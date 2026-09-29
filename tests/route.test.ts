import { describe, expect, it } from 'vitest';
import { parseHash } from '../src/lib/route.svelte';

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
