/** Megtakarítási célok haladása. Számlához kötött célnál a számla egyenlege a haladás. */
import { daysBetween } from './dates';
import type { Goal } from './types';

export interface GoalProgress {
	current: number;
	target: number;
	/** 0–1 */
	ratio: number;
	remaining: number;
	reached: boolean;
	/** Ha van határidő: havonta ennyit kell félretenni (a hátralévő hónapokra osztva). */
	neededPerMonth: number | null;
	/** Hátralévő napok a határidőig (negatív: lejárt). */
	daysLeft: number | null;
}

export function goalProgress(goal: Goal, balances: ReadonlyMap<number, number>, today: string): GoalProgress {
	const current = Math.max(0, goal.accountId != null ? (balances.get(goal.accountId) ?? 0) : goal.saved);
	const remaining = Math.max(0, goal.target - current);
	const daysLeft = goal.deadline ? daysBetween(today, goal.deadline) : null;
	let neededPerMonth: number | null = null;
	if (daysLeft !== null && remaining > 0 && daysLeft > 0) {
		neededPerMonth = Math.ceil(remaining / Math.max(1, daysLeft / 30.4375));
	}
	return {
		current,
		target: goal.target,
		ratio: Math.min(1, current / goal.target),
		remaining,
		reached: current >= goal.target,
		neededPerMonth,
		daysLeft
	};
}
