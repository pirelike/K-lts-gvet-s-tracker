import { describe, expect, it } from 'vitest';
import {
	accountBalances,
	categoryUsage,
	filterTransactions,
	groupByDay,
	knownDescriptions,
	lastUsed,
	monthSummary,
	suggestDescriptions,
	summarize,
	usedTags
} from '../src/lib/queries';
import { accounts, categories, tx } from './fixtures';

const data = [
	tx({ id: 1, type: 'expense', amount: 890, date: '2026-09-28', description: 'Kávé', tags: ['egyetem'] }),
	tx({ id: 2, type: 'expense', amount: 3200, date: '2026-09-28', description: 'Lidl bevásárlás', accountId: 2, note: 'hétvégére' }),
	tx({ id: 3, type: 'expense', amount: 9500, date: '2026-09-02', description: 'Bérlet', categoryId: 2, accountId: 2 }),
	tx({ id: 4, type: 'income', amount: 48000, date: '2026-09-05', description: 'Ösztöndíj', accountId: 2 }),
	tx({ id: 5, type: 'transfer', amount: 20000, date: '2026-09-10', accountId: 2, toAccountId: 1, description: 'Készpénzfelvétel' }),
	tx({ id: 6, type: 'expense', amount: 1500, date: '2026-08-30', description: 'Kávé' , tags: ['egyetem', 'nyaralás']})
];

describe('filterTransactions', () => {
	it('újabb elöl rendezés', () => {
		const ids = filterTransactions(data, {}).map((t) => t.id);
		expect(ids).toEqual([2, 1, 5, 4, 3, 6]);
	});
	it('szöveges keresés: ékezet- és kisbetű-független, több szó ÉS kapcsolat, megjegyzésben is', () => {
		expect(filterTransactions(data, { q: 'kave' }).map((t) => t.id)).toEqual([1, 6]);
		expect(filterTransactions(data, { q: 'LIDL bevas' }).map((t) => t.id)).toEqual([2]);
		expect(filterTransactions(data, { q: 'hetvege' }).map((t) => t.id)).toEqual([2]);
		expect(filterTransactions(data, { q: 'nincs ilyen' })).toEqual([]);
	});
	it('kategória, számla (átvezetés célszámlája is), típus, címke', () => {
		expect(filterTransactions(data, { categoryId: 2 }).map((t) => t.id)).toEqual([3]);
		expect(filterTransactions(data, { accountId: 1 }).map((t) => t.id)).toEqual([1, 5, 6]);
		expect(filterTransactions(data, { type: 'income' }).map((t) => t.id)).toEqual([4]);
		expect(filterTransactions(data, { tag: 'nyaralás' }).map((t) => t.id)).toEqual([6]);
	});
	it('időszak és összeghatár', () => {
		expect(filterTransactions(data, { from: '2026-09-01', to: '2026-09-30' })).toHaveLength(5);
		expect(filterTransactions(data, { min: 3000, max: 10000 }).map((t) => t.id)).toEqual([2, 3]);
	});
});

describe('összesítők', () => {
	it('summarize: az átvezetés nem bevétel/kiadás', () => {
		const s = summarize(data);
		expect(s.income).toBe(48000);
		expect(s.expense).toBe(890 + 3200 + 9500 + 1500);
		expect(s.transferCount).toBe(1);
		expect(s.net).toBe(48000 - 15090);
	});
	it('monthSummary: csak a hónap tételei, átvezetés nélkül, kategóriánkénti bontással', () => {
		const m = monthSummary(data, categories, '2026-09');
		expect(m.income).toBe(48000);
		expect(m.expense).toBe(890 + 3200 + 9500);
		expect(m.balance).toBe(48000 - 13590);
		expect(m.expenseByCategory.map((c) => [c.name, c.amount])).toEqual([
			['Közlekedés', 9500],
			['Étel', 4090]
		]);
		expect(m.expenseByCategory[0].share).toBeCloseTo(9500 / 13590);
		expect(m.incomeByCategory).toHaveLength(1);
	});
	it('groupByDay: napi részösszeg', () => {
		const groups = groupByDay(filterTransactions(data, { from: '2026-09-01' }));
		expect(groups.map((g) => [g.date, g.net])).toEqual([
			['2026-09-28', -4090],
			['2026-09-10', 0],
			['2026-09-05', 48000],
			['2026-09-02', -9500]
		]);
		expect(groups[1].hasIncomeOrExpense).toBe(false);
	});
});

describe('számlaegyenleg', () => {
	it('kezdőegyenleg + bevétel − kiadás ± átvezetés', () => {
		const bal = accountBalances(accounts, data);
		// Készpénz: 10000 − 890 − 1500 + 20000 (átvezetés be)
		expect(bal.get(1)).toBe(10000 - 890 - 1500 + 20000);
		// Bankkártya: 50000 − 3200 − 9500 + 48000 − 20000
		expect(bal.get(2)).toBe(50000 - 3200 - 9500 + 48000 - 20000);
		expect(bal.get(3)).toBe(0);
	});
	it('az átvezetés az összes egyenleget nem változtatja', () => {
		const withoutTransfer = data.filter((t) => t.type !== 'transfer');
		const total = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
		expect(total(accountBalances(accounts, data))).toBe(total(accountBalances(accounts, withoutTransfer)));
	});
});

describe('autocomplete és alapértelmezések', () => {
	it('knownDescriptions: legutóbbi kategória/számla/összeg, gyakoriság', () => {
		const known = knownDescriptions(data);
		const kave = known.find((k) => k.folded === 'kave')!;
		expect(kave.count).toBe(2);
		expect(kave.amount).toBe(890); // a 2026-09-28-i a legutóbbi
		expect(known.some((k) => k.description === 'Készpénzfelvétel')).toBe(false); // átvezetés kimarad
	});
	it('suggestDescriptions: szóelejére illő előre, saját típus, pontos egyezés nélkül', () => {
		const known = knownDescriptions(data);
		expect(suggestDescriptions(known, 'expense', 'lid').map((k) => k.description)).toEqual(['Lidl bevásárlás']);
		expect(suggestDescriptions(known, 'expense', 'kave')).toEqual([]);
		expect(suggestDescriptions(known, 'income', 'lid')).toEqual([]);
		expect(suggestDescriptions(known, 'expense', '')).toEqual([]);
	});
	it('lastUsed: típusonként a legutóbb létrehozott tétel értékei', () => {
		const l = lastUsed(data);
		expect(l.expense).toEqual({ categoryId: 1, accountId: 1 }); // id 6 a legutóbb létrehozott kiadás
		expect(l.income).toEqual({ categoryId: 4, accountId: 2 });
		expect(l.transfer).toEqual({ accountId: 2, toAccountId: 1 });
	});
	it('usedTags és categoryUsage', () => {
		expect(usedTags(data)).toEqual([
			{ tag: 'egyetem', count: 2 },
			{ tag: 'nyaralás', count: 1 }
		]);
		expect(categoryUsage(data).get(1)).toBe(3);
	});
});
