<script lang="ts">
	import { toasts } from '$lib/toast.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
	{#each toasts.items as t (t.id)}
		<div class="toast" class:error={t.kind === 'error'}>
			<span>{t.message}</span>
			{#if t.actionLabel}
				<button
					type="button"
					onclick={async () => {
						toasts.dismiss(t.id);
						await t.onAction?.();
					}}>{t.actionLabel}</button
				>
			{/if}
		</div>
	{/each}
</div>
