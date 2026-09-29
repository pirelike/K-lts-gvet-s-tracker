import type { Account, Category, Transaction } from '../src/lib/types';

export const accounts: Account[] = [
	{ id: 1, name: 'Készpénz', initialBalance: 10000, archived: false, sortOrder: 1, createdAt: 1 },
	{ id: 2, name: 'Bankkártya', initialBalance: 50000, archived: false, sortOrder: 2, createdAt: 2 },
	{ id: 3, name: 'Régi számla', initialBalance: 0, archived: true, sortOrder: 3, createdAt: 3 }
];

export const categories: Category[] = [
	{ id: 1, name: 'Étel', type: 'expense', color: '#f97316', icon: '🍽️', monthlyBudget: null, archived: false, sortOrder: 1, createdAt: 1 },
	{ id: 2, name: 'Közlekedés', type: 'expense', color: '#3b82f6', icon: '🚌', monthlyBudget: null, archived: false, sortOrder: 2, createdAt: 2 },
	{ id: 3, name: 'Régi', type: 'expense', color: '#000000', icon: '', monthlyBudget: null, archived: true, sortOrder: 3, createdAt: 3 },
	{ id: 4, name: 'Ösztöndíj', type: 'income', color: '#16a34a', icon: '🎓', monthlyBudget: null, archived: false, sortOrder: 1, createdAt: 4 }
];

let nextId = 1;
export function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
	const id = p.id ?? nextId++;
	return {
		description: '',
		categoryId: p.type === 'transfer' ? null : p.type === 'income' ? 4 : 1,
		accountId: 1,
		toAccountId: null,
		note: '',
		tags: [],
		createdAt: id,
		updatedAt: id,
		...p,
		id
	};
}
