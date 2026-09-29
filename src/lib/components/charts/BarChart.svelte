<script lang="ts">
	/**
	 * Csoportos oszlopdiagram (havi bevétel / kiadás, hétköznapok stb.), függőségmentes SVG.
	 * Vékony oszlopok (legfeljebb 24 px), lekerekített csúcs és négyzetes alap, 2 px rés az oszlopok között,
	 * halk rácsvonalak; rámutatásra és fókuszra tooltip; alatta táblázatos nézet (nem csak színnel érthető).
	 */
	import { niceTicks } from '$lib/chartScale';
	import { formatCompact } from '$lib/money';

	interface Series {
		name: string;
		/** CSS szín (pl. var(--viz-1)). */
		color: string;
		values: number[];
	}
	let {
		labels,
		series,
		format,
		title,
		height = 200,
		highlight = null
	}: {
		labels: string[];
		series: Series[];
		format: (n: number) => string;
		/** A grafikon neve (képernyőolvasónak és a táblázatnak). */
		title: string;
		height?: number;
		/** Kiemelt csoport indexe (pl. a kiválasztott hónap). */
		highlight?: number | null;
	} = $props();

	const PAD = { left: 42, right: 6, top: 10, bottom: 22 };
	const MIN_GROUP = 40;
	const BAR_MAX = 24;
	const GAP = 2;

	let width = $state(320);
	let active = $state<number | null>(null);

	const n = $derived(labels.length);
	const groupW = $derived(Math.max(MIN_GROUP, (width - PAD.left - PAD.right) / Math.max(1, n)));
	const svgW = $derived(PAD.left + PAD.right + groupW * n);
	const plotH = $derived(height - PAD.top - PAD.bottom);
	const max = $derived(Math.max(0, ...series.flatMap((s) => s.values)));
	const ticks = $derived(niceTicks(max));
	const top = $derived(ticks[ticks.length - 1] || 1);
	const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / top) * plotH;
	const barW = $derived(Math.min(BAR_MAX, (groupW * 0.7 - GAP * (series.length - 1)) / series.length));

	/** Oszlop: lekerekített csúcs (4 px), négyzetes alap. */
	function bar(x: number, v: number): string {
		const h = plotH - (y(v) - PAD.top);
		if (h <= 0) return '';
		const r = Math.min(4, h, barW / 2);
		const yt = y(v);
		const yb = PAD.top + plotH;
		return `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + barW - r}Q${x + barW},${yt} ${x + barW},${yt + r}V${yb}Z`;
	}
	const groupX = (i: number) => PAD.left + groupW * i;
	const barX = (i: number, s: number) => {
		const total = barW * series.length + GAP * (series.length - 1);
		return groupX(i) + (groupW - total) / 2 + s * (barW + GAP);
	};
	const tipLeft = $derived(active === null ? 0 : Math.min(Math.max(groupX(active) + groupW / 2, 70), svgW - 70));
</script>

<figure class="viz" aria-label={title}>
	{#if series.length > 1}
		<div class="viz-legend" aria-hidden="false">
			{#each series as s}
				<span><i class="swatch" style:background={s.color}></i>{s.name}</span>
			{/each}
		</div>
	{/if}
	<div class="viz-scroll" bind:clientWidth={width}>
		<div class="viz-box" style:width={`${svgW}px`}>
			<svg viewBox={`0 0 ${svgW} ${height}`} width={svgW} {height} role="group" aria-label={title}>
				{#each ticks as t}
					<line class="grid" x1={PAD.left} x2={svgW - PAD.right} y1={y(t)} y2={y(t)} />
					<text class="tick" x={PAD.left - 6} y={y(t)} text-anchor="end" dominant-baseline="middle">{formatCompact(t)}</text>
				{/each}
				{#each labels as label, i}
					{#if highlight === i}
						<rect class="hl" x={groupX(i) + 2} y={PAD.top} width={groupW - 4} height={plotH} rx="6" />
					{/if}
					{#each series as s, si}
						<path d={bar(barX(i, si), s.values[i] ?? 0)} fill={s.color} opacity={active === null || active === i ? 1 : 0.55} />
					{/each}
					<text class="tick" x={groupX(i) + groupW / 2} y={height - 6} text-anchor="middle">{label}</text>
					<!-- Nagy, átlátszó találati terület: a csoport egésze a célpont, nem az oszlop pixelei. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<rect
						class="hit"
						x={groupX(i)}
						y={PAD.top}
						width={groupW}
						height={plotH + PAD.bottom}
						tabindex="0"
						role="img"
						aria-label={`${label}: ${series.map((s) => `${s.name} ${format(s.values[i] ?? 0)}`).join(', ')}`}
						onpointerenter={() => (active = i)}
						onpointerleave={() => (active = null)}
						onfocus={() => (active = i)}
						onblur={() => (active = null)}
					/>
				{/each}
				<line class="axis" x1={PAD.left} x2={svgW - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
			</svg>
			{#if active !== null}
				<div class="viz-tip" style:left={`${tipLeft}px`} role="status">
					<div class="viz-tip-title">{labels[active]}</div>
					{#each series as s}
						<div class="viz-tip-row"><i class="key" style:background={s.color}></i><strong class="num">{format(s.values[active] ?? 0)}</strong><span>{s.name}</span></div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
	<details class="viz-table">
		<summary>Táblázatos nézet</summary>
		<table>
			<caption class="sr-only">{title}</caption>
			<thead>
				<tr><th scope="col"></th>{#each series as s}<th scope="col" class="num">{s.name}</th>{/each}</tr>
			</thead>
			<tbody>
				{#each labels as label, i}
					<tr><th scope="row">{label}</th>{#each series as s}<td class="num">{format(s.values[i] ?? 0)}</td>{/each}</tr>
				{/each}
			</tbody>
		</table>
	</details>
</figure>
