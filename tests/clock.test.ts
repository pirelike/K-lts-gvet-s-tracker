import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock } from '../src/lib/clock.svelte';

afterEach(() => vi.useRealTimers());

describe('reaktív „ma"', () => {
	it('a következő napra lépéskor frissül, hónapfordulón a hónap is', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0));
		clock.refresh();
		expect(clock.today).toBe('2026-09-30');
		expect(clock.month).toBe('2026-09');
		// a háttérből visszahozott app: az idő közben átlépett a következő hónapba
		vi.setSystemTime(new Date(2026, 9, 1, 0, 0, 5));
		clock.refresh();
		expect(clock.today).toBe('2026-10-01');
		expect(clock.month).toBe('2026-10');
	});

	it('ugyanazon a napon nem változik', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 30, 8, 0, 0));
		clock.refresh();
		const before = clock.today;
		vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 0));
		clock.refresh();
		expect(clock.today).toBe(before);
	});
});
