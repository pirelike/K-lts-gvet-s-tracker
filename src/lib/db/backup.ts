/**
 * Biztonsági mentés (JSON) készítése és szigorú ellenőrzése visszatöltéskor.
 *
 * Verziózás: a mentés `version` mezője a formátumot jelöli. Új mező vagy tároló felvételekor
 * emeld a `BACKUP_VERSION`-t, és írj egy `MIGRATIONS[régi]` lépést, ami a régi nyers JSON-t az
 * eggyel újabb alakra hozza – így a régebbi mentések mindig betölthetők maradnak. A lépések a
 * nyers (még nem ellenőrzött) objektumon dolgoznak; az ellenőrzés mindig a legújabb alakon fut.
 */
import { CURRENCIES } from '../currency';
import { isValidISODate } from '../dates';
import {
	ACCOUNT_TYPES,
	DEFAULT_PREFS,
	MAX_AMOUNT,
	MAX_SPLITS,
	mainCategory,
	type Account,
	type AccountType,
	type Backup,
	type Category,
	type Goal,
	type LedgerSnapshot,
	type Prefs,
	type Recurring,
	type SavedFilter,
	type Template,
	type Transaction,
	type TxSplit
} from '../types';
import { inferAccountType } from './idb';

export const BACKUP_VERSION = 2;

type Raw = Record<string, unknown>;

/** Kimenő mentés összeállítása; a hiányzó részek (régebbi hívók, tesztek) üresek lesznek. */
export function makeBackup(
	data: Partial<LedgerSnapshot> & Pick<LedgerSnapshot, 'accounts' | 'categories' | 'transactions'>,
	now: Date = new Date()
): Backup {
	return {
		app: 'koltsegvetes-tracker',
		version: BACKUP_VERSION,
		exportedAt: now.toISOString(),
		prefs: data.prefs ?? DEFAULT_PREFS,
		accounts: data.accounts,
		categories: data.categories,
		transactions: data.transactions,
		recurring: data.recurring ?? [],
		templates: data.templates ?? [],
		goals: data.goals ?? [],
		filters: data.filters ?? []
	};
}

export type ParsedBackup =
	| { ok: true; backup: Backup }
	| { ok: false; error: string; encrypted?: boolean };

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isDate = (v: unknown): v is string => isStr(v) && isValidISODate(v);

/** Lépések: MIGRATIONS[n] az n. verziójú nyers mentést az (n+1). verzióra hozza. */
const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
	// 1 -> 2: számlatípus, ismétlődők, sablonok, célok, mentett szűrők, beállítások (HUF).
	1: (raw) => ({
		...raw,
		version: 2,
		prefs: DEFAULT_PREFS,
		accounts: Array.isArray(raw.accounts)
			? raw.accounts.map((a) =>
					isObj(a) && !a.type && isStr(a.name) ? { ...a, type: inferAccountType(a.name) } : a
				)
			: raw.accounts,
		recurring: [],
		templates: [],
		goals: [],
		filters: []
	})
};

/** A mentés vissza is tölthető, ha a `version` legfeljebb az app ismert legújabb verziója. */
export function migrateBackup(raw: Raw): { ok: true; raw: Raw } | { ok: false; error: string } {
	let cur = raw;
	let v = cur.version;
	if (!isInt(v) || v < 1 || v > BACKUP_VERSION) return { ok: false, error: 'Ismeretlen mentésverzió' };
	while ((v as number) < BACKUP_VERSION) {
		cur = MIGRATIONS[v as number](cur);
		v = cur.version;
	}
	return { ok: true, raw: cur };
}

/** A fájl jelszóval védett mentés-e (a tartalma nélkül is felismerhető). */
export function isEncryptedBackup(text: string): boolean {
	try {
		const raw = JSON.parse(text);
		return isObj(raw) && raw.app === 'koltsegvetes-tracker' && raw.encrypted === true;
	} catch {
		return false;
	}
}

const fail = (error: string) => ({ ok: false as const, error });

export function parseBackup(text: string): ParsedBackup {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail('A fájl nem érvényes JSON');
	}
	if (!isObj(parsed) || parsed.app !== 'koltsegvetes-tracker') {
		return fail('Ez nem ennek az appnak a biztonsági mentése');
	}
	if (parsed.encrypted === true) {
		return { ok: false, error: 'A mentés jelszóval védett', encrypted: true };
	}
	const migrated = migrateBackup(parsed);
	if (!migrated.ok) return fail(migrated.error);
	const raw = migrated.raw;
	if (!Array.isArray(raw.accounts) || !Array.isArray(raw.categories) || !Array.isArray(raw.transactions)) {
		return fail('A mentés hiányos');
	}
	for (const k of ['recurring', 'templates', 'goals', 'filters'] as const) {
		if (!Array.isArray(raw[k])) return fail('A mentés hiányos');
	}

	// --- beállítások ---
	const rp = isObj(raw.prefs) ? raw.prefs : {};
	if (rp.currency !== undefined && !CURRENCIES.some((c) => c.code === rp.currency)) {
		return fail('Ismeretlen pénznem a mentésben');
	}
	const prefs: Prefs = {
		currency: isStr(rp.currency) ? rp.currency : DEFAULT_PREFS.currency,
		totalBudget: isInt(rp.totalBudget) && rp.totalBudget > 0 ? rp.totalBudget : null
	};

	// --- számlák ---
	const accounts: Account[] = [];
	const accountIds = new Set<number>();
	for (const a of raw.accounts as unknown[]) {
		if (!isObj(a) || !isInt(a.id) || !isStr(a.name) || !isInt(a.initialBalance)) {
			return fail('Hibás számla a mentésben');
		}
		if (accountIds.has(a.id)) return fail('Ismétlődő számlaazonosító');
		accountIds.add(a.id);
		accounts.push({
			id: a.id,
			name: a.name,
			type: ACCOUNT_TYPES.includes(a.type as AccountType) ? (a.type as AccountType) : inferAccountType(a.name),
			initialBalance: a.initialBalance,
			archived: a.archived === true,
			sortOrder: isInt(a.sortOrder) ? a.sortOrder : 0,
			createdAt: isInt(a.createdAt) ? a.createdAt : Date.now()
		});
	}

	// --- kategóriák ---
	const categories: Category[] = [];
	const categoryTypes = new Map<number, string>();
	for (const c of raw.categories as unknown[]) {
		if (
			!isObj(c) ||
			!isInt(c.id) ||
			!isStr(c.name) ||
			(c.type !== 'income' && c.type !== 'expense') ||
			!isStr(c.color) ||
			!/^#[0-9a-fA-F]{6}$/.test(c.color)
		) {
			return fail('Hibás kategória a mentésben');
		}
		if (categoryTypes.has(c.id)) return fail('Ismétlődő kategóriaazonosító');
		categoryTypes.set(c.id, c.type);
		categories.push({
			id: c.id,
			name: c.name,
			type: c.type,
			color: c.color,
			icon: isStr(c.icon) ? c.icon : '',
			monthlyBudget: isInt(c.monthlyBudget) && c.monthlyBudget > 0 ? c.monthlyBudget : null,
			archived: c.archived === true,
			sortOrder: isInt(c.sortOrder) ? c.sortOrder : 0,
			createdAt: isInt(c.createdAt) ? c.createdAt : Date.now()
		});
	}

	/** A kategória típusa, amit a tranzakciótípus megkövetel (átvezetésnél nincs). */
	const wantedCategoryType = (type: string) => (type === 'transfer' ? null : type === 'income' ? 'income' : 'expense');

	// --- tranzakciók ---
	const transactions: Transaction[] = [];
	const txIds = new Set<number>();
	for (const t of raw.transactions as unknown[]) {
		if (
			!isObj(t) ||
			!isInt(t.id) ||
			(t.type !== 'income' && t.type !== 'expense' && t.type !== 'transfer' && t.type !== 'refund') ||
			!isInt(t.amount) ||
			t.amount <= 0 ||
			t.amount > MAX_AMOUNT ||
			!isDate(t.date) ||
			!isInt(t.accountId) ||
			!accountIds.has(t.accountId)
		) {
			return fail('Hibás tétel a mentésben');
		}
		if (txIds.has(t.id)) return fail('Ismétlődő tételazonosító');
		txIds.add(t.id);
		let categoryId: number | null = null;
		let toAccountId: number | null = null;
		let splits: TxSplit[] | undefined;
		if (t.type === 'transfer') {
			if (!isInt(t.toAccountId) || !accountIds.has(t.toAccountId) || t.toAccountId === t.accountId) {
				return fail('Hibás átvezetés a mentésben');
			}
			toAccountId = t.toAccountId;
		} else {
			if (!isInt(t.categoryId) || categoryTypes.get(t.categoryId) !== wantedCategoryType(t.type)) {
				return fail('Hibás kategória-hivatkozás a mentésben');
			}
			categoryId = t.categoryId;
			if (t.splits !== undefined) {
				const parsedSplits = parseSplits(t.splits, t.amount, categoryTypes, wantedCategoryType(t.type)!);
				if (!parsedSplits) return fail('Hibás felosztás a mentésben');
				splits = parsedSplits;
				// A fő kategória mindig a legnagyobb rész kategóriája.
				categoryId = mainCategory(parsedSplits);
			}
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
			...(splits ? { splits } : {}),
			...(isInt(t.recurringId) ? { recurringId: t.recurringId } : {}),
			...(t.demo === true ? { demo: true } : {}),
			createdAt: isInt(t.createdAt) ? t.createdAt : Date.now(),
			updatedAt: isInt(t.updatedAt) ? t.updatedAt : Date.now()
		});
	}

	// --- ismétlődő tételek ---
	const recurring: Recurring[] = [];
	const recIds = new Set<number>();
	for (const r of raw.recurring as unknown[]) {
		if (
			!isObj(r) ||
			!isInt(r.id) ||
			(r.type !== 'income' && r.type !== 'expense' && r.type !== 'transfer') ||
			!isInt(r.amount) ||
			r.amount <= 0 ||
			r.amount > MAX_AMOUNT ||
			(r.frequency !== 'weekly' && r.frequency !== 'monthly' && r.frequency !== 'yearly') ||
			!isInt(r.interval) ||
			r.interval < 1 ||
			r.interval > 1000 ||
			!isDate(r.startDate) ||
			(r.endDate !== null && r.endDate !== undefined && !isDate(r.endDate)) ||
			(r.lastHandled !== null && r.lastHandled !== undefined && !isDate(r.lastHandled)) ||
			!isInt(r.accountId) ||
			!accountIds.has(r.accountId)
		) {
			return fail('Hibás ismétlődő tétel a mentésben');
		}
		if (recIds.has(r.id)) return fail('Ismétlődő szabályazonosító');
		recIds.add(r.id);
		let categoryId: number | null = null;
		let toAccountId: number | null = null;
		if (r.type === 'transfer') {
			if (!isInt(r.toAccountId) || !accountIds.has(r.toAccountId) || r.toAccountId === r.accountId) {
				return fail('Hibás ismétlődő átvezetés a mentésben');
			}
			toAccountId = r.toAccountId;
		} else {
			if (!isInt(r.categoryId) || categoryTypes.get(r.categoryId) !== r.type) {
				return fail('Hibás kategória az ismétlődő tételnél');
			}
			categoryId = r.categoryId;
		}
		recurring.push({
			id: r.id,
			type: r.type,
			amount: r.amount,
			description: isStr(r.description) ? r.description : '',
			categoryId,
			accountId: r.accountId,
			toAccountId,
			note: isStr(r.note) ? r.note : '',
			tags: Array.isArray(r.tags) ? r.tags.filter(isStr) : [],
			frequency: r.frequency,
			interval: r.interval,
			startDate: r.startDate,
			endDate: isStr(r.endDate) ? r.endDate : null,
			lastHandled: isStr(r.lastHandled) ? r.lastHandled : null,
			active: r.active !== false,
			createdAt: isInt(r.createdAt) ? r.createdAt : Date.now()
		});
	}

	// A sablonok és célok hivatkozásait a megszűnt elemekről nem utasítjuk el, csak kiürítjük.
	const refOrNull = (v: unknown, ids: Set<number>) => (isInt(v) && ids.has(v) ? v : null);

	const templates: Template[] = [];
	const tplIds = new Set<number>();
	for (const t of raw.templates as unknown[]) {
		if (
			!isObj(t) ||
			!isInt(t.id) ||
			!isStr(t.name) ||
			(t.type !== 'income' && t.type !== 'expense' && t.type !== 'transfer' && t.type !== 'refund') ||
			(t.amount !== null && t.amount !== undefined && (!isInt(t.amount) || t.amount <= 0 || t.amount > MAX_AMOUNT))
		) {
			return fail('Hibás sablon a mentésben');
		}
		if (tplIds.has(t.id)) return fail('Ismétlődő sablonazonosító');
		tplIds.add(t.id);
		const catId = refOrNull(t.categoryId, new Set(categoryTypes.keys()));
		templates.push({
			id: t.id,
			name: t.name,
			type: t.type,
			amount: isInt(t.amount) ? t.amount : null,
			description: isStr(t.description) ? t.description : '',
			categoryId: catId != null && categoryTypes.get(catId) === wantedCategoryType(t.type) ? catId : null,
			accountId: refOrNull(t.accountId, accountIds),
			toAccountId: refOrNull(t.toAccountId, accountIds),
			note: isStr(t.note) ? t.note : '',
			tags: Array.isArray(t.tags) ? t.tags.filter(isStr) : [],
			sortOrder: isInt(t.sortOrder) ? t.sortOrder : 0,
			createdAt: isInt(t.createdAt) ? t.createdAt : Date.now()
		});
	}

	const goals: Goal[] = [];
	const goalIds = new Set<number>();
	for (const g of raw.goals as unknown[]) {
		if (
			!isObj(g) ||
			!isInt(g.id) ||
			!isStr(g.name) ||
			!isInt(g.target) ||
			g.target <= 0 ||
			g.target > MAX_AMOUNT ||
			(g.deadline !== null && g.deadline !== undefined && !isDate(g.deadline))
		) {
			return fail('Hibás cél a mentésben');
		}
		if (goalIds.has(g.id)) return fail('Ismétlődő célazonosító');
		goalIds.add(g.id);
		goals.push({
			id: g.id,
			name: g.name,
			icon: isStr(g.icon) ? g.icon : '🎯',
			color: isStr(g.color) && /^#[0-9a-fA-F]{6}$/.test(g.color) ? g.color : '#4f46e5',
			target: g.target,
			saved: isInt(g.saved) && g.saved >= 0 ? g.saved : 0,
			accountId: refOrNull(g.accountId, accountIds),
			deadline: isStr(g.deadline) ? g.deadline : null,
			archived: g.archived === true,
			sortOrder: isInt(g.sortOrder) ? g.sortOrder : 0,
			createdAt: isInt(g.createdAt) ? g.createdAt : Date.now()
		});
	}

	const filters: SavedFilter[] = [];
	const filterIds = new Set<number>();
	for (const f of raw.filters as unknown[]) {
		if (!isObj(f) || !isInt(f.id) || !isStr(f.name) || !isStr(f.query)) return fail('Hibás mentett szűrő a mentésben');
		if (filterIds.has(f.id)) return fail('Ismétlődő szűrőazonosító');
		filterIds.add(f.id);
		filters.push({
			id: f.id,
			name: f.name,
			query: f.query,
			createdAt: isInt(f.createdAt) ? f.createdAt : Date.now()
		});
	}

	return {
		ok: true,
		backup: {
			app: 'koltsegvetes-tracker',
			version: BACKUP_VERSION,
			exportedAt: isStr(raw.exportedAt) ? raw.exportedAt : new Date().toISOString(),
			prefs,
			accounts,
			categories,
			transactions,
			recurring,
			templates,
			goals,
			filters
		}
	};
}

/** Felosztás ellenőrzése: 2+ rész, pozitív egészek, megfelelő típusú kategóriák, az összeg egyezik. */
function parseSplits(
	value: unknown,
	total: number,
	categoryTypes: Map<number, string>,
	wanted: string
): TxSplit[] | null {
	if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SPLITS) return null;
	const out: TxSplit[] = [];
	let sum = 0;
	for (const s of value) {
		if (!isObj(s) || !isInt(s.categoryId) || !isInt(s.amount) || s.amount <= 0) return null;
		if (categoryTypes.get(s.categoryId) !== wanted) return null;
		sum += s.amount;
		out.push({ categoryId: s.categoryId, amount: s.amount });
	}
	return sum === total ? out : null;
}
