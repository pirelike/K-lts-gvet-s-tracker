<script lang="ts">
	import { page } from '$app/state';
	import { href } from '$lib/nav';
</script>

<div class="page">
	<div class="card center stack">
		<h1>{page.status === 404 ? 'Nincs ilyen oldal' : 'Hiba történt'}</h1>
		<p class="muted">{page.error?.message}</p>
		<a class="btn primary" href={href('/')}>Vissza a főoldalra</a>
	</div>
</div>
