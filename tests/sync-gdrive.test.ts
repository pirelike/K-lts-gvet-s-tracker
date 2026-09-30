import { describe, expect, it, vi } from 'vitest';
import { GDRIVE_SCOPE, createGdriveProvider, type GoogleOAuth2 } from '../src/lib/sync/gdrive';
import { SyncAuthError, SyncNetworkError, SyncProviderError, type ProviderStorage } from '../src/lib/sync/provider';

// ---------- hamis Google Identity Services ----------

interface GisCall {
	config: Parameters<GoogleOAuth2['initTokenClient']>[0];
	overrides?: { prompt?: string };
}
function fakeGis(behaviour: () => { token?: string; expiresIn?: number; error?: string; popupError?: string } = () => ({ token: 'tok-1' })) {
	const calls: GisCall[] = [];
	const revoked: string[] = [];
	const oauth: GoogleOAuth2 = {
		initTokenClient(config) {
			return {
				requestAccessToken(overrides) {
					calls.push({ config, overrides });
					const b = behaviour();
					queueMicrotask(() => {
						if (b.popupError) config.error_callback?.({ type: b.popupError });
						else config.callback({ access_token: b.token, expires_in: b.expiresIn ?? 3600, error: b.error });
					});
				}
			};
		},
		revoke(token, done) {
			revoked.push(token);
			done?.();
		}
	};
	return { oauth, calls, revoked };
}

// ---------- hamis fetch ----------

interface Req {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}
type Handler = (req: Req) => Response | Promise<Response> | undefined;
function fakeFetch(handlers: Handler[]) {
	const reqs: Req[] = [];
	const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
		const req: Req = { url: String(url), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined };
		reqs.push(req);
		for (const h of handlers) {
			const res = await h(req);
			if (res) return res;
		}
		return new Response('nincs kezelő', { status: 500 });
	}) as typeof fetch;
	return { fn, reqs };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function memStorage(initial: unknown = null): ProviderStorage & { value: unknown } {
	const s = {
		value: initial,
		async load<T>() {
			return s.value as T | null;
		},
		async save<T>(v: T | null) {
			s.value = v;
		}
	};
	return s;
}

const T0 = 1_800_000_000_000;
function setup(over: { handlers?: Handler[]; gis?: ReturnType<typeof fakeGis>; storage?: ReturnType<typeof memStorage>; now?: () => number } = {}) {
	const gis = over.gis ?? fakeGis();
	const http = fakeFetch(over.handlers ?? []);
	const storage = over.storage ?? memStorage();
	const provider = createGdriveProvider(storage, { clientId: 'cid-123.apps.googleusercontent.com', fetch: http.fn, loadGis: async () => gis.oauth, now: over.now ?? (() => T0) });
	return { provider, gis, http, storage };
}
const userinfo: Handler = (r) => (r.url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo') ? json({ email: 'anna@example.com' }) : undefined);
const connected = (over: Partial<{ expiresAt: number }> = {}) => memStorage({ accessToken: 'tok-old', expiresAt: T0 + 3_600_000, email: 'anna@example.com', ...over });

describe('Google Drive: bejelentkezés', () => {
	it('a szolgáltató csak beállított kliens-azonosítóval érhető el', () => {
		const p = createGdriveProvider(memStorage(), { clientId: '', loadGis: async () => fakeGis().oauth });
		expect(p.available()).toBe(false);
		expect(p.id).toBe('gdrive');
		expect(p.label).toBe('Google Drive');
		expect(setup().provider.available()).toBe(true);
	});

	it('connect: a megadott kliens-azonosítóval és scope-okkal kér tokent, lekérdezi az e-mailt, és tárolja a tokent', async () => {
		const { provider, gis, http, storage } = setup({ handlers: [userinfo] });
		expect(await provider.connect()).toEqual({ account: 'anna@example.com' });
		expect(gis.calls).toHaveLength(1);
		expect(gis.calls[0].config.client_id).toBe('cid-123.apps.googleusercontent.com');
		expect(gis.calls[0].config.scope).toBe(GDRIVE_SCOPE);
		expect(GDRIVE_SCOPE).toContain('https://www.googleapis.com/auth/drive.appdata');
		expect(GDRIVE_SCOPE).toContain('openid email');
		const info = http.reqs.find((r) => r.url.includes('userinfo'))!;
		expect(info.headers.Authorization).toBe('Bearer tok-1');
		expect(storage.value).toEqual({ accessToken: 'tok-1', expiresAt: T0 + 3_600_000, email: 'anna@example.com' });
	});

	it('a felhasználó bezárja az ablakot / a popup nem nyílik meg: hitelesítési hiba, és nem mentődik token', async () => {
		for (const popupError of ['popup_closed', 'popup_failed_to_open']) {
			const { provider, storage } = setup({ gis: fakeGis(() => ({ popupError })) });
			await expect(provider.connect()).rejects.toBeInstanceOf(SyncAuthError);
			expect(storage.value).toBeNull();
		}
		const { provider } = setup({ gis: fakeGis(() => ({ error: 'access_denied' })) });
		await expect(provider.connect()).rejects.toThrow(/access_denied/);
	});

	it('a GIS betöltése kapcsolat nélkül hálózati hiba', async () => {
		const p = createGdriveProvider(memStorage(), {
			clientId: 'x',
			loadGis: async () => {
				throw new SyncNetworkError();
			}
		});
		await expect(p.connect()).rejects.toBeInstanceOf(SyncNetworkError);
	});

	it('kliens-azonosító nélkül nem próbálkozik', async () => {
		const p = createGdriveProvider(memStorage(), { clientId: '', loadGis: async () => fakeGis().oauth });
		await expect(p.connect()).rejects.toBeInstanceOf(SyncProviderError);
	});
});

describe('Google Drive: token megújítása', () => {
	it('érvényes token: nem nyit ablakot', async () => {
		const { provider, gis } = setup({ storage: connected() });
		expect(await provider.ensureToken(false)).toBe(true);
		expect(await provider.ensureToken(true)).toBe(true);
		expect(gis.calls).toHaveLength(0);
	});

	it('csatlakozás nélkül nincs token', async () => {
		expect(await setup().provider.ensureToken(true)).toBe(false);
	});

	it('lejárat előtti megújítás: `prompt: ""`-vel kéri, és az új tokent menti (az e-mailt megtartja)', async () => {
		const { provider, gis, storage } = setup({ storage: connected({ expiresAt: T0 + 30_000 }), gis: fakeGis(() => ({ token: 'tok-new', expiresIn: 1800 })) });
		expect(await provider.ensureToken(false)).toBe(true);
		expect(gis.calls[0].overrides).toEqual({ prompt: '' });
		expect(storage.value).toEqual({ accessToken: 'tok-new', expiresAt: T0 + 1_800_000, email: 'anna@example.com' });
	});

	it('ha a megújítás nem sikerül (popup-blokkoló, nincs gesztus), false: „szünetel", nem kivétel', async () => {
		const { provider, storage } = setup({ storage: connected({ expiresAt: 0 }), gis: fakeGis(() => ({ popupError: 'popup_failed_to_open' })) });
		expect(await provider.ensureToken(false)).toBe(false);
		expect((storage.value as { accessToken: string }).accessToken).toBe('tok-old'); // a régi tárolt token érintetlen
	});

	it('ha a GIS betöltése hálózati hiba, az kivétel (a motor „nincs kapcsolat"-ként kezeli)', async () => {
		const storage = connected({ expiresAt: 0 });
		const p = createGdriveProvider(storage, {
			clientId: 'x',
			now: () => T0,
			loadGis: async () => {
				throw new SyncNetworkError();
			}
		});
		await expect(p.ensureToken(false)).rejects.toBeInstanceOf(SyncNetworkError);
	});

	it('a megújítás időtúllépéssel véget ér, ha az ablak sosem válaszol', async () => {
		vi.useFakeTimers();
		try {
			const hang: GoogleOAuth2 = { initTokenClient: () => ({ requestAccessToken() {} }), revoke() {} };
			const p = createGdriveProvider(connected({ expiresAt: 0 }), { clientId: 'x', now: () => T0, loadGis: async () => hang });
			const pending = p.ensureToken(false);
			await vi.advanceTimersByTimeAsync(15_001);
			expect(await pending).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

const FILES = 'https://www.googleapis.com/drive/v3/files';
const listUrl = (r: Req) => r.url.startsWith(`${FILES}?spaces=appDataFolder`);

describe('Google Drive: olvasás', () => {
	it('nincs fájl → null; a keresés az appDataFolderben, név szerint fut', async () => {
		const { provider, http } = setup({ storage: connected(), handlers: [(r) => (listUrl(r) ? json({ files: [] }) : undefined)] });
		expect(await provider.read()).toBeNull();
		const req = http.reqs[0];
		expect(req.method).toBe('GET');
		expect(req.headers.Authorization).toBe('Bearer tok-old');
		const u = new URL(req.url);
		expect(u.searchParams.get('spaces')).toBe('appDataFolder');
		expect(u.searchParams.get('q')).toBe("name='ledger.sync.json'");
		expect(u.searchParams.get('fields')).toContain('files(id,version');
	});

	it('egy fájl: letölti (alt=media), a rev a fájl version mezője', async () => {
		const { provider, http } = setup({
			storage: connected(),
			handlers: [
				(r) => (listUrl(r) ? json({ files: [{ id: 'f1', version: '7', createdTime: '2026-01-01T00:00:00Z' }] }) : undefined),
				(r) => (r.url === `${FILES}/f1?alt=media` ? new Response('{"tartalom":1}') : undefined)
			]
		});
		expect(await provider.read()).toEqual({ text: '{"tartalom":1}', rev: '7' });
		expect(http.reqs.map((r) => r.method)).toEqual(['GET', 'GET']);
	});

	it('több fájl (két eszköz egyszerre hozott létre): a legrégebbi az elsődleges, a többi extra példány', async () => {
		const { provider } = setup({
			storage: connected(),
			handlers: [
				(r) =>
					listUrl(r)
						? json({
								files: [
									{ id: 'uj', version: '2', createdTime: '2026-02-01T00:00:00Z' },
									{ id: 'regi', version: '9', createdTime: '2026-01-01T00:00:00Z' }
								]
							})
						: undefined,
				(r) => (r.url.endsWith('/regi?alt=media') ? new Response('REGI') : r.url.endsWith('/uj?alt=media') ? new Response('UJ') : undefined)
			]
		});
		expect(await provider.read()).toEqual({ text: 'REGI', rev: '9', extra: [{ text: 'UJ', ref: 'uj' }] });
	});

	it('a listázás után közben törölt fájl (404) → null', async () => {
		const { provider } = setup({
			storage: connected(),
			handlers: [(r) => (listUrl(r) ? json({ files: [{ id: 'f1', version: '1' }] }) : undefined), () => new Response('', { status: 404 })]
		});
		expect(await provider.read()).toBeNull();
	});
});

describe('Google Drive: írás', () => {
	it('első írás: multipart feltöltés az appDataFolderbe, a tartalom és a metaadat is benne van', async () => {
		const { provider, http } = setup({
			storage: connected(),
			handlers: [(r) => (listUrl(r) ? json({ files: [] }) : undefined), (r) => (r.method === 'POST' ? json({ id: 'uj', version: '1' }) : undefined)]
		});
		expect(await provider.write('{"adat":true}', null)).toEqual({ ok: true, rev: '1' });
		const post = http.reqs.find((r) => r.method === 'POST')!;
		expect(post.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version');
		expect(post.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
		expect(post.headers.Authorization).toBe('Bearer tok-old');
		expect(post.body).toContain('"name":"ledger.sync.json"');
		expect(post.body).toContain('"parents":["appDataFolder"]');
		expect(post.body).toContain('{"adat":true}');
		const boundary = post.headers['Content-Type'].split('boundary=')[1];
		expect(post.body!.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
	});

	it('első írás, de közben másik eszköz már létrehozta a fájlt → conflict (nem hoz létre másodikat)', async () => {
		const { provider, http } = setup({ storage: connected(), handlers: [(r) => (listUrl(r) ? json({ files: [{ id: 'mar', version: '1' }] }) : undefined)] });
		expect(await provider.write('x', null)).toEqual({ ok: false, conflict: true });
		expect(http.reqs.every((r) => r.method === 'GET')).toBe(true);
	});

	it('frissítés: az írás előtt újra lekéri a version-t; egyezésnél PATCH a media feltöltéssel', async () => {
		const { provider, http } = setup({
			storage: connected(),
			handlers: [
				(r) => (listUrl(r) ? json({ files: [{ id: 'f1', version: '7' }] }) : undefined),
				(r) => (r.method === 'PATCH' ? json({ id: 'f1', version: '8' }) : undefined)
			]
		});
		expect(await provider.write('ÚJ TARTALOM', '7')).toEqual({ ok: true, rev: '8' });
		expect(http.reqs.map((r) => r.method)).toEqual(['GET', 'PATCH']);
		const patch = http.reqs[1];
		expect(patch.url).toBe('https://www.googleapis.com/upload/drive/v3/files/f1?uploadType=media&fields=id,version');
		expect(patch.body).toBe('ÚJ TARTALOM');
		expect(patch.headers['Content-Type']).toContain('application/json');
	});

	it('eltérő version (másik eszköz közben írt) → conflict, nem ír', async () => {
		const { provider, http } = setup({ storage: connected(), handlers: [(r) => (listUrl(r) ? json({ files: [{ id: 'f1', version: '9' }] }) : undefined)] });
		expect(await provider.write('x', '7')).toEqual({ ok: false, conflict: true });
		expect(http.reqs.some((r) => r.method === 'PATCH')).toBe(false);
	});

	it('közben törölt fájl (nincs találat / 404) → conflict', async () => {
		const gone = setup({ storage: connected(), handlers: [(r) => (listUrl(r) ? json({ files: [] }) : undefined)] });
		expect(await gone.provider.write('x', '7')).toEqual({ ok: false, conflict: true });
		const p404 = setup({
			storage: connected(),
			handlers: [(r) => (listUrl(r) ? json({ files: [{ id: 'f1', version: '7' }] }) : undefined), () => new Response('', { status: 404 })]
		});
		expect(await p404.provider.write('x', '7')).toEqual({ ok: false, conflict: true });
	});
});

describe('Google Drive: hibák', () => {
	const failing = (status: number, body = '') => setup({ storage: connected(), handlers: [() => new Response(body, { status })] });

	it('401: hitelesítési hiba, és a tárolt token lejártnak jelölődik (megújítás kell)', async () => {
		const { provider, storage } = failing(401);
		await expect(provider.read()).rejects.toBeInstanceOf(SyncAuthError);
		expect((storage.value as { expiresAt: number }).expiresAt).toBe(0);
	});

	it('403 jogosultsági hiba → hitelesítési; 403 rate limit, 429 és 5xx → hálózati (később újrapróbálható)', async () => {
		await expect(failing(403, '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}').provider.read()).rejects.toBeInstanceOf(SyncAuthError);
		await expect(failing(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}').provider.read()).rejects.toBeInstanceOf(SyncNetworkError);
		await expect(failing(429).provider.read()).rejects.toBeInstanceOf(SyncNetworkError);
		await expect(failing(503).provider.read()).rejects.toBeInstanceOf(SyncNetworkError);
	});

	it('egyéb 4xx: szolgáltatói hiba (az újrapróbálás nem segít)', async () => {
		await expect(failing(400).provider.read()).rejects.toBeInstanceOf(SyncProviderError);
	});

	it('a fetch kivétele (nincs hálózat) → hálózati hiba', async () => {
		const p = createGdriveProvider(connected(), {
			clientId: 'x',
			now: () => T0,
			fetch: (async () => {
				throw new TypeError('Failed to fetch');
			}) as typeof fetch
		});
		await expect(p.read()).rejects.toBeInstanceOf(SyncNetworkError);
		await expect(p.write('x', null)).rejects.toBeInstanceOf(SyncNetworkError);
	});

	it('token nélkül nincs kérés: hitelesítési hiba', async () => {
		const { provider, http } = setup();
		await expect(provider.read()).rejects.toBeInstanceOf(SyncAuthError);
		expect(http.reqs).toHaveLength(0);
	});
});

describe('Google Drive: törlés és kijelentkezés', () => {
	it('removeFile: minden találatot töröl (DELETE)', async () => {
		const { provider, http } = setup({
			storage: connected(),
			handlers: [(r) => (listUrl(r) ? json({ files: [{ id: 'a', version: '1' }, { id: 'b', version: '1' }] }) : undefined), (r) => (r.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined)]
		});
		await provider.removeFile();
		expect(http.reqs.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual([`${FILES}/a`, `${FILES}/b`]);
	});

	it('discardCopy: egy adott példány törlése', async () => {
		const { provider, http } = setup({ storage: connected(), handlers: [() => new Response(null, { status: 204 })] });
		await provider.discardCopy!('uj');
		expect(http.reqs).toEqual([expect.objectContaining({ method: 'DELETE', url: `${FILES}/uj` })]);
	});

	it('disconnect: visszavonja a tokent, és törli a tárolt adatokat; a felhőfájlhoz nem nyúl', async () => {
		const { provider, gis, http, storage } = setup({ storage: connected() });
		await provider.disconnect();
		expect(gis.revoked).toEqual(['tok-old']);
		expect(storage.value).toBeNull();
		expect(http.reqs).toHaveLength(0);
	});

	it('disconnect a visszavonás hibája esetén is törli a helyi adatokat', async () => {
		const storage = connected();
		const broken: GoogleOAuth2 = {
			initTokenClient: () => ({ requestAccessToken() {} }),
			revoke() {
				throw new Error('nincs hálózat');
			}
		};
		const p = createGdriveProvider(storage, { clientId: 'x', now: () => T0, loadGis: async () => broken });
		await p.disconnect();
		expect(storage.value).toBeNull();
	});
});
