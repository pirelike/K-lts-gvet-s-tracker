<script lang="ts">
	// Sorrend módosítása: egy hellyel feljebb / lejjebb (billentyűzettel és érintéssel is használható).
	let {
		index,
		count,
		label,
		onmove
	}: { index: number; count: number; label: string; onmove: (dir: -1 | 1) => void | Promise<void> } = $props();
</script>

<span class="reorder" role="group" aria-label={`${label} sorrendje`}>
	<button type="button" class="icon-btn small" aria-label={`${label}: feljebb`} disabled={index <= 0} onclick={() => onmove(-1)}>▲</button>
	<button type="button" class="icon-btn small" aria-label={`${label}: lejjebb`} disabled={index >= count - 1} onclick={() => onmove(1)}>▼</button>
</span>

<style>
	.reorder {
		display: inline-flex;
		gap: 4px;
	}
	.icon-btn.small {
		width: 34px;
		height: 34px;
		font-size: 0.7rem;
		cursor: pointer;
	}
	.icon-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
</style>
