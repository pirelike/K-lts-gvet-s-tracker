<script lang="ts">
	import { route } from '$lib/route.svelte';
	import { href } from '$lib/nav';
	import Icon from './Icon.svelte';

	const items = [
		{ path: '/', label: 'Főoldal', icon: 'home' },
		{ path: '/transactions', label: 'Tételek', icon: 'list' },
		{ path: '/categories', label: 'Kategóriák', icon: 'tag' },
		{ path: '/accounts', label: 'Számlák', icon: 'wallet' },
		{ path: '/settings', label: 'Beállítások', icon: 'settings' }
	];

	const isActive = (path: string) =>
		path === '/' ? route.path === '/' : route.path.startsWith(path);
</script>

<nav class="nav" aria-label="Főmenü">
	<span class="brand">Költségvetés</span>
	{#each items as item}
		<a href={href(item.path)} class:active={isActive(item.path)} aria-current={isActive(item.path) ? 'page' : undefined}>
			<Icon name={item.icon} />
			<span>{item.label}</span>
		</a>
	{/each}
</nav>
