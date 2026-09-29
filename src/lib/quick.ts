/**
 * Természetes nyelvű gyorsbevitel: „kávé 890 tegnap", „+48000 ösztöndíj", „mozi 3 200 péntek kártyával #haverok".
 *
 * A szöveg részeit felismeri (összeg, dátum, típus, számla, címkék), a maradék a leírás; a kategóriát
 * a korábbi tételekből vagy a kategória nevéből találja ki. Nem ír adatot: csak elemez, a mentés
 * a megszokott validáción megy át. Tiszta függvény, a „ma" és az adatok paraméterek.
 */
import { addDays, isValidISODate, weekdayMon0 } from './dates';
import { evaluateExpression } from './money';
import type { KnownDescription } from './queries';
import { fold } from './text';
import type { Account, Category, TxType } from './types';

export interface QuickContext {
	today: string;
	/** Használható (nem archivált) számlák. */
	accounts: readonly Account[];
	/** Használható (nem archivált) kategóriák. */
	categories: readonly Category[];
	known: readonly KnownDescription[];
}

export interface QuickParse {
	type: Exclude<TxType, 'transfer'>;
	amount: number | null;
	/** Az összeg ahogy beírták (kifejezés is lehet, pl. `1200+850`). */
	amountText: string;
	date: string;
	description: string;
	categoryId: number | null;
	/** Honnan a kategória: korábbi tételből, a kategória nevéből, vagy nincs. */
	categorySource: 'known' | 'name' | null;
	accountId: number | null;
	tags: string[];
	/** Ami hiányzik ahhoz, hogy menthető legyen (üres = rendben). */
	problems: string[];
}

const MONTH_FULL = ['januar', 'februar', 'marcius', 'aprilis', 'majus', 'junius', 'julius', 'augusztus', 'szeptember', 'oktober', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = {
	jan: 1, febr: 2, feb: 2, marc: 3, mar: 3, apr: 4, maj: 5, jun: 6, jul: 7, aug: 8, szept: 9, szep: 9, okt: 10, nov: 11, dec: 12
};
const WEEKDAY_STEMS = ['hetfo', 'kedd', 'szerda', 'csutortok', 'pentek', 'szombat', 'vasarnap'];

const INCOME_MARKERS = new Set(['bevetel', 'bevetelem', 'kaptam']);
const EXPENSE_MARKERS = new Set(['kiadas', 'koltottem', 'fizettem']);
const REFUND_WORDS = new Set(['visszaterites', 'visszateritest', 'visszateritese', 'visszateritesem', 'jovairas', 'jovairast', 'visszakaptam', 'visszavittem', 'refund']);
const INCOME_HINTS = new Set(['fizetes', 'fizu', 'osztondij', 'zsebpenz', 'jovedelem', 'utalas', 'ajandekpenz']);
const CURRENCY_WORDS = new Set(['ft', 'huf', 'forint', 'forintot', 'eur', 'euro', 'usd']);

/** Számla-szinonimák: a szó → melyik típusú számlát jelenti. */
const ACCOUNT_WORDS: Record<string, 'cash' | 'checking' | 'credit'> = {
	keszpenz: 'cash', kezpenz: 'cash', kp: 'cash', cash: 'cash',
	kartya: 'checking', bankkartya: 'checking',
	hitelkartya: 'credit'
};
const CASE_SUFFIX = '(?:-?(?:z[ae]l|val|vel|ba|be|bol|ra|re|rol|nal|nel|hoz|hez|t|n))?';

const cap = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('hu') + s.slice(1) : s);

/** Az adott napnál nem későbbi legutóbbi nap, ami a megadott hétköznapra esik (0 = hétfő). */
function lastWeekday(today: string, weekday: number): string {
	const diff = (weekdayMon0(today) - weekday + 7) % 7;
	return addDays(today, -diff);
}

function monthOf(token: string): number | null {
	const t = fold(token).replace(/\.$/, '');
	const full = MONTH_FULL.indexOf(t);
	if (full >= 0) return full + 1;
	return MONTH_ABBR[t] ?? null;
}

function dayNumber(token: string): number | null {
	const m = /^(\d{1,2})(?:\.|-?[ae]n|-?i)?\.?$/.exec(fold(token));
	if (!m) return null;
	const d = Number(m[1]);
	return d >= 1 && d <= 31 ? d : null;
}

/** Hónap + nap dátummá: ha a mai napnál későbbi lenne, az előző évből. */
function monthDay(today: string, month: number, day: number): string | null {
	const year = Number(today.slice(0, 4));
	const mk = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	let iso = mk(year);
	if (!isValidISODate(iso)) return null;
	if (iso > today) iso = mk(year - 1);
	return isValidISODate(iso) ? iso : null;
}

export function parseQuickEntry(input: string, ctx: QuickContext): QuickParse {
	const problems: string[] = [];
	let text = input.trim().replace(/\s+/g, ' ');

	// 1. címkék
	const tags: string[] = [];
	text = text.replace(/(^|\s)#([^\s#,;]+)/g, (_m, sp: string, tag: string) => {
		const t = tag.toLocaleLowerCase('hu');
		if (!tags.includes(t)) tags.push(t);
		return sp ? ' ' : '';
	});

	// 2. tokenek; az ezres csoportok („12 500") egy tokenné olvadnak
	const raw = text.split(' ').filter(Boolean);
	const tokens: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		let cur = raw[i];
		if (/^\d{1,3}$/.test(cur)) {
			while (i + 1 < raw.length && /^\d{3}$/.test(raw[i + 1])) cur += raw[++i];
		}
		tokens.push(cur);
	}
	const alive = () => tokens.filter((t) => t !== '');
	const drop = (...idx: number[]) => {
		for (const i of idx) tokens[i] = '';
	};

	let date: string | null = null;

	// 3. dátum: relatív szavak, ISO, ponttal tagolt, hónapnév + nap, hétköznap, „N napja"
	const take = (iso: string, ...idx: number[]) => {
		date = iso;
		drop(...idx);
	};
	for (let i = 0; i < tokens.length && !date; i++) {
		const tok = tokens[i];
		if (!tok) continue;
		const f = fold(tok);
		if (f === 'ma') take(ctx.today, i);
		else if (f === 'tegnap') take(addDays(ctx.today, -1), i);
		else if (f === 'tegnapelott') take(addDays(ctx.today, -2), i);
		else if (f === 'holnap') take(addDays(ctx.today, 1), i);
		else if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
			if (isValidISODate(f)) take(f, i);
		} else if (/^\d{4}\.\d{1,2}\.\d{1,2}\.?$/.test(f)) {
			const [y, m, d] = f.replace(/\.$/, '').split('.').map(Number);
			const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
			if (isValidISODate(iso)) take(iso, i);
		} else if (/^\d{1,2}\.\d{1,2}\.$/.test(f)) {
			const [m, d] = f.split('.').map(Number);
			const iso = monthDay(ctx.today, m, d);
			if (iso) take(iso, i);
		} else if (monthOf(tok) !== null) {
			const m = monthOf(tok)!;
			const next = i + 1 < tokens.length ? dayNumber(tokens[i + 1]) : null;
			const prev = i > 0 && tokens[i - 1] ? dayNumber(tokens[i - 1]) : null;
			const d = next ?? prev;
			const iso = d !== null ? monthDay(ctx.today, m, d) : null;
			if (iso) take(iso, i, next !== null ? i + 1 : i - 1);
		} else if (WEEKDAY_STEMS.some((st) => f.startsWith(st)) && f.length <= 14) {
			const wd = WEEKDAY_STEMS.findIndex((st) => f.startsWith(st));
			const lastWeek = i > 0 && fold(tokens[i - 1]) === 'mult';
			take(addDays(lastWeekday(ctx.today, wd), lastWeek ? -7 : 0), i, ...(lastWeek ? [i - 1] : []));
		} else if ((f === 'napja' || f === 'napja.') && i > 0 && /^\d{1,3}$/.test(tokens[i - 1])) {
			take(addDays(ctx.today, -Number(tokens[i - 1])), i, i - 1);
		}
	}

	// 4. összeg: az első érvényes szám/kifejezés; több szám esetén az utolsó (a leírásban is lehet szám)
	let amount: number | null = null;
	let amountText = '';
	let amountIdx = -1;
	let signHint: 'income' | 'expense' | null = null;
	const numeric = /^[+-]?(?=.*\d)[\d.,+\-*/()xXkKeE×÷:]+(?:ft|huf|forint)?$/i;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok || !numeric.test(tok)) continue;
		let core = tok.replace(/(ft|huf|forint)$/i, '');
		let sign: 'income' | 'expense' | null = null;
		if (core.startsWith('+')) {
			sign = 'income';
			core = core.slice(1);
		} else if (/^-\d/.test(core)) {
			sign = 'expense';
			core = core.slice(1);
		}
		const r = evaluateExpression(core);
		if (!r.ok || r.value <= 0) continue;
		amount = r.value;
		amountText = core;
		amountIdx = i;
		signHint = sign;
	}
	if (amountIdx >= 0) {
		drop(amountIdx);
		// a pénznem szó („Ft") az összeg mellől
		for (const j of [amountIdx + 1, amountIdx - 1]) {
			if (j >= 0 && j < tokens.length && tokens[j] && CURRENCY_WORDS.has(fold(tokens[j]))) drop(j);
		}
	}

	// 5. típusjelzők és számla
	let explicitType: QuickParse['type'] | null = signHint;
	let accountId: number | null = null;
	const accountByType = (t: 'cash' | 'checking' | 'credit') => {
		const list = ctx.accounts.filter((a) => a.type === t);
		if (t === 'checking') return list.find((a) => /kartya/.test(fold(a.name)))?.id ?? list[0]?.id ?? null;
		return list[0]?.id ?? null;
	};
	const nameRes = ctx.accounts.map((a) => ({ id: a.id, re: new RegExp(`^${fold(a.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${CASE_SUFFIX}$`) }));
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok) continue;
		const f = fold(tok).replace(/[.,;:]$/, '');
		if (INCOME_MARKERS.has(f)) {
			explicitType ??= 'income';
			drop(i);
		} else if (EXPENSE_MARKERS.has(f)) {
			explicitType ??= 'expense';
			drop(i);
		} else if (REFUND_WORDS.has(f)) {
			explicitType = 'refund';
			drop(i);
		} else if (accountId === null) {
			const byName = nameRes.find((n) => n.re.test(f));
			const stem = Object.keys(ACCOUNT_WORDS).find((k) => new RegExp(`^${k}${CASE_SUFFIX}$`).test(f));
			const id = byName ? byName.id : stem ? accountByType(ACCOUNT_WORDS[stem]) : null;
			if (id !== null) {
				accountId = id;
				drop(i);
			}
		}
	}

	// 6. leírás = a maradék
	const rest = alive().map((t) => t.replace(/^[,;:.\-–]+|[,;:]+$/g, '')).filter(Boolean);
	let description = cap(rest.join(' ').trim());
	const descFold = fold(description);

	// 7. típus
	const hasIncomeHint = rest.some((t) => INCOME_HINTS.has(fold(t)));
	const knownIncome = descFold ? ctx.known.find((k) => k.type === 'income' && k.folded === descFold) : undefined;
	const knownExpense = descFold ? ctx.known.find((k) => k.type === 'expense' && k.folded === descFold) : undefined;
	const type: QuickParse['type'] = explicitType ?? (knownIncome && !knownExpense ? 'income' : hasIncomeHint && !knownExpense ? 'income' : 'expense');
	const wantedCat = type === 'income' ? 'income' : 'expense';

	// 8. kategória: korábbi azonos leírás → kategória neve a szövegben → részleges egyezés korábbi leírással
	let categoryId: number | null = null;
	let categorySource: QuickParse['categorySource'] = null;
	const usableCat = (id: number) => ctx.categories.some((c) => c.id === id && c.type === wantedCat);
	const exact = ctx.known.find((k) => k.type === wantedCat && k.folded === descFold && usableCat(k.categoryId));
	if (exact) {
		categoryId = exact.categoryId;
		categorySource = 'known';
		description = exact.description; // a megszokott írásmód
		if (accountId === null) accountId = ctx.accounts.some((a) => a.id === exact.accountId) ? exact.accountId : null;
	} else if (descFold) {
		const byName = ctx.categories.find((c) => c.type === wantedCat && fold(c.name) === descFold);
		if (byName) {
			categoryId = byName.id;
			categorySource = 'name';
		} else {
			const partial = ctx.known
				.filter((k) => k.type === wantedCat && usableCat(k.categoryId) && (k.folded.includes(descFold) || descFold.includes(k.folded)))
				.sort((a, b) => b.count - a.count)[0];
			if (partial) {
				categoryId = partial.categoryId;
				categorySource = 'known';
			}
		}
	}
	// üres leírás, de van kategória → a kategória neve lesz a leírás
	if (!description && categoryId !== null) description = ctx.categories.find((c) => c.id === categoryId)?.name ?? '';

	if (amount === null) problems.push('Nem találok összeget (pl. „kávé 890")');
	if (type === 'expense' && !description) problems.push('Írd le, mire költöttél (pl. „kávé 890")');

	return {
		type,
		amount,
		amountText,
		date: date ?? ctx.today,
		description,
		categoryId,
		categorySource,
		accountId,
		tags,
		problems
	};
}
