<script lang="ts">
	import { SHORTCUT_HELP } from '$lib/shortcuts';

	let { open = $bindable(false) }: { open: boolean } = $props();
	let dialog: HTMLDialogElement;

	$effect(() => {
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog bind:this={dialog} class="shortcuts" aria-labelledby="sc-title" oncancel={() => (open = false)}
	onclose={() => (open = false)}
	onclick={(e) => e.target === dialog && (open = false)}>
	<div class="stack">
		<div class="row">
			<h2 id="sc-title" class="grow">Billentyűparancsok</h2>
			<button type="button" class="btn small" onclick={() => (open = false)} aria-label="Bezárás">Bezár</button>
		</div>
		<p class="hint">Beviteli mezőben gépelés közben nem működnek. A „G, majd …" a két billentyű egymás után.</p>
		<dl class="keys">
			{#each SHORTCUT_HELP as s}
				<dt><kbd>{s.keys}</kbd></dt>
				<dd>{s.label}</dd>
			{/each}
		</dl>
	</div>
</dialog>

<style>
	.shortcuts {
		max-width: 460px;
		width: calc(100% - 32px);
		max-height: 85dvh;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 18px;
		box-shadow: var(--shadow);
	}
	.shortcuts::backdrop {
		background: rgba(0, 0, 0, 0.45);
	}
	.keys {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px 14px;
		margin: 0;
		align-items: center;
	}
	.keys dd {
		margin: 0;
	}
	.keys dt {
		white-space: nowrap;
	}
	kbd {
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-bottom-width: 2px;
		border-radius: 6px;
		background: var(--surface-2);
	}
</style>
