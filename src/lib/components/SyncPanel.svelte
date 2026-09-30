<script lang="ts">
	import { clock } from '$lib/clock.svelte';
	import { MIN_BACKUP_PASSWORD, passwordError } from '$lib/db/crypto';
	import { downloadText } from '$lib/download';
	import { sync, type ConnectResult } from '$lib/sync/engine.svelte';
	import { downloadLostBackup } from '$lib/sync/notify';
	import type { ProviderId } from '$lib/sync/provider';
	import { toasts } from '$lib/toast.svelte';
	import ConfirmButton from './ConfirmButton.svelte';

	const providers = sync.availableProviders();
	const BUTTON_LABEL: Record<ProviderId, string> = {
		gdrive: 'Bejelentkezés Google-fiókkal',
		dropbox: 'Csatlakozás Dropboxszal',
		memory: 'Memória-szolgáltató (teszt)'
	};

	let busy = $state(false);
	let error = $state('');
	let password = $state('');
	let password2 = $state('');
	let unencrypted = $state(false);
	/** Mindkét oldalon van saját adat: a felhasználónak kell döntenie. */
	let choice = $state<Extract<ConnectResult, { code: 'needsChoice' }> | null>(null);

	// A jelszó módosítása és a hibás jelszó javítása
	let changeOpen = $state(false);
	let newPw = $state('');
	let newPw2 = $state('');
	let changeMsg = $state('');
	let retryPw = $state('');
	let retryMsg = $state('');

	const probe = $derived(sync.probe);
	/** Új jelszót kell kitalálni (nincs még fájl, vagy a meglévő titkosítatlan), nem egy meglévőt megadni. */
	const creating = $derived(!!probe && (!probe.remote.exists || !probe.remote.encrypted));

	async function begin(id: ProviderId) {
		busy = true;
		error = '';
		try {
			// A gomb közvetlen hívása: a bejelentkező ablak csak felhasználói gesztusból nyílik meg.
			await sync.beginConnect(id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'A bejelentkezés nem sikerült';
		} finally {
			busy = false;
		}
	}

	async function cancel() {
		await sync.cancelConnect();
		password = password2 = '';
		choice = null;
		error = '';
	}

	async function connect(pick?: 'remote' | 'merge') {
		if (!probe) return;
		error = '';
		if (creating && !unencrypted) {
			error = passwordError(password) ?? (password !== password2 ? 'A két jelszó nem egyezik' : '');
			if (error) return;
		}
		busy = true;
		try {
			const r = await sync.completeConnect({
				password,
				unencrypted: creating && unencrypted,
				choice: pick,
				// A felhőbeli adatok használata előtt a helyi adatok mentése letöltődik.
				beforeOverwrite: (json) => downloadText(`koltsegvetes-mentes-${clock.today}-szinkron-elott.json`, json, 'application/json')
			});
			if (r.ok) {
				password = password2 = '';
				choice = null;
				toasts.show('A szinkron be van kapcsolva');
			} else if (r.code === 'needsChoice') choice = r;
			else error = r.error;
		} finally {
			busy = false;
		}
	}

	async function syncNow() {
		busy = true;
		try {
			await sync.syncNow();
		} finally {
			busy = false;
		}
	}

	async function changePassword() {
		changeMsg = passwordError(newPw) ?? (newPw !== newPw2 ? 'A két jelszó nem egyezik' : '');
		if (changeMsg) return;
		busy = true;
		try {
			const r = await sync.changePassword(newPw);
			if (r.ok) {
				toasts.show('A szinkronjelszó megváltozott – a többi eszközön újra meg kell adni');
				newPw = newPw2 = '';
				changeOpen = false;
			} else changeMsg = r.error;
		} finally {
			busy = false;
		}
	}

	async function retryPassword() {
		retryMsg = '';
		busy = true;
		try {
			const r = await sync.retryPassword(retryPw);
			if (r.ok) retryPw = '';
			else retryMsg = r.error;
		} finally {
			busy = false;
		}
	}

	async function disconnect() {
		await sync.disconnect();
		toasts.show('Kijelentkeztél a szinkronból – a felhőben lévő adatok megmaradtak');
	}

	async function deleteCloud() {
		try {
			await sync.deleteCloudData();
			toasts.show('A felhőben tárolt adatok törölve, a szinkron kikapcsolt');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'A törlés nem sikerült');
		}
	}

	const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString('hu-HU') : 'még nem volt');
	const statusText = $derived(
		sync.status === 'syncing'
			? 'Szinkronizálás…'
			: sync.status === 'paused'
				? 'Szünetel – koppints a „Szinkron most" gombra a folytatáshoz'
				: sync.status === 'error'
					? sync.error
					: sync.pendingLocalChanges
						? 'Feltöltésre váró módosítások vannak'
						: 'Szinkronban'
	);
</script>

<section class="card stack" aria-labelledby="sec-sync" id="sync">
	<h2 id="sec-sync">Szinkronizálás</h2>

	{#if sync.connected}
		<!-- ===== bekapcsolt állapot ===== -->
		<p>
			Csatlakoztatva: <strong>{sync.providerLabel}</strong> · <strong>{sync.account}</strong>
		</p>
		<p class="small" data-testid="sync-status" data-status={sync.status}>
			Állapot: <strong class:error={sync.status === 'error' && sync.errorKind !== 'network'}>{statusText}</strong>
			<br />
			Utolsó szinkron: <strong>{when(sync.lastSyncAt)}</strong>
			· {sync.encrypted ? 'a felhőben titkosított fájl van' : 'titkosítás nélkül'}
		</p>

		{#if sync.errorKind === 'password'}
			<div class="notice warn stack" role="alert" data-testid="sync-password-retry">
				<p>A szinkronjelszó hibás vagy hiányzik ezen az eszközön (másik eszközön megváltozhatott). Add meg az aktuális jelszót.</p>
				<div class="row">
					<input type="password" autocomplete="current-password" aria-label="Szinkronjelszó" bind:value={retryPw}
						onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), retryPassword())} />
					<button class="btn primary" type="button" disabled={busy || !retryPw} onclick={retryPassword}>Folytatás</button>
				</div>
				{#if retryMsg}<p class="error" role="alert">{retryMsg}</p>{/if}
			</div>
		{/if}

		{#if sync.lostBackup}
			<div class="notice warn stack" role="alert" data-testid="sync-lost-backup">
				<p>
					Egy másik eszközön pénznemet váltottak vagy mentést töltöttek vissza, ezért az itteni, még nem szinkronizált módosítások
					elvesztek. Az előző állapotról ({when(sync.lostBackup.at)}) mentés maradt.
				</p>
				<div class="row wrap">
					<button class="btn primary" type="button" onclick={downloadLostBackup}>Mentés letöltése</button>
					<button class="btn" type="button" onclick={() => sync.clearLostBackup()}>Elvetés</button>
				</div>
			</div>
		{/if}

		<div class="row wrap">
			<button class="btn primary" type="button" disabled={busy || sync.status === 'syncing'} onclick={syncNow}>Szinkron most</button>
			{#if sync.encrypted}
				<button class="btn" type="button" aria-expanded={changeOpen} onclick={() => (changeOpen = !changeOpen)}>Szinkronjelszó cseréje…</button>
			{/if}
			<ConfirmButton label="Kijelentkezés" question="A szinkron leáll ezen az eszközön; a felhőben lévő adatok megmaradnak." confirmLabel="Igen, kijelentkezem" small={false} onconfirm={disconnect} />
		</div>

		{#if changeOpen}
			<div class="notice stack">
				<div class="field">
					<label for="sync-new1">Új szinkronjelszó (legalább {MIN_BACKUP_PASSWORD} karakter)</label>
					<input id="sync-new1" type="password" autocomplete="new-password" bind:value={newPw} />
				</div>
				<div class="field">
					<label for="sync-new2">Új jelszó újra</label>
					<input id="sync-new2" type="password" autocomplete="new-password" bind:value={newPw2} />
				</div>
				{#if changeMsg}<p class="error" role="alert">{changeMsg}</p>{/if}
				<p class="hint">A felhőfájl azonnal újratitkosítódik. A többi eszköz a következő szinkronnál „Hibás szinkronjelszó" üzenetet kap, és az újat kell megadni rajta.</p>
				<div><button class="btn primary" type="button" disabled={busy} onclick={changePassword}>Jelszó módosítása</button></div>
			</div>
		{/if}

		<hr />
		<div class="stack">
			<h3>Felhőben tárolt adatok</h3>
			<p class="hint">A kijelentkezés a felhőben lévő fájlt nem törli. Ha véglegesen meg akarod szüntetni a szinkront, a fájlt itt törölheted.</p>
			<div><ConfirmButton label="Felhőben tárolt adatok törlése" question="A szinkronfájl végleg törlődik, a szinkron kikapcsol." confirmLabel="Igen, törlöm" small={false} onconfirm={deleteCloud} /></div>
		</div>
	{:else if probe}
		<!-- ===== a bejelentkezés kész, a jelszó / döntés még hátravan ===== -->
		<p>Bejelentkezve: <strong>{probe.account}</strong></p>
		{#if choice}
			<div class="notice warn stack" role="alert" data-testid="sync-choice">
				<p>
					Mindkét oldalon vannak adatok: itt <strong>{choice.local.transactions} saját tétel</strong>, a felhőben
					<strong>{choice.remote.transactions} tétel</strong>. Mit szeretnél?
				</p>
				<div class="stack">
					<button class="btn primary" type="button" disabled={busy} onclick={() => connect('merge')}>Összefésülés (mindkét oldal adatai megmaradnak)</button>
					<button class="btn danger" type="button" disabled={busy} onclick={() => connect('remote')}>A felhőben lévő adatok használata (az itteniek törlődnek)</button>
					<button class="btn" type="button" disabled={busy} onclick={cancel}>Mégse</button>
				</div>
				<p class="hint">A felhőbeli adatok használata előtt az itteni adatokról automatikusan mentés töltődik le.</p>
			</div>
		{:else}
			{#if probe.remote.exists && probe.remote.encrypted}
				<p class="muted">A felhőben már van szinkronfájl (egy másik eszközről). Add meg az ott beállított szinkronjelszót.</p>
				<div class="field">
					<label for="sync-pw">Szinkronjelszó</label>
					<input id="sync-pw" type="password" autocomplete="current-password" bind:value={password}
						onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), connect())} />
				</div>
			{:else}
				<p class="muted">
					{probe.remote.exists ? 'A felhőben titkosítatlan szinkronfájl van.' : 'A felhőben még nincs szinkronfájl.'}
					A fájl titkosítva tárolódik, a jelszót eszközönként egyszer kell megadni. Ha elfelejted, a felhőbeli adatok nem nyithatók meg.
				</p>
				<label class="row"><input type="checkbox" bind:checked={unencrypted} /> Titkosítás nélkül (nem ajánlott)</label>
				{#if unencrypted}
					<p class="notice warn" role="alert">A felhőben lévő fájl bárki számára olvasható lesz, aki hozzáfér a tárhelyedhez (például a szolgáltató).</p>
				{:else}
					<div class="field">
						<label for="sync-pw">Szinkronjelszó (legalább {MIN_BACKUP_PASSWORD} karakter)</label>
						<input id="sync-pw" type="password" autocomplete="new-password" bind:value={password} />
					</div>
					<div class="field">
						<label for="sync-pw2">Jelszó újra</label>
						<input id="sync-pw2" type="password" autocomplete="new-password" bind:value={password2} />
					</div>
				{/if}
			{/if}
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="row wrap">
				<button class="btn primary" type="button" disabled={busy} onclick={() => connect()}>Csatlakozás</button>
				<button class="btn" type="button" disabled={busy} onclick={cancel}>Mégse</button>
			</div>
		{/if}
	{:else}
		<!-- ===== kikapcsolt állapot ===== -->
		<p class="muted">
			Az adataid a saját Google Drive-odra vagy Dropbox-odra kerülhetnek, titkosítva, így a laptopod és a telefonod szinkronban marad.
			Nincs hozzá szerver: az app továbbra is offline is működik, a szinkron csak egy opcionális réteg.
		</p>
		{#if providers.length > 0}
			<div class="row wrap">
				{#each providers as p, i}
					<button class="btn" class:primary={i === 0} type="button" disabled={busy} onclick={() => begin(p.id)} data-provider={p.id}>{BUTTON_LABEL[p.id]}</button>
				{/each}
			</div>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
		{:else}
			<p class="notice" data-testid="sync-unconfigured">
				A szinkron használatához a buildben be kell állítani a Google kliens-azonosítót (<code>GOOGLE_CLIENT_ID</code>) vagy a
				Dropbox app kulcsát (<code>DROPBOX_APP_KEY</code>). A lépéseket a README „Szinkronizálás" fejezete írja le.
			</p>
		{/if}
	{/if}

	<p class="hint">
		A működő szinkron egyben mentésnek számít: amíg fut, a „régen volt mentés" emlékeztető nem jelenik meg. A JSON-mentés
		ettől függetlenül érdemes időnként, mert a szinkron nem visszavonható archívum.
	</p>
</section>
