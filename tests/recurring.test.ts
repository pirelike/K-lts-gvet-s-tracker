import { describe, expect, it } from 'vitest';
import { describeSchedule, dueItems, nextOccurrence, occurrenceDate, pendingOccurrences, upcomingItems } from '../src/lib/recurring';
import type { Recurring } from '../src/lib/types';

const rule = (over: Partial<Recurring> = {}): Recurring => ({
	id: 1, type: 'expense', amount: 90000, description: 'Albérlet', categoryId: 1, accountId: 1, toAccountId: null,
	note: '', tags: [], frequency: 'monthly', interval: 1, startDate: '2026-01-05', endDate: null,
	lastHandled: null, active: true, createdAt: 1, updatedAt: 1, ...over
});

describe('ismétlődő tételek', () => {
	it('havi ismétlés: a kezdőnaphoz igazodik, hónap végén nem csúszik el', () => {
		const r = rule({ startDate: '2026-01-31' });
		expect([0, 1, 2, 3].map((n) => occurrenceDate(r, n))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
		expect(occurrenceDate(rule({ startDate: '2028-01-31' }), 1)).toBe('2028-02-29'); // szökőév
	});

	it('heti, kéthetes, éves ismétlés', () => {
		expect(occurrenceDate(rule({ frequency: 'weekly', startDate: '2026-09-01' }), 2)).toBe('2026-09-15');
		expect(occurrenceDate(rule({ frequency: 'weekly', interval: 2, startDate: '2026-09-01' }), 2)).toBe('2026-09-29');
		expect(occurrenceDate(rule({ frequency: 'yearly', startDate: '2024-02-29' }), 1)).toBe('2025-02-28');
		expect(occurrenceDate(rule({ frequency: 'monthly', interval: 3, startDate: '2026-01-10' }), 2)).toBe('2026-07-10');
	});

	it('a következő előfordulás a legutóbb feldolgozott utáni első', () => {
		expect(nextOccurrence(rule())).toBe('2026-01-05');
		expect(nextOccurrence(rule({ lastHandled: '2026-01-05' }))).toBe('2026-02-05');
		expect(nextOccurrence(rule({ lastHandled: '2026-03-20' }))).toBe('2026-04-05');
		expect(nextOccurrence(rule({ lastHandled: '2025-06-01' }))).toBe('2026-01-05');
		expect(nextOccurrence(rule({ frequency: 'weekly', startDate: '2026-09-01', lastHandled: '2026-09-15' }))).toBe('2026-09-22');
		expect(nextOccurrence(rule({ startDate: '2026-01-31', lastHandled: '2026-02-28' }))).toBe('2026-03-31');
	});

	it('lejárt szabálynál nincs következő', () => {
		expect(nextOccurrence(rule({ endDate: '2026-02-01', lastHandled: '2026-01-05' }))).toBeNull();
	});

	it('esedékes: a mai napig lejárt, feldolgozatlan előfordulások (felzárkózás)', () => {
		const due = dueItems([rule({ lastHandled: '2026-07-05' })], '2026-09-29');
		expect(due.map((d) => d.date)).toEqual(['2026-08-05', '2026-09-05']);
		expect(due[1].overdueDays).toBe(24);
		expect(dueItems([rule({ lastHandled: '2026-09-05' })], '2026-09-29')).toEqual([]);
		expect(dueItems([rule({ lastHandled: '2026-08-05' })], '2026-09-05').map((d) => d.date)).toEqual(['2026-09-05']); // ma is esedékes
	});

	it('inaktív szabály és a záródátum után nincs esedékes tétel', () => {
		expect(dueItems([rule({ active: false })], '2026-09-29')).toEqual([]);
		expect(pendingOccurrences(rule({ endDate: '2026-03-01' }), '2026-09-29')).toEqual(['2026-01-05', '2026-02-05']);
	});

	it('a felzárkózás korlátos', () => {
		expect(pendingOccurrences(rule({ frequency: 'weekly', startDate: '2020-01-06' }), '2026-09-29', 10)).toHaveLength(10);
	});

	it('közelgő tételek a mai nap után', () => {
		const up = upcomingItems([rule({ lastHandled: '2026-09-05' }), rule({ id: 2, frequency: 'weekly', startDate: '2026-09-30', lastHandled: null })], '2026-09-29', '2026-10-31');
		expect(up.map((d) => [d.rule.id, d.date])).toEqual([
			[2, '2026-09-30'],
			[1, '2026-10-05'],
			[2, '2026-10-07'],
			[2, '2026-10-14'],
			[2, '2026-10-21'],
			[2, '2026-10-28']
		]);
	});

	it('szöveges összefoglaló', () => {
		expect(describeSchedule(rule())).toBe('havonta, 5. napján');
		expect(describeSchedule(rule({ frequency: 'weekly', interval: 2 }))).toBe('2 hetente');
		expect(describeSchedule(rule({ frequency: 'yearly', startDate: '2026-03-14' }))).toBe('évente, 3. hó 14.');
	});
});
