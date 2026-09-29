/** Tételek exportja CSV-be (Excelhez): az import párja, ugyanazokkal az oszlopnevekkel. */
import { sanitizeCell, toCsv } from './csv';
import { activeCurrency, scaleOf } from './currency';
import { compareTx } from './queries';
import { txParts, type Account, type Category, type Transaction, type TxType } from './types';

export const CSV_HEADER = [
	'Dátum',
	'Típus',
	'Összeg',
	'Pénznem',
	'Leírás',
	'Kategória',
	'Számla',
	'Célszámla',
	'Címkék',
	'Megjegyzés'
];

/** A CSV-ben a jóváírás „Visszatérítés": a banki kivonatokon a „Jóváírás" bejövő pénzt jelent. */
const TYPE_CSV: Record<TxType, string> = {
	expense: 'Kiadás',
	income: 'Bevétel',
	transfer: 'Átvezetés',
	refund: 'Visszatérítés'
};

/** Összeg tizedesvesszővel, ezres tagolás nélkül (Excel-barát): 1250 (EUR) -> „12,50". */
export function csvAmount(minor: number): string {
	const dec = activeCurrency().decimals;
	if (dec === 0) return String(minor);
	const abs = Math.abs(minor);
	const scale = scaleOf();
	const s = `${Math.floor(abs / scale)},${String(abs % scale).padStart(dec, '0')}`;
	return minor < 0 ? `-${s}` : s;
}

/**
 * A tételek CSV-je (legújabb elöl). A kiadás negatív, a bevétel és jóváírás pozitív előjelű.
 * A felosztott tételekből részenként egy sor készül (ugyanazzal a dátummal és leírással).
 */
export function transactionsToCsv(
	txs: readonly Transaction[],
	categories: readonly Category[],
	accounts: readonly Account[]
): string {
	const cat = new Map(categories.map((c) => [c.id, c.name]));
	const acc = new Map(accounts.map((a) => [a.id, a.name]));
	const code = activeCurrency().code;
	const rows: string[][] = [CSV_HEADER];
	for (const t of [...txs].sort(compareTx)) {
		const parts = t.type === 'transfer' ? [{ categoryId: null as number | null, amount: t.amount }] : txParts(t);
		for (const p of parts) {
			const signed = t.type === 'expense' ? -p.amount : p.amount;
			rows.push([
				t.date,
				TYPE_CSV[t.type],
				csvAmount(signed),
				code,
				sanitizeCell(t.description),
				sanitizeCell(p.categoryId != null ? (cat.get(p.categoryId) ?? '') : ''),
				sanitizeCell(acc.get(t.accountId) ?? ''),
				sanitizeCell(t.toAccountId != null ? (acc.get(t.toAccountId) ?? '') : ''),
				sanitizeCell(t.tags.join(' ')),
				sanitizeCell(t.note)
			]);
		}
	}
	// BOM: az Excel ettől ismeri fel az UTF-8-at
	return '﻿' + toCsv(rows, ';');
}
