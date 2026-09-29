<script lang="ts">
	import { ledger } from '$lib/ledger.svelte';
	import { validateAccount, type AccountField } from '$lib/validation';
	import { untrack } from 'svelte';

	let {
		initial,
		editingId,
		submitLabel,
		onsave,
		oncancel
	}: {
		initial?: { name: string; initialBalance: number };
		editingId?: number;
		submitLabel: string;
		onsave: (v: { name: string; initialBalance: number }) => Promise<void> | void;
		oncancel?: () => void;
	} = $props();

	const init = untrack(() => initial);
	let name = $state(init?.name ?? '');
	let balance = $state(init ? String(init.initialBalance) : '');
	let errors = $state<Partial<Record<AccountField, string>>>({});
	const uid = $props.id();

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const res = validateAccount({ name, initialBalance: balance }, ledger.accounts, editingId);
		if (!res.ok) {
			errors = res.errors;
			return;
		}
		errors = {};
		await onsave(res.value);
		if (!editingId) {
			name = '';
			balance = '';
		}
	}
</script>

<form class="stack" onsubmit={submit} novalidate>
	<div class="field">
		<label for={`${uid}-name`}>Számla neve</label>
		<input id={`${uid}-name`} type="text" bind:value={name} maxlength="40" placeholder="pl. Készpénz, OTP kártya" aria-invalid={errors.name ? 'true' : undefined} />
		{#if errors.name}<p class="error" role="alert">{errors.name}</p>{/if}
	</div>
	<div class="field">
		<label for={`${uid}-bal`}>Kezdőegyenleg (Ft)</label>
		<input id={`${uid}-bal`} type="text" inputmode="decimal" bind:value={balance} placeholder="0" aria-invalid={errors.initialBalance ? 'true' : undefined} />
		{#if errors.initialBalance}<p class="error" role="alert">{errors.initialBalance}</p>{/if}
		<p class="hint">A számlán az app használata előtti egyenleg. Lehet negatív is.</p>
	</div>
	<div class="row wrap">
		<button class="btn primary" type="submit">{submitLabel}</button>
		{#if oncancel}<button class="btn" type="button" onclick={oncancel}>Mégse</button>{/if}
	</div>
</form>
