<script lang="ts">
	/**
	 * Természetes nyelvű gyorsbevitel: „kávé 890 tegnap", „+48000 ösztöndíj", „mozi 3200 péntek kártyával".
	 * Élő előnézet; Enter menti a szokásos ellenőrzéssel, vagy megnyitható az űrlapban.
	 */
	import { announceBudgetCrossings } from '$lib/budgetNotice';
	import { clock } from '$lib/clock.svelte';
	import { formatDateShort, monthOf } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney } from '$lib/money';
	import { go, query } from '$lib/nav';
	import { knownDescriptions, lastUsed } from '$lib/queries';
	import { parseQuickEntry } from '$lib/quick';
	import { toasts } from '$lib/toast.svelte';
	import { TX_TYPE_LABEL, categoryTypeFor } from '$lib/types';
	import { validateTx } from '$lib/validation';

	let text = $state('');
	let saving = $state(false);
	const uid = $props.id();

	const ctx = $derived({
		today: clock.today,
		accounts: ledger.activeAccounts,
		categories: [...ledger.activeCategories('expense'), ...ledger.activeCategories('income')],
		known: knownDescriptions(ledger.transactions)
	});
	const parsed = $derived(text.trim() ? parseQuickEntry(text, ctx) : null);
	const last = $derived(lastUsed(ledger.transactions));

	/** A hiányzó kategóriát és számlát az utoljára használt (vagy az első) érték pótolja. */
	const resolved = $derived.by(() => {
		if (!parsed) return null;
		const catType = categoryTypeFor(parsed.type)!;
		const cats = ledger.activeCategories(catType);
		const lu = last[parsed.type];
		let categoryId = parsed.categoryId;
		let guessed = false;
		if (categoryId === null) {
			categoryId = cats.some((c) => c.id === lu.categoryId) ? lu.categoryId : (cats[0]?.id ?? null);
			guessed = true;
		}
		const accountId =
			parsed.accountId ?? (ledger.activeAccounts.some((a) => a.id === lu.accountId) ? lu.accountId : (ledger.activeAccounts[0]?.id ?? null));
		return { categoryId, accountId, guessed };
	});

	const category = $derived(resolved?.categoryId != null ? ledger.catById.get(resolved.categoryId) : undefined);
	const account = $derived(resolved?.accountId != null ? ledger.accById.get(resolved.accountId) : undefined);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed || !resolved) return;
		if (parsed.problems.length) {
			toasts.error(parsed.problems[0]);
			return;
		}
		const res = validateTx(
			{
				type: parsed.type,
				amount: parsed.amountText || String(parsed.amount),
				date: parsed.date,
				description: parsed.description,
				categoryId: resolved.categoryId,
				accountId: resolved.accountId,
				toAccountId: null,
				note: '',
				tags: parsed.tags.join(' ')
			},
			{ categories: ledger.categories, accounts: ledger.accounts }
		);
		if (!res.ok) {
			toasts.error(Object.values(res.errors)[0] ?? 'A tétel nem menthető');
			return;
		}
		saving = true;
		try {
			const before = ledger.transactions;
			await ledger.addTx(res.value);
			toasts.show(`Mentve: ${formatMoney(res.value.amount)} · ${res.value.description || category?.name}`);
			if (res.value.type === 'expense') announceBudgetCrossings(before, monthOf(res.value.date));
			text = '';
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'A mentés nem sikerült');
		} finally {
			saving = false;
		}
	}

	function openInForm() {
		if (!parsed || !resolved) return;
		void go(
			`/new${query({
				type: parsed.type,
				amount: parsed.amountText,
				date: parsed.date,
				desc: parsed.description,
				cat: resolved.categoryId,
				acc: resolved.accountId,
				tags: parsed.tags.join(' ')
			})}`
		);
	}
</script>

<form class="card stack quick" onsubmit={submit} data-testid="quick-entry" novalidate>
	<label for={`${uid}-q`} class="quick-label">Gyorsbevitel</label>
	<div class="row">
		<input
			id={`${uid}-q`}
			type="text"
			autocomplete="off"
			enterkeyhint="done"
			placeholder="pl. kávé 890 tegnap"
			aria-describedby={`${uid}-help`}
			bind:value={text}
		/>
		<button class="btn primary" type="submit" disabled={saving || !parsed || parsed.problems.length > 0}>Mentés</button>
	</div>
	{#if parsed && resolved}
		<div class="quick-preview" id={`${uid}-help`} role="status" data-testid="quick-preview">
			{#if parsed.problems.length}
				<span class="hint">{parsed.problems[0]}</span>
			{:else}
				<span class="badge" class:demo={parsed.type !== 'expense'}>{TX_TYPE_LABEL[parsed.type]}</span>
				<strong class="num">{formatMoney(parsed.amount ?? 0)}</strong>
				<span>{parsed.description || category?.name}</span>
				<span class="muted">· {formatDateShort(parsed.date, clock.today)}</span>
				<span class="muted">· <span aria-hidden="true">{category?.icon}</span> {category?.name}{resolved.guessed ? ' (utoljára használt)' : ''}</span>
				<span class="muted">· {account?.name}</span>
				{#if parsed.tags.length}<span class="muted">· {parsed.tags.map((t) => `#${t}`).join(' ')}</span>{/if}
				<button type="button" class="link-btn" onclick={openInForm}>Megnyitás űrlapban</button>
			{/if}
		</div>
	{:else}
		<p class="hint" id={`${uid}-help`}>Írd le egy sorban: mire, mennyi, mikor. Pl. „lidl 4 500 tegnap", „+48000 ösztöndíj", „mozi 3200 péntek kártyával #haverok".</p>
	{/if}
</form>

<style>
	.quick {
		gap: 8px;
	}
	.quick-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--muted);
	}
	.quick-preview {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		font-size: 0.92rem;
	}
	.link-btn {
		border: 0;
		background: none;
		padding: 4px 0;
		color: var(--primary);
		font-weight: 600;
		cursor: pointer;
	}
</style>
