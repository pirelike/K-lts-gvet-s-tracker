import { describe, expect, it } from 'vitest';
import {
	addDays,
	daysInMonth,
	formatDayLabel,
	formatMonthLabel,
	isValidISODate,
	isValidMonth,
	monthRange,
	shiftMonth,
	todayISO
} from '../src/lib/dates';
import { escapeLike, fold } from '../src/lib/text';

describe('dátumok', () => {
	it('érvényesség', () => {
		expect(isValidISODate('2026-02-28')).toBe(true);
		expect(isValidISODate('2026-02-30')).toBe(false);
		expect(isValidISODate('2024-02-29')).toBe(true);
		expect(isValidISODate('2026-2-3')).toBe(false);
		expect(isValidMonth('2026-13')).toBe(false);
		expect(isValidMonth('2026-09')).toBe(true);
	});
	it('hónap tartomány és léptetés', () => {
		expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
		expect(monthRange('2024-02').to).toBe('2024-02-29');
		expect(shiftMonth('2026-01', -1)).toBe('2025-12');
		expect(shiftMonth('2026-12', 1)).toBe('2027-01');
		expect(shiftMonth('2026-09', -14)).toBe('2025-07');
		expect(daysInMonth('2026-09')).toBe(30);
	});
	it('napok hozzáadása', () => {
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
	});
	it('a mai nap az adott időzónában', () => {
		const t = new Date('2026-09-29T22:30:00Z'); // Budapesten már szept. 30.
		expect(todayISO(t, 'Europe/Budapest')).toBe('2026-09-30');
		expect(todayISO(t, 'UTC')).toBe('2026-09-29');
	});
	it('magyar címkék', () => {
		expect(formatMonthLabel('2026-09')).toBe('2026. szeptember');
		expect(formatDayLabel('2026-09-29', '2026-09-29')).toBe('Ma · szept. 29., kedd');
		expect(formatDayLabel('2026-09-28', '2026-09-29')).toBe('Tegnap · szept. 28., hétfő');
		expect(formatDayLabel('2026-09-26', '2026-09-29')).toBe('szept. 26., szombat');
		expect(formatDayLabel('2025-12-03', '2026-09-29')).toBe('2025. dec. 3., szerda');
	});
});

describe('fold', () => {
	it('ékezet- és kisbetű-független', () => {
		expect(fold('Kávé')).toBe('kave');
		expect(fold('ÉTEL')).toBe('etel');
		expect(fold('Őszi   ŰR')).toBe('oszi ur');
		expect(fold('  Lidl ')).toBe('lidl');
	});
	it('LIKE escape', () => {
		expect(escapeLike('50%_a\\')).toBe('50\\%\\_a\\\\');
	});
});
