// Az alkalmazásikonok (PNG) legenerálása a favicon.svg-ből egy headless Chromium-mal.
// Használat: npm run icons   (Playwright + Chromium szükséges; az eredmény be van commitolva)
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const svg = (size, { maskable = false } = {}) => {
	// maskable: a rajz a biztonságos zónán (középső 80%) belül marad, a háttér teli négyzet.
	const scale = maskable ? 0.72 : 1;
	const inner = `<g transform="translate(48 48) scale(${scale}) translate(-48 -48)">
		<circle cx="48" cy="48" r="26" fill="none" stroke="#fff" stroke-width="6"/>
		<path d="M38 52h20M38 44h20M48 34v28" stroke="#fff" stroke-width="5" stroke-linecap="round"/></g>`;
	const bg = maskable
		? '<rect width="96" height="96" fill="#4f46e5"/>'
		: '<rect width="96" height="96" rx="24" fill="#4f46e5"/>';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="${size}" height="${size}">${bg}${inner}</svg>`;
};

const targets = [
	['static/icons/icon-192.png', 192, {}],
	['static/icons/icon-512.png', 512, {}],
	['static/icons/icon-maskable-512.png', 512, { maskable: true }]
];

await mkdir('static/icons', { recursive: true });
const browser = await chromium.launch();
for (const [file, size, opts] of targets) {
	const page = await browser.newPage({ viewport: { width: size, height: size } });
	await page.setContent(`<body style="margin:0;background:transparent">${svg(size, opts)}</body>`);
	await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
	await page.close();
	console.log('kész:', file);
}
await browser.close();
