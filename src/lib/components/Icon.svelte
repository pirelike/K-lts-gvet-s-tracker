<script lang="ts">
	// Egyszerű, függőségmentes vonalikonok (24×24). A `|` több útvonalat választ el.
	const PATHS: Record<string, string> = {
		home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
		list: 'M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01',
		tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z|M7.5 7.5h.01',
		wallet: 'M3 7a2 2 0 0 1 2-2h13v4|M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z|M16 14.5h.01',
		settings: 'M4 21v-7|M4 10V3|M12 21v-9|M12 8V3|M20 21v-5|M20 12V3|M1 14h6|M9 8h6|M17 16h6',
		plus: 'M12 5v14|M5 12h14',
		close: 'M18 6 6 18|m6 6 12 12',
		left: 'm15 18-6-6 6-6',
		right: 'm9 18 6-6-6-6',
		lock: 'M5 11h14v10H5z|M8 11V7a4 4 0 0 1 8 0v4',
		search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|m21 21-4.3-4.3',
		transfer: 'M7 7h13l-3-3|M17 17H4l3 3'
	};
	let { name, size = 24 }: { name: keyof typeof PATHS | string; size?: number } = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#each (PATHS[name] ?? '').split('|') as d}
		<path {d} />
	{/each}
</svg>
