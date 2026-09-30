<script lang="ts">
	import { auth } from '$lib/auth.svelte';
	import { PIN_MAX, PIN_MIN, pinFormatError } from '$lib/db/pin';
	import { go } from '$lib/nav';
	import { sync } from '$lib/sync/engine.svelte';
	import type { ProviderId } from '$lib/sync/provider';
	import AppLogo from './AppLogo.svelte';

	const providers = sync.availableProviders();
	const LABEL: Record<ProviderId, string> = {
		gdrive: 'Csatlakozás Google-lel',
		dropbox: 'Csatlakozás Dropboxszal',
		memory: 'Memória-szolgáltató (teszt)'
	};

	let pin = $state('');
	let pin2 = $state('');
	let withDemo = $state(false);
	let error = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = pinFormatError(pin) ?? (pin !== pin2 ? 'A két PIN nem egyezik' : '');
		if (error) return;
		busy = true;
		error = (await auth.setup(pin, withDemo)) ?? '';
		busy = false;
	}

	/** „Már használom másik eszközön": bejelentkezés a felhőbe, majd a PIN beállítása és a szinkron befejezése a Beállításokban. */
	async function connectExisting(id: ProviderId) {
		error = pinFormatError(pin) ?? (pin !== pin2 ? 'A két PIN nem egyezik' : '');
		if (error) return;
		busy = true;
		try {
			// Előbb a bejelentkezés: a felugró ablak csak a gombnyomás gesztusából nyílhat meg.
			await sync.beginConnect(id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'A bejelentkezés nem sikerült';
			busy = false;
			return;
		}
		const err = await auth.setup(pin, false);
		busy = false;
		if (err) {
			error = err;
			await sync.cancelConnect();
			return;
		}
		await go('/settings'); // a szinkronjelszó megadása itt fejeződik be (SyncPanel)
	}
</script>

<main class="gate">
	<form class="gate-card" onsubmit={submit}>
		<AppLogo />
		<div class="stack center">
			<h1>Üdv a költségvetés-követőben!</h1>
			<p class="muted">
				Minden adatod kizárólag ezen az eszközön, a böngészőben tárolódik – nincs szerver, nincs
				fiók, internet nélkül is működik. Állíts be egy PIN-kódot, amivel az app zárolható.
			</p>
		</div>

		<div class="card stack">
			<div class="field">
				<label for="pin">Új PIN ({PIN_MIN}–{PIN_MAX} számjegy)</label>
				<input
					id="pin"
					class="pin-input"
					type="password"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength={PIN_MAX}
					autocomplete="new-password"
					bind:value={pin}
				/>
			</div>
			<div class="field">
				<label for="pin2">PIN megerősítése</label>
				<input
					id="pin2"
					class="pin-input"
					type="password"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength={PIN_MAX}
					autocomplete="new-password"
					bind:value={pin2}
				/>
				{#if error}<p class="error" role="alert">{error}</p>{/if}
			</div>
			<label class="row" style="align-items:flex-start">
				<input type="checkbox" bind:checked={withDemo} style="margin-top:4px;width:20px;height:20px" />
				<span>
					Példaadatokkal indulok
					<span class="hint" style="display:block">
						Az elmúlt 2–3 hónap kitalált tételei a kipróbáláshoz. A Beállításokban egy gombbal
						törölhetők.
					</span>
				</span>
			</label>
			<button class="btn primary block" type="submit" disabled={busy}>Kezdjük</button>
			{#if providers.length > 0}
				<hr />
				<div class="stack" data-testid="setup-connect">
					<p><strong>Már használod másik eszközön?</strong></p>
					<p class="hint">Jelentkezz be ugyanabba a tárhelybe, és az adataid átkerülnek erre az eszközre. A PIN eszközönként külön van.</p>
					{#each providers as p}
						<button class="btn block" type="button" disabled={busy} onclick={() => connectExisting(p.id)} data-provider={p.id}>{LABEL[p.id]}</button>
					{/each}
				</div>
			{/if}
		</div>

		<p class="hint center">
			A PIN alkalmazászár a véletlen belenézés ellen, nem titkosítás. Ha elfelejted, csak az összes
			adat törlésével lehet újrakezdeni – készíts időnként biztonsági mentést a Beállításokban.
		</p>
	</form>
</main>
