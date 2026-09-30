/**
 * A felhőben tárolt szinkronfájl (`ledger.sync.json`) formátuma, titkosítása és szigorú beolvasása.
 *
 * A sót a fájl tartalmazza, így minden eszköz ugyanazt a kulcsot származtatja ugyanabból a jelszóból.
 * Csatlakozáskor a jelszóból egyszer `CryptoKey` lesz (nem kinyerhető), amit az eszköz eltárol; a jelszót
 * magát sehol nem tároljuk. Minden íráskor új IV készül.
 */
import { BACKUP_VERSION, parseBackup } from '../db/backup';
import {
	DEFAULT_KDF_ITERATIONS,
	MAX_KDF_ITERATIONS,
	decryptWithKey,
	deriveBackupKey,
	encryptWithKey
} from '../db/crypto';
import { DATA_STORES } from '../db/idb';
import { fromB64, toB64 } from '../db/pin';
import type { Prefs } from '../types';
import type { SyncState } from './merge';
import { isEpoch, parseTombstoneKey, type Tombstones } from './tombstones';

export const SYNC_FILE_NAME = 'ledger.sync.json';
export const SYNC_FORMAT = 1;

/** Az eszközön tárolt (és a fájlban lévő sóhoz kötött) kulcs. */
export interface SyncKey {
	key: CryptoKey;
	/** Base64; ugyanaz, mint a fájl `kdf.salt` mezője. */
	salt: string;
	iterations: number;
}

interface SyncFileBase {
	app: 'koltsegvetes-tracker';
	kind: 'sync';
	format: 1;
}

export interface EncryptedSyncFile extends SyncFileBase {
	encrypted: true;
	kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
	cipher: { name: 'AES-GCM'; iv: string };
	/** Base64: a titkosított `SyncPayload` JSON. */
	data: string;
}

export interface PlainSyncFile extends SyncFileBase {
	encrypted: false;
	state: SyncPayload;
}

export type SyncFile = EncryptedSyncFile | PlainSyncFile;

/** A fájl tényleges tartalma (titkosítva vagy sima JSON-ként). */
export interface SyncPayload extends SyncState {
	/** A mentésformátum verziója, amivel az adatok (`data`) érvényesek. */
	schema: number;
	writtenAt: number;
	/** Melyik eszköz írta (csak tájékoztató, a döntésekben nem szerepel). */
	deviceId: string;
}

export type DecodeErrorCode =
	| 'invalid' // nem szinkronfájl vagy sérült
	| 'unsupported' // ismeretlen (újabb) formátum vagy séma
	| 'needsPassword' // titkosított fájl, de nincs kulcs
	| 'wrongPassword' // a visszafejtés nem sikerült
	| 'badState'; // visszafejthető, de az állapot érvénytelen

export type DecodeResult =
	| { ok: true; state: SyncState; writtenAt: number; deviceId: string; encrypted: boolean }
	| { ok: false; code: DecodeErrorCode; error: string };

const fail = (code: DecodeErrorCode, error: string): { ok: false; code: DecodeErrorCode; error: string } => ({
	ok: false,
	code,
	error
});

/** Új jelszó → új só és kulcs (első csatlakozás új fájllal, jelszócsere). */
export async function createSyncKey(password: string, opts: { iterations?: number } = {}): Promise<SyncKey> {
	const iterations = opts.iterations ?? DEFAULT_KDF_ITERATIONS;
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return { key: await deriveBackupKey(password, salt, iterations), salt: toB64(salt), iterations };
}

/** A meglévő fájl sójából és iterációszámából a jelszóhoz tartozó kulcs. */
export async function deriveSyncKey(password: string, kdf: { salt: string; iterations: number }): Promise<SyncKey> {
	return { key: await deriveBackupKey(password, fromB64(kdf.salt), kdf.iterations), salt: kdf.salt, iterations: kdf.iterations };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type PeekResult =
	| { ok: true; encrypted: false }
	| { ok: true; encrypted: true; kdf: { salt: string; iterations: number } }
	| { ok: false; error: string };

/**
 * A fájl fejlécének vizsgálata visszafejtés nélkül: titkosított-e, és mi a só/iterációszám. A kulcs
 * származtatásához kell (csatlakozáskor a jelszóból még nincs kulcs).
 */
export function peekSyncFile(text: string): PeekResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: 'A felhőben lévő fájl nem érvényes JSON' };
	}
	if (!isObj(raw) || raw.app !== 'koltsegvetes-tracker' || raw.kind !== 'sync') {
		return { ok: false, error: 'A felhőben lévő fájl nem ennek az appnak a szinkronfájlja' };
	}
	if (raw.format !== SYNC_FORMAT) return { ok: false, error: 'A szinkronfájl újabb formátumú: frissítsd az alkalmazást' };
	if (raw.encrypted !== true) return { ok: true, encrypted: false };
	const kdf = raw.kdf;
	if (
		!isObj(kdf) ||
		kdf.name !== 'PBKDF2' ||
		kdf.hash !== 'SHA-256' ||
		typeof kdf.salt !== 'string' ||
		typeof kdf.iterations !== 'number' ||
		!Number.isInteger(kdf.iterations) ||
		kdf.iterations < 1 ||
		kdf.iterations > MAX_KDF_ITERATIONS
	) {
		return { ok: false, error: 'A szinkronfájl titkosítási fejléce hibás' };
	}
	return { ok: true, encrypted: true, kdf: { salt: kdf.salt, iterations: kdf.iterations } };
}

/** Az állapot kódolása fájllá. `key = null` → titkosítatlan (csak ha a felhasználó kifejezetten kéri). */
export async function encodeSyncFile(
	state: SyncState,
	opts: { key: SyncKey | null; deviceId: string; writtenAt?: number }
): Promise<string> {
	const payload: SyncPayload = {
		schema: BACKUP_VERSION,
		writtenAt: opts.writtenAt ?? Date.now(),
		deviceId: opts.deviceId,
		epoch: state.epoch,
		prefs: state.prefs,
		prefsUpdatedAt: state.prefsUpdatedAt,
		data: state.data,
		tombstones: state.tombstones
	};
	if (!opts.key) {
		const file: PlainSyncFile = { app: 'koltsegvetes-tracker', kind: 'sync', format: 1, encrypted: false, state: payload };
		return JSON.stringify(file);
	}
	const { iv, data } = await encryptWithKey(opts.key.key, JSON.stringify(payload));
	const file: EncryptedSyncFile = {
		app: 'koltsegvetes-tracker',
		kind: 'sync',
		format: 1,
		encrypted: true,
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: opts.key.iterations, salt: opts.key.salt },
		cipher: { name: 'AES-GCM', iv },
		data
	};
	return JSON.stringify(file);
}

/** A fájl beolvasása: fejléc → visszafejtés → az állapot szigorú ellenőrzése. Semmit nem ír. */
export async function decodeSyncFile(text: string, key: SyncKey | null): Promise<DecodeResult> {
	const head = peekSyncFile(text);
	if (!head.ok) return fail(head.error.includes('újabb') ? 'unsupported' : 'invalid', head.error);
	const file = JSON.parse(text) as SyncFile;

	let payload: unknown;
	if (head.encrypted) {
		if (!key) return fail('needsPassword', 'A szinkronfájl jelszóval védett');
		const enc = file as EncryptedSyncFile;
		if (typeof enc.cipher?.iv !== 'string' || enc.cipher.name !== 'AES-GCM' || typeof enc.data !== 'string') {
			return fail('invalid', 'A szinkronfájl titkosított része hibás');
		}
		// Ha másik eszközön jelszót cseréltek, a fájl sója más: a régi kulccsal biztosan nem nyitható meg.
		if (enc.kdf.salt !== key.salt) return fail('wrongPassword', 'Hibás szinkronjelszó');
		let json: string;
		try {
			json = await decryptWithKey(key.key, enc.cipher.iv, enc.data);
		} catch {
			return fail('wrongPassword', 'Hibás szinkronjelszó');
		}
		try {
			payload = JSON.parse(json);
		} catch {
			return fail('invalid', 'A szinkronfájl tartalma sérült');
		}
	} else {
		payload = (file as PlainSyncFile).state;
	}
	const parsed = parseSyncPayload(payload);
	if (!parsed.ok) return parsed;
	return { ok: true, ...parsed.value, encrypted: head.encrypted };
}

type Parsed = { ok: true; value: { state: SyncState; writtenAt: number; deviceId: string } } | { ok: false; code: DecodeErrorCode; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * A (visszafejtett vagy sima) tartalom ellenőrzése. Az adatokat ugyanaz a szigorú `parseBackup` vizsgálja
 * és normalizálja, mint a JSON-mentés visszatöltésekor; érvénytelen állapotból nem lesz semmi.
 */
export function parseSyncPayload(raw: unknown): Parsed {
	if (!isObj(raw)) return fail('invalid', 'A szinkronfájl tartalma hibás');
	if (!isInt(raw.schema)) return fail('invalid', 'A szinkronfájl sémaverziója hiányzik');
	if (raw.schema > BACKUP_VERSION) return fail('unsupported', 'A szinkronfájl újabb sémájú: frissítsd az alkalmazást');
	if (raw.schema < BACKUP_VERSION) return fail('unsupported', 'A szinkronfájl régebbi sémájú, ezt az app már nem tudja beolvasni');
	if (!isEpoch(raw.epoch)) return fail('invalid', 'A szinkronfájl korszaka hibás');
	if (!isInt(raw.prefsUpdatedAt) || raw.prefsUpdatedAt < 0) return fail('invalid', 'A szinkronfájl beállításai hibásak');
	if (!isObj(raw.data) || !isObj(raw.prefs)) return fail('invalid', 'A szinkronfájl tartalma hiányos');

	const backup = parseBackup(
		JSON.stringify({ app: 'koltsegvetes-tracker', version: BACKUP_VERSION, exportedAt: '', prefs: raw.prefs, ...raw.data })
	);
	if (!backup.ok) return fail('badState', `A szinkronfájl adatai érvénytelenek: ${backup.error}`);
	const { prefs, ...data } = backup.backup;

	const tombstones: Tombstones = {};
	if (raw.tombstones !== undefined) {
		if (!isObj(raw.tombstones)) return fail('invalid', 'A szinkronfájl törlési jelölői hibásak');
		for (const [k, at] of Object.entries(raw.tombstones)) {
			const key = parseTombstoneKey(k);
			// Ismeretlen tárolóra vagy hibás időre vonatkozó jelölőt eldobunk (nem hiba: előre kompatibilis).
			if (key && (DATA_STORES as string[]).includes(key.store) && isInt(at) && at >= 0) tombstones[k] = at;
		}
	}
	return {
		ok: true,
		value: {
			state: {
				epoch: { id: raw.epoch.id, at: raw.epoch.at },
				prefs: prefs as Prefs,
				prefsUpdatedAt: raw.prefsUpdatedAt,
				data: { accounts: data.accounts, categories: data.categories, transactions: data.transactions, recurring: data.recurring, templates: data.templates, goals: data.goals, filters: data.filters },
				tombstones
			},
			writtenAt: isInt(raw.writtenAt) ? raw.writtenAt : 0,
			deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : ''
		}
	};
}
