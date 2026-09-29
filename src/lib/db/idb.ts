/** Minimális, függőségmentes IndexedDB segédek. */

export const DB_NAME = 'koltsegvetes';
/**
 * Az adatbázis sémaverziója. Új store vagy index csak úgy vehető fel, ha a verziót emeled, és a
 * `MIGRATIONS` tömbbe új lépést írsz (az i. elem az (i+1). verzióra lép). Létező lépést soha ne módosíts:
 * a régi telepítések pontosan azokon mennek végig.
 */
export const DB_VERSION = 2;

export type DataStore =
	| 'accounts'
	| 'categories'
	| 'transactions'
	| 'recurring'
	| 'templates'
	| 'goals'
	| 'filters';
export const DATA_STORES: DataStore[] = [
	'accounts',
	'categories',
	'transactions',
	'recurring',
	'templates',
	'goals',
	'filters'
];
export const ALL_STORES = [...DATA_STORES, 'meta'] as const;

const createStore = (db: IDBDatabase, name: string) => {
	if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
};

/** Az 1. verzió előtti állapotból (üres adatbázis) az 1. verzió sémájára. */
function toV1(db: IDBDatabase) {
	for (const s of ['accounts', 'categories', 'transactions']) createStore(db, s);
	if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
}

/** Számlanévből tippelt típus (a régi számláknak még nincs típusuk). */
export function inferAccountType(name: string): 'cash' | 'checking' | 'credit' | 'savings' {
	const n = name.toLocaleLowerCase('hu');
	if (/k[eé]szp[eé]nz|p[eé]nzt[aá]rca|cash/.test(n)) return 'cash';
	if (/megtakar[ií]t|tal[eé]kk|megtak|savings/.test(n)) return 'savings';
	if (/hitel|credit/.test(n)) return 'credit';
	return 'checking';
}

/** A 2. verzió: ismétlődő tételek, sablonok, célok, mentett szűrők + a számlák típusa. */
function toV2(db: IDBDatabase, tx: IDBTransaction) {
	for (const s of ['recurring', 'templates', 'goals', 'filters']) createStore(db, s);
	const accounts = tx.objectStore('accounts');
	const req = accounts.openCursor();
	req.onsuccess = () => {
		const cursor = req.result;
		if (!cursor) return;
		const a = cursor.value as { name?: string; type?: string };
		if (!a.type) cursor.update({ ...a, type: inferAccountType(String(a.name ?? '')) });
		cursor.continue();
	};
}

type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;
/** Az i. elem az (i+1). sémaverzióra lép. */
const MIGRATIONS: Migration[] = [(db) => toV1(db), toV2];

/** Lefuttatja a `from` verzió utáni összes lépést (kívülről is hívható a teszteknek). */
export function upgradeSchema(db: IDBDatabase, tx: IDBTransaction, from: number, to: number = DB_VERSION) {
	for (let v = from; v < to; v++) MIGRATIONS[v](db, tx);
}

export interface OpenOptions {
	/** Másik lap/ablak régebbi verzióval tartja nyitva az adatbázist: a frissítés várakozik. */
	onBlocked?: () => void;
	/** Az adatbázist egy másik lap frissítette (vagy törölte): ez a kapcsolat lezárult. */
	onClosed?: () => void;
}

export function openLedgerDb(name: string = DB_NAME, opts: OpenOptions = {}): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const tx = req.transaction!;
			upgradeSchema(req.result, tx, e.oldVersion);
		};
		req.onsuccess = () => {
			const db = req.result;
			// Ha egy másik lap frissítené a sémát, nem állhatunk az útjába: lezárjuk a kapcsolatunkat.
			db.onversionchange = () => {
				db.close();
				opts.onClosed?.();
			};
			db.onclose = () => opts.onClosed?.();
			resolve(db);
		};
		req.onerror = () => reject(req.error ?? new Error('Az adatbázis nem nyitható meg'));
		// A blokkolt frissítés nem hiba: amint a másik lap bezárul, a kérés folytatódik.
		req.onblocked = () => opts.onBlocked?.();
	});
}

export function wrap<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('A tranzakció megszakadt'));
	});
}

export function deleteLedgerDb(name: string = DB_NAME): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		req.onblocked = () => resolve();
	});
}
