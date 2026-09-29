import { describe, expect, it } from 'vitest';
import { parseHash, viewTransitionKind } from '../src/lib/route.svelte';

describe('parseHash', () => {
	it('útvonal és lekérdezés', () => {
		expect(parseHash('')).toEqual({ path: '/', query: '' });
		expect(parseHash('#/')).toEqual({ path: '/', query: '' });
		expect(parseHash('#/new')).toEqual({ path: '/new', query: '' });
		expect(parseHash('#/transactions?q=kave&type=expense')).toEqual({
			path: '/transactions',
			query: 'q=kave&type=expense'
		});
		expect(parseHash('#/transactions/12?back=x')).toEqual({ path: '/transactions/12', query: 'back=x' });
		expect(parseHash('#?month=2026-09')).toEqual({ path: '/', query: 'month=2026-09' });
	});
});

describe('viewTransitionKind', () => {
	const cur = '2026-09';
	it('másik képernyő → áttűnés', () => {
		expect(viewTransitionKind('#/', '#/transactions', cur)).toBe('page');
		expect(viewTransitionKind('#/transactions', '#/transactions/12', cur)).toBe('page');
		expect(viewTransitionKind('', '#/new', cur)).toBe('page');
	});
	it('hónapváltás → csúszás a lapozás irányába', () => {
		expect(viewTransitionKind('#/?month=2026-09', '#/?month=2026-10', cur)).toBe('month-next');
		expect(viewTransitionKind('#/?month=2026-09', '#/?month=2026-08', cur)).toBe('month-prev');
		expect(viewTransitionKind('#/?month=2025-12', '#/?month=2026-01', cur)).toBe('month-next');
		// ?month nélkül a mai hónap látszik
		expect(viewTransitionKind('#/', '#/?month=2026-08', cur)).toBe('month-prev');
		expect(viewTransitionKind('#/transactions?month=2026-08&period=month', '#/transactions?period=month', cur)).toBe('month-next');
	});
	it('keresés, szűrés, azonos hónap → nincs átmenet', () => {
		expect(viewTransitionKind('#/transactions', '#/transactions?q=kave', cur)).toBeNull();
		expect(viewTransitionKind('#/transactions?type=expense', '#/transactions?type=income', cur)).toBeNull();
		expect(viewTransitionKind('#/', '#/?month=2026-09', cur)).toBeNull();
		expect(viewTransitionKind('#/?month=hibas', '#/', cur)).toBeNull();
	});
});
