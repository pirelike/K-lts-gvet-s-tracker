/**
 * Billentyűparancsok. Egybetűs gyorsgombok és „g" + betű váltások (mint a Gmailben / GitHubon).
 * A feldolgozás tiszta függvény, hogy tesztelhető legyen; a bekötés a `+layout.svelte`-ben van.
 */

export type ShortcutAction =
	| { type: 'go'; path: string }
	| { type: 'search' }
	| { type: 'help' }
	| { type: 'month'; delta: -1 | 1 }
	| { type: 'lock' };

/** A „g" utáni betűk és az útvonalak. */
export const GO_TARGETS: Record<string, { path: string; label: string }> = {
	h: { path: '/', label: 'Főoldal' },
	t: { path: '/transactions', label: 'Tételek' },
	c: { path: '/calendar', label: 'Naptár' },
	s: { path: '/stats', label: 'Elemzés' },
	b: { path: '/budgets', label: 'Keretek' },
	r: { path: '/recurring', label: 'Ismétlődő tételek' },
	g: { path: '/goals', label: 'Megtakarítási célok' },
	m: { path: '/templates', label: 'Sablonok' },
	k: { path: '/categories', label: 'Kategóriák' },
	a: { path: '/accounts', label: 'Számlák' },
	i: { path: '/import', label: 'CSV-import' },
	o: { path: '/settings', label: 'Beállítások' }
};

export const SHORTCUT_HELP: { keys: string; label: string }[] = [
	{ keys: 'N', label: 'Új tétel' },
	{ keys: '/', label: 'Keresés a tételek között' },
	{ keys: '[  ]', label: 'Előző / következő hónap' },
	{ keys: '?', label: 'Ez a súgó' },
	{ keys: 'G, majd L', label: 'Zárolás' },
	...Object.entries(GO_TARGETS).map(([k, v]) => ({ keys: `G, majd ${k.toUpperCase()}`, label: v.label })),
	{ keys: 'Ctrl + Enter', label: 'Űrlapon: mentés és új tétel' },
	{ keys: 'Esc', label: 'Súgó / ablak bezárása' }
];

export interface KeyLike {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
}

/** Beviteli mezőben gépelés közben nem működnek a gyorsgombok. */
export function isTypingTarget(el: EventTarget | null): boolean {
	const e = el as HTMLElement | null;
	if (!e || typeof e.tagName !== 'string') return false;
	const tag = e.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable === true;
}

/**
 * Egy billentyű feldolgozása. `pending` a „g" lenyomása után `'g'`; vissza a művelet és az új
 * függő állapot. A módosítóval (Ctrl/Alt/Cmd) nyomott billentyűket békén hagyja.
 */
export function resolveShortcut(
	e: KeyLike,
	pending: string | null
): { action: ShortcutAction | null; pending: string | null } {
	if (e.ctrlKey || e.metaKey || e.altKey) return { action: null, pending: null };
	const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
	if (pending === 'g') {
		if (k === 'l') return { action: { type: 'lock' }, pending: null };
		const target = GO_TARGETS[k];
		return { action: target ? { type: 'go', path: target.path } : null, pending: null };
	}
	switch (k) {
		case 'g':
			return { action: null, pending: 'g' };
		case 'n':
			return { action: { type: 'go', path: '/new' }, pending: null };
		case '/':
			return { action: { type: 'search' }, pending: null };
		case '?':
			return { action: { type: 'help' }, pending: null };
		case '[':
			return { action: { type: 'month', delta: -1 }, pending: null };
		case ']':
			return { action: { type: 'month', delta: 1 }, pending: null };
		default:
			return { action: null, pending: null };
	}
}
