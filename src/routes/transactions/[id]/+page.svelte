<script lang="ts">
	import { page } from '$app/state';
	import { ledger } from '$lib/ledger.svelte';
	import TransactionForm from '$lib/components/TransactionForm.svelte';
	import { toInputAmount } from '$lib/money';
	import { href } from '$lib/nav';

	const tx = $derived(ledger.transactions.find((t) => t.id === Number(page.params.id)));
</script>

<svelte:head><title>Tétel szerkesztése · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Tétel szerkesztése</h1></div>
	{#if tx}
		{#key tx.id}
			<TransactionForm
				mode="edit"
				editing={tx}
				initial={{
					type: tx.type,
					amount: toInputAmount(tx.amount),
					date: tx.date,
					description: tx.description,
					categoryId: tx.categoryId,
					accountId: tx.accountId,
					toAccountId: tx.toAccountId,
					note: tx.note,
					tags: tx.tags.map((t) => `#${t}`).join(' '),
					splits: tx.splits?.map((p) => ({ categoryId: p.categoryId, amount: toInputAmount(p.amount) }))
				}}
			/>
		{/key}
	{:else}
		<div class="card center stack">
			<p>Ez a tétel nem található (talán törölted).</p>
			<a class="btn primary" href={href('/transactions')}>Vissza a tételekhez</a>
		</div>
	{/if}
</div>
