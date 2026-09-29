<script lang="ts">
	import '../app.css';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import { route, viewTransitionKind } from '$lib/route.svelte';
	import { auth } from '$lib/auth.svelte';
	import { ledger } from '$lib/ledger.svelte';
	import AppLogo from '$lib/components/AppLogo.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import LockScreen from '$lib/components/LockScreen.svelte';
	import NavBar from '$lib/components/NavBar.svelte';
	import SetupScreen from '$lib/components/SetupScreen.svelte';
	import Toaster from '$lib/components/Toaster.svelte';
	import ShortcutHelp from '$lib/components/ShortcutHelp.svelte';
	import { clock } from '$lib/clock.svelte';
	import { go, href, markHistory } from '$lib/nav';
	import { runReminderChecks } from '$lib/notify';
	import { isTypingTarget, resolveShortcut } from '$lib/shortcuts';
	import { toasts } from '$lib/toast.svelte';
	import { onMount, tick } from 'svelte';

	let { children } = $props();

	onMount(() => {
		clock.start();
		void auth.init();
		watchForUpdates();
		// iOS Safari csak akkor alkalmazza a :active állapotot érintésre, ha van touchstart-figyelő.
		document.addEventListener('touchstart', () => {}, { passive: true });
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

	// Oldalváltáskor finom áttűnés, hónapváltáskor csúszás a lapozás irányába (View Transitions API).
	// Ahol a böngésző nem támogatja, vagy csökkentett mozgás van beállítva, az oldal azonnal vált.
	let vtSeq = 0;
	onNavigate((nav) => {
		if (!document.startViewTransition || !nav.from || !nav.to || nav.willUnload) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const kind = viewTransitionKind(nav.from.url.hash, nav.to.url.hash, clock.month);
		if (!kind) return;
		const root = document.documentElement;
		const seq = ++vtSeq;
		root.dataset.vt = kind;
		return new Promise<void>((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await nav.complete;
			});
			const done = () => {
				if (seq === vtSeq) delete root.dataset.vt;
			};
			transition.finished.then(done, done);
		});
	});

	// --- billentyűparancsok (lásd $lib/shortcuts) ---
	let helpOpen = $state(false);
	let chord: string | null = null;
	let chordTimer: ReturnType<typeof setTimeout> | undefined;

	async function onKeydown(e: KeyboardEvent) {
		if (auth.phase !== 'unlocked' || e.defaultPrevented || e.isComposing) return;
		if (isTypingTarget(e.target) || helpOpen) return;
		const res = resolveShortcut(e, chord);
		chord = res.pending;
		clearTimeout(chordTimer);
		if (chord) chordTimer = setTimeout(() => (chord = null), 1500);
		const a = res.action;
		if (!a) return;
		e.preventDefault();
		switch (a.type) {
			case 'go':
				await go(a.path);
				break;
			case 'help':
				helpOpen = true;
				break;
			case 'lock':
				auth.lock();
				break;
			case 'month':
				// A hónapváltó gombok (főoldal, tételek, naptár, elemzés) közül az előző / következő.
				document.querySelector<HTMLElement>(`.pager a[aria-label="${a.delta < 0 ? 'Előző' : 'Következő'} hónap"]`)?.click();
				break;
			case 'search':
				if (route.path !== '/transactions') await go('/transactions');
				await tick();
				setTimeout(() => document.getElementById('q')?.focus(), 30);
				break;
		}
	}

	// --- emlékeztető-értesítések: percenként ellenőrizzük, mi esedékes (háttérben lévő oldalon) ---
	$effect(() => {
		if (auth.phase !== 'locked' && auth.phase !== 'unlocked') return;
		if (!auth.reminders.enabled) return;
		const check = () => void runReminderChecks();
		check();
		const id = setInterval(check, 60_000);
		document.addEventListener('visibilitychange', check);
		return () => {
			clearInterval(id);
			document.removeEventListener('visibilitychange', check);
		};
	});

	// A „+" gomb az űrlapokon felesleges.
	const showFab = $derived(
		route.path !== '/new' && !route.path.startsWith('/transactions/')
	);
</script>

<svelte:head>
	<title>Költségvetés</title>
</svelte:head>

<svelte:window onkeydown={onKeydown} />

{#if auth.phase === 'boot'}
	<main class="gate" aria-busy="true">
		<div class="gate-card center">
			<AppLogo />
			{#if auth.blocked}
				<h1>Adatbázis-frissítés folyamatban</h1>
				<p class="muted">
					Az app egy másik lapja vagy ablaka még a régi verziót használja, és blokkolja a frissítést. Zárd be az app többi
					lapját (vagy a telepített alkalmazás másik példányát) – ez a képernyő magától folytatódik.
				</p>
			{/if}
		</div>
	</main>
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
	<!-- Pénznemváltáskor az egész felület újraépül, hogy minden összeg az új pénznemben jelenjen meg. -->
	{#key ledger.prefs.currency}
	<div class="app">
		<NavBar />
		{#if auth.dbClosed}
			<div class="notice warn db-closed" role="alert">
				Az app egy másik lapon frissült, ezért ez a lap már nem éri el az adatbázist.
				<button type="button" class="btn small" onclick={() => location.reload()}>Újratöltés</button>
			</div>
		{/if}
		<main>
			{@render children()}
		</main>
		{#if showFab}
			<a class="fab" href={href('/new')} aria-label="Új tétel"><Icon name="plus" size={30} /></a>
		{/if}
	</div>
	{/key}
{/if}

<ShortcutHelp bind:open={helpOpen} />
<Toaster />
