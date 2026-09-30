/**
 * Tulajdonság-tesztek az összefésüléshez: véletlen műveletsorokon (saját kis, függőségmentes generátorral)
 * ellenőrizzük az algebrai tulajdonságokat és a konvergenciát.
 */
import { describe, expect, it } from 'vitest';
import { emptyData } from '../src/lib/db/repo';
import { ID_MIN } from '../src/lib/sync/ids';
import { mergeStates, sameState, validateState, type SyncState } from '../src/lib/sync/merge';
import { tombstoneKey } from '../src/lib/sync/tombstones';
import type { Account, Category, Goal, Recurring, Template, Transaction } from '../src/lib/types';

// ---------- generátor ----------

/** Determinisztikus álvéletlen-szám generátor (mulberry32). */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Ctx {
	rand: () => number;
	/** Közös óra: többnyire nő, néha egy pillanatra megáll (döntetlenek tesztelésére). */
	tick: () => number;
	newId: () => number;
}

const DATES = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-05`);
const pick = <T>(c: Ctx, xs: T[]): T | undefined => xs[Math.floor(c.rand() * xs.length)];

/** Az ismétlődő szabály egy előfordulásához tartozó tétel azonosítója (minden eszközön ugyanaz). */
const occurrenceId = (ruleId: number, date: string) => ID_MIN + 1_000_000 + ruleId * 100 + DATES.indexOf(date);

const EPOCH = { id: ID_MIN + 7, at: 1000 };

function base(): SyncState {
	const acct = (id: number, name: string): Account => ({ id, name, type: 'checking', initialBalance: 0, archived: false, sortOrder: id, createdAt: 1, updatedAt: 1 });
	const cat = (id: number, name: string, type: 'income' | 'expense'): Category => ({ id, name, type, color: '#112233', icon: '', monthlyBudget: null, archived: false, sortOrder: id, createdAt: 1, updatedAt: 1 });
	const tx = (id: number): Transaction => ({
		id, type: 'expense', amount: 1000 + id, date: '2026-09-10', description: `t${id}`, categoryId: 1, accountId: 1, toAccountId: null,
		note: '', tags: [], createdAt: id, updatedAt: 1
	});
	const rule: Recurring = {
		id: 21, type: 'expense', amount: 500, description: 'Albérlet', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [],
		frequency: 'monthly', interval: 1, startDate: '2026-01-05', endDate: null, lastHandled: null, active: true, createdAt: 1, updatedAt: 1
	};
	const tpl: Template = { id: 31, name: 'Sablon', type: 'expense', amount: null, description: '', categoryId: 2, accountId: 2, toAccountId: null, note: '', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 };
	const goal: Goal = { id: 41, name: 'Cél', icon: '🎯', color: '#4f46e5', target: 1000, saved: 0, accountId: 2, deadline: null, archived: false, sortOrder: 1, createdAt: 1, updatedAt: 1 };
	return {
		epoch: EPOCH,
		prefs: { currency: 'HUF', totalBudget: null },
		prefsUpdatedAt: 0,
		tombstones: {},
		data: {
			...emptyData(),
			accounts: [acct(1, 'Készpénz'), acct(2, 'Bank')],
			categories: [cat(1, 'Étel', 'expense'), cat(2, 'Utazás', 'expense'), cat(3, 'Fizetés', 'income')],
			transactions: [tx(11), tx(12), tx(13)],
			recurring: [rule],
			templates: [tpl],
			goals: [goal],
			filters: [{ id: 51, name: 'Szűrő', query: 'q=a', createdAt: 1, updatedAt: 1 }]
		}
	};
}

type StoreName = 'accounts' | 'categories' | 'transactions' | 'recurring' | 'templates' | 'goals' | 'filters';
type AnyRow = { id: number; updatedAt: number } & Record<string, unknown>;
const rows = (s: SyncState, store: StoreName) => s.data[store] as unknown as AnyRow[];

function remove(s: SyncState, store: StoreName, row: AnyRow, at: number) {
	(s.data as unknown as Record<StoreName, AnyRow[]>)[store] = rows(s, store).filter((r) => r.id !== row.id);
	s.tombstones[tombstoneKey(store, row.id)] = Math.max(at, row.updatedAt + 1);
}

const usedByTx = (s: SyncState, field: 'categoryId' | 'accountId', id: number) =>
	s.data.transactions.some(
		(t) => t[field] === id || (field === 'accountId' && t.toAccountId === id) || (field === 'categoryId' && (t.splits ?? []).some((p) => p.categoryId === id))
	) || s.data.recurring.some((r) => r[field] === id || (field === 'accountId' && r.toAccountId === id));

type Op = (s: SyncState, c: Ctx) => void;
const OPS: Op[] = [
	// tétel felvétele / szerkesztése / törlése
	(s, c) => {
		const cat = pick(c, s.data.categories.filter((x) => x.type === 'expense'));
		const acc = pick(c, s.data.accounts);
		if (!cat || !acc) return;
		const at = c.tick();
		const id = c.newId();
		s.data.transactions.push({
			id, type: 'expense', amount: 1 + Math.floor(c.rand() * 9999), date: `2026-09-${String(1 + Math.floor(c.rand() * 28)).padStart(2, '0')}`,
			description: `új${id % 1000}`, categoryId: cat.id, accountId: acc.id, toAccountId: null, note: '', tags: [], createdAt: at, updatedAt: at
		});
	},
	(s, c) => {
		const t = pick(c, s.data.transactions);
		if (t) Object.assign(t, { amount: 1 + Math.floor(c.rand() * 9999), updatedAt: c.tick() });
	},
	(s, c) => {
		const t = pick(c, rows(s, 'transactions'));
		if (t) remove(s, 'transactions', t, c.tick());
	},
	// kategória
	(s, c) => {
		const at = c.tick();
		s.data.categories.push({ id: c.newId(), name: `K${c.newId() % 997}`, type: 'expense', color: '#112233', icon: '', monthlyBudget: null, archived: false, sortOrder: 9, createdAt: at, updatedAt: at });
	},
	(s, c) => {
		const k = pick(c, s.data.categories);
		if (k) Object.assign(k, { name: `Átnevezett${Math.floor(c.rand() * 5)}`, updatedAt: c.tick() });
	},
	(s, c) => {
		const k = pick(c, s.data.categories);
		if (!k || usedByTx(s, 'categoryId', k.id)) return;
		const at = c.tick();
		remove(s, 'categories', k as unknown as AnyRow, at);
		for (const t of s.data.templates) if (t.categoryId === k.id) Object.assign(t, { categoryId: null, updatedAt: at });
	},
	// számla
	(s, c) => {
		const at = c.tick();
		s.data.accounts.push({ id: c.newId(), name: `Sz${c.newId() % 997}`, type: 'checking', initialBalance: 0, archived: false, sortOrder: 9, createdAt: at, updatedAt: at });
	},
	(s, c) => {
		const a = pick(c, s.data.accounts);
		if (a) Object.assign(a, { archived: c.rand() < 0.5, updatedAt: c.tick() });
	},
	(s, c) => {
		const a = pick(c, s.data.accounts);
		if (!a || usedByTx(s, 'accountId', a.id)) return;
		const at = c.tick();
		remove(s, 'accounts', a as unknown as AnyRow, at);
		for (const g of s.data.goals) if (g.accountId === a.id) Object.assign(g, { accountId: null, updatedAt: at });
		for (const t of s.data.templates) {
			if (t.accountId === a.id || t.toAccountId === a.id) {
				Object.assign(t, { accountId: t.accountId === a.id ? null : t.accountId, toAccountId: t.toAccountId === a.id ? null : t.toAccountId, updatedAt: at });
			}
		}
	},
	// sablon, cél, szűrő
	(s, c) => {
		const at = c.tick();
		const cat = pick(c, s.data.categories.filter((x) => x.type === 'expense'));
		s.data.templates.push({ id: c.newId(), name: 'Új sablon', type: 'expense', amount: null, description: '', categoryId: cat?.id ?? null, accountId: pick(c, s.data.accounts)?.id ?? null, toAccountId: null, note: '', tags: [], sortOrder: 9, createdAt: at, updatedAt: at });
	},
	(s, c) => {
		const t = pick(c, s.data.templates);
		if (t) Object.assign(t, { name: `Sablon${Math.floor(c.rand() * 5)}`, updatedAt: c.tick() });
	},
	(s, c) => {
		const t = pick(c, rows(s, 'templates'));
		if (t) remove(s, 'templates', t, c.tick());
	},
	(s, c) => {
		const at = c.tick();
		s.data.goals.push({ id: c.newId(), name: 'Új cél', icon: '🎯', color: '#4f46e5', target: 1000, saved: 0, accountId: pick(c, s.data.accounts)?.id ?? null, deadline: null, archived: false, sortOrder: 9, createdAt: at, updatedAt: at });
	},
	(s, c) => {
		const g = pick(c, s.data.goals);
		if (g) Object.assign(g, { saved: Math.floor(c.rand() * 900), updatedAt: c.tick() });
	},
	(s, c) => {
		const g = pick(c, rows(s, 'goals'));
		if (g) remove(s, 'goals', g, c.tick());
	},
	(s, c) => {
		const at = c.tick();
		s.data.filters.push({ id: c.newId(), name: 'F', query: `q=${Math.floor(c.rand() * 9)}`, createdAt: at, updatedAt: at });
	},
	(s, c) => {
		const f = pick(c, rows(s, 'filters'));
		if (f) remove(s, 'filters', f, c.tick());
	},
	// ismétlődő szabály: jóváhagyás, szerkesztés, törlés
	(s, c) => {
		const r = pick(c, s.data.recurring);
		if (!r) return;
		const next = DATES[r.lastHandled ? DATES.indexOf(r.lastHandled) + 1 : 0];
		if (!next) return;
		const at = c.tick();
		if (c.rand() < 0.8) {
			s.data.transactions.push({
				id: occurrenceId(r.id, next), type: 'expense', amount: r.amount, date: next, description: r.description, categoryId: r.categoryId,
				accountId: r.accountId, toAccountId: null, note: '', tags: [], recurringId: r.id, createdAt: at, updatedAt: at
			});
		}
		Object.assign(r, { lastHandled: next, updatedAt: at });
	},
	(s, c) => {
		const r = pick(c, s.data.recurring);
		if (r) Object.assign(r, { amount: 1 + Math.floor(c.rand() * 900), updatedAt: c.tick() });
	},
	(s, c) => {
		const r = pick(c, rows(s, 'recurring'));
		if (r) remove(s, 'recurring', r, c.tick());
	},
	// beállítások
	(s, c) => {
		s.prefs = { ...s.prefs, totalBudget: c.rand() < 0.3 ? null : 1000 * (1 + Math.floor(c.rand() * 9)) };
		s.prefsUpdatedAt = c.tick();
	}
];

function makeCtx(seed: number): Ctx {
	const rand = rng(seed);
	let clock = 100;
	let counter = 0;
	return {
		rand,
		tick: () => (rand() < 0.88 ? ++clock : clock),
		newId: () => ID_MIN + 10_000 + counter++
	};
}

function evolve(s: SyncState, c: Ctx, steps: number): SyncState {
	const out = structuredClone(s);
	for (let i = 0; i < steps; i++) OPS[Math.floor(c.rand() * OPS.length)](out, c);
	return out;
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const at = (seed: number) => `seed ${seed}`;
const merged = (a: SyncState, b: SyncState) => mergeStates(a, b).state;

// ---------- tulajdonságok ----------

describe('összefésülés: tulajdonságok véletlen műveletsorokon', () => {
	it('a generált állapotok érvényesek (a vizsgálat maga is megbízható)', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const s = evolve(base(), c, 12);
			expect(validateState(s), at(seed)).toEqual({ ok: true });
		}
	}, 60_000);

	it('kommutatív: merge(a, b) ≡ merge(b, a)', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const a = evolve(base(), c, Math.floor(c.rand() * 12));
			const b = evolve(base(), c, Math.floor(c.rand() * 12));
			expect(sameState(merged(a, b), merged(b, a)), at(seed)).toBe(true);
		}
	}, 60_000);

	it('idempotens: merge(a, a) ≡ a, és nem jelez változást', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const a = evolve(base(), c, Math.floor(c.rand() * 14));
			const r = mergeStates(a, a);
			expect(sameState(r.state, a), at(seed)).toBe(true);
			expect(r.localChanged || r.remoteChanged, at(seed)).toBe(false);
			expect(r.report.repaired, at(seed)).toEqual([]);
		}
	}, 60_000);

	it('elnyelő: merge(merge(a, b), a) ≡ merge(merge(a, b), b) ≡ merge(a, b)', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const a = evolve(base(), c, Math.floor(c.rand() * 12));
			const b = evolve(base(), c, Math.floor(c.rand() * 12));
			const ab = merged(a, b);
			expect(sameState(merged(ab, a), ab), at(seed)).toBe(true);
			expect(sameState(merged(ab, b), ab), at(seed)).toBe(true);
		}
	}, 60_000);

	it('asszociatív (rekordszinten): merge(merge(a, b), c) ≡ merge(a, merge(b, c))', () => {
		const m = (x: SyncState, y: SyncState) => mergeStates(x, y, { repair: false }).state;
		// Az egyetlen ismert kivétel a törölt, majd később újraszerkesztett ismétlődő szabály `lastHandled`
		// mezője: ha egy köztes összefésülés a szabályt a törlési jelölő miatt eldobja, az ott lévő (nagyobb)
		// `lastHandled` elvész. Ez csak a szabály feltámadásakor számít, és következménye legfeljebb egy
		// újra felkínált előfordulás, amit a determinisztikus tétel-azonosító miatt nem lehet megduplázni.
		// Ezért a `lastHandled` nélkül hasonlítunk; a mező viselkedését az egységtesztek fedik le.
		const noHandled = (x: SyncState): SyncState => {
			const y = structuredClone(x);
			for (const r of y.data.recurring) r.lastHandled = null;
			return y;
		};
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const [a, b, d] = [0, 1, 2].map(() => evolve(base(), c, Math.floor(c.rand() * 12)));
			expect(sameState(noHandled(m(m(a, b), d)), noHandled(m(a, m(b, d)))), at(seed)).toBe(true);
			expect(sameState(noHandled(m(m(a, b), d)), noHandled(m(m(b, d), a))), at(seed)).toBe(true);
		}
	}, 60_000);

	it('a lastHandled soha lép vissza egy élő szabályon, bármilyen sorrendben fésülünk', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const [a, b, d] = [0, 1, 2].map(() => evolve(base(), c, Math.floor(c.rand() * 12)));
			const r = merged(merged(a, b), d);
			const rule = r.data.recurring.find((x) => x.id === 21);
			if (!rule) continue;
			// Ha a szabály mindhárom oldalon élt a végéig, a legnagyobb feldolgozott dátum megmarad.
			const all = [a, b, d].map((s) => s.data.recurring.find((x) => x.id === 21));
			if (all.some((x) => !x)) continue;
			const best = all.map((x) => x!.lastHandled).filter((x): x is string => x !== null).sort().pop() ?? null;
			expect(rule.lastHandled, at(seed)).toBe(best);
		}
	}, 60_000);

	it('az összefésült eredmény mindig érvényes (a hivatkozás-javítás után is)', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const a = evolve(base(), c, Math.floor(c.rand() * 14));
			const b = evolve(base(), c, Math.floor(c.rand() * 14));
			const d = evolve(base(), c, Math.floor(c.rand() * 14));
			const v = validateState(merged(merged(a, b), d));
			expect(v, at(seed)).toEqual({ ok: true });
		}
	}, 60_000);

	it('előretekerés: a változatlan (régi) állapot beleolvad a módosítottba', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			const b = evolve(base(), c, Math.floor(c.rand() * 14));
			expect(sameState(merged(base(), b), b), at(seed)).toBe(true);
			expect(sameState(merged(b, base()), b), at(seed)).toBe(true);
		}
	}, 60_000);

	it('a törlés nem támad fel: ami az egyik oldalon törölve van, a másikon nem módosult, az eltűnik', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			// b csak töröl, a nem nyúl semmihez
			const b = structuredClone(base());
			const victim = b.data.transactions[Math.floor(c.rand() * 3)];
			remove(b, 'transactions', victim as unknown as AnyRow, c.tick());
			const r = merged(base(), b);
			expect(r.data.transactions.map((t) => t.id), at(seed)).not.toContain(victim.id);
			expect(r.data.transactions, at(seed)).toHaveLength(2);
		}
	}, 60_000);

	it('felhő-közvetített szinkronnál minden eszköz ugyanoda konvergál, és az állapot érvényes marad', () => {
		for (const seed of SEEDS) {
			const c = makeCtx(seed);
			let cloud = base();
			let devices = [base(), base(), base()];
			const sync = (i: number) => {
				const r = mergeStates(devices[i], cloud);
				cloud = r.state;
				devices[i] = r.state;
				expect(validateState(r.state), at(seed)).toEqual({ ok: true });
			};
			for (let round = 0; round < 4; round++) {
				devices = devices.map((d) => (c.rand() < 0.7 ? evolve(d, c, Math.floor(c.rand() * 6)) : d));
				const order = [0, 1, 2].sort(() => c.rand() - 0.5);
				for (const i of order.slice(0, 1 + Math.floor(c.rand() * 3))) sync(i);
			}
			// Elcsendesedés: több módosítás már nincs, mindenki újra és újra szinkronizál. Általában egy-két kör
			// elég; ritkán (egy visszaélesztett kategória miatt) három: a lényeg, hogy véges körben megáll.
			let passes = 0;
			do {
				passes++;
				for (const i of [0, 1, 2]) sync(i);
			} while (passes < 6 && !devices.every((d) => sameState(d, cloud)));
			expect(passes, at(seed)).toBeLessThanOrEqual(4);
			for (const d of devices) expect(sameState(d, cloud), at(seed)).toBe(true);
		}
	}, 60_000);
});
