/** Beviteli validáció – tiszta függvények, a felület és a tesztek is ezt használják. */
import { isValidISODate } from './dates';
import { evaluateExpression, parseAmount } from './money';
import { fold } from './text';
import {
	MAX_DESCRIPTION,
	MAX_NAME,
	MAX_NOTE,
	MAX_TAG,
	MAX_TAGS,
	type Account,
	type Category,
	type CategoryType,
	type TxInput,
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
}

export type TxField =
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
	existing?: { categoryId: number | null; accountId: number; toAccountId: number | null };
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
		const cat = ctx.categories.find((c) => c.id === v.categoryId);
		if (!cat || cat.type !== v.type) {
			errors.category = 'Válassz kategóriát';
		} else if (cat.archived && cat.id !== ctx.existing?.categoryId) {
			errors.category = 'Az archivált kategória nem használható új tételhez';
		} else {
			categoryId = cat.id;
		}
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
			tags: tags.tags
		}
	};
}

// --- kategóriák ---

export interface CategoryFormValues {
	name: string;
	type: CategoryType;
	color: string;
	icon: string;
}
export type CategoryField = 'name' | 'color' | 'icon';

export function validateCategory(
	v: CategoryFormValues,
	all: Category[],
	editingId?: number
): Validated<CategoryFormValues, CategoryField> {
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
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name, type: v.type, color: v.color.toLowerCase(), icon } };
}

// --- számlák ---

export interface AccountFormValues {
	name: string;
	initialBalance: string;
}
export type AccountField = 'name' | 'initialBalance';

export function validateAccount(
	v: AccountFormValues,
	all: Account[],
	editingId?: number
): Validated<{ name: string; initialBalance: number }, AccountField> {
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
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name, initialBalance } };
}
