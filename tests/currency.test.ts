import { afterEach, describe, expect, it } from 'vitest';
import { convertMinor, findCurrency, setActiveCurrency } from '../src/lib/currency';
import { evaluateExpression, formatCompact, formatMoney, formatNumber, formatSignedMoney, parseAmount } from '../src/lib/money';

afterEach(() => setActiveCurrency('HUF'));

describe('pénznem', () => {
	it('HUF: egész forint, „Ft" végződéssel', () => {
		expect(formatMoney(12345)).toBe('12 345 Ft');
		expect(formatMoney(-500)).toBe('−500 Ft');
		expect(formatCompact(1_234)).toBe('1,2e');
		expect(formatCompact(1_500_000)).toBe('1,5M');
		expect(formatCompact(950)).toBe('950');
	});

	it('EUR: az összeg centben van, két tizedessel jelenik meg', () => {
		setActiveCurrency('EUR');
		expect(formatMoney(1250)).toBe('12,50 €');
		expect(formatMoney(5)).toBe('0,05 €');
		expect(formatMoney(-123456)).toBe('−1 234,56 €');
		expect(formatSignedMoney('refund', 999)).toBe('+9,99 €');
		expect(formatCompact(123_456)).toBe('1,2e');
		expect(formatCompact(1234)).toBe('12,3');
	});

	it('EUR: az összegmező főegységben értendő, centre kerekít', () => {
		setActiveCurrency('EUR');
		const v = (s: string) => {
			const r = evaluateExpression(s);
			return r.ok ? r.value : `ERR:${r.error}`;
		};
		expect(v('12,5')).toBe(1250);
		expect(v('12.5')).toBe(1250);
		expect(v('3')).toBe(300);
		expect(v('1,5k')).toBe(150000);
		expect(v('10/3')).toBe(333);
		expect(parseAmount('0').ok).toBe(false);
	});

	it('ismeretlen kód esetén marad a forint', () => {
		expect(setActiveCurrency('XXX').code).toBe('HUF');
		expect(findCurrency('EUR')?.decimals).toBe(2);
		expect(formatNumber(5000, 0)).toBe('5 000');
	});

	it('átváltás: 1 EUR = 395 Ft', () => {
		const huf = findCurrency('HUF')!;
		const eur = findCurrency('EUR')!;
		expect(convertMinor(39500, huf, eur, 395)).toBe(10000); // 39 500 Ft = 100,00 €
		expect(convertMinor(1, huf, eur, 395)).toBe(1); // nem lehet 0 a pozitív összeg
		expect(convertMinor(-39500, huf, eur, 395)).toBe(-10000);
		expect(convertMinor(0, huf, eur, 395)).toBe(0);
		// vissza: 100,00 € -> 39 500 Ft (a rate itt az EUR/… : 1 HUF = 1/395 EUR, azaz rate = 1/395)
		expect(convertMinor(10000, eur, huf, 1 / 395)).toBe(39500);
	});
});
