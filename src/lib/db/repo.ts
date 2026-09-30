/**
 * Az adatbázis-réteg: egyszerű CRUD az IndexedDB fölött. Nem tud Svelte-ről – így Node alatt
 * (fake-indexeddb-vel) is tesztelhető.
 */
import type { Account, LedgerSnapshot, Prefs, Recurring, Transaction } from '../types';
import { newId, recurringTxId } from '../sync/ids';
import { DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from './defaults';
import { ALL_STORES, DATA_STORES, done, inferAccountType, wrap, type DataStore } from './idb';

/** Az összes adat-store tartalma (a beállítások nélkül). */
export type LedgerData = Omit<LedgerSnapshot, 'prefs'>;

type Row = { id: number };
type NewRow<T extends Row> = Omit<T, 'id'>;

/** Az IndexedDB nem tud Svelte-proxyt klónozni: sima objektumot adunk át. */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyData(): LedgerData {
	return { accounts: [], categories: [], transactions: [], recurring: [], templates: [], goals: [], filters: [] };
}

export class LedgerRepo {
	constructor(private readonly db: IDBDatabase) {}

	close() {
		this.db.close();
	}

	async loadAll(): Promise<LedgerData> {
		const tx = this.db.transaction(DATA_STORES, 'readonly');
		const data = emptyData() as Record<DataStore, unknown[]>;
		await Promise.all(
			DATA_STORES.map(async (s) => {
				// Az azonosítók véletlenek, a tároló mégis kulcs szerint adja vissza a sorokat: létrehozási
				// sorrendbe (createdAt, azon belül id) rendezzük, mint amikor az autoIncrement id még időrendet adott.
				const rows = (await wrap(tx.objectStore(s).getAll())) as { id: number; createdAt?: number }[];
				data[s] = rows.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id - b.id);
			})
		);
		const out = data as unknown as LedgerData;
		// Védőháló: a migráció után is legyen típusa minden számlának (pl. kézzel módosított adatbázis).
		out.accounts = out.accounts.map((a: Account) => (a.type ? a : { ...a, type: inferAccountType(a.name) }));
		return out;
	}

	/**
	 * Új sor beszúrása. Az azonosítót nem az adatbázis osztja (autoIncrement), hanem `newId()`:
	 * így két eszköz nem adhat ugyanazt az id-t két különböző sornak. Az `add` (nem `put`) ütközésnél
	 * hibát ad, ilyenkor új id-val újrapróbáljuk (gyakorlatilag soha nem fordul elő).
	 */
	async add<T extends Row>(store: DataStore, value: NewRow<T>): Promise<T> {
		const [row] = await this.addMany<T>(store, [value]);
		return row;
	}

	async addMany<T extends Row>(store: DataStore, values: NewRow<T>[]): Promise<T[]> {
		if (values.length === 0) return [];
		for (let attempt = 0; ; attempt++) {
			const seen = new Set<number>();
			const ids = values.map(() => {
				let id = newId();
				while (seen.has(id)) id = newId();
				seen.add(id);
				return id;
			});
			const tx = this.db.transaction(store, 'readwrite');
			const os = tx.objectStore(store);
			// A sikertelen `add` a tranzakciót is megszakítja; a kérés hibáját külön megjegyezzük,
			// mert a tranzakció hibája ilyenkor még üres lehet.
			const failure: { error: DOMException | null } = { error: null };
			for (let i = 0; i < values.length; i++) {
				const req = os.add({ ...plain(values[i]), id: ids[i] });
				req.onerror = () => {
					failure.error ??= req.error;
				};
			}
			try {
				await done(tx);
			} catch (e) {
				if (attempt < 3 && failure.error?.name === 'ConstraintError') continue;
				throw failure.error ?? e;
			}
			return values.map((v, i) => ({ ...(v as object), id: ids[i] }) as T);
		}
	}

	/** Beszúrás vagy felülírás a megadott azonosítóval (szerkesztés, törlés visszavonása). */
	async put<T extends Row>(store: DataStore, value: T): Promise<void> {
		const tx = this.db.transaction(store, 'readwrite');
		tx.objectStore(store).put(plain(value));
		await done(tx);
	}

	/** Több sor felülírása egyetlen tranzakcióban (csoportos módosítás, sorrend). */
	async putMany<T extends Row>(store: DataStore, values: T[]): Promise<void> {
		if (values.length === 0) return;
		const tx = this.db.transaction(store, 'readwrite');
		const os = tx.objectStore(store);
		for (const v of values) os.put(plain(v));
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
		// Fix azonosítók: két friss eszközön ugyanazok az alapelemek jönnek létre (lásd `defaults.ts`).
		DEFAULT_ACCOUNTS.forEach((a, i) => tx.objectStore('accounts').put({ ...a, createdAt: now + i }));
		DEFAULT_CATEGORIES.forEach((c, i) => tx.objectStore('categories').put({ ...c, createdAt: now + i }));
		meta.put({ key: 'initialized', value: true });
		await done(tx);
		return true;
	}

	/**
	 * Egy ismétlődő tétel egy előfordulásának feldolgozása egyetlen tranzakcióban: a szabály
	 * `lastHandled` értéke előlép, és (ha `row` van) létrejön a tétel. Ha közben másik lapon már
	 * feldolgozták (a tárolt `lastHandled` nem az elvárt), nem csinál semmit, és `null`-t ad vissza.
	 */
	async applyRecurring(
		ruleId: number,
		expectedPrev: string | null,
		handledDate: string,
		row: NewRow<Transaction> | null
	): Promise<{ rule: Recurring; tx: Transaction | null } | null> {
		// Az azonosító a szabályból és a napból képzett: ha másik eszközön is jóváhagyják ugyanezt az
		// előfordulást, ugyanaz az id keletkezik, és összefésüléskor egy tétel marad. A tranzakció
		// megnyitása előtt számoljuk ki: a Web Crypto `await`-je közben az IndexedDB-tranzakció lezárulna.
		const txId = row ? await recurringTxId(ruleId, handledDate) : 0;
		const t = this.db.transaction(['recurring', 'transactions'], 'readwrite');
		const rules = t.objectStore('recurring');
		const cur = (await wrap(rules.get(ruleId))) as Recurring | undefined;
		if (!cur || cur.lastHandled !== expectedPrev) {
			await done(t);
			return null;
		}
		const rule: Recurring = { ...cur, lastHandled: handledDate };
		rules.put(plain(rule));
		let added: Transaction | null = null;
		if (row) {
			t.objectStore('transactions').put({ ...plain(row), id: txId });
			added = { ...(row as object), id: txId } as Transaction;
		}
		await done(t);
		return { rule, tx: added };
	}

	/**
	 * Teljes csere (biztonsági mentés visszatöltése, pénznemváltás): egyetlen tranzakcióban,
	 * mindent vagy semmit. A `prefs` a meta store-ba kerül.
	 */
	async replaceAll(data: LedgerData, prefs?: Prefs): Promise<void> {
		const tx = this.db.transaction([...DATA_STORES, 'meta'], 'readwrite');
		for (const s of DATA_STORES) {
			const os = tx.objectStore(s);
			os.clear();
			for (const row of data[s] as Row[]) os.put(plain(row));
		}
		if (prefs) tx.objectStore('meta').put({ key: 'prefs', value: plain(prefs) });
		await done(tx);
	}

	/** Minden adat és beállítás törlése (a PIN-t is). */
	async wipeAll(): Promise<void> {
		const tx = this.db.transaction([...ALL_STORES], 'readwrite');
		for (const s of ALL_STORES) tx.objectStore(s).clear();
		await done(tx);
	}
}
