/**
 * Dropbox szolgáltató: OAuth 2 PKCE átirányítással, SDK nélkül, a Dropbox REST API-val az „App folder"
 * mappában. Van refresh token, ezért nem kell újra bejelentkezni. A feltöltés valódi feltételes írás
 * (`mode: update` + `rev`).
 *
 * Az átirányítás miatt az app újratöltődik és újra PIN-t kér; a csatlakozás a feloldás után fejeződik be
 * (`consumeDropboxRedirect` a kódot cseréli tokenre az indulásnál, a `resume` pedig a feloldás után zár).
 */
import {
	SyncAuthError,
	SyncNetworkError,
	SyncProviderError,
	type ProviderStorage,
	type RemoteFile,
	type SyncProvider,
	type WriteResult
} from './provider';

const PATH = '/ledger.sync.json';
const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const EXPIRY_MARGIN_MS = 60_000;

/** A `sessionStorage` kulcsai az átirányítás idejére (a lap újratöltődik). */
export const PKCE_KEY = 'koltsegvetes-dropbox-pkce';
export const PENDING_TOKENS_KEY = 'koltsegvetes-dropbox-tokens';
export const REDIRECT_ERROR_KEY = 'koltsegvetes-dropbox-error';

interface DropboxTokens {
	accessToken: string;
	/** Epoch ms. */
	expiresAt: number;
	refreshToken: string;
}

export interface DropboxDeps {
	/** Az app key (alapból `VITE_DROPBOX_APP_KEY`); nyilvános azonosító, nem titok. */
	appKey?: string;
	fetch?: typeof fetch;
	now?: () => number;
	session?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	/** A jelenlegi és a cél URL kezelése (tesztben hamis). */
	location?: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'> & { assign(url: string): void };
	history?: Pick<History, 'replaceState'>;
	randomBytes?: (n: number) => Uint8Array;
	sha256?: (data: Uint8Array) => Promise<ArrayBuffer>;
}

const b64url = (bytes: Uint8Array) => {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * A `Dropbox-API-Arg` fejlécben a nem ASCII karaktereket `\uXXXX`-re kell escape-elni (a fejléc nem tud
 * UTF-8-at). A fájlnév ASCII, de a segéd általános.
 */
export function dropboxArg(arg: unknown): string {
	return JSON.stringify(arg).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const env = (name: string): string => ((import.meta.env as Record<string, string | undefined> | undefined)?.[name] ?? '') as string;

function resolve(deps: DropboxDeps) {
	return {
		appKey: () => deps.appKey ?? env('VITE_DROPBOX_APP_KEY'),
		fetch: (...a: Parameters<typeof fetch>) => (deps.fetch ?? fetch)(...a),
		now: () => (deps.now ?? Date.now)(),
		session: () => deps.session ?? sessionStorage,
		location: () => deps.location ?? (window.location as unknown as NonNullable<DropboxDeps['location']>),
		history: () => deps.history ?? window.history,
		random: (n: number) => (deps.randomBytes ?? ((k: number) => crypto.getRandomValues(new Uint8Array(k))))(n),
		sha256: (d: Uint8Array) => (deps.sha256 ?? ((x: Uint8Array) => crypto.subtle.digest('SHA-256', x as BufferSource)))(d)
	};
}

/** Az alkalmazás gyökér URL-je (lekérdezés és hash nélkül): ez a regisztrált átirányítási cím. */
const redirectUri = (loc: { origin: string; pathname: string }) => `${loc.origin}${loc.pathname}`;

async function tokenRequest(d: ReturnType<typeof resolve>, params: Record<string, string>): Promise<Response> {
	try {
		return await d.fetch(TOKEN, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params).toString()
		});
	} catch {
		throw new SyncNetworkError();
	}
}

/**
 * Induláskor hívandó: ha az URL-ben Dropbox-átirányítás eredménye van (`?code=…&state=…`), a kódot tokenre
 * cseréli (PKCE), az URL-ből eltünteti, és a tokent a `sessionStorage`-ba teszi a feloldás utánig. Hibát a
 * `REDIRECT_ERROR_KEY` alá ír, amit a `resume` jelez a felhasználónak. Nem dob kivételt.
 */
export async function consumeDropboxRedirect(deps: DropboxDeps = {}): Promise<boolean> {
	const d = resolve(deps);
	let loc: ReturnType<ReturnType<typeof resolve>['location']>;
	let params: URLSearchParams;
	try {
		loc = d.location();
		params = new URLSearchParams(loc.search);
	} catch {
		return false;
	}
	const code = params.get('code');
	const state = params.get('state');
	const error = params.get('error');
	if (!(code && state) && !error) return false;
	const session = d.session();
	const stored = session.getItem(PKCE_KEY);
	// Csak a saját, folyamatban lévő kérésünkre érkező választ dolgozzuk fel; idegen `?code=` marad.
	if (!stored) return false;
	// Az URL azonnal megtisztul: a kód egyszer használatos, és ne maradjon a címsorban vagy az előzményekben.
	d.history().replaceState(null, '', `${loc.pathname}${loc.hash}`);
	session.removeItem(PKCE_KEY);
	let pkce: { verifier: string; state: string; redirectUri: string };
	try {
		pkce = JSON.parse(stored);
	} catch {
		return false;
	}
	const fail = (msg: string) => {
		session.setItem(REDIRECT_ERROR_KEY, msg);
		return true;
	};
	if (error) return fail(error === 'access_denied' ? 'A Dropbox-hozzáférést megtagadtad' : `A Dropbox bejelentkezés sikertelen (${error})`);
	if (state !== pkce.state) return fail('A Dropbox bejelentkezés állapota nem egyezik (lehetséges visszajátszás), próbáld újra');
	try {
		const res = await tokenRequest(d, {
			grant_type: 'authorization_code',
			code: code!,
			code_verifier: pkce.verifier,
			client_id: d.appKey(),
			redirect_uri: pkce.redirectUri
		});
		if (!res.ok) return fail(`A Dropbox nem adott tokent (${res.status})`);
		const t = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
		if (!t.access_token || !t.refresh_token) return fail('A Dropbox válasza hiányos (nincs refresh token)');
		const tokens: DropboxTokens = { accessToken: t.access_token, expiresAt: d.now() + (t.expires_in ?? 14400) * 1000, refreshToken: t.refresh_token };
		session.setItem(PENDING_TOKENS_KEY, JSON.stringify(tokens));
		return true;
	} catch (e) {
		return fail(e instanceof Error ? e.message : 'A Dropbox bejelentkezés nem sikerült');
	}
}

export function createDropboxProvider(storage: ProviderStorage, deps: DropboxDeps = {}): SyncProvider {
	const d = resolve(deps);
	let tokens: DropboxTokens | null | undefined;
	const loadTokens = async () => (tokens === undefined ? (tokens = await storage.load<DropboxTokens>()) : tokens);
	const saveTokens = async (t: DropboxTokens | null) => {
		tokens = t;
		await storage.save(t);
	};

	/** A token frissítése a refresh tokennel; `false`, ha a Dropbox visszautasítja (újra be kell jelentkezni). */
	async function refresh(t: DropboxTokens): Promise<boolean> {
		const res = await tokenRequest(d, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: d.appKey() });
		if (res.status === 400 || res.status === 401) return false;
		if (res.status === 429 || res.status >= 500) throw new SyncNetworkError();
		if (!res.ok) throw new SyncProviderError(`A Dropbox nem adott tokent (${res.status})`);
		const body = (await res.json()) as { access_token?: string; expires_in?: number };
		if (!body.access_token) return false;
		await saveTokens({ ...t, accessToken: body.access_token, expiresAt: d.now() + (body.expires_in ?? 14400) * 1000 });
		return true;
	}

	/** Hitelesített kérés; a hibákat a közös osztályokra képezi le. A 409 visszaadva marad (a hívó értelmezi). */
	async function call(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
		const t = await loadTokens();
		if (!t) throw new SyncAuthError('Nincs Dropbox-bejelentkezés');
		let res: Response;
		try {
			res = await d.fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${t.accessToken}` } });
		} catch {
			throw new SyncNetworkError();
		}
		if (res.ok || res.status === 409) return res;
		if (res.status === 401) {
			await saveTokens({ ...t, expiresAt: 0 }); // a következő `ensureToken` frissít
			throw new SyncAuthError();
		}
		if (res.status === 429 || res.status >= 500) throw new SyncNetworkError(`A Dropbox átmenetileg nem érhető el (${res.status})`);
		throw new SyncProviderError(`A Dropbox hibát adott (${res.status})`);
	}

	/** A 409-es válasz `error_summary` mezője (pl. `path/not_found/…`). */
	const summary = async (res: Response): Promise<string> => {
		try {
			return String(((await res.json()) as { error_summary?: string }).error_summary ?? '');
		} catch {
			return '';
		}
	};

	async function currentAccount(): Promise<string> {
		const res = await call(`${RPC}/users/get_current_account`, { method: 'POST' });
		if (!res.ok) throw new SyncProviderError('A Dropbox-fiók adatai nem kérdezhetők le');
		const a = (await res.json()) as { email?: string; name?: { display_name?: string } };
		return a.email ?? a.name?.display_name ?? 'Dropbox-fiók';
	}

	return {
		id: 'dropbox',
		label: 'Dropbox',
		available: () => !!d.appKey(),

		/**
		 * Átirányít a Dropbox bejelentkezési oldalára (PKCE); a lap elhagyása után a hívás sosem tér vissza. A
		 * `code_verifier`-t és a `state`-et a `sessionStorage` őrzi az átirányítás idejére.
		 */
		async connect() {
			const verifier = b64url(d.random(48));
			const state = b64url(d.random(16));
			const loc = d.location();
			const redirect = redirectUri(loc);
			const challenge = b64url(new Uint8Array(await d.sha256(new TextEncoder().encode(verifier))));
			d.session().setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirectUri: redirect }));
			const q = new URLSearchParams({
				client_id: d.appKey(),
				response_type: 'code',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				token_access_type: 'offline',
				redirect_uri: redirect,
				state
			});
			loc.assign(`${AUTHORIZE}?${q.toString()}`);
			return new Promise<{ account: string }>(() => {});
		},

		async resume() {
			const session = d.session();
			const err = session.getItem(REDIRECT_ERROR_KEY);
			if (err) {
				session.removeItem(REDIRECT_ERROR_KEY);
				throw new SyncAuthError(err);
			}
			const raw = session.getItem(PENDING_TOKENS_KEY);
			if (!raw) return null;
			session.removeItem(PENDING_TOKENS_KEY);
			await saveTokens(JSON.parse(raw) as DropboxTokens);
			return { account: await currentAccount() };
		},

		async ensureToken() {
			const t = await loadTokens();
			if (!t) return false;
			if (t.expiresAt - d.now() > EXPIRY_MARGIN_MS) return true;
			return refresh(t);
		},

		async read(): Promise<RemoteFile | null> {
			const res = await call(`${CONTENT}/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': dropboxArg({ path: PATH }) } });
			if (res.status === 409) {
				if ((await summary(res)).startsWith('path/not_found')) return null;
				throw new SyncProviderError('A Dropbox nem adta oda a fájlt');
			}
			const meta = JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') as { rev?: string };
			if (!meta.rev) throw new SyncProviderError('A Dropbox válaszából hiányzik a fájl változata');
			return { text: await res.text(), rev: meta.rev };
		},

		async write(text, prevRev): Promise<WriteResult> {
			// Valódi feltételes írás: `update` csak akkor, ha a `rev` egyezik; az első írásnál `add`.
			const mode = prevRev === null ? 'add' : { '.tag': 'update', update: prevRev };
			const res = await call(`${CONTENT}/files/upload`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/octet-stream',
					'Dropbox-API-Arg': dropboxArg({ path: PATH, mode, mute: true })
				},
				body: text
			});
			if (res.status === 409) {
				const s = await summary(res);
				if (s.startsWith('path/conflict') || s.startsWith('path/not_found')) return { ok: false, conflict: true };
				throw new SyncProviderError(`A Dropbox nem fogadta el a fájlt (${s || '409'})`);
			}
			const meta = (await res.json()) as { rev?: string };
			if (!meta.rev) throw new SyncProviderError('A Dropbox válaszából hiányzik a fájl változata');
			return { ok: true, rev: meta.rev };
		},

		async removeFile() {
			const res = await call(`${RPC}/files/delete_v2`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: PATH })
			});
			if (res.status === 409 && !(await summary(res)).includes('not_found')) throw new SyncProviderError('A Dropbox nem törölte a fájlt');
		},

		async disconnect() {
			const t = await loadTokens();
			if (t) {
				try {
					await call(`${RPC}/auth/token/revoke`, { method: 'POST' });
				} catch {
					// A visszavonás nem sikerült (pl. nincs kapcsolat): a helyi adatokat így is töröljük.
				}
			}
			await saveTokens(null);
		}
	};
}
