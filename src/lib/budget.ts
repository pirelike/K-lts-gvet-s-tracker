/** Havi keretek: költés kategóriánként, figyelmeztetési szintek (80% és 100%). Tiszta függvények. */
import { monthRange } from './dates';
import { txParts, type Category, type Transaction } from './types';

export const WARN_RATIO = 0.8;

export type BudgetLevel = 'ok' | 'warn' | 'over';

/** A keret kihasználtságának szintje: 80% alatt rendben, 80% fölött figyelmeztetés, 100% fölött túllépés. */
export function budgetLevel(spent: number, budget: number): BudgetLevel {
	if (budget <= 0) return 'ok';
	const ratio = spent / budget;
	if (ratio >= 1) return 'over';
	if (ratio >= WARN_RATIO) return 'warn';
	return 'ok';
}

export interface BudgetLine {
	categoryId: number | null;
	name: string;
	icon: string;
	color: string;
	budget: number;
	/** Nettó költés a hónapban (a jóváírásokkal csökkentve, legalább 0). */
	spent: number;
	/** spent / budget (lehet 1 fölött is). */
	ratio: number;
	/** budget − spent (negatív, ha túllépted). */
	remaining: number;
	level: BudgetLevel;
}

/** Nettó költés kategóriánként egy hónapban: kiadások mínusz jóváírások, a felosztott tételek részenként. */
export function spentByCategory(txs: readonly Transaction[], month: string): Map<number, number> {
	const { from, to } = monthRange(month);
	const out = new Map<number, number>();
	for (const t of txs) {
		if (t.date < from || t.date > to) continue;
		const sign = t.type === 'expense' ? 1 : t.type === 'refund' ? -1 : 0;
		if (sign === 0) continue;
		for (const p of txParts(t)) out.set(p.categoryId, (out.get(p.categoryId) ?? 0) + sign * p.amount);
	}
	return out;
}

/** A nettó teljes havi költés (minden kiadási kategória). */
export function totalSpent(txs: readonly Transaction[], month: string): number {
	let sum = 0;
	for (const v of spentByCategory(txs, month).values()) sum += v;
	return sum;
}

function line(
	categoryId: number | null,
	name: string,
	icon: string,
	color: string,
	budget: number,
	rawSpent: number
): BudgetLine {
	const spent = Math.max(0, rawSpent);
	return {
		categoryId,
		name,
		icon,
		color,
		budget,
		spent,
		ratio: budget > 0 ? spent / budget : 0,
		remaining: budget - spent,
		level: budgetLevel(spent, budget)
	};
}

/** A keretes (nem archivált) kiadási kategóriák állása; a legszorosabbak elöl. */
export function budgetLines(
	txs: readonly Transaction[],
	categories: readonly Category[],
	month: string
): BudgetLine[] {
	const spent = spentByCategory(txs, month);
	return categories
		.filter((c) => c.type === 'expense' && !c.archived && c.monthlyBudget != null && c.monthlyBudget > 0)
		.map((c) => line(c.id, c.name, c.icon, c.color, c.monthlyBudget!, spent.get(c.id) ?? 0))
		.sort((a, b) => b.ratio - a.ratio || a.name.localeCompare(b.name, 'hu'));
}

/** Az összes havi keret állása, ha van megadva. */
export function totalBudgetLine(
	txs: readonly Transaction[],
	month: string,
	totalBudget: number | null
): BudgetLine | null {
	if (totalBudget == null || totalBudget <= 0) return null;
	return line(null, 'Összes kiadás', '💰', '#4f46e5', totalBudget, totalSpent(txs, month));
}

/** Figyelmeztetendő sorok (80% fölött), a legrosszabb elöl. */
export function budgetAlerts(lines: readonly BudgetLine[]): BudgetLine[] {
	return lines.filter((l) => l.level !== 'ok').sort((a, b) => b.ratio - a.ratio);
}

/** Egy módosítás után lett-e rosszabb a szint; ha igen, melyik szintet lépte át. */
export function crossedLevel(before: BudgetLevel, after: BudgetLevel): 'warn' | 'over' | null {
	const rank = { ok: 0, warn: 1, over: 2 } as const;
	if (rank[after] > rank[before]) return after === 'over' ? 'over' : 'warn';
	return null;
}

/** A hónap hányadrésze telt el (0–1) – a „ütem szerinti" jelölőhöz a sávon. */
export function monthProgress(today: string, month: string): number {
	const { from, to } = monthRange(month);
	if (today < from) return 0;
	if (today > to) return 1;
	return Number(today.slice(8)) / Number(to.slice(8));
}

export interface BudgetCrossing {
	name: string;
	level: 'warn' | 'over';
	/** Kihasználtság a módosítás után (1 = 100%). */
	ratio: number;
}

/**
 * Egy módosítás után mely keretek léptek át rosszabb szintre (80% / 100%) – a mentés utáni
 * figyelmeztetéshez. A kategóriakeretek és az összes havi keret is számít.
 */
export function budgetCrossings(
	before: readonly Transaction[],
	after: readonly Transaction[],
	categories: readonly Category[],
	month: string,
	totalBudget: number | null
): BudgetCrossing[] {
	const lines = (txs: readonly Transaction[]) => [
		...budgetLines(txs, categories, month),
		...(totalBudgetLine(txs, month, totalBudget) ? [totalBudgetLine(txs, month, totalBudget)!] : [])
	];
	const was = new Map(lines(before).map((l) => [l.categoryId, l.level]));
	const out: BudgetCrossing[] = [];
	for (const l of lines(after)) {
		const crossed = crossedLevel(was.get(l.categoryId) ?? 'ok', l.level);
		if (crossed) out.push({ name: l.name, level: crossed, ratio: l.ratio });
	}
	return out.sort((a, b) => b.ratio - a.ratio);
}
