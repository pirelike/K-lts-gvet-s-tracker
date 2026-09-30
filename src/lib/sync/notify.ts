/** A szinkronmotor eseményeiből felhasználónak szóló üzenetek (toastok). */
import { downloadText } from '../download';
import { toasts } from '../toast.svelte';
import type { SyncEvent } from './engine.svelte';
import { sync } from './engine.svelte';

/** Az elveszett helyi módosítások előtti mentés letöltése; utána a mentés törölhető. */
export async function downloadLostBackup() {
	const lost = sync.lostBackup;
	if (!lost) return;
	const day = new Date(lost.at).toISOString().slice(0, 10);
	downloadText(`koltsegvetes-mentes-szinkron-elott-${day}.json`, lost.json, 'application/json');
	await sync.clearLostBackup();
}

/** A módosult tételek száma szövegesen; üres, ha nem történt érdemi változás. */
function changeText(t: { added: number; updated: number; removed: number }, other: number): string {
	const parts: string[] = [];
	if (t.added) parts.push(`${t.added} új tétel érkezett`);
	if (t.updated) parts.push(`${t.updated} tétel módosult`);
	if (t.removed) parts.push(`${t.removed} tétel törlődött`);
	if (parts.length === 0) return other > 0 ? 'Frissültek az adatok a másik eszközről' : '';
	return `${parts.join(', ')} a másik eszközről`.replace(/^./, (c) => c.toUpperCase());
}

export function toastForSyncEvent(e: SyncEvent) {
	if (e.type === 'epochLost') {
		toasts.show(
			`A másik eszközön pénznemet váltottál, mentést töltöttél vissza vagy példaadatot töltöttél be/töröltél; az itteni, még nem szinkronizált ${e.lost} módosítás elveszett.`,
			{ kind: 'error', actionLabel: 'Mentés letöltése', onAction: downloadLostBackup, duration: 20000 }
		);
	} else if (e.type === 'repaired') {
		const n = e.repaired.length;
		toasts.show(`A szinkron ${n} hivatkozást javított: ${e.repaired[0]}${n > 1 ? ` (+${n - 1})` : ''}`, { duration: 8000 });
	} else {
		const other = e.report.added + e.report.updated + e.report.removed - (e.report.transactions.added + e.report.transactions.updated + e.report.transactions.removed);
		const text = changeText(e.report.transactions, other);
		if (text) toasts.show(text);
	}
}
