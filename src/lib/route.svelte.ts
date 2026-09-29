/**
 * Hash-alapú útválasztásnál a SvelteKit `page.url` a böngésző valódi URL-je (`/#/tetelek?q=kave`),
 * ezért az útvonalat és a lekérdezés-paramétereket a hash-ből olvassuk ki. Reaktív: a `page.url`
 * változásakor a származtatott értékek is frissülnek.
 */
import { page } from '$app/state';
import { isValidMonth } from './dates';

/** Az `#/utvonal?kulcs=ertek` alakú hash szétbontása. */
export function parseHash(hash: string): { path: string; query: string } {
	const h = hash.replace(/^#/, '').split('#')[0];
	const i = h.indexOf('?');
	const path = (i < 0 ? h : h.slice(0, i)) || '/';
	return { path: path.startsWith('/') ? path : `/${path}`, query: i < 0 ? '' : h.slice(i + 1) };
}

export type ViewTransitionKind = 'page' | 'month-next' | 'month-prev';

/**
 * Milyen átmenet illik két hash-útvonal közé: másik képernyő → áttűnés; ugyanazon a képernyőn
 * másik hónap → csúszás a lapozás irányába; minden más (keresés, szűrők) → nincs átmenet.
 * A `?month` nélküli nézet a mai hónapot mutatja (`currentMonth`).
 */
export function viewTransitionKind(
	fromHash: string,
	toHash: string,
	currentMonth: string
): ViewTransitionKind | null {
	const a = parseHash(fromHash);
	const b = parseHash(toHash);
	if (a.path !== b.path) return 'page';
	const month = (query: string) => {
		const m = new URLSearchParams(query).get('month') ?? '';
		return isValidMonth(m) ? m : currentMonth;
	};
	const ma = month(a.query);
	const mb = month(b.query);
	if (ma === mb) return null;
	return mb > ma ? 'month-next' : 'month-prev';
}

class Route {
	private parsed = $derived(parseHash(page.url.hash));
	/** pl. `/transactions` */
	get path() {
		return this.parsed.path;
	}
	/** A nyers lekérdezőszöveg (kulcsoláshoz). */
	get query() {
		return this.parsed.query;
	}
	get params() {
		return new URLSearchParams(this.parsed.query);
	}
}

export const route = new Route();
