/**
 * Hash-alapú útválasztásnál a SvelteKit `page.url` a böngésző valódi URL-je (`/#/tetelek?q=kave`),
 * ezért az útvonalat és a lekérdezés-paramétereket a hash-ből olvassuk ki. Reaktív: a `page.url`
 * változásakor a származtatott értékek is frissülnek.
 */
import { page } from '$app/state';

/** Az `#/utvonal?kulcs=ertek` alakú hash szétbontása. */
export function parseHash(hash: string): { path: string; query: string } {
	const h = hash.replace(/^#/, '').split('#')[0];
	const i = h.indexOf('?');
	const path = (i < 0 ? h : h.slice(0, i)) || '/';
	return { path: path.startsWith('/') ? path : `/${path}`, query: i < 0 ? '' : h.slice(i + 1) };
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
