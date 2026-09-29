<script module lang="ts">
	import type { TxType } from '$lib/types';
	import type { SplitFormRow } from '$lib/validation';

	export interface TxFormInitial {
		type: TxType;
		amount?: string;
		date?: string;
		description?: string;
		categoryId?: number | null;
		accountId?: number | null;
		toAccountId?: number | null;
		note?: string;
		tags?: string;
		splits?: SplitFormRow[];
	}
</script>

<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { addDays, monthOf } from '$lib/dates';
	import { deleteTxWithUndo } from '$lib/actions';
	import { announceBudgetCrossings } from '$lib/budgetNotice';
	import { clock } from '$lib/clock.svelte';
	import { ledger } from '$lib/ledger.svelte';
	import { evaluateExpression, formatMoney, parseAmount, toInputAmount } from '$lib/money';
	import { ms } from '$lib/motion';
	import { segIndicator } from '$lib/segIndicator';
	import { go, goBack, href, query } from '$lib/nav';
	import { knownDescriptions, lastUsed, suggestDescriptions, usedTags, type KnownDescription } from '$lib/queries';
	import { fold } from '$lib/text';
	import { toasts } from '$lib/toast.svelte';
	import { TX_TYPE_LABEL, categoryTypeFor, type Template, type Transaction } from '$lib/types';
	import { validateTemplateName, validateTx, type TxField } from '$lib/validation';
	import { onMount, tick, untrack } from 'svelte';
	import { fly } from 'svelte/transition';

	let { mode, initial, editing }: { mode: 'create' | 'edit'; initial: TxFormInitial; editing?: Transaction } = $props();
	const init = untrack(() => initial);

	const last = $derived(lastUsed(ledger.transactions));

	/** Okos alapértelmezések: az utoljára használt kategória és számla, ha még használható. */
	function defaultsFor(t: TxType) {
		const accs = ledger.activeAccounts;
		const okAcc = (id: number | null | undefined) =>
			id != null && accs.some((a) => a.id === id) ? id : null;
		if (t === 'transfer') {
			const from = okAcc(last.transfer.accountId) ?? accs[0]?.id ?? null;
			let to = okAcc(last.transfer.toAccountId);
			if (to == null || to === from) to = accs.find((a) => a.id !== from)?.id ?? null;
			return { categoryId: null, accountId: from, toAccountId: to };
		}
		const cats = ledger.activeCategories(categoryTypeFor(t)!);
		const lc = last[t];
		return {
			categoryId: cats.some((c) => c.id === lc.categoryId) ? lc.categoryId : (cats[0]?.id ?? null),
			accountId: okAcc(lc.accountId) ?? accs[0]?.id ?? null,
			toAccountId: null
		};
	}

	const start = untrack(() => defaultsFor(init.type));
	let type = $state<TxType>(init.type);
	let amount = $state(init.amount ?? '');
	let date = $state(init.date ?? clock.today);
	let description = $state(init.description ?? '');
	let categoryId = $state<number | null>(init.categoryId !== undefined ? init.categoryId : start.categoryId);
	let accountId = $state<number | null>(init.accountId !== undefined ? init.accountId : start.accountId);
	let toAccountId = $state<number | null>(init.toAccountId !== undefined ? init.toAccountId : start.toAccountId);
	let note = $state(init.note ?? '');
	let tagsText = $state(init.tags ?? '');
	/** Felosztás több kategóriára: a sorok; üres tömb = nincs felosztás. */
	let splitRows = $state<SplitFormRow[]>(init.splits ? init.splits.map((r) => ({ ...r })) : []);
	const splitOn = $derived(splitRows.length > 0);

	let errors = $state<Partial<Record<TxField, string>>>({});
	let saving = $state(false);
	let categoryTouched = $state(untrack(() => mode === 'edit') || init.categoryId != null);
	let suggestedCategory = $state(false);
	/** Leírás-javaslatok: nyitva-e a lista, és melyik sor van kijelölve (nyilakkal). */
	let suggestOpen = $state(false);
	let activeIndex = $state(-1);
	let suggestEl = $state<HTMLElement>();

	let amountEl: HTMLInputElement;
	let againBtn = $state<HTMLButtonElement>();
	const today = $derived(clock.today);

	const known = $derived(knownDescriptions(ledger.transactions));
	/** A jóváírás a kiadásokból tanul (ugyanazok a boltok, kategóriák). */
	const suggestType = $derived<'income' | 'expense'>(type === 'income' ? 'income' : 'expense');
	const suggestions = $derived<KnownDescription[]>(
		type === 'transfer' ? [] : suggestDescriptions(known, suggestType, description)
	);
	const showSuggest = $derived(suggestOpen && suggestions.length > 0);
	const amountPreview = $derived(amount.trim() ? evaluateExpression(amount) : null);
	const tagSuggestions = $derived.by(() => {
		const present = new Set(tagsText.split(/[\s,;#]+/).map((t) => t.toLocaleLowerCase('hu')));
		return usedTags(ledger.transactions)
			.filter((t) => !present.has(t.tag))
			.slice(0, 8);
	});

	/** Szerkesztésnél az archivált kategória is látszik, ha a tétel használja. */
	const categoryChoices = $derived(
		type === 'transfer'
			? []
			: ledger
					.allCategories(categoryTypeFor(type)!)
					.filter((c) => !c.archived || c.id === editing?.categoryId || editing?.splits?.some((p) => p.categoryId === c.id))
	);
	const accountChoices = $derived(
		ledger.accounts
			.filter((a) => !a.archived || a.id === editing?.accountId || a.id === editing?.toAccountId)
			.sort((a, b) => a.sortOrder - b.sortOrder)
	);

	// A leírás alapján automatikus kategóriajavaslat (amíg kézzel nem választottál).
	$effect(() => {
		if (categoryTouched || type === 'transfer') return;
		const f = fold(description);
		if (!f) return;
		const k = known.find((x) => x.type === suggestType && x.folded === f);
		if (k && ledger.activeCategories(categoryTypeFor(type)!).some((c) => c.id === k.categoryId)) {
			untrack(() => {
				categoryId = k.categoryId;
				suggestedCategory = true;
			});
		}
	});

	function setType(next: TxType) {
		if (next === type) return;
		type = next;
		const d = defaultsFor(next);
		categoryId = d.categoryId;
		categoryTouched = false;
		suggestedCategory = false;
		splitRows = [];
		if (next === 'transfer') {
			accountId = d.accountId;
			toAccountId = d.toAccountId;
		} else if (accountId == null || ledger.accById.get(accountId)?.archived) {
			accountId = d.accountId;
		}
		errors = {};
	}

	// --- felosztás több kategóriára ---
	function startSplit() {
		splitRows = [
			{ categoryId, amount: '' },
			{ categoryId: null, amount: '' }
		];
	}
	function stopSplit() {
		const main = splitRows.find((r) => r.categoryId != null)?.categoryId;
		if (main != null) categoryId = main;
		splitRows = [];
	}
	function addSplitRow() {
		splitRows = [...splitRows, { categoryId: null, amount: '' }];
	}
	function removeSplitRow(i: number) {
		splitRows = splitRows.filter((_, idx) => idx !== i);
		if (splitRows.length < 2) stopSplit();
	}
	/** Mennyi van még elosztatlanul (a teljes összeg és a megadott részek különbsége). */
	const splitLeft = $derived.by(() => {
		const total = parseAmount(amount);
		if (!total.ok) return null;
		let used = 0;
		for (const r of splitRows) {
			if (!r.amount.trim()) continue;
			const a = parseAmount(r.amount);
			if (a.ok) used += a.value;
		}
		return total.value - used;
	});

	// --- sablonok ---
	const templates = $derived([...ledger.templates].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'hu')));
	function applyTemplate(t: Template) {
		type = t.type;
		const d = defaultsFor(t.type);
		if (t.amount != null) amount = toInputAmount(t.amount);
		description = t.description;
		note = t.note;
		tagsText = t.tags.map((g) => `#${g}`).join(' ');
		splitRows = [];
		const okAcc = (id: number | null) => (id != null && ledger.activeAccounts.some((a) => a.id === id) ? id : null);
		accountId = okAcc(t.accountId) ?? d.accountId;
		toAccountId = t.type === 'transfer' ? (okAcc(t.toAccountId) ?? d.toAccountId) : null;
		const cat = t.categoryId != null ? ledger.catById.get(t.categoryId) : undefined;
		categoryId = cat && !cat.archived ? cat.id : d.categoryId;
		categoryTouched = !!cat;
		suggestedCategory = false;
		errors = {};
		void tick().then(() => (t.amount == null ? amountEl?.focus() : undefined));
	}

	let tplName = $state('');
	let tplError = $state('');
	async function saveTemplate() {
		tplError = validateTemplateName(tplName, ledger.templates) ?? '';
		if (tplError) return;
		const amt = amount.trim() ? parseAmount(amount) : null;
		try {
			await ledger.addTemplate({
				name: tplName.trim(),
				type,
				amount: amt?.ok ? amt.value : null,
				description: description.trim(),
				categoryId: type === 'transfer' ? null : (splitOn ? (splitRows.find((r) => r.categoryId != null)?.categoryId ?? null) : categoryId),
				accountId,
				toAccountId: type === 'transfer' ? toAccountId : null,
				note: note.trim(),
				tags: tagsText.split(/[\s,;#]+/).map((g) => g.trim().toLocaleLowerCase('hu')).filter(Boolean)
			});
			toasts.show(`Sablon mentve: ${tplName.trim()}`);
			tplName = '';
		} catch (e) {
			tplError = e instanceof Error ? e.message : 'A sablon mentése nem sikerült';
		}
	}

	function pick(s: KnownDescription) {
		description = s.description;
		categoryId = s.categoryId;
		categoryTouched = true;
		suggestedCategory = true;
		accountId = s.accountId;
		if (!amount.trim()) amount = toInputAmount(s.amount);
		closeSuggest();
	}

	function closeSuggest() {
		suggestOpen = false;
		activeIndex = -1;
	}

	/** Combobox-billentyűk: ↓/↑ lépked a javaslatok között, Enter választ, Esc bezár. */
	function onDescKeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		const n = suggestions.length;
		if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n > 0) {
			e.preventDefault();
			suggestOpen = true;
			if (e.key === 'ArrowDown') activeIndex = (activeIndex + 1) % n;
			else activeIndex = activeIndex <= 0 ? n - 1 : activeIndex - 1;
		} else if (e.key === 'Enter' && showSuggest && activeIndex >= 0) {
			e.preventDefault();
			pick(suggestions[activeIndex]);
		} else if (e.key === 'Escape' && showSuggest) {
			e.preventDefault();
			closeSuggest();
		}
	}

	async function insert(ch: string) {
		const s = amountEl.selectionStart ?? amount.length;
		const e = amountEl.selectionEnd ?? s;
		amount = amount.slice(0, s) + ch + amount.slice(e);
		await tick();
		amountEl.focus();
		amountEl.setSelectionRange(s + ch.length, s + ch.length);
	}

	function addTag(tag: string) {
		tagsText = (tagsText.trim() ? tagsText.trim() + ' ' : '') + `#${tag}`;
	}

	onMount(() => {
		amountEl?.focus();
		if (init.amount) amountEl?.select();
	});

	// Mentetlen változtatások: navigáció előtt rákérdezünk, ha az űrlap eltér a kiinduló állapottól.
	const snapshot = () =>
		JSON.stringify([type, amount.trim(), date, description.trim(), categoryId, accountId, toAccountId, note.trim(), tagsText.trim(), splitRows]);
	let baseline = $state(untrack(snapshot));
	const dirty = $derived(snapshot() !== baseline);
	/** Sikeres mentés vagy törlés után szabadon továbbléphetünk. */
	let leaving = false;

	beforeNavigate((nav) => {
		if (leaving || !dirty) return;
		// Bezárás / újratöltés: a böngésző saját „Elhagyod az oldalt?" kérdése jelenik meg.
		if (nav.type === 'leave') return nav.cancel();
		const question =
			mode === 'edit'
				? 'A módosítások nincsenek mentve. Elveted őket?'
				: 'Az új tétel nincs mentve. Elveted?';
		if (!confirm(question)) nav.cancel();
	});

	async function onsubmit(e: SubmitEvent) {
		e.preventDefault();
		const again = (e.submitter as HTMLElement | null)?.dataset.again === '1';
		const res = validateTx(
			{ type, amount, date, description, categoryId, accountId, toAccountId, note, tags: tagsText, splits: splitRows },
			{
				categories: ledger.categories,
				accounts: ledger.accounts,
				existing: editing
					? {
							categoryId: editing.categoryId,
							accountId: editing.accountId,
							toAccountId: editing.toAccountId,
							splitCategoryIds: editing.splits?.map((p) => p.categoryId)
						}
					: undefined
			}
		);
		if (!res.ok) {
			errors = res.errors;
			await tick();
			document.querySelector<HTMLElement>('[aria-invalid="true"], .error')?.scrollIntoView({ block: 'center' });
			return;
		}
		errors = {};
		saving = true;
		// A keretfigyelmeztetéshez: mely keretek lépnek át 80% / 100%-ot ezzel a mentéssel.
		const before = ledger.transactions;
		const month = monthOf(res.value.date);
		const warn = () => res.value.type === 'expense' && announceBudgetCrossings(before, month);
		try {
			if (mode === 'edit' && editing) {
				await ledger.updateTx(editing.id, res.value);
				warn();
				leaving = true;
				toasts.show('Módosítások mentve');
				goBack('/transactions');
			} else {
				await ledger.addTx(res.value);
				toasts.show(`Mentve: ${formatMoney(res.value.amount)}`);
				warn();
				if (again) {
					amount = '';
					description = '';
					note = '';
					tagsText = '';
					splitRows = [];
					categoryTouched = false;
					suggestedCategory = false;
					baseline = snapshot();
					await tick();
					amountEl.focus();
					window.scrollTo({ top: 0 });
				} else {
					leaving = true;
					await go('/');
				}
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'A mentés nem sikerült');
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!editing) return;
		leaving = true;
		await deleteTxWithUndo(editing.id);
		goBack('/transactions');
	}

	const TX_TYPES = ['expense', 'income', 'refund', 'transfer'] as const;
	/** 0: a dátum ma, 1: tegnap, -1: egyéni dátum. */
	const quickDate = $derived(date === today ? 0 : date === addDays(today, -1) ? 1 : -1);

	const descLabel = $derived(
		type === 'expense'
			? 'Mire költöttél?'
			: type === 'income'
				? 'Honnan jött?'
				: type === 'refund'
					? 'Mit vittél vissza? (nem kötelező)'
					: 'Megjegyzés (nem kötelező)'
	);
	const descPlaceholder = $derived(
		type === 'expense'
			? 'pl. Lidl, menza, kávé'
			: type === 'income'
				? 'pl. ösztöndíj, zsebpénz'
				: type === 'refund'
					? 'pl. pulóver visszavíve'
					: 'pl. készpénzfelvétel'
	);
	const catLabel = $derived(type === 'refund' ? 'Melyik kategória költését csökkenti?' : 'Kategória');

	/** Ctrl/Cmd + Enter: mentés és új tétel (létrehozásnál). */
	function onFormKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && mode === 'create') {
			e.preventDefault();
			againBtn?.click();
		}
	}
</script>

<!-- Ctrl/Cmd+Enter az űrlap bármelyik mezőjéből: mentés és új tétel. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="stack" style="gap:18px" {onsubmit} onkeydown={onFormKeydown} novalidate>
	{#if mode === 'create' && templates.length > 0}
		<div class="field">
			<span class="label">Sablonok</span>
			<div class="chips" role="group" aria-label="Sablonok">
				{#each templates as t (t.id)}
					<button type="button" class="chip link" onclick={() => applyTemplate(t)}>
						<span aria-hidden="true">{t.categoryId != null ? (ledger.catById.get(t.categoryId)?.icon ?? '') : t.type === 'transfer' ? '⇄' : ''}</span>{t.name}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="seg four" role="radiogroup" aria-label="Típus" use:segIndicator={TX_TYPES.indexOf(type)}>
		{#each TX_TYPES as t}
			<label class={`t-${t}`}>
				<input type="radio" name="type" value={t} checked={type === t} onchange={() => setType(t)} />
				{TX_TYPE_LABEL[t]}
			</label>
		{/each}
	</div>

	<div class="field">
		<label for="amount">Összeg (Ft)</label>
		<input
			id="amount"
			bind:this={amountEl}
			class="amount-input"
			type="text"
			inputmode="decimal"
			autocomplete="off"
			enterkeyhint="next"
			placeholder="pl. 1200+850 vagy 12k"
			bind:value={amount}
			aria-invalid={errors.amount ? 'true' : undefined}
			aria-describedby="amount-help"
		/>
		<div class="amount-helpers" role="group" aria-label="Gyors karakterek">
			{#each [['+', '+'], ['−', '-'], ['×', '*'], ['k', 'k']] as [label, ch]}
				<button type="button" aria-label={`${label} beszúrása`} onmousedown={(e) => e.preventDefault()} onclick={() => insert(ch)}>{label}</button>
			{/each}
			<span id="amount-help" class="hint" style="align-self:center">
				{#if amountPreview?.ok}
					= <strong class="num">{formatMoney(amountPreview.value)}</strong>
				{:else}
					k = ezer
				{/if}
			</span>
		</div>
		{#if errors.amount}<p class="error" role="alert">{errors.amount}</p>{/if}
	</div>

	<div class="field" style="position:relative">
		<label for="description">{descLabel}</label>
		<input
			id="description"
			type="text"
			autocomplete="off"
			autocapitalize="sentences"
			maxlength="200"
			placeholder={descPlaceholder}
			bind:value={description}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={showSuggest}
			aria-controls={showSuggest ? 'desc-suggest' : undefined}
			aria-activedescendant={showSuggest && activeIndex >= 0 ? `desc-opt-${activeIndex}` : undefined}
			onfocus={() => (suggestOpen = true)}
			onblur={(e) => {
				// Ha a fókusz mégis a listára kerülne (a mousedown ezt általában megakadályozza), maradjon nyitva.
				if (!suggestEl?.contains(e.relatedTarget as Node | null)) closeSuggest();
			}}
			oninput={() => {
				suggestedCategory = false;
				suggestOpen = true;
				activeIndex = -1;
			}}
			onkeydown={onDescKeydown}
			aria-invalid={errors.description ? 'true' : undefined}
		/>
		{#if errors.description}<p class="error" role="alert">{errors.description}</p>{/if}
		{#if showSuggest}
			<!-- A lista nem veszi el a fókuszt (mousedown), így a leírásmező blur-je azonnal bezárhatja. -->
			<ul id="desc-suggest" class="suggest" role="listbox" aria-label="Korábbi tételek" bind:this={suggestEl} transition:fly={{ y: -6, duration: ms(140) }}>
				{#each suggestions as s, i (s.folded + s.type)}
					<!-- A billentyűzetet a leírásmező kezeli (combobox-minta). -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id={`desc-opt-${i}`}
						role="option"
						tabindex="-1"
						aria-selected={i === activeIndex}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => pick(s)}
					>
						<span>{s.description}</span>
						<span class="muted small num">{formatMoney(s.amount)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if type === 'refund'}
		<p class="notice">
			A jóváírás (visszavitt áru, visszatérítés) <strong>csökkenti a kiválasztott kategória költését</strong>, a
			számlára pedig pénz érkezik. Nem számít bevételnek.
		</p>
	{/if}

	{#if type !== 'transfer'}
		<fieldset class="field">
			<legend class="label">
				{catLabel}
				{#if suggestedCategory && !splitOn}<span class="badge demo">javasolt</span>{/if}
			</legend>
			{#if splitOn}
				<div class="stack" style="gap:8px" data-testid="split-editor">
					{#each splitRows as row, i}
						<div class="row split-row">
							<select aria-label={`${i + 1}. rész kategóriája`} value={row.categoryId ?? ''} onchange={(e) => (row.categoryId = e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
								<option value="">Kategória…</option>
								{#each categoryChoices as c (c.id)}
									<option value={c.id}>{c.icon} {c.name}{c.archived ? ' (archivált)' : ''}</option>
								{/each}
							</select>
							<input type="text" inputmode="decimal" autocomplete="off" placeholder="maradék" aria-label={`${i + 1}. rész összege`} bind:value={row.amount} />
							<button type="button" class="icon-btn" aria-label={`${i + 1}. rész törlése`} onclick={() => removeSplitRow(i)}>×</button>
						</div>
					{/each}
					<div class="row wrap">
						<button type="button" class="btn small" onclick={addSplitRow}>+ Újabb rész</button>
						<button type="button" class="btn small ghost" onclick={stopSplit}>Nincs felosztás</button>
					</div>
					<p class="hint" role="status">
						{#if splitLeft !== null}
							<strong class:exp={splitLeft < 0}>{splitLeft === 0 ? 'Minden elosztva.' : splitLeft > 0 ? `Elosztatlan: ${formatMoney(splitLeft)}.` : `Túl sok: ${formatMoney(-splitLeft)}.`}</strong>
						{/if}
						Az üresen hagyott összeg megkapja a maradékot.
					</p>
				</div>
				{#if errors.splits}<p class="error" role="alert">{errors.splits}</p>{/if}
			{:else}
			<div class="chips" role="radiogroup">
				{#each categoryChoices as c (c.id)}
					<label class="chip" style:--dot={c.color}>
						<input
							type="radio"
							name="category"
							value={c.id}
							checked={categoryId === c.id}
							onchange={() => {
								categoryId = c.id;
								categoryTouched = true;
								suggestedCategory = false;
							}}
						/>
						<span aria-hidden="true">{c.icon}</span>{c.name}{c.archived ? ' (archivált)' : ''}
					</label>
				{/each}
			</div>
			{#if errors.category}<p class="error" role="alert">{errors.category}</p>{/if}
			<div><button type="button" class="btn small ghost" onclick={startSplit}>Felosztás több kategóriára</button></div>
			{/if}
		</fieldset>

		<fieldset class="field">
			<legend class="label">Számla</legend>
			<div class="chips" role="radiogroup">
				{#each accountChoices as a (a.id)}
					<label class="chip">
						<input type="radio" name="account" value={a.id} checked={accountId === a.id} onchange={() => (accountId = a.id)} />
						{a.name}{a.archived ? ' (archivált)' : ''}
					</label>
				{/each}
			</div>
			{#if errors.account}<p class="error" role="alert">{errors.account}</p>{/if}
		</fieldset>
	{:else}
		<fieldset class="field">
			<legend class="label">Honnan (forrásszámla)</legend>
			<div class="chips" role="radiogroup">
				{#each accountChoices as a (a.id)}
					<label class="chip">
						<input type="radio" name="from" value={a.id} checked={accountId === a.id} onchange={() => (accountId = a.id)} />
						{a.name}
					</label>
				{/each}
			</div>
			{#if errors.account}<p class="error" role="alert">{errors.account}</p>{/if}
		</fieldset>
		<fieldset class="field">
			<legend class="label">Hová (célszámla)</legend>
			<div class="chips" role="radiogroup">
				{#each accountChoices as a (a.id)}
					<label class="chip">
						<input type="radio" name="to" value={a.id} checked={toAccountId === a.id} onchange={() => (toAccountId = a.id)} />
						{a.name}
					</label>
				{/each}
			</div>
			{#if errors.toAccount}<p class="error" role="alert">{errors.toAccount}</p>{/if}
			<p class="hint">Az átvezetés nem számít bevételnek vagy kiadásnak.</p>
		</fieldset>
	{/if}

	<div class="field">
		<label for="date">Dátum</label>
		<div class="row wrap">
			<input id="date" type="date" bind:value={date} style="flex:1;min-width:150px" aria-invalid={errors.date ? 'true' : undefined} />
			<!-- Gyorsgombok: a mezővel azonos magasak, a kijelölt (ma / tegnap) kiemelve; egyéni dátumnál egyik sem. -->
			<div class="seg accent" role="group" aria-label="Gyors dátum" style="flex:none;align-self:stretch" use:segIndicator={quickDate}>
				<button type="button" class:active={quickDate === 0} aria-pressed={quickDate === 0} onclick={() => (date = today)}>Ma</button>
				<button type="button" class:active={quickDate === 1} aria-pressed={quickDate === 1} onclick={() => (date = addDays(today, -1))}>Tegnap</button>
			</div>
		</div>
		{#if errors.date}<p class="error" role="alert">{errors.date}</p>{/if}
	</div>

	<details class="more" open={!!(note || tagsText)}>
		<summary>Címkék és megjegyzés</summary>
		<div class="stack" style="margin-top:8px">
			<div class="field">
				<label for="tags">Címkék</label>
				<input id="tags" type="text" autocomplete="off" placeholder="pl. #nyaralás #egyetem" bind:value={tagsText} aria-invalid={errors.tags ? 'true' : undefined} />
				{#if errors.tags}<p class="error" role="alert">{errors.tags}</p>{/if}
				{#if tagSuggestions.length}
					<div class="chips">
						{#each tagSuggestions as t}
							<button type="button" class="chip link" onclick={() => addTag(t.tag)}>#{t.tag}</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="field">
				<label for="note">Megjegyzés</label>
				<textarea id="note" bind:value={note} maxlength="2000"></textarea>
				{#if errors.note}<p class="error" role="alert">{errors.note}</p>{/if}
			</div>
		</div>
	</details>

	<details class="more">
		<summary>Mentés sablonként</summary>
		<div class="stack" style="margin-top:8px">
			<div class="row">
				<input type="text" maxlength="40" placeholder="Sablon neve, pl. Reggeli kávé" aria-label="Sablon neve" bind:value={tplName} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), saveTemplate())} />
				<button type="button" class="btn" onclick={saveTemplate}>Mentés</button>
			</div>
			{#if tplError}<p class="error" role="alert">{tplError}</p>{/if}
			<p class="hint">A sablonból később egy érintéssel kitölthető az új tétel űrlapja.</p>
		</div>
	</details>

	<div class="stack" style="gap:10px">
		<button class="btn primary block" type="submit" disabled={saving}>
			{mode === 'edit' ? 'Módosítások mentése' : 'Mentés'}
		</button>
		{#if mode === 'create'}
			<button class="btn block" type="submit" data-again="1" disabled={saving} bind:this={againBtn}>Mentés és új tétel</button>
		{:else if editing}
			<div class="row wrap">
				<a class="btn grow" href={href(`/new${query({ copy: editing.id })}`)}>Másolás</a>
				<button class="btn danger grow" type="button" onclick={remove}>Törlés</button>
			</div>
		{/if}
		<button class="btn ghost" type="button" onclick={() => goBack('/')}>Mégse</button>
	</div>
</form>
