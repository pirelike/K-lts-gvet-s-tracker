import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeBackup, parseBackup } from '../src/lib/db/backup';
import { generateDemoTransactions } from '../src/lib/db/demo';
import { DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from '../src/lib/db/defaults';
import { deleteLedgerDb, openLedgerDb } from '../src/lib/db/idb';
import { createPinRecord, lockoutMs, pinFormatError, verifyPin } from '../src/lib/db/pin';
import { LedgerRepo } from '../src/lib/db/repo';
import { accountBalances, summarize } from '../src/lib/queries';
import type { Transaction } from '../src/lib/types';

let repo: LedgerRepo;
let n = 0;
beforeEach(async () => {
	repo?.close();
	repo = new LedgerRepo(await openLedgerDb(`test-${n++}`));
});

describe('LedgerRepo', () => {
	it('első indításkor egyszer létrehozza az alap kategóriákat és számlákat', async () => {
		expect(await repo.seedDefaultsIfNeeded()).toBe(true);
		expect(await repo.seedDefaultsIfNeeded()).toBe(false);
		const data = await repo.loadAll();
		expect(data.accounts).toHaveLength(DEFAULT_ACCOUNTS.length);
		expect(data.categories).toHaveLength(DEFAULT_CATEGORIES.length);
		expect(data.categories.filter((c) => c.type === 'income').map((c) => c.name)).toEqual(
			expect.arrayContaining(['Ösztöndíj', 'Fizetés/munka', 'Családtól', 'Egyéb'])
		);
		expect(data.categories.filter((c) => c.type === 'expense')).toHaveLength(9);
	});

	it('hozzáadás, felülírás, törlés és visszaállítás azonos azonosítóval', async () => {
		await repo.seedDefaultsIfNeeded();
		const { accounts, categories } = await repo.loadAll();
		const base = {
			type: 'expense' as const,
			amount: 890,
			date: '2026-09-28',
			description: 'Kávé',
			categoryId: categories[0].id,
			accountId: accounts[0].id,
			toAccountId: null,
			note: '',
			tags: ['egyetem'],
			createdAt: 1,
			updatedAt: 1
		};
		const a = await repo.add<Transaction>('transactions', base);
		const b = await repo.add<Transaction>('transactions', { ...base, description: 'Lidl' });
		expect(b.id).toBeGreaterThan(a.id);

		await repo.put('transactions', { ...a, amount: 1000 });
		let all = (await repo.loadAll()).transactions;
		expect(all.find((t) => t.id === a.id)!.amount).toBe(1000);

		await repo.remove('transactions', a.id);
		all = (await repo.loadAll()).transactions;
		expect(all.map((t) => t.id)).toEqual([b.id]);

		await repo.put('transactions', a); // visszavonás
		all = (await repo.loadAll()).transactions;
		expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
	});

	it('nem törlés után újra alap adatot: az „initialized" jelző megmarad', async () => {
		await repo.seedDefaultsIfNeeded();
		const { categories } = await repo.loadAll();
		await repo.removeMany('categories', categories.map((c) => c.id));
		expect(await repo.seedDefaultsIfNeeded()).toBe(false);
		expect((await repo.loadAll()).categories).toHaveLength(0);
	});

	it('meta értékek', async () => {
		expect(await repo.getMeta('x')).toBeUndefined();
		await repo.setMeta('x', { a: 1 });
		expect(await repo.getMeta('x')).toEqual({ a: 1 });
	});

	it('wipeAll mindent töröl, a PIN-t is', async () => {
		await repo.seedDefaultsIfNeeded();
		await repo.setMeta('pin', { hash: 'x' });
		await repo.wipeAll();
		const data = await repo.loadAll();
		expect(data.accounts).toHaveLength(0);
		expect(await repo.getMeta('pin')).toBeUndefined();
		expect(await repo.seedDefaultsIfNeeded()).toBe(true); // újra alap adatok
	});
});

describe('biztonsági mentés', () => {
	it('kör: kiírás → ellenőrzés → visszatöltés ugyanazt adja', async () => {
		await repo.seedDefaultsIfNeeded();
		const seeded = await repo.loadAll();
		const demo = generateDemoTransactions('2026-09-29', seeded.accounts, seeded.categories);
		await repo.addMany<Transaction>('transactions', demo);
		const before = await repo.loadAll();

		const json = JSON.stringify(makeBackup(before, new Date('2026-09-29T10:00:00Z')));
		const parsed = parseBackup(json);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		// másik (üres) adatbázisba töltjük vissza
		const other = new LedgerRepo(await openLedgerDb(`test-restore-${n++}`));
		await other.replaceAll(parsed.backup);
		const after = await other.loadAll();
		other.close();
		const byId = <T extends { id: number }>(a: T[]) => [...a].sort((x, y) => x.id - y.id);
		expect(byId(after.transactions)).toEqual(byId(before.transactions));
		expect(byId(after.categories)).toEqual(byId(before.categories));
		expect(byId(after.accounts)).toEqual(byId(before.accounts));
	});

	it('hibás mentést visszautasít', () => {
		expect(parseBackup('nem json').ok).toBe(false);
		expect(parseBackup('{"app":"masik"}').ok).toBe(false);
		const good = { app: 'koltsegvetes-tracker', version: 1, accounts: [], categories: [], transactions: [] };
		expect(parseBackup(JSON.stringify(good)).ok).toBe(true);
		expect(parseBackup(JSON.stringify({ ...good, version: 2 })).ok).toBe(false);
		const acc = { id: 1, name: 'A', initialBalance: 0 };
		const cat = { id: 1, name: 'C', type: 'expense', color: '#112233' };
		const t = { id: 1, type: 'expense', amount: 5, date: '2026-01-01', categoryId: 1, accountId: 1 };
		const withData = (over: object) =>
			JSON.stringify({ ...good, accounts: [acc], categories: [cat], transactions: [{ ...t, ...over }] });
		expect(parseBackup(withData({})).ok).toBe(true);
		expect(parseBackup(withData({ amount: -5 })).ok).toBe(false);
		expect(parseBackup(withData({ amount: 5.5 })).ok).toBe(false);
		expect(parseBackup(withData({ date: '2026-13-01' })).ok).toBe(false);
		expect(parseBackup(withData({ accountId: 99 })).ok).toBe(false);
		expect(parseBackup(withData({ categoryId: 99 })).ok).toBe(false);
		expect(parseBackup(withData({ type: 'income' })).ok).toBe(false); // kategória típusa nem egyezik
		expect(parseBackup(withData({ type: 'transfer', categoryId: null, toAccountId: 1 })).ok).toBe(false);
	});
});

describe('példaadatok', () => {
	it('determinisztikusak, érvényesek és nem érintik a jövőt', async () => {
		await repo.seedDefaultsIfNeeded();
		const { accounts, categories } = await repo.loadAll();
		const a = generateDemoTransactions('2026-09-29', accounts, categories);
		const b = generateDemoTransactions('2026-09-29', accounts, categories);
		expect(a.map((t) => [t.date, t.amount, t.description])).toEqual(b.map((t) => [t.date, t.amount, t.description]));
		expect(a.length).toBeGreaterThan(100);
		expect(a.every((t) => t.demo && t.date <= '2026-09-29' && t.amount > 0)).toBe(true);
		expect(a.some((t) => t.type === 'transfer')).toBe(true);
		const s = summarize(a.map((t, i) => ({ ...t, id: i + 1 })));
		expect(s.income).toBeGreaterThan(0);
		expect(s.expense).toBeGreaterThan(0);
		// a backup-ellenőrző is elfogadja
		const withIds = a.map((t, i) => ({ ...t, id: i + 1 }));
		expect(parseBackup(JSON.stringify(makeBackup({ accounts, categories, transactions: withIds }))).ok).toBe(true);
		expect(accountBalances(accounts, withIds).size).toBe(accounts.length);
	});
});

describe('PIN', () => {
	it('formátum', () => {
		expect(pinFormatError('1234')).toBeNull();
		expect(pinFormatError('12345678')).toBeNull();
		expect(pinFormatError('123')).toBeTruthy();
		expect(pinFormatError('123456789')).toBeTruthy();
		expect(pinFormatError('12a4')).toBeTruthy();
	});
	it('hash-elés és ellenőrzés; a PIN nem olvasható vissza a rekordból', async () => {
		const rec = await createPinRecord('4821');
		expect(JSON.stringify(rec)).not.toContain('4821');
		expect(await verifyPin('4821', rec)).toBe(true);
		expect(await verifyPin('4822', rec)).toBe(false);
		const rec2 = await createPinRecord('4821');
		expect(rec2.salt).not.toBe(rec.salt); // sózott
		expect(rec2.hash).not.toBe(rec.hash);
	});
	it('növekvő várakozás a hibás próbák után', () => {
		expect(lockoutMs(4)).toBe(0);
		expect(lockoutMs(5)).toBe(30_000);
		expect(lockoutMs(6)).toBe(60_000);
		expect(lockoutMs(30)).toBe(15 * 60_000);
	});
});

it('deleteLedgerDb törli az adatbázist', async () => {
	const name = `del-${n++}`;
	const r = new LedgerRepo(await openLedgerDb(name));
	await r.seedDefaultsIfNeeded();
	r.close();
	await deleteLedgerDb(name);
	const again = new LedgerRepo(await openLedgerDb(name));
	expect((await again.loadAll()).accounts).toHaveLength(0);
	again.close();
});

describe('példaadatok realisztikussága', () => {
	// A demó a mai naphoz igazodik: több különböző „mai" dátumra is nemnegatív marad minden egyenleg.
	it.each(['2026-01-02', '2026-02-28', '2026-03-31', '2026-06-15', '2026-09-01', '2026-09-29', '2026-12-31'])(
		'a számlák egyenlege sosem megy negatívba (ma: %s)',
		async (today) => {
			await repo.seedDefaultsIfNeeded();
			const { accounts, categories } = await repo.loadAll();
			const rows = generateDemoTransactions(today, accounts, categories).map((t, i) => ({ ...t, id: i + 1 }));
			expect(rows.length).toBeGreaterThan(90);
			const running = new Map<number, number>(accounts.map((a) => [a.id, a.initialBalance]));
			const order = (t: { type: string }) => (t.type === 'income' ? 0 : t.type === 'transfer' ? 1 : 2);
			const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order(a) - order(b)));
			for (const t of sorted) {
				if (t.type === 'income') running.set(t.accountId, running.get(t.accountId)! + t.amount);
				else if (t.type === 'expense') running.set(t.accountId, running.get(t.accountId)! - t.amount);
				else {
					running.set(t.accountId, running.get(t.accountId)! - t.amount);
					running.set(t.toAccountId!, running.get(t.toAccountId!)! + t.amount);
				}
				for (const [id, v] of running) expect(v, `számla ${id} ${t.date}`).toBeGreaterThanOrEqual(0);
			}
		}
	);
});
