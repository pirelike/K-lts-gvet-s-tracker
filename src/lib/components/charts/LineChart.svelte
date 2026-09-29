<script lang="ts">
	/**
	 * Vonaldiagram (pl. kumulált havi költés az előző hónappal és a kerettel összevetve), függőségmentes SVG.
	 * 2 px-es vonal, véglap-pont 2 px-es felületszínű gyűrűvel, halk rács; függőleges célvonal követi az
	 * egeret/ujjat, nyilakkal is léptethető; táblázatos nézettel.
	 */
	import { niceTicks } from '$lib/chartScale';
	import { formatCompact } from '$lib/money';

	interface Series {
		name: string;
		color: string;
		/** Hiányzó (jövőbeli) értékek: null. */
		values: (number | null)[];
		/** A vonal szaggatott (előrejelzés). */
		dashed?: boolean;
		/** Halvány kitöltés a vonal alatt. */
		area?: boolean;
	}
	let {
		labels,
		series,
		format,
		title,
		ref = null,
		height = 210
	}: {
		labels: string[];
		series: Series[];
		format: (n: number) => string;
		title: string;
		/** Vízszintes viszonyítási vonal (pl. havi keret). */
		ref?: { value: number; label: string } | null;
		height?: number;
	} = $props();

	const PAD = { left: 42, right: 14, top: 12, bottom: 22 };
	let width = $state(320);
	let active = $state<number | null>(null);

	const n = $derived(labels.length);
	const plotW = $derived(Math.max(40, width - PAD.left - PAD.right));
	const plotH = $derived(height - PAD.top - PAD.bottom);
	const max = $derived(Math.max(0, ref?.value ?? 0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))));
	const ticks = $derived(niceTicks(max));
	const top = $derived(ticks[ticks.length - 1] || 1);
	const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
	const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / top) * plotH;

	/** A vonal útvonala; a hiányzó értékeknél megszakad. */
	function line(values: (number | null)[]): string {
		let d = '';
		let pen = false;
		values.forEach((v, i) => {
			if (v === null) {
				pen = false;
				return;
			}
			d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
			pen = true;
		});
		return d;
	}
	function area(values: (number | null)[]): string {
		const idx = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
		if (idx.length < 2) return '';
		const first = idx[0];
		const last = idx[idx.length - 1];
		return `${line(values.slice(0, last + 1).map((v, i) => (i < first ? null : v)))}L${x(last)},${y(0)}L${x(first)},${y(0)}Z`;
	}
	const lastIndex = (s: Series) => s.values.map((v) => v !== null).lastIndexOf(true);

	function nearest(e: PointerEvent & { currentTarget: SVGRectElement }) {
		const r = e.currentTarget.getBoundingClientRect();
		const px = ((e.clientX - r.left) / r.width) * plotW;
		active = n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round((px / plotW) * (n - 1))));
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') active = Math.max(0, (active ?? n) - 1);
		else if (e.key === 'ArrowRight') active = Math.min(n - 1, (active ?? -1) + 1);
		else if (e.key === 'Escape') active = null;
		else return;
		e.preventDefault();
	}
	const tickEvery = $derived(n > 20 ? 5 : n > 10 ? 2 : 1);
	const tipLeft = $derived(active === null ? 0 : Math.min(Math.max(x(active), 70), width - 70));
</script>

<figure class="viz" aria-label={title}>
	<div class="viz-legend">
		{#each series as s}
			<span><i class="swatch" style:background={s.color}></i>{s.name}</span>
		{/each}
		{#if ref}<span><i class="swatch" style:background="var(--warn)"></i>{ref.label}</span>{/if}
	</div>
	<div class="viz-box" bind:clientWidth={width}>
		<svg viewBox={`0 0 ${width} ${height}`} {width} {height} role="group" aria-label={title}>
			{#each ticks as t}
				<line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
				<text class="tick" x={PAD.left - 6} y={y(t)} text-anchor="end" dominant-baseline="middle">{formatCompact(t)}</text>
			{/each}
			{#each labels as label, i}
				{#if i % tickEvery === 0 || i === n - 1}
					<text class="tick" x={x(i)} y={height - 6} text-anchor="middle">{label}</text>
				{/if}
			{/each}
			{#if ref}
				<line x1={PAD.left} x2={width - PAD.right} y1={y(ref.value)} y2={y(ref.value)} stroke="var(--warn)" stroke-width="2" stroke-linecap="round" />
			{/if}
			{#each series as s}
				{#if s.area}<path d={area(s.values)} fill={s.color} opacity="0.1" />{/if}
				<path d={line(s.values)} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray={s.dashed ? '2 6' : undefined} />
			{/each}
			{#each series as s}
				{@const li = lastIndex(s)}
				{#if li >= 0 && !s.dashed}
					<circle cx={x(li)} cy={y(s.values[li] as number)} r="4" fill={s.color} stroke="var(--surface)" stroke-width="2" />
				{/if}
			{/each}
			{#if active !== null}
				<line class="axis" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} />
				{#each series as s}
					{#if s.values[active] !== null && s.values[active] !== undefined}
						<circle cx={x(active)} cy={y(s.values[active] as number)} r="4" fill={s.color} stroke="var(--surface)" stroke-width="2" />
					{/if}
				{/each}
			{/if}
			<line class="axis" x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
			<!-- Nagy találati terület: az egér/ujj X-e számít, nem a vonal 2 pixele. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<rect
				class="hit"
				x={PAD.left}
				y={PAD.top}
				width={plotW}
				height={plotH + PAD.bottom}
				tabindex="0"
				role="img"
				aria-label={`${title}. Nyilakkal léptethető.`}
				onpointermove={nearest}
				onpointerdown={nearest}
				onpointerleave={() => (active = null)}
				onfocus={() => (active ??= n - 1)}
				onblur={() => (active = null)}
				onkeydown={onKey}
			/>
		</svg>
		{#if active !== null}
			<div class="viz-tip" style:left={`${tipLeft}px`} role="status">
				<div class="viz-tip-title">{labels[active]}</div>
				{#each series as s}
					{#if s.values[active] !== null && s.values[active] !== undefined}
						<div class="viz-tip-row"><i class="key" style:background={s.color}></i><strong class="num">{format(s.values[active] as number)}</strong><span>{s.name}</span></div>
					{/if}
				{/each}
				{#if ref}<div class="viz-tip-row"><i class="key" style:background="var(--warn)"></i><strong class="num">{format(ref.value)}</strong><span>{ref.label}</span></div>{/if}
			</div>
		{/if}
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
					<tr><th scope="row">{label}</th>{#each series as s}<td class="num">{s.values[i] === null || s.values[i] === undefined ? '–' : format(s.values[i] as number)}</td>{/each}</tr>
				{/each}
			</tbody>
		</table>
	</details>
</figure>
