/**
 * A szinkronmotor valós forgatókönyvei: két „eszköz" (két külön fake-indexeddb adatbázis, két motor) egy
 * közös memória-felhővel. A hálózati hibák és versenyhelyzetek a szolgáltató burkolásával idézhetők elő.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openLedgerDb } from '../src/lib/db/idb';
import { LedgerRepo } from '../src/lib/db/repo';
import { META_SYNC, META_SYNC_KEY, syncOnce } from '../src/lib/sync/core';
import {
	BACKOFF_MAX_MS,
	BACKOFF_START_MS,
	DEBOUNCE_MS,
	SyncEngine,
	type SyncEvent,
	type Timers
} from '../src/lib/sync/engine.svelte';
import { createSyncKey, decodeSyncFile, peekSyncFile } from '../src/lib/sync/format';
import { isNewId } from '../src/lib/sync/ids';
import { createMemoryBackend, createMemoryProvider, type MemoryBackend } from '../src/lib/sync/memory';
import { SyncNetworkError, type SyncProvider } from '../src/lib/sync/provider';
import { stamp } from '../src/lib/sync/stamp';
import type { Recurring, Transaction } from '../src/lib/types';

const PASSWORD = 'helyes-lo-elem-tuzelo';

// ---------- eszköz-építő ----------

/** Kézzel léptethető időzítők (a fake-indexeddb saját időzítőit nem zavarja). */
function fakeTimers() {
	let now = 0;
	let seq = 0;
	const tasks = new Map<number, { at: number; fn: () => void }>();
	const timers: Timers = {
		set: (fn, ms) => {
			const id = ++seq;
			tasks.set(id, { at: now + ms, fn });
			return id;
		},
		clear: (h) => void tasks.delete(h as number)
	};
	return {
		timers,
		pending: () => [...tasks.values()].map((t) => t.at - now).sort((a, b) => a - b),
		/** Az esedékes időzítők lefuttatása; az újonnan ütemezettek is, ha még a lépésen belül esedékesek. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				tasks.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await new Promise((r) => setTimeout(r, 30)); // a futás befejezéséhez idő
			}
			now = end;
		}
	};
}

let n = 0;
interface Device {
	repo: LedgerRepo;
	engine: SyncEngine;
	events: SyncEvent[];
	reloads: () => number;
	unlocked: { value: boolean };
	timers: ReturnType<typeof fakeTimers>;
	synced: number[];
}

async function device(backend: MemoryBackend, wrap: (p: SyncProvider) => SyncProvider = (p) => p): Promise<Device> {
	const repo = new LedgerRepo(await openLedgerDb(`engine-${n++}`));
	await repo.seedDefaultsIfNeeded();
	const engine = new SyncEngine();
	const timers = fakeTimers();
	engine.configure({
		factories: { memory: () => wrap(createMemoryProvider(backend, { enabled: true, account: 'anna@example.com' })) },
		kdfIterations: 1000,
		timers: timers.timers
	});
	const events: SyncEvent[] = [];
	const synced: number[] = [];
	let reloads = 0;
	const unlocked = { value: true };
	await engine.attach({
		repo,
		reload: async () => void reloads++,
		unlocked: () => unlocked.value,
		onEvent: (e) => events.push(e),
		onSynced: (at) => synced.push(at)
	});
	return { repo, engine, events, reloads: () => reloads, unlocked, timers, synced };
}

const tx = (over: Partial<Transaction> = {}): Omit<Transaction, 'id'> => {
	const at = stamp();
	return {
		type: 'expense', amount: 1000, date: '2026-09-10', description: 'Kávé', categoryId: 101, accountId: 1, toAccountId: null,
		note: '', tags: [], createdAt: at, updatedAt: at, ...over
	};
};
const addTx = (d: Device, over: Partial<Transaction> = {}) => d.repo.add<Transaction>('transactions', tx(over));
const editTx = (d: Device, t: Transaction, over: Partial<Transaction>) => d.repo.put('transactions', { ...t, ...over, updatedAt: stamp() });
const txs = async (d: Device) => (await d.repo.loadAll()).transactions;
const descriptions = async (d: Device) => (await txs(d)).map((t) => t.description).sort();

/** Csatlakozás új fájllal / meglévővel, a jelszóval. */
async function connect(d: Device, over: Parameters<SyncEngine['completeConnect']>[0] = {}) {
	await d.engine.beginConnect('memory');
	return d.engine.completeConnect({ password: PASSWORD, ...over });
}

// ---------- alapforgatókönyvek ----------

describe('szinkron két eszköz között', () => {
	it('az A-n felvett tétel megjelenik B-n; a B-n felvett vissza az A-ra; a törlés is átmegy', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await addTx(A, { description: 'A kávé' });
		expect(await connect(A)).toMatchObject({ ok: true });
		expect(cloud.file).not.toBeNull();

		// B még üres (csak alapadatok): átveszi A adatait, és ugyanabban a korszakban lesz.
		expect(await connect(B)).toMatchObject({ ok: true });
		expect(await descriptions(B)).toEqual(['A kávé']);
		expect((await B.repo.getSyncMeta()).epoch).toEqual((await A.repo.getSyncMeta()).epoch);
		expect(B.reloads()).toBeGreaterThan(0);

		// B felvesz egyet → A-n megjelenik.
		await addTx(B, { description: 'B ebéd' });
		expect((await B.engine.syncNow())?.ok).toBe(true);
		const out = await A.engine.syncNow();
		expect(out && out.ok && out.changedLocal).toBe(true);
		expect(await descriptions(A)).toEqual(['A kávé', 'B ebéd']);
		expect(A.events).toContainEqual(expect.objectContaining({ type: 'changes' }));

		// B törli az A kávéját → A-n eltűnik.
		const aCoffee = (await txs(B)).find((t) => t.description === 'A kávé')!;
		await B.repo.remove('transactions', aCoffee.id);
		await B.engine.syncNow();
		await A.engine.syncNow();
		expect(await descriptions(A)).toEqual(['B ebéd']);
		expect(A.synced.length).toBeGreaterThan(0);
	});

	it('a felhőfájl titkosított, tartalma nem olvasható benne', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await addTx(A, { description: 'titkos kávé' });
		await connect(A);
		expect(cloud.file!.text).not.toContain('titkos kávé');
		expect(peekSyncFile(cloud.file!.text)).toMatchObject({ ok: true, encrypted: true });
		expect(await A.repo.getMeta(META_SYNC_KEY)).toBeTruthy();
		expect(JSON.stringify(await A.repo.getMeta(META_SYNC))).not.toContain(PASSWORD);
	});

	it('két oldali szerkesztés: az újabb nyer; a kihagyott szinkron nem veszít semmit', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		const t = await addTx(A, { description: 'közös', amount: 100 });
		await connect(A);
		await connect(B);
		const tB = (await txs(B)).find((x) => x.id === t.id)!;
		await editTx(A, t, { amount: 200 });
		await editTx(B, tB, { amount: 300 }); // újabb
		await A.engine.syncNow();
		await B.engine.syncNow();
		await A.engine.syncNow();
		expect((await txs(A))[0].amount).toBe(300);
		expect((await txs(B))[0].amount).toBe(300);
	});

	it('kapcsolat nélkül a módosítás megmarad, és később feltöltődik', async () => {
		const cloud = createMemoryBackend();
		let offline = false;
		const A = await device(cloud, (p) => ({
			...p,
			read: async () => {
				if (offline) throw new SyncNetworkError();
				return p.read();
			}
		}));
		await connect(A);
		offline = true;
		await addTx(A, { description: 'offline tétel' });
		const failed = await A.engine.syncNow();
		expect(failed).toMatchObject({ ok: false, kind: 'network' });
		expect(A.engine.status).toBe('error');
		expect(A.engine.errorKind).toBe('network');
		expect((await txs(A)).map((t) => t.description)).toEqual(['offline tétel']);
		offline = false;
		expect((await A.engine.syncNow())?.ok).toBe(true);
		expect(A.engine.status).toBe('idle');
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const remote = await decodeSyncFile(cloud.file!.text, key);
		expect(remote.ok && remote.state.data.transactions.map((t) => t.description)).toEqual(['offline tétel']);
	});

	it('az ugyanazon előfordulás kétoldali jóváhagyása egyetlen tételt ad', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		const rule: Omit<Recurring, 'id'> = {
			type: 'expense', amount: 90000, description: 'Albérlet', categoryId: 101, accountId: 1, toAccountId: null, note: '', tags: [],
			frequency: 'monthly', interval: 1, startDate: '2026-09-05', endDate: null, lastHandled: null, active: true, createdAt: stamp(), updatedAt: stamp()
		};
		const r = await A.repo.add<Recurring>('recurring', rule);
		await connect(A);
		await connect(B);
		// Mindkét eszköz jóváhagyja ugyanazt az előfordulást.
		const row = (): Omit<Transaction, 'id'> => tx({ description: 'Albérlet', amount: 90000, date: '2026-09-05', recurringId: r.id });
		await A.repo.applyRecurring(r.id, null, '2026-09-05', row());
		await B.repo.applyRecurring(r.id, null, '2026-09-05', row());
		await A.engine.syncNow();
		await B.engine.syncNow();
		await A.engine.syncNow();
		for (const d of [A, B]) {
			const all = await txs(d);
			expect(all).toHaveLength(1);
			expect((await d.repo.loadAll()).recurring[0].lastHandled).toBe('2026-09-05');
		}
	});
});

describe('versenyhelyzetek', () => {
	it('ha közben másik eszköz ír a felhőbe (conflict), újra letölti és összefésüli, semmi nem vész el', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await connect(A);
		await connect(B);
		await addTx(A, { description: 'A' });
		// B a saját, közben történő írását az A olvasása és írása közé ékeli.
		let injected = false;
		const A2Provider = createMemoryProvider(cloud, { enabled: true });
		const wrapped: SyncProvider = {
			...A2Provider,
			read: async () => {
				const f = await A2Provider.read();
				if (!injected) {
					injected = true;
					await addTx(B, { description: 'B' });
					await B.engine.syncNow(); // B felírja a felhőbe, miután A már olvasott
				}
				return f;
			}
		};
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const res = await syncOnce({ repo: A.repo, provider: wrapped, key, deviceId: 'a', lastSyncAt: null });
		expect(res.ok).toBe(true);
		expect(await descriptions(A)).toEqual(['A', 'B']);
		const remote = await decodeSyncFile(cloud.file!.text, key);
		expect(remote.ok && remote.state.data.transactions.map((t) => t.description).sort()).toEqual(['A', 'B']);
	});

	it('szinkron közben végzett helyi módosítás nem íródik felül (védett csere), hanem a következő körben beolvad', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await connect(A);
		await connect(B);
		await addTx(B, { description: 'B tétel' });
		await B.engine.syncNow();
		let injected = false;
		const inner = createMemoryProvider(cloud, { enabled: true });
		const wrapped: SyncProvider = {
			...inner,
			read: async () => {
				const f = await inner.read();
				if (!injected) {
					injected = true;
					await addTx(A, { description: 'A közben' }); // a felhasználó szerkeszt, míg a letöltés tart
				}
				return f;
			}
		};
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const res = await syncOnce({ repo: A.repo, provider: wrapped, key, deviceId: 'a', lastSyncAt: null });
		expect(res.ok).toBe(true);
		expect(await descriptions(A)).toEqual(['A közben', 'B tétel']);
		// A felhőbe is mindkettő felkerült.
		const remote = await decodeSyncFile(cloud.file!.text, key);
		expect(remote.ok && remote.state.data.transactions).toHaveLength(2);
	});

	it('három egymás utáni conflict után nem ír, hanem hibát jelez (később újrapróbálja)', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await connect(A);
		await addTx(A, { description: 'x' });
		const inner = createMemoryProvider(cloud, { enabled: true });
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const always: SyncProvider = { ...inner, write: async () => ({ ok: false, conflict: true }) };
		expect(await syncOnce({ repo: A.repo, provider: always, key, deviceId: 'a', lastSyncAt: null })).toMatchObject({ ok: false, kind: 'conflict' });
		expect(await descriptions(A)).toEqual(['x']); // a helyi adat érintetlen
	});
});

describe('korszak (epoch)', () => {
	it('ha másik eszközön mentést töltöttek vissza, az itteni nem szinkronizált módosítások elvesznek, de előtte mentés készül', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await connect(A);
		await connect(B);
		await addTx(B, { description: 'B még nem szinkronizált' });
		// A visszatölt egy mentést: új korszak, csak az ő adataival.
		await A.repo.replaceAll({ ...(await A.repo.loadAll()), transactions: [] });
		await addTx(A, { description: 'visszatöltött' });
		expect((await A.engine.syncNow())?.ok).toBe(true);

		const out = await B.engine.syncNow();
		expect(out && out.ok && out.report.epochLost).toBeGreaterThanOrEqual(1);
		expect(await descriptions(B)).toEqual(['visszatöltött']);
		expect(B.events).toContainEqual(expect.objectContaining({ type: 'epochLost', winner: 'remote' }));
		// A felülírás előtti helyi állapot letölthető JSON-mentésként megmaradt.
		expect(B.engine.lostBackup).not.toBeNull();
		const backup = JSON.parse(B.engine.lostBackup!.json);
		expect(backup.transactions.map((t: Transaction) => t.description)).toEqual(['B még nem szinkronizált']);
		expect(await B.repo.getMeta('lostBackup')).toBeTruthy(); // újratöltés után is elérhető
		await B.engine.clearLostBackup();
		expect(B.engine.lostBackup).toBeNull();
	});
});

// ---------- csatlakozás ----------

describe('első csatlakozás', () => {
	it('rossz jelszó: hiba, és semmi nem mentődik (sem kapcsolat, sem kulcs, sem adat)', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		await B.engine.beginConnect('memory');
		const r = await B.engine.completeConnect({ password: 'teljesen-mas-jelszo' });
		expect(r).toMatchObject({ ok: false, code: 'wrongPassword' });
		expect(await B.repo.getMeta(META_SYNC)).toBeUndefined();
		expect(await B.repo.getMeta(META_SYNC_KEY)).toBeUndefined();
		expect(await txs(B)).toEqual([]);
		expect(B.engine.connected).toBe(false);
		// A helyes jelszó ugyanazon a folyamaton belül még megadható.
		expect(await B.engine.completeConnect({ password: PASSWORD })).toMatchObject({ ok: true });
		expect(await descriptions(B)).toEqual(['A']);
	});

	it('gyenge vagy hiányzó jelszó új fájlnál; titkosítás nélkül sima fájl készül', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await A.engine.beginConnect('memory');
		expect(await A.engine.completeConnect({})).toMatchObject({ ok: false, code: 'needsPassword' });
		expect(await A.engine.completeConnect({ password: 'rövid' })).toMatchObject({ ok: false, code: 'weakPassword' });
		expect(await A.engine.completeConnect({ unencrypted: true })).toMatchObject({ ok: true });
		expect(peekSyncFile(cloud.file!.text)).toEqual({ ok: true, encrypted: false });
		expect(A.engine.encrypted).toBe(false);
		expect(await A.repo.getMeta(META_SYNC_KEY)).toBeUndefined();
	});

	it('a helyi oldal saját adatot tartalmaz, a felhőben is van: a felhasználónak kell döntenie', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		await addTx(B, { description: 'B saját' });
		await B.engine.beginConnect('memory');
		const first = await B.engine.completeConnect({ password: PASSWORD });
		expect(first).toMatchObject({ ok: false, code: 'needsChoice', local: { transactions: 1 }, remote: { transactions: 1 } });
		expect(B.engine.connected).toBe(false);
		expect(await descriptions(B)).toEqual(['B saját']); // amíg nincs döntés, nem történt semmi

		// „Összefésülés": mindkettő megmarad, az alapelemekből nincs duplikátum.
		const merged = await B.engine.completeConnect({ password: PASSWORD, choice: 'merge' });
		expect(merged).toMatchObject({ ok: true });
		expect(await descriptions(B)).toEqual(['A', 'B saját']);
		const data = await B.repo.loadAll();
		expect(data.categories.filter((c) => c.name === 'Étel')).toHaveLength(1);
		expect(data.accounts.filter((a) => a.name === 'Készpénz')).toHaveLength(1);
		expect(data.transactions.every((t) => isNewId(t.id))).toBe(true); // a régi sorszámok átszámozva
		// A felhőbe is felkerült a B tétele, így A is megkapja.
		await A.engine.syncNow();
		expect(await descriptions(A)).toEqual(['A', 'B saját']);
	});

	it('„a felhőben lévő adatok használata": előtte a helyi adatok JSON-mentése átadódik, majd a helyi cserélődik', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		await addTx(B, { description: 'B saját' });
		await B.engine.beginConnect('memory');
		let saved = '';
		const r = await B.engine.completeConnect({
			password: PASSWORD,
			choice: 'remote',
			beforeOverwrite: (json) => void (saved = json)
		});
		expect(r).toMatchObject({ ok: true });
		expect(JSON.parse(saved).transactions.map((t: Transaction) => t.description)).toEqual(['B saját']);
		expect(await descriptions(B)).toEqual(['A']);
	});

	it('kijelentkezés: a kapcsolat és a kulcs törlődik, a felhőfájl megmarad; a „felhőadatok törlése" a fájlt is törli', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		await A.engine.disconnect();
		expect(A.engine.connected).toBe(false);
		expect(A.engine.status).toBe('off');
		expect(await A.repo.getMeta(META_SYNC)).toBeUndefined();
		expect(await A.repo.getMeta(META_SYNC_KEY)).toBeUndefined();
		expect(cloud.file).not.toBeNull();
		expect(await descriptions(A)).toEqual(['A']); // a helyi adat megmarad

		await connect(A); // újra csatlakozik: ugyanaz a fájl, saját adat mindkét oldalon → döntés
		const again = await A.engine.completeConnect({ password: PASSWORD, choice: 'merge' });
		expect(again).toMatchObject({ ok: true });
		await A.engine.deleteCloudData();
		expect(cloud.file).toBeNull();
		expect(A.engine.connected).toBe(false);
	});
});

describe('jelszócsere', () => {
	it('új jelszóval azonnal újrafeltöltődik; a másik eszköz jelszót kér, és az újjal folytatja', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		await connect(B);

		expect(await A.engine.changePassword('uj-jelszo-12345')).toEqual({ ok: true });
		const head = peekSyncFile(cloud.file!.text);
		expect(head.ok && head.encrypted).toBe(true);

		await addTx(B, { description: 'B' });
		const out = await B.engine.syncNow();
		expect(out).toMatchObject({ ok: false, kind: 'password' });
		expect(B.engine.errorKind).toBe('password');
		expect(B.engine.status).toBe('error');
		expect(await descriptions(B)).toEqual(['A', 'B']); // a helyi adat érintetlen

		expect(await B.engine.retryPassword('rossz-jelszo-123')).toMatchObject({ ok: false });
		expect(await B.engine.retryPassword('uj-jelszo-12345')).toEqual({ ok: true });
		await new Promise((r) => setTimeout(r, 100)); // az újrapróbálás a háttérben fut
		await A.engine.syncNow();
		expect(await descriptions(A)).toEqual(['A', 'B']);
	});

	it('titkosítás nélküli kapcsolaton nem cserélhető jelszó; gyenge jelszót elutasít', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await A.engine.beginConnect('memory');
		await A.engine.completeConnect({ unencrypted: true });
		expect(await A.engine.changePassword('uj-jelszo-12345')).toMatchObject({ ok: false });
		const B = await device(createMemoryBackend());
		await connect(B);
		expect(await B.engine.changePassword('rövid')).toMatchObject({ ok: false });
	});
});

describe('érvénytelen felhőfájl', () => {
	it('sérült vagy idegen fájlnál hiba, és a helyi adat sértetlen marad', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		const rev = cloud.file!.rev;
		cloud.file = { text: '{"nem": "szinkronfájl"}', rev };
		const out = await A.engine.syncNow();
		expect(out).toMatchObject({ ok: false, kind: 'invalid' });
		expect(A.engine.errorKind).toBe('invalid');
		expect(await descriptions(A)).toEqual(['A']);
		expect(cloud.file.text).toBe('{"nem": "szinkronfájl"}'); // a felhőbe sem írtunk
	});

	it('az érvénytelen (pl. hivatkozás nélküli) távoli állapotból nem lesz helyi adat', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		await connect(B);
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const good = await decodeSyncFile(cloud.file!.text, key);
		if (!good.ok) throw new Error('dekódolás');
		const broken = structuredClone(good.state);
		broken.data.transactions[0].categoryId = 424242; // nincs ilyen kategória
		const { encodeSyncFile } = await import('../src/lib/sync/format');
		cloud.file = { text: await encodeSyncFile(broken, { key, deviceId: 'x' }), rev: cloud.file!.rev };
		const out = await B.engine.syncNow();
		expect(out).toMatchObject({ ok: false, kind: 'invalid' });
		expect(await descriptions(B)).toEqual(['A']); // a B eredeti (jó) adata
	});
});

// ---------- ütemezés ----------

describe('ütemezés', () => {
	it('a helyi módosítás 4 mp késleltetéssel indít szinkront, és a függő jelző lekapcsolódik', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await connect(A);
		A.engine.start();
		await new Promise((r) => setTimeout(r, 50));
		const before = A.synced.length;

		await addTx(A, { description: 'késleltetett' });
		A.engine.markDirty();
		expect(A.engine.pendingLocalChanges).toBe(true);
		expect(A.timers.pending()).toEqual([DEBOUNCE_MS]);
		await A.timers.advance(DEBOUNCE_MS - 1);
		expect(A.synced.length).toBe(before); // még nem futott
		await A.timers.advance(2);
		expect(A.synced.length).toBe(before + 1);
		expect(A.engine.pendingLocalChanges).toBe(false);
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const remote = await decodeSyncFile(cloud.file!.text, key);
		expect(remote.ok && remote.state.data.transactions.map((t) => t.description)).toEqual(['késleltetett']);
		A.engine.stop();
	});

	it('gyors egymás utáni módosítások egyetlen futássá olvadnak (debounce)', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await connect(A);
		A.engine.start();
		await new Promise((r) => setTimeout(r, 50));
		const before = A.synced.length;
		for (let i = 0; i < 5; i++) {
			await addTx(A, { description: `t${i}` });
			A.engine.markDirty();
			await A.timers.advance(1000);
		}
		expect(A.timers.pending()).toEqual([DEBOUNCE_MS - 1000]); // egyetlen, az utolsó módosítástól számolt időzítő
		await A.timers.advance(DEBOUNCE_MS - 1000);
		expect(A.synced.length).toBe(before + 1);
		A.engine.stop();
	});

	it('hálózati hiba után exponenciális visszalépés (30 mp → … → 10 perc), siker után újraindul', async () => {
		const cloud = createMemoryBackend();
		let offline = false;
		let reads = 0;
		const A = await device(cloud, (p) => ({
			...p,
			read: async () => {
				reads++;
				if (offline) throw new SyncNetworkError();
				return p.read();
			}
		}));
		await connect(A);
		A.engine.start();
		await new Promise((r) => setTimeout(r, 50));
		offline = true;
		await addTx(A);
		A.engine.markDirty();
		await A.timers.advance(DEBOUNCE_MS); // 1. hiba
		expect(A.engine.errorKind).toBe('network');
		expect(A.timers.pending()).toEqual([BACKOFF_START_MS]);
		const delays: number[] = [BACKOFF_START_MS];
		for (let i = 0; i < 6; i++) {
			await A.timers.advance(delays[delays.length - 1]);
			const next = A.timers.pending();
			expect(next).toHaveLength(1);
			delays.push(next[0]);
		}
		expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
		offline = false;
		await A.timers.advance(BACKOFF_MAX_MS);
		expect(A.engine.status).toBe('idle');
		expect(A.timers.pending()).toEqual([]);
		expect(reads).toBeGreaterThan(5);
		A.engine.stop();
	});

	it('zárolt állapotban és leállítás után nem fut szinkron; a leállítás törli az időzítőket', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await connect(A);
		A.engine.start();
		await new Promise((r) => setTimeout(r, 50));
		const before = A.synced.length;
		await addTx(A);
		A.engine.markDirty();
		expect(A.timers.pending()).toHaveLength(1);
		A.engine.stop();
		expect(A.timers.pending()).toEqual([]);
		await A.timers.advance(60_000);
		expect(A.synced.length).toBe(before);
		// Zárolt (unlocked = false) állapotban a közvetlen futás sem csinál semmit.
		A.engine.start();
		A.unlocked.value = false;
		expect(await A.engine.run()).toBeNull();
		A.engine.stop();
	});

	it('egyszerre egy futás: a párhuzamos hívás nem indít másodikat', async () => {
		const cloud = createMemoryBackend();
		let reads = 0;
		const A = await device(cloud, (p) => ({
			...p,
			read: async () => {
				reads++;
				await new Promise((r) => setTimeout(r, 40));
				return p.read();
			}
		}));
		await connect(A);
		A.engine.start();
		await new Promise((r) => setTimeout(r, 200));
		reads = 0;
		const [x, y] = await Promise.all([A.engine.run({ manual: true }), A.engine.run({ manual: true })]);
		expect([x, y].filter(Boolean)).toHaveLength(1);
		expect(reads).toBe(1);
		A.engine.stop();
	});

	it('lejárt token: csendes megújítás nem sikerül → „szünetel", adat nem vész el; koppintásra folytatódik', async () => {
		const cloud = createMemoryBackend();
		let tokenOk = true;
		const A = await device(cloud, (p) => ({
			...p,
			ensureToken: async (interactive) => tokenOk || interactive
		}));
		await connect(A);
		A.engine.start();
		await new Promise((r) => setTimeout(r, 50));
		tokenOk = false;
		await addTx(A, { description: 'függő' });
		A.engine.markDirty();
		await A.timers.advance(DEBOUNCE_MS);
		expect(A.engine.status).toBe('paused');
		expect(A.engine.pendingLocalChanges).toBe(true);
		expect(await descriptions(A)).toEqual(['függő']);
		const out = await A.engine.syncNow(); // felhasználói gesztus: interaktív megújítás sikerül
		expect(out?.ok).toBe(true);
		expect(A.engine.status).toBe('idle');
		A.engine.stop();
	});
});

describe('kulcs és korszak első csatlakozáskor', () => {
	it('a helyi korszak a csatlakozáskor jön létre (új tartományú azonosítóval), és a kapcsolat `deviceId`-t kap', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		expect((await A.repo.getSyncMeta()).epoch).toBeNull();
		await connect(A);
		const epoch = (await A.repo.getSyncMeta()).epoch;
		expect(epoch && isNewId(epoch.id)).toBe(true);
		const conn = await A.repo.getMeta<{ deviceId: string; encrypted: boolean }>(META_SYNC);
		expect(conn?.deviceId).toMatch(/^[0-9a-f]{16}$/);
		expect(conn?.encrypted).toBe(true);
		// A kulcs használható: a felhőfájl vele visszafejthető.
		const key = (await A.repo.getMeta<Awaited<ReturnType<typeof createSyncKey>>>(META_SYNC_KEY))!;
		expect((await decodeSyncFile(cloud.file!.text, key)).ok).toBe(true);
	});

	it('újraindítás után a kapcsolat és a kulcs visszatöltődik, jelszó nélkül folytatódik', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);
		// „Újraindítás": új motor ugyanazon az adatbázison.
		const engine = new SyncEngine();
		engine.configure({ factories: { memory: () => createMemoryProvider(cloud, { enabled: true }) }, kdfIterations: 1000, timers: fakeTimers().timers });
		await engine.attach({ repo: A.repo, reload: async () => {}, unlocked: () => true });
		expect(engine.connected).toBe(true);
		expect(engine.account).toBe('anna@example.com');
		expect(engine.status).toBe('idle');
		expect((await engine.syncNow())?.ok).toBe(true);
	});
});

describe('több felhőfájl (két eszköz egyszerre hozott létre fájlt)', () => {
	it('az olvashatatlan (más jelszóval írt) többletpéldányt nem törli, és az elsődleges szinkron zavartalan', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const other = await device(createMemoryBackend());
		await addTx(A, { description: 'A' });
		await connect(A);
		await addTx(other, { description: 'idegen' });
		await connect(other, { password: 'egeszen-mas-jelszo' });
		// Az `other` eszköz saját, más jelszóval titkosított felhőfájlja.
		const otherKey = (await other.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const { encodeSyncFile } = await import('../src/lib/sync/format');
		const { readLocalState } = await import('../src/lib/sync/core');
		const foreign = await encodeSyncFile(await readLocalState(other.repo), { key: otherKey, deviceId: 'x' });
		const discarded: string[] = [];
		const inner = createMemoryProvider(cloud, { enabled: true });
		const wrapped: SyncProvider = {
			...inner,
			read: async () => {
				const f = await inner.read();
				return f && { ...f, extra: [{ text: foreign, ref: 'idegen-1' }] };
			},
			discardCopy: async (ref) => void discarded.push(ref)
		};
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const res = await syncOnce({ repo: A.repo, provider: wrapped, key, deviceId: 'a', lastSyncAt: null });
		expect(res.ok).toBe(true);
		expect(discarded).toEqual([]); // amit nem tudtunk beolvasni, azt nem töröljük
		expect(await descriptions(A)).toEqual(['A']);
	});

	it('ugyanazzal a kulccsal olvasható többletpéldány összefésülődik, majd törlésre kerül', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		const B = await device(createMemoryBackend());
		await addTx(A, { description: 'A' });
		await connect(A);
		// B ugyanahhoz a jelszóhoz/sóhoz jut: átvesz mindent A-tól, majd külön felvesz egy tételt, és a saját példányát „külön fájlként" írja.
		const key = (await A.repo.getMeta<import('../src/lib/sync/format').SyncKey>(META_SYNC_KEY))!;
		const { encodeSyncFile } = await import('../src/lib/sync/format');
		const { readLocalState } = await import('../src/lib/sync/core');
		await B.repo.replaceAll((await A.repo.loadAll()), undefined, undefined, { epoch: (await A.repo.getSyncMeta()).epoch!, tombstones: {} });
		await addTx(B, { description: 'B külön' });
		const copyText = await encodeSyncFile(await readLocalState(B.repo), { key, deviceId: 'b' });

		const discarded: string[] = [];
		const inner = createMemoryProvider(cloud, { enabled: true });
		const wrapped: SyncProvider = {
			...inner,
			read: async () => {
				const f = await inner.read();
				return f && { ...f, extra: [{ text: copyText, ref: 'masolat-1' }] };
			},
			discardCopy: async (ref) => void discarded.push(ref)
		};
		const res = await syncOnce({ repo: A.repo, provider: wrapped, key, deviceId: 'a', lastSyncAt: null });
		expect(res).toMatchObject({ ok: true, uploaded: true });
		expect(await descriptions(A)).toEqual(['A', 'B külön']);
		expect(discarded).toEqual(['masolat-1']);
		const remote = await decodeSyncFile(cloud.file!.text, key);
		expect(remote.ok && remote.state.data.transactions.map((t) => t.description).sort()).toEqual(['A', 'B külön']);
	});
});

describe('átirányításos bejelentkezés befejezése (resumeConnect)', () => {
	it('a félbehagyott csatlakozás a feloldás után a jelszó-lépésnél folytatódik; ha nincs mit, null; hibát átad', async () => {
		const cloud = createMemoryBackend();
		const A = await device(cloud);
		await addTx(A, { description: 'A' });
		await connect(A);

		const repo = new LedgerRepo(await openLedgerDb(`engine-resume-${n++}`));
		await repo.seedDefaultsIfNeeded();
		let mode: 'ok' | 'none' | 'error' = 'ok';
		const engine = new SyncEngine();
		engine.configure({
			factories: {
				memory: (storage) => {
					const p = createMemoryProvider(cloud, { enabled: true, account: 'anna@example.com' });
					return {
						...p,
						resume: async () => {
							if (mode === 'error') throw new Error('A Dropbox-hozzáférést megtagadtad');
							if (mode === 'none') return null;
							await storage.save({ accessToken: 'x' });
							return { account: 'anna@example.com' };
						}
					};
				}
			},
			redirects: [],
			kdfIterations: 1000,
			timers: fakeTimers().timers
		});
		await engine.attach({ repo, reload: async () => {}, unlocked: () => true });

		mode = 'none';
		expect(await engine.resumeConnect()).toBeNull();
		mode = 'error';
		expect(await engine.resumeConnect()).toEqual({ ok: false, error: 'A Dropbox-hozzáférést megtagadtad' });
		expect(engine.probe).toBeNull();

		mode = 'ok';
		const r = await engine.resumeConnect();
		expect(r).toMatchObject({ ok: true, probe: { account: 'anna@example.com', remote: { exists: true, encrypted: true } } });
		expect(engine.probe).not.toBeNull();
		// A szolgáltató által mentett tokenek a kapcsolatba kerülnek.
		expect(await engine.completeConnect({ password: PASSWORD })).toMatchObject({ ok: true });
		expect((await repo.getMeta<{ tokens: unknown }>(META_SYNC))?.tokens).toEqual({ accessToken: 'x' });
		expect(engine.probe).toBeNull();
		expect(await engine.resumeConnect()).toBeNull(); // már csatlakoztatva
	});
});
