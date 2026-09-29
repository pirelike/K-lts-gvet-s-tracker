/** Minimális, függőségmentes IndexedDB segédek. */

export const DB_NAME = 'koltsegvetes';
export const DB_VERSION = 1;

export type DataStore = 'accounts' | 'categories' | 'transactions';
export const DATA_STORES: DataStore[] = ['accounts', 'categories', 'transactions'];
export const ALL_STORES = [...DATA_STORES, 'meta'] as const;

export function openLedgerDb(name: string = DB_NAME): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const s of DATA_STORES) db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
			db.createObjectStore('meta', { keyPath: 'key' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('Az adatbázis nem nyitható meg'));
		req.onblocked = () => reject(new Error('Az adatbázis egy másik lapon zárolva van'));
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
