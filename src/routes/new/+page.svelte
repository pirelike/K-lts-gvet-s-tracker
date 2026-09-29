<script lang="ts">
	import { route } from '$lib/route.svelte';
	import { todayISO } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import TransactionForm, { type TxFormInitial } from '$lib/components/TransactionForm.svelte';
	import type { TxType } from '$lib/types';

	// ?copy=ID  – meglévő tétel másolása (dátum: ma, összeg kijelölve)
	// ?type=transfer|income|expense – típus előre kiválasztva
	const initial = $derived.by<TxFormInitial>(() => {
		const sp = route.params;
		const copyId = Number(sp.get('copy'));
		const src = copyId ? ledger.transactions.find((t) => t.id === copyId) : undefined;
		if (src) {
			return {
				type: src.type,
				amount: String(src.amount),
				date: todayISO(),
				description: src.description,
				categoryId: src.categoryId,
				accountId: src.accountId,
				toAccountId: src.toAccountId,
				note: src.note,
				tags: src.tags.map((t) => `#${t}`).join(' ')
			};
		}
		const t = sp.get('type');
		return { type: (t === 'income' || t === 'transfer' ? t : 'expense') as TxType };
	});
</script>

<svelte:head><title>Új tétel · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Új tétel</h1></div>
	{#key route.query}
		<TransactionForm mode="create" {initial} />
	{/key}
</div>
