<script lang="ts">
	import MonthPager from '$lib/components/MonthPager.svelte';
	import TxRow from '$lib/components/TxRow.svelte';
	import { clock } from '$lib/clock.svelte';
	import { formatDateLong, formatMonthLabel, isValidISODate, isValidMonth, monthOf, monthRange, WEEKDAY_SHORT } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { formatCompact, formatMoney, formatNet } from '$lib/money';
	import { go, href, query } from '$lib/nav';
	import { compareTx, filterTransactions, monthSummary } from '$lib/queries';
	import { route } from '$lib/route.svelte';
	import { calendarWeeks } from '$lib/stats';

	const today = $derived(clock.today);
	const sp = $derived(route.params);
	const month = $derived.by(() => {
		const m = sp.get('month') ?? '';
		if (isValidMonth(m)) return m;
		const d = sp.get('day') ?? '';
		return isValidISODate(d) ? monthOf(d) : monthOf(today);
	});
	/** A kijelölt nap: ?day=…, különben a mai nap (ha ebben a hónapban van). */
	const selected = $derived.by(() => {
		const d = sp.get('day') ?? '';
		if (isValidISODate(d) && monthOf(d) === month) return d;
		return monthOf(today) === month ? today : null;
	});

	const weeks = $derived(calendarWeeks(ledger.transactions, month, ledger.recurring));
	const summary = $derived(monthSummary(ledger.transactions, ledger.categories, month));
	const maxExpense = $derived(Math.max(1, ...weeks.flat().map((c) => c.expense)));
	/** A napi kiadás 0–4 fokozatú „hőtérkép" szintje (egy színárnyalat, világostól sötétig). */
	const level = (expense: number) => (expense <= 0 ? 0 : Math.min(4, Math.ceil((expense / maxExpense) * 4)));

	const dayTxs = $derived(selected ? filterTransactions(ledger.transactions, { from: selected, to: selected }).sort(compareTx) : []);
	const range = $derived(monthRange(month));

	const pick = (date: string) => go(`/calendar${query({ month, day: date })}`, { replaceState: true, noScroll: true, keepFocus: true });
	const label = (c: (typeof weeks)[number][number]) =>
		[
			formatDateLong(c.date!, today),
			c.expense > 0 ? `kiadás ${formatMoney(c.expense)}` : c.expense < 0 ? `jóváírás ${formatMoney(-c.expense)}` : 'nincs kiadás',
			c.income > 0 ? `bevétel ${formatMoney(c.income)}` : '',
			c.count ? `${c.count} tétel` : '',
			c.recurring ? `${c.recurring} esedékes ismétlődő tétel` : ''
		]
			.filter(Boolean)
			.join(', ');
</script>

<svelte:head><title>Naptár · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>Naptár</h1></div>

	<MonthPager {month} hrefFor={(m) => `/calendar${query({ month: m })}`} />

	<div class="stack vt-month" style="gap:16px">
		<div class="stats" aria-label="Havi összesítő">
			<div class="stat"><div class="label">Bevétel</div><div class="value inc">+{formatMoney(summary.income)}</div></div>
			<div class="stat"><div class="label">Kiadás</div><div class="value exp">−{formatMoney(Math.max(0, summary.expense))}</div></div>
			<div class="stat"><div class="label">Egyenleg</div><div class="value" class:inc={summary.balance > 0} class:exp={summary.balance < 0}>{formatNet(summary.balance)}</div></div>
		</div>

		<section class="card" aria-label={`${formatMonthLabel(month)} naptára`}>
			<table class="cal" data-testid="calendar">
				<thead>
					<tr>{#each WEEKDAY_SHORT as d}<th scope="col">{d}</th>{/each}</tr>
				</thead>
				<tbody>
					{#each weeks as week}
						<tr>
							{#each week as c}
								<td>
									{#if c.date}
										<button
											type="button"
											class={`day lv${level(c.expense)}`}
											class:today={c.date === today}
											class:selected={c.date === selected}
											aria-label={label(c)}
											aria-pressed={c.date === selected}
											onclick={() => pick(c.date!)}
										>
											<span class="dn">{c.day}</span>
											{#if c.expense !== 0}<span class="amt">{c.expense < 0 ? '+' : ''}{formatCompact(Math.abs(c.expense))}</span>{/if}
											<span class="marks" aria-hidden="true">
												{#if c.income > 0}<i class="m-inc"></i>{/if}
												{#if c.recurring > 0}<i class="m-rec"></i>{/if}
											</span>
										</button>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			<div class="legend small muted" aria-hidden="true">
				<span>kevesebb kiadás</span>
				{#each [1, 2, 3, 4] as l}<i class={`swatch lv${l}`}></i>{/each}
				<span>több</span>
				<span class="sep"></span>
				<i class="m-inc"></i> bevétel
				<i class="m-rec"></i> esedékes ismétlődő
			</div>
		</section>

		{#if selected}
			<section class="card flush" aria-labelledby="day-title">
				<div class="card-title" style="padding:16px 16px 0">
					<h2 id="day-title">{formatDateLong(selected, today)}</h2>
					<a class="btn small primary" href={href(`/new${query({ date: selected })}`)}>+ Tétel erre a napra</a>
				</div>
				{#if dayTxs.length === 0}
					<p class="muted" style="padding:0 16px 16px">Ezen a napon nincs tétel.</p>
				{:else}
					<ul class="list">
						{#each dayTxs as tx (tx.id)}<li><TxRow {tx} /></li>{/each}
					</ul>
				{/if}
			</section>
		{:else}
			<p class="hint center">Válassz egy napot a részletekhez.</p>
		{/if}

		<p class="center"><a class="small" href={href(`/transactions${query({ from: range.from, to: range.to, period: 'range' })}`)}>A hónap összes tétele listában</a></p>
	</div>
</div>

<style>
	.cal {
		width: 100%;
		border-collapse: separate;
		border-spacing: 3px;
		table-layout: fixed;
	}
	.cal th {
		font-size: 0.75rem;
		color: var(--muted);
		font-weight: 600;
		padding: 2px 0 4px;
	}
	.cal td {
		padding: 0;
	}
	.day {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: space-between;
		width: 100%;
		min-height: 54px;
		padding: 4px 5px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
		font-size: 0.7rem;
		text-align: left;
	}
	.dn {
		font-weight: 700;
		font-size: 0.8rem;
	}
	.amt {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		line-height: 1;
	}
	/* egy színárnyalat (a kiadás színe), világostól sötétig – a szám is ott van, így nem csak színnel érthető */
	.day.lv1,
	.swatch.lv1 {
		background: color-mix(in srgb, var(--viz-2) 14%, var(--surface));
	}
	.day.lv2,
	.swatch.lv2 {
		background: color-mix(in srgb, var(--viz-2) 30%, var(--surface));
	}
	.day.lv3,
	.swatch.lv3 {
		background: color-mix(in srgb, var(--viz-2) 48%, var(--surface));
	}
	.day.lv4,
	.swatch.lv4 {
		background: color-mix(in srgb, var(--viz-2) 68%, var(--surface));
	}
	.day.today {
		border-color: var(--primary);
	}
	.day.selected {
		outline: 3px solid var(--primary);
		outline-offset: 1px;
	}
	.marks {
		display: flex;
		gap: 3px;
		min-height: 6px;
	}
	.m-inc,
	.m-rec {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--viz-1);
	}
	.m-rec {
		border-radius: 2px;
		background: var(--text);
		opacity: 0.6;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
	}
	.swatch {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 3px;
	}
	.sep {
		flex: 1;
	}
</style>
