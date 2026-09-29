import { describe, expect, it } from 'vitest';
import { accountBalances, categoryUsage, filterTransactions, groupByDay, knownDescriptions, monthSummary, summarize } from '../src/lib/queries';
import { resolveSplits, validateTx, type TxFormValues } from '../src/lib/validation';
import { accounts, categories, tx } from './fixtures';

const data = [
	tx({ id: 1, type: 'expense', amount: 15000, date: '2026-09-05', description: 'Pulóver', categoryId: 1 }),
	tx({ id: 2, type: 'refund', amount: 6000, date: '2026-09-09', description: 'Visszavitt pulóver', categoryId: 1 }),
	tx({ id: 3, type: 'expense', amount: 4000, date: '2026-09-10', description: 'Lidl', categoryId: 1, splits: [{ categoryId: 1, amount: 2500 }, { categoryId: 2, amount: 1500 }] }),
	tx({ id: 4, type: 'income', amount: 48000, date: '2026-09-11', description: 'Ösztöndíj' })
];

describe('jóváírás (visszatérítés)', () => {
	it('csökkenti a kategória költését és a havi kiadást, nem számít bevételnek', () => {
		const m = monthSummary(data, categories, '2026-09');
		expect(m.income).toBe(48000);
		expect(m.refund).toBe(6000);
		expect(m.expense).toBe(15000 - 6000 + 4000);
		expect(m.balance).toBe(48000 - 13000);
		const food = m.expenseByCategory.find((c) => c.categoryId === 1)!;
		expect(food.amount).toBe(15000 - 6000 + 2500); // a felosztott tétel csak a saját részével számít
		expect(m.expenseByCategory.find((c) => c.categoryId === 2)!.amount).toBe(1500);
	});

	it('növeli a számla egyenlegét', () => {
		const bal = accountBalances(accounts, data);
		expect(bal.get(1)).toBe(10000 - 15000 + 6000 - 4000 + 48000);
	});

	it('a napi részösszegben és a szűrésben is jóváírásként viselkedik', () => {
		const groups = groupByDay(filterTransactions(data, {}));
		expect(groups.find((g) => g.date === '2026-09-09')!.net).toBe(6000);
		expect(filterTransactions(data, { type: 'refund' }).map((t) => t.id)).toEqual([2]);
		const s = summarize(data);
		expect(s.grossExpense).toBe(19000);
		expect(s.expense).toBe(13000);
	});

	it('ha csak jóváírás van a kategóriában, kimarad a bontásból', () => {
		const m = monthSummary([tx({ type: 'refund', amount: 500, date: '2026-09-01', categoryId: 1 })], categories, '2026-09');
		expect(m.expenseByCategory).toEqual([]);
	});

	it('az autocomplete nem tanul jóváírásból', () => {
		expect(knownDescriptions(data).some((k) => k.description.startsWith('Visszavitt'))).toBe(false);
	});
});

describe('felosztott tétel', () => {
	it('a kategória-szűrő a részekre is illeszkedik, a használat minden részt számol', () => {
		expect(filterTransactions(data, { categoryId: 2 }).map((t) => t.id)).toEqual([3]);
		expect(categoryUsage(data).get(2)).toBe(1);
		expect(categoryUsage(data).get(1)).toBe(3); // 2 sima tétel + 1 felosztott rész
	});

	const base: TxFormValues = {
		type: 'expense', amount: '5000', date: '2026-09-28', description: 'Lidl',
		categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: ''
	};
	const ctx = { categories, accounts };

	it('az összegek egyeznek; egy üres rész megkapja a maradékot; a fő kategória a legnagyobb', () => {
		const ok = validateTx({ ...base, splits: [{ categoryId: 1, amount: '3000' }, { categoryId: 2, amount: '' }] }, ctx);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.value.splits).toEqual([{ categoryId: 1, amount: 3000 }, { categoryId: 2, amount: 2000 }]);
			expect(ok.value.categoryId).toBe(1);
		}
		const big = validateTx({ ...base, splits: [{ categoryId: 1, amount: '1000' }, { categoryId: 2, amount: '4000' }] }, ctx);
		if (big.ok) expect(big.value.categoryId).toBe(2);
		else throw new Error('elfogadnia kellett volna');
	});

	it('hibák: nem egyező összeg, kevés rész, ismétlődő vagy rossz típusú kategória, archivált', () => {
		const err = (splits: TxFormValues['splits']) => {
			const r = validateTx({ ...base, splits }, ctx);
			return r.ok ? null : r.errors.splits;
		};
		expect(err([{ categoryId: 1, amount: '3000' }, { categoryId: 2, amount: '1000' }])).toMatch(/kevesebb/);
		expect(err([{ categoryId: 1, amount: '3000' }, { categoryId: 2, amount: '3000' }])).toMatch(/több/);
		expect(err([{ categoryId: 1, amount: '5000' }])).toMatch(/két rész/);
		expect(err([{ categoryId: 1, amount: '2000' }, { categoryId: 1, amount: '3000' }])).toMatch(/csak egyszer/);
		expect(err([{ categoryId: 1, amount: '2000' }, { categoryId: 4, amount: '3000' }])).toMatch(/kategóriát/);
		expect(err([{ categoryId: 1, amount: '2000' }, { categoryId: 3, amount: '3000' }])).toMatch(/archivált/);
		expect(err([{ categoryId: 1, amount: '' }, { categoryId: 2, amount: '' }])).toMatch(/egy rész/);
		expect(err([{ categoryId: 1, amount: '6000' }, { categoryId: 2, amount: '' }])).toMatch(/meghaladja/);
	});

	it('szerkesztésnél a már mentett archivált kategória megmaradhat', () => {
		const r = resolveSplits(
			[{ categoryId: 1, amount: '2000' }, { categoryId: 3, amount: '3000' }], 5000, 'expense',
			{ categories, existing: { categoryId: 1, accountId: 1, toAccountId: null, splitCategoryIds: [3] } }
		);
		expect(r.ok).toBe(true);
	});

	it('jóváírás csak kiadási kategóriával érvényes; bevételi kategóriával nem', () => {
		const good = validateTx({ ...base, type: 'refund', description: '' }, ctx);
		expect(good.ok).toBe(true);
		const bad = validateTx({ ...base, type: 'refund', categoryId: 4 }, ctx);
		expect(bad.ok).toBe(false);
		const income = validateTx({ ...base, type: 'income', categoryId: 1 }, ctx);
		expect(income.ok).toBe(false); // a bevétel továbbra is bevételi kategória
	});
});
