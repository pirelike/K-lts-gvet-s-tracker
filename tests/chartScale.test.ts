import { describe, expect, it } from 'vitest';
import { niceTicks } from '../src/lib/chartScale';

describe('niceTicks', () => {
	it('kerek lépésköz, a maximumot lefedi', () => {
		const t = niceTicks(95000);
		expect(t[0]).toBe(0);
		expect(t[t.length - 1]).toBeGreaterThanOrEqual(95000);
		expect(t.length).toBeLessThanOrEqual(7);
		const steps = new Set(t.slice(1).map((v, i) => v - t[i]));
		expect(steps.size).toBe(1);
		expect(niceTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
		expect(niceTicks(95000)).toEqual([0, 25000, 50000, 75000, 100000]);
		expect(niceTicks(0)).toEqual([0, 1]);
		expect(niceTicks(7)[niceTicks(7).length - 1]).toBeGreaterThanOrEqual(7);
	});
});
