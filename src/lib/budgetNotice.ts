import { budgetCrossings } from './budget';
import { ledger } from './ledger.svelte';
import { toasts } from './toast.svelte';
import type { Transaction } from './types';

/**
 * Mentés után jelzi, ha egy havi keret átlépte a 80%-ot vagy a 100%-ot. A `before` a mentés előtti
 * tétellista (`ledger.transactions` a mentés előtt).
 */
export function announceBudgetCrossings(before: readonly Transaction[], month: string) {
	for (const c of budgetCrossings(before, ledger.transactions, ledger.categories, month, ledger.prefs.totalBudget)) {
		const pct = Math.round(c.ratio * 100);
		toasts.show(
			c.level === 'over' ? `${c.name}: túllépted a havi keretet (${pct}%)` : `${c.name}: a havi keret ${pct}%-án jársz`,
			{ kind: c.level === 'over' ? 'error' : 'info', duration: 6000 }
		);
	}
}
