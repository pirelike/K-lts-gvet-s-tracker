<script lang="ts">
	import { href } from '$lib/nav';
	import { sync } from '$lib/sync/engine.svelte';
	import Icon from './Icon.svelte';

	const info = $derived.by(() => {
		switch (sync.status) {
			case 'syncing':
				return { icon: 'sync', cls: 'spin', label: 'Szinkronizálás folyamatban' };
			case 'error':
				// Kapcsolat nélkül nem hibaként, hanem várakozásként mutatjuk: az app offline-first.
				return sync.errorKind === 'network'
					? { icon: 'cloud', cls: 'off', label: 'Nincs kapcsolat – a módosítások feltöltésre várnak' }
					: { icon: 'alert', cls: 'bad', label: `Szinkronhiba: ${sync.error}` };
			case 'paused':
				return { icon: 'pause', cls: 'warn', label: 'Szinkron szünetel – koppints a folytatáshoz' };
			default:
				return {
					icon: 'cloud',
					cls: sync.pendingLocalChanges ? 'pending' : 'ok',
					label: sync.pendingLocalChanges ? 'Feltöltésre váró módosítások' : 'Szinkronban'
				};
		}
	});

	function onclick(e: MouseEvent) {
		// Szüneteléskor a koppintás újra-hitelesít (felhasználói gesztus kell a felugró ablakhoz), egyébként a beállításokhoz visz.
		if (sync.status === 'paused') {
			e.preventDefault();
			void sync.syncNow();
		}
	}
</script>

{#if sync.connected}
	<a class="sync-badge {info.cls}" href={href('/settings')} {onclick} aria-label={info.label} title={info.label} data-testid="sync-badge" data-status={sync.status}>
		<Icon name={info.icon} size={20} />
	</a>
{/if}
