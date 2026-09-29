<script lang="ts">
	import type { BudgetLine } from '$lib/budget';
	import { formatMoney } from '$lib/money';
	import { href, query } from '$lib/nav';

	let {
		lines,
		month,
		/** A hónap előrehaladása (0–1) a folyó hónapnál: „ütem szerinti" jelölő a sávon. */
		pace = null
	}: { lines: BudgetLine[]; month: string; pace?: number | null } = $props();

	const fillColor = (l: BudgetLine) => (l.level === 'over' ? 'var(--expense)' : l.level === 'warn' ? 'var(--warn)' : l.color);
	const status = (l: BudgetLine) =>
		l.level === 'over'
			? `túllépve ${formatMoney(-l.remaining)}-tal`
			: l.level === 'warn'
				? `figyelem: még ${formatMoney(l.remaining)}`
				: `még ${formatMoney(l.remaining)}`;
</script>

<ul class="budget-list" data-testid="budget-bars">
	{#each lines as l (l.categoryId ?? 'total')}
		<li>
			<svelte:element
				this={l.categoryId != null ? 'a' : 'div'}
				class="budget-row"
				href={l.categoryId != null ? href(`/transactions${query({ month, cat: l.categoryId, type: 'expense' })}`) : undefined}
			>
				<span class="row">
					<span class="grow ellipsis"><span aria-hidden="true">{l.icon}</span> <strong>{l.name}</strong></span>
					<span class="pct num" class:warn={l.level === 'warn'} class:over={l.level === 'over'}>{Math.round(l.ratio * 100)}%</span>
				</span>
				<span
					class="meter"
					role="progressbar"
					aria-label={`${l.name} havi keret`}
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={Math.min(100, Math.round(l.ratio * 100))}
					aria-valuetext={`${Math.round(l.ratio * 100)}% (${status(l)})`}
				>
					<span class="meter-fill" style:width={`${Math.min(100, l.ratio * 100)}%`} style:background={fillColor(l)}></span>
					{#if pace !== null && pace > 0 && pace < 1}
						<span class="meter-pace" style:left={`${pace * 100}%`} title="A hónap eddig eltelt része"></span>
					{/if}
				</span>
				<span class="row wrap small" style="gap:2px 10px">
					<span class="num">{formatMoney(l.spent)} / {formatMoney(l.budget)}</span>
					<span class:muted={l.level === 'ok'} class:over-text={l.level === 'over'} class:warn-text={l.level === 'warn'}>
						{#if l.level !== 'ok'}<span aria-hidden="true">{l.level === 'over' ? '⚠' : '!'}</span>{/if}
						{status(l)}
					</span>
				</span>
			</svelte:element>
		</li>
	{/each}
</ul>

<style>
	.budget-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.budget-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: inherit;
		text-decoration: none;
	}
	.meter {
		position: relative;
		display: block;
		height: 10px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.meter-fill {
		display: block;
		height: 100%;
		border-radius: 999px;
	}
	.meter-pace {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--text);
		opacity: 0.55;
	}
	.pct {
		width: 3.2em;
		text-align: right;
		font-weight: 700;
	}
	.pct.warn,
	.warn-text {
		color: var(--warn);
	}
	.pct.over,
	.over-text {
		color: var(--expense);
	}
</style>
