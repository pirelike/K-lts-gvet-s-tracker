import { describe, expect, it } from 'vitest';
import { dueReminders, minutesOfDay } from '../src/lib/notify';
import { isTypingTarget, resolveShortcut, type KeyLike } from '../src/lib/shortcuts';
import { DEFAULT_REMINDERS } from '../src/lib/auth.svelte';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('billentyűparancsok', () => {
	it('egybetűs gyorsgombok', () => {
		expect(resolveShortcut(key('n'), null).action).toEqual({ type: 'go', path: '/new' });
		expect(resolveShortcut(key('N'), null).action).toEqual({ type: 'go', path: '/new' });
		expect(resolveShortcut(key('/'), null).action).toEqual({ type: 'search' });
		expect(resolveShortcut(key('?'), null).action).toEqual({ type: 'help' });
		expect(resolveShortcut(key('['), null).action).toEqual({ type: 'month', delta: -1 });
		expect(resolveShortcut(key(']'), null).action).toEqual({ type: 'month', delta: 1 });
		expect(resolveShortcut(key('x'), null)).toEqual({ action: null, pending: null });
	});

	it('g + betű váltás; érvénytelen második billentyű eldobja a láncot', () => {
		const first = resolveShortcut(key('g'), null);
		expect(first).toEqual({ action: null, pending: 'g' });
		expect(resolveShortcut(key('t'), first.pending)).toEqual({ action: { type: 'go', path: '/transactions' }, pending: null });
		expect(resolveShortcut(key('l'), 'g').action).toEqual({ type: 'lock' });
		expect(resolveShortcut(key('z'), 'g')).toEqual({ action: null, pending: null });
		// lánc közben az „n" már nem új tétel
		expect(resolveShortcut(key('n'), 'g').action).toBeNull();
	});

	it('módosítóval nyomott billentyűt nem vesz el (Ctrl+N, Cmd+G böngészőparancsok)', () => {
		expect(resolveShortcut(key('n', { ctrlKey: true }), null)).toEqual({ action: null, pending: null });
		expect(resolveShortcut(key('g', { metaKey: true }), null)).toEqual({ action: null, pending: null });
		expect(resolveShortcut(key('t', { altKey: true }), 'g')).toEqual({ action: null, pending: null });
	});

	it('beviteli mezőben nem aktív', () => {
		expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
		expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
		expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
		expect(isTypingTarget({ tagName: 'A' } as unknown as EventTarget)).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
	});
});

describe('emlékeztetők', () => {
	const base = {
		settings: { ...DEFAULT_REMINDERS, enabled: true, dailyTime: '20:00' },
		now: new Date(2026, 8, 29, 21, 0),
		today: '2026-09-29',
		hasTxToday: false as boolean | null,
		dueCount: 0,
		budgetAlerts: [] as { key: string; name: string; over: boolean }[],
		needsBackup: false,
		sent: new Set<string>()
	};

	it('időpont értelmezése', () => {
		expect(minutesOfDay('20:00')).toBe(1200);
		expect(minutesOfDay('7:05')).toBe(425);
		expect(minutesOfDay('24:00')).toBeNull();
		expect(minutesOfDay(null)).toBeNull();
		expect(minutesOfDay('abc')).toBeNull();
	});

	it('napi emlékeztető: az idő után, naponta egyszer, ha nincs még mai tétel', () => {
		expect(dueReminders(base).map((r) => r.key)).toEqual(['daily:2026-09-29']);
		expect(dueReminders({ ...base, now: new Date(2026, 8, 29, 19, 59) })).toEqual([]);
		expect(dueReminders({ ...base, hasTxToday: true })).toEqual([]);
		expect(dueReminders({ ...base, hasTxToday: null }).length).toBe(1); // zárolt: nem tudjuk, jelzünk
		expect(dueReminders({ ...base, sent: new Set(['daily:2026-09-29']) })).toEqual([]);
	});

	it('kikapcsolva semmi nem jön', () => {
		expect(dueReminders({ ...base, settings: { ...base.settings, enabled: false }, dueCount: 3 })).toEqual([]);
	});

	it('esedékes tételek, keret, mentés – mindegyik egyszer, a saját kapcsolója szerint', () => {
		const r = dueReminders({
			...base,
			hasTxToday: true,
			dueCount: 2,
			budgetAlerts: [{ key: 'budget:2026-09:3:warn', name: 'Étel', over: false }, { key: 'budget:2026-09:total:over', name: 'Összes kiadás', over: true }],
			needsBackup: true
		});
		expect(r.map((x) => x.key)).toEqual(['due:2026-09-29:2', 'budget:2026-09:3:warn', 'budget:2026-09:total:over', 'backup:2026-09']);
		expect(r[1].body).toContain('80%');
		expect(r[2].title).toMatch(/Túllépted/);
		const off = dueReminders({ ...base, hasTxToday: true, dueCount: 2, needsBackup: true, budgetAlerts: [{ key: 'k', name: 'x', over: true }], settings: { ...base.settings, due: false, budget: false, backup: false } });
		expect(off).toEqual([]);
		const again = dueReminders({ ...base, hasTxToday: true, dueCount: 2, sent: new Set(['due:2026-09-29:2']) });
		expect(again).toEqual([]);
		// ha időközben új tétel vált esedékessé, újra jelez
		expect(dueReminders({ ...base, hasTxToday: true, dueCount: 3, sent: new Set(['due:2026-09-29:2']) })).toHaveLength(1);
	});
});
