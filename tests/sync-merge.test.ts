import { describe, expect, it } from 'vitest';
import { emptyData, type LedgerData } from '../src/lib/db/repo';
import { DATA_STORES } from '../src/lib/db/idb';
import { ID_MIN, recurringTxId } from '../src/lib/sync/ids';
import { hasOwnData, mergeStates, remapIds, sameState, stableStringify, validateState, type SyncState } from '../src/lib/sync/merge';
import { tombstoneKey } from '../src/lib/sync/tombstones';
import type { Account, Category, Goal, Recurring, SavedFilter, Template, Transaction } from '../src/lib/types';

// ---------- építőelemek ----------

const EPOCH = { id: ID_MIN + 1, at: 1000 };

const acct = (id: number, name: string, updatedAt = 10, over: Partial<Account> = {}): Account => ({
	id, name, type: 'checking', initialBalance: 0, archived: false, sortOrder: id, createdAt: 1, updatedAt, ...over
});
const cat = (id: number, name: string, updatedAt = 10, over: Partial<Category> = {}): Category => ({
	id, name, type: 'expense', color: '#112233', icon: '', monthlyBudget: null, archived: false, sortOrder: id, createdAt: 1, updatedAt, ...over
});
const tx = (id: number, updatedAt = 10, over: Partial<Transaction> = {}): Transaction => ({
	id, type: 'expense', amount: 1000, date: '2026-09-10', description: 'Kávé', categoryId: 1, accountId: 1, toAccountId: null,
	note: '', tags: [], createdAt: id, updatedAt, ...over
});
const rule = (id: number, updatedAt = 10, over: Partial<Recurring> = {}): Recurring => ({
	id, type: 'expense', amount: 500, description: 'Albérlet', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [],
	frequency: 'monthly', interval: 1, startDate: '2026-01-05', endDate: null, lastHandled: null, active: true, createdAt: 1, updatedAt, ...over
});
const tpl = (id: number, updatedAt = 10, over: Partial<Template> = {}): Template => ({
	id, name: 'Sablon', type: 'expense', amount: null, description: '', categoryId: null, accountId: null, toAccountId: null,
	note: '', tags: [], sortOrder: id, createdAt: 1, updatedAt, ...over
});
const goal = (id: number, updatedAt = 10, over: Partial<Goal> = {}): Goal => ({
	id, name: 'Cél', icon: '🎯', color: '#4f46e5', target: 1000, saved: 0, accountId: null, deadline: null, archived: false,
	sortOrder: id, createdAt: 1, updatedAt, ...over
});
const filt = (id: number, updatedAt = 10): SavedFilter => ({ id, name: 'Szűrő', query: 'q=a', createdAt: 1, updatedAt });

/** Alapállapot: egy számla, egy kiadási kategória (id 1). */
function st(over: Partial<Omit<SyncState, 'data'>> & { data?: Partial<LedgerData> } = {}): SyncState {
	const { data, ...rest } = over;
	return {
		epoch: EPOCH,
		prefs: { currency: 'HUF', totalBudget: null },
		prefsUpdatedAt: 0,
		tombstones: {},
		...rest,
		data: { ...emptyData(), accounts: [acct(1, 'Készpénz')], categories: [cat(1, 'Étel')], ...data }
	};
}

const merge = (a: SyncState, b: SyncState) => mergeStates(a, b);
const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((x, y) => x - y);

// ---------- egységtesztek ----------

describe('mergeStates: rekordok', () => {
	it('az egyoldali hozzáadás átkerül a másik oldalra (mindkét irányban)', () => {
		const a = st({ data: { transactions: [tx(11)] } });
		const b = st();
		const ab = merge(a, b);
		expect(ids(ab.state.data.transactions)).toEqual([11]);
		expect(ab.localChanged).toBe(false); // a helyi már tartalmazza
		expect(ab.remoteChanged).toBe(true);
		expect(ab.report.transactions).toEqual({ added: 0, updated: 0, removed: 0 });

		const ba = merge(b, a);
		expect(ids(ba.state.data.transactions)).toEqual([11]);
		expect(ba.localChanged).toBe(true);
		expect(ba.remoteChanged).toBe(false);
		expect(ba.report).toMatchObject({ added: 1, updated: 0, removed: 0, transactions: { added: 1, updated: 0, removed: 0 } });
	});

	it('két oldali szerkesztés: az újabb updatedAt nyer, mindkét sorrendben', () => {
		const a = st({ data: { transactions: [tx(11, 20, { amount: 111 })] } });
		const b = st({ data: { transactions: [tx(11, 30, { amount: 222 })] } });
		expect(merge(a, b).state.data.transactions[0].amount).toBe(222);
		expect(merge(b, a).state.data.transactions[0].amount).toBe(222);
		const r = merge(a, b);
		expect(r.localChanged).toBe(true);
		expect(r.remoteChanged).toBe(false);
		expect(r.report.transactions.updated).toBe(1);
	});

	it('egyenlő updatedAt: a kulcs-rendezett JSON-ban nagyobb változat nyer, mindkét eszközön ugyanaz', () => {
		const a = st({ data: { transactions: [tx(11, 20, { description: 'alma' })] } });
		const b = st({ data: { transactions: [tx(11, 20, { description: 'körte' })] } });
		const ab = merge(a, b).state.data.transactions[0].description;
		const ba = merge(b, a).state.data.transactions[0].description;
		expect(ab).toBe(ba);
		expect(ab).toBe('körte');
	});

	it('a kulcssorrend nem számít a döntetlen feloldásánál', () => {
		const t1 = tx(11, 20, { note: 'x' });
		const t2 = JSON.parse(JSON.stringify(t1)) as Transaction;
		const reordered = Object.fromEntries(Object.entries(t2).reverse()) as unknown as Transaction;
		expect(stableStringify(t1)).toBe(stableStringify(reordered));
		const r = merge(st({ data: { transactions: [t1] } }), st({ data: { transactions: [reordered] } }));
		expect(r.localChanged || r.remoteChanged).toBe(false);
	});

	it('a törlés legyőzi a régebbi szerkesztést (mindkét sorrendben)', () => {
		const key = tombstoneKey('transactions', 11);
		const edited = st({ data: { transactions: [tx(11, 20)] } });
		const deleted = st({ tombstones: { [key]: 25 } });
		for (const [x, y] of [[edited, deleted], [deleted, edited]]) {
			const r = merge(x, y);
			expect(r.state.data.transactions).toEqual([]);
			expect(r.state.tombstones[key]).toBe(25);
		}
		const r = merge(edited, deleted);
		expect(r.localChanged).toBe(true);
		expect(r.report.transactions.removed).toBe(1);
		expect(r.remoteChanged).toBe(false);
	});

	it('a törlés utáni szerkesztés nyer (mindkét sorrendben), és a jelölő megmarad a térképben', () => {
		const key = tombstoneKey('transactions', 11);
		const editedAfter = st({ data: { transactions: [tx(11, 40, { amount: 7 })] } });
		const deleted = st({ tombstones: { [key]: 25 } });
		for (const [x, y] of [[editedAfter, deleted], [deleted, editedAfter]]) {
			const r = merge(x, y);
			expect(r.state.data.transactions.map((t) => t.amount)).toEqual([7]);
		}
	});

	it('egyenlő idejű törlés és szerkesztés: a törlés nyer (a jelölő ≥ updatedAt)', () => {
		const key = tombstoneKey('transactions', 11);
		const r = merge(st({ data: { transactions: [tx(11, 25)] } }), st({ tombstones: { [key]: 25 } }));
		expect(r.state.data.transactions).toEqual([]);
	});

	it('jelölő-takarítás után egy régi, nem szinkronizált eszköz visszahozhatja a törölt sort', () => {
		const key = tombstoneKey('transactions', 11);
		const stale = st({ data: { transactions: [tx(11, 20)] } });
		const cloudWithTombstone = st({ tombstones: { [key]: 25 } });
		const cloudPruned = st({ tombstones: {} }); // a 180 napos takarítás után
		expect(merge(stale, cloudWithTombstone).state.data.transactions).toEqual([]);
		expect(ids(merge(stale, cloudPruned).state.data.transactions)).toEqual([11]);
	});

	it('törlési jelölők: kulcsonként a nagyobb idő marad', () => {
		const r = merge(st({ tombstones: { 'goals:1': 5, 'goals:2': 9 } }), st({ tombstones: { 'goals:1': 8, 'filters:3': 1 } }));
		expect(r.state.tombstones).toEqual({ 'goals:1': 8, 'goals:2': 9, 'filters:3': 1 });
	});

	it('mind a hét tárolóban működik az egyesítés', () => {
		const a = st({
			data: {
				accounts: [acct(1, 'Készpénz'), acct(2, 'Bank')], categories: [cat(1, 'Étel'), cat(2, 'Utazás')],
				transactions: [tx(11)], recurring: [rule(21)], templates: [tpl(31)], goals: [goal(41)], filters: [filt(51)]
			}
		});
		const b = st({
			data: {
				accounts: [acct(1, 'Készpénz'), acct(3, 'Megtakarítás')], categories: [cat(1, 'Étel'), cat(3, 'Egyéb')],
				transactions: [tx(12)], recurring: [rule(22)], templates: [tpl(32)], goals: [goal(42)], filters: [filt(52)]
			}
		});
		const { state } = merge(a, b);
		expect(ids(state.data.accounts)).toEqual([1, 2, 3]);
		expect(ids(state.data.categories)).toEqual([1, 2, 3]);
		for (const [store, want] of [['transactions', [11, 12]], ['recurring', [21, 22]], ['templates', [31, 32]], ['goals', [41, 42]], ['filters', [51, 52]]] as const) {
			expect(ids(state.data[store])).toEqual(want);
		}
	});
});

describe('mergeStates: ismétlődő szabály', () => {
	it('a lastHandled mezőszinten a nagyobb dátum marad, akkor is, ha a másik rekord nyert', () => {
		const a = st({ data: { recurring: [rule(21, 50, { amount: 999, lastHandled: '2026-08-05' })] } });
		const b = st({ data: { recurring: [rule(21, 30, { amount: 500, lastHandled: '2026-09-05' })] } });
		for (const r of [merge(a, b), merge(b, a)]) {
			const out = r.state.data.recurring[0];
			expect(out.amount).toBe(999); // az újabb szerkesztés nyert
			expect(out.lastHandled).toBe('2026-09-05'); // de a feldolgozott előfordulás nem lép vissza
		}
		expect(merge(a, b).remoteChanged).toBe(true);
	});

	it('a null lastHandled nem ír felül dátumot', () => {
		const a = st({ data: { recurring: [rule(21, 50, { lastHandled: null })] } });
		const b = st({ data: { recurring: [rule(21, 30, { lastHandled: '2026-01-05' })] } });
		expect(merge(a, b).state.data.recurring[0].lastHandled).toBe('2026-01-05');
		expect(merge(b, a).state.data.recurring[0].lastHandled).toBe('2026-01-05');
	});

	it('ugyanazon előfordulás kétoldali jóváhagyása egyetlen tételt ad', async () => {
		const id = await recurringTxId(21, '2026-09-05');
		const approved = (at: number) =>
			st({
				data: {
					recurring: [rule(21, at, { lastHandled: '2026-09-05' })],
					transactions: [tx(id, at, { recurringId: 21, date: '2026-09-05', description: 'Albérlet' })]
				}
			});
		const r = merge(approved(100), approved(140));
		expect(r.state.data.transactions).toHaveLength(1);
		expect(r.state.data.transactions[0].id).toBe(id);
		expect(r.state.data.recurring[0].lastHandled).toBe('2026-09-05');
		expect(validateState(r.state)).toEqual({ ok: true });
	});

	it('az egyik eszközön jóváhagyott, a másikon kihagyott előfordulás: a feldolgozottság nem vész el', () => {
		const a = st({ data: { recurring: [rule(21, 100, { lastHandled: '2026-09-05' })] } });
		const b = st({ data: { recurring: [rule(21, 90, { lastHandled: '2026-08-05' })] } });
		expect(merge(b, a).state.data.recurring[0].lastHandled).toBe('2026-09-05');
	});
});

describe('mergeStates: beállítások', () => {
	it('a nagyobb prefsUpdatedAt nyer', () => {
		const a = st({ prefs: { currency: 'HUF', totalBudget: 1000 }, prefsUpdatedAt: 20 });
		const b = st({ prefs: { currency: 'HUF', totalBudget: 2000 }, prefsUpdatedAt: 30 });
		for (const r of [merge(a, b), merge(b, a)]) {
			expect(r.state.prefs.totalBudget).toBe(2000);
			expect(r.state.prefsUpdatedAt).toBe(30);
		}
	});

	it('egyenlő prefsUpdatedAt: determinisztikus választás', () => {
		const a = st({ prefs: { currency: 'HUF', totalBudget: 1000 }, prefsUpdatedAt: 20 });
		const b = st({ prefs: { currency: 'HUF', totalBudget: 2000 }, prefsUpdatedAt: 20 });
		expect(merge(a, b).state.prefs).toEqual(merge(b, a).state.prefs);
	});
});

describe('mergeStates: hivatkozások javítása', () => {
	it('törölt kategóriára mutató új tétel: a kategória visszaéled, a jelölő megszűnik', () => {
		const key = tombstoneKey('categories', 2);
		// A töröl: a 2-es kategória tombstone-nal eltűnt. B közben tételt vett fel rá.
		const a = st({ tombstones: { [key]: 50 } });
		const b = st({
			data: { categories: [cat(1, 'Étel'), cat(2, 'Utazás', 10)], transactions: [tx(11, 60, { categoryId: 2 })] }
		});
		for (const r of [merge(a, b), merge(b, a)]) {
			expect(ids(r.state.data.categories)).toEqual([1, 2]);
			expect(key in r.state.tombstones).toBe(false);
			expect(r.report.repaired).toEqual(['Kategória visszaállítva: „Utazás" (egy tétel még használja)']);
			expect(validateState(r.state)).toEqual({ ok: true });
		}
	});

	it('törölt számlára mutató ismétlődő szabály: a számla visszaéled', () => {
		const key = tombstoneKey('accounts', 2);
		const a = st({ tombstones: { [key]: 50 } });
		const b = st({ data: { accounts: [acct(1, 'Készpénz'), acct(2, 'Bank')], recurring: [rule(21, 60, { accountId: 2 })] } });
		const r = merge(a, b);
		expect(ids(r.state.data.accounts)).toEqual([1, 2]);
		expect(r.report.repaired).toEqual(['Számla visszaállítva: „Bank" (egy tétel még használja)']);
	});

	it('a felosztott tétel részének kategóriája is visszaéled', () => {
		const key = tombstoneKey('categories', 3);
		const a = st({ tombstones: { [key]: 50 } });
		const b = st({
			data: {
				categories: [cat(1, 'Étel'), cat(3, 'Háztartás')],
				transactions: [tx(11, 60, { amount: 500, splits: [{ categoryId: 1, amount: 300 }, { categoryId: 3, amount: 200 }] })]
			}
		});
		const r = merge(a, b);
		expect(ids(r.state.data.categories)).toEqual([1, 3]);
		expect(validateState(r.state)).toEqual({ ok: true });
	});

	it('törölt kategória/számla nélkül maradó sablon és cél hivatkozása null lesz', () => {
		const a = st({ tombstones: { [tombstoneKey('categories', 2)]: 50, [tombstoneKey('accounts', 2)]: 50 } });
		const b = st({
			data: {
				accounts: [acct(1, 'Készpénz'), acct(2, 'Bank', 10)],
				categories: [cat(1, 'Étel'), cat(2, 'Utazás', 10)],
				templates: [tpl(31, 60, { categoryId: 2, accountId: 2, toAccountId: 1, name: 'Bérlet' })],
				goals: [goal(41, 60, { accountId: 2, name: 'Laptop' })]
			}
		});
		const r = merge(a, b);
		expect(r.state.data.templates[0]).toMatchObject({ categoryId: null, accountId: null, toAccountId: 1 });
		expect(r.state.data.goals[0].accountId).toBeNull();
		expect(ids(r.state.data.categories)).toEqual([1]); // nincs, ami visszahozná
		expect(r.report.repaired).toEqual([
			'Cél „Laptop": a megszűnt számla-hivatkozás törölve',
			'Sablon „Bérlet": a megszűnt kategória-hivatkozás törölve',
			'Sablon „Bérlet": a megszűnt számla-hivatkozás törölve'
		]);
		expect(validateState(r.state)).toEqual({ ok: true });
	});

	it('ha nincs honnan visszahozni a hivatkozott elemet, a validáció hibát jelez (nem írunk semmit)', () => {
		const broken = st({ data: { transactions: [tx(11, 10, { categoryId: 99 })] } });
		const r = merge(broken, st());
		const v = validateState(r.state);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.error).toMatch(/kategória/);
	});

	it('javítás nélkül (repair: false) nem nyúl a hivatkozásokhoz', () => {
		const a = st({ tombstones: { [tombstoneKey('categories', 2)]: 50 } });
		const b = st({ data: { categories: [cat(1, 'Étel'), cat(2, 'Utazás')], transactions: [tx(11, 60, { categoryId: 2 })] } });
		const r = mergeStates(a, b, { repair: false });
		expect(ids(r.state.data.categories)).toEqual([1]);
		expect(r.report.repaired).toEqual([]);
	});
});

describe('mergeStates: korszak (epoch)', () => {
	const newer = { id: ID_MIN + 2, at: 2000 };
	const older = { id: ID_MIN + 3, at: 500 };

	it('eltérő korszaknál a későbbi egészben nyer, és a vesztes oldal elveszett módosításait megszámoljuk', () => {
		const local = st({
			epoch: older,
			data: { transactions: [tx(11, 300), tx(12, 400), tx(13, 50)] },
			tombstones: { [tombstoneKey('goals', 1)]: 350 },
			prefsUpdatedAt: 320
		});
		const remote = st({ epoch: newer, data: { transactions: [tx(99, 10)] } });
		const r = mergeStates(local, remote, { syncedAt: 100 });
		expect(r.state).toBe(remote);
		expect(r.state.data.transactions.map((t) => t.id)).toEqual([99]);
		expect(r.localChanged).toBe(true);
		expect(r.remoteChanged).toBe(false);
		expect(r.report.epochWinner).toBe('remote');
		expect(r.report.epochLost).toBe(2 + 1 + 1); // 2 tétel (300, 400), 1 jelölő, a beállítás
		expect(r.report.transactions).toEqual({ added: 1, updated: 0, removed: 3 });
	});

	it('ha a helyi korszak a későbbi, a helyi állapot felülírja a távolit', () => {
		const local = st({ epoch: newer, data: { transactions: [tx(11)] } });
		const remote = st({ epoch: older, data: { transactions: [tx(99)] } });
		const r = mergeStates(local, remote);
		expect(r.state).toBe(local);
		expect(r.localChanged).toBe(false);
		expect(r.remoteChanged).toBe(true);
		expect(r.report.epochWinner).toBe('local');
		expect(r.report.epochLost).toBeUndefined();
	});

	it('azonos idejű eltérő korszak: a nagyobb azonosító nyer (mindkét eszközön ugyanaz)', () => {
		const e1 = { id: ID_MIN + 5, at: 700 };
		const e2 = { id: ID_MIN + 9, at: 700 };
		expect(mergeStates(st({ epoch: e1 }), st({ epoch: e2 })).state.epoch).toEqual(e2);
		expect(mergeStates(st({ epoch: e2 }), st({ epoch: e1 })).state.epoch).toEqual(e2);
	});

	it('nem vesz el semmit, ha a vesztes oldalon nincs nem szinkronizált módosítás', () => {
		const local = st({ epoch: older, data: { transactions: [tx(11, 50)] } });
		const r = mergeStates(local, st({ epoch: newer }), { syncedAt: 100 });
		expect(r.report.epochLost).toBe(0);
	});
});

describe('remapIds', () => {
	const seq = (start: number) => {
		let n = start;
		return () => n++;
	};

	it('a régi azonosítókat átszámozza, a hivatkozásokkal és a törlési jelölőkkel együtt', () => {
		const state = st({
			data: {
				accounts: [acct(1, 'Készpénz'), acct(2, 'Bank')],
				categories: [cat(1, 'Étel'), cat(5, 'Utazás')],
				transactions: [
					tx(7, 10, { categoryId: 5, accountId: 2, recurringId: 3 }),
					tx(8, 10, { type: 'transfer', categoryId: null, accountId: 1, toAccountId: 2 }),
					tx(9, 10, { amount: 500, categoryId: 5, splits: [{ categoryId: 5, amount: 300 }, { categoryId: 1, amount: 200 }] })
				],
				recurring: [rule(3, 10, { categoryId: 1, accountId: 2 })],
				templates: [tpl(4, 10, { categoryId: 5, accountId: 1, toAccountId: 2 })],
				goals: [goal(6, 10, { accountId: 2 })],
				filters: [filt(2)]
			},
			tombstones: { [tombstoneKey('transactions', 77)]: 5, [tombstoneKey('categories', 5)]: 6 }
		});
		const out = remapIds(state, { generate: seq(ID_MIN + 100) });
		const acc = new Map(out.data.accounts.map((a) => [a.name, a.id]));
		const cats = new Map(out.data.categories.map((c) => [c.name, c.id]));
		// minden azonosító az új tartományba került, és egyedi
		const all = DATA_STORES.flatMap((s) => (out.data[s] as { id: number }[]).map((r) => r.id));
		expect(all.every((i) => i >= ID_MIN)).toBe(true);
		expect(new Set(all).size).toBe(all.length);
		// hivatkozások követik az átszámozást
		const t7 = out.data.transactions.find((t) => t.description === 'Kávé' && t.recurringId != null)!;
		expect(t7).toMatchObject({ categoryId: cats.get('Utazás'), accountId: acc.get('Bank'), recurringId: out.data.recurring[0].id });
		const tr = out.data.transactions.find((t) => t.type === 'transfer')!;
		expect(tr).toMatchObject({ accountId: acc.get('Készpénz'), toAccountId: acc.get('Bank') });
		const split = out.data.transactions.find((t) => t.splits)!;
		expect(split.splits!.map((s) => s.categoryId).sort()).toEqual([cats.get('Étel')!, cats.get('Utazás')!].sort());
		expect(out.data.recurring[0]).toMatchObject({ categoryId: cats.get('Étel'), accountId: acc.get('Bank') });
		expect(out.data.templates[0]).toMatchObject({ categoryId: cats.get('Utazás'), accountId: acc.get('Készpénz'), toAccountId: acc.get('Bank') });
		expect(out.data.goals[0].accountId).toBe(acc.get('Bank'));
		// a jelölők kulcsa is átkerült (a nem létező sor jelölője az új id-t kapja)
		expect(Object.keys(out.tombstones)).toContain(tombstoneKey('categories', cats.get('Utazás')!));
		expect(Object.keys(out.tombstones)).toContain(tombstoneKey('transactions', 77)); // ilyen sor nincs: változatlan
		// az időbélyegek érintetlenek, az eredmény érvényes
		expect(out.data.transactions.every((t) => t.updatedAt === 10)).toBe(true);
		expect(validateState(out)).toEqual({ ok: true });
	});

	it('az új tartománybeli azonosítókat nem bántja', () => {
		const big = ID_MIN + 42;
		const state = st({ data: { transactions: [tx(big, 10, { categoryId: 1 })] } });
		const out = remapIds(state, { generate: seq(ID_MIN + 100) });
		expect(out.data.transactions[0].id).toBe(big);
	});

	it('ütköző generált azonosítót kihagy', () => {
		const state = st({ data: { transactions: [tx(ID_MIN + 100, 10), tx(5, 10)] } });
		const out = remapIds(state, { generate: seq(ID_MIN + 100) });
		const all = DATA_STORES.flatMap((s) => (out.data[s] as { id: number }[]).map((r) => r.id));
		expect(new Set(all).size).toBe(all.length); // a meglévő ID_MIN + 100-zal nem ütközik semmi
		expect(out.data.transactions.map((t) => t.id)).toContain(ID_MIN + 100);
		expect(out.data.transactions.every((t) => t.id >= ID_MIN)).toBe(true);
	});

	it('a másik oldal azonos nevű számláját/kategóriáját újrahasznosítja, így nincs duplikátum', () => {
		const local = st({
			data: {
				accounts: [acct(1, 'Készpénz'), acct(2, 'Bank')],
				categories: [cat(1, 'Étel'), cat(5, 'Utazás')],
				transactions: [tx(7, 10, { categoryId: 5, accountId: 2 })]
			}
		});
		const remote = st({
			data: {
				accounts: [acct(1, 'Készpénz'), acct(ID_MIN + 9, 'bank')],
				categories: [cat(101, 'Étel'), cat(ID_MIN + 10, 'Utazás')]
			}
		});
		const out = remapIds(local, { generate: seq(ID_MIN + 100), match: remote.data });
		expect(out.data.accounts.map((a) => a.id).sort((a, b) => a - b)).toEqual([1, ID_MIN + 9]); // azonos id + név szerint
		expect(out.data.categories.map((c) => c.id).sort((a, b) => a - b)).toEqual([101, ID_MIN + 10]);
		expect(out.data.transactions[0]).toMatchObject({ accountId: ID_MIN + 9, categoryId: ID_MIN + 10 });
		// az egyesítés után egy-egy elem marad
		const merged = merge(out, remote);
		expect(merged.state.data.accounts).toHaveLength(2);
		expect(merged.state.data.categories).toHaveLength(2);
	});

	it('két azonos nevű helyi elem nem képződik ugyanarra a távoli azonosítóra', () => {
		const local = st({ data: { categories: [cat(1, 'Étel'), cat(2, 'Étel')], accounts: [acct(1, 'A')] } });
		const remote = st({ data: { categories: [cat(ID_MIN + 10, 'Étel')] } });
		const out = remapIds(local, { generate: seq(ID_MIN + 100), match: remote.data });
		const catIds = out.data.categories.map((c) => c.id);
		expect(new Set(catIds).size).toBe(2);
		expect(catIds).toContain(ID_MIN + 10);
	});
});

describe('validateState és hasOwnData', () => {
	it('érvényes állapot átmegy; a sérült hibát ad', () => {
		expect(validateState(st({ data: { transactions: [tx(11)] } }))).toEqual({ ok: true });
		const bad = st({ data: { transactions: [tx(11, 10, { amount: -5 })] } });
		expect(validateState(bad).ok).toBe(false);
	});

	it('csak alapelemek vagy példaadat nem számít saját adatnak', () => {
		const defaults = st({
			data: { accounts: [acct(1, 'Készpénz', 0)], categories: [cat(101, 'Étel', 0)], transactions: [tx(11, 5, { demo: true })] }
		});
		expect(hasOwnData(defaults)).toBe(false);
	});

	it('saját tétel, szerkesztett elem, sablon, cél, szűrő, ismétlődő vagy keret saját adat', () => {
		const base = { accounts: [acct(1, 'Készpénz', 0)], categories: [cat(1, 'Étel', 0)] };
		expect(hasOwnData(st({ data: { ...base, transactions: [tx(11)] } }))).toBe(true);
		expect(hasOwnData(st({ data: { ...base, accounts: [acct(1, 'Készpénz', 5)] } }))).toBe(true);
		expect(hasOwnData(st({ data: { ...base, categories: [cat(1, 'Étel', 5)] } }))).toBe(true);
		expect(hasOwnData(st({ data: { ...base, templates: [tpl(1)] } }))).toBe(true);
		expect(hasOwnData(st({ data: { ...base, goals: [goal(1)] } }))).toBe(true);
		expect(hasOwnData(st({ data: { ...base, filters: [filt(1)] } }))).toBe(true);
		expect(hasOwnData(st({ data: { ...base, recurring: [rule(1)] } }))).toBe(true);
		expect(hasOwnData(st({ data: base, prefsUpdatedAt: 9 }))).toBe(true);
	});
});

describe('sameState', () => {
	it('a sorok és kulcsok sorrendjétől független', () => {
		const a = st({ data: { transactions: [tx(11), tx(12)] } });
		const b = st({ data: { transactions: [tx(12), tx(11)] } });
		expect(sameState(a, b)).toBe(true);
		expect(sameState(a, st({ data: { transactions: [tx(11)] } }))).toBe(false);
	});
});
