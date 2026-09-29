/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Offline működés: az app teljes felülete (HTML, JS, CSS, ikonok) az első betöltéskor a
// gyorsítótárba kerül, onnantól internet nélkül is indul. Az adatok az IndexedDB-ben vannak,
// azokhoz semmi köze a service worker-nek.
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `koltsegvetes-${version}`;
const origin = sw.location.origin;
// A kiindulópont (index.html) a scope gyökere; hash-útválasztásnál minden képernyő ez az egy dokumentum.
const SHELL = new URL('./', sw.location.href).href;
const PRECACHE = [SHELL, ...[...build, ...files].map((p) => origin + p)];
// Fejlesztői módban a `build` lista üres: ilyenkor nem gyorsítótárazunk.
const isDev = build.length === 0;

sw.addEventListener('install', (event) => {
	if (isDev) return;
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith('koltsegvetes-') && key !== CACHE) await caches.delete(key);
			}
		})()
	);
});

sw.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (isDev || req.method !== 'GET' || !req.url.startsWith(origin)) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			if (req.mode === 'navigate') {
				const shell = await cache.match(SHELL);
				if (shell) return shell;
				return fetch(req);
			}
			const hit = await cache.match(req);
			if (hit) return hit;
			return fetch(req);
		})()
	);
});
