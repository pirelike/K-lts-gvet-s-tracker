/**
 * Tiszta lekérdező függvények a memóriában lévő adatokon (tranzakciók, kategóriák, számlák).
 * Egy személyes költségvetés (évi pár ezer tétel) mellett ez gyorsabb és egyszerűbb, mint külön DB-lekérdezés.
 */
import { fold } from './text';
import { monthRange } from './dates';
import type { Account, Category, Transaction, TxType } from './types';

export interface TxFilters {
	q?: string;
	type?: TxType | '';
	categoryId?: number | null;
	accountId?: number | null;
	tag?: string;
	from?: string;
	to?: string;
	min?: number | null;
	max?: number | null;
}

// A keresési szöveg (ékezet- és kisbetű-független) tranzakciónként gyorsítótárazva.
const hayCache = new Map<number, { stamp: number; hay: string }>();
function haystack(t: Transaction): string {
	const hit = hayCache.get(t.id);
	if (hit && hit.stamp === t.updatedAt) return hit.hay;
	const hay = fold(`${t.description} ${t.note}`);
	hayCache.set(t.id, { stamp: t.updatedAt, hay });
	return hay;
}

/** Legújabb elöl: dátum szerint csökkenő, azon belül létrehozás szerint csökkenő. */
export function compareTx(a: Transaction, b: Transaction): number {
	if (a.date !== b.date) return a.date < b.date ? 1 : -1;
	return b.id - a.id;
}

export function filterTransactions(txs: readonly Transaction[], f: TxFilters): Transaction[] {
	const terms = f.q ? fold(f.q).split(' ').filter(Boolean) : [];
	const out = txs.filter((t) => {
		if (f.type && t.type !== f.type) return false;
		if (f.categoryId != null && t.categoryId !== f.categoryId) return false;
		if (f.accountId != null && t.accountId !== f.accountId && t.toAccountId !== f.accountId) {
			return false;
		}
		if (f.tag && !t.tags.includes(f.tag)) return false;
		if (f.from && t.date < f.from) return false;
		if (f.to && t.date > f.to) return false;
		if (f.min != null && t.amount < f.min) return false;
		if (f.max != null && t.amount > f.max) return false;
		if (terms.length) {
			const hay = haystack(t);
			for (const term of terms) if (!hay.includes(term)) return false;
		}
		return true;
	});
	return out.sort(compareTx);
}

export interface Totals {
	count: number;
	income: number;
	expense: number;
	transferCount: number;
	/** bevétel − kiadás (az átvezetés nem számít bele) */
	net: number;
}

export function summarize(txs: readonly Transaction[]): Totals {
	let income = 0;
	let expense = 0;
	let transferCount = 0;
	for (const t of txs) {
		if (t.type === 'income') income += t.amount;
		else if (t.type === 'expense') expense += t.amount;
		else transferCount++;
	}
	return { count: txs.length, income, expense, transferCount, net: income - expense };
}

export interface DayGroup {
	date: string;
	items: Transaction[];
	net: number;
	hasIncomeOrExpense: boolean;
}

/** Napi csoportok napi részösszeggel; a bemenetnek már rendezettnek kell lennie. */
export function groupByDay(sorted: readonly Transaction[]): DayGroup[] {
	const groups: DayGroup[] = [];
	for (const t of sorted) {
		let g = groups[groups.length - 1];
		if (!g || g.date !== t.date) {
			g = { date: t.date, items: [], net: 0, hasIncomeOrExpense: false };
			groups.push(g);
		}
		g.items.push(t);
		if (t.type === 'income') {
			g.net += t.amount;
			g.hasIncomeOrExpense = true;
		} else if (t.type === 'expense') {
			g.net -= t.amount;
			g.hasIncomeOrExpense = true;
		}
	}
	return groups;
}

export interface CategoryShare {
	categoryId: number;
	name: string;
	color: string;
	icon: string;
	amount: number;
	count: number;
	/** 0–1 */
	share: number;
}

export interface MonthSummary {
	month: string;
	income: number;
	expense: number;
	balance: number;
	expenseByCategory: CategoryShare[];
	incomeByCategory: CategoryShare[];
	count: number;
}

function breakdown(
	txs: readonly Transaction[],
	type: 'income' | 'expense',
	cats: Map<number, Category>,
	total: number
): CategoryShare[] {
	const sums = new Map<number, { amount: number; count: number }>();
	for (const t of txs) {
		if (t.type !== type || t.categoryId == null) continue;
		const s = sums.get(t.categoryId) ?? { amount: 0, count: 0 };
		s.amount += t.amount;
		s.count++;
		sums.set(t.categoryId, s);
	}
	return [...sums.entries()]
		.map(([categoryId, s]) => {
			const c = cats.get(categoryId);
			return {
				categoryId,
				name: c?.name ?? 'Ismeretlen',
				color: c?.color ?? '#94a3b8',
				icon: c?.icon ?? '',
				amount: s.amount,
				count: s.count,
				share: total > 0 ? s.amount / total : 0
			};
		})
		.sort((a, b) => b.amount - a.amount);
}

/** Havi összesítő. Az átvezetés sem a bevételbe, sem a kiadásba nem számít bele. */
export function monthSummary(
	txs: readonly Transaction[],
	categories: readonly Category[],
	month: string
): MonthSummary {
	const { from, to } = monthRange(month);
	const inMonth = txs.filter((t) => t.date >= from && t.date <= to);
	const totals = summarize(inMonth);
	const cats = new Map(categories.map((c) => [c.id, c]));
	return {
		month,
		income: totals.income,
		expense: totals.expense,
		balance: totals.net,
		expenseByCategory: breakdown(inMonth, 'expense', cats, totals.expense),
		incomeByCategory: breakdown(inMonth, 'income', cats, totals.income),
		count: inMonth.length
	};
}

/** Számlánkénti aktuális egyenleg: kezdőegyenleg + bevételek − kiadások ± átvezetések. */
export function accountBalances(
	accounts: readonly Account[],
	txs: readonly Transaction[]
): Map<number, number> {
	const bal = new Map(accounts.map((a) => [a.id, a.initialBalance]));
	const add = (id: number | null, delta: number) => {
		if (id != null && bal.has(id)) bal.set(id, bal.get(id)! + delta);
	};
	for (const t of txs) {
		if (t.type === 'income') add(t.accountId, t.amount);
		else if (t.type === 'expense') add(t.accountId, -t.amount);
		else {
			add(t.accountId, -t.amount);
			add(t.toAccountId, t.amount);
		}
	}
	return bal;
}

export function categoryUsage(txs: readonly Transaction[]): Map<number, number> {
	const m = new Map<number, number>();
	for (const t of txs) if (t.categoryId != null) m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + 1);
	return m;
}

export function accountUsage(txs: readonly Transaction[]): Map<number, number> {
	const m = new Map<number, number>();
	for (const t of txs) {
		m.set(t.accountId, (m.get(t.accountId) ?? 0) + 1);
		if (t.toAccountId != null) m.set(t.toAccountId, (m.get(t.toAccountId) ?? 0) + 1);
	}
	return m;
}

export interface KnownDescription {
	description: string;
	folded: string;
	type: 'income' | 'expense';
	categoryId: number;
	accountId: number;
	amount: number;
	count: number;
}

/**
 * Korábbi leírások az autocomplete-hez: leírásonként (típusonként) a legutóbbi kategória,
 * számla és összeg, valamint a használat gyakorisága.
 */
export function knownDescriptions(txs: readonly Transaction[]): KnownDescription[] {
	const map = new Map<string, KnownDescription & { lastDate: string; lastId: number }>();
	for (const t of txs) {
		if (t.type === 'transfer' || t.categoryId == null || !t.description) continue;
		const folded = fold(t.description);
		const key = `${t.type}|${folded}`;
		const cur = map.get(key);
		if (!cur) {
			map.set(key, {
				description: t.description,
				folded,
				type: t.type,
				categoryId: t.categoryId,
				accountId: t.accountId,
				amount: t.amount,
				count: 1,
				lastDate: t.date,
				lastId: t.id
			});
		} else {
			cur.count++;
			if (t.date > cur.lastDate || (t.date === cur.lastDate && t.id > cur.lastId)) {
				cur.description = t.description;
				cur.categoryId = t.categoryId;
				cur.accountId = t.accountId;
				cur.amount = t.amount;
				cur.lastDate = t.date;
				cur.lastId = t.id;
			}
		}
	}
	return [...map.values()].map(({ lastDate: _d, lastId: _i, ...rest }) => rest);
}

/** Találatok az autocomplete-hez: előbb a szóelejére illők, aztán gyakoriság szerint. */
export function suggestDescriptions(
	known: readonly KnownDescription[],
	type: 'income' | 'expense',
	input: string,
	limit = 6
): KnownDescription[] {
	const q = fold(input);
	if (!q) return [];
	return known
		.filter((k) => k.type === type && k.folded.includes(q) && k.folded !== q)
		.sort((a, b) => {
			const pa = a.folded.startsWith(q) ? 0 : 1;
			const pb = b.folded.startsWith(q) ? 0 : 1;
			return pa - pb || b.count - a.count || a.folded.localeCompare(b.folded);
		})
		.slice(0, limit);
}

export interface LastUsed {
	expense: { categoryId: number | null; accountId: number | null };
	income: { categoryId: number | null; accountId: number | null };
	transfer: { accountId: number | null; toAccountId: number | null };
}

/** Az utoljára használt kategória/számla típusonként – ezek lesznek az előre kiválasztott értékek. */
export function lastUsed(txs: readonly Transaction[]): LastUsed {
	const res: LastUsed = {
		expense: { categoryId: null, accountId: null },
		income: { categoryId: null, accountId: null },
		transfer: { accountId: null, toAccountId: null }
	};
	const latest: Partial<Record<TxType, Transaction>> = {};
	for (const t of txs) {
		const cur = latest[t.type];
		if (!cur || t.createdAt > cur.createdAt || (t.createdAt === cur.createdAt && t.id > cur.id)) {
			latest[t.type] = t;
		}
	}
	if (latest.expense) {
		res.expense = { categoryId: latest.expense.categoryId, accountId: latest.expense.accountId };
	}
	if (latest.income) {
		res.income = { categoryId: latest.income.categoryId, accountId: latest.income.accountId };
	}
	if (latest.transfer) {
		res.transfer = { accountId: latest.transfer.accountId, toAccountId: latest.transfer.toAccountId };
	}
	return res;
}

export function usedTags(txs: readonly Transaction[]): { tag: string; count: number }[] {
	const m = new Map<string, number>();
	for (const t of txs) for (const tag of t.tags) m.set(tag, (m.get(tag) ?? 0) + 1);
	return [...m.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'hu'));
}
