<script lang="ts">
	let { size = 72 }: { size?: number } = $props();
</script>

<svg class="gate-logo" width={size} height={size} viewBox="0 0 96 96" role="img" aria-label="Költségvetés">
	<rect width="96" height="96" rx="24" fill="#4f46e5" />
	<circle cx="48" cy="48" r="26" fill="none" stroke="#fff" stroke-width="6" />
	<path d="M38 52h20M38 44h20M48 34v28" stroke="#fff" stroke-width="5" stroke-linecap="round" />
</svg>
