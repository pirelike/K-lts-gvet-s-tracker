<script lang="ts">
	import AccountForm from '$lib/components/AccountForm.svelte';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { href, query } from '$lib/nav';
	import { ledger, LedgerError } from '$lib/ledger.svelte';
	import { formatMoney } from '$lib/money';
	import { accountBalances, accountUsage } from '$lib/queries';
	import { toasts } from '$lib/toast.svelte';
	import type { Account } from '$lib/types';

	let editingId = $state<number | null>(null);
	let showArchived = $state(false);

	const balances = $derived(accountBalances(ledger.accounts, ledger.transactions));
	const usage = $derived(accountUsage(ledger.transactions));
	const active = $derived(ledger.accounts.filter((a) => !a.archived).sort((a, b) => a.sortOrder - b.sortOrder));
	const archived = $derived(ledger.accounts.filter((a) => a.archived));
	const total = $derived(active.reduce((s, a) => s + (balances.get(a.id) ?? 0), 0));

	async function run(fn: () => Promise<unknown>, ok?: string) {
		try {
			await fn();
			if (ok) toasts.show(ok);
		} catch (e) {
			toasts.error(e instanceof LedgerError || e instanceof Error ? e.message : 'A művelet nem sikerült');
		}
	}
</script>

<svelte:head><title>Számlák · Költségvetés</title></svelte:head>

{#snippet card(a: Account)}
	{@const b = balances.get(a.id) ?? 0}
	<li class="card stack">
		<div class="row">
			<div class="grow">
				<strong>{a.name}</strong>
				{#if a.archived}<span class="badge">archivált</span>{/if}
				<div class="muted small">
					Kezdőegyenleg: {formatMoney(a.initialBalance)} ·
					<a href={href(`/transactions${query({ acc: a.id })}`)}>{usage.get(a.id) ?? 0} tétel</a>
				</div>
			</div>
			<strong class="num" style="font-size:1.25rem" class:exp={b < 0} data-testid={`balance-${a.name}`}>{formatMoney(b)}</strong>
		</div>
		<div class="row wrap">
			<button class="btn small" type="button" onclick={() => (editingId = editingId === a.id ? null : a.id)}>
				{editingId === a.id ? 'Bezár' : 'Szerkesztés'}
			</button>
		</div>
		{#if editingId === a.id}
			<div class="stack">
				<AccountForm
					editingId={a.id}
					initial={{ name: a.name, initialBalance: a.initialBalance }}
					submitLabel="Mentés"
					onsave={async (v) => {
						await run(() => ledger.updateAccount(a.id, v), 'Számla módosítva');
						editingId = null;
					}}
					oncancel={() => (editingId = null)}
				/>
				<hr />
				<div class="row wrap">
					{#if a.archived}
						<button class="btn small" type="button" onclick={() => run(() => ledger.setAccountArchived(a.id, false), 'Számla visszaállítva')}>Visszaállítás</button>
					{:else}
						<button class="btn small" type="button" onclick={() => run(() => ledger.setAccountArchived(a.id, true), 'Számla archiválva')}>Archiválás</button>
					{/if}
					{#if (usage.get(a.id) ?? 0) === 0}
						<ConfirmButton label="Törlés" onconfirm={() => run(() => ledger.deleteAccount(a.id), 'Számla törölve')} />
					{:else}
						<span class="hint">Törölni nem lehet, mert vannak hozzá tételek – archiváld.</span>
					{/if}
				</div>
			</div>
		{/if}
	</li>
{/snippet}

<div class="page">
	<div class="page-head">
		<h1>Számlák</h1>
		<a class="btn small" href={href(`/new${query({ type: 'transfer' })}`)}><Icon name="transfer" size={18} /> Átvezetés</a>
	</div>

	<div class="card row">
		<span class="grow muted">Összes egyenleg</span>
		<strong class="num" style="font-size:1.35rem" class:exp={total < 0}>{formatMoney(total)}</strong>
	</div>

	<ul class="stack" style="list-style:none;margin:0;padding:0">
		{#each active as a (a.id)}
			{@render card(a)}
		{:else}
			<li class="card empty">Még nincs számlád – hozz létre egyet lent.</li>
		{/each}
	</ul>

	<details class="card more">
		<summary>+ Új számla</summary>
		<div style="margin-top:10px">
			<AccountForm submitLabel="Hozzáadás" onsave={(v) => run(() => ledger.addAccount(v), 'Számla létrehozva')} />
		</div>
	</details>

	{#if archived.length > 0}
		<section class="stack">
			<button class="btn ghost small" type="button" onclick={() => (showArchived = !showArchived)} aria-expanded={showArchived}>
				Archivált számlák ({archived.length}) {showArchived ? '▲' : '▼'}
			</button>
			{#if showArchived}
				<ul class="stack" style="list-style:none;margin:0;padding:0">
					{#each archived as a (a.id)}
						{@render card(a)}
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>
