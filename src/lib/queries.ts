/**
 * Tiszta lekérdező függvények a memóriában lévő adatokon (tranzakciók, kategóriák, számlák).
 * Egy személyes költségvetés (évi pár ezer tétel) mellett ez gyorsabb és egyszerűbb, mint külön DB-lekérdezés.
 */
import { fold } from './text';
import { monthRange } from './dates';
import { balanceSign, txParts, type Account, type Category, type Recurring, type Transaction, type TxType } from './types';

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
		if (f.categoryId != null && !txParts(t).some((p) => p.categoryId === f.categoryId)) return false;
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
	/** Nettó kiadás: a kiadások mínusz a jóváírások (visszatérítések). */
	expense: number;
	/** A jóváírások összege (ezzel csökkent a kiadás). */
	refund: number;
	/** A jóváírás nélküli kiadások összege. */
	grossExpense: number;
	transferCount: number;
	/** bevétel − nettó kiadás (az átvezetés nem számít bele) */
	net: number;
}

export function summarize(txs: readonly Transaction[]): Totals {
	let income = 0;
	let gross = 0;
	let refund = 0;
	let transferCount = 0;
	for (const t of txs) {
		if (t.type === 'income') income += t.amount;
		else if (t.type === 'expense') gross += t.amount;
		else if (t.type === 'refund') refund += t.amount;
		else transferCount++;
	}
	const expense = gross - refund;
	return { count: txs.length, income, expense, refund, grossExpense: gross, transferCount, net: income - expense };
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
		const sign = balanceSign(t.type);
		if (sign !== 0) {
			g.net += sign * t.amount;
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
	/** Nettó kiadás (a jóváírásokkal csökkentve). */
	expense: number;
	refund: number;
	balance: number;
	expenseByCategory: CategoryShare[];
	incomeByCategory: CategoryShare[];
	count: number;
}

/**
 * Kategóriánkénti bontás. Kiadásnál a jóváírások (visszatérítések) levonódnak a kategória költéséből,
 * a felosztott tételek a részeik kategóriájába számítanak. A nulla vagy negatív nettó összegű
 * kategóriák (pl. csak visszatérítés volt) kimaradnak.
 */
function breakdown(
	txs: readonly Transaction[],
	kind: 'income' | 'expense',
	cats: Map<number, Category>,
	total: number
): CategoryShare[] {
	const sums = new Map<number, { amount: number; count: number }>();
	for (const t of txs) {
		let sign = 0;
		if (kind === 'income') sign = t.type === 'income' ? 1 : 0;
		else sign = t.type === 'expense' ? 1 : t.type === 'refund' ? -1 : 0;
		if (sign === 0) continue;
		for (const part of txParts(t)) {
			const s = sums.get(part.categoryId) ?? { amount: 0, count: 0 };
			s.amount += sign * part.amount;
			s.count++;
			sums.set(part.categoryId, s);
		}
	}
	return [...sums.entries()]
		.filter(([, s]) => s.amount > 0)
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
		refund: totals.refund,
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
		if (t.type === 'transfer') {
			add(t.accountId, -t.amount);
			add(t.toAccountId, t.amount);
		} else {
			add(t.accountId, balanceSign(t.type) * t.amount);
		}
	}
	return bal;
}

/** Hányszor használják a kategóriát (a felosztott tételek részei és az ismétlődő szabályok is számítanak). */
export function categoryUsage(
	txs: readonly Transaction[],
	recurring: readonly Recurring[] = []
): Map<number, number> {
	const m = new Map<number, number>();
	const bump = (id: number) => m.set(id, (m.get(id) ?? 0) + 1);
	for (const t of txs) {
		if (t.splits && t.splits.length > 0) for (const p of t.splits) bump(p.categoryId);
		else if (t.categoryId != null) bump(t.categoryId);
	}
	for (const r of recurring) if (r.categoryId != null) bump(r.categoryId);
	return m;
}

export function accountUsage(
	txs: readonly Transaction[],
	recurring: readonly Recurring[] = []
): Map<number, number> {
	const m = new Map<number, number>();
	const bump = (id: number | null) => {
		if (id != null) m.set(id, (m.get(id) ?? 0) + 1);
	};
	for (const t of txs) {
		bump(t.accountId);
		bump(t.toAccountId);
	}
	for (const r of recurring) {
		bump(r.accountId);
		bump(r.toAccountId);
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
		if ((t.type !== 'income' && t.type !== 'expense') || t.categoryId == null || !t.description) continue;
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
	refund: { categoryId: number | null; accountId: number | null };
	transfer: { accountId: number | null; toAccountId: number | null };
}

/** Az utoljára használt kategória/számla típusonként – ezek lesznek az előre kiválasztott értékek. */
export function lastUsed(txs: readonly Transaction[]): LastUsed {
	const res: LastUsed = {
		expense: { categoryId: null, accountId: null },
		income: { categoryId: null, accountId: null },
		refund: { categoryId: null, accountId: null },
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
	if (latest.refund) {
		res.refund = { categoryId: latest.refund.categoryId, accountId: latest.refund.accountId };
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
