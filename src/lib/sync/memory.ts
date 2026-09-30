/**
 * Fejlesztői és teszt-szolgáltató: egyetlen „felhőfájl" a memóriában vagy a `localStorage`-ban. Valódi
 * fiók nélkül kipróbálható vele a teljes szinkron (csak dev buildben vagy `?syncProvider=memory` mellett
 * kínálja fel az app).
 *
 * A `localStorage` egy böngészőkontextuson belül közös, két elszigetelt kontextus (két „eszköz") között
 * nem. Az e2e-teszt ezért a `window.__syncMemoryBackend` horgonyon át közös, Node-oldali tárat köt be.
 */
import type { ProviderId, RemoteFile, SyncProvider, WriteResult } from './provider';

/** A „felhő": egy fájl és a változatszáma. Aszinkron, hogy hálózatot is lehessen mögé kötni. */
export interface MemoryBackend {
	read(): Promise<{ text: string; rev: string } | null>;
	/** Feltételes írás: `prevRev = null` → nem létezhet fájl. */
	write(text: string, prevRev: string | null): Promise<WriteResult>;
	remove(): Promise<void>;
}

/** Tisztán memóriabeli tár (tesztekhez); több szolgáltató-példány osztozhat rajta. */
export function createMemoryBackend(): MemoryBackend & { file: { text: string; rev: string } | null } {
	let counter = 0;
	const self = {
		file: null as { text: string; rev: string } | null,
		async read() {
			return self.file ? { ...self.file } : null;
		},
		async write(text: string, prevRev: string | null): Promise<WriteResult> {
			if ((self.file?.rev ?? null) !== prevRev) return { ok: false, conflict: true };
			self.file = { text, rev: String(++counter) };
			return { ok: true, rev: self.file.rev };
		},
		async remove() {
			self.file = null;
		}
	};
	return self;
}

const STORAGE_KEY = 'koltsegvetes-sync-memory';

/** `localStorage`-alapú tár (dev build, kézi kipróbálás). */
export function createLocalStorageBackend(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): MemoryBackend {
	const load = (): { text: string; rev: string } | null => {
		try {
			const raw = storage.getItem(STORAGE_KEY);
			return raw ? (JSON.parse(raw) as { text: string; rev: string }) : null;
		} catch {
			return null;
		}
	};
	return {
		async read() {
			return load();
		},
		async write(text, prevRev) {
			const cur = load();
			if ((cur?.rev ?? null) !== prevRev) return { ok: false, conflict: true };
			const rev = String((cur ? Number(cur.rev) || 0 : 0) + 1);
			storage.setItem(STORAGE_KEY, JSON.stringify({ text, rev }));
			return { ok: true, rev };
		},
		async remove() {
			storage.removeItem(STORAGE_KEY);
		}
	};
}

declare global {
	interface Window {
		/** Az e2e-teszt által beinjektált, kontextusok között közös tár. */
		__syncMemoryBackend?: MemoryBackend;
	}
}

/** A böngészőben használt tár: a beinjektált, különben a `localStorage`. */
export function defaultMemoryBackend(): MemoryBackend | null {
	if (typeof window === 'undefined') return null;
	if (window.__syncMemoryBackend) return window.__syncMemoryBackend;
	try {
		return window.localStorage ? createLocalStorageBackend(window.localStorage) : null;
	} catch {
		return null;
	}
}

/** Csak dev buildben, vagy ha az URL-ben `?syncProvider=memory` szerepel. */
export function memoryProviderEnabled(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		if (import.meta.env?.DEV) return true;
		return new URLSearchParams(window.location.search).get('syncProvider') === 'memory';
	} catch {
		return false;
	}
}

export function createMemoryProvider(
	backend: MemoryBackend | null = defaultMemoryBackend(),
	opts: { enabled?: boolean; account?: string } = {}
): SyncProvider {
	const id: ProviderId = 'memory';
	const need = (): MemoryBackend => {
		if (!backend) throw new Error('A memória-szolgáltató itt nem érhető el');
		return backend;
	};
	return {
		id,
		label: 'Memória (teszt)',
		available: () => opts.enabled ?? memoryProviderEnabled(),
		async connect() {
			need();
			return { account: opts.account ?? 'memoria@teszt' };
		},
		async ensureToken() {
			return true;
		},
		async read(): Promise<RemoteFile | null> {
			return need().read();
		},
		write: (text, prevRev) => need().write(text, prevRev),
		removeFile: () => need().remove(),
		async disconnect() {}
	};
}
