import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from '../src/lib/db/defaults';
import { openLedgerDb } from '../src/lib/db/idb';
import { LedgerRepo } from '../src/lib/db/repo';
import { ID_MAX, ID_MIN, isNewId, newId, recurringTxId } from '../src/lib/sync/ids';
import type { Transaction } from '../src/lib/types';

describe('newId', () => {
	it('mindig a [2^32, 2^53 − 1] tartományban van, és biztonságos egész', () => {
		for (let i = 0; i < 2000; i++) {
			const id = newId();
			expect(Number.isSafeInteger(id)).toBe(true);
			expect(id).toBeGreaterThanOrEqual(ID_MIN);
			expect(id).toBeLessThanOrEqual(ID_MAX);
		}
	});

	it('nem ismétlődik (a tér 2^53 nagyságú)', () => {
		const seen = new Set(Array.from({ length: 5000 }, () => newId()));
		expect(seen.size).toBe(5000);
	});

	it('a tartomány két szélét is eléri (nincs torzítás a felső biteken)', () => {
		const spy = vi.spyOn(crypto, 'getRandomValues');
		spy.mockImplementationOnce((a) => {
			(a as Uint32Array).set([0xffffffff, 0xffffffff]);
			return a;
		});
		expect(newId()).toBe(ID_MAX);
		spy.mockRestore();
	});

	it('az ID_MIN alatti nyers értéket eldobja, és újat húz', () => {
		const spy = vi.spyOn(crypto, 'getRandomValues');
		spy.mockImplementationOnce((a) => {
			(a as Uint32Array).set([0, 12345]);
			return a;
		});
		expect(newId()).toBeGreaterThanOrEqual(ID_MIN);
		spy.mockRestore();
	});

	it('isNewId: a régi sorszámokat nem tekinti újnak', () => {
		expect(isNewId(1)).toBe(false);
		expect(isNewId(ID_MIN - 1)).toBe(false);
		expect(isNewId(ID_MIN)).toBe(true);
		expect(isNewId(1.5 * ID_MIN)).toBe(true);
		expect(isNewId(2 ** 53)).toBe(false);
	});
});

describe('recurringTxId', () => {
	it('determinisztikus: ugyanaz a szabály és nap ugyanazt az azonosítót adja', async () => {
		expect(await recurringTxId(42, '2026-08-05')).toBe(await recurringTxId(42, '2026-08-05'));
	});

	it('más szabályra vagy napra más azonosítót ad', async () => {
		const a = await recurringTxId(42, '2026-08-05');
		expect(await recurringTxId(43, '2026-08-05')).not.toBe(a);
		expect(await recurringTxId(42, '2026-08-06')).not.toBe(a);
	});

	it('az új tartományban van', async () => {
		for (let d = 1; d <= 28; d++) {
			const id = await recurringTxId(7, `2026-02-${String(d).padStart(2, '0')}`);
			expect(isNewId(id)).toBe(true);
			expect(id).toBeLessThanOrEqual(ID_MAX);
		}
	});
});

describe('LedgerRepo azonosítók', () => {
	let repo: LedgerRepo;
	let n = 0;
	beforeEach(async () => {
		repo = new LedgerRepo(await openLedgerDb(`ids-${n++}`));
	});
	afterEach(() => {
		repo.close();
		vi.restoreAllMocks();
	});

	const base: Omit<Transaction, 'id'> = {
		type: 'expense',
		amount: 500,
		date: '2026-08-01',
		description: 'Kávé',
		categoryId: 101,
		accountId: 1,
		toAccountId: null,
		note: '',
		tags: [],
		createdAt: 1,
		updatedAt: 1
	};

	it('az add és az addMany új tartománybeli, egymástól különböző azonosítót ír', async () => {
		const one = await repo.add<Transaction>('transactions', { ...base });
		const many = await repo.addMany<Transaction>('transactions', [{ ...base }, { ...base }, { ...base }]);
		const ids = [one.id, ...many.map((t) => t.id)];
		expect(ids.every(isNewId)).toBe(true);
		expect(new Set(ids).size).toBe(4);
		// Amit visszakaptunk, az van az adatbázisban is.
		const stored = (await repo.loadAll()).transactions.map((t) => t.id).sort();
		expect(stored).toEqual([...ids].sort());
	});

	it('id-ütközésnél (gyakorlatilag lehetetlen) új azonosítóval újrapróbálja', async () => {
		const first = await repo.add<Transaction>('transactions', { ...base });
		// A következő húzás pontosan az előző azonosítót adja, utána újra véletlen.
		const hi = Math.floor(first.id / 2 ** 32);
		const lo = first.id % 2 ** 32;
		vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce((a) => {
			(a as Uint32Array).set([hi, lo]);
			return a;
		});
		const second = await repo.add<Transaction>('transactions', { ...base, description: 'Másik' });
		expect(second.id).not.toBe(first.id);
		const all = (await repo.loadAll()).transactions;
		expect(all).toHaveLength(2);
		expect(all.find((t) => t.id === first.id)!.description).toBe('Kávé');
	});

	it('az alapelemek fix azonosítót kapnak, így két friss eszközön ugyanazok', async () => {
		const other = new LedgerRepo(await openLedgerDb(`ids-other-${n++}`));
		try {
			await repo.seedDefaultsIfNeeded();
			await other.seedDefaultsIfNeeded();
			const a = await repo.loadAll();
			const b = await other.loadAll();
			expect(a.accounts.map((x) => x.id).sort()).toEqual(b.accounts.map((x) => x.id).sort());
			expect(a.categories.map((x) => x.id).sort()).toEqual(b.categories.map((x) => x.id).sort());
			expect(a.accounts.map((x) => x.id).sort()).toEqual(DEFAULT_ACCOUNTS.map((x) => x.id).sort());
			expect(a.accounts.every((x) => x.id < ID_MIN)).toBe(true);
			expect(a.categories.every((x) => x.id >= 101 && x.id < ID_MIN)).toBe(true);
			// Az alapkategóriák azonosítói egyediek.
			expect(new Set(DEFAULT_CATEGORIES.map((c) => c.id)).size).toBe(DEFAULT_CATEGORIES.length);
		} finally {
			other.close();
		}
	});

	it('az ismétlődő tétel előfordulásából képzett id: kétszeri jóváhagyás ugyanazt a tételt adja', async () => {
		const rule = await repo.add('recurring', {
			type: 'expense',
			amount: 1000,
			description: 'Albérlet',
			categoryId: 101,
			accountId: 1,
			toAccountId: null,
			note: '',
			tags: [],
			frequency: 'monthly',
			interval: 1,
			startDate: '2026-08-05',
			endDate: null,
			lastHandled: null,
			active: true,
			createdAt: 1
		} as never);
		const ruleId = (rule as { id: number }).id;
		const row = { ...base, recurringId: ruleId, date: '2026-08-05' };
		const r = await repo.applyRecurring(ruleId, null, '2026-08-05', row);
		expect(r!.tx!.id).toBe(await recurringTxId(ruleId, '2026-08-05'));
	});
});
