/** Biztonsági mentés (JSON) készítése és szigorú ellenőrzése visszatöltéskor. */
import { isValidISODate } from '../dates';
import { MAX_AMOUNT, type Account, type Backup, type Category, type Transaction } from '../types';

export function makeBackup(
	data: { accounts: Account[]; categories: Category[]; transactions: Transaction[] },
	now: Date = new Date()
): Backup {
	return {
		app: 'koltsegvetes-tracker',
		version: 1,
		exportedAt: now.toISOString(),
		accounts: data.accounts,
		categories: data.categories,
		transactions: data.transactions
	};
}

export type ParsedBackup = { ok: true; backup: Backup } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

export function parseBackup(text: string): ParsedBackup {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: 'A fájl nem érvényes JSON' };
	}
	if (!isObj(raw) || raw.app !== 'koltsegvetes-tracker') {
		return { ok: false, error: 'Ez nem ennek az appnak a biztonsági mentése' };
	}
	if (raw.version !== 1) return { ok: false, error: 'Ismeretlen mentésverzió' };
	if (!Array.isArray(raw.accounts) || !Array.isArray(raw.categories) || !Array.isArray(raw.transactions)) {
		return { ok: false, error: 'A mentés hiányos' };
	}

	const accounts: Account[] = [];
	const accountIds = new Set<number>();
	for (const a of raw.accounts) {
		if (!isObj(a) || !isInt(a.id) || !isStr(a.name) || !isInt(a.initialBalance)) {
			return { ok: false, error: 'Hibás számla a mentésben' };
		}
		if (accountIds.has(a.id)) return { ok: false, error: 'Ismétlődő számlaazonosító' };
		accountIds.add(a.id);
		accounts.push({
			id: a.id,
			name: a.name,
			initialBalance: a.initialBalance,
			archived: a.archived === true,
			sortOrder: isInt(a.sortOrder) ? a.sortOrder : 0,
			createdAt: isInt(a.createdAt) ? a.createdAt : Date.now()
		});
	}

	const categories: Category[] = [];
	const categoryTypes = new Map<number, string>();
	for (const c of raw.categories) {
		if (
			!isObj(c) ||
			!isInt(c.id) ||
			!isStr(c.name) ||
			(c.type !== 'income' && c.type !== 'expense') ||
			!isStr(c.color) ||
			!/^#[0-9a-fA-F]{6}$/.test(c.color)
		) {
			return { ok: false, error: 'Hibás kategória a mentésben' };
		}
		if (categoryTypes.has(c.id)) return { ok: false, error: 'Ismétlődő kategóriaazonosító' };
		categoryTypes.set(c.id, c.type);
		categories.push({
			id: c.id,
			name: c.name,
			type: c.type,
			color: c.color,
			icon: isStr(c.icon) ? c.icon : '',
			monthlyBudget: isInt(c.monthlyBudget) ? c.monthlyBudget : null,
			archived: c.archived === true,
			sortOrder: isInt(c.sortOrder) ? c.sortOrder : 0,
			createdAt: isInt(c.createdAt) ? c.createdAt : Date.now()
		});
	}

	const transactions: Transaction[] = [];
	const txIds = new Set<number>();
	for (const t of raw.transactions) {
		if (
			!isObj(t) ||
			!isInt(t.id) ||
			(t.type !== 'income' && t.type !== 'expense' && t.type !== 'transfer') ||
			!isInt(t.amount) ||
			t.amount <= 0 ||
			t.amount > MAX_AMOUNT ||
			!isStr(t.date) ||
			!isValidISODate(t.date) ||
			!isInt(t.accountId) ||
			!accountIds.has(t.accountId)
		) {
			return { ok: false, error: 'Hibás tétel a mentésben' };
		}
		if (txIds.has(t.id)) return { ok: false, error: 'Ismétlődő tételazonosító' };
		txIds.add(t.id);
		let categoryId: number | null = null;
		let toAccountId: number | null = null;
		if (t.type === 'transfer') {
			if (!isInt(t.toAccountId) || !accountIds.has(t.toAccountId) || t.toAccountId === t.accountId) {
				return { ok: false, error: 'Hibás átvezetés a mentésben' };
			}
			toAccountId = t.toAccountId;
		} else {
			if (!isInt(t.categoryId) || categoryTypes.get(t.categoryId) !== t.type) {
				return { ok: false, error: 'Hibás kategória-hivatkozás a mentésben' };
			}
			categoryId = t.categoryId;
		}
		const tags = Array.isArray(t.tags) ? t.tags.filter(isStr) : [];
		transactions.push({
			id: t.id,
			type: t.type,
			amount: t.amount,
			date: t.date,
			description: isStr(t.description) ? t.description : '',
			categoryId,
			accountId: t.accountId,
			toAccountId,
			note: isStr(t.note) ? t.note : '',
			tags,
			...(t.demo === true ? { demo: true } : {}),
			createdAt: isInt(t.createdAt) ? t.createdAt : Date.now(),
			updatedAt: isInt(t.updatedAt) ? t.updatedAt : Date.now()
		});
	}

	return {
		ok: true,
		backup: {
			app: 'koltsegvetes-tracker',
			version: 1,
			exportedAt: isStr(raw.exportedAt) ? raw.exportedAt : new Date().toISOString(),
			accounts,
			categories,
			transactions
		}
	};
}
