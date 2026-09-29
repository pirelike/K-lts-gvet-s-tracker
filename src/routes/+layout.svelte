<script lang="ts">
	import '../app.css';
	import { afterNavigate } from '$app/navigation';
	import { route } from '$lib/route.svelte';
	import { auth } from '$lib/auth.svelte';
	import AppLogo from '$lib/components/AppLogo.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import LockScreen from '$lib/components/LockScreen.svelte';
	import NavBar from '$lib/components/NavBar.svelte';
	import SetupScreen from '$lib/components/SetupScreen.svelte';
	import Toaster from '$lib/components/Toaster.svelte';
	import { href, markHistory } from '$lib/nav';
	import { toasts } from '$lib/toast.svelte';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		void auth.init();
		watchForUpdates();
	});

	// Új alkalmazásverzió: a service worker a háttérben települ, a frissítést a felhasználó indítja.
	function watchForUpdates() {
		if (!('serviceWorker' in navigator)) return;
		let reloading = false;
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (reloading) return;
			reloading = true;
			location.reload();
		});
		const offer = (worker: ServiceWorker) =>
			toasts.show('Új verzió érhető el', {
				actionLabel: 'Frissítés',
				duration: 15000,
				onAction: () => worker.postMessage({ type: 'SKIP_WAITING' })
			});
		void navigator.serviceWorker.getRegistration().then((reg) => {
			if (!reg) return;
			if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
			reg.addEventListener('updatefound', () => {
				const installing = reg.installing;
				installing?.addEventListener('statechange', () => {
					if (installing.state === 'installed' && navigator.serviceWorker.controller) offer(installing);
				});
			});
			document.addEventListener('visibilitychange', () => {
				if (!document.hidden) void reg.update().catch(() => {});
			});
		});
	}
	afterNavigate(({ from }) => {
		if (from) markHistory();
	});

	// A „+" gomb az űrlapokon felesleges.
	const showFab = $derived(
		route.path !== '/new' && !route.path.startsWith('/transactions/')
	);
</script>

<svelte:head>
	<title>Költségvetés</title>
</svelte:head>

{#if auth.phase === 'boot'}
	<main class="gate" aria-busy="true"><AppLogo /></main>
{:else if auth.phase === 'unsupported'}
	<main class="gate">
		<div class="gate-card center">
			<AppLogo />
			<h1>Biztonságos kapcsolat szükséges</h1>
			<p class="muted">
				A PIN védelméhez és az offline működéshez az appot HTTPS-en (vagy localhost-on) kell
				megnyitni. Nyisd meg egy https:// címről, vagy telepítsd a telefonodra ilyen címről.
			</p>
		</div>
	</main>
{:else if auth.phase === 'error'}
	<main class="gate">
		<div class="gate-card center">
			<AppLogo />
			<h1>Az adatbázis nem nyitható meg</h1>
			<p class="muted">{auth.error}</p>
			<p class="hint">
				Privát böngészési módban vagy tiltott webhelyadatok mellett a böngésző nem engedi az adatok
				helyi tárolását.
			</p>
		</div>
	</main>
{:else if auth.phase === 'setup'}
	<SetupScreen />
{:else if auth.phase === 'locked'}
	<LockScreen />
{:else}
	<div class="app">
		<NavBar />
		<main>
			{@render children()}
		</main>
		{#if showFab}
			<a class="fab" href={href('/new')} aria-label="Új tétel"><Icon name="plus" size={30} /></a>
		{/if}
	</div>
{/if}

<Toaster />
