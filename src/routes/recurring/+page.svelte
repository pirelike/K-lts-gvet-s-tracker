<script lang="ts">
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import DueList from '$lib/components/DueList.svelte';
	import RecurringForm from '$lib/components/RecurringForm.svelte';
	import { clock } from '$lib/clock.svelte';
	import { addDays, formatDateLong } from '$lib/dates';
	import { ledger, LedgerError } from '$lib/ledger.svelte';
	import { formatMoney } from '$lib/money';
	import { describeSchedule, nextOccurrence, upcomingItems } from '$lib/recurring';
	import { toasts } from '$lib/toast.svelte';
	import { TX_TYPE_LABEL, type Recurring } from '$lib/types';

	let editingId = $state<number | null>(null);

	const rules = $derived([...ledger.recurring].sort((a, b) => Number(b.active) - Number(a.active) || (nextOccurrence(a) ?? '9999') .localeCompare(nextOccurrence(b) ?? '9999')));
	const upcoming = $derived(upcomingItems(ledger.recurring, clock.today, addDays(clock.today, 30)));

	async function run(fn: () => Promise<unknown>, ok?: string) {
		try {
			await fn();
			if (ok) toasts.show(ok);
		} catch (e) {
			toasts.error(e instanceof LedgerError || e instanceof Error ? e.message : 'A művelet nem sikerült');
		}
	}

	const nameOf = (r: Recurring) => r.description || (r.type === 'transfer' ? 'Átvezetés' : (ledger.catById.get(r.categoryId ?? -1)?.name ?? 'Tétel'));
</script>

<svelte:head><title>Ismétlődő tételek · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Ismétlődő tételek</h1></div>
	<p class="muted">
		Albérlet, előfizetések, ösztöndíj: az esedékes tételek az app megnyitásakor a főoldalon várnak, egy érintéssel jóváhagyhatók.
		Nincs szerver, ezért magától nem jön létre semmi – a jóváhagyás a te döntésed.
	</p>

	<DueList />

	<details class="card more" open={ledger.recurring.length === 0}>
		<summary>+ Új ismétlődő tétel</summary>
		<div style="margin-top:10px">
			<RecurringForm submitLabel="Hozzáadás" onsave={(v) => run(() => ledger.addRecurring(v), 'Ismétlődő tétel létrehozva')} />
		</div>
	</details>

	<ul class="stack" style="list-style:none;margin:0;padding:0">
		{#each rules as r (r.id)}
			{@const next = nextOccurrence(r)}
			<li class="card stack">
				<div class="row">
					<div class="grow">
						<strong>{nameOf(r)}</strong>
						<span class="badge">{TX_TYPE_LABEL[r.type]}</span>
						{#if !r.active}<span class="badge">szünetel</span>{/if}
						<div class="muted small">
							{describeSchedule(r)}
							· {#if !r.active}szünetel{:else if next}következő: {formatDateLong(next, clock.today)}{:else}lejárt{/if}
						</div>
					</div>
					<strong class="num" class:exp={r.type === 'expense'} class:inc={r.type === 'income'}>
						{r.type === 'income' ? '+' : r.type === 'expense' ? '−' : ''}{formatMoney(r.amount)}
					</strong>
				</div>
				<div class="row wrap">
					<button class="btn small" type="button" onclick={() => (editingId = editingId === r.id ? null : r.id)}>
						{editingId === r.id ? 'Bezár' : 'Szerkesztés'}
					</button>
					<button class="btn small" type="button" onclick={() => run(() => ledger.setRecurringActive(r.id, !r.active), r.active ? 'Szüneteltetve' : 'Újra aktív')}>
						{r.active ? 'Szüneteltetés' : 'Folytatás'}
					</button>
					<ConfirmButton label="Törlés" question="A már létrehozott tételek megmaradnak." onconfirm={() => run(() => ledger.deleteRecurring(r.id), 'Ismétlődő tétel törölve')} />
				</div>
				{#if editingId === r.id}
					<RecurringForm
						initial={r}
						submitLabel="Mentés"
						onsave={async (v) => {
							await run(() => ledger.updateRecurring(r.id, v), 'Módosítva');
							editingId = null;
						}}
						oncancel={() => (editingId = null)}
					/>
				{/if}
			</li>
		{:else}
			<li class="card empty">Még nincs ismétlődő tételed.</li>
		{/each}
	</ul>

	{#if upcoming.length > 0}
		<section class="card" aria-labelledby="up-title">
			<div class="card-title"><h2 id="up-title">Következő 30 nap</h2></div>
			<ul class="list">
				{#each upcoming as u (u.rule.id + u.date)}
					<li class="row" style="padding:8px 0">
						<span class="muted small" style="width:8.5em">{formatDateLong(u.date, clock.today)}</span>
						<span class="grow ellipsis">{nameOf(u.rule)}</span>
						<span class="num" class:exp={u.rule.type === 'expense'} class:inc={u.rule.type === 'income'}>
							{u.rule.type === 'income' ? '+' : u.rule.type === 'expense' ? '−' : ''}{formatMoney(u.rule.amount)}
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
