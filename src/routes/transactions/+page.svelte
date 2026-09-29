<script lang="ts">
	import { route } from '$lib/route.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MonthPager from '$lib/components/MonthPager.svelte';
	import TxRow from '$lib/components/TxRow.svelte';
	import { deleteTxsWithUndo, updateTxsWithUndo } from '$lib/actions';
	import { clock } from '$lib/clock.svelte';
	import { transactionsToCsv } from '$lib/csvExport';
	import { formatDateShort, formatDayLabel, isValidISODate, isValidMonth, monthOf, monthRange } from '$lib/dates';
	import { downloadText } from '$lib/download';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney, formatNet, parseAmount } from '$lib/money';
	import { go, href, query } from '$lib/nav';
	import { segIndicator } from '$lib/segIndicator';
	import { filterTransactions, groupByDay, summarize, usedTags, type TxFilters } from '$lib/queries';
	import { toasts } from '$lib/toast.svelte';
	import { TX_TYPE_LABEL, type TxType } from '$lib/types';
	import { tick, untrack } from 'svelte';

	/** Ennyi tétel jelenik meg egyszerre; a „Továbbiak betöltése" gomb újabb részt tölt be. */
	const PAGE = 100;
	const today = $derived(clock.today);
	const sp = $derived(route.params);

	const num = (key: string) => {
		const v = Number(sp.get(key));
		return Number.isInteger(v) && v > 0 ? v : null;
	};
	const amountParam = (key: string) => {
		const raw = sp.get(key);
		if (!raw) return null;
		const r = parseAmount(raw);
		return r.ok ? r.value : null;
	};
	const dateParam = (key: string) => {
		const v = sp.get(key) ?? '';
		return isValidISODate(v) ? v : '';
	};

	const q = $derived(sp.get('q') ?? '');
	const typeParam = $derived(sp.get('type'));
	const type = $derived<TxType | ''>(
		typeParam === 'income' || typeParam === 'expense' || typeParam === 'transfer' || typeParam === 'refund' ? typeParam : ''
	);
	const categoryId = $derived(num('cat'));
	const accountId = $derived(num('acc'));
	const tag = $derived(sp.get('tag') ?? '');
	const minRaw = $derived(sp.get('min') ?? '');
	const maxRaw = $derived(sp.get('max') ?? '');
	const from = $derived(dateParam('from'));
	const to = $derived(dateParam('to'));

	const filterCount = $derived(
		[categoryId, accountId, tag, minRaw, maxRaw, from, to].filter(Boolean).length
	);
	const anyFilter = $derived(!!q || !!type || filterCount > 0);
	// A típus-szűrő csak nézet, nem váltja át az időszakot; a keresés és a többi szűrő igen.
	const searching = $derived(!!q || filterCount > 0);

	/**
	 * Időszak: ha nincs kifejezetten megadva, akkor
	 * egyéni dátum → „Időszak", ?month → „Hónap", keresés vagy szűrő → „Összes", különben a mai hónap.
	 */
	const period = $derived.by<'month' | 'range' | 'all'>(() => {
		const p = sp.get('period');
		if (p === 'month' || p === 'range' || p === 'all') return p;
		if (sp.has('from') || sp.has('to')) return 'range';
		if (sp.has('month')) return 'month';
		return searching ? 'all' : 'month';
	});
	const month = $derived.by(() => {
		const m = sp.get('month') ?? '';
		return isValidMonth(m) ? m : monthOf(today);
	});

	const filters = $derived<TxFilters>({
		q,
		type,
		categoryId,
		accountId,
		tag,
		min: amountParam('min'),
		max: amountParam('max'),
		...(period === 'month'
			? monthRange(month)
			: period === 'range'
				? { from: from || undefined, to: to || undefined }
				: {})
	});

	const results = $derived(filterTransactions(ledger.transactions, filters));
	const totals = $derived(summarize(results));
	const tags = $derived(usedTags(ledger.transactions));

	// --- „Továbbiak betöltése" ---
	let visible = $state(PAGE);
	// A szűrés, keresés vagy időszak változásakor újra az első oldal látszik.
	const filterKey = $derived(JSON.stringify(filters));
	$effect(() => {
		filterKey;
		untrack(() => (visible = PAGE));
	});
	const shown = $derived(results.slice(0, visible));
	const groups = $derived(groupByDay(shown));
	const remaining = $derived(Math.max(0, results.length - visible));

	// --- csoportos műveletek ---
	let selecting = $state(false);
	let selected = $state<Set<number>>(new Set());
	const selectedIds = $derived([...selected]);
	function toggle(id: number) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}
	function stopSelecting() {
		selecting = false;
		selected = new Set();
	}
	// A szűrés változásakor csak a még látható találatok maradnak kijelölve.
	$effect(() => {
		const ids = new Set(results.map((t) => t.id));
		untrack(() => {
			if ([...selected].some((id) => !ids.has(id))) selected = new Set([...selected].filter((id) => ids.has(id)));
		});
	});
	let bulkTag = $state('');
	async function bulkCategory(e: Event & { currentTarget: HTMLSelectElement }) {
		const id = Number(e.currentTarget.value);
		e.currentTarget.value = '';
		if (id) await updateTxsWithUndo(selectedIds, { categoryId: id }, 'Kategória módosítva');
	}
	async function bulkAccount(e: Event & { currentTarget: HTMLSelectElement }) {
		const id = Number(e.currentTarget.value);
		e.currentTarget.value = '';
		if (id) await updateTxsWithUndo(selectedIds, { accountId: id }, 'Számla módosítva');
	}
	async function bulkAddTag() {
		const tag = bulkTag.trim().replace(/^#/, '').toLocaleLowerCase('hu');
		if (!tag) return;
		if (await updateTxsWithUndo(selectedIds, { addTags: [tag] }, `#${tag} címke hozzáadva`)) bulkTag = '';
	}
	async function bulkDelete() {
		const n = await deleteTxsWithUndo(selectedIds);
		if (n > 0) stopSelecting();
	}

	// --- CSV-export a jelenlegi találatokról ---
	function exportCsv() {
		downloadText(`tetelek-${today}.csv`, transactionsToCsv(results, ledger.categories, ledger.accounts), 'text/csv;charset=utf-8');
		toasts.show(`${results.length} tétel exportálva (CSV)`);
	}

	// --- mentett szűrők ---
	/** A jelenlegi szűrő lekérdezése hónap nélkül (a „Hónap" időszak az alapértelmezett, azt nem mentjük). */
	const currentQuery = $derived(
		query({
			q: q.trim(),
			type,
			cat: categoryId,
			acc: accountId,
			tag,
			min: minRaw,
			max: maxRaw,
			from: period === 'range' ? from : '',
			to: period === 'range' ? to : '',
			period: period === 'month' ? '' : period
		}).replace(/^\?/, '')
	);
	let filterName = $state('');
	let filterError = $state('');
	async function saveFilter() {
		const name = filterName.trim();
		if (!name) filterError = 'Adj nevet a szűrőnek';
		else if (name.length > 40) filterError = 'A név legfeljebb 40 karakter lehet';
		else if (ledger.filters.some((f) => f.name.toLocaleLowerCase('hu') === name.toLocaleLowerCase('hu'))) {
			filterError = 'Már van ilyen nevű mentett szűrő';
		} else filterError = '';
		if (filterError) return;
		try {
			await ledger.addFilter(name, currentQuery);
			toasts.show(`Szűrő mentve: ${name}`);
			filterName = '';
		} catch (e) {
			filterError = e instanceof Error ? e.message : 'A mentés nem sikerült';
		}
	}
	const normalize = (qs: string) => [...new URLSearchParams(qs).entries()].sort().map(([k, v]) => `${k}=${v}`).join('&');

	// --- URL frissítése (a keresés élő, késleltetve) ---
	function update(patch: Record<string, string | number | null>) {
		const next: Record<string, string | null> = {};
		for (const key of ['q', 'type', 'cat', 'acc', 'tag', 'min', 'max', 'from', 'to', 'month', 'period']) {
			const v = key in patch ? patch[key] : sp.get(key);
			next[key] = v === null || v === undefined || v === '' ? null : String(v);
		}
		return go(`/transactions${query(next)}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	let qInput = $state(untrack(() => sp.get('q') ?? ''));
	let pushedQ = untrack(() => sp.get('q') ?? '');
	let timer: ReturnType<typeof setTimeout> | undefined;
	function onSearchInput() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			pushedQ = qInput;
			update({ q: qInput.trim() });
		}, 200);
	}
	// Külső navigáció (pl. a főoldalról érkező link) esetén a beviteli mező követi az URL-t.
	$effect(() => {
		if (q !== pushedQ) {
			qInput = q;
			pushedQ = q;
		}
	});

	const PERIODS = ['month', 'range', 'all'] as const;
	function setPeriod(p: (typeof PERIODS)[number]) {
		update({ period: p, ...(p === 'month' ? { month, from: null, to: null } : {}) });
	}

	/** Minden szűrő és a keresés törlése; a hónap és az „Összes" időszak marad. */
	const clearHref = $derived(
		href(`/transactions${query({ month: sp.get('month'), period: sp.get('period') === 'all' ? 'all' : undefined })}`)
	);

	/** A „Szűrők" mögé rejtett aktív szűrők chipként, egyenként törölhetően. */
	interface FilterChip {
		key: string;
		/** Képernyőolvasónak: mi ez a szűrő. */
		kind: string;
		label: string;
		clear: Record<string, null>;
	}
	const chips = $derived.by<FilterChip[]>(() => {
		const list: FilterChip[] = [];
		if (categoryId) {
			const c = ledger.catById.get(categoryId);
			list.push({ key: 'cat', kind: 'Kategória', label: c ? `${c.icon} ${c.name}` : 'Ismeretlen kategória', clear: { cat: null } });
		}
		if (accountId) {
			list.push({ key: 'acc', kind: 'Számla', label: ledger.accById.get(accountId)?.name ?? 'Ismeretlen számla', clear: { acc: null } });
		}
		if (tag) list.push({ key: 'tag', kind: 'Címke', label: `#${tag}`, clear: { tag: null } });
		// A jóváírás típus nincs a gyorsválasztón, ezért itt látszik, hogy aktív.
		if (type === 'refund') list.push({ key: 'type', kind: 'Típus', label: TX_TYPE_LABEL.refund, clear: { type: null } });
		const min = amountParam('min');
		const max = amountParam('max');
		if (minRaw) list.push({ key: 'min', kind: 'Minimum összeg', label: `Min. ${min != null ? formatMoney(min) : minRaw}`, clear: { min: null } });
		if (maxRaw) list.push({ key: 'max', kind: 'Maximum összeg', label: `Max. ${max != null ? formatMoney(max) : maxRaw}`, clear: { max: null } });
		// A dátumhatár csak „Időszak" nézetben szűr; az utolsó törlésekor az időszak is automatikusra vált.
		if (period !== 'range') return list;
		if (from) list.push({ key: 'from', kind: 'Kezdő dátum', label: `Ettől: ${formatDateShort(from, today)}`, clear: to ? { from: null } : { from: null, period: null } });
		if (to) list.push({ key: 'to', kind: 'Záró dátum', label: `Eddig: ${formatDateShort(to, today)}`, clear: from ? { to: null } : { to: null, period: null } });
		return list;
	});

	const clearChips = () => update(Object.assign(period === 'range' ? { period: null } : {}, ...chips.map((c) => c.clear)));

	let chipsEl = $state<HTMLElement>();
	async function removeChip(chip: FilterChip, index: number) {
		await update(chip.clear);
		await tick();
		// A fókusz a szomszédos chipre, ha már nincs több, a keresőmezőre kerül.
		const rest = chipsEl?.querySelectorAll<HTMLElement>('button.chip');
		(rest?.[Math.min(index, rest.length - 1)] ?? document.getElementById('q'))?.focus();
	}

	const monthHref = (m: string) =>
		`/transactions${query({ q, type, cat: categoryId, acc: accountId, tag, min: minRaw, max: maxRaw, month: m, period: 'month' })}`;

	const TYPE_FILTERS: { value: TxType | ''; label: string }[] = [
		{ value: '', label: 'Mind' },
		{ value: 'expense', label: 'Kiadás' },
		{ value: 'income', label: 'Bevétel' },
		{ value: 'transfer', label: 'Átvezetés' }
	];
</script>

<svelte:head><title>Tételek · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head">
		<h1>Tételek</h1>
		<a class="btn primary small" href={href('/new')}><Icon name="plus" size={18} /> Új</a>
	</div>

	<div class="stack" style="gap:10px">
		<div class="field">
			<label class="sr-only" for="q">Keresés</label>
			<input
				id="q"
				type="search"
				placeholder="Keresés a leírásban (pl. kávé)…"
				autocomplete="off"
				bind:value={qInput}
				oninput={onSearchInput}
			/>
		</div>

		<div class="seg" role="group" aria-label="Típus szűrő" use:segIndicator={TYPE_FILTERS.findIndex((f) => f.value === type)}>
			{#each TYPE_FILTERS as f}
				<a
					href={href(`/transactions${query({ q, type: f.value, cat: categoryId, acc: accountId, tag, min: minRaw, max: maxRaw, from, to, month: sp.get('month'), period: sp.get('period') })}`)}
					class:active={type === f.value}
					class={f.value ? `t-${f.value}` : ''}
				>{f.label}</a>
			{/each}
		</div>

		<details class="card more" style="padding:10px 16px" open={filterCount > 0}>
			<summary>Szűrők{filterCount ? ` (${filterCount})` : ''}</summary>
			<div class="stack" style="margin-top:8px">
				<div class="grid-2">
					<div class="field">
						<label for="f-type">Típus</label>
						<select id="f-type" value={type} onchange={(e) => update({ type: e.currentTarget.value })}>
							<option value="">Mind</option>
							{#each ['expense', 'income', 'refund', 'transfer'] as t}
								<option value={t}>{TX_TYPE_LABEL[t as TxType]}</option>
							{/each}
						</select>
					</div>
					<div class="field">
						<label for="f-cat">Kategória</label>
						<select id="f-cat" value={categoryId ?? ''} onchange={(e) => update({ cat: e.currentTarget.value })}>
							<option value="">Mind</option>
							<optgroup label="Kiadás">
								{#each ledger.allCategories('expense') as c}
									<option value={c.id}>{c.icon} {c.name}{c.archived ? ' (archivált)' : ''}</option>
								{/each}
							</optgroup>
							<optgroup label="Bevétel">
								{#each ledger.allCategories('income') as c}
									<option value={c.id}>{c.icon} {c.name}{c.archived ? ' (archivált)' : ''}</option>
								{/each}
							</optgroup>
						</select>
					</div>
					<div class="field">
						<label for="f-acc">Számla</label>
						<select id="f-acc" value={accountId ?? ''} onchange={(e) => update({ acc: e.currentTarget.value })}>
							<option value="">Mind</option>
							{#each ledger.accounts as a}
								<option value={a.id}>{a.name}{a.archived ? ' (archivált)' : ''}</option>
							{/each}
						</select>
					</div>
					<div class="field">
						<label for="f-tag">Címke</label>
						<select id="f-tag" value={tag} onchange={(e) => update({ tag: e.currentTarget.value })}>
							<option value="">Mind</option>
							{#each tags as t}
								<option value={t.tag}>#{t.tag} ({t.count})</option>
							{/each}
						</select>
					</div>
					<div class="field">
						<span class="label">Összeg (Ft)</span>
						<div class="row">
							<input type="text" inputmode="numeric" placeholder="-tól" aria-label="Minimum összeg" value={minRaw} onchange={(e) => update({ min: e.currentTarget.value.trim() })} />
							<input type="text" inputmode="numeric" placeholder="-ig" aria-label="Maximum összeg" value={maxRaw} onchange={(e) => update({ max: e.currentTarget.value.trim() })} />
						</div>
					</div>
				</div>
				<div class="field">
					<span class="label">Egyéni időszak</span>
					<div class="row">
						<input type="date" aria-label="Kezdő dátum" value={from} onchange={(e) => update({ from: e.currentTarget.value, period: 'range' })} />
						<input type="date" aria-label="Záró dátum" value={to} onchange={(e) => update({ to: e.currentTarget.value, period: 'range' })} />
					</div>
				</div>
				{#if anyFilter}
					<div class="row wrap">
						<a class="btn small" href={clearHref}>Szűrők törlése</a>
					</div>
					<div class="field">
						<label for="filter-name">Szűrő mentése névvel</label>
						<div class="row">
							<input id="filter-name" type="text" maxlength="40" placeholder="pl. Kávék és menza" bind:value={filterName}
								onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), saveFilter())} />
							<button class="btn" type="button" onclick={saveFilter}>Mentés</button>
						</div>
						{#if filterError}<p class="error" role="alert">{filterError}</p>{/if}
					</div>
				{/if}
			</div>
		</details>

		{#if ledger.filters.length > 0}
			<div class="chips" role="group" aria-label="Mentett szűrők" data-testid="saved-filters">
				{#each ledger.filters as f (f.id)}
					<span class="chip removable saved" class:active={normalize(f.query) === normalize(currentQuery)}>
						<a href={href(`/transactions${f.query ? '?' + f.query : ''}`)} class="saved-link">{f.name}</a>
						<button type="button" class="chip-x" aria-label={`Mentett szűrő törlése: ${f.name}`} onclick={() => ledger.deleteFilter(f.id)}>
							<Icon name="close" size={16} />
						</button>
					</span>
				{/each}
			</div>
		{/if}

		<div class="seg" role="group" aria-label="Időszak" use:segIndicator={PERIODS.indexOf(period)}>
			<button type="button" class="seg-btn" class:active={period === 'month'} onclick={() => setPeriod('month')}>Hónap</button>
			<button type="button" class="seg-btn" class:active={period === 'range'} onclick={() => setPeriod('range')}>Időszak</button>
			<button type="button" class="seg-btn" class:active={period === 'all'} onclick={() => setPeriod('all')}>Összes</button>
		</div>

		{#if period === 'month'}
			<MonthPager {month} hrefFor={monthHref} />
		{/if}
	</div>

	{#if chips.length > 0}
		<div class="chips" role="group" aria-label="Aktív szűrők" bind:this={chipsEl}>
			{#each chips as chip, i (chip.key)}
				<button type="button" class="chip removable" aria-label={`Szűrő törlése: ${chip.kind}: ${chip.label}`} onclick={() => removeChip(chip, i)}>
					<span>{chip.label}</span>
					<Icon name="close" size={18} />
				</button>
			{/each}
			{#if chips.length > 1}
				<button type="button" class="btn ghost small" onclick={clearChips}>Összes törlése</button>
			{/if}
		</div>
	{/if}

	<!-- A hónapfüggő tartalom lapozáskor oldalra csúszik (app.css: .vt-month). -->
	<div class="stack vt-month" style="gap:16px">
		<div class="row wrap muted" aria-live="polite" data-testid="result-summary">
			<strong style="color:var(--text)">{totals.count} tétel</strong>
			{#if totals.expense > 0}<span class="exp num">−{formatMoney(totals.expense)}</span>{/if}
			{#if totals.expense < 0}<span class="inc num">+{formatMoney(-totals.expense)}</span>{/if}
			{#if totals.income > 0}<span class="inc num">+{formatMoney(totals.income)}</span>{/if}
			{#if totals.expense !== 0 && totals.income > 0}<span class="num">= {formatNet(totals.net)}</span>{/if}
			{#if totals.refund > 0 && totals.expense > 0}<span class="small">(jóváírással csökkentve)</span>{/if}
			{#if totals.transferCount > 0}<span>· {totals.transferCount} átvezetés</span>{/if}
			<span class="spacer"></span>
			{#if results.length > 0}
				<button type="button" class="btn small ghost" onclick={exportCsv} aria-label="Találatok exportálása CSV-be">CSV</button>
				<button type="button" class="btn small" aria-pressed={selecting} onclick={() => (selecting ? stopSelecting() : (selecting = true))}>
					{selecting ? 'Kész' : 'Kijelölés'}
				</button>
			{/if}
		</div>

		{#if results.length === 0}
			<div class="card empty">
				{#if ledger.transactions.length === 0}
					Még nincs egyetlen tétel sem.
				{:else if anyFilter}
					<p>Nincs a szűrésnek megfelelő tétel.</p>
					<a class="btn small" href={clearHref} style="margin-top:12px">Szűrők törlése</a>
				{:else}
					Ebben a hónapban nincs tétel.
				{/if}
			</div>
		{:else}
			<div class="card flush">
				{#each groups as g (g.date)}
					<div class="day-head">
						<span>{formatDayLabel(g.date, today)}</span>
						{#if g.hasIncomeOrExpense}
							<span class="num" class:inc={g.net > 0} class:exp={g.net < 0}>{formatNet(g.net)}</span>
						{/if}
					</div>
					<ul class="list">
							{#each g.items as tx (tx.id)}
								<li><TxRow {tx} selectable={selecting} selected={selected.has(tx.id)} ontoggle={toggle} /></li>
							{/each}
						</ul>
					{/each}
				</div>
				{#if remaining > 0}
					<button type="button" class="btn block" data-testid="load-more" onclick={() => (visible += PAGE)}>
						Továbbiak betöltése (még {remaining} tétel)
					</button>
				{/if}
		{/if}
	</div>
</div>

{#if selecting}
	<div class="bulkbar" role="region" aria-label="Csoportos műveletek" data-testid="bulk-bar">
		<div class="row wrap">
			<strong>{selected.size} kijelölve</strong>
			<button type="button" class="btn small ghost" onclick={() => (selected = new Set(results.map((t) => t.id)))}>Mind ({results.length})</button>
			<button type="button" class="btn small ghost" disabled={selected.size === 0} onclick={() => (selected = new Set())}>Kijelölés törlése</button>
		</div>
		<div class="row wrap">
			<select aria-label="Kategória módosítása" disabled={selected.size === 0} onchange={bulkCategory}>
				<option value="">Kategória…</option>
				<optgroup label="Kiadás">
					{#each ledger.activeCategories('expense') as c}<option value={c.id}>{c.icon} {c.name}</option>{/each}
				</optgroup>
				<optgroup label="Bevétel">
					{#each ledger.activeCategories('income') as c}<option value={c.id}>{c.icon} {c.name}</option>{/each}
				</optgroup>
			</select>
			<select aria-label="Számla módosítása" disabled={selected.size === 0} onchange={bulkAccount}>
				<option value="">Számla…</option>
				{#each ledger.activeAccounts as a}<option value={a.id}>{a.name}</option>{/each}
			</select>
			<input type="text" class="bulk-tag" placeholder="#címke" aria-label="Címke hozzáadása" disabled={selected.size === 0} bind:value={bulkTag}
				onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), bulkAddTag())} />
			<button type="button" class="btn small" disabled={selected.size === 0 || !bulkTag.trim()} onclick={bulkAddTag}>+ Címke</button>
			<button type="button" class="btn small danger" disabled={selected.size === 0} onclick={bulkDelete}>Törlés</button>
		</div>
	</div>
{/if}

<style>
	.grid-2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	@media (max-width: 480px) {
		.grid-2 {
			grid-template-columns: 1fr;
		}
	}
	.saved-link {
		color: inherit;
		text-decoration: none;
	}
	.chip.saved.active {
		border-color: var(--primary);
		font-weight: 700;
	}
	.chip-x {
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		padding: 4px;
	}
	.bulk-tag {
		width: 8.5em;
		min-height: 36px;
	}
</style>
