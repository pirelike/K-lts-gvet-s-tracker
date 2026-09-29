import { describe, expect, it } from 'vitest';
import { evaluateExpression, formatMoney, formatNumber, formatSignedMoney, parseAmount } from '../src/lib/money';

const val = (s: string) => {
	const r = evaluateExpression(s);
	return r.ok ? r.value : `ERR:${r.error}`;
};

describe('evaluateExpression', () => {
	it('egyszerű számok és ezres tagolás', () => {
		expect(val('890')).toBe(890);
		expect(val('12 000')).toBe(12000);
		expect(val('12 000')).toBe(12000);
		expect(val('1.200')).toBe(1200);
		expect(val('1.200.000')).toBe(1200000);
		expect(val('1 200 850')).toBe(1200850);
	});

	it('matek a mezőben', () => {
		expect(val('1200+850')).toBe(2050);
		expect(val('1200 + 850 - 50')).toBe(2000);
		expect(val('2*450')).toBe(900);
		expect(val('3x300')).toBe(900);
		expect(val('900/3')).toBe(300);
		expect(val('(1200+300)/3')).toBe(500);
		expect(val('2+3*4')).toBe(14);
	});

	it('k és e rövidítés = ezer', () => {
		expect(val('12k')).toBe(12000);
		expect(val('12K')).toBe(12000);
		expect(val('3e')).toBe(3000);
		expect(val('1,5k')).toBe(1500);
		expect(val('1.5k')).toBe(1500);
		expect(val('2k+500')).toBe(2500);
	});

	it('kerekít egész számra', () => {
		expect(val('10/3')).toBe(3);
		expect(val('2,5')).toBe(3);
	});

	it('hibás bemenet', () => {
		expect(val('')).toMatch(/^ERR/);
		expect(val('abc')).toMatch(/^ERR/);
		expect(val('12+')).toMatch(/^ERR/);
		expect(val('1200 850')).toMatch(/^ERR/);
		expect(val('(1+2')).toMatch(/^ERR/);
		expect(val('5/0')).toBe('ERR:Nullával nem lehet osztani');
		expect(val('99999999999999999')).toMatch(/^ERR/);
	});

	it('jelzi, ha a bemenet sima szám', () => {
		const plain = evaluateExpression('1200');
		const calc = evaluateExpression('1200+1');
		const suffixed = evaluateExpression('12k');
		expect(plain.ok && plain.plain).toBe(true);
		expect(calc.ok && calc.plain).toBe(false);
		expect(suffixed.ok && suffixed.plain).toBe(false);
	});
});

describe('parseAmount', () => {
	it('csak pozitív összeget fogad el', () => {
		expect(parseAmount('0').ok).toBe(false);
		expect(parseAmount('100-200').ok).toBe(false);
		expect(parseAmount('-5').ok).toBe(false);
		expect(parseAmount('100').ok).toBe(true);
	});
});

describe('formázás', () => {
	it('ezres tagolás nem törhető szóközzel, 4 jegyűnél is', () => {
		expect(formatNumber(1200)).toBe('1 200');
		expect(formatNumber(1234567)).toBe('1 234 567');
		expect(formatNumber(999)).toBe('999');
		expect(formatMoney(18400)).toBe('18 400 Ft');
	});
	it('előjeles megjelenítés', () => {
		expect(formatSignedMoney('income', 5000)).toBe('+5 000 Ft');
		expect(formatSignedMoney('expense', 5000)).toBe('−5 000 Ft');
		expect(formatSignedMoney('transfer', 5000)).toBe('5 000 Ft');
	});
});
