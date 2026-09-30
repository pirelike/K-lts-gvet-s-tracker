import { describe, expect, it } from 'vitest';
import {
	parseBudget,
	validateAccount,
	validateCategory,
	validateGoal,
	validateRecurring,
	validateTemplateName,
	type RecurringFormValues
} from '../src/lib/validation';
import { accounts, categories } from './fixtures';

describe('kategória havi keret', () => {
	const base = { name: 'Új', type: 'expense' as const, color: '#112233', icon: '🎁' };
	it('üres = nincs keret; szám elfogadva; hibás elutasítva; bevételnél nincs keret', () => {
		expect(parseBudget('')).toEqual({ ok: true, value: null });
		expect(parseBudget('40 000')).toEqual({ ok: true, value: 40000 });
		expect(parseBudget('12k')).toEqual({ ok: true, value: 12000 });
		expect(parseBudget('abc').ok).toBe(false);
		expect(parseBudget('0').ok).toBe(false);
		const ok = validateCategory({ ...base, monthlyBudget: '35 000' }, categories);
		expect(ok.ok && ok.value.monthlyBudget).toBe(35000);
		const bad = validateCategory({ ...base, monthlyBudget: 'sok' }, categories);
		expect(!bad.ok && bad.errors.monthlyBudget).toBeTruthy();
		const inc = validateCategory({ ...base, type: 'income', monthlyBudget: '5000' }, categories);
		expect(inc.ok && inc.value.monthlyBudget).toBeNull();
	});
});

describe('számla típusa', () => {
	it('alapból folyószámla, ismeretlen típus hiba', () => {
		const ok = validateAccount({ name: 'OTP', initialBalance: '1000' }, accounts);
		expect(ok.ok && ok.value).toEqual({ name: 'OTP', initialBalance: 1000, type: 'checking' });
		const cash = validateAccount({ name: 'Persely', initialBalance: '', type: 'cash' }, accounts);
		expect(cash.ok && cash.value.type).toBe('cash');
		const bad = validateAccount({ name: 'X', initialBalance: '', type: 'bitcoin' as never }, accounts);
		expect(bad.ok).toBe(false);
	});
});

describe('ismétlődő tétel', () => {
	const base: RecurringFormValues = {
		type: 'expense', amount: '90 000', description: 'Albérlet', categoryId: 1, accountId: 2, toAccountId: null,
		note: '', tags: '#lakás', frequency: 'monthly', interval: '1', startDate: '2026-10-05', endDate: ''
	};
	const ctx = { categories, accounts };
	const errs = (over: Partial<RecurringFormValues>) => {
		const r = validateRecurring({ ...base, ...over }, ctx);
		return r.ok ? {} : r.errors;
	};

	it('érvényes szabály', () => {
		const r = validateRecurring(base, ctx);
		expect(r.ok && r.value).toMatchObject({ type: 'expense', amount: 90000, categoryId: 1, accountId: 2, frequency: 'monthly', interval: 1, startDate: '2026-10-05', endDate: null, tags: ['lakás'] });
	});
	it('hibák', () => {
		expect(errs({ amount: '0' }).amount).toBeTruthy();
		expect(errs({ description: '' }).description).toBeTruthy();
		expect(errs({ description: '', type: 'income', categoryId: 4 }).description).toBeUndefined(); // bevételnél nem kötelező
		expect(errs({ categoryId: 4 }).category).toBeTruthy(); // bevételi kategória kiadáshoz
		expect(errs({ categoryId: 3 }).category).toBeTruthy(); // archivált
		expect(errs({ accountId: 3 }).account).toBeTruthy(); // archivált számla
		expect(errs({ interval: '0' }).interval).toBeTruthy();
		expect(errs({ interval: '1,5' }).interval).toBeTruthy();
		expect(errs({ startDate: '2026-02-30' }).startDate).toBeTruthy();
		expect(errs({ endDate: '2026-01-01' }).endDate).toBeTruthy();
		expect(errs({ endDate: '2027-01-01' })).toEqual({});
	});
	it('átvezetés: célszámla kell, más mint a forrás; nincs kategória', () => {
		expect(errs({ type: 'transfer', toAccountId: null }).toAccount).toBeTruthy();
		expect(errs({ type: 'transfer', toAccountId: 2 }).toAccount).toMatch(/nem lehet ugyanaz/);
		const r = validateRecurring({ ...base, type: 'transfer', categoryId: null, toAccountId: 1, description: '' }, ctx);
		expect(r.ok && r.value).toMatchObject({ type: 'transfer', categoryId: null, toAccountId: 1 });
	});
});

describe('cél és sablon', () => {
	it('cél: kötelező név és összeg, opcionális határidő', () => {
		const ok = validateGoal({ name: 'Laptop', icon: '💻', color: '#3b82f6', target: '300 000', saved: '', accountId: null, deadline: '2027-01-01' }, []);
		expect(ok.ok && ok.value).toMatchObject({ name: 'Laptop', target: 300000, saved: 0, deadline: '2027-01-01' });
		const bad = validateGoal({ name: '', icon: '', color: 'piros', target: '0', saved: '-5', accountId: null, deadline: 'holnap' }, []);
		expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['color', 'deadline', 'name', 'saved', 'target']);
		const dup = validateGoal({ name: 'laptop', icon: '', color: '#3b82f6', target: '5', saved: '', accountId: null, deadline: '' }, [{ id: 1, name: 'Laptop', icon: '', color: '#000000', target: 1, saved: 0, accountId: null, deadline: null, archived: false, sortOrder: 1, createdAt: 1, updatedAt: 1 }]);
		expect(!dup.ok && dup.errors.name).toMatch(/Már van/);
	});
	it('számlához kötött célnál a rejtett „eddig félretéve" mező hibás értéke nem akadályoz', () => {
		const base = { name: 'Nyaralás', icon: '', color: '#3b82f6', target: '1000', deadline: '' };
		const tracked = validateGoal({ ...base, saved: 'abc', accountId: 3 }, []);
		expect(tracked.ok && tracked.value).toMatchObject({ saved: 0, accountId: 3 });
		const negative = validateGoal({ ...base, saved: '-5', accountId: 3 }, []);
		expect(negative.ok && negative.value.saved).toBe(0);
		const manual = validateGoal({ ...base, saved: 'abc', accountId: null }, []);
		expect(!manual.ok && manual.errors.saved).toBeTruthy();
	});
	it('sablon neve', () => {
		expect(validateTemplateName('', [])).toBeTruthy();
		expect(validateTemplateName('Kávé', [])).toBeNull();
		expect(validateTemplateName('kavé', [{ id: 1, name: 'Kávé' } as never])).toMatch(/Már van/);
		expect(validateTemplateName('Kávé', [{ id: 1, name: 'Kávé' } as never], 1)).toBeNull(); // önmagával nem ütközik
	});
});
