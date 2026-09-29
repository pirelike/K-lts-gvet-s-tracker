<script lang="ts">
	import { auth } from '$lib/auth.svelte';
	import { PIN_MAX, PIN_MIN, pinFormatError } from '$lib/db/pin';
	import AppLogo from './AppLogo.svelte';

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
		</div>

		<p class="hint center">
			A PIN alkalmazászár a véletlen belenézés ellen, nem titkosítás. Ha elfelejted, csak az összes
			adat törlésével lehet újrakezdeni – készíts időnként biztonsági mentést a Beállításokban.
		</p>
	</form>
</main>
