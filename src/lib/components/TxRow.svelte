<script lang="ts">
	import { formatDateShort, todayISO } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { formatSignedMoney } from '$lib/money';
	import { href } from '$lib/nav';
	import type { Transaction } from '$lib/types';

	let { tx, showDate = false }: { tx: Transaction; showDate?: boolean } = $props();

	const cat = $derived(tx.categoryId != null ? ledger.catById.get(tx.categoryId) : undefined);
	const acc = $derived(ledger.accById.get(tx.accountId));
	const to = $derived(tx.toAccountId != null ? ledger.accById.get(tx.toAccountId) : undefined);
	const title = $derived(
		tx.description || (tx.type === 'transfer' ? 'Átvezetés' : (cat?.name ?? 'Tétel'))
	);
	const sub = $derived.by(() => {
		const parts: string[] = [];
		if (tx.type === 'transfer') parts.push(`${acc?.name ?? '?'} → ${to?.name ?? '?'}`);
		else parts.push(cat?.name ?? 'Ismeretlen kategória', acc?.name ?? '?');
		if (showDate) parts.unshift(formatDateShort(tx.date, todayISO()));
		if (tx.tags.length) parts.push(tx.tags.map((t) => `#${t}`).join(' '));
		return parts.join(' · ');
	});
</script>

<a class="tx" href={href(`/transactions/${tx.id}`)} style:--dot={cat?.color ?? '#64748b'}>
	<span class="tx-icon" aria-hidden="true">{tx.type === 'transfer' ? '⇄' : cat?.icon || '•'}</span>
	<span class="tx-main">
		<span class="tx-title" style="display:block">{title}</span>
		<span class="tx-sub" style="display:block">{sub}</span>
	</span>
	<span class="tx-amount num" class:inc={tx.type === 'income'} class:exp={tx.type === 'expense'}>
		{formatSignedMoney(tx.type, tx.amount)}
	</span>
</a>
