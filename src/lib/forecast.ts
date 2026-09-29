/**
 * Előrejelzés a folyó hónapra: várható hó végi költés és egyenleg.
 *
 * Módszer (egyszerű és magyarázható): a hátralévő napokra a **változó költések** (az ismétlődő
 * szabályból nem származó kiadások) napi átlagát vetítjük előre, ehhez jönnek a hátralévő,
 * még jóvá nem hagyott ismétlődő tételek. A napi átlag az elmúlt hónapok átlagából indul, és
 * a hónap előrehaladtával (10. napra) fokozatosan a folyó hónap tényleges ütemére vált.
 */
import { daysInMonth, monthRange, shiftMonth } from './dates';
import { pendingOccurrences } from './recurring';
import { spentByCategory } from './budget';
import type { Recurring, Transaction } from './types';

export interface Forecast {
	month: string;
	today: string;
	daysElapsed: number;
	daysInMonth: number;
	daysLeft: number;
	/** Eddigi nettó költés a hónapban. */
	spent: number;
	income: number;
	/** Hátralévő ismétlődő kiadások (esedékesek és a hónap végéig várhatók). */
	upcomingExpense: number;
	upcomingIncome: number;
	/** Napi változó költés, amivel a hátralévő napokat számoltuk. */
	dailyVariable: number;
	/** Várható teljes hó végi nettó költés. */
	projectedExpense: number;
	projectedIncome: number;
	/** Hó végi várható összegyenleg (ha adott az aktuális összegyenleg). */
	projectedBalance: number | null;
}

/** Nettó változó költés egy hónapban (ismétlődő szabályból származó tételek nélkül). */
function variableSpent(txs: readonly Transaction[], month: string): number {
	const { from, to } = monthRange(month);
	let sum = 0;
	for (const t of txs) {
		if (t.date < from || t.date > to || t.recurringId != null) continue;
		if (t.type === 'expense') sum += t.amount;
		else if (t.type === 'refund') sum -= t.amount;
	}
	return Math.max(0, sum);
}

export function forecastMonth(opts: {
	txs: readonly Transaction[];
	recurring: readonly Recurring[];
	today: string;
	/** Az aktív számlák összegyenlege most (az „egyenleg hó végén" számításhoz). */
	currentBalance?: number;
}): Forecast {
	const { txs, recurring, today } = opts;
	const month = today.slice(0, 7);
	const { to } = monthRange(month);
	const dim = daysInMonth(month);
	const elapsed = Number(today.slice(8));
	const left = dim - elapsed;

	const spentTotal = [...spentByCategory(txs, month).values()].reduce((a, b) => a + b, 0);
	const spent = Math.max(0, spentTotal);
	const { from } = monthRange(month);
	let income = 0;
	for (const t of txs) if (t.type === 'income' && t.date >= from && t.date <= to) income += t.amount;

	// A folyó hónap ütemét az elmúlt (legfeljebb 3) tétellel rendelkező hónap átlagához keverjük.
	const thisRate = variableSpent(txs, month) / elapsed;
	const prevRates: number[] = [];
	for (let i = 1; i <= 3; i++) {
		const m = shiftMonth(month, -i);
		const r = monthRange(m);
		if (txs.some((t) => t.date >= r.from && t.date <= r.to)) prevRates.push(variableSpent(txs, m) / daysInMonth(m));
	}
	const prevRate = prevRates.length ? prevRates.reduce((a, b) => a + b, 0) / prevRates.length : null;
	const w = Math.min(1, elapsed / 10);
	const dailyVariable = prevRate === null ? thisRate : w * thisRate + (1 - w) * prevRate;

	let upcomingExpense = 0;
	let upcomingIncome = 0;
	for (const rule of recurring) {
		for (const date of pendingOccurrences(rule, to)) {
			void date;
			if (rule.type === 'expense') upcomingExpense += rule.amount;
			else if (rule.type === 'income') upcomingIncome += rule.amount;
		}
	}

	const variableRest = Math.round(dailyVariable * left);
	const projectedExpense = spent + upcomingExpense + variableRest;
	const projectedIncome = income + upcomingIncome;
	return {
		month,
		today,
		daysElapsed: elapsed,
		daysInMonth: dim,
		daysLeft: left,
		spent,
		income,
		upcomingExpense,
		upcomingIncome,
		dailyVariable: Math.round(dailyVariable),
		projectedExpense,
		projectedIncome,
		projectedBalance:
			opts.currentBalance === undefined
				? null
				: opts.currentBalance + upcomingIncome - upcomingExpense - variableRest
	};
}
