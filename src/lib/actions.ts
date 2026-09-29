import { ledger } from './ledger.svelte';
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
