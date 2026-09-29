<script lang="ts">
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';
	import ReorderButtons from '$lib/components/ReorderButtons.svelte';
	import { clock } from '$lib/clock.svelte';
	import { announceBudgetCrossings } from '$lib/budgetNotice';
	import { monthOf } from '$lib/dates';
	import { ledger, LedgerError } from '$lib/ledger.svelte';
	import { formatMoney, toInputAmount } from '$lib/money';
	import { href, query } from '$lib/nav';
	import { toasts } from '$lib/toast.svelte';
	import { TX_TYPE_LABEL, categoryTypeFor, type Template } from '$lib/types';
	import { validateTemplateName } from '$lib/validation';

	const list = $derived([...ledger.templates].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'hu')));
	let editingId = $state<number | null>(null);
	let nameText = $state('');
	let nameError = $state('');

	async function run(fn: () => Promise<unknown>, ok?: string) {
		try {
			await fn();
			if (ok) toasts.show(ok);
		} catch (e) {
			toasts.error(e instanceof LedgerError || e instanceof Error ? e.message : 'A művelet nem sikerült');
		}
	}

	/** Az űrlap előtöltése a sablonnal (a naptár és a gyorsbevitel ugyanezt a hivatkozást használja). */
	const formHref = (t: Template) =>
		href(
			`/new${query({
				type: t.type,
				amount: t.amount != null ? toInputAmount(t.amount) : '',
				desc: t.description,
				cat: t.categoryId,
				acc: t.accountId,
				to: t.toAccountId,
				tags: t.tags.join(' ')
			})}`
		);

	/** Azonnali rögzítés a mai napra (ha a sablon teljes: van összeg, kategória és számla). */
	const complete = (t: Template) => {
		const cat = t.categoryId != null ? ledger.catById.get(t.categoryId) : undefined;
		const acc = t.accountId != null ? ledger.accById.get(t.accountId) : undefined;
		if (t.amount == null || !acc || acc.archived) return false;
		if (t.type === 'transfer') return t.toAccountId != null && t.toAccountId !== t.accountId && !ledger.accById.get(t.toAccountId)?.archived;
		return !!cat && !cat.archived && cat.type === categoryTypeFor(t.type);
	};
	async function addNow(t: Template) {
		if (!complete(t)) return;
		const before = ledger.transactions;
		await run(async () => {
			await ledger.addTx({
				type: t.type,
				amount: t.amount!,
				date: clock.today,
				description: t.description,
				categoryId: t.type === 'transfer' ? null : t.categoryId,
				accountId: t.accountId!,
				toAccountId: t.type === 'transfer' ? t.toAccountId : null,
				note: t.note,
				tags: t.tags
			});
			toasts.show(`Rögzítve: ${t.name} · ${formatMoney(t.amount!)}`);
			if (t.type === 'expense') announceBudgetCrossings(before, monthOf(clock.today));
		});
	}

	function startRename(t: Template) {
		editingId = editingId === t.id ? null : t.id;
		nameText = t.name;
		nameError = '';
	}
	async function rename(t: Template) {
		nameError = validateTemplateName(nameText, ledger.templates, t.id) ?? '';
		if (nameError) return;
		await run(() => ledger.renameTemplate(t.id, nameText.trim()), 'Átnevezve');
		editingId = null;
	}
</script>

<svelte:head><title>Sablonok · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head">
		<h1>Sablonok</h1>
		<a class="btn small primary" href={href('/new')}>Új tétel</a>
	</div>
	<p class="muted">
		A sablon egy gyakori tétel mintája (pl. „Reggeli kávé", „Havi bérlet"). Az új tétel űrlapján egy érintéssel kitölthető.
		Új sablont az űrlap alján, a <strong>Mentés sablonként</strong> résznél hozhatsz létre.
	</p>

	<ul class="stack" style="list-style:none;margin:0;padding:0">
		{#each list as t, i (t.id)}
			{@const cat = t.categoryId != null ? ledger.catById.get(t.categoryId) : undefined}
			<li class="card stack">
				<div class="row">
					<span class="tx-icon" style:--dot={cat?.color ?? '#64748b'} aria-hidden="true">{t.type === 'transfer' ? '⇄' : cat?.icon || '•'}</span>
					<div class="grow">
						<strong>{t.name}</strong> <span class="badge">{TX_TYPE_LABEL[t.type]}</span>
						<div class="muted small">
							{t.amount != null ? formatMoney(t.amount) : 'összeg nélkül'}
							{#if cat}· {cat.name}{/if}
							{#if t.accountId != null}· {ledger.accById.get(t.accountId)?.name ?? '?'}{/if}
						</div>
					</div>
					{#if list.length > 1}<ReorderButtons index={i} count={list.length} label={t.name} onmove={(dir) => run(() => ledger.moveTemplate(t.id, dir))} />{/if}
				</div>
				<div class="row wrap">
					<a class="btn small" href={formHref(t)}>Megnyitás űrlapban</a>
					{#if complete(t)}
						<button class="btn small primary" type="button" onclick={() => addNow(t)}>Rögzítés most</button>
					{/if}
					<button class="btn small" type="button" onclick={() => startRename(t)}>Átnevezés</button>
					<ConfirmButton label="Törlés" onconfirm={() => run(() => ledger.deleteTemplate(t.id), 'Sablon törölve')} />
				</div>
				{#if editingId === t.id}
					<div class="field">
						<label for={`tpl-${t.id}`}>Új név</label>
						<div class="row">
							<input id={`tpl-${t.id}`} type="text" maxlength="40" bind:value={nameText} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), rename(t))} />
							<button class="btn primary" type="button" onclick={() => rename(t)}>Mentés</button>
						</div>
						{#if nameError}<p class="error" role="alert">{nameError}</p>{/if}
					</div>
				{/if}
			</li>
		{:else}
			<li class="card empty">Még nincs sablonod.</li>
		{/each}
	</ul>
</div>
