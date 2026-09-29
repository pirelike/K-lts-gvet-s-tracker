<script lang="ts">
	import { clock } from '$lib/clock.svelte';
	import { ledger } from '$lib/ledger.svelte';
	import { toInputAmount } from '$lib/money';
	import { segIndicator } from '$lib/segIndicator';
	import { FREQUENCY_LABEL } from '$lib/recurring';
	import { TX_TYPE_LABEL, type Frequency, type Recurring } from '$lib/types';
	import { validateRecurring, type RecurringField, type RecurringInput } from '$lib/validation';
	import { untrack } from 'svelte';

	let {
		initial,
		submitLabel,
		onsave,
		oncancel
	}: {
		initial?: Recurring;
		submitLabel: string;
		onsave: (v: RecurringInput) => Promise<void> | void;
		oncancel?: () => void;
	} = $props();

	const init = untrack(() => initial);
	const TYPES = ['expense', 'income', 'transfer'] as const;
	let type = $state<(typeof TYPES)[number]>(init?.type ?? 'expense');
	let description = $state(init?.description ?? '');
	let amount = $state(init ? toInputAmount(init.amount) : '');
	let categoryId = $state<number | null>(init?.categoryId ?? null);
	let accountId = $state<number | null>(init?.accountId ?? ledger.activeAccounts[0]?.id ?? null);
	let toAccountId = $state<number | null>(init?.toAccountId ?? null);
	let frequency = $state<Frequency>(init?.frequency ?? 'monthly');
	let interval = $state(String(init?.interval ?? 1));
	let startDate = $state(init?.startDate ?? clock.today);
	let endDate = $state(init?.endDate ?? '');
	let tags = $state(init?.tags.map((t) => `#${t}`).join(' ') ?? '');
	let note = $state(init?.note ?? '');
	let errors = $state<Partial<Record<RecurringField, string>>>({});
	const uid = $props.id();

	const cats = $derived(type === 'transfer' ? [] : ledger.allCategories(type).filter((c) => !c.archived || c.id === init?.categoryId));
	// Típusváltáskor a kategória a megfelelő típusúra áll.
	$effect(() => {
		if (type === 'transfer') return;
		if (!cats.some((c) => c.id === categoryId)) categoryId = cats[0]?.id ?? null;
	});
	$effect(() => {
		if (type === 'transfer' && (toAccountId === null || toAccountId === accountId)) {
			toAccountId = ledger.activeAccounts.find((a) => a.id !== accountId)?.id ?? null;
		}
	});
	const accounts = $derived(ledger.accounts.filter((a) => !a.archived || a.id === init?.accountId || a.id === init?.toAccountId));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const res = validateRecurring(
			{ type, amount, description, categoryId, accountId, toAccountId, note, tags, frequency, interval, startDate, endDate },
			{ categories: ledger.categories, accounts: ledger.accounts }
		);
		if (!res.ok) {
			errors = res.errors;
			return;
		}
		errors = {};
		await onsave(res.value);
	}
</script>

<form class="stack" onsubmit={submit} novalidate>
	<div class="seg" role="radiogroup" aria-label="Típus" use:segIndicator={TYPES.indexOf(type)}>
		{#each TYPES as t}
			<label class={`t-${t}`}>
				<input type="radio" name={`${uid}-type`} value={t} checked={type === t} onchange={() => (type = t)} />
				{TX_TYPE_LABEL[t]}
			</label>
		{/each}
	</div>
	<div class="field">
		<label for={`${uid}-desc`}>{type === 'income' ? 'Honnan jön?' : type === 'transfer' ? 'Megnevezés (nem kötelező)' : 'Megnevezés'}</label>
		<input id={`${uid}-desc`} type="text" maxlength="200" placeholder={type === 'income' ? 'pl. ösztöndíj' : type === 'transfer' ? 'pl. havi félretét' : 'pl. albérlet, Netflix'} bind:value={description} aria-invalid={errors.description ? 'true' : undefined} />
		{#if errors.description}<p class="error" role="alert">{errors.description}</p>{/if}
	</div>
	<div class="field">
		<label for={`${uid}-amount`}>Összeg</label>
		<input id={`${uid}-amount`} type="text" inputmode="decimal" autocomplete="off" placeholder="pl. 90 000" bind:value={amount} aria-invalid={errors.amount ? 'true' : undefined} />
		{#if errors.amount}<p class="error" role="alert">{errors.amount}</p>{/if}
		<p class="hint">Jóváhagyáskor még módosítható (pl. változó közüzemi díjnál).</p>
	</div>
	{#if type !== 'transfer'}
		<div class="field">
			<label for={`${uid}-cat`}>Kategória</label>
			<select id={`${uid}-cat`} bind:value={categoryId} aria-invalid={errors.category ? 'true' : undefined}>
				{#each cats as c}<option value={c.id}>{c.icon} {c.name}</option>{/each}
			</select>
			{#if errors.category}<p class="error" role="alert">{errors.category}</p>{/if}
		</div>
	{/if}
	<div class="grid-2">
		<div class="field">
			<label for={`${uid}-acc`}>{type === 'transfer' ? 'Honnan (forrásszámla)' : 'Számla'}</label>
			<select id={`${uid}-acc`} bind:value={accountId} aria-invalid={errors.account ? 'true' : undefined}>
				{#each accounts as a}<option value={a.id}>{a.name}</option>{/each}
			</select>
			{#if errors.account}<p class="error" role="alert">{errors.account}</p>{/if}
		</div>
		{#if type === 'transfer'}
			<div class="field">
				<label for={`${uid}-to`}>Hová (célszámla)</label>
				<select id={`${uid}-to`} bind:value={toAccountId} aria-invalid={errors.toAccount ? 'true' : undefined}>
					{#each accounts as a}<option value={a.id}>{a.name}</option>{/each}
				</select>
				{#if errors.toAccount}<p class="error" role="alert">{errors.toAccount}</p>{/if}
			</div>
		{/if}
	</div>
	<div class="grid-2">
		<div class="field">
			<label for={`${uid}-freq`}>Gyakoriság</label>
			<select id={`${uid}-freq`} bind:value={frequency}>
				{#each ['weekly', 'monthly', 'yearly'] as f}<option value={f}>{FREQUENCY_LABEL[f as Frequency]}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for={`${uid}-int`}>Minden … {frequency === 'weekly' ? 'hét' : frequency === 'monthly' ? 'hónap' : 'év'}</label>
			<input id={`${uid}-int`} type="text" inputmode="numeric" bind:value={interval} aria-invalid={errors.interval ? 'true' : undefined} />
			{#if errors.interval}<p class="error" role="alert">{errors.interval}</p>{/if}
		</div>
	</div>
	<div class="grid-2">
		<div class="field">
			<label for={`${uid}-start`}>Első alkalom</label>
			<input id={`${uid}-start`} type="date" bind:value={startDate} aria-invalid={errors.startDate ? 'true' : undefined} />
			{#if errors.startDate}<p class="error" role="alert">{errors.startDate}</p>{/if}
		</div>
		<div class="field">
			<label for={`${uid}-end`}>Utolsó alkalom (nem kötelező)</label>
			<input id={`${uid}-end`} type="date" bind:value={endDate} aria-invalid={errors.endDate ? 'true' : undefined} />
			{#if errors.endDate}<p class="error" role="alert">{errors.endDate}</p>{/if}
		</div>
	</div>
	<p class="hint">Ha az első alkalom a múltban van, a kimaradt előfordulások is esedékesként jelennek meg (egyenként kihagyhatók).</p>
	<details class="more" open={!!(tags || note)}>
		<summary>Címkék és megjegyzés</summary>
		<div class="stack" style="margin-top:8px">
			<div class="field">
				<label for={`${uid}-tags`}>Címkék</label>
				<input id={`${uid}-tags`} type="text" placeholder="pl. #lakás" bind:value={tags} aria-invalid={errors.tags ? 'true' : undefined} />
				{#if errors.tags}<p class="error" role="alert">{errors.tags}</p>{/if}
			</div>
			<div class="field">
				<label for={`${uid}-note`}>Megjegyzés</label>
				<textarea id={`${uid}-note`} bind:value={note} maxlength="2000"></textarea>
			</div>
		</div>
	</details>
	<div class="row wrap">
		<button class="btn primary" type="submit">{submitLabel}</button>
		{#if oncancel}<button class="btn" type="button" onclick={oncancel}>Mégse</button>{/if}
	</div>
</form>

<style>
	.grid-2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	@media (max-width: 480px) {
		.grid-2 {
			grid-template-columns: 1fr;
		}
	}
</style>
