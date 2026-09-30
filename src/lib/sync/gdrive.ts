/**
 * Google Drive szolgáltató: Google Identity Services (token model) + a Drive REST API az `appDataFolder`
 * rejtett, csak az apphoz tartozó mappájában. Nincs SDK és nincs npm-függőség: a GIS szkriptet csak akkor
 * töltjük be, amikor a felhasználó a Google-t választja.
 *
 * A böngészőben nincs refresh token: a hozzáférési token kb. 1 óráig él. A megújítás (`prompt: ''`)
 * felhasználói gesztusból megbízható; ha nem sikerül, az állapot „szünetel", és egy koppintás megoldja.
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

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email';
const GIS_URL = 'https://accounts.google.com/gsi/client';
const FILE_NAME = 'ledger.sync.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
/** A lejárat előtt ennyivel már megújítjuk a tokent. */
const EXPIRY_MARGIN_MS = 60_000;
const INTERACTIVE_TIMEOUT_MS = 120_000;
const SILENT_TIMEOUT_MS = 15_000;

interface TokenResponse {
	access_token?: string;
	expires_in?: number | string;
	error?: string;
}
interface TokenClient {
	requestAccessToken(overrides?: { prompt?: string }): void;
}
/** A GIS-ből használt felület (a valódi `window.google.accounts.oauth2` része). */
export interface GoogleOAuth2 {
	initTokenClient(config: {
		client_id: string;
		scope: string;
		callback: (r: TokenResponse) => void;
		error_callback?: (e: { type?: string; message?: string }) => void;
	}): TokenClient;
	revoke(token: string, done?: () => void): void;
}

declare global {
	interface Window {
		google?: { accounts?: { oauth2?: GoogleOAuth2 } };
	}
}

interface GdriveTokens {
	accessToken: string;
	/** Epoch ms. */
	expiresAt: number;
	email: string;
}

export interface GdriveDeps {
	/** Az OAuth kliens-azonosító (alapból `VITE_GOOGLE_CLIENT_ID`); nyilvános érték, nem titok. */
	clientId?: string;
	fetch?: typeof fetch;
	/** A GIS betöltése; tesztben hamis. */
	loadGis?: () => Promise<GoogleOAuth2>;
	now?: () => number;
}

let gisPromise: Promise<GoogleOAuth2> | null = null;

/** A GIS szkript dinamikus betöltése (egyszer). Kapcsolat nélkül hálózati hiba. */
export function loadGoogleIdentity(): Promise<GoogleOAuth2> {
	const ready = () => window.google?.accounts?.oauth2 ?? null;
	const existing = ready();
	if (existing) return Promise.resolve(existing);
	gisPromise ??= new Promise<GoogleOAuth2>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = GIS_URL;
		s.async = true;
		s.onload = () => {
			const g = ready();
			if (g) resolve(g);
			else reject(new SyncProviderError('A Google bejelentkezés nem érhető el'));
		};
		s.onerror = () => {
			gisPromise = null; // legközelebb újra megpróbáljuk
			reject(new SyncNetworkError('A Google bejelentkezés nem tölthető be (nincs kapcsolat?)'));
		};
		document.head.appendChild(s);
	});
	return gisPromise;
}

interface DriveFile {
	id: string;
	version?: string;
	createdTime?: string;
	modifiedTime?: string;
}

/** A legrégebbi elöl: ő marad meg, ha két eszköz egyszerre hozott létre fájlt. */
const byAge = (a: DriveFile, b: DriveFile) =>
	(a.createdTime ?? a.modifiedTime ?? '').localeCompare(b.createdTime ?? b.modifiedTime ?? '') || a.id.localeCompare(b.id);

export function createGdriveProvider(storage: ProviderStorage, deps: GdriveDeps = {}): SyncProvider {
	const clientId = () => deps.clientId ?? (import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';
	const doFetch = (...a: Parameters<typeof fetch>) => (deps.fetch ?? fetch)(...a);
	const now = () => (deps.now ?? Date.now)();
	const gis = deps.loadGis ?? loadGoogleIdentity;

	let tokens: GdriveTokens | null | undefined;
	const loadTokens = async () => (tokens === undefined ? (tokens = await storage.load<GdriveTokens>()) : tokens);
	const saveTokens = async (t: GdriveTokens | null) => {
		tokens = t;
		await storage.save(t);
	};

	/** Hozzáférési token kérése a GIS-től; felhasználói gesztusból popup nyílik, időtúllépéssel. */
	async function requestToken(prompt: string | undefined, timeoutMs: number): Promise<{ accessToken: string; expiresAt: number }> {
		const oauth = await gis();
		const id = clientId();
		if (!id) throw new SyncProviderError('Nincs beállítva a Google kliens-azonosító');
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new SyncAuthError('A Google bejelentkezés nem válaszolt')), timeoutMs);
			const done = <T>(fn: (v: T) => void) => (v: T) => {
				clearTimeout(timer);
				fn(v);
			};
			const client = oauth.initTokenClient({
				client_id: id,
				scope: GDRIVE_SCOPE,
				callback: done((r: TokenResponse) => {
					if (r.error || !r.access_token) reject(new SyncAuthError(`A Google bejelentkezés sikertelen${r.error ? `: ${r.error}` : ''}`));
					else resolve({ accessToken: r.access_token, expiresAt: now() + Number(r.expires_in ?? 3600) * 1000 });
				}),
				error_callback: done((e: { type?: string }) => reject(new SyncAuthError(`A Google bejelentkezés megszakadt (${e.type ?? 'ismeretlen'})`)))
			});
			client.requestAccessToken(prompt === undefined ? undefined : { prompt });
		});
	}

	/** Hitelesített kérés; a hibákat a közös osztályokra képezi le. */
	async function api(url: string, init: RequestInit = {}): Promise<Response> {
		const t = await loadTokens();
		if (!t) throw new SyncAuthError('Nincs Google-bejelentkezés');
		let res: Response;
		try {
			res = await doFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t.accessToken}` } });
		} catch {
			throw new SyncNetworkError();
		}
		if (res.ok) return res;
		if (res.status === 401) {
			// A token érvénytelen: a következő `ensureToken` megújítja.
			await saveTokens({ ...t, expiresAt: 0 });
			throw new SyncAuthError();
		}
		if (res.status === 404) return res;
		const reason = await res.text().catch(() => '');
		if (res.status === 429 || res.status >= 500 || /rateLimitExceeded|userRateLimitExceeded/i.test(reason)) throw new SyncNetworkError(`A Google Drive átmenetileg nem érhető el (${res.status})`);
		if (res.status === 403) throw new SyncAuthError('A Google Drive elutasította a kérést (jogosultság)');
		throw new SyncProviderError(`A Google Drive hibát adott (${res.status})`);
	}

	async function listFiles(): Promise<DriveFile[]> {
		const q = encodeURIComponent(`name='${FILE_NAME}'`);
		const res = await api(`${API}?spaces=appDataFolder&q=${q}&fields=files(id,version,createdTime,modifiedTime)`);
		if (!res.ok) throw new SyncProviderError(`A Google Drive hibát adott (${res.status})`);
		const body = (await res.json()) as { files?: DriveFile[] };
		return [...(body.files ?? [])].sort(byAge);
	}

	async function download(id: string): Promise<string | null> {
		const res = await api(`${API}/${encodeURIComponent(id)}?alt=media`);
		return res.ok ? res.text() : null;
	}

	return {
		id: 'gdrive',
		label: 'Google Drive',
		available: () => !!clientId(),

		async connect() {
			const t = await requestToken(undefined, INTERACTIVE_TIMEOUT_MS);
			await saveTokens({ ...t, email: '' });
			const res = await api(USERINFO);
			if (!res.ok) throw new SyncProviderError('A Google-fiók adatai nem kérdezhetők le');
			const info = (await res.json()) as { email?: string; name?: string };
			const email = info.email ?? info.name ?? 'Google-fiók';
			await saveTokens({ ...t, email });
			return { account: email };
		},

		async ensureToken(interactive) {
			const t = await loadTokens();
			if (!t) return false;
			if (t.expiresAt - now() > EXPIRY_MARGIN_MS) return true;
			try {
				const fresh = await requestToken('', interactive ? INTERACTIVE_TIMEOUT_MS : SILENT_TIMEOUT_MS);
				await saveTokens({ ...fresh, email: t.email });
				return true;
			} catch (e) {
				// Kapcsolat nélkül a GIS sem tölthető be: ez nem „szünetel", hanem hálózati hiba.
				if (e instanceof SyncNetworkError) throw e;
				return false;
			}
		},

		async read(): Promise<RemoteFile | null> {
			const files = await listFiles();
			if (files.length === 0) return null;
			const [primary, ...others] = files;
			const text = await download(primary.id);
			if (text === null) return null; // közben törölték
			const extra: { text: string; ref: string }[] = [];
			for (const f of others) {
				const copy = await download(f.id);
				if (copy !== null) extra.push({ text: copy, ref: f.id });
			}
			return { text, rev: primary.version ?? '', ...(extra.length ? { extra } : {}) };
		},

		async write(text, prevRev): Promise<WriteResult> {
			// A Drive v3 nem ad megbízható feltételes írást: írás előtt újra lekérjük a változatot.
			const files = await listFiles();
			if (prevRev === null) {
				if (files.length > 0) return { ok: false, conflict: true }; // közben másik eszköz létrehozta
				const boundary = `koltsegvetes-${Math.random().toString(36).slice(2)}`;
				const body =
					`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n` +
					`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
				const res = await api(`${UPLOAD}?uploadType=multipart&fields=id,version`, {
					method: 'POST',
					headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
					body
				});
				if (!res.ok) throw new SyncProviderError(`A Google Drive hibát adott (${res.status})`);
				const created = (await res.json()) as DriveFile;
				return { ok: true, rev: created.version ?? '' };
			}
			const target = files[0];
			if (!target || target.version !== prevRev) return { ok: false, conflict: true };
			const res = await api(`${UPLOAD}/${encodeURIComponent(target.id)}?uploadType=media&fields=id,version`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json; charset=UTF-8' },
				body: text
			});
			if (res.status === 404) return { ok: false, conflict: true };
			if (!res.ok) throw new SyncProviderError(`A Google Drive hibát adott (${res.status})`);
			const updated = (await res.json()) as DriveFile;
			return { ok: true, rev: updated.version ?? '' };
		},

		async discardCopy(ref) {
			await api(`${API}/${encodeURIComponent(ref)}`, { method: 'DELETE' });
		},

		async removeFile() {
			for (const f of await listFiles()) await api(`${API}/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
		},

		async disconnect() {
			const t = await loadTokens();
			if (t?.accessToken) {
				try {
					(await gis()).revoke(t.accessToken);
				} catch {
					// A visszavonás nem sikerült (pl. nincs kapcsolat): a helyi adatokat így is töröljük.
				}
			}
			await saveTokens(null);
		}
	};
}
