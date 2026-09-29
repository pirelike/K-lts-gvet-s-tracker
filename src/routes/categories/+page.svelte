<script lang="ts">
	import CategoryForm from '$lib/components/CategoryForm.svelte';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import ReorderButtons from '$lib/components/ReorderButtons.svelte';
	import { formatMoney } from '$lib/money';
	import { href, query } from '$lib/nav';
	import { segIndicator } from '$lib/segIndicator';
	import { ledger, LedgerError } from '$lib/ledger.svelte';
	import { categoryUsage } from '$lib/queries';
	import { toasts } from '$lib/toast.svelte';
	import type { Category, CategoryType } from '$lib/types';

	let tab = $state<CategoryType>('expense');
	let editingId = $state<number | null>(null);
	let showArchived = $state(false);

	const usage = $derived(categoryUsage(ledger.transactions, ledger.recurring));
	const all = $derived(ledger.allCategories(tab));
	const active = $derived(all.filter((c) => !c.archived));
	const archived = $derived(all.filter((c) => c.archived));

	async function run(fn: () => Promise<unknown>, ok?: string) {
		try {
			await fn();
			if (ok) toasts.show(ok);
		} catch (e) {
			toasts.error(e instanceof LedgerError || e instanceof Error ? e.message : 'A művelet nem sikerült');
		}
	}
</script>

<svelte:head><title>Kategóriák · Költségvetés</title></svelte:head>

{#snippet row(c: Category, i: number, count: number)}
	<li class="stack" style="padding:12px 16px;gap:10px">
		<div class="row">
			<span class="tx-icon" style:--dot={c.color} aria-hidden="true">{c.icon || '•'}</span>
			<div class="grow">
				<strong>{c.name}</strong>
				{#if c.archived}<span class="badge">archivált</span>{/if}
				<div class="muted small">
					<a href={href(`/transactions${query({ cat: c.id })}`)}>{usage.get(c.id) ?? 0} tétel</a>
					{#if c.monthlyBudget}· havi keret: {formatMoney(c.monthlyBudget)}{/if}
				</div>
			</div>
			{#if !c.archived && count > 1}
				<ReorderButtons index={i} {count} label={c.name} onmove={(dir) => run(() => ledger.moveCategory(c.id, dir))} />
			{/if}
			<button class="btn small" type="button" onclick={() => (editingId = editingId === c.id ? null : c.id)}>
				{editingId === c.id ? 'Bezár' : 'Szerkesztés'}
			</button>
		</div>
		{#if editingId === c.id}
			<div class="card" style="box-shadow:none">
				<CategoryForm
					type={c.type}
					editingId={c.id}
					initial={{ name: c.name, icon: c.icon, color: c.color, monthlyBudget: c.monthlyBudget }}
					submitLabel="Mentés"
					onsave={async (v) => {
						await run(() => ledger.updateCategory(c.id, v), 'Kategória módosítva');
						editingId = null;
					}}
					oncancel={() => (editingId = null)}
				/>
				<hr style="margin:14px 0" />
				<div class="row wrap">
					{#if c.archived}
						<button class="btn small" type="button" onclick={() => run(() => ledger.setCategoryArchived(c.id, false), 'Kategória visszaállítva')}>Visszaállítás</button>
					{:else}
						<button class="btn small" type="button" onclick={() => run(() => ledger.setCategoryArchived(c.id, true), 'Kategória archiválva')}>Archiválás</button>
					{/if}
					{#if (usage.get(c.id) ?? 0) === 0}
						<ConfirmButton label="Törlés" onconfirm={() => run(() => ledger.deleteCategory(c.id), 'Kategória törölve')} />
					{:else}
						<span class="hint">Törölni nem lehet, mert vannak hozzá tételek – archiváld.</span>
					{/if}
				</div>
			</div>
		{/if}
	</li>
{/snippet}

<div class="page">
	<div class="page-head"><h1>Kategóriák</h1></div>

	<div class="seg" role="group" aria-label="Kategória típusa" use:segIndicator={tab === 'expense' ? 0 : 1}>
		<button type="button" class="seg-btn t-expense" class:active={tab === 'expense'} onclick={() => { tab = 'expense'; editingId = null; }}>Kiadás</button>
		<button type="button" class="seg-btn t-income" class:active={tab === 'income'} onclick={() => { tab = 'income'; editingId = null; }}>Bevétel</button>
	</div>

	<details class="card more">
		<summary>+ Új {tab === 'expense' ? 'kiadási' : 'bevételi'} kategória</summary>
		<div style="margin-top:10px">
			{#key tab}
				<CategoryForm
					type={tab}
					submitLabel="Hozzáadás"
					onsave={(v) => run(() => ledger.addCategory(tab, v), 'Kategória létrehozva')}
				/>
			{/key}
		</div>
	</details>

	<div class="card flush">
		<ul class="list">
			{#each active as c, i (c.id)}
				{@render row(c, i, active.length)}
			{:else}
				<li class="empty">Nincs aktív kategória.</li>
			{/each}
		</ul>
	</div>

	{#if archived.length > 0}
		<section class="stack">
			<button class="btn ghost small" type="button" onclick={() => (showArchived = !showArchived)} aria-expanded={showArchived}>
				Archivált kategóriák ({archived.length}) {showArchived ? '▲' : '▼'}
			</button>
			{#if showArchived}
				<div class="card flush">
					<ul class="list">
						{#each archived as c, i (c.id)}
							{@render row(c, i, archived.length)}
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}
</div>

