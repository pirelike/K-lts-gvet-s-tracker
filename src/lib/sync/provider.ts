/**
 * A felhő-szolgáltatók közös felülete. A motor csak ezt ismeri; a Google Drive és a Dropbox ugyanazt
 * az egyetlen fájlt (`ledger.sync.json`) kezeli, ezért ugyanaz a kód szolgálja ki mindkettőt.
 */

export type ProviderId = 'gdrive' | 'dropbox' | 'memory';

export interface RemoteFile {
	text: string;
	/** A fájl változatának azonosítója (Drive: `version`, Dropbox: `rev`); feltételes íráshoz kell. */
	rev: string;
}

export type WriteResult = { ok: true; rev: string } | { ok: false; conflict: true };

export interface SyncProvider {
	readonly id: ProviderId;
	/** Emberi név a felületen, pl. „Google Drive". */
	readonly label: string;
	/** Van-e beállított kliens-azonosító a buildben (különben a szolgáltató nem jelenik meg). */
	available(): boolean;
	/** Bejelentkezés. Felhasználói gesztusból hívandó (popup / átirányítás). */
	connect(): Promise<{ account: string }>;
	/**
	 * Érvényes hozzáférési token biztosítása. `interactive = false`: csak csendben (nincs felugró ablak).
	 * `false` = nem sikerült, felhasználói gesztus kell.
	 */
	ensureToken(interactive: boolean): Promise<boolean>;
	/** `null` = még nincs fájl. */
	read(): Promise<RemoteFile | null>;
	/** Feltételes írás: `prevRev = null` → a fájl még nem létezhet. Eltérő változatnál `conflict`. */
	write(text: string, prevRev: string | null): Promise<WriteResult>;
	/** A felhőben tárolt fájl törlése (a „Felhőben tárolt adatok törlése" gomb). */
	removeFile(): Promise<void>;
	/** Token visszavonása és a szolgáltató helyi adatainak törlése; a felhőbeli fájl megmarad. */
	disconnect(): Promise<void>;
}

/** A szolgáltató tokenjeinek tárolója (a motor a `meta.sync` kulcs alá képezi le, eszközönként). */
export interface ProviderStorage {
	load<T>(): Promise<T | null>;
	save<T>(value: T | null): Promise<void>;
}

/** Hálózati vagy átmeneti szolgáltatói hiba (nincs kapcsolat, 5xx, 429): később újrapróbálható. */
export class SyncNetworkError extends Error {
	constructor(message = 'Nincs kapcsolat a felhővel') {
		super(message);
		this.name = 'SyncNetworkError';
	}
}

/** A token érvénytelen vagy lejárt (401/403): megújítás vagy újra-bejelentkezés kell. */
export class SyncAuthError extends Error {
	constructor(message = 'A felhő-bejelentkezés lejárt') {
		super(message);
		this.name = 'SyncAuthError';
	}
}

/** A kérés nem kezelhető (4xx, váratlan válasz): nem segít az újrapróbálás. */
export class SyncProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SyncProviderError';
	}
}
