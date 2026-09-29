/**
 * Ismétlődő tételek: az előfordulások kiszámítása és az „esedékes tételek" listája.
 *
 * Szerver nincs, ezért a tételek nem maguktól jönnek létre: az app megnyitásakor a lejárt
 * előfordulások „esedékes" listába kerülnek, és egy érintéssel jóváhagyhatók (vagy kihagyhatók).
 * Az előfordulás mindig a kezdőnaphoz igazodik (n-edik = kezdet + n × intervallum), így a hónap
 * végi napok nem csúsznak el (jan. 31. → feb. 28. → márc. 31.).
 */
import { addDays, addMonths, daysBetween } from './dates';
import type { Frequency, Recurring } from './types';

type Schedule = Pick<Recurring, 'frequency' | 'interval' | 'startDate'>;

export const FREQUENCY_LABEL: Record<Frequency, string> = {
	weekly: 'hetente',
	monthly: 'havonta',
	yearly: 'évente'
};

/** Az n. előfordulás napja (n = 0: a kezdőnap). */
export function occurrenceDate(rule: Schedule, n: number): string {
	switch (rule.frequency) {
		case 'weekly':
			return addDays(rule.startDate, n * 7 * rule.interval);
		case 'monthly':
			return addMonths(rule.startDate, n * rule.interval);
		case 'yearly':
			return addMonths(rule.startDate, n * 12 * rule.interval);
	}
}

/** Az első olyan előfordulás sorszáma, ami az `after` napnál későbbi (null: a legelső). */
function firstIndexAfter(rule: Schedule, after: string | null): number {
	if (after === null || after < rule.startDate) return 0;
	let n: number;
	if (rule.frequency === 'weekly') {
		n = Math.floor(daysBetween(rule.startDate, after) / (7 * rule.interval));
	} else {
		const step = rule.frequency === 'monthly' ? rule.interval : 12 * rule.interval;
		const months =
			(Number(after.slice(0, 4)) - Number(rule.startDate.slice(0, 4))) * 12 +
			(Number(after.slice(5, 7)) - Number(rule.startDate.slice(5, 7)));
		n = Math.max(0, Math.floor(months / step));
	}
	// A becslés legfeljebb egy-két lépést téved (hónapvégi igazítás miatt): pontosítunk.
	while (occurrenceDate(rule, n) <= after) n++;
	while (n > 0 && occurrenceDate(rule, n - 1) > after) n--;
	return n;
}

/** A következő (még nem feldolgozott) előfordulás napja, vagy null, ha a szabály lejárt. */
export function nextOccurrence(rule: Recurring): string | null {
	const date = occurrenceDate(rule, firstIndexAfter(rule, rule.lastHandled));
	if (rule.endDate && date > rule.endDate) return null;
	return date;
}

/** A még feldolgozatlan előfordulások a megadott napig (a lejárat és a `cap` határolja). */
export function pendingOccurrences(rule: Recurring, upTo: string, cap = 60): string[] {
	if (!rule.active) return [];
	const out: string[] = [];
	let n = firstIndexAfter(rule, rule.lastHandled);
	while (out.length < cap) {
		const date = occurrenceDate(rule, n++);
		if (date > upTo || (rule.endDate && date > rule.endDate)) break;
		out.push(date);
	}
	return out;
}

export interface DueItem {
	rule: Recurring;
	date: string;
	/** Hány napja esedékes (0 = ma). */
	overdueDays: number;
}

/** Az esedékes tételek (ma vagy korábban), időrendben. */
export function dueItems(rules: readonly Recurring[], today: string, capPerRule = 36): DueItem[] {
	const out: DueItem[] = [];
	for (const rule of rules) {
		for (const date of pendingOccurrences(rule, today, capPerRule)) {
			out.push({ rule, date, overdueDays: daysBetween(date, today) });
		}
	}
	return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rule.id - b.rule.id));
}

/** A ma utáni előfordulások a megadott napig (előrejelzés, „következő 30 nap"). */
export function upcomingItems(rules: readonly Recurring[], today: string, upTo: string): DueItem[] {
	const out: DueItem[] = [];
	for (const rule of rules) {
		for (const date of pendingOccurrences(rule, upTo, 60)) {
			if (date > today) out.push({ rule, date, overdueDays: daysBetween(date, today) });
		}
	}
	return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rule.id - b.rule.id));
}

/** Olvasható összefoglaló: „havonta, a hónap 5. napján" / „2 hetente" / „évente". */
export function describeSchedule(rule: Schedule): string {
	const every = (unit: string, plural: string) => (rule.interval === 1 ? plural : `${rule.interval} ${unit}`);
	if (rule.frequency === 'weekly') return rule.interval === 1 ? 'hetente' : `${rule.interval} hetente`;
	if (rule.frequency === 'monthly') {
		const d = Number(rule.startDate.slice(8));
		return `${every('havonta', 'havonta')}, ${d}. napján`;
	}
	const [, m, d] = rule.startDate.split('-').map(Number);
	return `${every('évente', 'évente')}, ${m}. hó ${d}.`;
}
