import type { Account, Category } from '../types';

type NewCategory = Omit<Category, 'id' | 'createdAt'>;
type NewAccount = Omit<Account, 'id' | 'createdAt'>;

const cat = (
	type: 'income' | 'expense',
	name: string,
	icon: string,
	color: string,
	sortOrder: number
): NewCategory => ({ type, name, icon, color, monthlyBudget: null, archived: false, sortOrder });

/** Alap kategóriák (mind szerkeszthető). */
export const DEFAULT_CATEGORIES: NewCategory[] = [
	cat('expense', 'Étel', '🍽️', '#f97316', 1),
	cat('expense', 'Közlekedés', '🚌', '#3b82f6', 2),
	cat('expense', 'Lakhatás/kollégium', '🏠', '#8b5cf6', 3),
	cat('expense', 'Tanulás', '📚', '#14b8a6', 4),
	cat('expense', 'Szórakozás', '🎬', '#ec4899', 5),
	cat('expense', 'Ruházat', '👕', '#a855f7', 6),
	cat('expense', 'Egészség', '💊', '#ef4444', 7),
	cat('expense', 'Előfizetések', '🔁', '#06b6d4', 8),
	cat('expense', 'Egyéb', '🧾', '#64748b', 9),
	cat('income', 'Ösztöndíj', '🎓', '#16a34a', 1),
	cat('income', 'Fizetés/munka', '💼', '#0d9488', 2),
	cat('income', 'Családtól', '👪', '#65a30d', 3),
	cat('income', 'Egyéb', '💰', '#0891b2', 4)
];

export const DEFAULT_ACCOUNTS: NewAccount[] = [
	{ name: 'Készpénz', initialBalance: 0, archived: false, sortOrder: 1 },
	{ name: 'Bankkártya', initialBalance: 0, archived: false, sortOrder: 2 },
	{ name: 'Megtakarítás', initialBalance: 0, archived: false, sortOrder: 3 }
];
