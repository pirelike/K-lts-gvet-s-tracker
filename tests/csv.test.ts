import { afterAll, describe, expect, it } from 'vitest';
import { decodeCsvBytes, detectDelimiter, parseCsv, sanitizeCell, toCsv, unsanitizeCell } from '../src/lib/csv';
import { csvAmount, transactionsToCsv } from '../src/lib/csvExport';
import { detectMapping, looksLikeHeader, parseDateCell, parseMoneyCell, planImport, type ImportOptions } from '../src/lib/csvImport';
import { setActiveCurrency } from '../src/lib/currency';
import { accounts, categories, tx } from './fixtures';

describe('CSV olvasás/írás', () => {
	it('elválasztó felismerése', () => {
		expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
		expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
		expect(detectDelimiter('a\tb\tc')).toBe('\t');
		expect(detectDelimiter('"a;b",c,d')).toBe(','); // idézőjelen belüli pontosvessző nem számít
		expect(detectDelimiter('egyetlen oszlop')).toBe(';');
	});

	it('idézőjelek, kettőzött idézőjel, sortörés a mezőben, CRLF, BOM', () => {
		const text = '﻿a;b;c\r\n"x;y";"ő ""idézet""";"sor1\nsor2"\r\n\r\n1;2;3\r\n';
		expect(parseCsv(text)).toEqual([['a', 'b', 'c'], ['x;y', 'ő "idézet"', 'sor1\nsor2'], ['1', '2', '3']]);
	});

	it('üres mezők és záró elválasztó', () => {
		expect(parseCsv('a;;c;\n;;;')).toEqual([['a', '', 'c', ''], ['', '', '', '']]);
		expect(parseCsv('')).toEqual([]);
		expect(parseCsv('a;b')).toEqual([['a', 'b']]);
	});

	it('írás → olvasás kör', () => {
		const rows = [['Dátum', 'Leírás'], ['2026-09-01', 'Lidl; "bevásárlás"'], ['2026-09-02', 'sor1\nsor2']];
		expect(parseCsv(toCsv(rows))).toEqual(rows);
	});

	it('képlet-injektálás elleni védelem és inverze', () => {
		for (const bad of ['=1+1', '+36301234567', '-2+3', '@SUM(A1)', '\tcmd']) {
			expect(sanitizeCell(bad).startsWith("'")).toBe(true);
			expect(unsanitizeCell(sanitizeCell(bad))).toBe(bad);
		}
		expect(sanitizeCell('Kávé')).toBe('Kávé');
		expect(unsanitizeCell("'valódi aposztróf")).toBe("'valódi aposztróf");
	});

	it('windows-1250 kódolású fájl is olvasható', () => {
		// „Ösztöndíj" windows-1250-ben: Ö=0xD6, ö=0xF6, í=0xED
		const bytes = new Uint8Array([0xd6, 0x73, 0x7a, 0x74, 0xf6, 0x6e, 0x64, 0xed, 0x6a]);
		expect(decodeCsvBytes(bytes.buffer)).toBe('Ösztöndíj');
		expect(decodeCsvBytes(new TextEncoder().encode('Ösztöndíj').buffer as ArrayBuffer)).toBe('Ösztöndíj');
	});
});

describe('cellák értelmezése', () => {
	it('összegek különböző formákban (HUF)', () => {
		const v = (s: string) => parseMoneyCell(s, 0);
		expect(v('1200')).toBe(1200);
		expect(v('-1 200')).toBe(-1200);
		expect(v('1 234 567 Ft')).toBe(1234567);
		expect(v('1.200')).toBe(1200);
		expect(v('1.234.567')).toBe(1234567);
		expect(v('1,234,567')).toBe(1234567);
		expect(v('1.234,56')).toBe(1235);
		expect(v('1,234.56')).toBe(1235);
		expect(v('(1200)')).toBe(-1200);
		expect(v('1200-')).toBe(-1200);
		expect(v('+500 HUF')).toBe(500);
		expect(v('−3 500')).toBe(-3500);
		expect(v('12,5')).toBe(13);
		expect(v('abc')).toBeNull();
		expect(v('')).toBeNull();
		expect(v('12a3')).toBeNull();
	});

	it('összegek (EUR: cent)', () => {
		const v = (s: string) => parseMoneyCell(s, 2);
		expect(v('12,50')).toBe(1250);
		expect(v('12.5')).toBe(1250);
		expect(v('-1 234,56 €')).toBe(-123456);
		expect(v('1.234,56')).toBe(123456);
		expect(v('1,234.56')).toBe(123456);
		expect(v('1.500')).toBe(150000); // három számjegy = ezres tagolás
	});

	it('dátumok', () => {
		expect(parseDateCell('2026-09-28')).toBe('2026-09-28');
		expect(parseDateCell('2026.09.28.')).toBe('2026-09-28');
		expect(parseDateCell('2026/9/8')).toBe('2026-09-08');
		expect(parseDateCell('28.09.2026')).toBe('2026-09-28');
		expect(parseDateCell('28/09/2026')).toBe('2026-09-28');
		expect(parseDateCell('09/28/2026')).toBe('2026-09-28'); // egyértelműen hónap/nap
		expect(parseDateCell('05/06/2026')).toBe('2026-06-05'); // nap az első
		expect(parseDateCell('2026-09-28 14:30:00')).toBe('2026-09-28');
		expect(parseDateCell('2026-02-30')).toBeNull();
		expect(parseDateCell('holnap')).toBeNull();
		expect(parseDateCell('')).toBeNull();
	});
});

describe('oszlopok felismerése', () => {
	it('fejléc felismerése és hozzárendelés (saját export és banki minta)', () => {
		expect(looksLikeHeader(['Dátum', 'Típus', 'Összeg'])).toBe(true);
		expect(looksLikeHeader(['2026-09-01', 'Lidl', '-3200'])).toBe(false);
		const m = detectMapping(['Dátum', 'Típus', 'Összeg', 'Pénznem', 'Leírás', 'Kategória', 'Számla', 'Célszámla', 'Címkék', 'Megjegyzés'], true);
		expect(m).toMatchObject({ date: 0, type: 1, amount: 2, description: 4, category: 5, account: 6, toAccount: 7, tags: 8, note: 9 });
		const bank = detectMapping(['Könyvelési dátum', 'Partner neve', 'Közlemény', 'Terhelés', 'Jóváírás'], true);
		expect(bank).toMatchObject({ date: 0, description: 1, debit: 3, credit: 4, amount: -1 });
	});

	it('fejléc nélkül a dátum, összeg, leírás, kategória, számla sorrend', () => {
		expect(detectMapping(['a', 'b', 'c'], false)).toMatchObject({ date: 0, amount: 1, description: 2, category: -1 });
	});
});

const opts = (over: Partial<ImportOptions> = {}): ImportOptions => ({
	hasHeader: true,
	mapping: detectMapping(['Dátum', 'Típus', 'Összeg', 'Pénznem', 'Leírás', 'Kategória', 'Számla', 'Célszámla', 'Címkék', 'Megjegyzés'], true),
	defaultAccountId: 1,
	createMissing: false,
	skipDuplicates: true,
	importTag: '',
	...over
});
const ctx = { accounts: accounts.filter((a) => !a.archived), categories, transactions: [] as ReturnType<typeof tx>[] };
const H = ['Dátum', 'Típus', 'Összeg', 'Pénznem', 'Leírás', 'Kategória', 'Számla', 'Célszámla', 'Címkék', 'Megjegyzés'];

describe('import terv', () => {
	it('kiadás, bevétel, átvezetés, jóváírás és típus nélküli előjeles sor', () => {
		const rows = [
			H,
			['2026-09-01', 'Kiadás', '-890', 'HUF', 'Kávé', 'Étel', 'Készpénz', '', '#egyetem reggel', 'jegyzet'],
			['2026-09-02', 'Bevétel', '48000', 'HUF', 'Ösztöndíj', 'Ösztöndíj', 'Bankkártya', '', '', ''],
			['2026-09-03', 'Átvezetés', '20000', 'HUF', 'Felvét', '', 'Bankkártya', 'Készpénz', '', ''],
			['2026-09-04', 'Visszatérítés', '6000', 'HUF', 'Pulóver', 'Étel', 'Bankkártya', '', '', '']
		];
		const plan = planImport(rows, opts(), ctx);
		expect(plan.errors).toEqual([]);
		expect(plan.rows.map((r) => [r.input.type, r.input.amount])).toEqual([['expense', 890], ['income', 48000], ['transfer', 20000], ['refund', 6000]]);
		expect(plan.rows[0].input).toMatchObject({ description: 'Kávé', note: 'jegyzet', tags: ['egyetem', 'reggel'] });
		expect(plan.rows[0].category).toEqual({ id: 1 });
		expect(plan.rows[0].account).toEqual({ id: 1 });
		expect(plan.rows[2].toAccount).toEqual({ id: 1 });
		expect(plan.rows[2].category).toBeNull();
	});

	it('típus nélkül az előjel dönt; külön terhelés/jóváírás oszlop', () => {
		const rows = [['Dátum', 'Közlemény', 'Terhelés', 'Jóváírás'], ['28.09.2026', 'Lidl', '3 200', ''], ['29.09.2026', 'Zsebpénz', '', '10 000']];
		const plan = planImport(rows, opts({ mapping: detectMapping(rows[0], true) }), ctx);
		expect(plan.errors).toEqual([]);
		expect(plan.rows.map((r) => [r.input.date, r.input.type, r.input.amount])).toEqual([['2026-09-28', 'expense', 3200], ['2026-09-29', 'income', 10000]]);
		const signed = planImport([['Dátum', 'Összeg', 'Leírás'], ['2026-09-01', '-500', 'x'], ['2026-09-02', '700', 'y']], opts({ mapping: detectMapping(['Dátum', 'Összeg', 'Leírás'], true) }), ctx);
		expect(signed.rows.map((r) => r.input.type)).toEqual(['expense', 'income']);
	});

	it('hibás sorok sorszámmal, a jó sorok bekerülnek', () => {
		const rows = [H, ['nem dátum', 'Kiadás', '-5', '', 'x', '', '', '', '', ''], ['2026-09-01', 'Kiadás', 'sok', '', 'x', '', '', '', '', ''], ['2026-09-01', 'Kiadás', '0', '', 'x', '', '', '', '', ''], ['2026-09-01', 'Átvezetés', '5', '', 'x', '', 'Készpénz', '', '', ''], ['2026-09-01', 'Kiadás', '-5', '', 'ok', 'Étel', '', '', '', '']];
		const plan = planImport(rows, opts(), ctx);
		expect(plan.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
		expect(plan.errors[3].message).toMatch(/célszámla/);
		expect(plan.rows).toHaveLength(1);
		expect(plan.rows[0].line).toBe(6);
		expect(plan.total).toBe(5);
	});

	it('ismeretlen kategória: alapból az „Egyéb"/első kategóriába; kérésre létrejön', () => {
		const rows = [H, ['2026-09-01', 'Kiadás', '-5', '', 'x', 'Új kategória', 'Új számla', '', '', '']];
		const plain = planImport(rows, opts(), ctx);
		expect(plain.rows[0].category).toEqual({ id: 1 }); // nincs „Egyéb": az első kiadási kategória
		expect(plain.rows[0].account).toEqual({ id: 1 }); // alapértelmezett számla
		const create = planImport(rows, opts({ createMissing: true }), ctx);
		expect(create.newCategories).toEqual([{ type: 'expense', name: 'Új kategória' }]);
		expect(create.newAccounts).toEqual(['Új számla']);
		expect(create.rows[0].category).toEqual({ newName: 'Új kategória', type: 'expense' });
		// számla nélkül, alapértelmezett nélkül hiba
		const none = planImport([H, ['2026-09-01', 'Kiadás', '-5', '', 'x', 'Étel', '', '', '', '']], opts({ defaultAccountId: null }), ctx);
		expect(none.errors[0].message).toMatch(/számla/);
	});

	it('duplikátumok: a meglévő tételekkel egyezők kimaradnak, de csak annyi, ahány meglévő van', () => {
		const existing = [tx({ id: 1, type: 'expense', amount: 890, date: '2026-09-01', description: 'Kávé', categoryId: 1, accountId: 1 })];
		const rows = [H, ['2026-09-01', 'Kiadás', '-890', '', 'kávé', 'Étel', 'Készpénz', '', '', ''], ['2026-09-01', 'Kiadás', '-890', '', 'Kávé', 'Étel', 'Készpénz', '', '', '']];
		const plan = planImport(rows, opts(), { ...ctx, transactions: existing });
		expect(plan.duplicates).toBe(1); // a második kávé új tétel
		expect(plan.rows.map((r) => r.duplicate)).toEqual([true, false]);
		const off = planImport(rows, opts({ skipDuplicates: false }), { ...ctx, transactions: existing });
		expect(off.duplicates).toBe(0);
	});

	it('importcímke minden sorra kerül', () => {
		const plan = planImport([H, ['2026-09-01', 'Kiadás', '-5', '', 'x', 'Étel', '', '', 'a', '']], opts({ importTag: 'Import' }), ctx);
		expect(plan.rows[0].input.tags).toEqual(['a', 'import']);
	});
});

describe('export', () => {
	afterAll(() => setActiveCurrency('HUF'));
	const txs = [
		tx({ id: 1, type: 'expense', amount: 890, date: '2026-09-01', description: '=SUM(A1)', categoryId: 1, accountId: 1, tags: ['egyetem', 'reggel'] }),
		tx({ id: 2, type: 'income', amount: 48000, date: '2026-09-02', description: 'Ösztöndíj', categoryId: 4, accountId: 2 }),
		tx({ id: 3, type: 'transfer', amount: 5000, date: '2026-09-03', categoryId: null, accountId: 2, toAccountId: 1, description: 'Felvét; "készpénz"' }),
		tx({ id: 4, type: 'refund', amount: 600, date: '2026-09-04', categoryId: 1, accountId: 2 }),
		tx({ id: 5, type: 'expense', amount: 5000, date: '2026-09-05', description: 'Lidl', categoryId: 1, accountId: 1, splits: [{ categoryId: 1, amount: 3000 }, { categoryId: 2, amount: 2000 }] })
	];

	it('BOM-mal, pontosvesszővel, előjeles összeggel; a felosztott tétel részenként egy sor', () => {
		const csv = transactionsToCsv(txs, categories, accounts);
		expect(csv.startsWith('﻿Dátum;Típus;Összeg;Pénznem;')).toBe(true);
		const rows = parseCsv(csv);
		expect(rows).toHaveLength(1 + 6);
		const byDesc = (d: string) => rows.filter((r) => r[4] === d);
		expect(byDesc("'=SUM(A1)")[0].slice(0, 4)).toEqual(['2026-09-01', 'Kiadás', '-890', 'HUF']); // képlet-védelem
		expect(byDesc('Lidl').map((r) => [r[2], r[5]])).toEqual([['-3000', 'Étel'], ['-2000', 'Közlekedés']]);
		expect(rows.find((r) => r[1] === 'Visszatérítés')![2]).toBe('600');
		expect(rows.find((r) => r[1] === 'Átvezetés')![7]).toBe('Készpénz');
	});

	it('export → import kör ugyanazokat a tételeket adja', () => {
		const rows = parseCsv(transactionsToCsv(txs, categories, accounts));
		const plan = planImport(rows, { ...opts(), mapping: detectMapping(rows[0], true), skipDuplicates: false }, { accounts: accounts.filter((a) => !a.archived), categories, transactions: [] });
		expect(plan.errors).toEqual([]);
		expect(plan.rows).toHaveLength(6);
		const first = plan.rows.find((r) => r.input.description === '=SUM(A1)')!; // a védő aposztróf lekerül
		expect(first.input).toMatchObject({ type: 'expense', amount: 890, tags: ['egyetem', 'reggel'] });
		expect(plan.rows.find((r) => r.input.type === 'refund')!.input.amount).toBe(600);
		expect(plan.rows.filter((r) => r.input.description === 'Lidl').reduce((s, r) => s + r.input.amount, 0)).toBe(5000);
	});

	it('EUR: tizedesvesszős összeg', () => {
		setActiveCurrency('EUR');
		expect(csvAmount(1250)).toBe('12,50');
		expect(csvAmount(-5)).toBe('-0,05');
		expect(transactionsToCsv([tx({ type: 'expense', amount: 999, date: '2026-09-01', description: 'x' })], categories, accounts)).toContain('-9,99;EUR');
		setActiveCurrency('HUF');
		expect(csvAmount(-1250)).toBe('-1250');
	});
});
