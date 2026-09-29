/**
 * Az adatbázis-réteg: egyszerű CRUD az IndexedDB fölött. Nem tud Svelte-ről – így Node alatt
 * (fake-indexeddb-vel) is tesztelhető.
 */
import type { Account, Category, Transaction } from '../types';
import { DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from './defaults';
import { ALL_STORES, DATA_STORES, done, wrap, type DataStore } from './idb';

export interface LedgerData {
	accounts: Account[];
	categories: Category[];
	transactions: Transaction[];
}

type Row = { id: number };
type NewRow<T extends Row> = Omit<T, 'id'>;

/** Az IndexedDB nem tud Svelte-proxyt klónozni: sima objektumot adunk át. */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export class LedgerRepo {
	constructor(private readonly db: IDBDatabase) {}

	close() {
		this.db.close();
	}

	async loadAll(): Promise<LedgerData> {
		const tx = this.db.transaction(DATA_STORES, 'readonly');
		const [accounts, categories, transactions] = await Promise.all([
			wrap(tx.objectStore('accounts').getAll()),
			wrap(tx.objectStore('categories').getAll()),
			wrap(tx.objectStore('transactions').getAll())
		]);
		return {
			accounts: accounts as Account[],
			categories: categories as Category[],
			transactions: transactions as Transaction[]
		};
	}

	async add<T extends Row>(store: DataStore, value: NewRow<T>): Promise<T> {
		const tx = this.db.transaction(store, 'readwrite');
		const id = (await wrap(tx.objectStore(store).add(plain(value)))) as number;
		await done(tx);
		return { ...(value as object), id } as T;
	}

	async addMany<T extends Row>(store: DataStore, values: NewRow<T>[]): Promise<T[]> {
		const tx = this.db.transaction(store, 'readwrite');
		const os = tx.objectStore(store);
		const ids = await Promise.all(values.map((v) => wrap(os.add(plain(v))) as Promise<number>));
		await done(tx);
		return values.map((v, i) => ({ ...(v as object), id: ids[i] }) as T);
	}

	/** Beszúrás vagy felülírás a megadott azonosítóval (szerkesztés, törlés visszavonása). */
	async put<T extends Row>(store: DataStore, value: T): Promise<void> {
		const tx = this.db.transaction(store, 'readwrite');
		tx.objectStore(store).put(plain(value));
		await done(tx);
	}

	async remove(store: DataStore, id: number): Promise<void> {
		const tx = this.db.transaction(store, 'readwrite');
		tx.objectStore(store).delete(id);
		await done(tx);
	}

	async removeMany(store: DataStore, ids: number[]): Promise<void> {
		const tx = this.db.transaction(store, 'readwrite');
		for (const id of ids) tx.objectStore(store).delete(id);
		await done(tx);
	}

	async getMeta<T>(key: string): Promise<T | undefined> {
		const tx = this.db.transaction('meta', 'readonly');
		const row = (await wrap(tx.objectStore('meta').get(key))) as { key: string; value: T } | undefined;
		return row?.value;
	}

	async setMeta<T>(key: string, value: T): Promise<void> {
		const tx = this.db.transaction('meta', 'readwrite');
		tx.objectStore('meta').put({ key, value: plain(value) });
		await done(tx);
	}

	/** Első indításkor létrehozza az alap kategóriákat és számlákat (egyszer, egy tranzakcióban). */
	async seedDefaultsIfNeeded(): Promise<boolean> {
		const tx = this.db.transaction(['accounts', 'categories', 'meta'], 'readwrite');
		const meta = tx.objectStore('meta');
		const flag = await wrap(meta.get('initialized'));
		if (flag) {
			await done(tx);
			return false;
		}
		const now = Date.now();
		DEFAULT_ACCOUNTS.forEach((a, i) => tx.objectStore('accounts').add({ ...a, createdAt: now + i }));
		DEFAULT_CATEGORIES.forEach((c, i) => tx.objectStore('categories').add({ ...c, createdAt: now + i }));
		meta.put({ key: 'initialized', value: true });
		await done(tx);
		return true;
	}

	/** Teljes csere (biztonsági mentés visszatöltése): egyetlen tranzakcióban, mindent vagy semmit. */
	async replaceAll(data: LedgerData): Promise<void> {
		const tx = this.db.transaction(DATA_STORES, 'readwrite');
		for (const s of DATA_STORES) {
			const os = tx.objectStore(s);
			os.clear();
			for (const row of data[s]) os.put(plain(row));
		}
		await done(tx);
	}

	/** Minden adat és beállítás törlése (a PIN-t is). */
	async wipeAll(): Promise<void> {
		const tx = this.db.transaction([...ALL_STORES], 'readwrite');
		for (const s of ALL_STORES) tx.objectStore(s).clear();
		await done(tx);
	}
}
