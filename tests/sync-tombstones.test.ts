import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { setActiveCurrency } from '../src/lib/currency';
import { openLedgerDb } from '../src/lib/db/idb';
import { LedgerRepo, emptyData } from '../src/lib/db/repo';
import { ledger } from '../src/lib/ledger.svelte';
import { isNewId } from '../src/lib/sync/ids';
import {
	TOMBSTONE_TTL_MS,
	parseTombstoneKey,
	pruneTombstones,
	tombstoneKey
} from '../src/lib/sync/tombstones';
import type { TxInput } from '../src/lib/types';

let n = 0;
let repo: LedgerRepo;
beforeEach(async () => {
	setActiveCurrency('HUF');
	repo = new LedgerRepo(await openLedgerDb(`tomb-${n++}`));
	ledger.attach(repo);
	await repo.seedDefaultsIfNeeded();
	await ledger.load();
});

const cat = (type: 'income' | 'expense', name: string) => ledger.categories.find((c) => c.type === type && c.name === name)!;
const acc = (name: string) => ledger.accounts.find((a) => a.name === name)!;
const expense = (over: Partial<TxInput> = {}): TxInput => ({
	type: 'expense', amount: 1000, date: '2026-09-10', description: 'Kávé', categoryId: cat('expense', 'Étel').id,
	accountId: acc('Készpénz').id, toAccountId: null, note: '', tags: [], ...over
});
const tombs = async () => (await repo.getSyncMeta()).tombstones;

describe('törlési jelölők', () => {
	it('a törlés jelölőt ír, a jelölő ideje újabb a törölt sor updatedAt értékénél', async () => {
		const t = await ledger.addTx(expense());
		expect(await tombs()).toEqual({});
		await ledger.deleteTx(t.id);
		const all = await tombs();
		expect(Object.keys(all)).toEqual([tombstoneKey('transactions', t.id)]);
		expect(all[tombstoneKey('transactions', t.id)]).toBeGreaterThan(t.updatedAt);
		expect((await repo.loadAll()).transactions).toHaveLength(0);
	});

	it('a jelölő akkor is a törölt változatnál újabb, ha annak órája előrejár', async () => {
		const t = await ledger.addTx(expense());
		const future = Date.now() + 10 * 60_000;
		await repo.put('transactions', { ...t, updatedAt: future });
		await repo.remove('transactions', t.id);
		expect((await tombs())[tombstoneKey('transactions', t.id)]).toBeGreaterThan(future);
	});

	it('csoportos törlés minden törölt sorra ír jelölőt', async () => {
		const a = await ledger.addTx(expense());
		const b = await ledger.addTx(expense({ amount: 2000 }));
		await ledger.deleteTxs([a.id, b.id]);
		expect(Object.keys(await tombs()).sort()).toEqual([tombstoneKey('transactions', a.id), tombstoneKey('transactions', b.id)].sort());
	});

	it('mind a hét adattárolóban törlés → jelölő', async () => {
		const c = await ledger.addCategory('expense', { name: 'Törlendő', color: '#112233', icon: '' });
		const a = await ledger.addAccount({ name: 'Törlendő számla', initialBalance: 0 });
		const r = await ledger.addRecurring({
			type: 'expense', amount: 1, description: 'x', categoryId: cat('expense', 'Étel').id, accountId: acc('Készpénz').id,
			toAccountId: null, note: '', tags: [], frequency: 'weekly', interval: 1, startDate: '2026-09-07', endDate: null
		});
		const t = await ledger.addTemplate({ name: 'S', type: 'expense', amount: null, description: '', categoryId: null, accountId: null, toAccountId: null, note: '', tags: [] });
		const g = await ledger.addGoal({ name: 'Cél', icon: '🎯', color: '#4f46e5', target: 10, saved: 0, accountId: null, deadline: null });
		const f = await ledger.addFilter('Szűrő', 'q=a');
		const tx = await ledger.addTx(expense());
		await ledger.deleteCategory(c.id);
		await ledger.deleteAccount(a.id);
		await ledger.deleteRecurring(r.id);
		await ledger.deleteTemplate(t.id);
		await ledger.deleteGoal(g.id);
		await ledger.deleteFilter(f.id);
		await ledger.deleteTx(tx.id);
		expect(Object.keys(await tombs()).sort()).toEqual(
			[
				tombstoneKey('categories', c.id),
				tombstoneKey('accounts', a.id),
				tombstoneKey('recurring', r.id),
				tombstoneKey('templates', t.id),
				tombstoneKey('goals', g.id),
				tombstoneKey('filters', f.id),
				tombstoneKey('transactions', tx.id)
			].sort()
		);
	});

	it('nem létező sor törlése nem ír jelölőt', async () => {
		await repo.remove('transactions', 12345);
		expect(await tombs()).toEqual({});
	});

	it('a törlés visszavonása megszünteti a jelölőt, és új updatedAt-et ad', async () => {
		const t = await ledger.addTx(expense());
		const snap = await ledger.deleteTx(t.id);
		await ledger.restoreTx(snap);
		expect(await tombs()).toEqual({});
		expect((await repo.loadAll()).transactions[0].updatedAt).toBeGreaterThan(snap.updatedAt);

		const many = await ledger.deleteTxs([t.id]);
		expect(Object.keys(await tombs())).toHaveLength(1);
		await ledger.restoreTxs(many);
		expect(await tombs()).toEqual({});
	});

	it('közvetlen put egy jelölt azonosítóra is megszünteti a jelölőt; a többit nem bántja', async () => {
		const a = await ledger.addTx(expense());
		const b = await ledger.addTx(expense({ amount: 5 }));
		const snapA = await ledger.deleteTx(a.id);
		await ledger.deleteTx(b.id);
		await repo.put('transactions', snapA);
		expect(Object.keys(await tombs())).toEqual([tombstoneKey('transactions', b.id)]);
	});

	it('az ismétlődő tétel jóváhagyása megszünteti az előfordulás azonosítójának jelölőjét', async () => {
		const r = await ledger.addRecurring({
			type: 'expense', amount: 1000, description: 'Albérlet', categoryId: cat('expense', 'Étel').id, accountId: acc('Készpénz').id,
			toAccountId: null, note: '', tags: [], frequency: 'monthly', interval: 1, startDate: '2026-09-05', endDate: null
		});
		const tx = (await ledger.handleRecurring(r.id, '2026-09-05', 'approve'))!;
		await ledger.deleteTx(tx.id);
		expect(Object.keys(await tombs())).toEqual([tombstoneKey('transactions', tx.id)]);
		// A szabály lastHandled értéke már előrelépett, így ugyanez az előfordulás nem kínálható fel újra;
		// a jelölő a jóváhagyás közvetlen ismétlésénél (más eszközön) tűnne el.
		await repo.applyRecurring(r.id, '2026-09-05', '2026-09-05', { ...expense(), recurringId: r.id, createdAt: 1, updatedAt: 1 });
		expect(await tombs()).toEqual({});
	});

	it('a jelölő túléli az újratöltést (tartós)', async () => {
		const t = await ledger.addTx(expense());
		await ledger.deleteTx(t.id);
		const again = new LedgerRepo(await openLedgerDb(`tomb-${n - 1}`));
		expect(Object.keys((await again.getSyncMeta()).tombstones)).toEqual([tombstoneKey('transactions', t.id)]);
		again.close();
	});

	it('kulcs: képzés és visszafejtés', () => {
		expect(tombstoneKey('goals', 7)).toBe('goals:7');
		expect(parseTombstoneKey('transactions:9007199254740991')).toEqual({ store: 'transactions', id: 9007199254740991 });
		expect(parseTombstoneKey('rossz')).toBeNull();
		expect(parseTombstoneKey('goals:x')).toBeNull();
	});

	it('takarítás: a 180 napnál régebbi jelölők kikerülnek', () => {
		const now = Date.UTC(2026, 8, 30);
		const kept = { 'a:1': now - TOMBSTONE_TTL_MS + 1000, 'a:2': now - 1000, 'a:3': now - TOMBSTONE_TTL_MS };
		const all = { ...kept, 'a:4': now - TOMBSTONE_TTL_MS - 1, 'a:5': 0 };
		expect(pruneTombstones(all, now)).toEqual(kept);
	});
});

describe('korszak (epoch)', () => {
	it('csatlakozás előtt nincs korszak; az ensureEpoch létrehozza, és utána stabil', async () => {
		expect((await repo.getSyncMeta()).epoch).toBeNull();
		const e = await repo.ensureEpoch();
		expect(isNewId(e.id)).toBe(true);
		expect(await repo.ensureEpoch()).toEqual(e);
		expect((await repo.getSyncMeta()).epoch).toEqual(e);
	});

	it('a szokásos szerkesztések és törlések nem váltanak korszakot', async () => {
		const e = await repo.ensureEpoch();
		const t = await ledger.addTx(expense());
		await ledger.updateTx(t.id, expense({ amount: 5 }));
		await ledger.deleteTx(t.id);
		await ledger.addAccount({ name: 'x', initialBalance: 0 });
		await ledger.setTotalBudget(1000);
		expect((await repo.getSyncMeta()).epoch).toEqual(e);
	});

	it('pénznemváltás új korszakot indít, és elavulttá teszi a jelölőket', async () => {
		const e = await repo.ensureEpoch();
		const t = await ledger.addTx(expense());
		await ledger.deleteTx(t.id);
		expect(Object.keys(await tombs())).toHaveLength(1);
		await ledger.switchCurrency('EUR', 395);
		const meta = await repo.getSyncMeta();
		expect(meta.epoch).not.toBeNull();
		expect(meta.epoch!.id).not.toBe(e.id);
		expect(meta.epoch!.at).toBeGreaterThan(e.at);
		expect(meta.tombstones).toEqual({});
	});

	it('a mentés visszatöltése új korszakot indít', async () => {
		const e = await repo.ensureEpoch();
		await ledger.importBackup(ledger.exportBackup());
		const after = (await repo.getSyncMeta()).epoch!;
		expect(after.id).not.toBe(e.id);
		expect(after.at).toBeGreaterThan(e.at);
	});

	it('a példaadatok betöltése és törlése is új korszakot indít', async () => {
		const e0 = await repo.ensureEpoch();
		await ledger.loadDemoData('2026-09-30');
		const e1 = (await repo.getSyncMeta()).epoch!;
		expect(e1.id).not.toBe(e0.id);
		await ledger.removeDemoData();
		const meta = await repo.getSyncMeta();
		expect(meta.epoch!.id).not.toBe(e1.id);
		expect(meta.tombstones).toEqual({}); // az új korszakban a demo-tételek jelölői már nem kellenek
	});

	it('a szinkron által átadott korszak és jelölők érintetlenül tárolódnak (nincs új korszak)', async () => {
		const epoch = { id: 2 ** 40 + 5, at: 12345 };
		const tombstones = { 'transactions:5': 999 };
		await repo.replaceAll(emptyData(), { currency: 'HUF', totalBudget: null }, 77, { epoch, tombstones });
		expect(await repo.getSyncMeta()).toEqual({ epoch, tombstones });
		expect((await repo.getPrefs()).updatedAt).toBe(77);
	});

	it('a teljes törlés a korszakot és a jelölőket is eltünteti (a szinkron-kapcsolattal együtt)', async () => {
		await repo.ensureEpoch();
		const t = await ledger.addTx(expense());
		await ledger.deleteTx(t.id);
		await repo.setMeta('sync', { provider: 'memory' });
		await repo.wipeAll();
		expect(await repo.getSyncMeta()).toEqual({ epoch: null, tombstones: {} });
		expect(await repo.getMeta('sync')).toBeUndefined();
	});
});
