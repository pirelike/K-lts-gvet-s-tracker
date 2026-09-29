<script lang="ts">
	import { route } from '$lib/route.svelte';
	import { clock } from '$lib/clock.svelte';
	import { isValidISODate } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { toInputAmount } from '$lib/money';
	import TransactionForm, { type TxFormInitial } from '$lib/components/TransactionForm.svelte';
	import type { TxType } from '$lib/types';

	// ?copy=ID  – meglévő tétel másolása (dátum: ma, összeg kijelölve)
	// ?type=transfer|income|expense|refund – típus előre kiválasztva
	// ?date=YYYY-MM-DD, ?amount=, ?desc=, ?cat=ID, ?acc=ID, ?tags=a+b – előre kitöltött mezők (naptár, gyorsbevitel)
	const TYPES: TxType[] = ['income', 'transfer', 'refund'];
	const initial = $derived.by<TxFormInitial>(() => {
		const sp = route.params;
		const copyId = Number(sp.get('copy'));
		const src = copyId ? ledger.transactions.find((t) => t.id === copyId) : undefined;
		if (src) {
			return {
				type: src.type,
				amount: toInputAmount(src.amount),
				date: clock.today,
				description: src.description,
				categoryId: src.categoryId,
				accountId: src.accountId,
				toAccountId: src.toAccountId,
				note: src.note,
				tags: src.tags.map((t) => `#${t}`).join(' '),
				splits: src.splits?.map((p) => ({ categoryId: p.categoryId, amount: toInputAmount(p.amount) }))
			};
		}
		const t = sp.get('type') as TxType;
		const id = (key: string) => {
			const v = Number(sp.get(key));
			return Number.isInteger(v) && v > 0 ? v : undefined;
		};
		const date = sp.get('date') ?? '';
		return {
			type: TYPES.includes(t) ? t : 'expense',
			amount: sp.get('amount') ?? undefined,
			date: isValidISODate(date) ? date : undefined,
			description: sp.get('desc') ?? undefined,
			categoryId: id('cat'),
			accountId: id('acc'),
			toAccountId: id('to'),
			tags: (sp.get('tags') ?? '')
				.split(/\s+/)
				.filter(Boolean)
				.map((g) => `#${g}`)
				.join(' ')
		};
	});
</script>

<svelte:head><title>Új tétel · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Új tétel</h1></div>
	{#key route.query}
		<TransactionForm mode="create" {initial} />
	{/key}
</div>
