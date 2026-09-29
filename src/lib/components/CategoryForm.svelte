<script lang="ts">
	import { PALETTE } from '$lib/palette';
	import type { CategoryType } from '$lib/types';
	import { validateCategory, type CategoryField, type CategoryValues } from '$lib/validation';
	import { ledger } from '$lib/ledger.svelte';
	import { toInputAmount } from '$lib/money';
	import { untrack } from 'svelte';

	let {
		type,
		initial,
		editingId,
		submitLabel,
		onsave,
		oncancel
	}: {
		type: CategoryType;
		initial?: { name: string; icon: string; color: string; monthlyBudget?: number | null };
		editingId?: number;
		submitLabel: string;
		onsave: (v: CategoryValues) => Promise<void> | void;
		oncancel?: () => void;
	} = $props();

	const init = untrack(() => initial);
	let name = $state(init?.name ?? '');
	let icon = $state(init?.icon ?? '');
	let color = $state(init?.color ?? PALETTE[0]);
	let budget = $state(init?.monthlyBudget ? toInputAmount(init.monthlyBudget) : '');
	let errors = $state<Partial<Record<CategoryField, string>>>({});
	const uid = $props.id();

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const res = validateCategory({ name, type, color, icon, monthlyBudget: budget }, ledger.categories, editingId);
		if (!res.ok) {
			errors = res.errors;
			return;
		}
		errors = {};
		await onsave(res.value);
		if (!editingId) {
			name = '';
			icon = '';
			budget = '';
		}
	}
</script>

<form class="stack" onsubmit={submit} novalidate>
	<div class="row">
		<div class="field" style="width:84px">
			<label for={`${uid}-icon`}>Ikon</label>
			<input id={`${uid}-icon`} type="text" bind:value={icon} placeholder="🍽️" aria-label="Ikon (emoji)" style="text-align:center" />
		</div>
		<div class="field grow">
			<label for={`${uid}-name`}>Név</label>
			<input id={`${uid}-name`} type="text" bind:value={name} maxlength="40" aria-invalid={errors.name ? 'true' : undefined} />
		</div>
	</div>
	{#if errors.name}<p class="error" role="alert">{errors.name}</p>{/if}
	{#if errors.icon}<p class="error" role="alert">{errors.icon}</p>{/if}
	{#if type === 'expense'}
		<div class="field">
			<label for={`${uid}-budget`}>Havi keret (nem kötelező)</label>
			<input id={`${uid}-budget`} type="text" inputmode="decimal" autocomplete="off" bind:value={budget} placeholder="pl. 40 000" aria-invalid={errors.monthlyBudget ? 'true' : undefined} />
			{#if errors.monthlyBudget}<p class="error" role="alert">{errors.monthlyBudget}</p>{/if}
			<p class="hint">A főoldalon sáv mutatja a kihasználtságát; 80% és 100% felett figyelmeztet.</p>
		</div>
	{/if}
	<fieldset class="field">
		<legend class="label">Szín</legend>
		<div class="swatches" role="radiogroup">
			{#each PALETTE as c}
				<label class="swatch" style:--dot={c}>
					<input type="radio" name={`${uid}-color`} value={c} bind:group={color} aria-label={`Szín ${c}`} />
				</label>
			{/each}
		</div>
	</fieldset>
	<div class="row wrap">
		<button class="btn primary" type="submit">{submitLabel}</button>
		{#if oncancel}<button class="btn" type="button" onclick={oncancel}>Mégse</button>{/if}
	</div>
</form>
