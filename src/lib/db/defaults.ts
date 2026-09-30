import type { Account, Category } from '../types';

/** Az alapelemek azonosítója fix: két friss eszköz ugyanazokat hozza létre, szinkron után sincs duplikátum. */
type NewCategory = Omit<Category, 'createdAt' | 'updatedAt'>;
type NewAccount = Omit<Account, 'createdAt' | 'updatedAt'>;

/** Az alap kategóriák azonosítói ettől indulnak (a számlák 1-től); a felhasználói elemeké `>= 2^32`. */
export const DEFAULT_CATEGORY_ID_BASE = 101;

let nextCategoryId = DEFAULT_CATEGORY_ID_BASE;
const cat = (
	type: 'income' | 'expense',
	name: string,
	icon: string,
	color: string,
	sortOrder: number
): NewCategory => ({ id: nextCategoryId++, type, name, icon, color, monthlyBudget: null, archived: false, sortOrder });

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
	{ id: 1, name: 'Készpénz', type: 'cash', initialBalance: 0, archived: false, sortOrder: 1 },
	{ id: 2, name: 'Bankkártya', type: 'checking', initialBalance: 0, archived: false, sortOrder: 2 },
	{ id: 3, name: 'Megtakarítás', type: 'savings', initialBalance: 0, archived: false, sortOrder: 3 }
];

/** Az egyenleg-egyeztetés korrekciós tételeinek kategóriája (kiadás és bevétel oldalon is létrejön, ha kell). */
export const CORRECTION_CATEGORY = { name: 'Egyenleg-korrekció', icon: '⚖️', color: '#64748b' };
