/**
 * Pénzösszegek kezelése: HUF, egész számok.
 *
 * Az összegmező kifejezést is elfogad: `1200+850`, `12k` (= 12 000), `3e` (= 3 000),
 * `1,5k`, `12 000`, `2*450`, `(1200+300)/3`. A szerver és a kliens ugyanezt a modult használja.
 */
import { MAX_AMOUNT } from './types';

const NBSP = ' ';

export type EvalResult = { ok: true; value: number; plain: boolean } | { ok: false; error: string };

/** 12345 -> "12 345" (nem törhető szóközzel), negatívnál valódi mínusz jellel. */
export function formatNumber(n: number): string {
	const abs = Math.abs(Math.trunc(n));
	const grouped = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
	return (n < 0 ? '−' : '') + grouped;
}

export function formatHuf(n: number): string {
	return `${formatNumber(n)}${NBSP}Ft`;
}

/** Előjeles megjelenítés: bevétel +, kiadás −, átvezetés előjel nélkül. */
export function formatSignedHuf(type: 'income' | 'expense' | 'transfer', amount: number): string {
	if (type === 'income') return `+${formatHuf(amount)}`;
	if (type === 'expense') return `−${formatHuf(amount)}`;
	return formatHuf(amount);
}

/** Nettó összeg (bevétel − kiadás) előjellel, pl. a napi részösszeghez. */
export function formatNet(n: number): string {
	if (n > 0) return `+${formatHuf(n)}`;
	return formatHuf(n);
}

type Token =
	| { t: 'num'; v: number; suffixed: boolean }
	| { t: 'op'; v: '+' | '-' | '*' | '/' }
	| { t: 'lp' }
	| { t: 'rp' };

// Ezres tagolású szám (1 200, 1.200, 1 200 000) vagy sima / tizedes szám. Sticky regex.
const NUMBER_RE = /[1-9]\d{0,2}(?:[  .]\d{3})+(?!\d)|\d+(?:[.,]\d+)?/y;

function tokenize(input: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === ' ' || ch === ' ' || ch === '\t') {
			i++;
			continue;
		}
		if (ch === '+') tokens.push({ t: 'op', v: '+' });
		else if (ch === '-' || ch === '−' || ch === '–') tokens.push({ t: 'op', v: '-' });
		else if (ch === '*' || ch === '×' || ch === 'x' || ch === 'X') tokens.push({ t: 'op', v: '*' });
		else if (ch === '/' || ch === '÷' || ch === ':') tokens.push({ t: 'op', v: '/' });
		else if (ch === '(') tokens.push({ t: 'lp' });
		else if (ch === ')') tokens.push({ t: 'rp' });
		else if (ch >= '0' && ch <= '9') {
			NUMBER_RE.lastIndex = i;
			const m = NUMBER_RE.exec(input);
			if (!m) return null;
			const raw = m[0];
			let value: number;
			if (/^[1-9]\d{0,2}(?:[  .]\d{3})+$/.test(raw)) {
				value = Number(raw.replace(/[  .]/g, ''));
			} else {
				value = Number(raw.replace(',', '.'));
			}
			i += raw.length;
			let suffixed = false;
			const next = input[i];
			if (next === 'k' || next === 'K' || next === 'e' || next === 'E') {
				value *= 1000;
				suffixed = true;
				i++;
			}
			tokens.push({ t: 'num', v: value, suffixed });
			continue;
		} else {
			return null;
		}
		i++;
	}
	return tokens;
}

class ParseError extends Error {}

/**
 * Kifejezés kiértékelése egész számra kerekítve. Nem ellenőrzi az előjelet
 * (kezdőegyenlegnél lehet 0 vagy negatív is).
 */
export function evaluateExpression(input: string): EvalResult {
	const text = input.trim();
	if (!text) return { ok: false, error: 'Add meg az összeget' };
	const tokens = tokenize(text);
	if (!tokens || tokens.length === 0) return { ok: false, error: 'Érvénytelen összeg' };

	let pos = 0;
	const peek = () => tokens[pos];

	function parseExpr(): number {
		let left = parseTerm();
		for (;;) {
			const tok = peek();
			if (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
				pos++;
				const right = parseTerm();
				left = tok.v === '+' ? left + right : left - right;
			} else return left;
		}
	}

	function parseTerm(): number {
		let left = parseFactor();
		for (;;) {
			const tok = peek();
			if (tok && tok.t === 'op' && (tok.v === '*' || tok.v === '/')) {
				pos++;
				const right = parseFactor();
				if (tok.v === '*') left = left * right;
				else {
					if (right === 0) throw new ParseError('Nullával nem lehet osztani');
					left = left / right;
				}
			} else return left;
		}
	}

	function parseFactor(): number {
		const tok = peek();
		if (tok && tok.t === 'op' && (tok.v === '-' || tok.v === '+')) {
			pos++;
			const v = parseFactor();
			return tok.v === '-' ? -v : v;
		}
		return parsePrimary();
	}

	function parsePrimary(): number {
		const tok = peek();
		if (!tok) throw new ParseError('Érvénytelen összeg');
		if (tok.t === 'num') {
			pos++;
			return tok.v;
		}
		if (tok.t === 'lp') {
			pos++;
			const v = parseExpr();
			if (peek()?.t !== 'rp') throw new ParseError('Hiányzó zárójel');
			pos++;
			return v;
		}
		throw new ParseError('Érvénytelen összeg');
	}

	try {
		const value = parseExpr();
		if (pos !== tokens.length) return { ok: false, error: 'Érvénytelen összeg' };
		if (!Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) {
			return { ok: false, error: 'Túl nagy összeg' };
		}
		const plain = tokens.length === 1 && tokens[0].t === 'num' && !tokens[0].suffixed;
		return { ok: true, value: Math.round(value), plain };
	} catch (e) {
		if (e instanceof ParseError) return { ok: false, error: e.message };
		throw e;
	}
}

/** Tranzakcióösszeg: pozitív egész szám kell. */
export function parseAmount(input: string): EvalResult {
	const r = evaluateExpression(input);
	if (!r.ok) return r;
	if (r.value <= 0) return { ok: false, error: 'Az összegnek pozitívnak kell lennie' };
	return r;
}
