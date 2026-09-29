import { ledger, type BulkPatch } from './ledger.svelte';
import { toasts } from './toast.svelte';

/** Tétel törlése; néhány másodpercig „Visszavonás" gombbal (tételnél nincs külön megerősítés). */
export async function deleteTxWithUndo(id: number) {
	try {
		const snapshot = await ledger.deleteTx(id);
		toasts.show('Tétel törölve', {
			actionLabel: 'Visszavonás',
			onAction: async () => {
				try {
					await ledger.restoreTx(snapshot);
					toasts.show('Tétel visszaállítva');
				} catch (e) {
					toasts.error(e instanceof Error ? e.message : 'A visszaállítás nem sikerült');
				}
			}
		});
	} catch (e) {
		toasts.error(e instanceof Error ? e.message : 'A törlés nem sikerült');
	}
}

/** Több tétel törlése egyszerre, közös „Visszavonás"-sal. */
export async function deleteTxsWithUndo(ids: number[]): Promise<number> {
	try {
		const snapshots = await ledger.deleteTxs(ids);
		if (snapshots.length === 0) return 0;
		toasts.show(`${snapshots.length} tétel törölve`, {
			actionLabel: 'Visszavonás',
			onAction: async () => {
				try {
					const n = await ledger.restoreTxs(snapshots);
					toasts.show(`${n} tétel visszaállítva`);
				} catch (e) {
					toasts.error(e instanceof Error ? e.message : 'A visszaállítás nem sikerült');
				}
			}
		});
		return snapshots.length;
	} catch (e) {
		toasts.error(e instanceof Error ? e.message : 'A törlés nem sikerült');
		return 0;
	}
}

/** Csoportos módosítás visszavonási lehetőséggel; a kihagyott tételekről tájékoztat. */
export async function updateTxsWithUndo(ids: number[], patch: BulkPatch, what: string): Promise<boolean> {
	const before = ledger.transactions.filter((t) => ids.includes(t.id));
	try {
		const { changed, skipped } = await ledger.updateTxs(ids, patch);
		const note = skipped ? ` (${skipped} tételre nem alkalmazható, kihagyva)` : '';
		if (changed === 0) {
			toasts.show(`Nem módosult tétel${note}`);
			return false;
		}
		toasts.show(`${what}: ${changed} tétel${note}`, {
			actionLabel: 'Visszavonás',
			onAction: async () => {
				try {
					await ledger.replaceTxs(before);
					toasts.show('Módosítás visszavonva');
				} catch (e) {
					toasts.error(e instanceof Error ? e.message : 'A visszavonás nem sikerült');
				}
			}
		});
		return true;
	} catch (e) {
		toasts.error(e instanceof Error ? e.message : 'A módosítás nem sikerült');
		return false;
	}
}
