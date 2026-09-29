<script lang="ts">
	import { formatDateShort } from '$lib/dates';
	import { clock } from '$lib/clock.svelte';
	import { ledger } from '$lib/ledger.svelte';
	import { formatSignedMoney } from '$lib/money';
	import { href } from '$lib/nav';
	import { TX_TYPE_LABEL, type Transaction } from '$lib/types';

	let {
		tx,
		showDate = false,
		selectable = false,
		selected = false,
		ontoggle
	}: {
		tx: Transaction;
		showDate?: boolean;
		/** Csoportos kijelölés módban a sor jelölőnégyzet, nem hivatkozás. */
		selectable?: boolean;
		selected?: boolean;
		ontoggle?: (id: number) => void;
	} = $props();

	const cat = $derived(tx.categoryId != null ? ledger.catById.get(tx.categoryId) : undefined);
	const acc = $derived(ledger.accById.get(tx.accountId));
	const to = $derived(tx.toAccountId != null ? ledger.accById.get(tx.toAccountId) : undefined);
	const title = $derived(
		tx.description || (tx.type === 'transfer' ? 'Átvezetés' : tx.type === 'refund' ? 'Jóváírás' : (cat?.name ?? 'Tétel'))
	);
	const sub = $derived.by(() => {
		const parts: string[] = [];
		if (tx.type === 'transfer') parts.push(`${acc?.name ?? '?'} → ${to?.name ?? '?'}`);
		else {
			if (tx.splits && tx.splits.length > 0) {
				parts.push(tx.splits.map((p) => ledger.catById.get(p.categoryId)?.name ?? '?').join(' + '));
			} else parts.push(cat?.name ?? 'Ismeretlen kategória');
			parts.push(acc?.name ?? '?');
		}
		if (tx.type === 'refund') parts.unshift(TX_TYPE_LABEL.refund);
		if (showDate) parts.unshift(formatDateShort(tx.date, clock.today));
		if (tx.tags.length) parts.push(tx.tags.map((t) => `#${t}`).join(' '));
		return parts.join(' · ');
	});
</script>

{#snippet body()}
	<span class="tx-icon" aria-hidden="true">{tx.type === 'transfer' ? '⇄' : cat?.icon || '•'}</span>
	<span class="tx-main">
		<span class="tx-title" style="display:block">
			{title}{#if tx.recurringId != null}<span class="rec-mark" title="Ismétlődő tételből" aria-label="ismétlődő"> ↻</span>{/if}
		</span>
		<span class="tx-sub" style="display:block">{sub}</span>
	</span>
	<span class="tx-amount num" class:inc={tx.type === 'income' || tx.type === 'refund'} class:exp={tx.type === 'expense'}>
		{formatSignedMoney(tx.type, tx.amount)}
	</span>
{/snippet}

{#if selectable}
	<label class="tx selectable" class:selected style:--dot={cat?.color ?? '#64748b'}>
		<input type="checkbox" checked={selected} onchange={() => ontoggle?.(tx.id)} aria-label={`Kijelölés: ${title}`} />
		{@render body()}
	</label>
{:else}
	<a class="tx" href={href(`/transactions/${tx.id}`)} style:--dot={cat?.color ?? '#64748b'}>
		{@render body()}
	</a>
{/if}

<style>
	.rec-mark {
		color: var(--muted);
		font-weight: 400;
	}
	.selectable {
		cursor: pointer;
	}
	.selectable input {
		width: 22px;
		height: 22px;
		flex: none;
		accent-color: var(--primary);
	}
	.selectable.selected {
		background: var(--primary-soft);
	}
</style>
