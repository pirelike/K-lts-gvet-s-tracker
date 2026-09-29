/** Dátumkezelés: minden dátum `YYYY-MM-DD` szöveg, a hónap `YYYY-MM`. Nincs időzóna-csúszás. */

const MONTHS = [
	'január',
	'február',
	'március',
	'április',
	'május',
	'június',
	'július',
	'augusztus',
	'szeptember',
	'október',
	'november',
	'december'
];
const MONTHS_SHORT = [
	'jan.',
	'febr.',
	'márc.',
	'ápr.',
	'máj.',
	'jún.',
	'júl.',
	'aug.',
	'szept.',
	'okt.',
	'nov.',
	'dec.'
];
const WEEKDAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];

const pad = (n: number) => String(n).padStart(2, '0');

export function isValidISODate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const [y, m, d] = s.split('-').map(Number);
	if (y < 1970 || y > 2999) return false;
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidMonth(s: string): boolean {
	return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && Number(s.slice(0, 4)) >= 1970;
}

/** A mai nap a készülék helyi időzónájában (vagy a megadottban – tesztekhez). */
export function todayISO(now: Date = new Date(), timeZone?: string): string {
	if (!timeZone) return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(now);
	const get = (t: string) => parts.find((p) => p.type === t)!.value;
	return `${get('year')}-${get('month')}-${get('day')}`;
}

export function monthOf(iso: string): string {
	return iso.slice(0, 7);
}

export function monthRange(month: string): { from: string; to: string } {
	const [y, m] = month.split('-').map(Number);
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

export function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const idx = y * 12 + (m - 1) + delta;
	return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

export function addDays(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d + delta));
	return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Napok száma a hónapban. */
export function daysInMonth(month: string): number {
	return Number(monthRange(month).to.slice(8));
}

/** „2026. szeptember" */
export function formatMonthLabel(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return `${y}. ${MONTHS[m - 1]}`;
}

/** „szept. 29., kedd" – más évben „2025. dec. 3., szerda". */
export function formatDateLong(iso: string, today?: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
	const yearPart = today && today.slice(0, 4) === iso.slice(0, 4) ? '' : `${y}. `;
	return `${yearPart}${MONTHS_SHORT[m - 1]} ${d}., ${wd}`;
}

/** „szept. 29." – más évben „2025. dec. 3.". */
export function formatDateShort(iso: string, today?: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const yearPart = today && today.slice(0, 4) === iso.slice(0, 4) ? '' : `${y}. `;
	return `${yearPart}${MONTHS_SHORT[m - 1]} ${d}.`;
}

/** „Ma", „Tegnap" vagy a hosszú forma. */
export function formatDayLabel(iso: string, today: string): string {
	if (iso === today) return `Ma · ${formatDateLong(iso, today)}`;
	if (iso === addDays(today, -1)) return `Tegnap · ${formatDateLong(iso, today)}`;
	return formatDateLong(iso, today);
}

/** Hónap hozzáadása: a nap a hónap végére igazodik (jan. 31. + 1 hónap = feb. 28./29.). */
export function addMonths(iso: string, delta: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const idx = y * 12 + (m - 1) + delta;
	const ny = Math.floor(idx / 12);
	const nm = (idx % 12) + 1;
	const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
	return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

/** Két nap közötti különbség napokban (b − a). */
export function daysBetween(a: string, b: string): number {
	const [ya, ma, da] = a.split('-').map(Number);
	const [yb, mb, db] = b.split('-').map(Number);
	return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/** A hét napja hétfővel kezdve: hétfő = 0 … vasárnap = 6. */
export function weekdayMon0(iso: string): number {
	const [y, m, d] = iso.split('-').map(Number);
	return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

const WEEKDAYS_MON0 = ['hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat', 'vasárnap'];
export const WEEKDAY_NAMES: readonly string[] = WEEKDAYS_MON0;
export const WEEKDAY_SHORT: readonly string[] = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];

/** A hónapok neve (0 = január) a naptárhoz és a gyorsbevitelhez. */
export const MONTH_NAMES: readonly string[] = MONTHS;

/** Az adott nap ISO-ja a hónap `n`-edik napján (a hónap végére igazítva). */
export function dayOfMonthISO(month: string, day: number): string {
	return `${month}-${pad(Math.min(Math.max(day, 1), daysInMonth(month)))}`;
}

/** Ennyi ms múlva jön el a következő helyi éjfél (a „ma" frissítéséhez). */
export function msUntilMidnight(now: Date = new Date()): number {
	const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
	return Math.max(1000, next.getTime() - now.getTime());
}

/** A hónap első napjának hétfőtől számított oszlopa (0–6), a naptárrács igazításához. */
export function monthStartOffset(month: string): number {
	return weekdayMon0(`${month}-01`);
}

/** „szept. 29." rövid hónapnevek (0 = január). */
export const MONTH_SHORT_NAMES: readonly string[] = MONTHS_SHORT;

/** „szept." – csak a hónap rövid neve. */
export function formatMonthShort(month: string): string {
	return MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
}
