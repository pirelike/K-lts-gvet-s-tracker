import { describe, expect, it } from 'vitest';
import {
	PENDING_TOKENS_KEY,
	PKCE_KEY,
	REDIRECT_ERROR_KEY,
	consumeDropboxRedirect,
	createDropboxProvider,
	dropboxArg,
	type DropboxDeps
} from '../src/lib/sync/dropbox';
import { SyncAuthError, SyncNetworkError, SyncProviderError, type ProviderStorage } from '../src/lib/sync/provider';

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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

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
function memSession(initial: Record<string, string> = {}) {
	const m = new Map(Object.entries(initial));
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		map: m
	};
}

const T0 = 1_800_000_000_000;
const APP_KEY = 'abcd1234appkey';
const tokens = (over: Partial<{ expiresAt: number }> = {}) => ({ accessToken: 'acc-old', expiresAt: T0 + 3_600_000, refreshToken: 'ref-1', ...over });

function setup(over: { handlers?: Handler[]; storage?: ReturnType<typeof memStorage>; deps?: DropboxDeps } = {}) {
	const http = fakeFetch(over.handlers ?? []);
	const storage = over.storage ?? memStorage(tokens());
	const provider = createDropboxProvider(storage, { appKey: APP_KEY, fetch: http.fn, now: () => T0, ...over.deps });
	return { provider, http, storage };
}

const DOWNLOAD = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD = 'https://content.dropboxapi.com/2/files/upload';

describe('Dropbox: Dropbox-API-Arg fejléc', () => {
	it('a nem ASCII karaktereket \\uXXXX-re escape-eli, az ASCII-t nem bántja', () => {
		expect(dropboxArg({ path: '/ledger.sync.json' })).toBe('{"path":"/ledger.sync.json"}');
		const arg = dropboxArg({ path: '/árvíztűrő😀.json' });
		expect(arg).toMatch(/^[\x20-\x7e]*$/);
		expect(arg).toContain('\\u00e1rv');
		expect(arg).toContain('\\ud83d\\ude00'); // helyettesítő pár
		expect(JSON.parse(arg).path).toBe('/árvíztűrő😀.json');
	});
});

describe('Dropbox: bejelentkezés (PKCE, átirányítás)', () => {
	function connectDeps() {
		const session = memSession();
		const assigned: string[] = [];
		const deps: DropboxDeps = {
			session,
			location: { origin: 'https://anna.github.io', pathname: '/koltsegvetes/', search: '?x=1', hash: '#/settings', assign: (u) => void assigned.push(u) },
			randomBytes: (n) => new Uint8Array(n).map((_, i) => (i * 7 + n) % 256),
			sha256: async () => new Uint8Array(32).fill(1).buffer
		};
		return { session, assigned, deps };
	}

	it('a connect a Dropbox authorize URL-jére irányít (S256, offline, a gyökér URL az átirányítási cím), és a verifier-t/state-et elteszi', async () => {
		const { session, assigned, deps } = connectDeps();
		const { provider } = setup({ deps, storage: memStorage() });
		void provider.connect(); // sosem tér vissza: a lap elhagyja az appot
		await new Promise((r) => setTimeout(r, 10));
		expect(assigned).toHaveLength(1);
		const u = new URL(assigned[0]);
		expect(`${u.origin}${u.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize');
		expect(u.searchParams.get('client_id')).toBe(APP_KEY);
		expect(u.searchParams.get('response_type')).toBe('code');
		expect(u.searchParams.get('code_challenge_method')).toBe('S256');
		expect(u.searchParams.get('token_access_type')).toBe('offline');
		expect(u.searchParams.get('redirect_uri')).toBe('https://anna.github.io/koltsegvetes/'); // nincs lekérdezés és hash
		const stored = JSON.parse(session.getItem(PKCE_KEY)!);
		expect(u.searchParams.get('state')).toBe(stored.state);
		expect(stored.verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636: 43–128 karakter
		expect(stored.verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
		expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
		expect(stored.redirectUri).toBe('https://anna.github.io/koltsegvetes/');
	});

	it('a code_challenge a verifier SHA-256 hash-e (base64url)', async () => {
		const { session, assigned, deps } = connectDeps();
		const seen: Uint8Array[] = [];
		deps.sha256 = async (data) => {
			seen.push(data);
			return new Uint8Array(32).fill(255).buffer;
		};
		const { provider } = setup({ deps, storage: memStorage() });
		void provider.connect();
		await new Promise((r) => setTimeout(r, 10));
		const stored = JSON.parse(session.getItem(PKCE_KEY)!);
		expect(new TextDecoder().decode(seen[0])).toBe(stored.verifier);
		expect(new URL(assigned[0]).searchParams.get('code_challenge')).toBe('_'.repeat(42) + '8'); // 32 db 0xFF base64url-ben (az utolsó jel 4 értékes bit: 0b111100 = '8')
	});

	function redirectDeps(search: string, pkce: object | null = { verifier: 'ver-123', state: 'st-1', redirectUri: 'https://anna.github.io/koltsegvetes/' }, handlers: Handler[] = []) {
		const session = memSession(pkce ? { [PKCE_KEY]: JSON.stringify(pkce) } : {});
		const replaced: string[] = [];
		const http = fakeFetch(handlers);
		const deps: DropboxDeps = {
			appKey: APP_KEY,
			fetch: http.fn,
			now: () => T0,
			session,
			location: { origin: 'https://anna.github.io', pathname: '/koltsegvetes/', search, hash: '', assign: () => {} },
			history: { replaceState: (_d, _t, url) => void replaced.push(String(url)) }
		};
		return { session, replaced, http, deps };
	}
	const tokenOk: Handler = (r) =>
		r.url === 'https://api.dropboxapi.com/oauth2/token' ? json({ access_token: 'acc-new', expires_in: 14400, refresh_token: 'ref-new', account_id: 'dbid:1' }) : undefined;

	it('a visszatérő ?code=&state= a tokenre cserélődik (PKCE), az URL megtisztul, a token a feloldásig a sessionben vár', async () => {
		const { session, replaced, http, deps } = redirectDeps('?code=KOD&state=st-1', undefined, [tokenOk]);
		expect(await consumeDropboxRedirect(deps)).toBe(true);
		expect(replaced).toEqual(['/koltsegvetes/']);
		const req = http.reqs[0];
		expect(req.method).toBe('POST');
		expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		const form = new URLSearchParams(req.body);
		expect(Object.fromEntries(form)).toEqual({
			grant_type: 'authorization_code',
			code: 'KOD',
			code_verifier: 'ver-123',
			client_id: APP_KEY,
			redirect_uri: 'https://anna.github.io/koltsegvetes/'
		});
		expect(JSON.parse(session.getItem(PENDING_TOKENS_KEY)!)).toEqual({ accessToken: 'acc-new', expiresAt: T0 + 14_400_000, refreshToken: 'ref-new' });
		expect(session.getItem(PKCE_KEY)).toBeNull(); // egyszer használatos
	});

	it('a hash-útvonal az URL megtisztításakor megmarad', async () => {
		const { replaced, deps } = redirectDeps('?code=KOD&state=st-1', undefined, [tokenOk]);
		deps.location = { ...deps.location!, hash: '#/settings' };
		await consumeDropboxRedirect(deps);
		expect(replaced).toEqual(['/koltsegvetes/#/settings']);
	});

	it('nem egyező state (visszajátszás/CSRF): nem cserél tokenre, hibát jelez', async () => {
		const { session, http, deps } = redirectDeps('?code=KOD&state=MASIK', undefined, [tokenOk]);
		expect(await consumeDropboxRedirect(deps)).toBe(true);
		expect(http.reqs).toHaveLength(0);
		expect(session.getItem(PENDING_TOKENS_KEY)).toBeNull();
		expect(session.getItem(REDIRECT_ERROR_KEY)).toMatch(/nem egyezik/);
	});

	it('megtagadott hozzáférés (?error=access_denied): érthető hiba', async () => {
		const { session, deps } = redirectDeps('?error=access_denied&state=st-1');
		await consumeDropboxRedirect(deps);
		expect(session.getItem(REDIRECT_ERROR_KEY)).toMatch(/megtagadtad/);
	});

	it('saját kérés nélkül érkező ?code= (idegen paraméter) érintetlen marad', async () => {
		const { replaced, http, deps } = redirectDeps('?code=KOD&state=x', null, [tokenOk]);
		expect(await consumeDropboxRedirect(deps)).toBe(false);
		expect(replaced).toEqual([]);
		expect(http.reqs).toHaveLength(0);
	});

	it('nincs átirányítás: nem csinál semmit; a hibás környezet sem dob kivételt', async () => {
		const { http, deps } = redirectDeps('?valami=1');
		expect(await consumeDropboxRedirect(deps)).toBe(false);
		expect(http.reqs).toHaveLength(0);
		expect(await consumeDropboxRedirect({})).toBe(false); // Node: nincs window
	});

	it('a token-csere hibái (400, hiányzó refresh token, nincs hálózat) hibaüzenetté válnak, kivétel nélkül', async () => {
		for (const handler of [
			(() => json({ error: 'invalid_grant' }, 400)) as Handler,
			(() => json({ access_token: 'x', expires_in: 1 })) as Handler,
			(() => {
				throw new TypeError('Failed to fetch');
			}) as Handler
		]) {
			const { session, deps } = redirectDeps('?code=KOD&state=st-1', undefined, [handler]);
			expect(await consumeDropboxRedirect(deps)).toBe(true);
			expect(session.getItem(PENDING_TOKENS_KEY)).toBeNull();
			expect(session.getItem(REDIRECT_ERROR_KEY)).toBeTruthy();
		}
	});

	it('resume: a sessionben váró tokent átveszi a tárolóba, lekérdezi a fiókot; hibát átad; ha nincs mit, null', async () => {
		const session = memSession({ [PENDING_TOKENS_KEY]: JSON.stringify(tokens()) });
		const { provider, storage, http } = setup({
			storage: memStorage(),
			deps: { session },
			handlers: [(r) => (r.url === 'https://api.dropboxapi.com/2/users/get_current_account' ? json({ email: 'anna@example.com', name: { display_name: 'Anna' } }) : undefined)]
		});
		expect(await provider.resume!()).toEqual({ account: 'anna@example.com' });
		expect(storage.value).toEqual(tokens());
		expect(session.getItem(PENDING_TOKENS_KEY)).toBeNull();
		const acct = http.reqs[0];
		expect(acct.method).toBe('POST');
		expect(acct.headers.Authorization).toBe('Bearer acc-old');
		expect(acct.headers['Content-Type']).toBeUndefined(); // az RPC-nek argumentum nélkül nem kell tartalomtípus
		expect(await provider.resume!()).toBeNull();

		const withErr = setup({ storage: memStorage(), deps: { session: memSession({ [REDIRECT_ERROR_KEY]: 'A Dropbox-hozzáférést megtagadtad' }) } });
		await expect(withErr.provider.resume!()).rejects.toThrow(/megtagadtad/);
		await expect(withErr.provider.resume!()).resolves.toBeNull(); // a hiba egyszer jelenik meg
	});

	it('az app key nélküli szolgáltató nem érhető el', () => {
		expect(createDropboxProvider(memStorage(), { appKey: '' }).available()).toBe(false);
		expect(setup().provider.available()).toBe(true);
	});
});

describe('Dropbox: token frissítése', () => {
	it('érvényes token: nem hív hálózatot', async () => {
		const { provider, http } = setup();
		expect(await provider.ensureToken(false)).toBe(true);
		expect(http.reqs).toHaveLength(0);
	});

	it('lejárt token: refresh_token-nel frissít, és menti (a refresh token megmarad)', async () => {
		const { provider, http, storage } = setup({
			storage: memStorage(tokens({ expiresAt: T0 + 10_000 })),
			handlers: [(r) => (r.url === 'https://api.dropboxapi.com/oauth2/token' ? json({ access_token: 'acc-new', expires_in: 14400 }) : undefined)]
		});
		expect(await provider.ensureToken(false)).toBe(true);
		expect(Object.fromEntries(new URLSearchParams(http.reqs[0].body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'ref-1', client_id: APP_KEY });
		expect(storage.value).toEqual({ accessToken: 'acc-new', expiresAt: T0 + 14_400_000, refreshToken: 'ref-1' });
	});

	it('elutasított refresh token (400/401): false; hálózati hiba és 5xx: kivétel', async () => {
		const expired = () => memStorage(tokens({ expiresAt: 0 }));
		expect(await setup({ storage: expired(), handlers: [() => json({ error: 'invalid_grant' }, 400)] }).provider.ensureToken(false)).toBe(false);
		expect(await setup({ storage: expired(), handlers: [() => new Response('', { status: 401 })] }).provider.ensureToken(false)).toBe(false);
		await expect(setup({ storage: expired(), handlers: [() => new Response('', { status: 503 })] }).provider.ensureToken(false)).rejects.toBeInstanceOf(SyncNetworkError);
		const offline = createDropboxProvider(expired(), {
			appKey: APP_KEY,
			now: () => T0,
			fetch: (async () => {
				throw new TypeError('Failed to fetch');
			}) as typeof fetch
		});
		await expect(offline.ensureToken(false)).rejects.toBeInstanceOf(SyncNetworkError);
	});

	it('csatlakozás nélkül nincs token', async () => {
		expect(await setup({ storage: memStorage() }).provider.ensureToken(true)).toBe(false);
	});
});

describe('Dropbox: olvasás', () => {
	it('letöltés: POST a content végpontra, Dropbox-API-Arg fejléc, a rev a Dropbox-API-Result fejlécből', async () => {
		const { provider, http } = setup({
			handlers: [(r) => (r.url === DOWNLOAD ? new Response('{"adat":1}', { headers: { 'Dropbox-API-Result': JSON.stringify({ rev: '015abc', name: 'ledger.sync.json' }) } }) : undefined)]
		});
		expect(await provider.read()).toEqual({ text: '{"adat":1}', rev: '015abc' });
		const req = http.reqs[0];
		expect(req.method).toBe('POST');
		expect(req.headers.Authorization).toBe('Bearer acc-old');
		expect(req.headers['Dropbox-API-Arg']).toBe('{"path":"/ledger.sync.json"}');
	});

	it('409 path/not_found → null (még nincs fájl)', async () => {
		const { provider } = setup({ handlers: [(r) => (r.url === DOWNLOAD ? json({ error_summary: 'path/not_found/.' }, 409) : undefined)] });
		expect(await provider.read()).toBeNull();
	});

	it('más 409 vagy hiányzó rev: szolgáltatói hiba', async () => {
		await expect(setup({ handlers: [() => json({ error_summary: 'valami/mas/.' }, 409)] }).provider.read()).rejects.toBeInstanceOf(SyncProviderError);
		await expect(setup({ handlers: [() => new Response('x')] }).provider.read()).rejects.toBeInstanceOf(SyncProviderError);
	});
});

describe('Dropbox: írás (valódi feltételes írás)', () => {
	const ok = (rev: string): Handler => (r) => (r.url === UPLOAD ? json({ rev, name: 'ledger.sync.json' }) : undefined);

	it('első írás: mode "add"', async () => {
		const { provider, http } = setup({ handlers: [ok('r1')] });
		expect(await provider.write('{"a":1}', null)).toEqual({ ok: true, rev: 'r1' });
		const req = http.reqs[0];
		expect(req.method).toBe('POST');
		expect(req.body).toBe('{"a":1}');
		expect(req.headers['Content-Type']).toBe('application/octet-stream');
		expect(JSON.parse(req.headers['Dropbox-API-Arg'])).toEqual({ path: '/ledger.sync.json', mode: 'add', mute: true });
	});

	it('további írás: mode update a letöltéskori rev-vel', async () => {
		const { provider, http } = setup({ handlers: [ok('r2')] });
		expect(await provider.write('x', 'r1')).toEqual({ ok: true, rev: 'r2' });
		expect(JSON.parse(http.reqs[0].headers['Dropbox-API-Arg'])).toEqual({ path: '/ledger.sync.json', mode: { '.tag': 'update', update: 'r1' }, mute: true });
	});

	it('409 path/conflict → conflict (mindkét módban)', async () => {
		const { provider } = setup({ handlers: [() => json({ error_summary: 'path/conflict/file/..' }, 409)] });
		expect(await provider.write('x', 'r1')).toEqual({ ok: false, conflict: true });
		expect(await provider.write('x', null)).toEqual({ ok: false, conflict: true });
	});

	it('közben törölt fájl (update + path/not_found) → conflict; egyéb 409 hiba', async () => {
		expect(await setup({ handlers: [() => json({ error_summary: 'path/not_found/..' }, 409)] }).provider.write('x', 'r1')).toEqual({ ok: false, conflict: true });
		await expect(setup({ handlers: [() => json({ error_summary: 'path/insufficient_space/..' }, 409)] }).provider.write('x', null)).rejects.toBeInstanceOf(SyncProviderError);
	});
});

describe('Dropbox: hibák', () => {
	const failing = (status: number) => setup({ handlers: [() => new Response('', { status })] });

	it('401: hitelesítési hiba, a token lejártnak jelölődik (a következő ensureToken frissít)', async () => {
		const { provider, storage } = failing(401);
		await expect(provider.read()).rejects.toBeInstanceOf(SyncAuthError);
		expect((storage.value as { expiresAt: number }).expiresAt).toBe(0);
	});

	it('429 és 5xx: hálózati (később újrapróbálható); egyéb 4xx: szolgáltatói hiba', async () => {
		await expect(failing(429).provider.read()).rejects.toBeInstanceOf(SyncNetworkError);
		await expect(failing(502).provider.write('x', null)).rejects.toBeInstanceOf(SyncNetworkError);
		await expect(failing(400).provider.read()).rejects.toBeInstanceOf(SyncProviderError);
	});

	it('a fetch kivétele (nincs hálózat) → hálózati hiba', async () => {
		const p = createDropboxProvider(memStorage(tokens()), {
			appKey: APP_KEY,
			now: () => T0,
			fetch: (async () => {
				throw new TypeError('Failed to fetch');
			}) as typeof fetch
		});
		await expect(p.read()).rejects.toBeInstanceOf(SyncNetworkError);
	});

	it('token nélkül nincs kérés', async () => {
		const { provider, http } = setup({ storage: memStorage() });
		await expect(provider.read()).rejects.toBeInstanceOf(SyncAuthError);
		expect(http.reqs).toHaveLength(0);
	});
});

describe('Dropbox: törlés és kijelentkezés', () => {
	it('removeFile: delete_v2; a már nem létező fájl nem hiba', async () => {
		const a = setup({ handlers: [(r) => (r.url === 'https://api.dropboxapi.com/2/files/delete_v2' ? json({ metadata: {} }) : undefined)] });
		await a.provider.removeFile();
		expect(JSON.parse(a.http.reqs[0].body!)).toEqual({ path: '/ledger.sync.json' });
		expect(a.http.reqs[0].headers['Content-Type']).toBe('application/json');
		const gone = setup({ handlers: [() => json({ error_summary: 'path_lookup/not_found/..' }, 409)] });
		await expect(gone.provider.removeFile()).resolves.toBeUndefined();
		const bad = setup({ handlers: [() => json({ error_summary: 'path_lookup/malformed_path/..' }, 409)] });
		await expect(bad.provider.removeFile()).rejects.toBeInstanceOf(SyncProviderError);
	});

	it('disconnect: visszavonja a tokent (auth/token/revoke), és törli a tárolt adatokat', async () => {
		const { provider, http, storage } = setup({ handlers: [(r) => (r.url === 'https://api.dropboxapi.com/2/auth/token/revoke' ? json(null) : undefined)] });
		await provider.disconnect();
		expect(http.reqs[0].url).toBe('https://api.dropboxapi.com/2/auth/token/revoke');
		expect(http.reqs[0].headers.Authorization).toBe('Bearer acc-old');
		expect(storage.value).toBeNull();
	});

	it('disconnect a visszavonás hibája esetén is törli a helyi adatokat', async () => {
		const { provider, storage } = setup({ handlers: [() => new Response('', { status: 500 })] });
		await provider.disconnect();
		expect(storage.value).toBeNull();
	});
});
