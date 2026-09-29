import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// BASE_PATH: ha az app almappából szolgálódik ki (pl. GitHub Pages: /repo-neve), állítsd be build előtt.
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Tisztán statikus SPA: nincs szerveroldali kód, bármilyen statikus tárhelyről fut.
		adapter: adapter({ fallback: 'index.html', strict: false }),
		// Hash-alapú útválasztás (#/tetelek): nem kell hozzá szerveroldali átirányítás.
		router: { type: 'hash' },
		paths: { base, relative: false }
	}
};

export default config;
