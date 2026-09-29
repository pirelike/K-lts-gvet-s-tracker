import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openLedgerDb } from '../src/lib/db/idb';
import { LedgerRepo } from '../src/lib/db/repo';
import { ledger, LedgerError } from '../src/lib/ledger.svelte';
import { accountBalances, monthSummary } from '../src/lib/queries';
import type { TxInput } from '../src/lib/types';

let n = 0;
beforeEach(async () => {
	const repo = new LedgerRepo(await openLedgerDb(`ledger-${n++}`));
	ledger.attach(repo);
	await repo.seedDefaultsIfNeeded();
	await ledger.load();
});

const cat = (type: 'income' | 'expense', name: string) => ledger.categories.find((c) => c.type === type && c.name === name)!;
const acc = (name: string) => ledger.accounts.find((a) => a.name === name)!;
const expense = (over: Partial<TxInput> = {}): TxInput => ({
	type: 'expense',
	amount: 890,
	date: '2026-09-28',
	description: 'Kávé',
	categoryId: cat('expense', 'Étel').id,
	accountId: acc('Készpénz').id,
	toAccountId: null,
	note: '',
	tags: [],
	...over
});

describe('főkönyv', () => {
	it('felvitel, szerkesztés, törlés, visszavonás', async () => {
		const t = await ledger.addTx(expense());
		expect(ledger.transactions).toHaveLength(1);

		await ledger.updateTx(t.id, expense({ amount: 1200, description: 'Dupla kávé' }));
		expect(ledger.transactions[0].amount).toBe(1200);
		expect(ledger.transactions[0].updatedAt).toBeGreaterThanOrEqual(t.updatedAt);

		const snap = await ledger.deleteTx(t.id);
		expect(ledger.transactions).toHaveLength(0);

		await ledger.restoreTx(snap);
		expect(ledger.transactions).toHaveLength(1);
		expect(ledger.transactions[0].id).toBe(t.id);
		await ledger.restoreTx(snap); // kétszeri visszavonás nem duplikál
		expect(ledger.transactions).toHaveLength(1);

		// a memória és az adatbázis egyezik
		const fresh = ledger.transactions.map((x) => x.id);
		await ledger.load();
		expect(ledger.transactions.map((x) => x.id)).toEqual(fresh);
	});

	it('kategória: használt nem törölhető, csak archiválható; használaton kívüli törölhető', async () => {
		const food = cat('expense', 'Étel');
		await ledger.addTx(expense());
		await expect(ledger.deleteCategory(food.id)).rejects.toThrow(LedgerError);
		await ledger.setCategoryArchived(food.id, true);
		expect(ledger.catById.get(food.id)!.archived).toBe(true);
		await ledger.setCategoryArchived(food.id, false);

		const unused = await ledger.addCategory('expense', { name: 'Ajándék', color: '#123456', icon: '🎁' });
		await ledger.deleteCategory(unused.id);
		expect(ledger.catById.has(unused.id)).toBe(false);
	});

	it('számla: használt nem törölhető; átvezetés számít használatnak', async () => {
		const savings = acc('Megtakarítás');
		await ledger.addTx({
			type: 'transfer', amount: 5000, date: '2026-09-28', description: '', categoryId: null,
			accountId: acc('Bankkártya').id, toAccountId: savings.id, note: '', tags: []
		});
		await expect(ledger.deleteAccount(savings.id)).rejects.toThrow(LedgerError);
		const fresh = await ledger.addAccount({ name: 'Új', initialBalance: 100 });
		await ledger.deleteAccount(fresh.id);
	});

	it('az átvezetés nem kerül a havi bevételbe/kiadásba, de az egyenleget mozgatja', async () => {
		await ledger.addTx(expense({ amount: 1000 }));
		await ledger.addTx({
			type: 'transfer', amount: 20000, date: '2026-09-28', description: '', categoryId: null,
			accountId: acc('Bankkártya').id, toAccountId: acc('Készpénz').id, note: '', tags: []
		});
		const m = monthSummary(ledger.transactions, ledger.categories, '2026-09');
		expect(m.expense).toBe(1000);
		expect(m.income).toBe(0);
		const bal = accountBalances(ledger.accounts, ledger.transactions);
		expect(bal.get(acc('Készpénz').id)).toBe(19000);
		expect(bal.get(acc('Bankkártya').id)).toBe(-20000);
	});

	it('példaadatok betöltése és egy gombos törlése; a saját tételek megmaradnak', async () => {
		await ledger.addTx(expense({ description: 'Saját tétel' }));
		const added = await ledger.loadDemoData('2026-09-29');
		expect(added).toBeGreaterThan(100);
		expect(ledger.hasDemo).toBe(true);
		const removed = await ledger.removeDemoData();
		expect(removed).toBe(added);
		expect(ledger.hasDemo).toBe(false);
		expect(ledger.transactions.map((t) => t.description)).toEqual(['Saját tétel']);
	});

	it('mentés visszatöltése lecseréli az adatokat', async () => {
		await ledger.addTx(expense({ description: 'Régi' }));
		const backup = ledger.exportBackup();
		await ledger.addTx(expense({ description: 'Újabb' }));
		expect(ledger.transactions).toHaveLength(2);
		await ledger.importBackup(backup);
		expect(ledger.transactions.map((t) => t.description)).toEqual(['Régi']);
	});
});
