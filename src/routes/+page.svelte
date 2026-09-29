<script lang="ts">
	import { route } from '$lib/route.svelte';
	import { auth } from '$lib/auth.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MonthPager from '$lib/components/MonthPager.svelte';
	import TxRow from '$lib/components/TxRow.svelte';
	import { isValidMonth, monthOf, todayISO } from '$lib/dates';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney, formatNet } from '$lib/money';
	import { href, query } from '$lib/nav';
	import { accountBalances, compareTx, monthSummary } from '$lib/queries';

	const today = todayISO();
	const month = $derived.by(() => {
		const m = route.params.get('month') ?? '';
		return isValidMonth(m) ? m : monthOf(today);
	});

	const summary = $derived(monthSummary(ledger.transactions, ledger.categories, month));
	const balances = $derived(accountBalances(ledger.accounts, ledger.transactions));
	const totalBalance = $derived(
		ledger.activeAccounts.reduce((sum, a) => sum + (balances.get(a.id) ?? 0), 0)
	);
	const recent = $derived([...ledger.transactions].sort(compareTx).slice(0, 5));

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
				<div class="value exp">−{formatMoney(summary.expense)}</div>
			</div>
			<div class="stat">
				<div class="label">Egyenleg</div>
				<div class="value" class:inc={summary.balance > 0} class:exp={summary.balance < 0}>
					{formatNet(summary.balance)}
				</div>
			</div>
		</div>

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
					Nyomd meg a <strong>+</strong> gombot az első bevétel vagy kiadás rögzítéséhez.
				</p>
				<a class="btn primary" href={href('/new')}>Első tétel felvitele</a>
			</div>
		{:else}
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

			<section class="card" aria-labelledby="acc-title">
				<div class="card-title">
					<h2 id="acc-title">Számlák</h2>
					<a class="small" href={href('/accounts')}>Részletek</a>
				</div>
				<ul class="list">
					{#each ledger.activeAccounts as a (a.id)}
						{@const b = balances.get(a.id) ?? 0}
						<li class="row" style="padding:8px 0">
							<span class="grow">{a.name}</span>
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
