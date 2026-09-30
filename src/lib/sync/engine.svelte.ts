/**
 * A szinkronmotor: állapot, ütemezés, zárak, csatlakozás. A tényleges egy-futásos logika a `core.ts`-ben van;
 * itt dől el, mikor fusson, mit mutasson a felület, és mi történjen hiba esetén.
 *
 * A motor nem ismeri az `auth`-ot és a `ledger`-t (ciklus lenne): az `attach` kapja meg a szükséges
 * „gazda" felületet (`SyncHost`), amit az `auth.init` köt be.
 */
import type { LedgerRepo } from '../db/repo';
import {
	META_LOST_BACKUP,
	META_SYNC,
	META_SYNC_KEY,
	applyFirstConnect,
	backupJsonOf,
	planFirstConnect,
	readLocalState,
	syncOnce,
	type SyncConnection,
	type SyncFailureKind,
	type SyncOutcome
} from './core';
import { createSyncKey, decodeSyncFile, deriveSyncKey, peekSyncFile, type SyncKey } from './format';
import type { MergeReport, SyncState } from './merge';
import type { ProviderId, ProviderStorage, RemoteFile, SyncProvider } from './provider';
import { providerFactories, type ProviderFactory } from './providers';
import { passwordError } from '../db/crypto';
import { stamp } from './stamp';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'paused' | 'error';

/** A felhasználónak szóló események (a felület toastot csinál belőlük). */
export type SyncEvent =
	| { type: 'changes'; report: MergeReport }
	| { type: 'repaired'; repaired: string[] }
	| { type: 'epochLost'; lost: number; winner: 'remote' };

export interface SyncHost {
	repo: LedgerRepo;
	/** A memória újratöltése az adatbázisból (a szinkron írta át). */
	reload(): Promise<void>;
	/** Az app fel van-e oldva (zárolt állapotban a szinkron nem fut). */
	unlocked(): boolean;
	/** Sikeres szinkron után (pl. az „utolsó mentés" ideje frissül). */
	onSynced?(at: number): void;
	onEvent?(event: SyncEvent): void;
}

export interface ConnectProbe {
	account: string;
	/** A felhőben már van-e szinkronfájl, és ha igen, titkosított-e. */
	remote: { exists: false } | { exists: true; encrypted: boolean };
}

export type ConnectResult =
	| { ok: true; report?: MergeReport }
	| { ok: false; code: 'needsChoice'; local: { transactions: number }; remote: { transactions: number } }
	| { ok: false; code: 'needsPassword' | 'wrongPassword' | 'weakPassword' | 'invalid' | 'network' | 'concurrent' | 'other'; error: string };

export interface ConnectOptions {
	/** A szinkronjelszó: új fájlnál az új, meglévőnél a másik eszközön megadott. */
	password?: string;
	/** Titkosítás nélkül (csak kifejezett kérésre, új vagy titkosítatlan fájlnál). */
	unencrypted?: boolean;
	/** Ha mindkét oldalon van saját adat: melyiket használjuk. */
	choice?: 'remote' | 'merge';
	/** A „felhőben lévő adatok használata" előtt a helyi adatok JSON-mentése (a felület letölti). */
	beforeOverwrite?: (backupJson: string) => Promise<void> | void;
}

/** Az ütemezéshez használt időzítők (tesztben kézzel léptethető cserélhető). */
export interface Timers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const DEBOUNCE_MS = 4_000;
export const VISIBLE_MIN_INTERVAL_MS = 30_000;
export const BACKOFF_START_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const BUSY_RETRY_MS = 5_000;

const randomDeviceId = () => {
	const b = crypto.getRandomValues(new Uint8Array(8));
	return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export class SyncEngine {
	status = $state<SyncStatus>('off');
	/** A fiók e-mail címe / neve. */
	account = $state('');
	providerId = $state<ProviderId | null>(null);
	providerLabel = $state('');
	encrypted = $state(true);
	lastSyncAt = $state<number | null>(null);
	/** Emberi hibaüzenet; üres, ha nincs hiba. */
	error = $state('');
	errorKind = $state<SyncFailureKind | null>(null);
	/** Van-e feltöltetlen helyi módosítás. */
	pendingLocalChanges = $state(false);
	/** Az eltérő korszak miatt elveszett helyi módosítások előtti mentés (JSON), amíg a felhasználó le nem tölti. */
	lostBackup = $state<{ at: number; json: string } | null>(null);
	connected = $derived(this.providerId !== null);
	/** A folyamatban lévő csatlakozás (bejelentkezés kész, a jelszó/döntés még hátravan); a felület ebből rajzol. */
	probe = $state<ConnectProbe | null>(null);

	private host: SyncHost | null = null;
	private conn: SyncConnection | null = null;
	private key: SyncKey | null = null;
	private provider: SyncProvider | null = null;
	private factories: Partial<Record<ProviderId, ProviderFactory>> = providerFactories;
	private active = false;
	private running = false;
	private debounce: unknown = null;
	private retry: unknown = null;
	private backoff = 0;
	private lastRunAt = 0;
	/** Nő minden helyi módosításnál: így tudjuk, hogy a futás alatt jött-e új. */
	private dirtyCounter = 0;
	private applying = false;
	private pending: {
		provider: SyncProvider;
		account: string;
		remoteFile: RemoteFile | null;
		tokens: unknown;
	} | null = null;
	private listeners: (() => void)[] = [];
	/** A `stamp()` szigorúan növekvő, így az utolsó szinkron ideje pontosan elválasztja a korábbi és a későbbi módosításokat. */
	private now: () => number = () => stamp();
	private kdfIterations: number | undefined;
	private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

	/** Csak teszthez: gyárak, óra és (gyors) kulcsleszármaztatás cseréje. */
	configure(opts: {
		factories?: Partial<Record<ProviderId, ProviderFactory>>;
		now?: () => number;
		kdfIterations?: number;
		timers?: Timers;
	}) {
		if (opts.timers) this.timers = opts.timers;
		if (opts.factories) this.factories = opts.factories;
		if (opts.now) this.now = opts.now;
		if (opts.kdfIterations) this.kdfIterations = opts.kdfIterations;
	}

	/** A gazda bekötése (adatbázis megnyitása után, még zárolt állapotban). */
	async attach(host: SyncHost) {
		this.host = host;
		await this.restore();
	}

	/** A tárolt kapcsolat betöltése (`meta.sync`, `meta.syncKey`). */
	async restore() {
		const repo = this.repo();
		const conn = (await repo.getMeta<SyncConnection>(META_SYNC)) ?? null;
		const lost = (await repo.getMeta<{ at: number; json: string }>(META_LOST_BACKUP)) ?? null;
		this.lostBackup = lost;
		if (!conn) {
			this.setDisconnected();
			return;
		}
		const factory = this.factories[conn.provider];
		if (!factory) {
			this.setDisconnected();
			return;
		}
		this.conn = conn;
		this.key = conn.encrypted ? ((await repo.getMeta<SyncKey>(META_SYNC_KEY)) ?? null) : null;
		this.provider = factory(this.storage());
		this.providerId = conn.provider;
		this.providerLabel = this.provider.label;
		this.account = conn.account;
		this.encrypted = conn.encrypted;
		this.lastSyncAt = conn.lastSyncAt;
		this.status = 'idle';
		// Titkosított kapcsolat kulcs nélkül (pl. sérült tár): a felhasználónak újra meg kell adnia a jelszót.
		if (conn.encrypted && !this.key) this.fail('password', 'A szinkronjelszó nincs meg ezen az eszközön, add meg újra');
	}

	private repo(): LedgerRepo {
		if (!this.host) throw new Error('A szinkronmotor nincs bekötve');
		return this.host.repo;
	}

	private setDisconnected() {
		this.conn = null;
		this.key = null;
		this.provider = null;
		this.providerId = null;
		this.providerLabel = '';
		this.account = '';
		this.lastSyncAt = null;
		this.status = 'off';
		this.error = '';
		this.errorKind = null;
		this.pendingLocalChanges = false;
	}

	/** A szolgáltató tokenjeinek tárolója: a kapcsolat `tokens` mezője (csatlakozás közben a memória). */
	private storage(): ProviderStorage {
		return {
			load: async <T>() => ((this.conn ? this.conn.tokens : this.pending?.tokens) ?? null) as T | null,
			save: async <T>(value: T | null) => {
				if (this.conn) {
					this.conn = { ...this.conn, tokens: value };
					await this.repo().setMeta(META_SYNC, this.conn);
				} else if (this.pending) {
					this.pending.tokens = value;
				}
			}
		};
	}

	// ---------- ütemezés ----------

	/** A feloldás után: (kapcsolat esetén) a figyelők bekötése és alapból az első szinkron. */
	start(opts: { run?: boolean } = {}) {
		const wasActive = this.active;
		this.active = true;
		if (!this.conn) return;
		this.bindListeners();
		if (!wasActive && opts.run !== false) void this.run();
	}

	/** A láthatóság- és online-figyelők bekötése (egyszer; a kapcsolat létrejöhet a feloldás után is). */
	private bindListeners() {
		if (this.listeners.length > 0 || typeof document === 'undefined') return;
		const onVisibility = () => {
			if (!this.active) return;
			if (document.hidden) {
				// Elrejtéskor egy utolsó, gyors feltöltés, ha van függő módosítás.
				if (this.pendingLocalChanges) void this.run();
			} else if (this.now() - this.lastRunAt >= VISIBLE_MIN_INTERVAL_MS) {
				void this.run();
			}
		};
		const onOnline = () => void this.run();
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('online', onOnline);
		this.listeners = [
			() => document.removeEventListener('visibilitychange', onVisibility),
			() => window.removeEventListener('online', onOnline)
		];
	}

	/** Zároláskor: nincs több indítás; a folyamatban lévő futás befejeződik, de nem tölt be semmit a memóriába. */
	stop() {
		this.active = false;
		if (this.debounce) this.timers.clear(this.debounce);
		if (this.retry) this.timers.clear(this.retry);
		this.debounce = this.retry = null;
		for (const off of this.listeners) off();
		this.listeners = [];
	}

	/** A főkönyv minden helyi módosítása után: feltöltetlen változás van, rövid késleltetéssel szinkron. */
	markDirty() {
		if (this.applying || !this.conn) return;
		this.dirtyCounter++;
		this.pendingLocalChanges = true;
		if (!this.active) return;
		if (this.debounce) this.timers.clear(this.debounce);
		this.debounce = this.timers.set(() => void this.run(), DEBOUNCE_MS);
	}

	private scheduleRetry(ms: number) {
		if (!this.active) return;
		if (this.retry) this.timers.clear(this.retry);
		this.retry = this.timers.set(() => void this.run(), ms);
	}

	/** „Szinkron most": felhasználói gesztusból, ezért a token felugró ablakkal is megújítható. */
	async syncNow(): Promise<SyncOutcome | null> {
		if (!this.conn || !this.provider) return null;
		this.error = '';
		this.errorKind = null;
		if (!(await this.provider.ensureToken(true))) {
			this.status = 'paused';
			return null;
		}
		return this.run({ manual: true, tokenReady: true });
	}

	/**
	 * A PIN-feloldás gombnyomásakor hívandó, még az első `await` előtt: a Google csendes tokenmegújítása
	 * csak felhasználói gesztusból megbízható. A folyamat a háttérben fut; a `run` nem várja meg.
	 */
	prepareToken() {
		if (this.provider && this.conn) void this.provider.ensureToken(true).catch(() => false);
	}

	// ---------- futás ----------

	private async withLock<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
		if (this.running) return 'busy';
		this.running = true;
		try {
			const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
			if (locks?.request) {
				return await locks.request('koltsegvetes-sync', { ifAvailable: true }, async (lock) => (lock ? fn() : 'busy'));
			}
			return await fn();
		} finally {
			this.running = false;
		}
	}

	/** Egy szinkronfutás (zárral, hibakezeléssel). Zárolt állapotban vagy kapcsolat nélkül nem csinál semmit. */
	async run(opts: { manual?: boolean; tokenReady?: boolean } = {}): Promise<SyncOutcome | null> {
		if (!this.host || !this.conn || !this.provider) return null;
		if (!opts.manual && (!this.active || !this.host.unlocked())) return null;
		if (this.errorKind === 'password' && !opts.manual) return null; // a felhasználónak kell dönteni
		if (this.debounce) {
			this.timers.clear(this.debounce);
			this.debounce = null;
		}
		const res = await this.withLock(() => this.runLocked(opts.tokenReady === true));
		if (res === 'busy') {
			// Másik futás (vagy másik lap) épp dolgozik: kis várakozás után újra.
			if (this.pendingLocalChanges) this.scheduleRetry(BUSY_RETRY_MS);
			return null;
		}
		return res;
	}

	/** `tokenReady`: a hívó (felhasználói gesztussal) már gondoskodott az érvényes tokenről. */
	private async runLocked(tokenReady: boolean): Promise<SyncOutcome | null> {
		const { host, provider } = this;
		if (!host || !provider || !this.conn) return null;
		this.lastRunAt = this.now();
		this.status = 'syncing';
		const dirtyAtStart = this.dirtyCounter;

		if (!tokenReady && !(await provider.ensureToken(false))) {
			this.status = 'paused';
			return null;
		}
		let outcome = await this.once();
		if (!outcome.ok && outcome.kind === 'auth') {
			// A token időközben lejárt: egy csendes megújítás, és még egy próba.
			if (await provider.ensureToken(false)) outcome = await this.once();
			if (!outcome.ok && outcome.kind === 'auth') {
				this.status = 'paused';
				return outcome;
			}
		}

		if (!outcome.ok) {
			this.fail(outcome.kind, outcome.error);
			if (outcome.kind === 'network' || outcome.kind === 'conflict' || outcome.kind === 'provider') {
				this.backoff = this.backoff ? Math.min(this.backoff * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
				this.scheduleRetry(this.backoff);
			}
			return outcome;
		}

		this.backoff = 0;
		this.error = '';
		this.errorKind = null;
		this.status = 'idle';
		this.lastSyncAt = outcome.writtenAt;
		this.conn = { ...this.conn, lastRev: outcome.rev, lastSyncAt: outcome.writtenAt };
		await host.repo.setMeta(META_SYNC, this.conn);
		// A futás alatt érkezett új módosítás miatt marad a függő jelző, és újabb futás kell.
		if (this.dirtyCounter === dirtyAtStart) this.pendingLocalChanges = false;
		else this.markDirty();
		if (this.active && outcome.changedLocal) await host.reload();
		host.onSynced?.(outcome.writtenAt);
		this.emit(outcome.report, outcome.changedLocal);
		return outcome;
	}

	private async once(): Promise<SyncOutcome> {
		const host = this.host!;
		this.applying = true;
		try {
			return await syncOnce({
				repo: host.repo,
				provider: this.provider!,
				key: this.key,
				deviceId: this.conn!.deviceId,
				lastSyncAt: this.conn!.lastSyncAt,
				now: this.now,
				onEpochLost: async (json) => {
					const lost = { at: this.now(), json };
					await host.repo.setMeta(META_LOST_BACKUP, lost);
					this.lostBackup = lost;
				}
			});
		} finally {
			this.applying = false;
		}
	}

	private emit(report: MergeReport, changedLocal: boolean) {
		const host = this.host;
		if (!host?.onEvent || !changedLocal) return;
		if (report.epochLost !== undefined && report.epochWinner === 'remote') {
			host.onEvent({ type: 'epochLost', lost: report.epochLost, winner: 'remote' });
		}
		if (report.repaired.length > 0) host.onEvent({ type: 'repaired', repaired: report.repaired });
		const t = report.transactions;
		if (t.added + t.updated + t.removed > 0 || report.added + report.updated + report.removed > 0) {
			host.onEvent({ type: 'changes', report });
		}
	}

	private fail(kind: SyncFailureKind, message: string) {
		this.status = 'error';
		this.errorKind = kind;
		this.error = message;
	}

	/** A `lostBackup` lementése után/elvetésekor törölhető. */
	async clearLostBackup() {
		this.lostBackup = null;
		await this.repo().deleteMeta(META_LOST_BACKUP);
	}

	// ---------- csatlakozás ----------

	/** A szolgáltatók, amelyeket fel lehet kínálni (van hozzájuk beállított kliens-azonosító). */
	availableProviders(): { id: ProviderId; label: string }[] {
		const out: { id: ProviderId; label: string }[] = [];
		for (const [id, factory] of Object.entries(this.factories) as [ProviderId, ProviderFactory][]) {
			const p = factory(this.storage());
			if (p.available()) out.push({ id, label: p.label });
		}
		return out;
	}

	/**
	 * 1. lépés: bejelentkezés és a felhőfájl megnézése. Felhasználói gesztusból hívandó (popup). Semmit
	 * nem ment el tartósan; a `completeConnect` vagy a `cancelConnect` zárja le.
	 */
	async beginConnect(id: ProviderId): Promise<ConnectProbe> {
		await this.cancelConnect();
		const factory = this.factories[id];
		if (!factory) throw new Error('Ismeretlen szolgáltató');
		this.pending = { provider: factory(this.storage()), account: '', remoteFile: null, tokens: null };
		const p = this.pending;
		try {
			const { account } = await p.provider.connect();
			p.account = account;
			p.remoteFile = await p.provider.read();
		} catch (e) {
			await this.cancelConnect();
			throw e;
		}
		if (!p.remoteFile) return (this.probe = { account: p.account, remote: { exists: false } });
		const head = peekSyncFile(p.remoteFile.text);
		if (!head.ok) {
			await this.cancelConnect();
			throw new Error(head.error);
		}
		return (this.probe = { account: p.account, remote: { exists: true, encrypted: head.encrypted } });
	}

	async cancelConnect() {
		const p = this.pending;
		this.pending = null;
		this.probe = null;
		if (p) await p.provider.disconnect().catch(() => {});
	}

	/** 2. lépés: jelszó, az első csatlakozás szabályai (terv 4.5), majd az első szinkron. */
	async completeConnect(opts: ConnectOptions = {}): Promise<ConnectResult> {
		const p = this.pending;
		if (!p || !this.host) return { ok: false, code: 'other', error: 'Nincs folyamatban lévő csatlakozás' };
		const repo = this.repo();

		// --- kulcs ---
		const head = p.remoteFile ? peekSyncFile(p.remoteFile.text) : null;
		if (head && !head.ok) return { ok: false, code: 'invalid', error: head.error };
		let key: SyncKey | null;
		if (head?.ok && head.encrypted) {
			if (!opts.password) return { ok: false, code: 'needsPassword', error: 'Add meg a másik eszközön beállított szinkronjelszót' };
			key = await deriveSyncKey(opts.password, head.kdf);
		} else if (opts.unencrypted) {
			key = null;
		} else {
			const bad = passwordError(opts.password ?? '');
			if (bad) return { ok: false, code: opts.password ? 'weakPassword' : 'needsPassword', error: bad };
			key = await createSyncKey(opts.password!, { iterations: this.kdfIterations });
		}

		// --- a távoli állapot ellenőrzése (rossz jelszónál semmit nem mentünk el) ---
		let remote: SyncState | null = null;
		if (p.remoteFile) {
			const dec = await decodeSyncFile(p.remoteFile.text, key);
			if (!dec.ok) {
				const code = dec.code === 'wrongPassword' || dec.code === 'needsPassword' ? 'wrongPassword' : 'invalid';
				return { ok: false, code, error: dec.error };
			}
			remote = dec.state;
		}

		// --- első csatlakozás: mi legyen a két oldal adataival ---
		let report: MergeReport | undefined;
		let changedLocal = false;
		const local = await readLocalState(repo);
		const plan = planFirstConnect(local, remote);
		if (remote && plan.kind !== 'upload') {
			let choice: 'adopt' | 'merge';
			if (plan.kind === 'choose') {
				if (!opts.choice) {
					return {
						ok: false,
						code: 'needsChoice',
						local: { transactions: local.data.transactions.filter((t) => !t.demo).length },
						remote: { transactions: remote.data.transactions.length }
					};
				}
				if (opts.choice === 'remote') await opts.beforeOverwrite?.(backupJsonOf(local));
				choice = opts.choice === 'remote' ? 'adopt' : 'merge';
			} else {
				choice = 'adopt';
			}
			const applied = await applyFirstConnect(repo, local, remote, choice);
			if (!applied.ok) return { ok: false, code: applied.concurrent ? 'concurrent' : 'invalid', error: applied.error };
			report = applied.report;
			changedLocal = true;
		}

		// --- a kapcsolat tartós mentése ---
		const deviceId = (await repo.getMeta<string>('deviceId')) ?? randomDeviceId();
		await repo.setMeta('deviceId', deviceId);
		const conn: SyncConnection = {
			provider: p.provider.id,
			account: p.account,
			encrypted: key !== null,
			deviceId,
			lastRev: p.remoteFile?.rev ?? null,
			lastSyncAt: null,
			tokens: p.tokens
		};
		this.conn = conn;
		this.key = key;
		this.provider = p.provider;
		this.pending = null;
		this.probe = null;
		await repo.setMeta(META_SYNC, conn);
		if (key) await repo.setMetaRaw(META_SYNC_KEY, key);
		else await repo.deleteMeta(META_SYNC_KEY);
		this.providerId = conn.provider;
		this.providerLabel = p.provider.label;
		this.account = conn.account;
		this.encrypted = conn.encrypted;
		this.status = 'idle';
		this.error = '';
		this.errorKind = null;

		// --- első szinkron (feltölti, ami a felhőből hiányzik) ---
		this.start({ run: false }); // a figyelők bekötése; a futást alább közvetlenül, megvárva végezzük
		if (changedLocal) await this.host.reload();
		const outcome = await this.run({ manual: true, tokenReady: true });
		if (outcome && !outcome.ok) {
			return { ok: false, code: outcome.kind === 'network' ? 'network' : 'other', error: outcome.error };
		}
		return { ok: true, report };
	}

	/** Szinkronjelszó cseréje: új só, új kulcs, azonnali újrafeltöltés. A többi eszköz újra bekéri a jelszót. */
	async changePassword(newPassword: string): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.conn || !this.provider || !this.host) return { ok: false, error: 'Nincs szinkron-kapcsolat' };
		if (!this.conn.encrypted) return { ok: false, error: 'A szinkron titkosítás nélkül fut' };
		const bad = passwordError(newPassword);
		if (bad) return { ok: false, error: bad };
		const repo = this.repo();
		const newKey = await createSyncKey(newPassword, { iterations: this.kdfIterations });
		const res = await this.withLock(async () => {
			this.status = 'syncing';
			this.applying = true;
			try {
				return await syncOnce({
					repo,
					provider: this.provider!,
					key: this.key,
					writeKey: newKey,
					forceUpload: true,
					deviceId: this.conn!.deviceId,
					lastSyncAt: this.conn!.lastSyncAt,
					now: this.now
				});
			} finally {
				this.applying = false;
			}
		});
		if (res === 'busy') return { ok: false, error: 'Épp szinkronizálás fut, próbáld újra' };
		if (!res.ok) {
			this.status = 'error';
			return { ok: false, error: res.error };
		}
		this.key = newKey;
		await repo.setMetaRaw(META_SYNC_KEY, newKey);
		this.conn = { ...this.conn, lastRev: res.rev, lastSyncAt: res.writtenAt };
		await repo.setMeta(META_SYNC, this.conn);
		this.lastSyncAt = res.writtenAt;
		this.status = 'idle';
		this.error = '';
		this.errorKind = null;
		if (res.changedLocal) await this.host.reload();
		return { ok: true };
	}

	/**
	 * A hibás/hiányzó jelszó javítása egy már meglévő kapcsolatnál (pl. másik eszközön jelszót cseréltek):
	 * a fájl sójából származtat kulcsot, ellenőrzi, és csak sikeres visszafejtés után menti.
	 */
	async retryPassword(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.conn || !this.provider) return { ok: false, error: 'Nincs szinkron-kapcsolat' };
		if (!(await this.provider.ensureToken(true))) return { ok: false, error: 'A felhő-bejelentkezés lejárt' };
		let file: RemoteFile | null;
		try {
			file = await this.provider.read();
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		if (!file) return { ok: false, error: 'A felhőben nincs szinkronfájl' };
		const head = peekSyncFile(file.text);
		if (!head.ok) return { ok: false, error: head.error };
		if (!head.encrypted) return { ok: false, error: 'A felhőfájl már titkosítatlan' };
		const key = await deriveSyncKey(password, head.kdf);
		const dec = await decodeSyncFile(file.text, key);
		if (!dec.ok) return { ok: false, error: dec.error };
		this.key = key;
		await this.repo().setMetaRaw(META_SYNC_KEY, key);
		this.error = '';
		this.errorKind = null;
		this.status = 'idle';
		void this.run({ manual: true, tokenReady: true });
		return { ok: true };
	}

	/** Kijelentkezés: a token visszavonása, a helyi kapcsolat és kulcs törlése. A felhőfájl megmarad. */
	async disconnect() {
		const provider = this.provider;
		this.stop();
		const repo = this.repo();
		await provider?.disconnect().catch(() => {});
		await repo.deleteMeta(META_SYNC);
		await repo.deleteMeta(META_SYNC_KEY);
		this.setDisconnected();
		if (this.host?.unlocked()) this.active = false;
	}

	/** A felhőben tárolt fájl törlése, majd kijelentkezés. */
	async deleteCloudData() {
		if (this.provider) {
			if (!(await this.provider.ensureToken(true))) throw new Error('A felhő-bejelentkezés lejárt');
			await this.provider.removeFile();
		}
		await this.disconnect();
	}

	/** A teljes törlés (`wipeAll`) után: a memóriabeli állapot alaphelyzetbe. */
	reset() {
		this.stop();
		this.setDisconnected();
		this.lostBackup = null;
		this.pending = null;
		this.probe = null;
	}
}

export const sync = new SyncEngine();
