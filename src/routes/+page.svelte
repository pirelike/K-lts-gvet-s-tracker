<script lang="ts">
	import { route } from '$lib/route.svelte';
	import { auth } from '$lib/auth.svelte';
	import BudgetBars from '$lib/components/BudgetBars.svelte';
	import DueList from '$lib/components/DueList.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MonthPager from '$lib/components/MonthPager.svelte';
	import QuickEntry from '$lib/components/QuickEntry.svelte';
	import TxRow from '$lib/components/TxRow.svelte';
	import { budgetAlerts, budgetLines, monthProgress, totalBudgetLine } from '$lib/budget';
	import { clock } from '$lib/clock.svelte';
	import { forecastMonth } from '$lib/forecast';
	import { goalProgress } from '$lib/goals';
	import { isValidMonth, monthOf } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney, formatNet } from '$lib/money';
	import { href, query } from '$lib/nav';
	import { accountBalances, compareTx, monthSummary } from '$lib/queries';
	import { ACCOUNT_TYPE_LABEL } from '$lib/types';

	const today = $derived(clock.today);
	const month = $derived.by(() => {
		const m = route.params.get('month') ?? '';
		return isValidMonth(m) ? m : monthOf(today);
	});
	const isCurrent = $derived(month === monthOf(today));

	const summary = $derived(monthSummary(ledger.transactions, ledger.categories, month));
	const balances = $derived(accountBalances(ledger.accounts, ledger.transactions));
	const totalBalance = $derived(
		ledger.activeAccounts.reduce((sum, a) => sum + (balances.get(a.id) ?? 0), 0)
	);
	const recent = $derived([...ledger.transactions].sort(compareTx).slice(0, 5));

	// --- havi keretek ---
	const lines = $derived(budgetLines(ledger.transactions, ledger.categories, month));
	const totalLine = $derived(totalBudgetLine(ledger.transactions, month, ledger.prefs.totalBudget));
	const allLines = $derived(totalLine ? [totalLine, ...lines] : lines);
	const alerts = $derived(budgetAlerts(allLines));

	// --- előrejelzés (csak a folyó hónapra) ---
	const forecast = $derived(
		isCurrent && ledger.transactions.length > 0
			? forecastMonth({ txs: ledger.transactions, recurring: ledger.recurring, today, currentBalance: totalBalance })
			: null
	);

	// --- célok ---
	const goals = $derived(
		ledger.goals
			.filter((g) => !g.archived)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.slice(0, 3)
			.map((g) => ({ goal: g, p: goalProgress(g, balances, today) }))
	);

	// Az adatok csak a böngészőben vannak: a saját tételek felhalmozódása után emlékeztetünk a mentésre.
	const DAY = 86_400_000;
	const needsBackup = $derived(
		ledger.transactions.filter((t) => !t.demo).length >= 20 &&
			(auth.lastBackupAt === null || Date.now() - auth.lastBackupAt > 30 * DAY)
	);
</script>

<svelte:head><title>Főoldal · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head">
		<h1>Főoldal</h1>
		<button type="button" class="btn small" onclick={() => auth.lock()} aria-label="Zárolás">
			<Icon name="lock" size={18} /> Zárolás
		</button>
	</div>

	<DueList />
	<QuickEntry />

	<MonthPager {month} hrefFor={(m) => `/${query({ month: m })}`} />

	<!-- A hónapfüggő tartalom lapozáskor oldalra csúszik (app.css: .vt-month). -->
	<div class="stack vt-month" style="gap:16px">
		<div class="stats" aria-label="Havi összesítő">
			<div class="stat">
				<div class="label">Bevétel</div>
				<div class="value inc">+{formatMoney(summary.income)}</div>
			</div>
			<div class="stat">
				<div class="label">Kiadás</div>
				<div class="value" class:exp={summary.expense >= 0} class:inc={summary.expense < 0}>{summary.expense < 0 ? '+' : '−'}{formatMoney(Math.abs(summary.expense))}</div>
				{#if summary.refund > 0}<div class="label" style="font-weight:500">jóváírással: −{formatMoney(summary.refund)}</div>{/if}
			</div>
			<div class="stat">
				<div class="label">Egyenleg</div>
				<div class="value" class:inc={summary.balance > 0} class:exp={summary.balance < 0}>
					{formatNet(summary.balance)}
				</div>
			</div>
		</div>

		{#if alerts.length > 0}
			<div class="notice warn stack" role="status" style="gap:4px" data-testid="budget-alerts">
				{#each alerts as a (a.categoryId ?? 'total')}
					<div>
						<strong>{a.level === 'over' ? '⚠ Túllépted' : 'Figyelem:'}</strong>
						{a.icon} {a.name} – {Math.round(a.ratio * 100)}%
						({a.level === 'over' ? `${formatMoney(-a.remaining)}-tal a keret fölött` : `még ${formatMoney(a.remaining)} maradt`})
					</div>
				{/each}
			</div>
		{/if}

		{#if needsBackup}
			<div class="notice warn" role="status">
				{auth.lastBackupAt === null ? 'Még nem készítettél biztonsági mentést.' : 'Több mint egy hónapja nem volt biztonsági mentés.'}
				Az adataid csak ezen az eszközön vannak –
				<a href={href('/settings')}>mentés a Beállításokban</a>.
			</div>
		{/if}

		{#if ledger.transactions.length === 0}
			<div class="card stack center">
				<h2>Még nincs egyetlen tétel sem</h2>
				<p class="muted">
					Írd be fent a gyorsbevitelbe (pl. „kávé 890"), vagy nyomd meg a <strong>+</strong> gombot az első bevétel vagy kiadás rögzítéséhez.
				</p>
				<a class="btn primary" href={href('/new')}>Első tétel felvitele</a>
			</div>
		{:else}
			{#if allLines.length > 0}
				<section class="card" aria-labelledby="budget-title">
					<div class="card-title">
						<h2 id="budget-title">Havi keretek</h2>
						<a class="small" href={href('/budgets')}>Beállítás</a>
					</div>
					<BudgetBars lines={allLines} {month} pace={isCurrent ? monthProgress(today, month) : null} />
					{#if isCurrent}<p class="hint" style="margin-top:8px">A függőleges jel a hónap eddig eltelt részét mutatja.</p>{/if}
				</section>
			{:else}
				<div class="notice">
					Állíts be havi keretet a kategóriákhoz – a főoldalon sáv mutatja a kihasználtságát.
					<a href={href('/budgets')}>Keretek beállítása</a>
				</div>
			{/if}

			{#if forecast}
				<section class="card stack" style="gap:8px" aria-labelledby="fc-title" data-testid="forecast">
					<div class="card-title" style="margin:0">
						<h2 id="fc-title">Várható hó végi állás</h2>
						<a class="small" href={href('/stats')}>Elemzés</a>
					</div>
					<div class="row">
						<span class="grow muted">Várható havi kiadás</span>
						<strong class="num exp" style="font-size:1.25rem">−{formatMoney(forecast.projectedExpense)}</strong>
					</div>
					{#if ledger.prefs.totalBudget}
						<div class="row small">
							<span class="grow muted">Összes havi keret</span>
							<span class="num" class:exp={forecast.projectedExpense > ledger.prefs.totalBudget}>
								{formatMoney(ledger.prefs.totalBudget)}
								({forecast.projectedExpense > ledger.prefs.totalBudget ? 'ütem szerint túllépnéd' : 'belefér'})
							</span>
						</div>
					{/if}
					{#if forecast.projectedBalance !== null}
						<div class="row small">
							<span class="grow muted">Várható összegyenleg hó végén</span>
							<span class="num" class:exp={forecast.projectedBalance < 0}>{formatMoney(forecast.projectedBalance)}</span>
						</div>
					{/if}
					<p class="hint">
						Eddig {formatMoney(forecast.spent)}, napi ~{formatMoney(forecast.dailyVariable)} változó költéssel
						{#if forecast.upcomingExpense > 0}és {formatMoney(forecast.upcomingExpense)} hátralévő ismétlődő kiadással{/if}
						számolva ({forecast.daysLeft} nap van hátra).
					</p>
				</section>
			{/if}

			<section class="card" aria-labelledby="exp-title">
				<div class="card-title">
					<h2 id="exp-title">Kiadások kategóriánként</h2>
					<span class="muted small">{summary.expenseByCategory.reduce((n, c) => n + c.count, 0)} tétel</span>
				</div>
				{#if summary.expenseByCategory.length === 0}
					<p class="muted">Ebben a hónapban nincs kiadás.</p>
				{:else}
					<ul class="list" style="display:flex;flex-direction:column;gap:2px">
						{#each summary.expenseByCategory as c (c.categoryId)}
							<li style="border:0">
								<a
									class="stack"
									style="gap:6px;color:inherit;text-decoration:none;padding:8px 0"
									href={href(`/transactions${query({ month, cat: c.categoryId, type: 'expense' })}`)}
								>
									<span class="row">
										<span class="dot" style:--dot={c.color}></span>
										<span class="grow ellipsis"><span aria-hidden="true">{c.icon}</span> {c.name}</span>
										<span class="num nowrap"><strong>{formatMoney(c.amount)}</strong></span>
										<span class="muted small num" style="width:3.2em;text-align:right">{Math.round(c.share * 100)}%</span>
									</span>
									<span class="bar" style:--dot={c.color}><span style:width={`${Math.max(2, c.share * 100)}%`}></span></span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
				{#if summary.incomeByCategory.length > 0}
					<details class="more" style="margin-top:8px">
						<summary>Bevételek kategóriánként</summary>
						<ul class="list">
							{#each summary.incomeByCategory as c (c.categoryId)}
								<li>
									<a class="row" style="color:inherit;text-decoration:none;padding:10px 0" href={href(`/transactions${query({ month, cat: c.categoryId, type: 'income' })}`)}>
										<span class="dot" style:--dot={c.color}></span>
										<span class="grow"><span aria-hidden="true">{c.icon}</span> {c.name}</span>
										<strong class="num inc">+{formatMoney(c.amount)}</strong>
									</a>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</section>

			{#if goals.length > 0}
				<section class="card stack" style="gap:12px" aria-labelledby="goal-title">
					<div class="card-title" style="margin:0">
						<h2 id="goal-title">Megtakarítási céljaim</h2>
						<a class="small" href={href('/goals')}>Összes</a>
					</div>
					{#each goals as { goal, p } (goal.id)}
						<div class="stack" style="gap:4px">
							<span class="row">
								<span class="grow ellipsis"><span aria-hidden="true">{goal.icon}</span> <strong>{goal.name}</strong></span>
								<span class="num small nowrap">{formatMoney(p.current)} / {formatMoney(p.target)}</span>
							</span>
							<span class="bar" style:--dot={goal.color}><span style:width={`${Math.max(p.ratio > 0 ? 2 : 0, p.ratio * 100)}%`}></span></span>
						</div>
					{/each}
				</section>
			{/if}

			<section class="card" aria-labelledby="acc-title">
				<div class="card-title">
					<h2 id="acc-title">Számlák</h2>
					<a class="small" href={href('/accounts')}>Részletek</a>
				</div>
				<ul class="list">
					{#each ledger.activeAccounts as a (a.id)}
						{@const b = balances.get(a.id) ?? 0}
						<li class="row" style="padding:8px 0">
							<span class="grow">{a.name} <span class="badge">{ACCOUNT_TYPE_LABEL[a.type]}</span></span>
							<strong class="num" class:exp={b < 0}>{formatMoney(b)}</strong>
						</li>
					{/each}
					<li class="row" style="padding:10px 0">
						<span class="grow muted">Összesen</span>
						<strong class="num" class:exp={totalBalance < 0}>{formatMoney(totalBalance)}</strong>
					</li>
				</ul>
			</section>

			<section class="card flush" aria-labelledby="recent-title">
				<div class="card-title" style="padding:16px 16px 0">
					<h2 id="recent-title">Utolsó tételek</h2>
					<a class="small" href={href('/transactions')}>Összes tétel</a>
				</div>
				<ul class="list">
					{#each recent as tx (tx.id)}
						<li><TxRow {tx} showDate /></li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</div>
