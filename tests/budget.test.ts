import { describe, expect, it } from 'vitest';
import { budgetAlerts, budgetLevel, budgetLines, crossedLevel, monthProgress, spentByCategory, totalBudgetLine } from '../src/lib/budget';
import type { Category } from '../src/lib/types';
import { categories, tx } from './fixtures';

const cats: Category[] = categories.map((c) => (c.id === 1 ? { ...c, monthlyBudget: 30000 } : c.id === 2 ? { ...c, monthlyBudget: 10000 } : c));
const data = [
	tx({ id: 1, type: 'expense', amount: 20000, date: '2026-09-05', categoryId: 1 }),
	tx({ id: 2, type: 'expense', amount: 5000, date: '2026-09-06', categoryId: 1 }),
	tx({ id: 3, type: 'refund', amount: 1000, date: '2026-09-07', categoryId: 1 }),
	tx({ id: 4, type: 'expense', amount: 12000, date: '2026-09-08', categoryId: 2 }),
	tx({ id: 5, type: 'expense', amount: 99999, date: '2026-08-31', categoryId: 1 }), // más hónap
	tx({ id: 6, type: 'transfer', amount: 5000, date: '2026-09-09', accountId: 1, toAccountId: 2, categoryId: null })
];

describe('havi keretek', () => {
	it('szintek: 80% alatt rendben, 80% felett figyelmeztetés, 100% felett túllépés', () => {
		expect(budgetLevel(7999, 10000)).toBe('ok');
		expect(budgetLevel(8000, 10000)).toBe('warn');
		expect(budgetLevel(9999, 10000)).toBe('warn');
		expect(budgetLevel(10000, 10000)).toBe('over');
		expect(budgetLevel(500, 0)).toBe('ok');
	});

	it('a költés nettó (jóváírással csökkentve), csak a hónap tételeiből', () => {
		const spent = spentByCategory(data, '2026-09');
		expect(spent.get(1)).toBe(24000);
		expect(spent.get(2)).toBe(12000);
	});

	it('sorok: a legszorosabb elöl, a keret nélküliek kimaradnak', () => {
		const lines = budgetLines(data, cats, '2026-09');
		expect(lines.map((l) => [l.name, l.level])).toEqual([
			['Közlekedés', 'over'],
			['Étel', 'warn']
		]);
		expect(lines[0].remaining).toBe(-2000);
		expect(lines[1].ratio).toBeCloseTo(0.8);
		expect(budgetAlerts(lines)).toHaveLength(2);
	});

	it('összes keret', () => {
		expect(totalBudgetLine(data, '2026-09', null)).toBeNull();
		const t = totalBudgetLine(data, '2026-09', 40000)!;
		expect(t.spent).toBe(36000);
		expect(t.level).toBe('warn');
	});

	it('átlépés-észlelés', () => {
		expect(crossedLevel('ok', 'warn')).toBe('warn');
		expect(crossedLevel('ok', 'over')).toBe('over');
		expect(crossedLevel('warn', 'over')).toBe('over');
		expect(crossedLevel('warn', 'warn')).toBeNull();
		expect(crossedLevel('over', 'warn')).toBeNull();
	});

	it('a hónap előrehaladása', () => {
		expect(monthProgress('2026-09-15', '2026-09')).toBe(0.5);
		expect(monthProgress('2026-10-01', '2026-09')).toBe(1);
		expect(monthProgress('2026-08-31', '2026-09')).toBe(0);
	});
});
