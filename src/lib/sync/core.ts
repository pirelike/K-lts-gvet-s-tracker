/**
 * Egyetlen szinkronfutás: letöltés → visszafejtés → összefésülés → validálás → helyi csere (védetten) →
 * feltöltés. Nem tud Svelte-ről, ütemezésről vagy felületről, ezért két `LedgerRepo` között (két
 * `fake-indexeddb` példánnyal) valós forgatókönyvek tesztelhetők vele. Az ütemezés az `engine.svelte.ts`-ben van.
 */
import { makeBackup } from '../db/backup';
import type { LedgerRepo, RepoSnapshot } from '../db/repo';
import { decodeSyncFile, encodeSyncFile, type SyncKey } from './format';
import {
	hasOwnData,
	mergeStates,
	remapIds,
	sameState,
	stateFingerprint,
	validateState,
	type MergeReport,
	type SyncState
} from './merge';
import { SyncAuthError, SyncNetworkError, SyncProviderError, type ProviderId, type SyncProvider } from './provider';
import { pruneTombstones } from './tombstones';

/** Az eszközön tárolt kapcsolat (`meta.sync`); nem része a JSON-mentésnek. */
export interface SyncConnection {
	provider: ProviderId;
	/** A fiók e-mail címe vagy neve. */
	account: string;
	/** Titkosított-e a felhőfájl. A kulcs külön (`meta.syncKey`) van. */
	encrypted: boolean;
	/** Véletlen azonosító az eszközhöz (a fájlba tájékoztatásul kerül). */
	deviceId: string;
	lastRev: string | null;
	/** Az utolsó sikeres szinkron ideje (ms). */
	lastSyncAt: number | null;
	/** A szolgáltató tokenjei (a szolgáltató tölti és írja a `ProviderStorage`-on át). */
	tokens: unknown;
}

export const META_SYNC = 'sync';
export const META_SYNC_KEY = 'syncKey';
export const META_LOST_BACKUP = 'lostBackup';

/** Legfeljebb ennyiszer próbáljuk újra egy futáson belül (versenyhelyzet a felhőfájlon vagy a helyi adaton). */
export const MAX_ATTEMPTS = 3;

export type SyncFailureKind =
	| 'network' // nincs kapcsolat: később újrapróbálható
	| 'auth' // a token lejárt: megújítás kell
	| 'password' // a szinkronjelszó hibás vagy hiányzik: a felhasználó dönt
	| 'invalid' // a fájl vagy az összefésült állapot érvénytelen: semmit nem írtunk
	| 'conflict' // többször módosult közben a felhőfájl
	| 'provider'; // egyéb szolgáltatói hiba

export type SyncOutcome =
	| { ok: true; uploaded: boolean; changedLocal: boolean; rev: string | null; report: MergeReport; writtenAt: number }
	| { ok: false; kind: SyncFailureKind; error: string };

export interface SyncRunInput {
	repo: LedgerRepo;
	provider: SyncProvider;
	/** `null` = titkosítatlan fájl. Ezzel fejtjük vissza a letöltött fájlt. */
	key: SyncKey | null;
	/** Ha meg van adva, ezzel írjuk a fájlt (jelszócsere): a letöltöttet még a régi kulccsal nyitjuk. */
	writeKey?: SyncKey | null;
	deviceId: string;
	/** Az utolsó sikeres szinkron ideje (az eltérő korszaknál elveszett módosítások számolásához). */
	lastSyncAt: number | null;
	now?: () => number;
	/** Feltöltés akkor is, ha az összefésülés nem követeli meg (pl. jelszócsere). */
	forceUpload?: boolean;
	/** Eltérő korszaknál, ha a helyi oldal veszít: a felülírás előtti helyi mentés (JSON) átadása. */
	onEpochLost?: (backupJson: string, report: MergeReport) => Promise<void> | void;
}

const emptyReport = (): MergeReport => ({ added: 0, updated: 0, removed: 0, transactions: { added: 0, updated: 0, removed: 0 }, repaired: [] });

function addReports(a: MergeReport, b: MergeReport): MergeReport {
	return {
		added: a.added + b.added,
		updated: a.updated + b.updated,
		removed: a.removed + b.removed,
		transactions: {
			added: a.transactions.added + b.transactions.added,
			updated: a.transactions.updated + b.transactions.updated,
			removed: a.transactions.removed + b.transactions.removed
		},
		repaired: [...new Set([...a.repaired, ...b.repaired])].sort(),
		...(a.epochLost !== undefined || b.epochLost !== undefined ? { epochLost: (a.epochLost ?? 0) + (b.epochLost ?? 0) } : {}),
		...((a.epochWinner ?? b.epochWinner) ? { epochWinner: a.epochWinner ?? b.epochWinner } : {})
	};
}

/** Az adatbázis pillanatképe szinkronállapotként. A korszak hiánya (`null`) nem fordulhat elő az `ensureEpoch` után. */
export function toState(snap: RepoSnapshot): SyncState {
	return {
		epoch: snap.epoch ?? { id: -1, at: -1 },
		prefs: snap.prefs,
		prefsUpdatedAt: snap.prefsUpdatedAt,
		data: snap.data,
		tombstones: snap.tombstones
	};
}

/** A helyi állapot (a korszakot szükség esetén létrehozza). */
export async function readLocalState(repo: LedgerRepo): Promise<SyncState> {
	await repo.ensureEpoch();
	return toState(await repo.readSnapshot());
}

/** A helyi adatok teljes JSON-mentése (a `makeBackup` formátumában). */
export const backupJsonOf = (state: Pick<SyncState, 'data' | 'prefs'>): string =>
	JSON.stringify(makeBackup({ ...state.data, prefs: state.prefs }));

/** Egy szolgáltatói kivétel besorolása. */
function classify(e: unknown): { kind: SyncFailureKind; error: string } {
	if (e instanceof SyncNetworkError) return { kind: 'network', error: e.message };
	if (e instanceof SyncAuthError) return { kind: 'auth', error: e.message };
	if (e instanceof SyncProviderError) return { kind: 'provider', error: e.message };
	return { kind: 'provider', error: e instanceof Error ? e.message : String(e) };
}

/**
 * Az összefésült állapot átvétele helyben: védetten, ugyanabban a tranzakcióban ellenőrizve, hogy a helyi
 * adat még az, amiből az összefésülés készült. `false` = közben módosult, újra kell kezdeni.
 */
async function applyLocal(repo: LedgerRepo, expected: string, next: SyncState): Promise<boolean> {
	return repo.replaceAllGuarded(
		{ expected, fingerprint: (snap) => stateFingerprint(toState(snap)) },
		next.data,
		next.prefs,
		next.prefsUpdatedAt,
		{ epoch: next.epoch, tombstones: next.tombstones }
	);
}

export async function syncOnce(input: SyncRunInput): Promise<SyncOutcome> {
	const { repo, provider, key, deviceId } = input;
	const writeKey = input.writeKey !== undefined ? input.writeKey : key;
	const now = input.now ?? Date.now;
	let report = emptyReport();
	let changedLocal = false;

	try {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const local = await readLocalState(repo);
			const expected = stateFingerprint(local);
			const remoteFile = await provider.read();

			let remoteState: SyncState | null = null;
			let remoteEncrypted = writeKey !== null;
			// Két eszköz egyszerre létrehozott fájlja: az elsőt (a legrégebbit) tartjuk meg, a többit összefésüljük bele.
			const mergedCopies: string[] = [];
			if (remoteFile) {
				const dec = await decodeSyncFile(remoteFile.text, key);
				if (!dec.ok) {
					const kind: SyncFailureKind = dec.code === 'wrongPassword' || dec.code === 'needsPassword' ? 'password' : 'invalid';
					return { ok: false, kind, error: dec.error };
				}
				remoteState = { ...dec.state, tombstones: pruneTombstones(dec.state.tombstones, now()) };
				remoteEncrypted = dec.encrypted;
				for (const copy of remoteFile.extra ?? []) {
					const extra = await decodeSyncFile(copy.text, key);
					if (!extra.ok) continue; // amit nem tudunk beolvasni, azt nem is töröljük
					remoteState = mergeStates(remoteState, { ...extra.state, tombstones: pruneTombstones(extra.state.tombstones, now()) }).state;
					mergedCopies.push(copy.ref);
				}
			}

			// A régi jelölők eldobása (a törlés így 180 nap után „elfelejtődik").
			const pruned: SyncState = { ...local, tombstones: pruneTombstones(local.tombstones, now()) };
			const merged = remoteState
				? mergeStates(pruned, remoteState, { syncedAt: input.lastSyncAt ?? undefined })
				: { state: pruned, localChanged: !sameState(pruned, local), remoteChanged: true, report: emptyReport() };

			const valid = validateState(merged.state);
			if (!valid.ok) return { ok: false, kind: 'invalid', error: valid.error };

			if (merged.localChanged) {
				if (merged.report.epochWinner === 'remote' && (merged.report.epochLost ?? 0) > 0) {
					await input.onEpochLost?.(backupJsonOf(local), merged.report);
				}
				if (!(await applyLocal(repo, expected, merged.state))) continue; // közben módosítottak: újra
				changedLocal = true;
			}
			report = addReports(report, merged.report);

			const upload =
				merged.remoteChanged || !remoteFile || input.forceUpload === true || remoteEncrypted !== (writeKey !== null) || mergedCopies.length > 0;
			let rev = remoteFile?.rev ?? null;
			if (upload) {
				const text = await encodeSyncFile(merged.state, { key: writeKey, deviceId, writtenAt: now() });
				const w = await provider.write(text, remoteFile?.rev ?? null);
				if (!w.ok) continue; // másik eszköz közben írt: újra letöltjük és összefésüljük
				rev = w.rev;
				// Az összefésült többletpéldányok már benne vannak a feltöltött fájlban: törölhetők.
				for (const ref of mergedCopies) await provider.discardCopy?.(ref).catch(() => {});
			}
			return { ok: true, uploaded: upload, changedLocal, rev, report, writtenAt: now() };
		}
		return { ok: false, kind: 'conflict', error: 'A felhőfájl közben többször módosult, később újrapróbáljuk' };
	} catch (e) {
		return { ok: false, ...classify(e) };
	}
}

// ---------- első csatlakozás (a terv 4.5 pontja) ----------

export type FirstConnectPlan =
	/** A felhőben még nincs fájl: a helyi állapot feltöltése. */
	| { kind: 'upload' }
	/** Van fájl, helyben nincs saját adat: a távoli állapot átvétele egészben. */
	| { kind: 'adopt' }
	/** Mindkét oldalon van saját adat: a felhasználó dönt. */
	| { kind: 'choose' };

export function planFirstConnect(local: SyncState, remote: SyncState | null): FirstConnectPlan {
	if (!remote) return { kind: 'upload' };
	return hasOwnData(local) ? { kind: 'choose' } : { kind: 'adopt' };
}

/**
 * „Összefésülés": a helyi régi (kis sorszámú) azonosítók átszámozása a távoli oldalhoz igazítva, majd a
 * helyi állapot a távoli korszakba kerül, hogy rekordszintű összefésülés legyen belőle.
 */
export function prepareFirstMerge(local: SyncState, remote: SyncState): SyncState {
	const remapped = remapIds(local, { match: remote.data });
	return { ...remapped, epoch: remote.epoch };
}

/**
 * Az első csatlakozás helyi lépése: a távoli állapot átvétele (`adopt`) vagy összefésülése (`merge`) a
 * helyivel, védetten (közben módosított helyi adatot nem ír felül). A feltöltést a következő `syncOnce`
 * végzi el: a helyi állapot ekkor már tartalmazza a távolit, a helyi többlet pedig feltöltődik.
 */
export async function applyFirstConnect(
	repo: LedgerRepo,
	local: SyncState,
	remote: SyncState,
	choice: 'adopt' | 'merge'
): Promise<{ ok: true; report: MergeReport } | { ok: false; error: string; concurrent: boolean }> {
	let next: SyncState;
	let report: MergeReport;
	if (choice === 'adopt') {
		next = remote;
		// A helyi oldal korszakát a legrégebbire állítva a távoli nyer, és a különbség a jelentésbe kerül.
		report = mergeStates({ ...local, epoch: { id: -1, at: -1 } }, remote).report;
	} else {
		const merged = mergeStates(prepareFirstMerge(local, remote), remote);
		next = merged.state;
		report = merged.report;
	}
	const valid = validateState(next);
	if (!valid.ok) return { ok: false, error: valid.error, concurrent: false };
	const applied = await applyLocal(repo, stateFingerprint(local), next);
	return applied ? { ok: true, report } : { ok: false, error: 'Az adatok közben módosultak, próbáld újra', concurrent: true };
}
