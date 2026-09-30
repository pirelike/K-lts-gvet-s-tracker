<script lang="ts">
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import GoalForm from '$lib/components/GoalForm.svelte';
	import ReorderButtons from '$lib/components/ReorderButtons.svelte';
	import { clock } from '$lib/clock.svelte';
	import { formatDateShort } from '$lib/dates';
	import { goalProgress } from '$lib/goals';
	import { ledger, LedgerError } from '$lib/ledger.svelte';
	import { evaluateExpression, formatMoney } from '$lib/money';
	import { accountBalances } from '$lib/queries';
	import { toasts } from '$lib/toast.svelte';
	import type { Goal } from '$lib/types';

	let editingId = $state<number | null>(null);
	let showArchived = $state(false);
	let amounts = $state<Record<number, string>>({});

	const balances = $derived(accountBalances(ledger.accounts, ledger.transactions));
	const active = $derived(ledger.goals.filter((g) => !g.archived).sort((a, b) => a.sortOrder - b.sortOrder));
	const archived = $derived(ledger.goals.filter((g) => g.archived));

	/** `true`, ha a művelet sikerült; hibánál toast jelzi, és `false` a válasz (hogy az űrlapok ne ürüljenek ki / záródjanak be). */
	async function run(fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
		try {
			await fn();
			if (ok) toasts.show(ok);
			return true;
		} catch (e) {
			toasts.error(e instanceof LedgerError || e instanceof Error ? e.message : 'A művelet nem sikerült');
			return false;
		}
	}

	async function contribute(g: Goal, sign: 1 | -1) {
		const r = evaluateExpression(amounts[g.id] ?? '');
		if (!r.ok || r.value <= 0) return toasts.error('Adj meg egy pozitív összeget');
		if (sign < 0 && r.value > g.saved) return toasts.error(g.saved > 0 ? `Legfeljebb ${formatMoney(g.saved)} vehető ki` : 'Még nincs mit kivenni');
		if (await run(() => ledger.addToGoal(g.id, sign * r.value), sign > 0 ? 'Befizetés rögzítve' : 'Kivétel rögzítve')) amounts[g.id] = '';
	}

</script>

<svelte:head><title>Megtakarítási célok · Költségvetés</title></svelte:head>

{#snippet card(g: Goal, i: number, count: number)}
	{@const p = goalProgress(g, balances, clock.today)}
	<li class="card stack">
		<div class="row">
			<span class="tx-icon" style:--dot={g.color} aria-hidden="true">{g.icon}</span>
			<div class="grow">
				<strong>{g.name}</strong>
				{#if p.reached}<span class="badge demo">elérve 🎉</span>{/if}
				<div class="muted small">
					{g.accountId != null ? `Számla: ${ledger.accById.get(g.accountId)?.name ?? '?'}` : 'Kézi követés'}
					{#if g.deadline}· határidő: {formatDateShort(g.deadline, clock.today)}{/if}
				</div>
			</div>
			{#if !g.archived && count > 1}<ReorderButtons index={i} {count} label={g.name} onmove={(dir) => run(() => ledger.moveGoal(g.id, dir))} />{/if}
		</div>
		<div class="stack" style="gap:6px">
			<div class="row">
				<strong class="num grow">{formatMoney(p.current)} <span class="muted">/ {formatMoney(p.target)}</span></strong>
				<strong class="num">{Math.round(p.ratio * 100)}%</strong>
			</div>
			<div class="bar" style:--dot={g.color} role="progressbar" aria-label={g.name} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(p.ratio * 100)}>
				<span style:width={`${Math.max(p.ratio > 0 ? 2 : 0, p.ratio * 100)}%`}></span>
			</div>
			{#if !p.reached}
				<p class="small muted">
					Még {formatMoney(p.remaining)} hiányzik.
					{#if p.daysLeft !== null && p.daysLeft < 0}<strong class="exp">A határidő lejárt.</strong>
					{:else if p.daysLeft === 0}<strong>A határidő ma van.</strong>
					{:else if p.neededPerMonth !== null}Ehhez havonta ~<strong>{formatMoney(p.neededPerMonth)}</strong> kell félretenni ({p.daysLeft} nap van hátra).{/if}
				</p>
			{/if}
		</div>
		{#if g.accountId === null && !g.archived}
			<div class="contrib">
				<input class="amt" type="text" inputmode="decimal" autocomplete="off" placeholder="összeg" aria-label={`Összeg: ${g.name}`} bind:value={amounts[g.id]}
					onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), contribute(g, 1))} />
				<button class="btn small primary" type="button" onclick={() => contribute(g, 1)}>+ Befizetés</button>
				<button class="btn small" type="button" onclick={() => contribute(g, -1)}>− Kivétel</button>
			</div>
		{/if}
		<div class="actions">
			<button class="btn small" type="button" aria-expanded={editingId === g.id} onclick={() => (editingId = editingId === g.id ? null : g.id)}>{editingId === g.id ? 'Bezár' : 'Szerkesztés'}</button>
			<button class="btn small" type="button" onclick={() => run(() => ledger.setGoalArchived(g.id, !g.archived), g.archived ? 'Cél visszaállítva' : 'Cél archiválva')}>
				{g.archived ? 'Visszaállítás' : 'Archiválás'}
			</button>
			<ConfirmButton label="Törlés" onconfirm={() => run(() => ledger.deleteGoal(g.id), 'Cél törölve')} />
		</div>
		{#if editingId === g.id}
			<hr />
			<GoalForm
				initial={g}
				submitLabel="Mentés"
				onsave={async (v) => {
					const saved = await run(() => ledger.updateGoal(g.id, v), 'Cél módosítva');
					if (saved) editingId = null;
					return saved;
				}}
				oncancel={() => (editingId = null)}
			/>
		{/if}
	</li>
{/snippet}

<div class="page">
	<div class="page-head"><h1>Megtakarítási célok</h1></div>

	<details class="card more" open={ledger.goals.length === 0}>
		<summary>+ Új cél</summary>
		<div style="margin-top:10px">
			<GoalForm submitLabel="Hozzáadás" onsave={(v) => run(() => ledger.addGoal(v), 'Cél létrehozva')} />
		</div>
	</details>

	<ul class="stack" style="list-style:none;margin:0;padding:0">
		{#each active as g, i (g.id)}
			{@render card(g, i, active.length)}
		{:else}
			<li class="card empty">Még nincs célod – adj meg egyet, és követheted a haladást.</li>
		{/each}
	</ul>

	{#if archived.length > 0}
		<section class="stack">
			<button class="btn ghost small" type="button" onclick={() => (showArchived = !showArchived)} aria-expanded={showArchived}>
				Archivált célok ({archived.length}) {showArchived ? '▲' : '▼'}
			</button>
			{#if showArchived}
				<ul class="stack" style="list-style:none;margin:0;padding:0">
					{#each archived as g, i (g.id)}{@render card(g, i, archived.length)}{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<style>
	/* Összeg + két gomb: keskeny képernyőn az összeg külön, teljes szélességű sorban, alatta egyenlő gombok. */
	.contrib {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.amt {
		grid-column: 1 / -1;
		min-height: 40px;
		padding: 4px 10px;
	}
	@media (min-width: 520px) {
		.contrib {
			grid-template-columns: minmax(8em, 1fr) auto auto;
		}
		.amt {
			grid-column: auto;
		}
	}
</style>
