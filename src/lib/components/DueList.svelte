<script lang="ts">
	/** Esedékes ismétlődő tételek: egy érintéssel jóváhagyhatók (az összeg előtte módosítható) vagy kihagyhatók. */
	import { clock } from '$lib/clock.svelte';
	import { formatDayLabel } from '$lib/dates';
	import { ledger, LedgerError } from '$lib/ledger.svelte';
	import { formatMoney, parseAmount, toInputAmount } from '$lib/money';
	import { href } from '$lib/nav';
	import type { DueItem } from '$lib/recurring';
	import { toasts } from '$lib/toast.svelte';

	let amounts = $state<Record<number, string>>({});
	let busy = $state(false);

	/** Szabályonként csak a legkorábbi esedékes előfordulás látszik (időrendben haladunk). */
	const items = $derived.by(() => {
		const seen = new Set<number>();
		const out: DueItem[] = [];
		for (const d of ledger.due) {
			if (seen.has(d.rule.id)) continue;
			seen.add(d.rule.id);
			out.push(d);
		}
		return out;
	});
	const total = $derived(ledger.due.length);

	const amountFor = (d: DueItem) => amounts[d.rule.id] ?? toInputAmount(d.rule.amount);

	async function handle(d: DueItem, mode: 'approve' | 'skip') {
		let amount: number | undefined;
		if (mode === 'approve') {
			const raw = amountFor(d);
			const r = parseAmount(raw);
			if (!r.ok) {
				toasts.error(r.error);
				return;
			}
			if (r.value !== d.rule.amount) amount = r.value;
		}
		busy = true;
		try {
			const tx = await ledger.handleRecurring(d.rule.id, d.date, mode, { amount });
			delete amounts[d.rule.id];
			toasts.show(mode === 'approve' ? (tx ? `Jóváhagyva: ${d.rule.description || 'tétel'}` : 'Ezt már feldolgozták') : 'Kihagyva');
		} catch (e) {
			toasts.error(e instanceof LedgerError || e instanceof Error ? e.message : 'A művelet nem sikerült');
		} finally {
			busy = false;
		}
	}

	async function approveAll() {
		busy = true;
		let n = 0;
		try {
			// Pillanatkép: minden esedékes előfordulás időrendben (a lista közben átrendeződik).
			for (const d of [...ledger.due]) {
				const tx = await ledger.handleRecurring(d.rule.id, d.date, 'approve');
				if (tx) n++;
			}
			toasts.show(`${n} tétel jóváhagyva`);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'A művelet nem sikerült');
		} finally {
			busy = false;
		}
	}
</script>

{#if items.length > 0}
	<section class="card stack due" aria-labelledby="due-title" data-testid="due-list">
		<div class="card-title" style="margin:0">
			<h2 id="due-title">Esedékes tételek ({total})</h2>
			<a class="small" href={href('/recurring')}>Kezelés</a>
		</div>
		<ul class="list" style="display:flex;flex-direction:column;gap:10px">
			{#each items as d (d.rule.id + d.date)}
				{@const cat = d.rule.categoryId != null ? ledger.catById.get(d.rule.categoryId) : undefined}
				<li class="due-item" style="border:0">
					<div class="row">
						<span class="tx-icon" style:--dot={cat?.color ?? '#64748b'} aria-hidden="true">{d.rule.type === 'transfer' ? '⇄' : cat?.icon || '•'}</span>
						<div class="grow">
							<strong>{d.rule.description || cat?.name || 'Átvezetés'}</strong>
							<div class="muted small">{formatDayLabel(d.date, clock.today)}{d.overdueDays > 0 ? ` · ${d.overdueDays} napja esedékes` : ''}</div>
						</div>
					</div>
					<div class="row wrap">
						<input class="due-amount num" type="text" inputmode="decimal" autocomplete="off" aria-label={`Összeg: ${d.rule.description}`}
							value={amountFor(d)} oninput={(e) => (amounts[d.rule.id] = e.currentTarget.value)} />
						<button class="btn primary small" type="button" disabled={busy} onclick={() => handle(d, 'approve')}>
							{d.rule.type === 'income' ? 'Megérkezett' : d.rule.type === 'transfer' ? 'Átvezetve' : 'Kifizetve'}
						</button>
						<button class="btn small" type="button" disabled={busy} onclick={() => handle(d, 'skip')}>Kihagy</button>
					</div>
				</li>
			{/each}
		</ul>
		{#if total > 1}
			<button class="btn block" type="button" disabled={busy} onclick={approveAll}>
				Mind jóváhagyása a listás összegekkel ({total})
			</button>
		{/if}
		<p class="hint">
			{formatMoney(items.reduce((s, d) => s + (d.rule.type === 'income' ? 0 : d.rule.type === 'transfer' ? 0 : d.rule.amount), 0))} kiadás vár jóváhagyásra.
		</p>
	</section>
{/if}

<style>
	.due {
		border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
	}
	.due-item {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.due-amount {
		width: 8em;
		min-height: 40px;
		padding: 6px 10px;
		font-weight: 700;
	}
</style>
