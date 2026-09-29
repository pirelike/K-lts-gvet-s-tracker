/**
 * Emlékeztető-értesítések. Szerver nincs, ezért csak helyi értesítések lehetségesek:
 * - amíg az app (akár háttérben) fut, egy percenként ellenőrizzük, mi esedékes;
 * - Chromium alapú, telepített PWA-nál a service worker időszakos szinkronja (periodicsync)
 *   a napi emlékeztetőt akkor is elküldi, ha az app nincs megnyitva (a böngésző dönti el, mikor).
 * iOS-en és zárt appnál az értesítések megbízhatatlanok – ez a böngészők korlátja, nem az appé.
 * Az értesítések szövege általános, összeget nem tartalmaz.
 */
import { auth, type ReminderSettings } from './auth.svelte';
import { budgetLines, totalBudgetLine } from './budget';
import { clock } from './clock.svelte';
import { ledger } from './ledger.svelte';

const DAY = 86_400_000;

export function notificationsSupported(): boolean {
	return typeof Notification !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
	return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
	if (!notificationsSupported()) return 'unsupported';
	try {
		return await Notification.requestPermission();
	} catch {
		return Notification.permission;
	}
}

/** Értesítés megjelenítése (a service workeren át, mert Androidon a `new Notification` nem működik). */
export async function showNotification(title: string, body: string, tag: string): Promise<boolean> {
	if (notificationPermission() !== 'granted') return false;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		if (reg) {
			await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
			return true;
		}
		new Notification(title, { body, tag });
		return true;
	} catch {
		return false;
	}
}

/** Időszakos háttérszinkron be/ki a napi emlékeztetőhöz (csak ahol a böngésző támogatja). */
export async function syncPeriodicReminder(enabled: boolean): Promise<void> {
	try {
		const reg = (await navigator.serviceWorker?.getRegistration()) as
			| (ServiceWorkerRegistration & { periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void>; unregister(tag: string): Promise<void> } })
			| undefined;
		if (!reg?.periodicSync) return;
		if (enabled) await reg.periodicSync.register('daily-reminder', { minInterval: 12 * 3_600_000 });
		else await reg.periodicSync.unregister('daily-reminder');
	} catch {
		/* nem támogatott vagy nincs engedély – az oldal-időzítő marad */
	}
}

/** „HH:MM" → perc éjfél óta; érvénytelen esetén null. */
export function minutesOfDay(time: string | null): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h < 24 && min < 60 ? h * 60 + min : null;
}

export interface Reminder {
	key: string;
	title: string;
	body: string;
}

/**
 * Melyik emlékeztetők esedékesek most. Tiszta függvény a tesztelhetőségért: az állapotot és a
 * már elküldött kulcsokat paraméterként kapja.
 */
export function dueReminders(input: {
	settings: ReminderSettings;
	now: Date;
	today: string;
	/** Van-e már mai tétel (ha igen, a napi emlékeztető felesleges); null = nem tudjuk (zárolt). */
	hasTxToday: boolean | null;
	dueCount: number;
	budgetAlerts: { key: string; name: string; over: boolean }[];
	needsBackup: boolean;
	sent: ReadonlySet<string>;
}): Reminder[] {
	const { settings, sent, today } = input;
	if (!settings.enabled) return [];
	const out: Reminder[] = [];
	const at = minutesOfDay(settings.dailyTime);
	const nowMin = input.now.getHours() * 60 + input.now.getMinutes();
	if (at !== null && nowMin >= at && input.hasTxToday !== true && !sent.has(`daily:${today}`)) {
		out.push({ key: `daily:${today}`, title: 'Költségvetés', body: 'Ne felejtsd rögzíteni a mai kiadásaidat.' });
	}
	if (settings.due && input.dueCount > 0 && !sent.has(`due:${today}:${input.dueCount}`)) {
		out.push({
			key: `due:${today}:${input.dueCount}`,
			title: 'Esedékes tételek',
			body: `${input.dueCount} ismétlődő tétel vár jóváhagyásra.`
		});
	}
	if (settings.budget) {
		for (const a of input.budgetAlerts) {
			if (sent.has(a.key)) continue;
			out.push({
				key: a.key,
				title: a.over ? 'Túllépted a havi keretet' : 'Közel a havi kerethez',
				body: a.over ? `${a.name}: a havi keret elfogyott.` : `${a.name}: a havi keret 80%-át elérted.`
			});
		}
	}
	if (settings.backup && input.needsBackup && !sent.has(`backup:${today.slice(0, 7)}`)) {
		out.push({ key: `backup:${today.slice(0, 7)}`, title: 'Biztonsági mentés', body: 'Régen nem készült mentés az adataidról.' });
	}
	return out;
}

/** Az appban futó ellenőrzés: háttérben lévő oldalon elküldi a még nem jelzett emlékeztetőket. */
export async function runReminderChecks(now: Date = new Date()): Promise<void> {
	if (!auth.reminders.enabled || notificationPermission() !== 'granted') return;
	// Előtérben az app maga mutat mindent (szalagok, lista), oda felesleges az értesítés.
	if (typeof document !== 'undefined' && !document.hidden) return;
	const today = clock.today;
	const month = today.slice(0, 7);
	const unlocked = ledger.loaded;
	const alerts: { key: string; name: string; over: boolean }[] = [];
	let hasTxToday: boolean | null = null;
	let needsBackup = false;
	if (unlocked) {
		hasTxToday = ledger.transactions.some((t) => t.date === today);
		const lines = budgetLines(ledger.transactions, ledger.categories, month);
		const total = totalBudgetLine(ledger.transactions, month, ledger.prefs.totalBudget);
		for (const l of [...lines, ...(total ? [total] : [])]) {
			if (l.level === 'ok') continue;
			alerts.push({ key: `budget:${month}:${l.categoryId ?? 'total'}:${l.level}`, name: l.name, over: l.level === 'over' });
		}
		const own = ledger.transactions.filter((t) => !t.demo).length;
		needsBackup = own >= 20 && (auth.lastBackupAt === null || now.getTime() - auth.lastBackupAt > 30 * DAY);
	}
	const sent = await auth.notifiedKeys();
	const list = dueReminders({
		settings: auth.reminders,
		now,
		today,
		hasTxToday,
		dueCount: unlocked ? ledger.due.length : 0,
		budgetAlerts: alerts,
		needsBackup,
		sent
	});
	if (list.length === 0) return;
	for (const r of list) {
		if (await showNotification(r.title, r.body, r.key)) sent.add(r.key);
	}
	// A régi hónapok kulcsai kihullanak (a lista mérete korlátos).
	await auth.rememberNotified(sent);
}
