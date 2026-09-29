<script lang="ts">
	import { formatMonthLabel, monthOf, shiftMonth, todayISO } from '$lib/dates';
	import { href } from '$lib/nav';
	import Icon from './Icon.svelte';

	let { month, hrefFor }: { month: string; hrefFor: (month: string) => string } = $props();
	const current = $derived(monthOf(todayISO()));
</script>

<div class="pager">
	<a class="icon-btn" href={href(hrefFor(shiftMonth(month, -1)))} aria-label="Előző hónap"><Icon name="left" /></a>
	<div class="label">
		{formatMonthLabel(month)}
		{#if month !== current}
			<a class="small" style="display:block;font-weight:600" href={href(hrefFor(current))}>Vissza a mai hónapra</a>
		{/if}
	</div>
	<a class="icon-btn" href={href(hrefFor(shiftMonth(month, 1)))} aria-label="Következő hónap"><Icon name="right" /></a>
</div>
