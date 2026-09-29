/**
 * CSV-import: oszlop-hozzárendelés, sorok értelmezése, hiányzó kategóriák/számlák terve és
 * duplikátumok kiszűrése. Tiszta függvények; az adatbázisba írást a `ledger.importCsv` végzi.
 */
import { unsanitizeCell } from './csv';
import { activeCurrency } from './currency';
import { isValidISODate } from './dates';
import { fold } from './text';
import type { Account, Category, CategoryType, Transaction, TxInput, TxType } from './types';
import { MAX_AMOUNT, MAX_DESCRIPTION, MAX_NOTE, MAX_TAG, MAX_TAGS, categoryTypeFor } from './types';

export type ImportField =
	| 'date'
	| 'amount'
	| 'debit'
	| 'credit'
	| 'type'
	| 'description'
	| 'category'
	| 'account'
	| 'toAccount'
	| 'tags'
	| 'note';

export const IMPORT_FIELDS: { key: ImportField; label: string; required?: boolean }[] = [
	{ key: 'date', label: 'Dátum', required: true },
	{ key: 'amount', label: 'Összeg (előjeles is lehet)', required: true },
	{ key: 'debit', label: 'Terhelés (kiadás) oszlop' },
	{ key: 'credit', label: 'Jóváírás (bevétel) oszlop' },
	{ key: 'type', label: 'Típus' },
	{ key: 'description', label: 'Leírás' },
	{ key: 'category', label: 'Kategória' },
	{ key: 'account', label: 'Számla' },
	{ key: 'toAccount', label: 'Célszámla (átvezetésnél)' },
	{ key: 'tags', label: 'Címkék' },
	{ key: 'note', label: 'Megjegyzés' }
];

/** Az egyes mezők oszlopindexe (-1 = nincs). */
export type ColumnMapping = Record<ImportField, number>;

const ALIASES: Record<ImportField, string[]> = {
	date: ['datum', 'date', 'konyvelesi datum', 'teljesites datuma', 'tranzakcio datuma', 'ertaknap', 'ertek nap', 'idopont', 'nap'],
	amount: ['osszeg', 'amount', 'tranzakcio osszege', 'forgalom', 'ertek', 'osszeg huf', 'osszeg ft'],
	debit: ['terheles', 'debit', 'kiadas osszege', 'ki'],
	credit: ['jovairas', 'credit', 'bevetel osszege', 'be'],
	type: ['tipus', 'type', 'irany', 'tranzakcio tipusa'],
	description: ['leiras', 'description', 'megnevezes', 'partner', 'partner neve', 'kedvezmenyezett', 'kozlemeny', 'tetel', 'nev', 'merchant', 'megjegyzes / kozlemeny'],
	category: ['kategoria', 'category'],
	account: ['szamla', 'account', 'szamlanev', 'forras szamla'],
	toAccount: ['celszamla', 'cel szamla', 'to account', 'szamla (cel)'],
	tags: ['cimkek', 'cimke', 'tags', 'tag'],
	note: ['megjegyzes', 'note', 'jegyzet', 'poznamka']
};

/** Az első sor fejléc-e (legalább két ismert oszlopnevet tartalmaz). */
export function looksLikeHeader(row: readonly string[]): boolean {
	const cells = row.map((c) => fold(c));
	let hits = 0;
	for (const key of Object.keys(ALIASES) as ImportField[]) {
		if (cells.some((c) => ALIASES[key].includes(c))) hits++;
	}
	return hits >= 2;
}

/** Oszlopok kitalálása a fejlécből (fejléc nélkül: dátum, összeg, leírás, kategória, számla sorrendben). */
export function detectMapping(headers: readonly string[], hasHeader: boolean): ColumnMapping {
	const map = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, -1])) as ColumnMapping;
	if (!hasHeader) {
		const order: ImportField[] = ['date', 'amount', 'description', 'category', 'account'];
		order.forEach((k, i) => {
			if (i < headers.length) map[k] = i;
		});
		return map;
	}
	const used = new Set<number>();
	const cells = headers.map((h) => fold(h));
	// A pontos egyezés előnyt élvez; a hosszabb (specifikusabb) aliasok előbb.
	for (const key of ['toAccount', 'date', 'amount', 'debit', 'credit', 'type', 'category', 'account', 'tags', 'description', 'note'] as ImportField[]) {
		const idx = cells.findIndex((c, i) => !used.has(i) && ALIASES[key].includes(c));
		if (idx >= 0) {
			map[key] = idx;
			used.add(idx);
		}
	}
	return map;
}

/**
 * Pénzösszeg-cella értelmezése: „-1 234,50 Ft", „1.234,56", „1,234.56", „(1200)", „1200-".
 * Az eredmény előjeles egész az aktív pénznem legkisebb egységében, vagy null.
 */
export function parseMoneyCell(text: string, decimals: number = activeCurrency().decimals): number | null {
	let s = text.trim();
	if (!s) return null;
	let neg = false;
	if (/^\(.*\)$/.test(s)) {
		neg = true;
		s = s.slice(1, -1);
	}
	if (/^[-−–]/.test(s)) {
		neg = !neg;
		s = s.slice(1);
	} else if (/[-−–]$/.test(s)) {
		neg = !neg;
		s = s.slice(0, -1);
	}
	s = s.replace(/^\+/, '');
	// szóközök, majd a pénznem jele/neve elöl vagy hátul („Ft", „HUF", „€", „zł")
	s = s.replace(/[\s\u00a0\u202f]/g, '').replace(/^[\p{L}€$£¥]+/u, '').replace(/[\p{L}€$£¥]+\.?$/u, '');
	if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
	const dots = (s.match(/\./g) ?? []).length;
	const commas = (s.match(/,/g) ?? []).length;
	let normalized: string;
	if (dots > 0 && commas > 0) {
		const decSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
		const thousand = decSep === ',' ? '.' : ',';
		normalized = s.split(thousand).join('').replace(decSep, '.');
	} else if (dots + commas > 0) {
		const sep = dots > 0 ? '.' : ',';
		const count = dots + commas;
		const after = s.length - s.lastIndexOf(sep) - 1;
		// több elválasztó, vagy pontosan három számjegy utánuk = ezres tagolás
		normalized = count > 1 || after === 3 ? s.split(sep).join('') : s.replace(sep, '.');
	} else normalized = s;
	const value = Number(normalized);
	if (!Number.isFinite(value)) return null;
	const minor = Math.round(value * 10 ** decimals);
	if (minor > MAX_AMOUNT) return null;
	return neg ? -minor : minor;
}

/** Dátum-cella: YYYY-MM-DD, YYYY.MM.DD., YYYY/MM/DD, DD.MM.YYYY, DD/MM/YYYY (a nap az első, kivéve ha a második > 12). */
export function parseDateCell(text: string): string | null {
	const s = text.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '').replace(/\.$/, '');
	const pad = (n: number) => String(n).padStart(2, '0');
	let m = /^(\d{4})[-./\s]+(\d{1,2})[-./\s]+(\d{1,2})$/.exec(s);
	let y: number, mo: number, d: number;
	if (m) {
		[y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	} else if ((m = /^(\d{1,2})[-./\s]+(\d{1,2})[-./\s]+(\d{4})$/.exec(s))) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		y = Number(m[3]);
		// pont/kötőjel: nap.hónap; per jelnél a második > 12 esetén hónap/nap (angol forma)
		if (s.includes('/') && b > 12 && a <= 12) [mo, d] = [a, b];
		else [d, mo] = [a, b];
	} else return null;
	const iso = `${y}-${pad(mo)}-${pad(d)}`;
	return isValidISODate(iso) ? iso : null;
}

const TYPE_WORDS: Record<string, TxType> = {
	kiadas: 'expense', expense: 'expense', ki: 'expense', koltes: 'expense', terheles: 'expense', debit: 'expense',
	bevetel: 'income', income: 'income', be: 'income', jovairas: 'income', credit: 'income',
	atvezetes: 'transfer', transfer: 'transfer',
	visszaterites: 'refund', refund: 'refund'
};

export interface ImportOptions {
	hasHeader: boolean;
	mapping: ColumnMapping;
	/** Ha a fájlban nincs számla, ide kerülnek a tételek. */
	defaultAccountId: number | null;
	/** Ismeretlen kategória/számla létrehozása (különben az „Egyéb"-be / az alapértelmezett számlára kerül). */
	createMissing: boolean;
	skipDuplicates: boolean;
	/** Ez a címke kerül minden importált tételre (üres = nincs). */
	importTag: string;
}

/** Egy beolvasott sor; a kategória/számla vagy meglévő azonosító, vagy még létrehozandó név. */
export interface ImportedRow {
	line: number;
	input: Omit<TxInput, 'categoryId' | 'accountId' | 'toAccountId'>;
	category: { id: number } | { newName: string; type: CategoryType } | null;
	account: { id: number } | { newName: string } | null;
	toAccount: { id: number } | { newName: string } | null;
	duplicate: boolean;
}

export interface ImportPlan {
	rows: ImportedRow[];
	errors: { line: number; message: string }[];
	newCategories: { type: CategoryType; name: string }[];
	newAccounts: string[];
	duplicates: number;
	/** Hány sor lett feldolgozva (fejléc nélkül). */
	total: number;
}

export interface ImportContext {
	accounts: readonly Account[];
	categories: readonly Category[];
	transactions: readonly Transaction[];
}

const cell = (row: readonly string[], idx: number) => (idx >= 0 && idx < row.length ? unsanitizeCell(row[idx].trim()) : '');

/** A fájl sorainak értelmezése; a tényleges mentéshez a `ledger.importCsv` használja az eredményt. */
export function planImport(rows: readonly string[][], opts: ImportOptions, ctx: ImportContext): ImportPlan {
	const body = opts.hasHeader ? rows.slice(1) : rows;
	const offset = opts.hasHeader ? 2 : 1;
	const m = opts.mapping;
	const plan: ImportPlan = { rows: [], errors: [], newCategories: [], newAccounts: [], duplicates: 0, total: body.length };

	const accByName = new Map(ctx.accounts.map((a) => [fold(a.name), a.id]));
	const catByName = (type: CategoryType) =>
		new Map(ctx.categories.filter((c) => c.type === type).map((c) => [fold(c.name), c.id]));
	const cats = { income: catByName('income'), expense: catByName('expense') };
	const newCats = new Set<string>();
	const newAccs = new Set<string>();

	// Meglévő tételek a duplikátum-kereséshez (többszörös halmaz: egy meglévő tétel csak egy sort „fedez").
	const existing = new Map<string, number>();
	const key = (date: string, type: string, amount: number, desc: string, acc: string | number) =>
		`${date}|${type}|${amount}|${fold(desc)}|${acc}`;
	if (opts.skipDuplicates) {
		for (const t of ctx.transactions) {
			const k = key(t.date, t.type, t.amount, t.description, t.accountId);
			existing.set(k, (existing.get(k) ?? 0) + 1);
		}
	}

	body.forEach((row, i) => {
		const line = i + offset;
		const err = (message: string) => plan.errors.push({ line, message });

		const date = parseDateCell(cell(row, m.date));
		if (!date) return err(`Érvénytelen dátum: „${cell(row, m.date)}"`);

		// összeg: előjeles oszlop, vagy külön terhelés/jóváírás oszlop
		let signed: number | null = null;
		if (m.amount >= 0) {
			signed = parseMoneyCell(cell(row, m.amount));
			if (signed === null) return err(`Érvénytelen összeg: „${cell(row, m.amount)}"`);
		} else {
			const debit = m.debit >= 0 ? parseMoneyCell(cell(row, m.debit)) : null;
			const credit = m.credit >= 0 ? parseMoneyCell(cell(row, m.credit)) : null;
			if (debit === null && credit === null) return err('Nincs összeg a sorban');
			signed = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
		}
		if (signed === 0) return err('Az összeg nulla');

		const typeWord = m.type >= 0 ? fold(cell(row, m.type)) : '';
		const type: TxType = TYPE_WORDS[typeWord] ?? (signed < 0 ? 'expense' : 'income');
		const amount = Math.abs(signed);
		if (amount > MAX_AMOUNT) return err('Túl nagy összeg');

		const description = cell(row, m.description).slice(0, MAX_DESCRIPTION);
		const note = cell(row, m.note).slice(0, MAX_NOTE);
		const tagSet = new Set<string>();
		for (const raw of cell(row, m.tags).split(/[\s,;#]+/)) {
			const t = raw.trim().toLocaleLowerCase('hu');
			if (t && t.length <= MAX_TAG) tagSet.add(t);
		}
		if (opts.importTag) tagSet.add(opts.importTag.toLocaleLowerCase('hu'));
		const tags = [...tagSet].slice(0, MAX_TAGS);

		// számla
		const accName = cell(row, m.account);
		let account: ImportedRow['account'] = null;
		if (accName) {
			const id = accByName.get(fold(accName));
			if (id !== undefined) account = { id };
			else if (opts.createMissing) {
				account = { newName: accName };
				newAccs.add(accName);
			}
		}
		if (!account && opts.defaultAccountId != null) account = { id: opts.defaultAccountId };
		if (!account) return err(accName ? `Ismeretlen számla: „${accName}"` : 'Nincs számla megadva');

		let toAccount: ImportedRow['toAccount'] = null;
		if (type === 'transfer') {
			const toName = cell(row, m.toAccount);
			const id = toName ? accByName.get(fold(toName)) : undefined;
			if (id !== undefined) toAccount = { id };
			else if (toName && opts.createMissing) {
				toAccount = { newName: toName };
				newAccs.add(toName);
			}
			if (!toAccount) return err('Átvezetésnél a célszámla kötelező');
			if ('id' in account && 'id' in toAccount && account.id === toAccount.id) return err('A forrás- és a célszámla ugyanaz');
			if ('newName' in account && 'newName' in toAccount && fold(account.newName) === fold(toAccount.newName)) {
				return err('A forrás- és a célszámla ugyanaz');
			}
		}

		// kategória
		let category: ImportedRow['category'] = null;
		const catType = categoryTypeFor(type);
		if (catType) {
			const catName = cell(row, m.category);
			const id = catName ? cats[catType].get(fold(catName)) : undefined;
			if (id !== undefined) category = { id };
			else if (catName && opts.createMissing) {
				category = { newName: catName, type: catType };
				newCats.add(`${catType}|${catName}`);
			} else {
				// „Egyéb" vagy az első kategória
				const fallback = cats[catType].get('egyeb') ?? [...cats[catType].values()][0];
				if (fallback === undefined) return err('Nincs használható kategória');
				category = { id: fallback };
			}
		}

		let duplicate = false;
		if (opts.skipDuplicates && 'id' in account) {
			const k = key(date, type, amount, description, account.id);
			const left = existing.get(k) ?? 0;
			if (left > 0) {
				existing.set(k, left - 1);
				duplicate = true;
				plan.duplicates++;
			}
		}

		plan.rows.push({
			line,
			input: { type, amount, date, description, note, tags },
			category,
			account,
			toAccount,
			duplicate
		});
	});

	plan.newCategories = [...newCats].map((k) => {
		const [type, ...name] = k.split('|');
		return { type: type as CategoryType, name: name.join('|') };
	});
	plan.newAccounts = [...newAccs];
	return plan;
}
