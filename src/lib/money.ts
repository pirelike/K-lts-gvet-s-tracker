/**
 * Pénzösszegek kezelése: egész számok a pénznem legkisebb egységében (HUF: forint, EUR: cent).
 *
 * Az összegmező kifejezést is elfogad: `1200+850`, `12k` (= 12 000), `3e` (= 3 000),
 * `1,5k`, `12 000`, `2*450`, `(1200+300)/3`. A szerver és a kliens ugyanezt a modult használja.
 */
import { activeCurrency, scaleOf } from './currency';
import { MAX_AMOUNT } from './types';

const NBSP = ' ';

export type EvalResult = { ok: true; value: number; plain: boolean } | { ok: false; error: string };

/**
 * 12345 -> "12 345" (nem törhető szóközzel), negatívnál valódi mínusz jellel.
 * Tizedes pénznemnél (pl. EUR) az összeg a legkisebb egységben van: 1250 -> "12,50".
 */
export function formatNumber(n: number, decimals: number = activeCurrency().decimals): string {
	const abs = Math.abs(Math.trunc(n));
	const scale = 10 ** decimals;
	const whole = Math.floor(abs / scale);
	let grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
	if (decimals > 0) grouped += ',' + String(abs % scale).padStart(decimals, '0');
	return (n < 0 ? '\u2212' : '') + grouped;
}

/** Összeg beviteli mezőbe: 1250 (EUR) -> „12,5", 5000 (HUF) -> „5000" (nincs ezres tagolás, nincs felesleges nulla). */
export function toInputAmount(minor: number): string {
	const dec = activeCurrency().decimals;
	if (dec === 0) return String(minor);
	const abs = Math.abs(minor);
	const scale = 10 ** dec;
	const frac = String(abs % scale).padStart(dec, '0').replace(/0+$/, '');
	return `${minor < 0 ? '-' : ''}${Math.floor(abs / scale)}${frac ? ',' + frac : ''}`;
}

/** Összeg az aktív pénznemben: „12 345 Ft" vagy „12,50 €". */
export function formatMoney(n: number): string {
	return `${formatNumber(n)}${NBSP}${activeCurrency().symbol}`;
}

/** Előjeles megjelenítés: bevétel/jóváírás +, kiadás −, átvezetés előjel nélkül. */
export function formatSignedMoney(type: 'income' | 'expense' | 'transfer' | 'refund', amount: number): string {
	if (type === 'income' || type === 'refund') return `+${formatMoney(amount)}`;
	if (type === 'expense') return `\u2212${formatMoney(amount)}`;
	return formatMoney(amount);
}

/** Nettó összeg (bevétel − kiadás) előjellel, pl. a napi részösszeghez. */
export function formatNet(n: number): string {
	if (n > 0) return `+${formatMoney(n)}`;
	return formatMoney(n);
}

/** Tömör alak grafikonokhoz és naptárhoz: 1 234 -> „1,2e", 1 500 000 -> „1,5M" (főegységben). */
export function formatCompact(minor: number): string {
	const major = Math.abs(minor) / scaleOf();
	const sign = minor < 0 ? '\u2212' : '';
	const one = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', ',');
	if (major >= 1_000_000) return `${sign}${one(major / 1_000_000)}M`;
	if (major >= 1000) return `${sign}${one(major / 1000)}e`;
	return sign + (activeCurrency().decimals === 0 ? String(Math.round(major)) : one(major));
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
 * Kifejezés kiértékelése; az eredmény az aktív pénznem legkisebb egysége, egész számra kerekítve
 * (HUF: forint, EUR: cent). Nem ellenőrzi az előjelet (kezdőegyenlegnél lehet 0 vagy negatív is).
 */
export function evaluateExpression(input: string, decimals: number = activeCurrency().decimals): EvalResult {
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
		const scaled = value * 10 ** decimals;
		if (!Number.isFinite(scaled) || Math.abs(scaled) > MAX_AMOUNT) {
			return { ok: false, error: 'Túl nagy összeg' };
		}
		const plain = tokens.length === 1 && tokens[0].t === 'num' && !tokens[0].suffixed;
		return { ok: true, value: Math.round(scaled), plain };
	} catch (e) {
		if (e instanceof ParseError) return { ok: false, error: e.message };
		throw e;
	}
}

/** Tranzakcióösszeg: pozitív egész szám kell. */
export function parseAmount(input: string, decimals?: number): EvalResult {
	const r = evaluateExpression(input, decimals);
	if (!r.ok) return r;
	if (r.value <= 0) return { ok: false, error: 'Az összegnek pozitívnak kell lennie' };
	return r;
}
