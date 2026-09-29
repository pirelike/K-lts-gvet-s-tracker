<script lang="ts">
	import { ledger } from '$lib/ledger.svelte';
	import { toInputAmount } from '$lib/money';
	import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL, type AccountType } from '$lib/types';
	import { validateAccount, type AccountField, type AccountValues } from '$lib/validation';
	import { untrack } from 'svelte';

	let {
		initial,
		editingId,
		submitLabel,
		onsave,
		oncancel
	}: {
		initial?: { name: string; initialBalance: number; type: AccountType };
		editingId?: number;
		submitLabel: string;
		onsave: (v: AccountValues) => Promise<void> | void;
		oncancel?: () => void;
	} = $props();

	const init = untrack(() => initial);
	let name = $state(init?.name ?? '');
	let balance = $state(init ? toInputAmount(init.initialBalance) : '');
	let type = $state<AccountType>(init?.type ?? 'checking');
	let errors = $state<Partial<Record<AccountField, string>>>({});
	const uid = $props.id();

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const res = validateAccount({ name, initialBalance: balance, type }, ledger.accounts, editingId);
		if (!res.ok) {
			errors = res.errors;
			return;
		}
		errors = {};
		await onsave(res.value);
		if (!editingId) {
			name = '';
			balance = '';
			type = 'checking';
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
		<label for={`${uid}-type`}>Számla típusa</label>
		<select id={`${uid}-type`} bind:value={type}>
			{#each ACCOUNT_TYPES as t}
				<option value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>
			{/each}
		</select>
	</div>
	<div class="field">
		<label for={`${uid}-bal`}>Kezdőegyenleg</label>
		<input id={`${uid}-bal`} type="text" inputmode="decimal" bind:value={balance} placeholder="0" aria-invalid={errors.initialBalance ? 'true' : undefined} />
		{#if errors.initialBalance}<p class="error" role="alert">{errors.initialBalance}</p>{/if}
		<p class="hint">A számlán az app használata előtti egyenleg. Lehet negatív is.</p>
	</div>
	<div class="row wrap">
		<button class="btn primary" type="submit">{submitLabel}</button>
		{#if oncancel}<button class="btn" type="button" onclick={oncancel}>Mégse</button>{/if}
	</div>
</form>
