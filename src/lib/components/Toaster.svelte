<script lang="ts">
	import { cubicOut } from 'svelte/easing';
	import { flip } from 'svelte/animate';
	import { fade, fly } from 'svelte/transition';
	import { ms } from '$lib/motion';
	import { toasts, type Toast } from '$lib/toast.svelte';

	// A hibák azonnal (role="alert"), a többi üzenet udvariasan (role="status") hangzik el.
	const errors = $derived(toasts.items.filter((t) => t.kind === 'error'));
	const infos = $derived(toasts.items.filter((t) => t.kind !== 'error'));
</script>

{#snippet toast(t: Toast)}
	<!-- A mutató/fókusz csak megállítja az időzítőt, nem interakció. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="toast"
		class:error={t.kind === 'error'}
		class:paused={t.paused}
		onpointerenter={() => toasts.pause(t.id, 'pointer')}
		onpointerleave={() => toasts.resume(t.id, 'pointer')}
		onfocusin={() => toasts.pause(t.id, 'focus')}
		onfocusout={() => toasts.resume(t.id, 'focus')}
	>
		<span>{t.message}</span>
		{#if t.actionLabel}
			<button
				type="button"
				onclick={async () => {
					toasts.dismiss(t.id);
					await t.onAction?.();
				}}>{t.actionLabel}</button
			>
			<span class="toast-timer" style:animation-duration={`${t.duration}ms`} aria-hidden="true"></span>
		{/if}
	</div>
{/snippet}

<div class="toasts">
	<div class="toast-region" role="alert">
		{#each errors as t (t.id)}
			<div
				animate:flip={{ duration: ms(200) }}
				in:fly={{ y: 24, duration: ms(220), easing: cubicOut }}
				out:fade={{ duration: ms(150) }}
			>
				{@render toast(t)}
			</div>
		{/each}
	</div>
	<div class="toast-region" role="status">
		{#each infos as t (t.id)}
			<div
				animate:flip={{ duration: ms(200) }}
				in:fly={{ y: 24, duration: ms(220), easing: cubicOut }}
				out:fade={{ duration: ms(150) }}
			>
				{@render toast(t)}
			</div>
		{/each}
	</div>
</div>
