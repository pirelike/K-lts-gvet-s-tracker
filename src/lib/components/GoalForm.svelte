<script lang="ts">
	import { ledger } from '$lib/ledger.svelte';
	import { toInputAmount } from '$lib/money';
	import { PALETTE } from '$lib/palette';
	import type { Goal } from '$lib/types';
	import { validateGoal, type GoalField, type GoalInput } from '$lib/validation';
	import { untrack } from 'svelte';

	let {
		initial,
		submitLabel,
		onsave,
		oncancel
	}: {
		initial?: Goal;
		submitLabel: string;
		/** `false`: a mentés nem sikerült, az űrlap megtartja a beírt adatokat. */
		onsave: (v: GoalInput) => Promise<boolean | void> | boolean | void;
		oncancel?: () => void;
	} = $props();

	const init = untrack(() => initial);
	let name = $state(init?.name ?? '');
	let icon = $state(init?.icon ?? '🎯');
	let color = $state(init?.color ?? PALETTE[5]);
	let target = $state(init ? toInputAmount(init.target) : '');
	let saved = $state(init && init.saved ? toInputAmount(init.saved) : '');
	let accountId = $state<number | null>(init?.accountId ?? null);
	let deadline = $state(init?.deadline ?? '');
	let errors = $state<Partial<Record<GoalField, string>>>({});
	let busy = $state(false);
	const uid = $props.id();
	const accounts = $derived(ledger.accounts.filter((a) => !a.archived || a.id === init?.accountId));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return; // dupla koppintásra ne jöjjön létre két cél
		const res = validateGoal({ name, icon, color, target, saved, accountId, deadline }, ledger.goals, init?.id);
		if (!res.ok) {
			errors = res.errors;
			return;
		}
		errors = {};
		busy = true;
		try {
			if ((await onsave(res.value)) === false) return;
		} finally {
			busy = false;
		}
		if (!init) {
			name = '';
			target = '';
			saved = '';
			deadline = '';
			accountId = null;
		}
	}
</script>

<form class="stack" onsubmit={submit} novalidate>
	<div class="row">
		<div class="field" style="width:84px">
			<label for={`${uid}-icon`}>Ikon</label>
			<input id={`${uid}-icon`} type="text" bind:value={icon} style="text-align:center" aria-invalid={errors.icon ? 'true' : undefined} />
		</div>
		<div class="field grow">
			<label for={`${uid}-name`}>Cél neve</label>
			<input id={`${uid}-name`} type="text" maxlength="40" placeholder="pl. Új laptop, nyaralás" bind:value={name} aria-invalid={errors.name ? 'true' : undefined} />
		</div>
	</div>
	{#if errors.name}<p class="error" role="alert">{errors.name}</p>{/if}
	{#if errors.icon}<p class="error" role="alert">{errors.icon}</p>{/if}
	<div class="field">
		<label for={`${uid}-target`}>Cél összege</label>
		<input id={`${uid}-target`} type="text" inputmode="decimal" autocomplete="off" placeholder="pl. 300 000" bind:value={target} aria-invalid={errors.target ? 'true' : undefined} />
		{#if errors.target}<p class="error" role="alert">{errors.target}</p>{/if}
	</div>
	<div class="field">
		<label for={`${uid}-acc`}>Követés</label>
		<select id={`${uid}-acc`} bind:value={accountId}>
			<option value={null}>Kézi befizetésekkel</option>
			{#each accounts as a}<option value={a.id}>A(z) „{a.name}" számla egyenlege</option>{/each}
		</select>
		<p class="hint">Ha egy megtakarítási számlához kötöd, a számla egyenlege a haladás; különben te írod be, mennyit tettél félre.</p>
	</div>
	{#if accountId === null}
		<div class="field">
			<label for={`${uid}-saved`}>Eddig félretéve</label>
			<input id={`${uid}-saved`} type="text" inputmode="decimal" autocomplete="off" placeholder="0" bind:value={saved} aria-invalid={errors.saved ? 'true' : undefined} />
			{#if errors.saved}<p class="error" role="alert">{errors.saved}</p>{/if}
		</div>
	{/if}
	<div class="field">
		<label for={`${uid}-deadline`}>Határidő (nem kötelező)</label>
		<input id={`${uid}-deadline`} type="date" bind:value={deadline} aria-invalid={errors.deadline ? 'true' : undefined} />
		{#if errors.deadline}<p class="error" role="alert">{errors.deadline}</p>{/if}
	</div>
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
	<div class="actions">
		<button class="btn primary" type="submit" disabled={busy}>{submitLabel}</button>
		{#if oncancel}<button class="btn" type="button" onclick={oncancel}>Mégse</button>{/if}
	</div>
</form>
