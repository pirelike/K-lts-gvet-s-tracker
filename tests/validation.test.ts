import { describe, expect, it } from 'vitest';
import { parseTags, validateAccount, validateCategory, validateTx, type TxFormValues } from '../src/lib/validation';
import { accounts, categories } from './fixtures';

const base: TxFormValues = {
	type: 'expense',
	amount: '890',
	date: '2026-09-29',
	description: 'Kávé',
	categoryId: 1,
	accountId: 1,
	toAccountId: null,
	note: '',
	tags: ''
};
const ctx = { categories, accounts };

describe('validateTx', () => {
	it('érvényes kiadás', () => {
		const r = validateTx({ ...base, amount: '1200+850', tags: '#Nyaralás, egyetem' }, ctx);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.amount).toBe(2050);
			expect(r.value.tags).toEqual(['nyaralás', 'egyetem']);
			expect(r.value.toAccountId).toBeNull();
		}
	});

	it('kiadásnál kötelező a leírás, bevételnél nem', () => {
		const e = validateTx({ ...base, description: '  ' }, ctx);
		expect(e.ok).toBe(false);
		if (!e.ok) expect(e.errors.description).toBeTruthy();
		const i = validateTx({ ...base, type: 'income', categoryId: 4, description: '' }, ctx);
		expect(i.ok).toBe(true);
	});

	it('az összeg mindig pozitív', () => {
		for (const amount of ['0', '-100', '100-200', '', 'abc']) {
			const r = validateTx({ ...base, amount }, ctx);
			expect(r.ok, amount).toBe(false);
		}
	});

	it('rossz dátum', () => {
		const r = validateTx({ ...base, date: '2026-02-30' }, ctx);
		expect(r.ok).toBe(false);
	});

	it('a kategória típusának egyeznie kell a tétel típusával', () => {
		const r = validateTx({ ...base, categoryId: 4 }, ctx); // bevételi kategória kiadáshoz
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.category).toBeTruthy();
	});

	it('archivált kategória új tételhez nem, meglévő tétel szerkesztésénél igen', () => {
		expect(validateTx({ ...base, categoryId: 3 }, ctx).ok).toBe(false);
		const edit = { ...ctx, existing: { categoryId: 3, accountId: 1, toAccountId: null } };
		expect(validateTx({ ...base, categoryId: 3 }, edit).ok).toBe(true);
	});

	it('archivált számla új tételhez nem használható', () => {
		expect(validateTx({ ...base, accountId: 3 }, ctx).ok).toBe(false);
	});

	it('átvezetés: két különböző számla, kategória nélkül', () => {
		const ok = validateTx({ ...base, type: 'transfer', description: '', categoryId: 1, accountId: 1, toAccountId: 2 }, ctx);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.value.categoryId).toBeNull();
			expect(ok.value.toAccountId).toBe(2);
		}
		const same = validateTx({ ...base, type: 'transfer', accountId: 1, toAccountId: 1 }, ctx);
		expect(same.ok).toBe(false);
		const none = validateTx({ ...base, type: 'transfer', accountId: 1, toAccountId: null }, ctx);
		expect(none.ok).toBe(false);
	});

	it('hosszú leírás és megjegyzés elutasítva', () => {
		expect(validateTx({ ...base, description: 'x'.repeat(201) }, ctx).ok).toBe(false);
		expect(validateTx({ ...base, note: 'x'.repeat(2001) }, ctx).ok).toBe(false);
	});
});

describe('parseTags', () => {
	it('szétválaszt, kisbetűsít, deduplikál', () => {
		expect(parseTags('#Nyaralás #egyetem, nyaralás;  Kávé').tags).toEqual(['nyaralás', 'egyetem', 'kávé']);
		expect(parseTags('').tags).toEqual([]);
	});
	it('korlátok', () => {
		expect(parseTags('a'.repeat(31)).error).toBeTruthy();
		expect(parseTags('a b c d e f g h i j k').error).toBeTruthy();
	});
});

describe('validateCategory / validateAccount', () => {
	it('egyedi név típuson belül, ékezet- és kisbetű-függetlenül', () => {
		const dup = validateCategory({ name: 'etel', type: 'expense', color: '#112233', icon: '' }, categories);
		expect(dup.ok).toBe(false);
		// ugyanaz a név másik típusban rendben van
		const other = validateCategory({ name: 'Étel', type: 'income', color: '#112233', icon: '' }, categories);
		expect(other.ok).toBe(true);
		// saját magával nem ütközik szerkesztéskor
		const self = validateCategory({ name: 'Étel', type: 'expense', color: '#112233', icon: '' }, categories, 1);
		expect(self.ok).toBe(true);
	});
	it('szín ellenőrzés', () => {
		expect(validateCategory({ name: 'Új', type: 'expense', color: 'piros', icon: '' }, categories).ok).toBe(false);
	});
	it('számla: név egyedi, kezdőegyenleg lehet negatív vagy üres', () => {
		expect(validateAccount({ name: 'készpénz', initialBalance: '' }, accounts).ok).toBe(false);
		const neg = validateAccount({ name: 'Hitelkeret', initialBalance: '-20k' }, accounts);
		expect(neg.ok && neg.value.initialBalance).toBe(-20000);
		const empty = validateAccount({ name: 'Új', initialBalance: '' }, accounts);
		expect(empty.ok && empty.value.initialBalance).toBe(0);
		expect(validateAccount({ name: 'Új', initialBalance: 'xx' }, accounts).ok).toBe(false);
	});
});
