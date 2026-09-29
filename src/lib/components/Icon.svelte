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
		transfer: 'M7 7h13l-3-3|M17 17H4l3 3',
		calendar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z|M4 10h16|M8 3v4|M16 3v4',
		chart: 'M4 20V10|M10 20V4|M16 20v-7|M22 20H2',
		more: 'M5 12h.01|M12 12h.01|M19 12h.01',
		repeat: 'M17 2l4 4-4 4|M3 11V9a3 3 0 0 1 3-3h15|M7 22l-4-4 4-4|M21 13v2a3 3 0 0 1-3 3H3',
		target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M12 12h.01',
		download: 'M12 3v12|m7 10 5 5 5-5|M4 21h16',
		upload: 'M12 15V3|m7 8 5-5 5 5|M4 21h16',
		check: 'M20 6 9 17l-5-5',
		template: 'M4 4h16v6H4z|M4 14h7v6H4z|M15 14h5v6h-5z',
		gauge: 'M12 14l4-4|M3.3 17a10 10 0 1 1 17.4 0'
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
