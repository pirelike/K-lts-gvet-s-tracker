/**
 * Jelszóval titkosított JSON-mentés: PBKDF2-SHA256-ból származtatott AES-256-GCM kulcs.
 * A kulcsleszármaztatás ugyanaz a Web Crypto-s megoldás, mint a PIN-hash-nél (`pin.ts`), csak itt
 * kulcs lesz belőle, nem hash. A jelszó nem tárolódik; elfelejtett jelszóval a mentés nem nyitható meg.
 */
import { fromB64, toB64 } from './pin';

export const MIN_BACKUP_PASSWORD = 8;
const ITERATIONS = 310_000;
/** A kulcsleszármaztatás fájlból olvasott iterációszámának felső korlátja (sérült/rosszindulatú fájl ellen). */
export const MAX_KDF_ITERATIONS = 5_000_000;
export const DEFAULT_KDF_ITERATIONS = ITERATIONS;

export interface EncryptedBackup {
	app: 'koltsegvetes-tracker';
	encrypted: true;
	format: 1;
	kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
	cipher: { name: 'AES-GCM'; iv: string };
	/** Base64: a titkosított JSON-mentés (a GCM hitelesítő címkével együtt). */
	data: string;
}

export function passwordError(password: string): string | null {
	if (password.length < MIN_BACKUP_PASSWORD) return `A jelszó legalább ${MIN_BACKUP_PASSWORD} karakter legyen`;
	return null;
}

/**
 * Jelszóból és sóból AES-256-GCM kulcs (PBKDF2-SHA256). A kulcs nem kinyerhető (`extractable: false`),
 * de az IndexedDB tartósan tárolni tudja: a szinkron ezt használja, hogy a jelszót ne kelljen tárolni.
 */
export async function deriveBackupKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
		'deriveKey'
	]);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/** Szöveg titkosítása kész kulccsal. Minden híváshoz új IV készül; az eredmény base64. */
export async function encryptWithKey(key: CryptoKey, text: string): Promise<{ iv: string; data: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(text));
	return { iv: toB64(iv), data: toB64(cipher) };
}

/** Visszafejtés kész kulccsal; rossz kulcs vagy módosított adat esetén kivételt dob (a GCM hitelesít). */
export async function decryptWithKey(key: CryptoKey, iv: string, data: string): Promise<string> {
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromB64(iv) as BufferSource },
		key,
		fromB64(data) as BufferSource
	);
	return new TextDecoder().decode(plain);
}

/** A mentés JSON-szövegének titkosítása; az eredmény egy újabb JSON-szöveg (a fájl tartalma). */
export async function encryptBackup(json: string, password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveBackupKey(password, salt, ITERATIONS);
	const cipher = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as BufferSource },
		key,
		new TextEncoder().encode(json)
	);
	const out: EncryptedBackup = {
		app: 'koltsegvetes-tracker',
		encrypted: true,
		format: 1,
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
		cipher: { name: 'AES-GCM', iv: toB64(iv) },
		data: toB64(cipher)
	};
	return JSON.stringify(out);
}

export type DecryptResult = { ok: true; json: string } | { ok: false; error: string };

/** Visszafejtés; rossz jelszó vagy sérült fájl esetén hibát ad (a GCM hitelesít). */
export async function decryptBackup(text: string, password: string): Promise<DecryptResult> {
	let env: unknown;
	try {
		env = JSON.parse(text);
	} catch {
		return { ok: false, error: 'A fájl nem érvényes JSON' };
	}
	const e = env as Partial<EncryptedBackup> | null;
	if (
		!e ||
		e.app !== 'koltsegvetes-tracker' ||
		e.encrypted !== true ||
		e.format !== 1 ||
		e.kdf?.name !== 'PBKDF2' ||
		e.kdf.hash !== 'SHA-256' ||
		typeof e.kdf.iterations !== 'number' ||
		e.kdf.iterations < 1 ||
		e.kdf.iterations > MAX_KDF_ITERATIONS ||
		typeof e.kdf.salt !== 'string' ||
		e.cipher?.name !== 'AES-GCM' ||
		typeof e.cipher.iv !== 'string' ||
		typeof e.data !== 'string'
	) {
		return { ok: false, error: 'A titkosított mentés hibás vagy ismeretlen formátumú' };
	}
	try {
		const key = await deriveBackupKey(password, fromB64(e.kdf.salt), e.kdf.iterations);
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromB64(e.cipher.iv) as BufferSource },
			key,
			fromB64(e.data) as BufferSource
		);
		return { ok: true, json: new TextDecoder().decode(plain) };
	} catch {
		return { ok: false, error: 'Hibás jelszó, vagy a fájl megsérült' };
	}
}
