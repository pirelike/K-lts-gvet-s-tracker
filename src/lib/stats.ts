/** Elemzések és statisztikák a memóriában lévő tételekből – tiszta függvények. */
import { daysBetween, daysInMonth, monthRange, monthStartOffset, shiftMonth, weekdayMon0 } from './dates';
import { fold } from './text';
import { txParts, type Category, type Recurring, type Transaction } from './types';
import { spentByCategory } from './budget';
import { pendingOccurrences } from './recurring';

export interface TrendPoint {
	month: string;
	income: number;
	/** Nettó kiadás (jóváírással csökkentve, legalább 0). */
	expense: number;
	net: number;
	count: number;
}

/** A `count` hónap havi bevétele/kiadása az `endMonth`-ig (régebbi elöl). */
export function monthlyTrend(txs: readonly Transaction[], endMonth: string, count: number): TrendPoint[] {
	const months = Array.from({ length: count }, (_, i) => shiftMonth(endMonth, i - count + 1));
	const idx = new Map(months.map((m, i) => [m, i]));
	const pts: TrendPoint[] = months.map((month) => ({ month, income: 0, expense: 0, net: 0, count: 0 }));
	for (const t of txs) {
		const i = idx.get(t.date.slice(0, 7));
		if (i === undefined || t.type === 'transfer') continue;
		const p = pts[i];
		p.count++;
		if (t.type === 'income') p.income += t.amount;
		else if (t.type === 'expense') p.expense += t.amount;
		else if (t.type === 'refund') p.expense -= t.amount;
	}
	for (const p of pts) {
		p.expense = Math.max(0, p.expense);
		p.net = p.income - p.expense;
	}
	return pts;
}

export interface CategoryCompareRow {
	categoryId: number;
	name: string;
	icon: string;
	color: string;
	current: number;
	previous: number;
	delta: number;
	/** Változás az előző hónaphoz képest (null, ha az előző 0 volt). */
	deltaPct: number | null;
}

/** Kiadási kategóriák összevetése az előző hónappal; a legnagyobb tételek elöl. */
export function categoryCompare(
	txs: readonly Transaction[],
	categories: readonly Category[],
	month: string
): CategoryCompareRow[] {
	const cur = spentByCategory(txs, month);
	const prev = spentByCategory(txs, shiftMonth(month, -1));
	const ids = new Set([...cur.keys(), ...prev.keys()]);
	const byId = new Map(categories.map((c) => [c.id, c]));
	const rows: CategoryCompareRow[] = [];
	for (const id of ids) {
		const current = Math.max(0, cur.get(id) ?? 0);
		const previous = Math.max(0, prev.get(id) ?? 0);
		if (current === 0 && previous === 0) continue;
		const c = byId.get(id);
		rows.push({
			categoryId: id,
			name: c?.name ?? 'Ismeretlen',
			icon: c?.icon ?? '',
			color: c?.color ?? '#94a3b8',
			current,
			previous,
			delta: current - previous,
			deltaPct: previous > 0 ? (current - previous) / previous : null
		});
	}
	return rows.sort((a, b) => Math.max(b.current, b.previous) - Math.max(a.current, a.previous));
}

export interface MerchantRow {
	description: string;
	amount: number;
	count: number;
}

export interface WeekdayRow {
	/** 0 = hétfő … 6 = vasárnap */
	weekday: number;
	total: number;
	/** Átlag egy ilyen napra (az időszakban előforduló ilyen napok száma szerint). */
	average: number;
}

export interface SpendingAnalysis {
	from: string;
	to: string;
	total: number;
	/** Kategóriák nettó költés szerint (csökkenő). */
	categories: { categoryId: number; name: string; icon: string; color: string; amount: number; share: number }[];
	/** Leírások (pl. „Lidl") összesítve, költés szerint csökkenően. */
	merchants: MerchantRow[];
	/** Legnagyobb egyedi kiadások. */
	largest: Transaction[];
	byWeekday: WeekdayRow[];
	byTag: { tag: string; amount: number; count: number }[];
	/** Átlagos napi költés az időszakban (a mai napig számolva). */
	dailyAverage: number;
}

/** „Mire költöttem a legtöbbet?": kategóriák, helyek/leírások, legnagyobb tételek, hétköznapok, címkék. */
export function analyzeSpending(
	txs: readonly Transaction[],
	categories: readonly Category[],
	from: string,
	to: string,
	today: string
): SpendingAnalysis {
	const byId = new Map(categories.map((c) => [c.id, c]));
	const catSum = new Map<number, number>();
	const merch = new Map<string, MerchantRow & { key: string }>();
	const tags = new Map<string, { amount: number; count: number }>();
	const weekday = Array.from({ length: 7 }, () => 0);
	const expenses: Transaction[] = [];
	let total = 0;

	for (const t of txs) {
		if (t.date < from || t.date > to) continue;
		if (t.type !== 'expense' && t.type !== 'refund') continue;
		const sign = t.type === 'expense' ? 1 : -1;
		total += sign * t.amount;
		weekday[weekdayMon0(t.date)] += sign * t.amount;
		for (const p of txParts(t)) catSum.set(p.categoryId, (catSum.get(p.categoryId) ?? 0) + sign * p.amount);
		if (t.type === 'expense') {
			expenses.push(t);
			const d = t.description.trim();
			if (d) {
				const key = fold(d);
				const m = merch.get(key) ?? { key, description: d, amount: 0, count: 0 };
				m.amount += t.amount;
				m.count++;
				merch.set(key, m);
			}
			for (const tag of t.tags) {
				const g = tags.get(tag) ?? { amount: 0, count: 0 };
				g.amount += t.amount;
				g.count++;
				tags.set(tag, g);
			}
		}
	}

	const positiveTotal = [...catSum.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
	const categoriesOut = [...catSum.entries()]
		.filter(([, v]) => v > 0)
		.map(([categoryId, amount]) => {
			const c = byId.get(categoryId);
			return {
				categoryId,
				name: c?.name ?? 'Ismeretlen',
				icon: c?.icon ?? '',
				color: c?.color ?? '#94a3b8',
				amount,
				share: positiveTotal > 0 ? amount / positiveTotal : 0
			};
		})
		.sort((a, b) => b.amount - a.amount);

	// Hány hétfő, kedd … esik az időszakra (a mai napig), az átlaghoz.
	const end = to < today ? to : today;
	const dayCounts = Array.from({ length: 7 }, () => 0);
	const spanDays = Math.max(0, daysBetween(from, end)) + 1;
	if (end >= from && spanDays <= 4000) {
		const startWd = weekdayMon0(from);
		for (let i = 0; i < spanDays; i++) dayCounts[(startWd + i) % 7]++;
	}

	return {
		from,
		to,
		total,
		categories: categoriesOut,
		merchants: [...merch.values()]
			.sort((a, b) => b.amount - a.amount || b.count - a.count)
			.map(({ key: _k, ...rest }) => rest),
		largest: expenses.sort((a, b) => b.amount - a.amount || b.createdAt - a.createdAt || b.id - a.id).slice(0, 5),
		byWeekday: weekday.map((tot, i) => ({
			weekday: i,
			total: Math.max(0, tot),
			average: dayCounts[i] > 0 ? Math.round(Math.max(0, tot) / dayCounts[i]) : 0
		})),
		byTag: [...tags.entries()]
			.map(([tag, g]) => ({ tag, ...g }))
			.sort((a, b) => b.amount - a.amount),
		dailyAverage: spanDays > 0 && end >= from ? Math.round(Math.max(0, total) / spanDays) : 0
	};
}

export type PeriodKey = 'month' | '3m' | '6m' | '12m' | 'year' | 'all';

/** Az elemzés időszakai. `month`: a megadott hónap; a többi a mai napig visszafelé számolt. */
export function periodRange(key: PeriodKey, today: string, month: string, firstDate?: string): { from: string; to: string } {
	switch (key) {
		case 'month':
			return monthRange(month);
		case '3m':
			return { from: `${shiftMonth(today.slice(0, 7), -2)}-01`, to: today };
		case '6m':
			return { from: `${shiftMonth(today.slice(0, 7), -5)}-01`, to: today };
		case '12m':
			return { from: `${shiftMonth(today.slice(0, 7), -11)}-01`, to: today };
		case 'year':
			return { from: `${today.slice(0, 4)}-01-01`, to: today };
		case 'all':
			return { from: firstDate ?? today, to: today };
	}
}

/**
 * Kumulált nettó költés napról napra egy hónapban (a `throughDay`-ig), a grafikonhoz.
 * Az érték az adott nap végéig összegzett kiadás mínusz jóváírás.
 */
export function cumulativeSpend(txs: readonly Transaction[], month: string, throughDay?: number): number[] {
	const dim = daysInMonth(month);
	const last = Math.min(throughDay ?? dim, dim);
	const daily = Array.from({ length: dim }, () => 0);
	const { from, to } = monthRange(month);
	for (const t of txs) {
		if (t.date < from || t.date > to) continue;
		const d = Number(t.date.slice(8)) - 1;
		if (t.type === 'expense') daily[d] += t.amount;
		else if (t.type === 'refund') daily[d] -= t.amount;
	}
	const out: number[] = [];
	let acc = 0;
	for (let i = 0; i < last; i++) {
		acc += daily[i];
		out.push(acc);
	}
	return out;
}

export interface CalendarCell {
	/** YYYY-MM-DD, vagy null a hónap előtti/utáni üres cellánál. */
	date: string | null;
	day: number;
	expense: number;
	income: number;
	count: number;
	/** Esedékes ismétlődő tételek száma ezen a napon. */
	recurring: number;
}

/** Naptárrács (hétfőtől vasárnapig); a hónap előtti/utáni cellák üresek. */
export function calendarWeeks(
	txs: readonly Transaction[],
	month: string,
	recurring: readonly Recurring[] = []
): CalendarCell[][] {
	const dim = daysInMonth(month);
	const cells: CalendarCell[] = Array.from({ length: dim }, (_, i) => ({
		date: `${month}-${String(i + 1).padStart(2, '0')}`,
		day: i + 1,
		expense: 0,
		income: 0,
		count: 0,
		recurring: 0
	}));
	const { from, to } = monthRange(month);
	for (const t of txs) {
		if (t.date < from || t.date > to) continue;
		const c = cells[Number(t.date.slice(8)) - 1];
		c.count++;
		if (t.type === 'expense') c.expense += t.amount;
		else if (t.type === 'refund') c.expense -= t.amount;
		else if (t.type === 'income') c.income += t.amount;
	}
	for (const rule of recurring) {
		for (const date of pendingOccurrences(rule, to)) {
			if (date >= from) cells[Number(date.slice(8)) - 1].recurring++;
		}
	}
	const blank = (): CalendarCell => ({ date: null, day: 0, expense: 0, income: 0, count: 0, recurring: 0 });
	const flat: CalendarCell[] = [...Array.from({ length: monthStartOffset(month) }, blank), ...cells];
	while (flat.length % 7 !== 0) flat.push(blank());
	const weeks: CalendarCell[][] = [];
	for (let i = 0; i < flat.length; i += 7) weeks.push(flat.slice(i, i + 7));
	return weeks;
}
