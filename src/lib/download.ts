/** Fájl letöltése és megosztása a böngészőből (mentés, CSV). */

export function downloadText(filename: string, text: string, mime: string) {
	const blob = new Blob([text], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Megoszthatók-e fájlok (telefonon a rendszer megosztó lapja: Drive, e-mail, üzenetek). */
export function canShareFile(file: File): boolean {
	try {
		return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files: [file] });
	} catch {
		return false;
	}
}

/**
 * Megosztás a rendszer megosztó lapján. `cancelled`: a felhasználó bezárta a lapot (nem hiba);
 * `unsupported`: ezen az eszközön nem lehet fájlt megosztani.
 */
export async function shareFile(file: File, title: string): Promise<'shared' | 'cancelled' | 'unsupported'> {
	if (!canShareFile(file)) return 'unsupported';
	try {
		await navigator.share({ files: [file], title });
		return 'shared';
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
		throw e;
	}
}
