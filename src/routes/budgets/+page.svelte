<script lang="ts">
	import BudgetBars from '$lib/components/BudgetBars.svelte';
	import { budgetLines, monthProgress, spentByCategory, totalBudgetLine } from '$lib/budget';
	import { clock } from '$lib/clock.svelte';
	import { formatMonthLabel } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { evaluateExpression, formatMoney, toInputAmount } from '$lib/money';
	import { toasts } from '$lib/toast.svelte';

	const month = $derived(clock.month);
	const expenseCats = $derived(ledger.activeCategories('expense'));
	const spent = $derived(spentByCategory(ledger.transactions, month));
	const lines = $derived(budgetLines(ledger.transactions, ledger.categories, month));
	const totalLine = $derived(totalBudgetLine(ledger.transactions, month, ledger.prefs.totalBudget));
	const overview = $derived(totalLine ? [totalLine, ...lines] : lines);

	/** Üres = nincs keret; különben pozitív összeg. */
	function parse(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
		if (!raw.trim()) return { ok: true, value: null };
		const r = evaluateExpression(raw);
		if (!r.ok) return r;
		if (r.value <= 0) return { ok: false, error: 'A keret pozitív összeg legyen (a törléshez hagyd üresen)' };
		return { ok: true, value: r.value };
	}

	let totalText = $state(ledger.prefs.totalBudget ? toInputAmount(ledger.prefs.totalBudget) : '');
	let totalError = $state('');
	async function saveTotal() {
		const r = parse(totalText);
		if (!r.ok) return (totalError = r.error);
		totalError = '';
		try {
			await ledger.setTotalBudget(r.value);
			toasts.show(r.value ? 'Összes havi keret mentve' : 'Összes havi keret törölve');
		} catch (e) {
			totalError = e instanceof Error ? e.message : 'A mentés nem sikerült';
		}
	}

	let errors = $state<Record<number, string>>({});
	async function saveCategory(id: number, raw: string, current: number | null) {
		const r = parse(raw);
		if (!r.ok) {
			errors[id] = r.error;
			return;
		}
		delete errors[id];
		if (r.value === current) return;
		try {
			await ledger.setCategoryBudget(id, r.value);
			toasts.show(r.value ? 'Keret mentve' : 'Keret törölve');
		} catch (e) {
			errors[id] = e instanceof Error ? e.message : 'A mentés nem sikerült';
		}
	}
</script>

<svelte:head><title>Keretek · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Havi keretek</h1></div>
	<p class="muted">
		Állíts be havi keretet kategóriánként és/vagy összesen. A főoldalon sáv mutatja, mennyit használtál el belőle
		(a jóváírások levonódnak); <strong>80%</strong> fölött figyelmeztet, <strong>100%</strong> fölött jelzi a túllépést.
	</p>

	{#if overview.length > 0}
		<section class="card" aria-labelledby="ov-title">
			<div class="card-title"><h2 id="ov-title">{formatMonthLabel(month)}</h2></div>
			<BudgetBars lines={overview} {month} pace={monthProgress(clock.today, month)} />
		</section>
	{/if}

	<section class="card stack" aria-labelledby="total-title">
		<h2 id="total-title">Összes havi keret</h2>
		<div class="field">
			<label for="total-budget">Összes kiadás havonta</label>
			<div class="row">
				<input id="total-budget" type="text" inputmode="decimal" autocomplete="off" placeholder="nincs megadva" bind:value={totalText}
					onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), saveTotal())} aria-invalid={totalError ? 'true' : undefined} />
				<button class="btn" type="button" onclick={saveTotal}>Mentés</button>
			</div>
			{#if totalError}<p class="error" role="alert">{totalError}</p>{/if}
			<p class="hint">Az összes kiadásra vonatkozó keret, a kategóriakeretektől függetlenül. Üresen hagyva nincs.</p>
		</div>
	</section>

	<section class="card stack" aria-labelledby="cat-title">
		<h2 id="cat-title">Kategóriakeretek</h2>
		<ul class="list" style="display:flex;flex-direction:column;gap:10px">
			{#each expenseCats as c (c.id)}
				<li class="row" style="border:0;align-items:flex-start">
					<span class="tx-icon" style:--dot={c.color} aria-hidden="true">{c.icon || '•'}</span>
					<div class="grow field" style="gap:2px">
						<label for={`b-${c.id}`} style="color:var(--text)">{c.name}</label>
						<span class="hint">Ebben a hónapban: {formatMoney(Math.max(0, spent.get(c.id) ?? 0))}</span>
						{#if errors[c.id]}<p class="error" role="alert">{errors[c.id]}</p>{/if}
					</div>
					<input
						id={`b-${c.id}`}
						class="budget-input num"
						type="text"
						inputmode="decimal"
						autocomplete="off"
						placeholder="nincs keret"
						value={c.monthlyBudget ? toInputAmount(c.monthlyBudget) : ''}
						aria-invalid={errors[c.id] ? 'true' : undefined}
						onchange={(e) => saveCategory(c.id, e.currentTarget.value, c.monthlyBudget)}
					/>
				</li>
			{/each}
		</ul>
		<p class="hint">A mező elhagyásakor mentődik. Üresen hagyva a keret törlődik.</p>
	</section>
</div>

<style>
	.budget-input {
		width: 9em;
		flex: none;
		text-align: right;
	}
</style>
