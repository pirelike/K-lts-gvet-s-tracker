/**
 * Pénznemek. Az összegek mindig egész számok a pénznem **legkisebb egységében**
 * (HUF-nál forint, EUR-nál cent), így a kerekítési hibák kizártak. Az aktív pénznem a
 * beállításokból töltődik be (lásd `auth.svelte.ts`), és a formázás/beolvasás ezt használja.
 */

export interface Currency {
	code: string;
	symbol: string;
	/** Tizedesjegyek száma (a legkisebb egység 10^-decimals főegység). */
	decimals: number;
	name: string;
}

export const CURRENCIES: readonly Currency[] = [
	{ code: 'HUF', symbol: 'Ft', decimals: 0, name: 'magyar forint' },
	{ code: 'EUR', symbol: '€', decimals: 2, name: 'euró' },
	{ code: 'USD', symbol: '$', decimals: 2, name: 'amerikai dollár' },
	{ code: 'GBP', symbol: '£', decimals: 2, name: 'font sterling' },
	{ code: 'CHF', symbol: 'CHF', decimals: 2, name: 'svájci frank' },
	{ code: 'PLN', symbol: 'zł', decimals: 2, name: 'lengyel zloty' },
	{ code: 'CZK', symbol: 'Kč', decimals: 2, name: 'cseh korona' },
	{ code: 'RON', symbol: 'lei', decimals: 2, name: 'román lej' },
	{ code: 'JPY', symbol: '¥', decimals: 0, name: 'japán jen' }
];

export const DEFAULT_CURRENCY = CURRENCIES[0];

export function findCurrency(code: string | null | undefined): Currency | undefined {
	return CURRENCIES.find((c) => c.code === code);
}

let active: Currency = DEFAULT_CURRENCY;

export function activeCurrency(): Currency {
	return active;
}

/** Ismeretlen kód esetén marad a forint. */
export function setActiveCurrency(code: string | null | undefined): Currency {
	active = findCurrency(code) ?? DEFAULT_CURRENCY;
	return active;
}

/** Egy főegység hány legkisebb egység (HUF: 1, EUR: 100). */
export const scaleOf = (c: Currency = active) => 10 ** c.decimals;

/**
 * Átváltás pénznemek között. `rate` = hány `from` pénznem egy `to` pénznem
 * (pl. 1 EUR = 395 HUF → from: HUF, to: EUR, rate: 395). Az eredmény a `to` legkisebb egységében,
 * legalább 1 (pozitív összeg nem lehet 0), előjelet megtartja.
 */
export function convertMinor(minor: number, from: Currency, to: Currency, rate: number): number {
	if (minor === 0) return 0;
	const major = minor / scaleOf(from);
	const converted = Math.round((major / rate) * scaleOf(to));
	if (converted === 0) return minor > 0 ? 1 : -1;
	return converted;
}
