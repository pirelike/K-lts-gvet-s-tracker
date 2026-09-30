/**
 * Az adatbázis-réteg: egyszerű CRUD az IndexedDB fölött. Nem tud Svelte-ről – így Node alatt
 * (fake-indexeddb-vel) is tesztelhető.
 */
import { DEFAULT_PREFS, type Account, type LedgerSnapshot, type Prefs, type Recurring, type Transaction } from '../types';
import { newId, recurringTxId } from '../sync/ids';
import { stamp } from '../sync/stamp';
import { isEpoch, newEpoch, tombstoneKey, type SyncEpoch, type Tombstones } from '../sync/tombstones';
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

	/**
	 * Beszúrás vagy felülírás a megadott azonosítóval (szerkesztés, törlés visszavonása). Ha az
	 * azonosítóra törlési jelölő volt, az megszűnik: a visszaállított sor él.
	 */
	async put<T extends Row>(store: DataStore, value: T): Promise<void> {
		await this.putMany(store, [value]);
	}

	/** Több sor felülírása egyetlen tranzakcióban (csoportos módosítás, sorrend). */
	async putMany<T extends Row>(store: DataStore, values: T[]): Promise<void> {
		if (values.length === 0) return;
		const tx = this.db.transaction([store, 'meta'], 'readwrite');
		const os = tx.objectStore(store);
		for (const v of values) os.put(plain(v));
		await untombstone(tx.objectStore('meta'), store, values.map((v) => v.id));
		await done(tx);
	}

	/**
	 * Törlés. A törlési jelölő ugyanabban az IndexedDB-tranzakcióban íródik, mint a törlés, így nem
	 * maradhat jelölő nélküli törlés. A jelölő ideje mindig újabb a törölt sor `updatedAt` értékénél:
	 * a törlés az általa törölt változatot mindig legyőzi.
	 */
	async remove(store: DataStore, id: number): Promise<void> {
		await this.removeMany(store, [id]);
	}

	async removeMany(store: DataStore, ids: number[]): Promise<void> {
		if (ids.length === 0) return;
		const tx = this.db.transaction([store, 'meta'], 'readwrite');
		const os = tx.objectStore(store);
		const meta = tx.objectStore('meta');
		const tombstones = await readTombstones(meta);
		const rows = await Promise.all(ids.map((id) => wrap(os.get(id)) as Promise<{ updatedAt?: number } | undefined>));
		ids.forEach((id, i) => {
			os.delete(id);
			if (rows[i]) tombstones[tombstoneKey(store, id)] = Math.max(stamp(), (rows[i]!.updatedAt ?? 0) + 1);
		});
		meta.put({ key: 'tombstones', value: tombstones });
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

	/**
	 * Mint a `setMeta`, de a JSON-kerülő nélkül, az IndexedDB saját (structured clone) másolásával. Kell
	 * a `CryptoKey`-hez (szinkronkulcs), amit a JSON-kerülő értéktelen `{}`-vá tenne.
	 */
	async setMetaRaw<T>(key: string, value: T): Promise<void> {
		const tx = this.db.transaction('meta', 'readwrite');
		tx.objectStore('meta').put({ key, value });
		await done(tx);
	}

	/** A beállítások a módosítás idejével (a szinkronhoz); a `meta.prefs` értéke a kettő együtt. */
	async getPrefs(): Promise<{ prefs: Prefs; updatedAt: number }> {
		const stored = await this.getMeta<Prefs & { updatedAt?: number }>('prefs');
		if (!stored) return { prefs: DEFAULT_PREFS, updatedAt: 0 };
		const { updatedAt, ...prefs } = stored;
		return { prefs: { ...DEFAULT_PREFS, ...prefs }, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 };
	}

	async setPrefs(prefs: Prefs, updatedAt: number): Promise<void> {
		await this.setMeta('prefs', { ...prefs, updatedAt });
	}

	/** A szinkronhoz tartozó adatok: a korszak (még nincs, ha az eszköz nem csatlakozott) és a törlési jelölők. */
	async getSyncMeta(): Promise<{ epoch: SyncEpoch | null; tombstones: Tombstones }> {
		const tx = this.db.transaction('meta', 'readonly');
		const meta = tx.objectStore('meta');
		const [epoch, tombstones] = await Promise.all([readEpoch(meta), readTombstones(meta)]);
		return { epoch, tombstones };
	}

	/** Új korszak indítása (az adatok egésze egyszerre cserélődött): a régi jelölők elavulnak. */
	async startEpoch(): Promise<SyncEpoch> {
		const epoch = newEpoch();
		const tx = this.db.transaction('meta', 'readwrite');
		const meta = tx.objectStore('meta');
		meta.put({ key: 'syncEpoch', value: epoch });
		meta.put({ key: 'tombstones', value: {} });
		await done(tx);
		return epoch;
	}

	/** Ha még nincs korszak (első csatlakozás előtt), létrehoz egyet; a meglévőt visszaadja. */
	async ensureEpoch(): Promise<SyncEpoch> {
		const { epoch } = await this.getSyncMeta();
		return epoch ?? this.startEpoch();
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
		// Az `updatedAt` 0, így bármilyen valódi módosítás felülírja az alapértéket összefésüléskor.
		DEFAULT_ACCOUNTS.forEach((a, i) => tx.objectStore('accounts').put({ ...a, createdAt: now + i, updatedAt: 0 }));
		DEFAULT_CATEGORIES.forEach((c, i) => tx.objectStore('categories').put({ ...c, createdAt: now + i, updatedAt: 0 }));
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
		const t = this.db.transaction(['recurring', 'transactions', 'meta'], 'readwrite');
		const rules = t.objectStore('recurring');
		const cur = (await wrap(rules.get(ruleId))) as Recurring | undefined;
		if (!cur || cur.lastHandled !== expectedPrev) {
			await done(t);
			return null;
		}
		const rule: Recurring = { ...cur, lastHandled: handledDate, updatedAt: stamp() };
		rules.put(plain(rule));
		let added: Transaction | null = null;
		if (row) {
			t.objectStore('transactions').put({ ...plain(row), id: txId });
			await untombstone(t.objectStore('meta'), 'transactions', [txId]);
			added = { ...(row as object), id: txId } as Transaction;
		}
		await done(t);
		return { rule, tx: added };
	}

	/**
	 * Teljes csere (biztonsági mentés visszatöltése, pénznemváltás, szinkron eredményének átvétele):
	 * egyetlen tranzakcióban, mindent vagy semmit. A `prefs` a meta store-ba kerül.
	 *
	 * Ha nincs `sync`, az adatok egésze cserélődik, ezért új korszak indul, és a törlési jelölők
	 * elavulnak. A szinkron a saját korszakát és az összefésült jelölőket adja át.
	 */
	async replaceAll(
		data: LedgerData,
		prefs?: Prefs,
		prefsUpdatedAt: number = stamp(),
		sync?: { epoch: SyncEpoch; tombstones: Tombstones }
	): Promise<void> {
		const tx = this.db.transaction([...DATA_STORES, 'meta'], 'readwrite');
		for (const s of DATA_STORES) {
			const os = tx.objectStore(s);
			os.clear();
			for (const row of data[s] as Row[]) os.put(plain(row));
		}
		const meta = tx.objectStore('meta');
		if (prefs) meta.put({ key: 'prefs', value: { ...plain(prefs), updatedAt: prefsUpdatedAt } });
		meta.put({ key: 'syncEpoch', value: sync?.epoch ?? newEpoch() });
		meta.put({ key: 'tombstones', value: sync ? plain(sync.tombstones) : {} });
		await done(tx);
	}

	/** Minden adat és beállítás törlése (a PIN-t is). */
	async wipeAll(): Promise<void> {
		const tx = this.db.transaction([...ALL_STORES], 'readwrite');
		for (const s of ALL_STORES) tx.objectStore(s).clear();
		await done(tx);
	}
}

async function readTombstones(meta: IDBObjectStore): Promise<Tombstones> {
	const row = (await wrap(meta.get('tombstones'))) as { value?: Tombstones } | undefined;
	return row?.value && typeof row.value === 'object' ? { ...row.value } : {};
}

async function readEpoch(meta: IDBObjectStore): Promise<SyncEpoch | null> {
	const row = (await wrap(meta.get('syncEpoch'))) as { value?: unknown } | undefined;
	return isEpoch(row?.value) ? row.value : null;
}

/** A megadott azonosítók törlési jelölőinek megszüntetése (ha voltak); a `meta` tárolót csak ilyenkor írja. */
async function untombstone(meta: IDBObjectStore, store: DataStore, ids: number[]): Promise<void> {
	const tombstones = await readTombstones(meta);
	let changed = false;
	for (const id of ids) {
		const key = tombstoneKey(store, id);
		if (key in tombstones) {
			delete tombstones[key];
			changed = true;
		}
	}
	if (changed) meta.put({ key: 'tombstones', value: tombstones });
}
