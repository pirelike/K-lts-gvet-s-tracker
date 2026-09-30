<script lang="ts">
	import { decodeCsvBytes, detectDelimiter, parseCsv } from '$lib/csv';
	import { IMPORT_FIELDS, detectMapping, looksLikeHeader, planImport, type ColumnMapping, type ImportField } from '$lib/csvImport';
	import { ledger } from '$lib/ledger.svelte';
	import { formatMoney } from '$lib/money';
	import { href, query } from '$lib/nav';
	import { toasts } from '$lib/toast.svelte';

	const MAX_BYTES = 20 * 1024 * 1024;
	let fileName = $state('');
	let text = $state('');
	let delimiter = $state<';' | ',' | '\t'>(';');
	let hasHeader = $state(true);
	let mapping = $state<ColumnMapping>(detectMapping([], false));
	let defaultAccountId = $state<number | null>(null);
	let createMissing = $state(true);
	let skipDuplicates = $state(true);
	let importTag = $state('import');
	let error = $state('');
	let busy = $state(false);
	let fileInput: HTMLInputElement;

	const rows = $derived(text ? parseCsv(text, delimiter) : []);
	const columnCount = $derived(Math.max(0, ...rows.slice(0, 50).map((r) => r.length)));
	const headers = $derived(hasHeader && rows[0] ? rows[0] : Array.from({ length: columnCount }, (_, i) => `Oszlop ${i + 1}`));

	async function onFile(e: Event & { currentTarget: HTMLInputElement }) {
		const input = e.currentTarget;
		const file = input.files?.[0];
		error = '';
		if (!file) return;
		if (file.size > MAX_BYTES) {
			error = 'A fájl túl nagy (legfeljebb 20 MB)';
			input.value = '';
			return;
		}
		try {
			const t = decodeCsvBytes(await file.arrayBuffer());
			fileName = file.name;
			text = t;
			delimiter = detectDelimiter(t);
			const parsed = parseCsv(t, delimiter);
			if (parsed.length === 0) {
				error = 'A fájl üres';
				text = '';
				return;
			}
			hasHeader = looksLikeHeader(parsed[0]);
			mapping = detectMapping(parsed[0], hasHeader);
			defaultAccountId = ledger.activeAccounts[0]?.id ?? null;
		} catch {
			error = 'A fájl nem olvasható';
		}
		input.value = '';
	}

	// A fejléc be/ki kapcsolása vagy az elválasztó cseréje újra kitalálja az oszlopokat.
	function remap() {
		if (rows[0]) mapping = detectMapping(rows[0], hasHeader);
	}

	const canPlan = $derived(rows.length > 0 && mapping.date >= 0 && (mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0));
	const plan = $derived(
		canPlan
			? planImport(rows, { hasHeader, mapping, defaultAccountId, createMissing, skipDuplicates, importTag: importTag.trim().replace(/^#/, '') }, {
					accounts: ledger.activeAccounts,
					categories: ledger.categories.filter((c) => !c.archived),
					transactions: ledger.transactions
				})
			: null
	);
	const importable = $derived(plan ? plan.rows.filter((r) => !r.duplicate).length : 0);
	const preview = $derived((hasHeader ? rows.slice(1) : rows).slice(0, 5));

	async function run() {
		if (!plan || importable === 0) return;
		busy = true;
		try {
			const r = await ledger.importPlan(plan);
			const extra = [r.categories ? `${r.categories} új kategória` : '', r.accounts ? `${r.accounts} új számla` : ''].filter(Boolean).join(', ');
			toasts.show(`${r.added} tétel importálva${extra ? ` (${extra})` : ''}`);
			text = '';
			fileName = '';
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Az importálás nem sikerült');
		} finally {
			busy = false;
		}
	}

	const setMap = (key: ImportField, value: string) => (mapping = { ...mapping, [key]: Number(value) });
</script>

<svelte:head><title>CSV-import · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head"><h1>CSV-import</h1></div>
	<p class="muted">
		Tételek beolvasása táblázatból vagy banki exportból (Excel: <em>Mentés másként → CSV</em>). Az oszlopokat az app kitalálja, te ellenőrzöd.
		A saját CSV-exportod formátuma tökéletesen visszatölthető.
	</p>

	<section class="card stack">
		<div class="row wrap">
			<button class="btn primary" type="button" onclick={() => fileInput.click()}>CSV-fájl kiválasztása…</button>
			<input bind:this={fileInput} type="file" accept=".csv,.txt,text/csv,text/plain" onchange={onFile} class="sr-only" tabindex="-1" aria-label="CSV-fájl kiválasztása" />
			{#if fileName}<span class="muted small">{fileName} · {rows.length} sor</span>{/if}
		</div>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</section>

	{#if rows.length > 0}
		<section class="card stack" aria-labelledby="map-title">
			<h2 id="map-title">Oszlopok</h2>
			<div class="row wrap">
				<label class="row small">
					<input type="checkbox" bind:checked={hasHeader} onchange={remap} /> Az első sor fejléc
				</label>
				<label class="row small">
					Elválasztó
					<select bind:value={delimiter} onchange={remap} style="width:auto;min-height:36px" aria-label="Elválasztó">
						<option value=";">pontosvessző ( ; )</option>
						<option value=",">vessző ( , )</option>
						<option value={'\t'}>tabulátor</option>
					</select>
				</label>
			</div>
			<div class="map-grid">
				{#each IMPORT_FIELDS as f}
					<div class="field">
						<label for={`map-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
						<select id={`map-${f.key}`} value={mapping[f.key]} onchange={(e) => setMap(f.key, e.currentTarget.value)}>
							<option value={-1}>— nincs —</option>
							{#each headers as h, i}<option value={i}>{h || `Oszlop ${i + 1}`}</option>{/each}
						</select>
					</div>
				{/each}
			</div>
			{#if !canPlan}<p class="notice warn">Add meg legalább a dátum és az összeg (vagy a terhelés/jóváírás) oszlopát.</p>{/if}

			<div class="scroll">
				<table class="prev">
					<thead><tr>{#each headers as h}<th scope="col">{h}</th>{/each}</tr></thead>
					<tbody>
						{#each preview as r}<tr>{#each headers as _h, i}<td>{r[i] ?? ''}</td>{/each}</tr>{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="card stack" aria-labelledby="opt-title">
			<h2 id="opt-title">Beállítások</h2>
			<div class="field">
				<label for="def-acc">Alapértelmezett számla (ha a sorban nincs)</label>
				<select id="def-acc" bind:value={defaultAccountId}>
					<option value={null}>— nincs —</option>
					{#each ledger.activeAccounts as a}<option value={a.id}>{a.name}</option>{/each}
				</select>
			</div>
			<label class="check"><input type="checkbox" bind:checked={createMissing} /> Ismeretlen kategóriák és számlák létrehozása</label>
			<label class="check"><input type="checkbox" bind:checked={skipDuplicates} /> Már meglévő tételek kihagyása (azonos dátum, összeg, leírás, számla)</label>
			<div class="field">
				<label for="imp-tag">Címke az importált tételekre</label>
				<input id="imp-tag" type="text" maxlength="30" bind:value={importTag} />
				<p class="hint">A címkével az egész import egyben megtalálható és csoportosan törölhető a Tételek oldalon.</p>
			</div>
		</section>

		{#if plan}
			<section class="card stack" aria-labelledby="sum-title" data-testid="import-summary">
				<h2 id="sum-title">Összegzés</h2>
				<p>
					<strong>{importable} tétel</strong> importálható a {plan.total} sorból.
					{#if plan.duplicates > 0}<span class="muted">{plan.duplicates} duplikátum kimarad.</span>{/if}
					{#if plan.errors.length > 0}<span class="exp">{plan.errors.length} sor hibás.</span>{/if}
				</p>
				{#if plan.newCategories.length > 0}
					<p class="small">Új kategóriák: {plan.newCategories.map((c) => `${c.name} (${c.type === 'expense' ? 'kiadás' : 'bevétel'})`).join(', ')}</p>
				{/if}
				{#if plan.newAccounts.length > 0}<p class="small">Új számlák: {plan.newAccounts.join(', ')}</p>{/if}
				{#if plan.rows.length > 0}
					<p class="small muted">
						Első tétel: {plan.rows[0].input.date} · {plan.rows[0].input.description || '(nincs leírás)'} · {formatMoney(plan.rows[0].input.amount)}
					</p>
				{/if}
				{#if plan.errors.length > 0}
					<details class="more">
						<summary>Hibás sorok ({plan.errors.length})</summary>
						<ul class="small" style="margin:8px 0 0;padding-left:18px">
							{#each plan.errors.slice(0, 30) as e}<li>{e.line}. sor: {e.message}</li>{/each}
							{#if plan.errors.length > 30}<li>… és még {plan.errors.length - 30}</li>{/if}
						</ul>
					</details>
				{/if}
				<div class="row wrap">
					<button class="btn primary" type="button" disabled={busy || importable === 0} onclick={run}>{importable} tétel importálása</button>
					{#if importTag.trim()}
						<a class="btn" href={href(`/transactions${query({ tag: importTag.trim().replace(/^#/, '').toLocaleLowerCase('hu') })}`)}>Importált tételek megnézése</a>
					{/if}
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.map-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	@media (max-width: 340px) {
		.map-grid {
			grid-template-columns: 1fr;
		}
	}
	.scroll {
		overflow-x: auto;
	}
	.prev {
		border-collapse: collapse;
		font-size: 0.8rem;
		white-space: nowrap;
	}
	.prev th,
	.prev td {
		padding: 4px 8px;
		border-bottom: 1px solid var(--border);
		text-align: left;
	}
	.prev th {
		color: var(--muted);
		font-weight: 600;
	}
</style>
