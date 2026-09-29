/**
 * Indítás és zárolás: az adatbázis megnyitása, első indításkor PIN beállítása,
 * későbbi indításkor PIN-bekérés, automatikus zárolás.
 */
import { todayISO } from './dates';
import { openLedgerDb } from './db/idb';
import {
	createPinRecord,
	cryptoAvailable,
	lockoutMs,
	pinFormatError,
	verifyPin,
	type PinAttempts,
	type PinRecord
} from './db/pin';
import { LedgerRepo } from './db/repo';
import { ledger } from './ledger.svelte';

export type Phase = 'boot' | 'unsupported' | 'error' | 'setup' | 'locked' | 'unlocked';

/** Automatikus zárolás háttérbe kerülés után (mp); -1 = soha. */
export const AUTO_LOCK_OPTIONS: { seconds: number; label: string }[] = [
	{ seconds: 0, label: 'Azonnal' },
	{ seconds: 60, label: '1 perc után' },
	{ seconds: 300, label: '5 perc után' },
	{ seconds: 1800, label: '30 perc után' },
	{ seconds: -1, label: 'Soha (csak újraindításkor)' }
];

interface Settings {
	autoLockSeconds: number;
	lastBackupAt?: number;
}

class Auth {
	phase = $state<Phase>('boot');
	error = $state('');
	autoLockSeconds = $state(60);
	persisted = $state<boolean | null>(null);
	/** Az utolsó JSON-mentés időpontja (epoch ms) – a mentés-emlékeztetőhöz. */
	lastBackupAt = $state<number | null>(null);

	private repo: LedgerRepo | null = null;
	private pin: PinRecord | null = null;
	private hiddenAt: number | null = null;
	private started = false;

	async init() {
		if (this.started) return;
		this.started = true;
		if (!cryptoAvailable()) {
			this.phase = 'unsupported';
			return;
		}
		try {
			const db = await openLedgerDb();
			this.repo = new LedgerRepo(db);
			ledger.attach(this.repo);
			await this.repo.seedDefaultsIfNeeded();
			this.pin = (await this.repo.getMeta<PinRecord>('pin')) ?? null;
			const settings = await this.repo.getMeta<Settings>('settings');
			if (settings) {
				this.autoLockSeconds = settings.autoLockSeconds;
				this.lastBackupAt = settings.lastBackupAt ?? null;
			}
			this.phase = this.pin ? 'locked' : 'setup';
			document.addEventListener('visibilitychange', () => this.onVisibility());
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			this.phase = 'error';
		}
	}

	private onVisibility() {
		if (this.phase !== 'unlocked') return;
		if (document.hidden) {
			this.hiddenAt = Date.now();
			return;
		}
		const away = this.hiddenAt === null ? 0 : Date.now() - this.hiddenAt;
		this.hiddenAt = null;
		if (this.autoLockSeconds >= 0 && away >= this.autoLockSeconds * 1000) this.lock();
	}

	private async afterUnlock() {
		await ledger.load();
		this.phase = 'unlocked';
		// Kérjük a böngészőt, hogy ne törölje az adatokat tárhelyhiány esetén.
		try {
			this.persisted = (await navigator.storage?.persist?.()) ?? null;
		} catch {
			this.persisted = null;
		}
	}

	/** Első indítás: a felhasználó beállítja a saját PIN-jét; opcionálisan példaadatokkal indul. */
	async setup(pin: string, withDemo: boolean): Promise<string | null> {
		const bad = pinFormatError(pin);
		if (bad) return bad;
		try {
			const repo = this.repo!;
			this.pin = await createPinRecord(pin);
			await repo.setMeta('pin', this.pin);
			await ledger.load();
			if (withDemo) await ledger.loadDemoData(todayISO());
			await this.afterUnlock();
			return null;
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	}

	async unlock(pin: string): Promise<{ ok: true } | { ok: false; error: string; retryAt?: number }> {
		const repo = this.repo!;
		const attempts = (await repo.getMeta<PinAttempts>('pinAttempts')) ?? { failures: 0, lockedUntil: 0 };
		const now = Date.now();
		if (attempts.lockedUntil > now) {
			return { ok: false, error: 'Túl sok hibás próba', retryAt: attempts.lockedUntil };
		}
		if (pinFormatError(pin) || !this.pin || !(await verifyPin(pin, this.pin))) {
			const failures = attempts.failures + 1;
			const lockedUntil = lockoutMs(failures) ? Date.now() + lockoutMs(failures) : 0;
			await repo.setMeta<PinAttempts>('pinAttempts', { failures, lockedUntil });
			return {
				ok: false,
				error: lockedUntil ? 'Túl sok hibás próba' : 'Hibás PIN',
				retryAt: lockedUntil || undefined
			};
		}
		await repo.setMeta<PinAttempts>('pinAttempts', { failures: 0, lockedUntil: 0 });
		await this.afterUnlock();
		return { ok: true };
	}

	lock() {
		if (this.phase !== 'unlocked') return;
		ledger.clear();
		this.phase = 'locked';
	}

	async changePin(current: string, next: string): Promise<string | null> {
		if (!this.pin || !(await verifyPin(current, this.pin))) return 'A jelenlegi PIN hibás';
		const bad = pinFormatError(next);
		if (bad) return bad;
		this.pin = await createPinRecord(next);
		await this.repo!.setMeta('pin', this.pin);
		return null;
	}

	private async saveSettings() {
		const s: Settings = { autoLockSeconds: this.autoLockSeconds };
		if (this.lastBackupAt != null) s.lastBackupAt = this.lastBackupAt;
		await this.repo!.setMeta<Settings>('settings', s);
	}

	async setAutoLock(seconds: number) {
		this.autoLockSeconds = seconds;
		await this.saveSettings();
	}

	async markBackup() {
		this.lastBackupAt = Date.now();
		await this.saveSettings();
	}

	/** Minden adat (és a PIN) törlése – az „elfelejtett PIN" és a „mindent töröl" útja. */
	async wipeEverything() {
		const repo = this.repo!;
		await repo.wipeAll();
		ledger.clear();
		this.pin = null;
		this.autoLockSeconds = 60;
		this.lastBackupAt = null;
		await repo.seedDefaultsIfNeeded();
		this.phase = 'setup';
	}
}

export const auth = new Auth();
