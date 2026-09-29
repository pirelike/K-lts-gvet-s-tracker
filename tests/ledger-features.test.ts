import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { setActiveCurrency } from '../src/lib/currency';
import { openLedgerDb } from '../src/lib/db/idb';
import { LedgerRepo } from '../src/lib/db/repo';
import { ledger, LedgerError, reorder, stripAmountParams } from '../src/lib/ledger.svelte';
import { accountBalances, monthSummary } from '../src/lib/queries';
import type { RecurringInput } from '../src/lib/validation';
import type { TxInput } from '../src/lib/types';

let n = 0;
let repo: LedgerRepo;
beforeEach(async () => {
	setActiveCurrency('HUF');
	repo = new LedgerRepo(await openLedgerDb(`ledger-feat-${n++}`));
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
const balance = (name: string) => accountBalances(ledger.accounts, ledger.transactions).get(acc(name).id)!;

describe('egyenleg-egyeztetés', () => {
	it('a valós egyenlegnél kisebb nyilvántartásra bevételi korrekciós tételt készít', async () => {
		await ledger.addTx(expense({ amount: 3000 })); // egyenleg: −3000
		const r = await ledger.reconcileAccount(acc('Készpénz').id, 2000, { date: '2026-09-11' });
		expect(r).not.toBeNull();
		expect(r!.difference).toBe(5000);
		expect(r!.transaction).toMatchObject({ type: 'income', amount: 5000, date: '2026-09-11', description: 'Egyenleg-egyeztetés', tags: ['korrekció'] });
		expect(balance('Készpénz')).toBe(2000);
		expect(cat('income', 'Egyenleg-korrekció')).toBeTruthy();
	});

	it('a valós egyenlegnél nagyobb nyilvántartásra kiadási korrekciót; a kezdőegyenleg érintetlen marad', async () => {
		await ledger.updateAccount(acc('Készpénz').id, { name: 'Készpénz', initialBalance: 10000 });
		const r = await ledger.reconcileAccount(acc('Készpénz').id, 7500);
		expect(r!.transaction).toMatchObject({ type: 'expense', amount: 2500 });
		expect(balance('Készpénz')).toBe(7500);
		expect(acc('Készpénz').initialBalance).toBe(10000);
		const m = monthSummary(ledger.transactions, ledger.categories, r!.transaction.date.slice(0, 7));
		expect(m.expense).toBe(2500);
	});

	it('nincs eltérés → nincs tétel; a korrekciós kategória újrahasznosul (archiválva is)', async () => {
		expect(await ledger.reconcileAccount(acc('Készpénz').id, 0)).toBeNull();
		expect(ledger.transactions).toHaveLength(0);
		await ledger.reconcileAccount(acc('Készpénz').id, 100);
		await ledger.reconcileAccount(acc('Készpénz').id, 300);
		expect(ledger.categories.filter((c) => c.name === 'Egyenleg-korrekció')).toHaveLength(1);
		const c = cat('income', 'Egyenleg-korrekció');
		await ledger.setCategoryArchived(c.id, true);
		await ledger.reconcileAccount(acc('Készpénz').id, 500);
		expect(cat('income', 'Egyenleg-korrekció').archived).toBe(false);
		expect(balance('Készpénz')).toBe(500);
	});

	it('érvénytelen bemenetnél hibát dob', async () => {
		await expect(ledger.reconcileAccount(9999, 0)).rejects.toThrow(LedgerError);
		await expect(ledger.reconcileAccount(acc('Készpénz').id, 1.5)).rejects.toThrow(LedgerError);
	});
});

describe('csoportos műveletek', () => {
	it('kategória, számla és címke egyszerre több tételen; a nem alkalmazhatók kimaradnak', async () => {
		const a = await ledger.addTx(expense({ description: 'a' }));
		const b = await ledger.addTx(expense({ description: 'b', tags: ['x'] }));
		const inc = await ledger.addTx({ ...expense({ description: 'fizu' }), type: 'income', categoryId: cat('income', 'Ösztöndíj').id });
		const tr = await ledger.addTx({ type: 'transfer', amount: 500, date: '2026-09-10', description: '', categoryId: null, accountId: acc('Készpénz').id, toAccountId: acc('Bankkártya').id, note: '', tags: [] });

		const res = await ledger.updateTxs([a.id, b.id, inc.id, tr.id], { categoryId: cat('expense', 'Közlekedés').id });
		expect(res).toEqual({ changed: 2, skipped: 2 }); // a bevétel és az átvezetés kimarad
		expect(ledger.transactions.find((t) => t.id === a.id)!.categoryId).toBe(cat('expense', 'Közlekedés').id);
		expect(ledger.transactions.find((t) => t.id === inc.id)!.categoryId).toBe(cat('income', 'Ösztöndíj').id);

		const r2 = await ledger.updateTxs([a.id, b.id, tr.id], { accountId: acc('Bankkártya').id });
		expect(r2).toEqual({ changed: 2, skipped: 1 }); // az átvezetés célszámlája ugyanaz lenne
		const r3 = await ledger.updateTxs([a.id, b.id], { addTags: ['egyetem'], removeTags: ['x'] });
		expect(r3.changed).toBe(2);
		expect(ledger.transactions.find((t) => t.id === b.id)!.tags).toEqual(['egyetem']);

		const fresh = ledger.transactions.map((t) => [t.id, t.categoryId, t.accountId, t.tags.join()]);
		await ledger.load();
		expect(ledger.transactions.map((t) => [t.id, t.categoryId, t.accountId, t.tags.join()])).toEqual(fresh);
	});

	it('felosztott tétel kategóriája csoportosan nem írható át', async () => {
		const s = await ledger.addTx(expense({ amount: 5000, splits: [{ categoryId: cat('expense', 'Étel').id, amount: 3000 }, { categoryId: cat('expense', 'Egyéb').id, amount: 2000 }] }));
		const r = await ledger.updateTxs([s.id], { categoryId: cat('expense', 'Közlekedés').id });
		expect(r).toEqual({ changed: 0, skipped: 1 });
	});

	it('csoportos törlés és visszavonás', async () => {
		const a = await ledger.addTx(expense());
		const b = await ledger.addTx(expense({ amount: 2000 }));
		const snaps = await ledger.deleteTxs([a.id, b.id]);
		expect(snaps).toHaveLength(2);
		expect(ledger.transactions).toHaveLength(0);
		expect(await ledger.restoreTxs(snaps)).toBe(2);
		expect(await ledger.restoreTxs(snaps)).toBe(0); // nem duplikál
		expect(ledger.transactions.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
	});
});

describe('sorrend', () => {
	it('reorder: szomszéddal cserél, a csoportot 1..n-re rendezi', () => {
		const items = [{ id: 1, sortOrder: 5 }, { id: 2, sortOrder: 7 }, { id: 3, sortOrder: 9 }];
		const r = reorder(items, 3, -1);
		expect(r.map((x) => [x.id, x.sortOrder]).sort()).toEqual([[1, 1], [2, 3], [3, 2]]);
		expect(reorder(items, 1, -1)).toEqual([]); // az elsőt nem lehet feljebb vinni
		expect(reorder(items, 3, 1)).toEqual([]);
	});

	it('számlák és kategóriák átrendezése tartósan megmarad', async () => {
		const before = ledger.activeAccounts.map((a) => a.name);
		await ledger.moveAccount(acc('Bankkártya').id, -1);
		expect(ledger.activeAccounts.map((a) => a.name)).toEqual([before[1], before[0], before[2]]);
		await ledger.load();
		expect(ledger.activeAccounts.map((a) => a.name)).toEqual([before[1], before[0], before[2]]);

		const food = ledger.activeCategories('expense').map((c) => c.name);
		await ledger.moveCategory(cat('expense', 'Étel').id, 1);
		expect(ledger.activeCategories('expense').map((c) => c.name).slice(0, 2)).toEqual([food[1], food[0]]);
		// a bevételi kategóriák sorrendje nem változott
		expect(ledger.activeCategories('income')[0].name).toBe('Ösztöndíj');
	});
});

describe('havi keret és összes keret', () => {
	it('kategóriakeret beállítása, törlése; az összes keret a beállításokban él', async () => {
		const food = cat('expense', 'Étel');
		await ledger.setCategoryBudget(food.id, 40000);
		expect(ledger.catById.get(food.id)!.monthlyBudget).toBe(40000);
		await ledger.load();
		expect(ledger.catById.get(food.id)!.monthlyBudget).toBe(40000);
		await ledger.setCategoryBudget(food.id, null);
		expect(ledger.catById.get(food.id)!.monthlyBudget).toBeNull();
		await expect(ledger.setCategoryBudget(food.id, -5)).rejects.toThrow(LedgerError);

		await ledger.setTotalBudget(150000);
		await ledger.load();
		expect(ledger.prefs.totalBudget).toBe(150000);
		await ledger.setTotalBudget(null);
		expect(ledger.prefs.totalBudget).toBeNull();
	});

	it('a kategória szerkesztése a keretet is menti (bevételi kategóriánál nem)', async () => {
		const food = cat('expense', 'Étel');
		await ledger.updateCategory(food.id, { name: 'Étel', color: '#f97316', icon: '🍽️', monthlyBudget: 35000 });
		expect(ledger.catById.get(food.id)!.monthlyBudget).toBe(35000);
		const inc = cat('income', 'Ösztöndíj');
		await ledger.updateCategory(inc.id, { name: 'Ösztöndíj', color: '#16a34a', icon: '🎓', monthlyBudget: 5000 });
		expect(ledger.catById.get(inc.id)!.monthlyBudget).toBeNull();
	});
});

describe('ismétlődő tételek', () => {
	const rec = (over: Partial<RecurringInput> = {}): RecurringInput => ({
		type: 'expense', amount: 90000, description: 'Albérlet', categoryId: cat('expense', 'Lakhatás/kollégium').id,
		accountId: acc('Bankkártya').id, toAccountId: null, note: '', tags: ['lakás'], frequency: 'monthly', interval: 1,
		startDate: '2026-08-05', endDate: null, ...over
	});

	it('jóváhagyás létrehozza a tételt az esedékes napon, és előreléptet; időrendben kell haladni', async () => {
		const r = await ledger.addRecurring(rec());
		await expect(ledger.handleRecurring(r.id, '2026-09-05', 'approve')).rejects.toThrow(/korábbi/); // kihagyná a 08-05-öt
		const t1 = await ledger.handleRecurring(r.id, '2026-08-05', 'approve');
		expect(t1).toMatchObject({ date: '2026-08-05', amount: 90000, recurringId: r.id, description: 'Albérlet', tags: ['lakás'] });
		expect(ledger.recurring[0].lastHandled).toBe('2026-08-05');
		const t2 = await ledger.handleRecurring(r.id, '2026-09-05', 'approve', { amount: 91500 }); // módosított összeg
		expect(t2!.amount).toBe(91500);
		expect(ledger.transactions).toHaveLength(2);
		await ledger.load();
		expect(ledger.recurring[0].lastHandled).toBe('2026-09-05');
	});

	it('kihagyás nem hoz létre tételt, de előreléptet', async () => {
		const r = await ledger.addRecurring(rec());
		expect(await ledger.handleRecurring(r.id, '2026-08-05', 'skip')).toBeNull();
		expect(ledger.transactions).toHaveLength(0);
		expect(ledger.recurring[0].lastHandled).toBe('2026-08-05');
	});

	it('másik lapon már feldolgozott előfordulást nem duplikálja', async () => {
		const r = await ledger.addRecurring(rec());
		// „másik lap": közvetlenül az adatbázisban lép előre a szabály
		await repo.applyRecurring(r.id, null, '2026-08-05', null);
		const res = await ledger.handleRecurring(r.id, '2026-08-05', 'approve');
		expect(res).toBeNull();
		expect(ledger.transactions).toHaveLength(0);
		expect(ledger.recurring[0].lastHandled).toBe('2026-08-05'); // a memória az adatbázishoz igazodott
	});

	it('az esedékes lista a mai napig számol; használt kategória/számla nem törölhető', async () => {
		const r = await ledger.addRecurring(rec({ startDate: '2020-01-05' }));
		expect(ledger.due.length).toBeGreaterThan(0);
		await expect(ledger.deleteCategory(r.categoryId!)).rejects.toThrow(LedgerError);
		await expect(ledger.deleteAccount(r.accountId)).rejects.toThrow(LedgerError);
		await ledger.setRecurringActive(r.id, false);
		expect(ledger.due).toEqual([]);
		await ledger.deleteRecurring(r.id);
		await ledger.deleteCategory(r.categoryId!); // most már törölhető
	});

	it('átvezetés is ismétlődhet', async () => {
		const r = await ledger.addRecurring(rec({ type: 'transfer', categoryId: null, toAccountId: acc('Megtakarítás').id, description: 'Havi félretét', amount: 10000 }));
		const t = await ledger.handleRecurring(r.id, '2026-08-05', 'approve');
		expect(t).toMatchObject({ type: 'transfer', toAccountId: acc('Megtakarítás').id });
		expect(balance('Megtakarítás')).toBe(10000);
	});
});

describe('sablonok, célok, mentett szűrők', () => {
	it('sablon: létrehozás, átnevezés, átrendezés, törlés; kategória törlésekor a hivatkozás kiürül', async () => {
		const extra = await ledger.addCategory('expense', { name: 'Ajándék', color: '#123456', icon: '🎁' });
		const t = await ledger.addTemplate({ name: 'Ajándék', type: 'expense', amount: null, description: 'Ajándék', categoryId: extra.id, accountId: acc('Készpénz').id, toAccountId: null, note: '', tags: [] });
		const t2 = await ledger.addTemplate({ name: 'Kávé', type: 'expense', amount: 890, description: 'Kávé', categoryId: cat('expense', 'Étel').id, accountId: null, toAccountId: null, note: '', tags: [] });
		await ledger.renameTemplate(t2.id, 'Reggeli kávé');
		await ledger.moveTemplate(t2.id, -1);
		expect([...ledger.templates].sort((a, b) => a.sortOrder - b.sortOrder).map((x) => x.name)).toEqual(['Reggeli kávé', 'Ajándék']);
		await ledger.deleteCategory(extra.id); // sablon nem számít használatnak
		expect(ledger.templates.find((x) => x.id === t.id)!.categoryId).toBeNull();
		await ledger.deleteTemplate(t2.id);
		expect(ledger.templates).toHaveLength(1);
	});

	it('számla törlésekor a cél és a sablon hivatkozása kiürül', async () => {
		const extra = await ledger.addAccount({ name: 'Utazás', initialBalance: 0, type: 'savings' });
		const g = await ledger.addGoal({ name: 'Nyaralás', icon: '🏖️', color: '#06b6d4', target: 200000, saved: 0, accountId: extra.id, deadline: null });
		await ledger.deleteAccount(extra.id);
		expect(ledger.goals.find((x) => x.id === g.id)!.accountId).toBeNull();
	});

	it('cél: befizetés, 0 alá nem mehet, archiválás', async () => {
		const g = await ledger.addGoal({ name: 'Laptop', icon: '💻', color: '#3b82f6', target: 300000, saved: 0, accountId: null, deadline: '2027-01-01' });
		await ledger.addToGoal(g.id, 50000);
		await ledger.addToGoal(g.id, -80000);
		expect(ledger.goals[0].saved).toBe(0);
		await ledger.addToGoal(g.id, 120000);
		await ledger.setGoalArchived(g.id, true);
		await ledger.load();
		expect(ledger.goals[0]).toMatchObject({ saved: 120000, archived: true });
	});

	it('mentett szűrők; az összeghatárok kiszűrése', async () => {
		const f = await ledger.addFilter('Kávék', 'q=kave&min=500&type=expense');
		await ledger.load();
		expect(ledger.filters).toHaveLength(1);
		await ledger.deleteFilter(f.id);
		expect(ledger.filters).toHaveLength(0);
		expect(stripAmountParams('q=kave&min=500&max=900&type=expense')).toBe('q=kave&type=expense');
	});
});

describe('pénznemváltás', () => {
	it('minden összeg átszámolódik, a felosztás összege egyezik, a pénznem tartós', async () => {
		await ledger.updateAccount(acc('Készpénz').id, { name: 'Készpénz', initialBalance: 39500 });
		await ledger.setCategoryBudget(cat('expense', 'Étel').id, 79000);
		await ledger.setTotalBudget(395000);
		await ledger.addTx(expense({ amount: 3950, description: 'Kávé' }));
		await ledger.addTx(expense({ amount: 7900, splits: [{ categoryId: cat('expense', 'Étel').id, amount: 3950 }, { categoryId: cat('expense', 'Egyéb').id, amount: 3950 }] }));
		await ledger.addRecurring({ type: 'expense', amount: 3950, description: 'Netflix', categoryId: cat('expense', 'Előfizetések').id, accountId: acc('Bankkártya').id, toAccountId: null, note: '', tags: [], frequency: 'monthly', interval: 1, startDate: '2026-09-01', endDate: null });

		await ledger.switchCurrency('EUR', 395); // 1 EUR = 395 Ft
		expect(ledger.prefs.currency).toBe('EUR');
		expect(acc('Készpénz').initialBalance).toBe(10000);
		expect(cat('expense', 'Étel').monthlyBudget).toBe(20000);
		expect(ledger.prefs.totalBudget).toBe(100000);
		expect(ledger.transactions.map((t) => t.amount)).toEqual([1000, 2000]);
		const split = ledger.transactions[1];
		expect(split.splits!.reduce((s, p) => s + p.amount, 0)).toBe(split.amount);
		expect(ledger.recurring[0].amount).toBe(1000);

		await ledger.load(); // újratöltés ugyanazt adja
		expect(ledger.prefs.currency).toBe('EUR');
		expect(ledger.transactions.map((t) => t.amount)).toEqual([1000, 2000]);
	});

	it('hibás árfolyam és azonos pénznem elutasítva; a felosztás összege apró összegnél sem sérül', async () => {
		await expect(ledger.switchCurrency('EUR', 0)).rejects.toThrow(LedgerError);
		await expect(ledger.switchCurrency('EUR', NaN)).rejects.toThrow(LedgerError);
		await expect(ledger.switchCurrency('HUF', 1)).rejects.toThrow(LedgerError);
		await expect(ledger.switchCurrency('XXX', 1)).rejects.toThrow(LedgerError);
		await ledger.addTx(expense({ amount: 3, splits: [{ categoryId: cat('expense', 'Étel').id, amount: 1 }, { categoryId: cat('expense', 'Egyéb').id, amount: 2 }] }));
		await ledger.switchCurrency('EUR', 395);
		const t = ledger.transactions[0];
		expect(t.amount).toBeGreaterThan(0);
		if (t.splits) expect(t.splits.reduce((s, p) => s + p.amount, 0)).toBe(t.amount);
	});

	it('mentésből visszatöltve a pénznem is visszaáll', async () => {
		await ledger.addTx(expense({ amount: 3950 }));
		const hufBackup = ledger.exportBackup();
		expect(hufBackup.prefs.currency).toBe('HUF');
		await ledger.switchCurrency('EUR', 395);
		expect(ledger.exportBackup().prefs.currency).toBe('EUR');
		await ledger.importBackup(hufBackup);
		expect(ledger.prefs.currency).toBe('HUF');
		expect(ledger.transactions[0].amount).toBe(3950);
	});
});

describe('jóváírás a főkönyvben', () => {
	it('a jóváírás csökkenti a kategória költését és növeli a számlát', async () => {
		await ledger.addTx(expense({ amount: 15000, categoryId: cat('expense', 'Ruházat').id, description: 'Kabát' }));
		await ledger.addTx({ ...expense({ amount: 15000, categoryId: cat('expense', 'Ruházat').id, description: 'Kabát visszavíve' }), type: 'refund' });
		const m = monthSummary(ledger.transactions, ledger.categories, '2026-09');
		expect(m.expense).toBe(0);
		expect(m.income).toBe(0);
		expect(balance('Készpénz')).toBe(0);
	});
});

describe('CSV-import a főkönyvben', () => {
	it('a hiányzó kategóriák és számlák létrejönnek (csak amit a sorok használnak), a tételek egyben kerülnek be', async () => {
		const { planImport, detectMapping } = await import('../src/lib/csvImport');
		const H = ['Dátum', 'Típus', 'Összeg', 'Leírás', 'Kategória', 'Számla', 'Célszámla'];
		const rows = [
			H,
			['2026-09-01', 'Kiadás', '-1200', 'Menza', 'Ebéd', 'OTP kártya', ''],
			['2026-09-01', 'Kiadás', '-500', 'Kávé', 'Étel', 'Készpénz', ''],
			['2026-09-02', 'Bevétel', '10000', 'Zsebpénz', 'Apu', 'OTP kártya', ''],
			['2026-09-03', 'Átvezetés', '3000', '', '', 'OTP kártya', 'Készpénz'],
			['2026-09-04', 'Kiadás', '-700', 'Duplikált', 'Ebéd', 'Készpénz', '']
		];
		await ledger.addTx(expense({ amount: 700, date: '2026-09-04', description: 'Duplikált' })); // ez már megvan (Étel/Készpénz)
		const plan = planImport(
			rows,
			{ hasHeader: true, mapping: detectMapping(H, true), defaultAccountId: acc('Készpénz').id, createMissing: true, skipDuplicates: true, importTag: 'import' },
			{ accounts: ledger.activeAccounts, categories: ledger.categories, transactions: ledger.transactions }
		);
		expect(plan.errors).toEqual([]);
		expect(plan.duplicates).toBe(1); // ugyanaz a dátum, összeg, leírás és számla (a kategória nem számít)
		const r = await ledger.importPlan(plan);
		expect(r.accounts).toBe(1);
		expect(r.categories).toBe(2); // Ebéd (kiadás), Apu (bevétel)
		expect(ledger.accounts.some((a) => a.name === 'OTP kártya')).toBe(true);
		expect(ledger.categories.some((c) => c.name === 'Ebéd' && c.type === 'expense')).toBe(true);
		expect(ledger.categories.some((c) => c.name === 'Apu' && c.type === 'income')).toBe(true);
		const menza = ledger.transactions.find((t) => t.description === 'Menza')!;
		expect(menza).toMatchObject({ amount: 1200, type: 'expense', tags: ['import'] });
		expect(ledger.catById.get(menza.categoryId!)!.name).toBe('Ebéd');
		expect(ledger.accById.get(menza.accountId)!.name).toBe('OTP kártya');
		const tr = ledger.transactions.find((t) => t.type === 'transfer')!;
		expect(ledger.accById.get(tr.accountId)!.name).toBe('OTP kártya');
		expect(ledger.accById.get(tr.toAccountId!)!.name).toBe('Készpénz');
		await ledger.load();
		expect(ledger.transactions.filter((t) => t.tags.includes('import'))).toHaveLength(4);
	});

	it('duplikátumot kihagyva nem hoz létre felesleges kategóriát', async () => {
		const { planImport, detectMapping } = await import('../src/lib/csvImport');
		const H = ['Dátum', 'Összeg', 'Leírás', 'Kategória', 'Számla'];
		await ledger.addTx(expense({ amount: 700, date: '2026-09-04', description: 'Duplikált' }));
		const plan = planImport(
			[H, ['2026-09-04', '-700', 'Duplikált', 'Csak ehhez kellene', 'Készpénz']],
			{ hasHeader: true, mapping: detectMapping(H, true), defaultAccountId: null, createMissing: true, skipDuplicates: true, importTag: '' },
			{ accounts: ledger.activeAccounts, categories: ledger.categories, transactions: ledger.transactions }
		);
		expect(plan.duplicates).toBe(1);
		const r = await ledger.importPlan(plan);
		expect(r).toEqual({ added: 0, categories: 0, accounts: 0 });
		expect(ledger.categories.some((c) => c.name === 'Csak ehhez kellene')).toBe(false);
	});
});
