<script lang="ts">
	import BarChart from '$lib/components/charts/BarChart.svelte';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import MonthPager from '$lib/components/MonthPager.svelte';
	import TxRow from '$lib/components/TxRow.svelte';
	import { clock } from '$lib/clock.svelte';
	import { daysInMonth, formatMonthLabel, formatMonthShort, isValidMonth, monthOf, shiftMonth, WEEKDAY_SHORT } from '$lib/dates';
	import { forecastMonth } from '$lib/forecast';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney } from '$lib/money';
	import { go, href, query } from '$lib/nav';
	import { accountBalances, monthSummary } from '$lib/queries';
	import { route } from '$lib/route.svelte';
	import { segIndicator } from '$lib/segIndicator';
	import { analyzeSpending, categoryCompare, cumulativeSpend, monthlyTrend, periodRange, type PeriodKey } from '$lib/stats';

	const today = $derived(clock.today);
	const sp = $derived(route.params);
	const month = $derived.by(() => {
		const m = sp.get('month') ?? '';
		return isValidMonth(m) ? m : monthOf(today);
	});
	const isCurrent = $derived(month === monthOf(today));

	const PERIODS: { key: PeriodKey; label: string }[] = [
		{ key: 'month', label: 'Hónap' },
		{ key: '3m', label: '3 hó' },
		{ key: '6m', label: '6 hó' },
		{ key: '12m', label: '12 hó' },
		{ key: 'year', label: 'Év' },
		{ key: 'all', label: 'Összes' }
	];
	const period = $derived<PeriodKey>(PERIODS.find((p) => p.key === sp.get('p'))?.key ?? 'month');
	const TRENDS = [6, 12] as const;
	const trendMonths = $derived<6 | 12>(sp.get('t') === '12' ? 12 : 6);

	const update = (patch: Record<string, string | null>) =>
		go(`/stats${query({ month: sp.get('month'), p: sp.get('p'), t: sp.get('t'), ...patch })}`, { replaceState: true, noScroll: true, keepFocus: true });

	// --- trend ---
	const trend = $derived(monthlyTrend(ledger.transactions, monthOf(today), trendMonths));
	const trendActive = $derived(trend.filter((t) => t.count > 0));
	const avgExpense = $derived(trendActive.length ? Math.round(trendActive.reduce((s, t) => s + t.expense, 0) / trendActive.length) : 0);
	const avgIncome = $derived(trendActive.length ? Math.round(trendActive.reduce((s, t) => s + t.income, 0) / trendActive.length) : 0);
	const highlight = $derived(trend.findIndex((t) => t.month === month));

	// --- kumulált költés az előző hónappal, előrejelzéssel ---
	const balances = $derived(accountBalances(ledger.accounts, ledger.transactions));
	const total = $derived(ledger.activeAccounts.reduce((s, a) => s + (balances.get(a.id) ?? 0), 0));
	const forecast = $derived(isCurrent ? forecastMonth({ txs: ledger.transactions, recurring: ledger.recurring, today, currentBalance: total }) : null);
	const line = $derived.by(() => {
		const dim = daysInMonth(month);
		const through = isCurrent ? Number(today.slice(8)) : dim;
		const cur = cumulativeSpend(ledger.transactions, month, through);
		const prevRaw = cumulativeSpend(ledger.transactions, shiftMonth(month, -1));
		const prev = Array.from({ length: dim }, (_, i) => (i < prevRaw.length ? prevRaw[i] : null));
		const values = Array.from({ length: dim }, (_, i) => (i < cur.length ? cur[i] : null));
		let projection: (number | null)[] | null = null;
		if (forecast && cur.length > 0 && cur.length < dim) {
			const start = cur[cur.length - 1];
			const end = Math.max(start, forecast.projectedExpense);
			projection = Array.from({ length: dim }, (_, i) => (i < cur.length - 1 ? null : start + ((end - start) * (i - (cur.length - 1))) / (dim - cur.length)));
		}
		return { labels: Array.from({ length: dim }, (_, i) => String(i + 1)), values, prev, projection };
	});
	const hasPrev = $derived(line.prev.some((v) => v !== null && v > 0));

	// --- összevetés az előző hónappal ---
	const compare = $derived(categoryCompare(ledger.transactions, ledger.categories, month));
	const summary = $derived(monthSummary(ledger.transactions, ledger.categories, month));
	const prevSummary = $derived(monthSummary(ledger.transactions, ledger.categories, shiftMonth(month, -1)));

	// --- „mire költöttem a legtöbbet?" ---
	const firstDate = $derived(ledger.transactions.reduce((m, t) => (t.date < m ? t.date : m), today));
	const range = $derived(periodRange(period, today, month, firstDate));
	const analysis = $derived(analyzeSpending(ledger.transactions, ledger.categories, range.from, range.to, today));
	const rangeLabel = $derived(period === 'month' ? formatMonthLabel(month) : PERIODS.find((p) => p.key === period)!.label);

	const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`;
</script>

<svelte:head><title>Elemzés · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Elemzés</h1></div>

	{#if ledger.transactions.length === 0}
		<div class="card empty">Még nincs adat az elemzéshez. Vigyél fel néhány tételt!</div>
	{:else}
		<section class="card stack" aria-labelledby="trend-title">
			<div class="card-title" style="margin:0">
				<h2 id="trend-title">Havi bevétel és kiadás</h2>
				<div class="seg" role="group" aria-label="Trend hossza" use:segIndicator={TRENDS.indexOf(trendMonths)} style="min-width:120px">
					{#each TRENDS as t}
						<button type="button" class:active={trendMonths === t} onclick={() => update({ t: String(t) })}>{t} hó</button>
					{/each}
				</div>
			</div>
			<BarChart
				title={`Havi bevétel és kiadás, az elmúlt ${trendMonths} hónap`}
				labels={trend.map((t) => formatMonthShort(t.month).replace('.', ''))}
				series={[
					{ name: 'Bevétel', color: 'var(--viz-1)', values: trend.map((t) => t.income) },
					{ name: 'Kiadás', color: 'var(--viz-2)', values: trend.map((t) => t.expense) }
				]}
				format={formatMoney}
				{highlight}
			/>
			<p class="small muted">
				Havi átlag ({trendActive.length} hónap adatából): bevétel <strong class="num">{formatMoney(avgIncome)}</strong>, kiadás <strong class="num">{formatMoney(avgExpense)}</strong>.
			</p>
		</section>

		<MonthPager {month} hrefFor={(m) => `/stats${query({ month: m, p: sp.get('p'), t: sp.get('t') })}`} />

		<div class="stack vt-month" style="gap:16px">
			<section class="card stack" aria-labelledby="cum-title">
				<div class="card-title" style="margin:0"><h2 id="cum-title">Költés a hónapban, napról napra</h2></div>
				<LineChart
					title={`${formatMonthLabel(month)}: kumulált költés napról napra`}
					labels={line.labels}
					series={[
						...(hasPrev ? [{ name: formatMonthLabel(shiftMonth(month, -1)), color: 'var(--viz-muted)', values: line.prev }] : []),
						...(line.projection ? [{ name: 'Előrejelzés', color: 'var(--viz-1)', values: line.projection, dashed: true }] : []),
						{ name: formatMonthLabel(month), color: 'var(--viz-1)', values: line.values, area: true }
					]}
					format={formatMoney}
					ref={ledger.prefs.totalBudget ? { value: ledger.prefs.totalBudget, label: 'Összes havi keret' } : null}
				/>
				{#if forecast}
					<p class="small">
						Ütem szerint a hónap végére várhatóan <strong class="num exp">{formatMoney(forecast.projectedExpense)}</strong> lesz a kiadás
						({formatMoney(forecast.spent)} már elköltve, napi ~{formatMoney(forecast.dailyVariable)} változó költéssel
						{#if forecast.upcomingExpense > 0}és {formatMoney(forecast.upcomingExpense)} hátralévő ismétlődő kiadással{/if} számolva).
						{#if forecast.projectedBalance !== null}Az összegyenleg így várhatóan <strong class="num" class:exp={forecast.projectedBalance < 0}>{formatMoney(forecast.projectedBalance)}</strong> lesz.{/if}
					</p>
				{/if}
			</section>

			<section class="card stack" aria-labelledby="cmp-title">
				<div class="card-title" style="margin:0"><h2 id="cmp-title">Az előző hónaphoz képest</h2></div>
				<div class="row wrap small">
					<span>Kiadás: <strong class="num">{formatMoney(summary.expense)}</strong> (előző: {formatMoney(prevSummary.expense)})</span>
					{#if prevSummary.expense > 0}
						<strong class="num" class:exp={summary.expense > prevSummary.expense} class:inc={summary.expense < prevSummary.expense}>
							{summary.expense > prevSummary.expense ? '▲' : summary.expense < prevSummary.expense ? '▼' : '='}
							{pct((summary.expense - prevSummary.expense) / prevSummary.expense)}
						</strong>
					{/if}
				</div>
				{#if compare.length === 0}
					<p class="muted">Erre a két hónapra nincs kiadás.</p>
				{:else}
					<table class="cmp">
						<thead>
							<tr><th scope="col">Kategória</th><th scope="col" class="num">Ez a hónap</th><th scope="col" class="num">Előző</th><th scope="col" class="num">Változás</th></tr>
						</thead>
						<tbody>
							{#each compare as r (r.categoryId)}
								<tr>
									<th scope="row"><a href={href(`/transactions${query({ month, cat: r.categoryId })}`)}><span aria-hidden="true">{r.icon}</span> {r.name}</a></th>
									<td class="num">{formatMoney(r.current)}</td>
									<td class="num muted">{formatMoney(r.previous)}</td>
									<td class="num">
										<span class:exp={r.delta > 0} class:inc={r.delta < 0}>
											{r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '='}
											{r.deltaPct === null ? 'új' : pct(r.deltaPct)}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>
		</div>

		<section class="card stack" aria-labelledby="top-title">
			<div class="card-title" style="margin:0">
				<h2 id="top-title">Mire költöttem a legtöbbet?</h2>
			</div>
			<div class="seg" role="group" aria-label="Időszak" use:segIndicator={PERIODS.findIndex((p) => p.key === period)}>
				{#each PERIODS as p}
					<button type="button" class:active={period === p.key} onclick={() => update({ p: p.key === 'month' ? null : p.key })}>{p.label}</button>
				{/each}
			</div>
			{#if analysis.total <= 0}
				<p class="muted">Ebben az időszakban ({rangeLabel}) nincs kiadás.</p>
			{:else}
				<div class="row wrap">
					<div class="stat grow"><div class="label">Összes kiadás</div><div class="value exp">−{formatMoney(analysis.total)}</div></div>
					<div class="stat grow"><div class="label">Napi átlag</div><div class="value">{formatMoney(analysis.dailyAverage)}</div></div>
				</div>

				<h3>Kategóriák</h3>
				<ul class="list" style="display:flex;flex-direction:column;gap:2px">
					{#each analysis.categories.slice(0, 8) as c (c.categoryId)}
						<li style="border:0">
							<a class="stack" style="gap:6px;color:inherit;text-decoration:none;padding:6px 0" href={href(`/transactions${query({ from: range.from, to: range.to, period: 'range', cat: c.categoryId })}`)}>
								<span class="row">
									<span class="dot" style:--dot={c.color}></span>
									<span class="grow ellipsis"><span aria-hidden="true">{c.icon}</span> {c.name}</span>
									<strong class="num nowrap">{formatMoney(c.amount)}</strong>
									<span class="muted small num" style="width:3.2em;text-align:right">{Math.round(c.share * 100)}%</span>
								</span>
								<span class="bar" style:--dot={c.color}><span style:width={`${Math.max(2, c.share * 100)}%`}></span></span>
							</a>
						</li>
					{/each}
				</ul>

				{#if analysis.merchants.length > 0}
					<h3>Helyek és tételek (leírás szerint)</h3>
					<ol class="rank">
						{#each analysis.merchants.slice(0, 8) as m, i}
							<li>
								<span class="muted num" style="width:1.6em">{i + 1}.</span>
								<a class="grow ellipsis" href={href(`/transactions${query({ q: m.description, from: range.from, to: range.to, period: 'range', type: 'expense' })}`)}>{m.description}</a>
								<span class="muted small nowrap">{m.count}× · átl. {formatMoney(Math.round(m.amount / m.count))}</span>
								<strong class="num nowrap">{formatMoney(m.amount)}</strong>
							</li>
						{/each}
					</ol>
				{/if}

				<h3>Legnagyobb egyedi kiadások</h3>
				<ul class="list card flush" style="box-shadow:none">
					{#each analysis.largest as tx (tx.id)}<li><TxRow {tx} showDate /></li>{/each}
				</ul>

				<h3>Melyik napon költök a legtöbbet?</h3>
				<BarChart
					title="Átlagos költés a hét napjain"
					labels={[...WEEKDAY_SHORT]}
					series={[{ name: 'Átlagos költés az adott napon', color: 'var(--viz-1)', values: analysis.byWeekday.map((w) => w.average) }]}
					format={formatMoney}
					height={170}
				/>

				{#if analysis.byTag.length > 0}
					<h3>Címkék</h3>
					<div class="chips">
						{#each analysis.byTag.slice(0, 10) as t}
							<a class="chip" href={href(`/transactions${query({ tag: t.tag, from: range.from, to: range.to, period: 'range' })}`)}>#{t.tag} · {formatMoney(t.amount)}</a>
						{/each}
					</div>
				{/if}
			{/if}
		</section>
	{/if}
</div>

<style>
	.cmp {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	.cmp th,
	.cmp td {
		padding: 8px 4px;
		border-bottom: 1px solid var(--border);
		text-align: right;
	}
	.cmp th[scope='row'],
	.cmp thead th:first-child {
		text-align: left;
		font-weight: 600;
	}
	.cmp thead th {
		font-size: 0.78rem;
		color: var(--muted);
		font-weight: 600;
	}
	.cmp a {
		color: inherit;
	}
	.rank {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.rank li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.rank a {
		color: inherit;
	}
</style>
