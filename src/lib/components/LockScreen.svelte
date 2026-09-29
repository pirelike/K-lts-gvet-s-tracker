<script lang="ts">
	import { auth } from '$lib/auth.svelte';
	import { PIN_MAX } from '$lib/db/pin';
	import { onMount } from 'svelte';
	import AppLogo from './AppLogo.svelte';
	import ConfirmButton from './ConfirmButton.svelte';

	let pin = $state('');
	let error = $state('');
	let retryAt = $state(0);
	let now = $state(Date.now());
	let busy = $state(false);
	let showForgot = $state(false);
	let input: HTMLInputElement;

	const wait = $derived(Math.max(0, Math.ceil((retryAt - now) / 1000)));

	onMount(() => {
		input?.focus();
		// Ha korábbi próbálkozások miatt még várakozni kell, a számláló azonnal látszik.
		const t = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(t);
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (wait > 0 || !pin) return;
		busy = true;
		const r = await auth.unlock(pin);
		busy = false;
		if (!r.ok) {
			error = r.error;
			retryAt = r.retryAt ?? 0;
			now = Date.now();
			pin = '';
			input?.focus();
		}
	}
</script>

<main class="gate">
	<form class="gate-card" onsubmit={submit}>
		<AppLogo />
		<div class="stack center">
			<h1>Add meg a PIN-kódot</h1>
		</div>
		<div class="card stack">
			<div class="field">
				<label class="sr-only" for="pin">PIN</label>
				<input
					id="pin"
					bind:this={input}
					class="pin-input"
					type="password"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength={PIN_MAX}
					autocomplete="current-password"
					bind:value={pin}
					disabled={wait > 0}
					aria-invalid={error ? 'true' : undefined}
				/>
				{#if wait > 0}
					<p class="error" role="alert">Túl sok hibás próba. Próbáld újra {wait} másodperc múlva.</p>
				{:else if error}
					<p class="error" role="alert">{error}</p>
				{/if}
			</div>
			<button class="btn primary block" type="submit" disabled={busy || wait > 0 || !pin}>Feloldás</button>
		</div>

		<div class="center stack">
			{#if !showForgot}
				<button type="button" class="btn ghost small" onclick={() => (showForgot = true)}>Elfelejtett PIN?</button>
			{:else}
				<div class="notice warn stack">
					<p>
						A PIN nem állítható vissza az adatok megtartásával – az adatok csak az eszközön vannak,
						a PIN pedig az egyetlen zár. Újrakezdéshez minden adatot törölni kell. Ha van
						biztonsági mentésed, az új beállítás után visszatöltheted a Beállításokban.
					</p>
					<div class="row wrap" style="justify-content:center">
						<ConfirmButton
							label="Minden adat törlése"
							question="Az összes tétel végleg törlődik!"
							confirmLabel="Igen, mindent törlök"
							onconfirm={() => auth.wipeEverything()}
						/>
						<button type="button" class="btn small" onclick={() => (showForgot = false)}>Mégse</button>
					</div>
				</div>
			{/if}
		</div>
	</form>
</main>
