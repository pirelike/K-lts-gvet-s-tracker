<script lang="ts">
	import { route } from '$lib/route.svelte';
	import { href } from '$lib/nav';
	import { ledger } from '$lib/ledger.svelte';
	import Icon from './Icon.svelte';

	/** Telefonon az alsó sávban: a leggyakoribb öt hely; a többi a „Több" menüben. Nagy kijelzőn minden az oldalsávban van. */
	const items = [
		{ path: '/', label: 'Főoldal', icon: 'home', where: 'both' },
		{ path: '/transactions', label: 'Tételek', icon: 'list', where: 'both' },
		{ path: '/stats', label: 'Elemzés', icon: 'chart', where: 'both' },
		{ path: '/calendar', label: 'Naptár', icon: 'calendar', where: 'both' },
		{ path: '/budgets', label: 'Keretek', icon: 'gauge', where: 'wide' },
		{ path: '/recurring', label: 'Ismétlődők', icon: 'repeat', where: 'wide' },
		{ path: '/goals', label: 'Célok', icon: 'target', where: 'wide' },
		{ path: '/templates', label: 'Sablonok', icon: 'template', where: 'wide' },
		{ path: '/categories', label: 'Kategóriák', icon: 'tag', where: 'wide' },
		{ path: '/accounts', label: 'Számlák', icon: 'wallet', where: 'wide' },
		{ path: '/import', label: 'CSV-import', icon: 'upload', where: 'wide' },
		{ path: '/settings', label: 'Beállítások', icon: 'settings', where: 'wide' },
		{ path: '/more', label: 'Több', icon: 'more', where: 'narrow' }
	];

	/** A „Több" menü alá tartozó oldalak: ezeken a „Több" jelenik meg aktívként a keskeny sávban. */
	const MORE = ['/more', '/budgets', '/recurring', '/goals', '/templates', '/categories', '/accounts', '/import', '/settings'];

	const isActive = (path: string) =>
		path === '/'
			? route.path === '/'
			: path === '/more'
				? MORE.some((p) => route.path.startsWith(p))
				: route.path.startsWith(path);
</script>

<nav class="nav" aria-label="Főmenü">
	<span class="brand">Költségvetés</span>
	{#each items as item}
		{@const active = item.where === 'wide' ? route.path.startsWith(item.path) : isActive(item.path)}
		<a
			href={href(item.path)}
			class:active
			class:wide-only={item.where === 'wide'}
			class:narrow-only={item.where === 'narrow'}
			aria-current={active ? 'page' : undefined}
		>
			<Icon name={item.icon} />
			<span>{item.label}</span>
			{#if item.path === '/recurring' && ledger.due.length > 0}<span class="nav-badge" aria-label={`${ledger.due.length} esedékes`}>{ledger.due.length}</span>{/if}
		</a>
	{/each}
</nav>
