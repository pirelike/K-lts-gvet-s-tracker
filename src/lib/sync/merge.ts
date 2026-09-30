/**
 * A szinkron lelke: két eszköz állapotának összefésülése. Tiszta függvények (nincs IndexedDB, nincs
 * óra, nincs hálózat), ezért véletlen műveletsorokon is tesztelhetők.
 *
 * Az összefésülés rekordonként „az újabb nyer" (LWW, `updatedAt`), törlési jelölőkkel. Ha az azonosító és
 * az `updatedAt` egyaránt egyenlő, a rekord kulcs-rendezett JSON-szövege dönt, így mindkét eszköz
 * ugyanazt választja. Az összefésülés kommutatív és idempotens; a rekordszintű rész asszociatív is.
 * A hivatkozás-javítás (lásd `repairRefs`) a rekordszinten felül egy determinisztikus utólépés.
 */
import { makeBackup, parseBackup } from '../db/backup';
import { DATA_STORES, type DataStore } from '../db/idb';
import { emptyData, type LedgerData } from '../db/repo';
import type { Prefs } from '../types';
import { ID_MIN, newId } from './ids';
import { tombstoneKey, type SyncEpoch, type Tombstones } from './tombstones';

/** Egy eszköz teljes szinkronizálandó állapota. */
export interface SyncState {
	epoch: SyncEpoch;
	prefs: Prefs;
	prefsUpdatedAt: number;
	/** Mind a 7 adattároló. */
	data: LedgerData;
	tombstones: Tombstones;
}

export interface MergeReport {
	/** A helyi állapothoz képest: új, módosult, eltűnt rekordok száma (az összes tárolóban). */
	added: number;
	updated: number;
	removed: number;
	/** Csak a tranzakciók (a felhasználónak szóló értesítésekhez). */
	transactions: { added: number; updated: number; removed: number };
	/** Az összefésülés utáni hivatkozás-javítások emberi szöveggel. */
	repaired: string[];
	/** Eltérő korszaknál a helyi oldalon elveszett, még nem szinkronizált módosítások száma. */
	epochLost?: number;
	/** Eltérő korszaknál melyik oldal nyert. */
	epochWinner?: 'local' | 'remote';
}

export interface MergeResult {
	state: SyncState;
	/** Kell-e helyben `replaceAll`. */
	localChanged: boolean;
	/** Kell-e feltöltés. */
	remoteChanged: boolean;
	report: MergeReport;
}

export interface MergeOptions {
	/** Az utolsó sikeres szinkron ideje: az ennél újabb helyi módosítások „még nem szinkronizáltak". */
	syncedAt?: number;
	/** Hivatkozás-javítás kikapcsolása (csak a rekordszintű algebra tesztelésére). Alapból be van kapcsolva. */
	repair?: boolean;
}

type Row = { id: number; createdAt: number; updatedAt: number };
type Rows = Record<string, unknown> & Row;

/** Kulcs szerint rendezett, determinisztikus JSON (a `undefined` értékű mezők kimaradnak). */
export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

const byCreated = (a: Row, b: Row) => a.createdAt - b.createdAt || a.id - b.id;

/** Kanonikus alak az összehasonlításhoz: rendezett tárolók, rendezett kulcsok. */
function canonical(s: SyncState): string {
	const data: Record<string, Row[]> = {};
	for (const st of DATA_STORES) data[st] = [...rowsOf(s.data, st)].sort(byCreated);
	return stableStringify({ epoch: s.epoch, prefs: s.prefs, prefsUpdatedAt: s.prefsUpdatedAt, data, tombstones: s.tombstones });
}

/** Két állapot azonos-e (kulcssorrendtől és a sorok sorrendjétől függetlenül). */
export const sameState = (a: SyncState, b: SyncState): boolean => canonical(a) === canonical(b);

const maxDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** Az újabb változat; egyenlő `updatedAt`-nél a nagyobb szöveg (mindkét eszköz ugyanazt választja). */
function newer(a: Rows, b: Rows, keyOf: (r: Rows) => string): Rows {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
	return keyOf(a) >= keyOf(b) ? a : b;
}

/**
 * Egy tároló rekordjainak egyesítése: minden azonosítóra a nyertes változat (a törlést itt még nem
 * alkalmazzuk). Az ismétlődő szabálynál a `lastHandled` mezőszinten a nagyobb dátum.
 */
function mergeRows(store: DataStore, local: Rows[], remote: Rows[]): Map<number, Rows> {
	const out = new Map<number, Rows>();
	const l = new Map(local.map((r) => [r.id, r]));
	const r = new Map(remote.map((x) => [x.id, x]));
	// A szabálynál a döntetlenkor a `lastHandled` nélküli alak számít, mert azt külön egyesítjük.
	const keyOf =
		store === 'recurring'
			? (x: Rows) => stableStringify({ ...x, lastHandled: null })
			: (x: Rows) => stableStringify(x);
	for (const id of new Set([...l.keys(), ...r.keys()])) {
		const a = l.get(id);
		const b = r.get(id);
		if (!a || !b) {
			out.set(id, (a ?? b)!);
			continue;
		}
		let win = newer(a, b, keyOf);
		if (store === 'recurring') {
			const lastHandled = maxDate((a.lastHandled as string | null) ?? null, (b.lastHandled as string | null) ?? null);
			win = { ...win, lastHandled };
		}
		out.set(id, win);
	}
	return out;
}

const REF_MESSAGES = { categories: 'Kategória', accounts: 'Számla' } as const;

/**
 * Hivatkozások javítása az összefésülés után:
 * - ha egy élő tranzakció vagy ismétlődő szabály törölt kategóriára/számlára mutat, a hivatkozott elem
 *   **visszaéled** (a törlési jelölő megszűnik, a rekord a vesztes oldalról visszakerül),
 * - a sablonok és célok megszűnt hivatkozása `null` lesz (ahogy a `parseBackup` is teszi).
 * A javítás csak az összefésült állapottól függ, ezért mindkét eszközön ugyanaz az eredménye.
 */
function repairRefs(
	live: Record<DataStore, Map<number, Rows>>,
	pool: Record<DataStore, Map<number, Rows>>,
	tombstones: Tombstones
): string[] {
	const repaired: string[] = [];
	const need = { accounts: new Set<number>(), categories: new Set<number>() };
	for (const t of live.transactions.values()) {
		need.accounts.add(t.accountId as number);
		if (t.toAccountId != null) need.accounts.add(t.toAccountId as number);
		if (t.categoryId != null) need.categories.add(t.categoryId as number);
		for (const s of (t.splits as { categoryId: number }[] | undefined) ?? []) need.categories.add(s.categoryId);
	}
	for (const r of live.recurring.values()) {
		need.accounts.add(r.accountId as number);
		if (r.toAccountId != null) need.accounts.add(r.toAccountId as number);
		if (r.categoryId != null) need.categories.add(r.categoryId as number);
	}
	for (const store of ['accounts', 'categories'] as const) {
		for (const id of need[store]) {
			if (live[store].has(id)) continue;
			const row = pool[store].get(id);
			if (!row) continue; // nincs honnan visszahozni: a validáció jelzi a hibát
			live[store].set(id, row);
			delete tombstones[tombstoneKey(store, id)];
			repaired.push(`${REF_MESSAGES[store]} visszaállítva: „${String(row.name)}" (egy tétel még használja)`);
		}
	}
	const clear = (store: 'templates' | 'goals', field: string, kind: keyof typeof REF_MESSAGES) => {
		for (const [id, row] of live[store]) {
			const ref = row[field];
			if (ref == null || live[kind].has(ref as number)) continue;
			live[store].set(id, { ...row, [field]: null });
			const what = store === 'templates' ? 'Sablon' : 'Cél';
			repaired.push(`${what} „${String(row.name)}": a megszűnt ${kind === 'categories' ? 'kategória' : 'számla'}-hivatkozás törölve`);
		}
	};
	clear('templates', 'categoryId', 'categories');
	clear('templates', 'accountId', 'accounts');
	clear('templates', 'toAccountId', 'accounts');
	clear('goals', 'accountId', 'accounts');
	return repaired.sort();
}

/** Egy tároló sorai típus nélkül (a tárolóktól független kezeléshez). */
const rowsOf = (data: LedgerData, store: DataStore): Rows[] => data[store] as unknown as Rows[];

/** Az állapot rekordjai tárolónként az azonosítóval és a tartalommal (a változás-számoláshoz). */
function indexOf(data: LedgerData, store: DataStore): Map<number, string> {
	return new Map(rowsOf(data, store).map((r) => [r.id, stableStringify(r)]));
}

function diffReport(local: SyncState, result: SyncState): Pick<MergeReport, 'added' | 'updated' | 'removed' | 'transactions'> {
	const total = { added: 0, updated: 0, removed: 0 };
	const tx = { added: 0, updated: 0, removed: 0 };
	for (const store of DATA_STORES) {
		const a = indexOf(local.data, store);
		const b = indexOf(result.data, store);
		const acc = store === 'transactions' ? [total, tx] : [total];
		for (const [id, content] of b) {
			const before = a.get(id);
			const key = before === undefined ? 'added' : before !== content ? 'updated' : null;
			if (key) for (const c of acc) c[key]++;
		}
		for (const id of a.keys()) if (!b.has(id)) for (const c of acc) c.removed++;
	}
	return { ...total, transactions: tx };
}

/** Hány helyi módosítás (rekord, törlés, beállítás) újabb az utolsó sikeres szinkronnál. */
function unsyncedCount(local: SyncState, syncedAt: number): number {
	let n = 0;
	for (const store of DATA_STORES) for (const r of rowsOf(local.data, store)) if (r.updatedAt > syncedAt) n++;
	for (const at of Object.values(local.tombstones)) if (at > syncedAt) n++;
	if (local.prefsUpdatedAt > syncedAt) n++;
	return n;
}

/** Eltérő korszakú állapotok: a későbbi `at` nyer egészben (döntetlennél a nagyobb azonosító). */
function epochWinner(a: SyncEpoch, b: SyncEpoch): 'local' | 'remote' {
	if (a.at !== b.at) return a.at > b.at ? 'local' : 'remote';
	return a.id >= b.id ? 'local' : 'remote';
}

export function mergeStates(local: SyncState, remote: SyncState, opts: MergeOptions = {}): MergeResult {
	// 1. Eltérő korszak: nincs rekordszintű összefésülés.
	if (local.epoch.id !== remote.epoch.id) {
		const winner = epochWinner(local.epoch, remote.epoch);
		const state = winner === 'local' ? local : remote;
		const report: MergeReport = { ...diffReport(local, state), repaired: [], epochWinner: winner };
		if (winner === 'remote') report.epochLost = unsyncedCount(local, opts.syncedAt ?? 0);
		return {
			state,
			localChanged: winner === 'remote' && !sameState(local, remote),
			remoteChanged: winner === 'local' && !sameState(local, remote),
			report
		};
	}

	// 2–5. Rekordszintű egyesítés törlési jelölőkkel.
	const tombstones: Tombstones = { ...local.tombstones };
	for (const [k, at] of Object.entries(remote.tombstones)) tombstones[k] = Math.max(tombstones[k] ?? -Infinity, at);

	const pool = {} as Record<DataStore, Map<number, Rows>>;
	const live = {} as Record<DataStore, Map<number, Rows>>;
	for (const store of DATA_STORES) {
		pool[store] = mergeRows(store, rowsOf(local.data, store), rowsOf(remote.data, store));
		live[store] = new Map();
		for (const [id, row] of pool[store]) {
			const gone = tombstones[tombstoneKey(store, id)];
			// A törlés akkor érvényes, ha a jelölő ideje nem korábbi a rekordénál (a törlés utáni szerkesztés nyer).
			if (gone === undefined || gone < row.updatedAt) live[store].set(id, row);
		}
	}

	// 5. Beállítások: a nagyobb `prefsUpdatedAt` nyer (döntetlennél a nagyobb szöveg).
	const lp = stableStringify(local.prefs);
	const rp = stableStringify(remote.prefs);
	const localPrefs =
		local.prefsUpdatedAt !== remote.prefsUpdatedAt ? local.prefsUpdatedAt > remote.prefsUpdatedAt : lp >= rp;
	const prefs = localPrefs ? local.prefs : remote.prefs;
	const prefsUpdatedAt = Math.max(local.prefsUpdatedAt, remote.prefsUpdatedAt);

	// 6. Hivatkozások javítása.
	const repaired = opts.repair === false ? [] : repairRefs(live, pool, tombstones);

	const data = emptyData();
	for (const store of DATA_STORES) {
		(data as unknown as Record<DataStore, Rows[]>)[store] = [...live[store].values()].sort(byCreated);
	}
	const state: SyncState = { epoch: local.epoch, prefs, prefsUpdatedAt, data, tombstones };
	return {
		state,
		localChanged: !sameState(state, local),
		remoteChanged: !sameState(state, remote),
		report: { ...diffReport(local, state), repaired }
	};
}

/**
 * 7. Az állapot ellenőrzése a mentés-lánccal (`makeBackup` → `parseBackup`), ugyanazzal a szigorú
 * szabályrendszerrel, mint a visszatöltésnél. Érvénytelen állapotot nem szabad se elmenteni, se feltölteni.
 */
export function validateState(state: SyncState): { ok: true } | { ok: false; error: string } {
	const backup = makeBackup({ ...state.data, prefs: state.prefs });
	const parsed = parseBackup(JSON.stringify(backup));
	return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}

/**
 * Van-e a helyi állapotban saját adat: saját (nem példa-) tétel, szerkesztett vagy létrehozott elem,
 * ismétlődő, sablon, cél, mentett szűrő vagy beállított keret. Az érintetlen alapelemek (`updatedAt` = 0)
 * és a példaadatok nem számítanak. Óvatos: bármi gyanús esetén „van adat", és a felhasználó dönt.
 */
export function hasOwnData(state: Pick<SyncState, 'data' | 'prefsUpdatedAt'>): boolean {
	const d = state.data;
	return (
		d.transactions.some((t) => !t.demo) ||
		d.recurring.length > 0 ||
		d.templates.length > 0 ||
		d.goals.length > 0 ||
		d.filters.length > 0 ||
		d.accounts.some((a) => a.updatedAt > 0) ||
		d.categories.some((c) => c.updatedAt > 0) ||
		state.prefsUpdatedAt > 0
	);
}

export interface RemapOptions {
	/** Új azonosító-forrás (alapból `newId`); a tesztek kiszámítható értékeket adhatnak. */
	generate?: () => number;
	/**
	 * A másik oldal adatai: ha egy átszámozandó számla vagy kategória (típus és név szerint) egyezik egy
	 * ottanival, annak az azonosítóját kapja, így az alapelemekből nem lesz duplikátum.
	 */
	match?: Pick<LedgerData, 'accounts' | 'categories'>;
}

const foldName = (s: string) => s.trim().toLocaleLowerCase('hu');

/**
 * A régi, kis sorszámú (`< 2^32`) azonosítók átszámozása, a hivatkozásokkal és a törlési jelölőkkel
 * együtt. Első csatlakozásnál, „összefésülés" választásakor kell, mert két eszköz régi sorszámai
 * különböző tételeket jelölhetnek. Az érintett rekordok `updatedAt` értéke nem változik.
 */
export function remapIds(state: SyncState, opts: RemapOptions = {}): SyncState {
	const generate = opts.generate ?? newId;
	const used = new Set<number>();
	for (const store of DATA_STORES) for (const r of rowsOf(state.data, store)) used.add(r.id);
	for (const a of opts.match?.accounts ?? []) used.add(a.id);
	for (const c of opts.match?.categories ?? []) used.add(c.id);
	const fresh = () => {
		let id = generate();
		while (used.has(id)) id = generate();
		used.add(id);
		return id;
	};

	const maps = {} as Record<DataStore, Map<number, number>>;
	for (const store of DATA_STORES) {
		maps[store] = new Map();
		const remoteRows = store === 'accounts' ? opts.match?.accounts : store === 'categories' ? opts.match?.categories : undefined;
		const taken = new Set<number>();
		for (const row of rowsOf(state.data, store) as (Rows & { name?: string; type?: string })[]) {
			if (row.id >= ID_MIN) continue;
			let target: number | undefined;
			if (remoteRows) {
				const same = (x: { id: number; name: string; type?: string }) =>
					foldName(x.name) === foldName(row.name ?? '') && x.type === row.type;
				const sameId = (remoteRows as { id: number; name: string; type?: string }[]).find((x) => x.id === row.id && same(x));
				const byName = (remoteRows as { id: number; name: string; type?: string }[]).find((x) => same(x) && !taken.has(x.id));
				const pick = sameId && !taken.has(sameId.id) ? sameId : byName;
				if (pick) {
					target = pick.id;
					taken.add(pick.id);
				}
			}
			maps[store].set(row.id, target ?? fresh());
		}
	}

	const m = (store: DataStore, id: number | null | undefined): number | null =>
		id == null ? null : (maps[store].get(id) ?? id);
	const at = <T extends { id: number }>(store: DataStore, row: T): T => ({ ...row, id: maps[store].get(row.id) ?? row.id });
	const d = state.data;
	const data: LedgerData = {
		accounts: d.accounts.map((a) => at('accounts', a)),
		categories: d.categories.map((c) => at('categories', c)),
		transactions: d.transactions.map((t) => ({
			...at('transactions', t),
			categoryId: m('categories', t.categoryId),
			accountId: m('accounts', t.accountId)!,
			toAccountId: m('accounts', t.toAccountId),
			...(t.splits ? { splits: t.splits.map((s) => ({ ...s, categoryId: m('categories', s.categoryId)! })) } : {}),
			...(t.recurringId != null ? { recurringId: m('recurring', t.recurringId)! } : {})
		})),
		recurring: d.recurring.map((r) => ({
			...at('recurring', r),
			categoryId: m('categories', r.categoryId),
			accountId: m('accounts', r.accountId)!,
			toAccountId: m('accounts', r.toAccountId)
		})),
		templates: d.templates.map((t) => ({
			...at('templates', t),
			categoryId: m('categories', t.categoryId),
			accountId: m('accounts', t.accountId),
			toAccountId: m('accounts', t.toAccountId)
		})),
		goals: d.goals.map((g) => ({ ...at('goals', g), accountId: m('accounts', g.accountId) })),
		filters: d.filters.map((f) => at('filters', f))
	};

	const tombstones: Tombstones = {};
	for (const [k, t] of Object.entries(state.tombstones)) {
		const i = k.indexOf(':');
		const store = k.slice(0, i) as DataStore;
		const id = Number(k.slice(i + 1));
		tombstones[maps[store] ? tombstoneKey(store, maps[store].get(id) ?? id) : k] = t;
	}
	return { ...state, data, tombstones };
}
