<script lang="ts">
	import { AUTO_LOCK_OPTIONS, auth, DEFAULT_REMINDERS, type ReminderSettings } from '$lib/auth.svelte';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import { CURRENCIES, activeCurrency, convertMinor, findCurrency, scaleOf } from '$lib/currency';
	import { transactionsToCsv } from '$lib/csvExport';
	import { isEncryptedBackup, parseBackup } from '$lib/db/backup';
	import { MIN_BACKUP_PASSWORD, decryptBackup, encryptBackup, passwordError } from '$lib/db/crypto';
	import { PIN_MAX, PIN_MIN, pinFormatError } from '$lib/db/pin';
	import { clock } from '$lib/clock.svelte';
	import { canShareFile, downloadText, shareFile } from '$lib/download';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney } from '$lib/money';
	import { href } from '$lib/nav';
	import {
		notificationPermission,
		notificationsSupported,
		requestNotificationPermission,
		showNotification,
		syncPeriodicReminder
	} from '$lib/notify';
	import { SHORTCUT_HELP } from '$lib/shortcuts';
	import { toasts } from '$lib/toast.svelte';
	import type { Backup } from '$lib/types';
	import { shiftMonth } from '$lib/dates';

	// --- PIN módosítása ---
	let curPin = $state('');
	let newPin = $state('');
	let newPin2 = $state('');
	let pinMsg = $state('');
	let pinOk = $state(false);

	async function changePin(e: SubmitEvent) {
		e.preventDefault();
		pinOk = false;
		pinMsg = pinFormatError(newPin) ?? (newPin !== newPin2 ? 'A két új PIN nem egyezik' : '');
		if (pinMsg) return;
		pinMsg = (await auth.changePin(curPin, newPin)) ?? '';
		if (!pinMsg) {
			pinOk = true;
			pinMsg = 'A PIN megváltozott.';
			curPin = newPin = newPin2 = '';
		}
	}

	// --- biztonsági mentés ---
	const backupName = (encrypted: boolean) => `koltsegvetes-mentes-${clock.today}${encrypted ? '-titkositott' : ''}.json`;
	const plainJson = () => JSON.stringify(ledger.exportBackup(), null, 2);

	function exportBackup() {
		downloadText(backupName(false), plainJson(), 'application/json');
		void auth.markBackup();
		toasts.show('Mentés letöltve');
	}

	// Jelszóval védett mentés (AES-256-GCM, a jelszóból PBKDF2-vel képzett kulccsal)
	let encPass = $state('');
	let encPass2 = $state('');
	let encMsg = $state('');
	let encBusy = $state(false);
	let encOpen = $state(false);
	/** Mit csinálunk a titkosított fájllal: letöltés vagy megosztás. */
	async function encrypted(mode: 'download' | 'share') {
		encMsg = passwordError(encPass) ?? (encPass !== encPass2 ? 'A két jelszó nem egyezik' : '');
		if (encMsg) return;
		encBusy = true;
		try {
			const text = await encryptBackup(plainJson(), encPass);
			await deliver(text, true, mode);
			encPass = encPass2 = '';
			encOpen = false;
		} catch (e) {
			encMsg = e instanceof Error ? e.message : 'A titkosítás nem sikerült';
		} finally {
			encBusy = false;
		}
	}

	/** A kész mentés letöltése vagy küldése (telefonon a rendszer megosztó lapja: Drive, e-mail …). */
	async function deliver(text: string, isEncrypted: boolean, mode: 'download' | 'share') {
		const name = backupName(isEncrypted);
		if (mode === 'share') {
			const file = new File([text], name, { type: 'application/json' });
			const r = await shareFile(file, 'Költségvetés – biztonsági mentés');
			if (r === 'cancelled') return;
			if (r === 'unsupported') {
				downloadText(name, text, 'application/json');
				toasts.show('Ezen az eszközön a megosztás nem érhető el – a mentés letöltve');
			} else toasts.show('Mentés elküldve');
		} else {
			downloadText(name, text, 'application/json');
			toasts.show(isEncrypted ? 'Titkosított mentés letöltve' : 'Mentés letöltve');
		}
		void auth.markBackup();
	}
	function shareBackup() {
		void deliver(plainJson(), false, 'share').catch((e) => toasts.error(e instanceof Error ? e.message : 'A megosztás nem sikerült'));
	}
	const canShare = $derived(typeof File !== 'undefined' && canShareFile(new File(['{}'], 'x.json', { type: 'application/json' })));

	let pending = $state<Backup | null>(null);
	let importError = $state('');
	let fileInput: HTMLInputElement;
	/** Jelszót váró titkosított fájl tartalma. */
	let lockedText = $state<string | null>(null);
	let unlockPass = $state('');
	let unlockBusy = $state(false);

	async function onFile(e: Event & { currentTarget: HTMLInputElement }) {
		// Az `await` után az esemény `currentTarget`-je már null, ezért előre eltesszük.
		const input = e.currentTarget;
		const file = input.files?.[0];
		pending = null;
		lockedText = null;
		importError = '';
		if (!file) return;
		if (file.size > 50 * 1024 * 1024) {
			importError = 'A fájl túl nagy';
			input.value = '';
			return;
		}
		const text = await file.text();
		if (isEncryptedBackup(text)) lockedText = text;
		else {
			const r = parseBackup(text);
			if (r.ok) pending = r.backup;
			else importError = r.error;
		}
		input.value = ''; // ugyanaz a fájl újra kiválasztható legyen
	}

	async function unlockBackup() {
		if (!lockedText) return;
		unlockBusy = true;
		importError = '';
		try {
			const d = await decryptBackup(lockedText, unlockPass);
			if (!d.ok) return void (importError = d.error);
			const r = parseBackup(d.json);
			if (!r.ok) return void (importError = r.error);
			pending = r.backup;
			lockedText = null;
			unlockPass = '';
		} finally {
			unlockBusy = false;
		}
	}

	async function restore() {
		if (!pending) return;
		try {
			await ledger.importBackup(pending);
			toasts.show('Biztonsági mentés visszatöltve');
			pending = null;
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'A visszatöltés nem sikerült');
		}
	}

	// --- CSV-export ---
	type Scope = 'all' | 'month' | 'year' | '12m';
	let scope = $state<Scope>('all');
	function exportCsv() {
		const t = clock.today;
		const from = scope === 'month' ? `${t.slice(0, 7)}-01` : scope === 'year' ? `${t.slice(0, 4)}-01-01` : scope === '12m' ? `${shiftMonth(t.slice(0, 7), -11)}-01` : '';
		const rows = ledger.transactions.filter((x) => !from || x.date >= from);
		if (rows.length === 0) return void toasts.show('Nincs exportálható tétel');
		downloadText(`tetelek-${t}.csv`, transactionsToCsv(rows, ledger.categories, ledger.accounts), 'text/csv;charset=utf-8');
		toasts.show(`${rows.length} tétel exportálva`);
	}

	// --- pénznemváltás ---
	const cur = $derived(activeCurrency());
	let targetCode = $state('EUR');
	let rateText = $state('');
	let backupFirst = $state(true);
	let switchBusy = $state(false);
	const target = $derived(findCurrency(targetCode) ?? CURRENCIES[1]);
	/** A természetes felírás: a külföldi pénznem egysége hány forint (ha nincs forint a párban, az új pénznem egysége hány régi). */
	const quoted = $derived(cur.code === 'HUF' ? { unit: target, per: cur, invert: false } : target.code === 'HUF' ? { unit: cur, per: target, invert: true } : { unit: target, per: cur, invert: false });
	const rate = $derived.by(() => {
		const x = Number(rateText.replace(/\s/g, '').replace(',', '.'));
		if (!Number.isFinite(x) || x <= 0) return null;
		return quoted.invert ? 1 / x : x;
	});
	const sample = $derived(rate ? convertMinor(1000 * scaleOf(cur), cur, target, rate) : null);
	$effect(() => {
		if (target.code === cur.code) targetCode = CURRENCIES.find((c) => c.code !== cur.code)!.code;
	});
	async function switchCurrency() {
		if (!rate) return;
		switchBusy = true;
		try {
			if (backupFirst) {
				downloadText(backupName(false), plainJson(), 'application/json');
				void auth.markBackup();
			}
			await ledger.switchCurrency(target.code, rate);
			toasts.show(`Pénznem átváltva: ${target.code}`);
			rateText = '';
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Az átváltás nem sikerült');
		} finally {
			switchBusy = false;
		}
	}

	// --- emlékeztetők ---
	const perm = $derived(notificationPermission());
	async function saveReminders(next: ReminderSettings) {
		await auth.setReminders(next);
		void syncPeriodicReminder(next.enabled && !!next.dailyTime);
	}
	async function toggleReminders(e: Event & { currentTarget: HTMLInputElement }) {
		const on = e.currentTarget.checked;
		if (on) {
			const p = await requestNotificationPermission();
			if (p !== 'granted') {
				e.currentTarget.checked = false;
				toasts.error(p === 'unsupported' ? 'Ez a böngésző nem támogatja az értesítéseket' : 'Az értesítések le vannak tiltva – engedélyezd a böngésző beállításaiban');
				return;
			}
		}
		await saveReminders({ ...auth.reminders, enabled: on });
	}
	async function testNotification() {
		const ok = await showNotification('Költségvetés', 'Így fognak kinézni az emlékeztetők.', 'test');
		if (!ok) toasts.error('Az értesítés nem jeleníthető meg');
	}

	async function loadDemo() {
		const n = await ledger.loadDemoData(clock.today);
		toasts.show(n ? `${n} példatétel betöltve` : 'A példaadatokhoz kellenek az alap számlák és kategóriák');
	}
	async function removeDemo() {
		const n = await ledger.removeDemoData();
		toasts.show(`${n} példatétel törölve`);
	}

	const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('hu-HU');
</script>

<svelte:head><title>Beállítások · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Beállítások</h1></div>

	<section class="card stack" aria-labelledby="sec-security">
		<h2 id="sec-security">Biztonság</h2>
		<div class="field">
			<label for="autolock">Automatikus zárolás</label>
			<select id="autolock" value={auth.autoLockSeconds} onchange={(e) => auth.setAutoLock(Number(e.currentTarget.value))}>
				{#each AUTO_LOCK_OPTIONS as o}
					<option value={o.seconds}>{o.label}</option>
				{/each}
			</select>
			<p class="hint">Az app háttérbe kerülése vagy a lap elhagyása után ennyi idővel kér újra PIN-t.</p>
		</div>
		<button class="btn" type="button" onclick={() => auth.lock()}>Zárolás most</button>

		<hr />
		<form class="stack" onsubmit={changePin}>
			<h3>PIN módosítása</h3>
			<div class="field">
				<label for="cur">Jelenlegi PIN</label>
				<input id="cur" type="password" inputmode="numeric" pattern="[0-9]*" maxlength={PIN_MAX} autocomplete="current-password" bind:value={curPin} />
			</div>
			<div class="field">
				<label for="new">Új PIN ({PIN_MIN}–{PIN_MAX} számjegy)</label>
				<input id="new" type="password" inputmode="numeric" pattern="[0-9]*" maxlength={PIN_MAX} autocomplete="new-password" bind:value={newPin} />
			</div>
			<div class="field">
				<label for="new2">Új PIN újra</label>
				<input id="new2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength={PIN_MAX} autocomplete="new-password" bind:value={newPin2} />
			</div>
			{#if pinMsg}<p class={pinOk ? 'inc' : 'error'} role="alert">{pinMsg}</p>{/if}
			<button class="btn primary" type="submit" disabled={!curPin || !newPin}>PIN módosítása</button>
		</form>
		<p class="hint">
			A PIN alkalmazászár: megakadályozza, hogy más belenézzen az appba, de az adatok a böngészőben
			titkosítatlanul tárolódnak. Az eszköz zárolása és a böngészőprofil védelme továbbra is fontos.
			A jelszóval védett mentés viszont valóban titkosított fájl.
		</p>
	</section>

	<section class="card stack" aria-labelledby="sec-data">
		<h2 id="sec-data">Adatok és biztonsági mentés</h2>
		<p class="muted">
			Az adataid csak ezen az eszközön, ebben a böngészőben vannak. Ha törlöd a böngészőadatokat vagy
			új telefonra váltasz, a JSON-mentés az egyetlen módja a visszaállításnak.
		</p>
		<p class="small">
			Utolsó mentés:
			<strong>{auth.lastBackupAt ? fmtDate(auth.lastBackupAt) : 'még nem volt'}</strong>
			· Tartós tárhely:
			<strong>{auth.persisted === null ? 'ismeretlen' : auth.persisted ? 'igen' : 'nem (a böngésző szükség esetén törölheti)'}</strong>
		</p>
		<div class="row wrap">
			<button class="btn primary" type="button" onclick={exportBackup}>Mentés letöltése (JSON)</button>
			{#if canShare}
				<button class="btn" type="button" onclick={shareBackup}>Mentés küldése…</button>
			{/if}
			<button class="btn" type="button" aria-expanded={encOpen} onclick={() => (encOpen = !encOpen)}>Jelszóval védett mentés…</button>
			<button class="btn" type="button" onclick={() => fileInput.click()}>Mentés visszatöltése…</button>
			<input bind:this={fileInput} type="file" accept="application/json,.json" onchange={onFile} class="sr-only" tabindex="-1" aria-label="Mentésfájl kiválasztása" />
		</div>
		{#if canShare}
			<p class="hint">A „Mentés küldése" a telefon megosztó lapját nyitja meg: egy lépésben Drive-ra, e-mailbe vagy üzenetbe küldheted a fájlt.</p>
		{/if}

		{#if encOpen}
			<div class="notice stack" data-testid="encrypted-backup">
				<div class="field">
					<label for="enc1">Jelszó a mentéshez (legalább {MIN_BACKUP_PASSWORD} karakter)</label>
					<input id="enc1" type="password" autocomplete="new-password" bind:value={encPass} />
				</div>
				<div class="field">
					<label for="enc2">Jelszó újra</label>
					<input id="enc2" type="password" autocomplete="new-password" bind:value={encPass2} />
				</div>
				{#if encMsg}<p class="error" role="alert">{encMsg}</p>{/if}
				<p class="hint">
					A fájl AES-256-GCM-mel titkosított, a kulcsot a jelszóból képezzük (PBKDF2). <strong>A jelszót nem tárolja senki:</strong> ha elfelejted, a mentés nem nyitható meg.
				</p>
				<div class="row wrap">
					<button class="btn primary" type="button" disabled={encBusy} onclick={() => encrypted('download')}>Titkosított mentés letöltése</button>
					{#if canShare}<button class="btn" type="button" disabled={encBusy} onclick={() => encrypted('share')}>Titkosított mentés küldése…</button>{/if}
				</div>
			</div>
		{/if}

		{#if importError}<p class="error" role="alert">{importError}</p>{/if}
		{#if lockedText}
			<div class="notice stack" role="alert" data-testid="unlock-backup">
				<p>Ez a mentés jelszóval védett. Add meg a jelszót a megnyitásához.</p>
				<div class="row">
					<input type="password" autocomplete="current-password" aria-label="A mentés jelszava" bind:value={unlockPass}
						onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), unlockBackup())} />
					<button class="btn primary" type="button" disabled={unlockBusy || !unlockPass} onclick={unlockBackup}>Feloldás</button>
				</div>
			</div>
		{/if}
		{#if pending}
			<div class="notice warn stack" role="alert">
				<p>
					A fájl: <strong>{pending.transactions.length} tétel</strong>, {pending.categories.length} kategória,
					{pending.accounts.length} számla{pending.recurring.length ? `, ${pending.recurring.length} ismétlődő tétel` : ''}{pending.templates.length ? `, ${pending.templates.length} sablon` : ''}{pending.goals.length ? `, ${pending.goals.length} cél` : ''}
					(pénznem: {pending.prefs.currency}; mentve: {new Date(pending.exportedAt).toLocaleString('hu-HU')}).
					A visszatöltés <strong>felülírja a mostani adatokat</strong>.
				</p>
				<div class="row wrap">
					<ConfirmButton label="Visszatöltés" question="Felülírja a mostani adatokat!" confirmLabel="Igen, visszatöltöm" onconfirm={restore} />
					<button class="btn small" type="button" onclick={() => (pending = null)}>Mégse</button>
				</div>
			</div>
		{/if}
	</section>

	<section class="card stack" aria-labelledby="sec-csv">
		<h2 id="sec-csv">CSV-export és -import (Excel)</h2>
		<p class="muted">A tételek táblázatként Excelbe (pontosvesszős, UTF-8 CSV). Az import párja a <a href={href('/import')}>CSV-import</a> oldal.</p>
		<div class="row wrap">
			<select bind:value={scope} aria-label="Exportálandó időszak" style="width:auto">
				<option value="all">Minden tétel</option>
				<option value="month">Ez a hónap</option>
				<option value="year">Ez az év</option>
				<option value="12m">Elmúlt 12 hónap</option>
			</select>
			<button class="btn primary" type="button" onclick={exportCsv}>Exportálás (CSV)</button>
			<a class="btn" href={href('/import')}>Importálás…</a>
		</div>
	</section>

	<section class="card stack" aria-labelledby="sec-currency">
		<h2 id="sec-currency">Pénznem</h2>
		<p>Jelenlegi pénznem: <strong>{cur.name} ({cur.code}, {cur.symbol})</strong></p>
		<p class="hint">
			A pénznem átváltásakor az összes összeg (tételek, egyenlegek, keretek, célok, ismétlődők) az általad megadott árfolyammal
			átszámolódik. Ez a kerekítés miatt nem tökéletesen visszafordítható, ezért előtte mentés készül.
		</p>
		<div class="field">
			<label for="cur-target">Átváltás erre</label>
			<select id="cur-target" bind:value={targetCode}>
				{#each CURRENCIES.filter((c) => c.code !== cur.code) as c}<option value={c.code}>{c.name} ({c.code})</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="cur-rate">Árfolyam: 1 {quoted.unit.code} = ? {quoted.per.code}</label>
			<input id="cur-rate" type="text" inputmode="decimal" autocomplete="off" placeholder={quoted.per.code === 'HUF' ? 'pl. 395' : 'pl. 1,08'} bind:value={rateText} />
			{#if sample !== null}
				<p class="hint">Például: {formatMoney(1000 * scaleOf(cur))} → <strong>{(() => { const f = findCurrency(target.code)!; return `${new Intl.NumberFormat('hu-HU', { minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals }).format(sample / scaleOf(f))} ${f.symbol}`; })()}</strong></p>
			{/if}
		</div>
		<label class="row"><input type="checkbox" bind:checked={backupFirst} /> Mentés letöltése az átváltás előtt (ajánlott)</label>
		<div>
			<ConfirmButton
				label="Pénznem átváltása"
				question={`Minden összeg átszámolódik (${cur.code} → ${target.code}).`}
				confirmLabel="Igen, átváltom"
				small={false}
				onconfirm={async () => {
					if (rate && !switchBusy) await switchCurrency();
					else toasts.error('Add meg az árfolyamot');
				}}
			/>
		</div>
	</section>

	<section class="card stack" aria-labelledby="sec-remind">
		<h2 id="sec-remind">Emlékeztetők</h2>
		{#if perm === 'unsupported'}
			<p class="muted">Ez a böngésző nem támogatja az értesítéseket.</p>
		{:else}
			<label class="row">
				<input type="checkbox" checked={auth.reminders.enabled} onchange={toggleReminders} /> Emlékeztető-értesítések bekapcsolása
			</label>
			{#if perm === 'denied'}<p class="error">Az értesítések le vannak tiltva a böngészőben; engedélyezd az oldal beállításaiban.</p>{/if}
			{#if auth.reminders.enabled}
				<div class="field">
					<label for="daily-time">Napi emlékeztető ideje (üresen: nincs)</label>
					<input id="daily-time" type="time" value={auth.reminders.dailyTime ?? ''} onchange={(e) => saveReminders({ ...auth.reminders, dailyTime: e.currentTarget.value || null })} />
					<p class="hint">„Ne felejtsd rögzíteni a mai kiadásaidat" – ha aznap még nincs tételed.</p>
				</div>
				<label class="row"><input type="checkbox" checked={auth.reminders.due} onchange={(e) => saveReminders({ ...auth.reminders, due: e.currentTarget.checked })} /> Esedékes ismétlődő tételek</label>
				<label class="row"><input type="checkbox" checked={auth.reminders.budget} onchange={(e) => saveReminders({ ...auth.reminders, budget: e.currentTarget.checked })} /> Havi keret 80% / 100% átlépése</label>
				<label class="row"><input type="checkbox" checked={auth.reminders.backup} onchange={(e) => saveReminders({ ...auth.reminders, backup: e.currentTarget.checked })} /> Régen volt biztonsági mentés</label>
				<div><button class="btn small" type="button" onclick={testNotification}>Próba értesítés</button></div>
			{/if}
			<p class="hint">
				Szerver nincs, ezért az értesítések helyiek: akkor érkeznek, ha az app (akár háttérben) fut. Chromium alapú, telepített
				appnál a napi emlékeztetőt a böngésző időnként akkor is elküldheti, ha az app zárva van. iOS-en ez korlátozott. Az értesítések
				szövege nem tartalmaz összegeket. Az alapértelmezett idő: {DEFAULT_REMINDERS.dailyTime}.
			</p>
		{/if}
	</section>

	<section class="card stack" aria-labelledby="sec-keys">
		<h2 id="sec-keys">Billentyűparancsok</h2>
		<details class="more">
			<summary>Lista megnyitása (vagy nyomd meg a ? gombot)</summary>
			<dl class="key-list">
				{#each SHORTCUT_HELP as k}<dt><kbd>{k.keys}</kbd></dt><dd>{k.label}</dd>{/each}
			</dl>
		</details>
	</section>

	<section class="card stack" aria-labelledby="sec-demo">
		<h2 id="sec-demo">Példaadatok</h2>
		{#if ledger.hasDemo}
			<p class="muted">Kitalált tételek vannak az appban a kipróbáláshoz. A saját tételeid megmaradnak.</p>
			<div><ConfirmButton label="Példaadatok törlése" question="Csak a példatételek törlődnek." confirmLabel="Igen, törlöm" small={false} onconfirm={removeDemo} /></div>
		{:else}
			<p class="muted">Töltsd be kipróbálásra az elmúlt 2–3 hónap kitalált tételeit – később egy gombbal törölhetők.</p>
			<div><button class="btn" type="button" onclick={loadDemo}>Példaadatok betöltése</button></div>
		{/if}
	</section>

	<section class="card stack" aria-labelledby="sec-danger">
		<h2 id="sec-danger">Veszélyes zóna</h2>
		<p class="muted">Minden tétel, kategória, számla és a PIN végleg törlődik az eszközről, az app újra az első indítási képernyővel indul.</p>
		<div>
			<ConfirmButton label="Minden adat törlése" question="Ez nem vonható vissza!" confirmLabel="Igen, mindent törlök" small={false} onconfirm={() => auth.wipeEverything()} />
		</div>
	</section>

	<p class="hint center">Költségvetés-követő · offline, szerver nélkül működő PWA</p>
</div>

<style>
	.key-list {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px 14px;
		margin: 10px 0 0;
		align-items: center;
	}
	.key-list dd {
		margin: 0;
	}
</style>
