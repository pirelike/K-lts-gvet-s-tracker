<script lang="ts">
	// Kétlépéses művelet (kategória/számla törlése): az első koppintás csak „élesít".
	let {
		label,
		confirmLabel = 'Igen, törlöm',
		question = 'Biztosan?',
		small = true,
		onconfirm
	}: {
		label: string;
		confirmLabel?: string;
		question?: string;
		small?: boolean;
		onconfirm: () => void | Promise<void>;
	} = $props();

	let armed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function arm() {
		armed = true;
		clearTimeout(timer);
		timer = setTimeout(() => (armed = false), 8000);
	}
	function cancel() {
		armed = false;
		clearTimeout(timer);
	}
</script>

{#if armed}
	<span class="row wrap">
		<span class="small">{question}</span>
		<button
			type="button"
			class="btn danger solid"
			class:small
			onclick={async () => {
				cancel();
				await onconfirm();
			}}>{confirmLabel}</button
		>
		<button type="button" class="btn" class:small onclick={cancel}>Mégse</button>
	</span>
{:else}
	<button type="button" class="btn danger" class:small onclick={arm}>{label}</button>
{/if}
