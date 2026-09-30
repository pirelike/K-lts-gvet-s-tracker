/** Beviteli validáció – tiszta függvények, a felület és a tesztek is ezt használják. */
import { isValidISODate } from './dates';
import { evaluateExpression, parseAmount } from './money';
import { fold } from './text';
import {
	ACCOUNT_TYPES,
	MAX_DESCRIPTION,
	MAX_NAME,
	MAX_NOTE,
	MAX_SPLITS,
	MAX_TAG,
	MAX_TAGS,
	categoryTypeFor,
	mainCategory,
	type Account,
	type AccountType,
	type Category,
	type CategoryType,
	type Frequency,
	type Goal,
	type NewRecurring,
	type Template,
	type TxInput,
	type TxSplit,
	type TxType
} from './types';

export type Errors<K extends string> = Partial<Record<K, string>>;
export type Validated<T, K extends string> =
	| { ok: true; value: T }
	| { ok: false; errors: Errors<K> };

/** „nyaralás, #egyetem  Kávé" -> ['nyaralás', 'egyetem', 'kávé'] */
export function parseTags(text: string): { tags: string[]; error?: string } {
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const raw of text.split(/[\s,;#]+/)) {
		const tag = raw.trim().toLocaleLowerCase('hu');
		if (!tag || seen.has(tag)) continue;
		if (tag.length > MAX_TAG) return { tags, error: `A címke legfeljebb ${MAX_TAG} karakter lehet` };
		seen.add(tag);
		tags.push(tag);
	}
	if (tags.length > MAX_TAGS) return { tags, error: `Legfeljebb ${MAX_TAGS} címke adható meg` };
	return { tags };
}

/** A felosztás egy sora az űrlapon (üres összeg = a hátralévő rész). */
export interface SplitFormRow {
	categoryId: number | null;
	amount: string;
}

/** Az űrlap nyers (szöveges) értékei. */
export interface TxFormValues {
	type: TxType;
	amount: string;
	date: string;
	description: string;
	categoryId: number | null;
	accountId: number | null;
	toAccountId: number | null;
	note: string;
	tags: string;
	/** Felosztás sorai; üres vagy hiányzó = nincs felosztás. */
	splits?: SplitFormRow[];
}

export type TxField =
	| 'splits'
	| 'amount'
	| 'date'
	| 'description'
	| 'category'
	| 'account'
	| 'toAccount'
	| 'note'
	| 'tags';

export interface TxContext {
	categories: Category[];
	accounts: Account[];
	/** Szerkesztésnél a jelenlegi mentett érték: archivált kategória/számla ilyenkor még elfogadott. */
	existing?: {
		categoryId: number | null;
		accountId: number;
		toAccountId: number | null;
		/** A már mentett felosztás kategóriái (azok archiválva is megmaradhatnak). */
		splitCategoryIds?: number[];
	};
}

/**
 * Felosztás ellenőrzése. Legfeljebb egy sor összege lehet üres: az kapja a hátralévő részt.
 * Vissza: a részek, vagy hibaüzenet.
 */
export function resolveSplits(
	rows: readonly SplitFormRow[],
	total: number,
	wantedType: CategoryType,
	ctx: Pick<TxContext, 'categories' | 'existing'>
): { ok: true; parts: TxSplit[] } | { ok: false; error: string } {
	if (rows.length < 2) return { ok: false, error: 'A felosztáshoz legalább két rész kell' };
	if (rows.length > MAX_SPLITS) return { ok: false, error: `Legfeljebb ${MAX_SPLITS} részre bontható` };
	const seen = new Set<number>();
	const parts: { categoryId: number; amount: number | null }[] = [];
	let explicit = 0;
	let blanks = 0;
	for (const row of rows) {
		const cat = ctx.categories.find((c) => c.id === row.categoryId);
		if (!cat || cat.type !== wantedType) return { ok: false, error: 'Minden részhez válassz kategóriát' };
		if (cat.archived && !ctx.existing?.splitCategoryIds?.includes(cat.id) && cat.id !== ctx.existing?.categoryId) {
			return { ok: false, error: 'Az archivált kategória nem használható új részhez' };
		}
		if (seen.has(cat.id)) return { ok: false, error: 'Egy kategória csak egyszer szerepelhet a felosztásban' };
		seen.add(cat.id);
		if (!row.amount.trim()) {
			blanks++;
			parts.push({ categoryId: cat.id, amount: null });
			continue;
		}
		const a = parseAmount(row.amount);
		if (!a.ok) return { ok: false, error: a.error };
		explicit += a.value;
		parts.push({ categoryId: cat.id, amount: a.value });
	}
	if (blanks > 1) return { ok: false, error: 'Legfeljebb egy rész összege maradhat üresen' };
	const rest = total - explicit;
	if (blanks === 1) {
		if (rest <= 0) return { ok: false, error: 'A részek összege eléri vagy meghaladja a teljes összeget' };
	} else if (rest !== 0) {
		return {
			ok: false,
			error: rest > 0 ? 'A részek összege kevesebb, mint a teljes összeg' : 'A részek összege több, mint a teljes összeg'
		};
	}
	return { ok: true, parts: parts.map((p) => ({ categoryId: p.categoryId, amount: p.amount ?? rest })) };
}

export function validateTx(v: TxFormValues, ctx: TxContext): Validated<TxInput, TxField> {
	const errors: Errors<TxField> = {};

	const amount = parseAmount(v.amount);
	if (!amount.ok) errors.amount = amount.error;

	if (!isValidISODate(v.date)) errors.date = 'Érvénytelen dátum';

	const description = v.description.trim();
	if (description.length > MAX_DESCRIPTION) {
		errors.description = `A leírás legfeljebb ${MAX_DESCRIPTION} karakter lehet`;
	} else if (v.type === 'expense' && !description) {
		errors.description = 'Írd le, mire költöttél';
	}

	const note = v.note.trim();
	if (note.length > MAX_NOTE) errors.note = `A megjegyzés legfeljebb ${MAX_NOTE} karakter lehet`;

	const accountOk = (id: number | null, current: number | null | undefined) => {
		if (id === null) return false;
		const a = ctx.accounts.find((x) => x.id === id);
		return !!a && (!a.archived || id === current);
	};

	let categoryId: number | null = null;
	let toAccountId: number | null = null;

	if (!accountOk(v.accountId, ctx.existing?.accountId)) {
		errors.account = v.type === 'transfer' ? 'Válaszd ki a forrásszámlát' : 'Válaszd ki a számlát';
	}

	if (v.type === 'transfer') {
		if (!accountOk(v.toAccountId, ctx.existing?.toAccountId)) {
			errors.toAccount = 'Válaszd ki a célszámlát';
		} else if (v.toAccountId === v.accountId) {
			errors.toAccount = 'A forrás- és a célszámla nem lehet ugyanaz';
		} else {
			toAccountId = v.toAccountId;
		}
	} else {
		const wanted = categoryTypeFor(v.type)!;
		const cat = ctx.categories.find((c) => c.id === v.categoryId);
		if (!cat || cat.type !== wanted) {
			errors.category = 'Válassz kategóriát';
		} else if (cat.archived && cat.id !== ctx.existing?.categoryId) {
			errors.category = 'Az archivált kategória nem használható új tételhez';
		} else {
			categoryId = cat.id;
		}
	}

	let splits: TxSplit[] | undefined;
	if (v.type !== 'transfer' && v.splits && v.splits.length > 0) {
		if (amount.ok) {
			const r = resolveSplits(v.splits, amount.value, categoryTypeFor(v.type)!, ctx);
			if (r.ok) {
				splits = r.parts;
				categoryId = mainCategory(r.parts);
				delete errors.category;
			} else errors.splits = r.error;
		} else errors.splits = 'Előbb add meg a teljes összeget';
	}

	const tags = parseTags(v.tags);
	if (tags.error) errors.tags = tags.error;

	if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
	return {
		ok: true,
		value: {
			type: v.type,
			amount: amount.value,
			date: v.date,
			description,
			categoryId,
			accountId: v.accountId!,
			toAccountId,
			note,
			tags: tags.tags,
			...(splits ? { splits } : {})
		}
	};
}

// --- kategóriák ---

export interface CategoryFormValues {
	name: string;
	type: CategoryType;
	color: string;
	icon: string;
	/** Havi keret nyers szövege (csak kiadási kategóriánál; üres = nincs). */
	monthlyBudget?: string;
}
export type CategoryField = 'name' | 'color' | 'icon' | 'monthlyBudget';

export interface CategoryValues {
	name: string;
	type: CategoryType;
	color: string;
	icon: string;
	monthlyBudget: number | null;
}

/** Havi keret mező: üres = nincs keret, különben pozitív összeg. */
export function parseBudget(raw: string | undefined): { ok: true; value: number | null } | { ok: false; error: string } {
	if (!raw || !raw.trim()) return { ok: true, value: null };
	const r = parseAmount(raw);
	if (!r.ok) return { ok: false, error: r.error };
	return { ok: true, value: r.value };
}

export function validateCategory(
	v: CategoryFormValues,
	all: Category[],
	editingId?: number
): Validated<CategoryValues, CategoryField> {
	const errors: Errors<CategoryField> = {};
	const name = v.name.trim();
	if (!name) errors.name = 'Adj nevet a kategóriának';
	else if (name.length > MAX_NAME) errors.name = `A név legfeljebb ${MAX_NAME} karakter lehet`;
	else if (all.some((c) => c.id !== editingId && c.type === v.type && fold(c.name) === fold(name))) {
		errors.name = 'Már van ilyen nevű kategória';
	}
	if (!/^#[0-9a-fA-F]{6}$/.test(v.color)) errors.color = 'Érvénytelen szín';
	const icon = v.icon.trim();
	if ([...icon].length > 4) errors.icon = 'Az ikon legfeljebb 4 karakter';
	let monthlyBudget: number | null = null;
	if (v.type === 'expense') {
		const b = parseBudget(v.monthlyBudget);
		if (!b.ok) errors.monthlyBudget = b.error;
		else monthlyBudget = b.value;
	}
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name, type: v.type, color: v.color.toLowerCase(), icon, monthlyBudget } };
}

// --- számlák ---

export interface AccountFormValues {
	name: string;
	initialBalance: string;
	type?: AccountType;
}
export type AccountField = 'name' | 'initialBalance' | 'type';

export interface AccountValues {
	name: string;
	initialBalance: number;
	type: AccountType;
}

export function validateAccount(
	v: AccountFormValues,
	all: Account[],
	editingId?: number
): Validated<AccountValues, AccountField> {
	const errors: Errors<AccountField> = {};
	const name = v.name.trim();
	if (!name) errors.name = 'Adj nevet a számlának';
	else if (name.length > MAX_NAME) errors.name = `A név legfeljebb ${MAX_NAME} karakter lehet`;
	else if (all.some((a) => a.id !== editingId && fold(a.name) === fold(name))) {
		errors.name = 'Már van ilyen nevű számla';
	}
	let initialBalance = 0;
	if (v.initialBalance.trim()) {
		const r = evaluateExpression(v.initialBalance);
		if (!r.ok) errors.initialBalance = r.error;
		else initialBalance = r.value;
	}
	const type = v.type ?? 'checking';
	if (!ACCOUNT_TYPES.includes(type)) errors.type = 'Ismeretlen számlatípus';
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name, initialBalance, type } };
}

// --- ismétlődő tételek ---

export interface RecurringFormValues {
	type: 'income' | 'expense' | 'transfer';
	amount: string;
	description: string;
	categoryId: number | null;
	accountId: number | null;
	toAccountId: number | null;
	note: string;
	tags: string;
	frequency: Frequency;
	interval: string;
	startDate: string;
	/** Üres = határozatlan ideig. */
	endDate: string;
}
export type RecurringField = 'amount' | 'description' | 'category' | 'account' | 'toAccount' | 'interval' | 'startDate' | 'endDate' | 'tags';

/** A szabály mezői a technikai adatok (azonosító, feldolgozás állapota) nélkül. */
export type RecurringInput = Omit<NewRecurring, 'lastHandled' | 'active' | 'createdAt' | 'updatedAt'>;

export function validateRecurring(
	v: RecurringFormValues,
	ctx: { categories: Category[]; accounts: Account[] }
): Validated<RecurringInput, RecurringField> {
	const errors: Errors<RecurringField> = {};
	const amount = parseAmount(v.amount);
	if (!amount.ok) errors.amount = amount.error;
	const description = v.description.trim();
	if (description.length > MAX_DESCRIPTION) errors.description = `A leírás legfeljebb ${MAX_DESCRIPTION} karakter lehet`;
	else if (v.type === 'expense' && !description) errors.description = 'Adj nevet a tételnek (pl. Albérlet)';

	const okAccount = (id: number | null) => id !== null && ctx.accounts.some((a) => a.id === id && !a.archived);
	if (!okAccount(v.accountId)) errors.account = v.type === 'transfer' ? 'Válaszd ki a forrásszámlát' : 'Válaszd ki a számlát';
	let categoryId: number | null = null;
	let toAccountId: number | null = null;
	if (v.type === 'transfer') {
		if (!okAccount(v.toAccountId)) errors.toAccount = 'Válaszd ki a célszámlát';
		else if (v.toAccountId === v.accountId) errors.toAccount = 'A forrás- és a célszámla nem lehet ugyanaz';
		else toAccountId = v.toAccountId;
	} else {
		const cat = ctx.categories.find((c) => c.id === v.categoryId);
		if (!cat || cat.type !== v.type || cat.archived) errors.category = 'Válassz kategóriát';
		else categoryId = cat.id;
	}

	const interval = Number(v.interval);
	if (!Number.isInteger(interval) || interval < 1 || interval > 60) errors.interval = 'Az ismétlés 1 és 60 közötti egész szám legyen';
	if (!isValidISODate(v.startDate)) errors.startDate = 'Érvénytelen kezdődátum';
	let endDate: string | null = null;
	if (v.endDate.trim()) {
		if (!isValidISODate(v.endDate)) errors.endDate = 'Érvénytelen záródátum';
		else if (isValidISODate(v.startDate) && v.endDate < v.startDate) errors.endDate = 'A záródátum nem lehet a kezdet előtt';
		else endDate = v.endDate;
	}
	const tags = parseTags(v.tags);
	if (tags.error) errors.tags = tags.error;

	if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
	return {
		ok: true,
		value: {
			type: v.type,
			amount: amount.value,
			description,
			categoryId,
			accountId: v.accountId!,
			toAccountId,
			note: v.note.trim(),
			tags: tags.tags,
			frequency: v.frequency,
			interval,
			startDate: v.startDate,
			endDate
		}
	};
}

// --- sablonok ---

export type TemplateInput = Omit<Template, 'id' | 'sortOrder' | 'createdAt' | 'updatedAt'>;

export function validateTemplateName(name: string, all: Template[], editingId?: number): string | null {
	const n = name.trim();
	if (!n) return 'Adj nevet a sablonnak';
	if (n.length > MAX_NAME) return `A név legfeljebb ${MAX_NAME} karakter lehet`;
	if (all.some((t) => t.id !== editingId && fold(t.name) === fold(n))) return 'Már van ilyen nevű sablon';
	return null;
}

// --- megtakarítási célok ---

export interface GoalFormValues {
	name: string;
	icon: string;
	color: string;
	target: string;
	saved: string;
	accountId: number | null;
	deadline: string;
}
export type GoalField = 'name' | 'target' | 'saved' | 'deadline' | 'icon' | 'color';
export type GoalInput = Omit<Goal, 'id' | 'archived' | 'sortOrder' | 'createdAt' | 'updatedAt'>;

export function validateGoal(v: GoalFormValues, all: Goal[], editingId?: number): Validated<GoalInput, GoalField> {
	const errors: Errors<GoalField> = {};
	const name = v.name.trim();
	if (!name) errors.name = 'Adj nevet a célnak';
	else if (name.length > MAX_NAME) errors.name = `A név legfeljebb ${MAX_NAME} karakter lehet`;
	else if (all.some((g) => g.id !== editingId && fold(g.name) === fold(name))) errors.name = 'Már van ilyen nevű cél';
	const target = parseAmount(v.target);
	if (!target.ok) errors.target = target.error;
	// Számlához kötött célnál az „Eddig félretéve" mező el van rejtve, ezért ott nem lehet hibát okozni vele.
	const trackedByAccount = v.accountId !== null;
	let saved = 0;
	if (v.saved.trim()) {
		const s = evaluateExpression(v.saved);
		if (!s.ok) {
			if (!trackedByAccount) errors.saved = s.error;
		} else if (s.value < 0) {
			if (!trackedByAccount) errors.saved = 'Az összeg nem lehet negatív';
		} else saved = s.value;
	}
	let deadline: string | null = null;
	if (v.deadline.trim()) {
		if (!isValidISODate(v.deadline)) errors.deadline = 'Érvénytelen dátum';
		else deadline = v.deadline;
	}
	const icon = v.icon.trim() || '🎯';
	if ([...icon].length > 4) errors.icon = 'Az ikon legfeljebb 4 karakter';
	if (!/^#[0-9a-fA-F]{6}$/.test(v.color)) errors.color = 'Érvénytelen szín';
	if (Object.keys(errors).length > 0 || !target.ok) return { ok: false, errors };
	return {
		ok: true,
		value: { name, icon, color: v.color.toLowerCase(), target: target.value, saved, accountId: v.accountId, deadline }
	};
}
