import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DATA_STORES, DB_VERSION, inferAccountType, openLedgerDb, upgradeSchema } from '../src/lib/db/idb';
import { LedgerRepo } from '../src/lib/db/repo';

let n = 0;
const name = () => `mig-${n++}`;

/** Az 1. verziós (régi) séma, ahogy az első kiadás létrehozta – a migráció tesztjéhez. */
function openV1(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(dbName, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const s of ['accounts', 'categories', 'transactions']) db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
			db.createObjectStore('meta', { keyPath: 'key' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

const put = (db: IDBDatabase, store: string, value: object) =>
	new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).put(value);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});

describe('IndexedDB-migráció', () => {
	it('üres adatbázisnál az összes tároló létrejön', async () => {
		const db = await openLedgerDb(name());
		expect(db.version).toBe(DB_VERSION);
		for (const s of [...DATA_STORES, 'meta']) expect(db.objectStoreNames.contains(s)).toBe(true);
		db.close();
	});

	it('az 1. verziós adatbázis adatvesztés nélkül frissül: a számlák típust kapnak, az új tárolók megjelennek', async () => {
		const dbName = name();
		const v1 = await openV1(dbName);
		await put(v1, 'accounts', { id: 1, name: 'Készpénz', initialBalance: 5000, archived: false, sortOrder: 1, createdAt: 1 });
		await put(v1, 'accounts', { id: 2, name: 'OTP folyószámla', initialBalance: 0, archived: false, sortOrder: 2, createdAt: 2 });
		await put(v1, 'accounts', { id: 3, name: 'Megtakarítás', initialBalance: 0, archived: false, sortOrder: 3, createdAt: 3 });
		await put(v1, 'categories', { id: 1, name: 'Étel', type: 'expense', color: '#f97316', icon: '🍽️', monthlyBudget: null, archived: false, sortOrder: 1, createdAt: 1 });
		await put(v1, 'transactions', { id: 1, type: 'expense', amount: 890, date: '2026-09-28', description: 'Kávé', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], createdAt: 1, updatedAt: 1 });
		await put(v1, 'meta', { key: 'pin', value: { hash: 'x' } });
		v1.close();

		const repo = new LedgerRepo(await openLedgerDb(dbName));
		const data = await repo.loadAll();
		expect(data.accounts.map((a) => [a.name, a.type])).toEqual([
			['Készpénz', 'cash'],
			['OTP folyószámla', 'checking'],
			['Megtakarítás', 'savings']
		]);
		expect(data.accounts[0].initialBalance).toBe(5000);
		expect(data.transactions).toHaveLength(1);
		expect(data.transactions[0].description).toBe('Kávé');
		expect(data.recurring).toEqual([]);
		expect(await repo.getMeta('pin')).toEqual({ hash: 'x' });
		// az új tárolók használhatók
		await repo.add('templates', { name: 'Kávé', type: 'expense', amount: 890, description: 'Kávé', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], sortOrder: 1, createdAt: 1 });
		expect((await repo.loadAll()).templates).toHaveLength(1);
		repo.close();
	});

	it('a számlatípus a névből következik', () => {
		expect(inferAccountType('Készpénz')).toBe('cash');
		expect(inferAccountType('Bankkártya')).toBe('checking');
		expect(inferAccountType('Megtakarítás')).toBe('savings');
		expect(inferAccountType('Hitelkártya')).toBe('credit');
	});

	it('ha másik lap frissítené a sémát, a nyitott kapcsolat magától lezárul (nem blokkol)', async () => {
		const dbName = name();
		let closed = 0;
		const db = await openLedgerDb(dbName, { onClosed: () => closed++ });
		// „Jövőbeli" verzió egy másik lapról
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(dbName, DB_VERSION + 1);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
			req.onblocked = () => reject(new Error('blokkolt'));
		});
		expect(closed).toBe(1);
		expect(upgraded.version).toBe(DB_VERSION + 1);
		upgraded.close();
		void db;
	});

	it('blokkolt frissítésnél nem utasít el, hanem vár, és jelez', async () => {
		const dbName = name();
		const old = await openV1(dbName); // régi kód: nincs onversionchange, nyitva marad
		let blocked = 0;
		const opening = openLedgerDb(dbName, { onBlocked: () => blocked++ });
		let settled = false;
		void opening.then(() => (settled = true));
		await new Promise((r) => setTimeout(r, 50));
		expect(blocked).toBeGreaterThan(0);
		expect(settled).toBe(false);
		old.close(); // a régi lap bezárul → a frissítés lefut
		const db = await opening;
		expect(db.version).toBe(DB_VERSION);
		expect(db.objectStoreNames.contains('recurring')).toBe(true);
		db.close();
	});

	it('a 2. verziós adatbázis a 3.-ra frissül: minden rekordtípus updatedAt-et kap (= createdAt), a meglévőt nem bántja', async () => {
		const dbName = name();
		const v2 = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(dbName, 2);
			req.onupgradeneeded = (e) => upgradeSchema(req.result, req.transaction!, e.oldVersion, 2);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await put(v2, 'accounts', { id: 1, name: 'Készpénz', type: 'cash', initialBalance: 0, archived: false, sortOrder: 1, createdAt: 11 });
		await put(v2, 'categories', { id: 1, name: 'Étel', type: 'expense', color: '#f97316', icon: '', monthlyBudget: null, archived: false, sortOrder: 1, createdAt: 12 });
		await put(v2, 'transactions', { id: 1, type: 'expense', amount: 890, date: '2026-09-28', description: 'Kávé', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], createdAt: 13, updatedAt: 99 });
		await put(v2, 'recurring', { id: 1, type: 'expense', amount: 1, description: 'x', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], frequency: 'weekly', interval: 1, startDate: '2026-09-07', endDate: null, lastHandled: null, active: true, createdAt: 14 });
		await put(v2, 'templates', { id: 1, name: 'Kávé', type: 'expense', amount: null, description: '', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], sortOrder: 1, createdAt: 15 });
		await put(v2, 'goals', { id: 1, name: 'Laptop', icon: '', color: '#000000', target: 5, saved: 0, accountId: null, deadline: null, archived: false, sortOrder: 1, createdAt: 16 });
		await put(v2, 'filters', { id: 1, name: 'f', query: 'q=a', createdAt: 17 });
		await put(v2, 'meta', { key: 'prefs', value: { currency: 'EUR', totalBudget: null } });
		v2.close();

		const repo = new LedgerRepo(await openLedgerDb(dbName));
		const d = await repo.loadAll();
		expect(d.accounts[0].updatedAt).toBe(11);
		expect(d.categories[0].updatedAt).toBe(12);
		expect(d.transactions[0].updatedAt).toBe(99); // a tranzakcióké érintetlen
		expect(d.recurring[0].updatedAt).toBe(14);
		expect(d.templates[0].updatedAt).toBe(15);
		expect(d.goals[0].updatedAt).toBe(16);
		expect(d.filters[0].updatedAt).toBe(17);
		// A régi beállításoknak nincs módosítási idejük: 0, így minden valódi módosítás újabb.
		expect(await repo.getPrefs()).toEqual({ prefs: { currency: 'EUR', totalBudget: null }, updatedAt: 0 });
		repo.close();
	});

	it('a beállítások módosítási ideje a meta.prefs értékében tárolódik', async () => {
		const repo = new LedgerRepo(await openLedgerDb(name()));
		expect((await repo.getPrefs()).updatedAt).toBe(0);
		await repo.setPrefs({ currency: 'HUF', totalBudget: 5000 }, 1234);
		expect(await repo.getPrefs()).toEqual({ prefs: { currency: 'HUF', totalBudget: 5000 }, updatedAt: 1234 });
		expect(await repo.getMeta('prefs')).toEqual({ currency: 'HUF', totalBudget: 5000, updatedAt: 1234 });
		repo.close();
	});
});
