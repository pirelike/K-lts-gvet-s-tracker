/** Hash-alapú útválasztáshoz: linkek és navigáció. Az útvonalak mindig `/`-rel kezdődnek. */
import { goto } from '$app/navigation';

export const href = (path: string) => `#${path}`;

export function go(path: string, opts: { replaceState?: boolean; keepFocus?: boolean; noScroll?: boolean } = {}) {
	return goto(href(path), opts);
}

let hasHistory = false;
export function markHistory() {
	hasHistory = true;
}

/** Vissza az előző képernyőre, ha van; különben a megadott útvonalra. */
export function goBack(fallback: string) {
	if (hasHistory && typeof history !== 'undefined') history.back();
	else void go(fallback, { replaceState: true });
}

/** Lekérdezőszöveg építése: az üres értékeket kihagyja. */
export function query(params: Record<string, string | number | null | undefined>): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
	}
	const s = sp.toString();
	return s ? `?${s}` : '';
}
