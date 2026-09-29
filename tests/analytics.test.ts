import { describe, expect, it } from 'vitest';
import { forecastMonth } from '../src/lib/forecast';
import { goalProgress } from '../src/lib/goals';
import { analyzeSpending, calendarWeeks, categoryCompare, cumulativeSpend, monthlyTrend, periodRange } from '../src/lib/stats';
import { msUntilMidnight, addMonths, daysBetween, weekdayMon0, monthStartOffset } from '../src/lib/dates';
import type { Goal, Recurring } from '../src/lib/types';
import { categories, tx } from './fixtures';

const data = [
	tx({ id: 1, type: 'expense', amount: 3000, date: '2026-07-10', description: 'Lidl', categoryId: 1 }),
	tx({ id: 2, type: 'income', amount: 50000, date: '2026-07-05' }),
	tx({ id: 3, type: 'expense', amount: 6000, date: '2026-08-10', description: 'Lidl', categoryId: 1 }),
	tx({ id: 4, type: 'expense', amount: 2000, date: '2026-08-12', description: 'Bérlet', categoryId: 2 }),
	tx({ id: 5, type: 'refund', amount: 1000, date: '2026-08-15', categoryId: 1 }),
	tx({ id: 6, type: 'expense', amount: 9000, date: '2026-09-02', description: 'Lidl', categoryId: 1, tags: ['hétvége'] }),
	tx({ id: 7, type: 'expense', amount: 1000, date: '2026-09-04', description: 'Kávé', categoryId: 1 }),
	tx({ id: 8, type: 'income', amount: 48000, date: '2026-09-05' }),
	tx({ id: 9, type: 'transfer', amount: 7000, date: '2026-09-06', categoryId: null, accountId: 2, toAccountId: 1 })
];

describe('trend', () => {
	it('havi bevétel/kiadás, régebbi elöl, hiányzó hónapok nullával; a jóváírás levonódik', () => {
		const t = monthlyTrend(data, '2026-09', 4);
		expect(t.map((p) => p.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
		expect(t.map((p) => p.expense)).toEqual([0, 3000, 7000, 10000]);
		expect(t.map((p) => p.income)).toEqual([0, 50000, 0, 48000]);
		expect(t[3].net).toBe(38000);
		expect(t[3].count).toBe(3); // az átvezetés nem számít
	});
});

describe('kategóriák összevetése az előző hónappal', () => {
	it('változás összeg és százalék szerint', () => {
		const rows = categoryCompare(data, categories, '2026-09');
		const food = rows.find((r) => r.categoryId === 1)!;
		expect(food.current).toBe(10000);
		expect(food.previous).toBe(5000);
		expect(food.delta).toBe(5000);
		expect(food.deltaPct).toBeCloseTo(1);
		const bus = rows.find((r) => r.categoryId === 2)!;
		expect(bus.current).toBe(0);
		expect(bus.deltaPct).toBe(-1);
		expect(rows[0].categoryId).toBe(1); // a legnagyobb elöl
	});
	it('új kategóriánál nincs százalék', () => {
		const rows = categoryCompare([tx({ type: 'expense', amount: 500, date: '2026-09-01', categoryId: 2 })], categories, '2026-09');
		expect(rows[0].deltaPct).toBeNull();
	});
});

describe('mire költöttem a legtöbbet', () => {
	const a = analyzeSpending(data, categories, '2026-07-01', '2026-09-30', '2026-09-29');
	it('kategóriák, helyek, legnagyobb tételek, címkék', () => {
		expect(a.total).toBe(3000 + 6000 + 2000 - 1000 + 9000 + 1000);
		expect(a.categories[0]).toMatchObject({ categoryId: 1, amount: 3000 + 6000 - 1000 + 9000 + 1000 });
		expect(a.merchants[0]).toMatchObject({ description: 'Lidl', amount: 18000, count: 3 });
		expect(a.largest[0].id).toBe(6);
		expect(a.byTag).toEqual([{ tag: 'hétvége', amount: 9000, count: 1 }]);
	});
	it('hétköznapok szerint, átlaggal', () => {
		expect(a.byWeekday).toHaveLength(7);
		expect(a.byWeekday[weekdayMon0('2026-09-02')].total).toBe(11000); // szerda: 9000 + 2000
		expect(a.byWeekday[weekdayMon0('2026-08-15')].total).toBe(0); // szombat: csak jóváírás volt, nem megy negatívba
		expect(a.byWeekday[weekdayMon0('2026-07-10')].total).toBe(4000); // péntek: 3000 + 1000
		expect(a.byWeekday[weekdayMon0('2026-07-10')].average).toBeGreaterThan(0);
		expect(weekdayMon0('2026-09-29')).toBe(1); // kedd
	});
	it('napi átlag a mai napig számol', () => {
		expect(a.dailyAverage).toBe(Math.round(a.total / (daysBetween('2026-07-01', '2026-09-29') + 1)));
	});
	it('időszakok', () => {
		expect(periodRange('month', '2026-09-29', '2026-08')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
		expect(periodRange('3m', '2026-09-29', '2026-09')).toEqual({ from: '2026-07-01', to: '2026-09-29' });
		expect(periodRange('year', '2026-09-29', '2026-09')).toEqual({ from: '2026-01-01', to: '2026-09-29' });
	});
});

describe('kumulált költés és naptár', () => {
	it('napról napra növekvő, a jóváírás csökkenti', () => {
		const c = cumulativeSpend(data, '2026-08');
		expect(c).toHaveLength(31);
		expect(c[9]).toBe(6000);
		expect(c[11]).toBe(8000);
		expect(c[14]).toBe(7000);
		expect(cumulativeSpend(data, '2026-09', 5)).toEqual([0, 9000, 9000, 10000, 10000]);
	});

	it('naptárrács: hétfőn kezdődik, üres cellák, napi összegek', () => {
		const weeks = calendarWeeks(data, '2026-09', []);
		expect(weeks.every((w) => w.length === 7)).toBe(true);
		expect(monthStartOffset('2026-09')).toBe(1); // szept. 1. kedd
		expect(weeks[0][0].date).toBeNull();
		const sep2 = weeks.flat().find((c) => c.date === '2026-09-02')!;
		expect(sep2.expense).toBe(9000);
		expect(weeks.flat().filter((c) => c.date).length).toBe(30);
		expect(weeks.flat().find((c) => c.date === '2026-09-05')!.income).toBe(48000);
	});

	it('naptár: az esedékes ismétlődő tétel jelölve van', () => {
		const rec: Recurring = { id: 1, type: 'expense', amount: 1, description: 'x', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], frequency: 'weekly', interval: 1, startDate: '2026-09-07', endDate: null, lastHandled: null, active: true, createdAt: 1 };
		const cells = calendarWeeks([], '2026-09', [rec]).flat().filter((c) => c.recurring > 0).map((c) => c.date);
		expect(cells).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
	});
});

describe('előrejelzés', () => {
	it('változó napi átlagból és a hátralévő ismétlődőkből számol', () => {
		const txs = [
			tx({ type: 'expense', amount: 10000, date: '2026-09-02', categoryId: 1 }),
			tx({ type: 'expense', amount: 20000, date: '2026-09-09', categoryId: 1 }),
			tx({ type: 'expense', amount: 5000, date: '2026-09-10', categoryId: 1, recurringId: 1 }) // nem változó
		];
		const rec: Recurring = { id: 2, type: 'expense', amount: 8000, description: 'Netflix', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], frequency: 'monthly', interval: 1, startDate: '2026-09-25', endDate: null, lastHandled: null, active: true, createdAt: 1 };
		const f = forecastMonth({ txs, recurring: [rec], today: '2026-09-10', currentBalance: 100000 });
		expect(f.spent).toBe(35000);
		expect(f.daysLeft).toBe(20);
		expect(f.dailyVariable).toBe(3000); // 30 000 / 10 nap; nincs korábbi hónap
		expect(f.upcomingExpense).toBe(8000);
		expect(f.projectedExpense).toBe(35000 + 8000 + 60000);
		expect(f.projectedBalance).toBe(100000 - 8000 - 60000);
	});

	it('a hónap elején a korábbi hónapok átlagához húz', () => {
		const txs = [
			tx({ type: 'expense', amount: 30000, date: '2026-08-10', categoryId: 1 }), // 30 000 / 31 nap ≈ 968/nap
			tx({ type: 'expense', amount: 5000, date: '2026-09-01', categoryId: 1 })
		];
		const f = forecastMonth({ txs, recurring: [], today: '2026-09-01' });
		// w = 0,1: 0,1 × 5000 + 0,9 × 967,7
		expect(f.dailyVariable).toBe(Math.round(0.1 * 5000 + 0.9 * (30000 / 31)));
		expect(f.projectedBalance).toBeNull();
	});

	it('üres adatnál nulla', () => {
		const f = forecastMonth({ txs: [], recurring: [], today: '2026-09-15' });
		expect(f.projectedExpense).toBe(0);
	});
});

describe('célok', () => {
	const goal: Goal = { id: 1, name: 'Laptop', icon: '💻', color: '#3b82f6', target: 300000, saved: 60000, accountId: null, deadline: '2027-03-29', archived: false, sortOrder: 1, createdAt: 1 };
	it('kézi haladás és havi szükséges összeg', () => {
		const p = goalProgress(goal, new Map(), '2026-09-29');
		expect(p.current).toBe(60000);
		expect(p.ratio).toBeCloseTo(0.2);
		expect(p.remaining).toBe(240000);
		expect(p.neededPerMonth).toBeGreaterThan(30000);
		expect(p.neededPerMonth).toBeLessThan(45000);
		expect(p.reached).toBe(false);
	});
	it('számlához kötött cél a számla egyenlegét követi, negatív egyenleg 0', () => {
		expect(goalProgress({ ...goal, accountId: 2 }, new Map([[2, 150000]]), '2026-09-29').current).toBe(150000);
		expect(goalProgress({ ...goal, accountId: 2 }, new Map([[2, -500]]), '2026-09-29').current).toBe(0);
		const done = goalProgress({ ...goal, accountId: 2 }, new Map([[2, 400000]]), '2026-09-29');
		expect(done.reached).toBe(true);
		expect(done.ratio).toBe(1);
		expect(done.neededPerMonth).toBeNull();
	});
});

describe('dátum segédek', () => {
	it('addMonths hónap végére igazít', () => {
		expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
		expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
		expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
	});
	it('éjfélig hátralévő idő', () => {
		expect(msUntilMidnight(new Date(2026, 8, 29, 23, 59, 0))).toBe(60_000);
		expect(msUntilMidnight(new Date(2026, 8, 29, 0, 0, 0))).toBe(86_400_000);
	});
});
