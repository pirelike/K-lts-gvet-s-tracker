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

// --- emlékeztető-értesítések (lásd src/lib/notify.ts) ---

/** A beállításokat közvetlenül az IndexedDB-ből olvassa; az adatbázist nem hozza létre és nem frissíti. */
async function readReminderSettings(): Promise<{ enabled?: boolean; dailyTime?: string | null } | null> {
	const db = await new Promise<IDBDatabase | null>((resolve) => {
		const req = indexedDB.open('koltsegvetes');
		// Ha még nincs adatbázis, ne jöjjön létre üresen (az app később a saját sémájával hozza létre).
		req.onupgradeneeded = () => req.transaction?.abort();
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => resolve(null);
	});
	if (!db) return null;
	try {
		if (!db.objectStoreNames.contains('meta')) return null;
		const row = await new Promise<{ value?: { reminders?: { enabled?: boolean; dailyTime?: string | null } } } | undefined>((resolve) => {
			const r = db.transaction('meta').objectStore('meta').get('settings');
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => resolve(undefined);
		});
		return row?.value?.reminders ?? null;
	} finally {
		db.close();
	}
}

sw.addEventListener('periodicsync', (event) => {
	const e = event as Event & { tag: string; waitUntil(p: Promise<unknown>): void };
	if (e.tag !== 'daily-reminder') return;
	e.waitUntil(
		(async () => {
			const settings = await readReminderSettings();
			if (!settings?.enabled || !settings.dailyTime) return;
			const [h, m] = settings.dailyTime.split(':').map(Number);
			const now = new Date();
			if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
			// Ugyanaz a tag: egy napi emlékeztető nem halmozódik.
			await sw.registration.showNotification('Költségvetés', {
				body: 'Ne felejtsd rögzíteni a mai kiadásaidat.',
				tag: 'daily',
				icon: 'icons/icon-192.png'
			});
		})()
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		(async () => {
			const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = clients.find((c) => c.url.startsWith(SHELL));
			if (open) return void (await open.focus());
			await sw.clients.openWindow(SHELL);
		})()
	);
});
