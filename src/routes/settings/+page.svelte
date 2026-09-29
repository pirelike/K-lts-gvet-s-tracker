<script lang="ts">
	import { AUTO_LOCK_OPTIONS, auth } from '$lib/auth.svelte';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import { parseBackup } from '$lib/db/backup';
	import { PIN_MAX, PIN_MIN, pinFormatError } from '$lib/db/pin';
	import { todayISO } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { toasts } from '$lib/toast.svelte';
	import type { Backup } from '$lib/types';

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
	function exportBackup() {
		const blob = new Blob([JSON.stringify(ledger.exportBackup(), null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `koltsegvetes-mentes-${todayISO()}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
		void auth.markBackup();
		toasts.show('Mentés letöltve');
	}

	let pending = $state<Backup | null>(null);
	let importError = $state('');
	let fileInput: HTMLInputElement;

	async function onFile(e: Event & { currentTarget: HTMLInputElement }) {
		// Az `await` után az esemény `currentTarget`-je már null, ezért előre eltesszük.
		const input = e.currentTarget;
		const file = input.files?.[0];
		pending = null;
		importError = '';
		if (!file) return;
		if (file.size > 50 * 1024 * 1024) {
			importError = 'A fájl túl nagy';
			input.value = '';
			return;
		}
		const r = parseBackup(await file.text());
		if (r.ok) pending = r.backup;
		else importError = r.error;
		input.value = ''; // ugyanaz a fájl újra kiválasztható legyen
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

	async function loadDemo() {
		const n = await ledger.loadDemoData(todayISO());
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
			<button class="btn" type="button" onclick={() => fileInput.click()}>Mentés visszatöltése…</button>
			<input bind:this={fileInput} type="file" accept="application/json,.json" onchange={onFile} class="sr-only" tabindex="-1" aria-label="Mentésfájl kiválasztása" />
		</div>
		{#if importError}<p class="error" role="alert">{importError}</p>{/if}
		{#if pending}
			<div class="notice warn stack" role="alert">
				<p>
					A fájl: <strong>{pending.transactions.length} tétel</strong>, {pending.categories.length} kategória,
					{pending.accounts.length} számla (mentve: {new Date(pending.exportedAt).toLocaleString('hu-HU')}).
					A visszatöltés <strong>felülírja a mostani adatokat</strong>.
				</p>
				<div class="row wrap">
					<ConfirmButton label="Visszatöltés" question="Felülírja a mostani adatokat!" confirmLabel="Igen, visszatöltöm" onconfirm={restore} />
					<button class="btn small" type="button" onclick={() => (pending = null)}>Mégse</button>
				</div>
			</div>
		{/if}
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
