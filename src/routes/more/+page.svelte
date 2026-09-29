<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { auth } from '$lib/auth.svelte';
	import { ledger } from '$lib/ledger.svelte';
	import { href } from '$lib/nav';

	const links = $derived([
		{ path: '/budgets', icon: 'gauge', label: 'Havi keretek', text: 'Kategóriánkénti és összes keret, figyelmeztetés 80% és 100% felett', badge: 0 },
		{ path: '/recurring', icon: 'repeat', label: 'Ismétlődő tételek', text: 'Albérlet, előfizetések, ösztöndíj – esedékes tételek jóváhagyása', badge: ledger.due.length },
		{ path: '/goals', icon: 'target', label: 'Megtakarítási célok', text: 'Haladás a célod felé, havi félretenni való', badge: 0 },
		{ path: '/templates', icon: 'template', label: 'Sablonok', text: 'Gyakori tételek egy érintéssel', badge: 0 },
		{ path: '/categories', icon: 'tag', label: 'Kategóriák', text: 'Létrehozás, sorrend, ikon, szín, keret', badge: 0 },
		{ path: '/accounts', icon: 'wallet', label: 'Számlák', text: 'Egyenlegek, egyeztetés, átvezetés', badge: 0 },
		{ path: '/import', icon: 'upload', label: 'CSV-import', text: 'Tételek beolvasása táblázatból vagy banki exportból', badge: 0 },
		{ path: '/settings', icon: 'settings', label: 'Beállítások', text: 'Biztonság, mentés, CSV-export, pénznem, emlékeztetők', badge: 0 }
	]);
</script>

<svelte:head><title>Több · Költségvetés</title></svelte:head>

<div class="page">
	<div class="page-head">
		<h1>Több</h1>
		<button type="button" class="btn small" onclick={() => auth.lock()}><Icon name="lock" size={18} /> Zárolás</button>
	</div>
	<ul class="card flush list">
		{#each links as l}
			<li>
				<a class="tx" href={href(l.path)}>
					<span class="tx-icon" aria-hidden="true"><Icon name={l.icon} size={20} /></span>
					<span class="tx-main">
						<span class="tx-title" style="display:block">{l.label}</span>
						<span class="tx-sub" style="display:block;white-space:normal">{l.text}</span>
					</span>
					{#if l.badge > 0}<span class="nav-badge">{l.badge}</span>{/if}
				</a>
			</li>
		{/each}
	</ul>
	<p class="hint center">Billentyűzeten a <kbd>?</kbd> gomb mutatja a gyorsparancsokat.</p>
</div>
