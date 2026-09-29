import type { Action } from 'svelte/action';

/**
 * Csúszó jelölő a szegmentált választókhoz (`.seg`): a kijelölt elem (a paraméter a sorszáma)
 * helyét és szélességét a `--seg-x` / `--seg-w` változóba írja, a `.seg::before` ezt követi.
 * Mérés kell, mert a rácsoszlopok hosszabb feliratnál (pl. „Átvezetés") nem egyforma szélesek.
 */
export const segIndicator: Action<HTMLElement, number> = (node, index) => {
	let current = index;
	const measure = () => {
		const el = node.children[current] as HTMLElement | undefined;
		if (!el) return node.style.removeProperty('--seg-w');
		const box = node.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		node.style.setProperty('--seg-x', `${r.left - box.left - node.clientLeft}px`);
		node.style.setProperty('--seg-w', `${r.width}px`);
	};
	measure();
	// Az első elhelyezés után kapcsoljuk be az átmenetet, hogy betöltéskor ne csússzon be.
	const raf = requestAnimationFrame(() => (node.dataset.segReady = ''));
	const ro = new ResizeObserver(measure);
	ro.observe(node);
	return {
		update(next) {
			current = next;
			measure();
		},
		destroy() {
			cancelAnimationFrame(raf);
			ro.disconnect();
		}
	};
};
