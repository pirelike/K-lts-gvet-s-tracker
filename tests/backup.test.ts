import { describe, expect, it } from 'vitest';
import { BACKUP_VERSION, isEncryptedBackup, makeBackup, parseBackup } from '../src/lib/db/backup';
import { decryptBackup, encryptBackup, passwordError } from '../src/lib/db/crypto';
import { accounts, categories, tx } from './fixtures';

/** Egy valódi 1-es verziójú mentés (ahogy az első kiadás írta) – a régi mentések betölthetőségének védelme. */
const V1 = JSON.stringify({
	app: 'koltsegvetes-tracker',
	version: 1,
	exportedAt: '2026-08-01T10:00:00.000Z',
	accounts: [
		{ id: 1, name: 'Készpénz', initialBalance: 1000, archived: false, sortOrder: 1, createdAt: 1 },
		{ id: 2, name: 'Megtakarítás', initialBalance: 0, archived: false, sortOrder: 2, createdAt: 2 }
	],
	categories: [
		{ id: 1, name: 'Étel', type: 'expense', color: '#f97316', icon: '🍽️', monthlyBudget: 30000, archived: false, sortOrder: 1, createdAt: 1 },
		{ id: 2, name: 'Ösztöndíj', type: 'income', color: '#16a34a', icon: '🎓', monthlyBudget: null, archived: false, sortOrder: 1, createdAt: 2 }
	],
	transactions: [
		{ id: 1, type: 'expense', amount: 890, date: '2026-07-28', description: 'Kávé', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: ['egyetem'], createdAt: 1, updatedAt: 1 },
		{ id: 2, type: 'income', amount: 48000, date: '2026-07-05', description: 'Ösztöndíj', categoryId: 2, accountId: 1, toAccountId: null, note: '', tags: [], createdAt: 2, updatedAt: 2 }
	]
});

describe('mentés: régi verziók betöltése', () => {
	it('az 1-es verziójú mentés betöltődik, és az újabb mezők alapértékeket kapnak', () => {
		const r = parseBackup(V1);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const b = r.backup;
		expect(b.version).toBe(BACKUP_VERSION);
		expect(b.prefs).toEqual({ currency: 'HUF', totalBudget: null });
		expect(b.accounts.map((a) => a.type)).toEqual(['cash', 'savings']); // névből következtetve
		expect(b.categories[0].monthlyBudget).toBe(30000); // a régi keret megmarad
		expect(b.transactions).toHaveLength(2);
		expect(b.recurring).toEqual([]);
		expect(b.templates).toEqual([]);
		expect(b.goals).toEqual([]);
		expect(b.filters).toEqual([]);
	});

	it('az 1-es verziójú mentés rekordjai updatedAt-et kapnak (= createdAt)', () => {
		const r = parseBackup(V1);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.backup.accounts.map((a) => [a.createdAt, a.updatedAt])).toEqual([[1, 1], [2, 2]]);
		expect(r.backup.categories.map((c) => c.updatedAt)).toEqual([1, 2]);
		expect(r.backup.transactions.map((t) => t.updatedAt)).toEqual([1, 2]); // a tranzakcióké már megvolt
	});

	it('a 2-es verziójú mentés minden rekordtípusa updatedAt-et kap; a meglévő érték megmarad', () => {
		const v2 = {
			app: 'koltsegvetes-tracker',
			version: 2,
			exportedAt: '2026-09-01T10:00:00.000Z',
			prefs: { currency: 'HUF', totalBudget: null },
			accounts: [{ id: 1, name: 'Készpénz', type: 'cash', initialBalance: 0, archived: false, sortOrder: 1, createdAt: 5 }],
			categories: [{ id: 1, name: 'Étel', type: 'expense', color: '#f97316', icon: '', monthlyBudget: null, archived: false, sortOrder: 1, createdAt: 6, updatedAt: 60 }],
			transactions: [],
			recurring: [{ id: 1, type: 'expense', amount: 1, description: 'x', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], frequency: 'weekly', interval: 1, startDate: '2026-09-07', endDate: null, lastHandled: null, active: true, createdAt: 7 }],
			templates: [{ id: 1, name: 'Kávé', type: 'expense', amount: null, description: '', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], sortOrder: 1, createdAt: 8 }],
			goals: [{ id: 1, name: 'Laptop', icon: '', color: '#000000', target: 5, saved: 0, accountId: null, deadline: null, archived: false, sortOrder: 1, createdAt: 9 }],
			filters: [{ id: 1, name: 'f', query: 'q=a', createdAt: 10 }]
		};
		const r = parseBackup(JSON.stringify(v2));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const b = r.backup;
		expect(b.version).toBe(3);
		expect(b.accounts[0].updatedAt).toBe(5);
		expect(b.categories[0].updatedAt).toBe(60);
		expect(b.recurring[0].updatedAt).toBe(7);
		expect(b.templates[0].updatedAt).toBe(8);
		expect(b.goals[0].updatedAt).toBe(9);
		expect(b.filters[0].updatedAt).toBe(10);
	});

	it('ismeretlen (újabb) verziót nem próbál betölteni', () => {
		const future = JSON.stringify({ ...JSON.parse(V1), version: BACKUP_VERSION + 1 });
		const r = parseBackup(future);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe('Ismeretlen mentésverzió');
		expect(parseBackup(JSON.stringify({ ...JSON.parse(V1), version: 0 })).ok).toBe(false);
	});
});

describe('mentés: 2-es verzió', () => {
	const full = () => {
		const txs = [
			tx({ id: 1, type: 'expense', amount: 5000, date: '2026-09-10', description: 'Lidl', categoryId: 1, splits: [{ categoryId: 1, amount: 3000 }, { categoryId: 2, amount: 2000 }] }),
			tx({ id: 2, type: 'refund', amount: 2000, date: '2026-09-12', description: 'Visszavitt', categoryId: 1 }),
			tx({ id: 3, type: 'expense', amount: 1500, date: '2026-09-15', description: 'Spotify', recurringId: 7 })
		];
		return makeBackup({
			prefs: { currency: 'EUR', totalBudget: 120000 },
			accounts,
			categories,
			transactions: txs,
			recurring: [{ id: 7, type: 'expense', amount: 1500, description: 'Spotify', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], frequency: 'monthly', interval: 1, startDate: '2026-08-15', endDate: null, lastHandled: '2026-09-15', active: true, createdAt: 1, updatedAt: 1 }],
			templates: [{ id: 1, name: 'Kávé', type: 'expense', amount: 890, description: 'Kávé', categoryId: 1, accountId: 1, toAccountId: null, note: '', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 }],
			goals: [{ id: 1, name: 'Laptop', icon: '💻', color: '#3b82f6', target: 300000, saved: 20000, accountId: 2, deadline: '2027-01-01', archived: false, sortOrder: 1, createdAt: 1, updatedAt: 1 }],
			filters: [{ id: 1, name: 'Kávék', query: 'q=kave', createdAt: 1, updatedAt: 1 }]
		});
	};

	it('kiírás → beolvasás ugyanazt adja (minden entitással)', () => {
		const b = full();
		const r = parseBackup(JSON.stringify(b));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.backup.prefs).toEqual({ currency: 'EUR', totalBudget: 120000 });
		expect(r.backup.transactions[0].splits).toEqual([{ categoryId: 1, amount: 3000 }, { categoryId: 2, amount: 2000 }]);
		expect(r.backup.transactions[1].type).toBe('refund');
		expect(r.backup.transactions[2].recurringId).toBe(7);
		expect(r.backup.recurring[0].lastHandled).toBe('2026-09-15');
		expect(r.backup.templates[0].name).toBe('Kávé');
		expect(r.backup.goals[0].accountId).toBe(2);
		expect(r.backup.filters[0].query).toBe('q=kave');
	});

	const mutate = (fn: (b: ReturnType<typeof full>) => void) => {
		const b = full();
		fn(b);
		return parseBackup(JSON.stringify(b));
	};

	it('hibás felosztást, jóváírást és ismétlődőt visszautasít', () => {
		expect(mutate((b) => (b.transactions[0].splits![0].amount = 1)).ok).toBe(false); // összeg nem egyezik
		expect(mutate((b) => (b.transactions[0].splits = [{ categoryId: 1, amount: 5000 }])).ok).toBe(false); // 1 rész
		expect(mutate((b) => (b.transactions[0].splits![1].categoryId = 4)).ok).toBe(false); // bevételi kategória
		expect(mutate((b) => (b.transactions[1].categoryId = 4)).ok).toBe(false); // jóváírás bevételi kategóriával
		expect(mutate((b) => (b.recurring[0].frequency = 'daily' as never)).ok).toBe(false);
		expect(mutate((b) => (b.recurring[0].accountId = 99)).ok).toBe(false);
		expect(mutate((b) => (b.prefs.currency = 'XXX')).ok).toBe(false);
		expect(mutate((b) => (b.goals[0].target = 0)).ok).toBe(false);
	});

	it('a sablon és a cél megszűnt hivatkozását kiüríti, nem utasítja el', () => {
		const r = mutate((b) => {
			b.templates[0].categoryId = 99;
			b.goals[0].accountId = 99;
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.backup.templates[0].categoryId).toBeNull();
			expect(r.backup.goals[0].accountId).toBeNull();
		}
	});
});

describe('jelszavas mentés', () => {
	it('titkosítás → visszafejtés ugyanazt adja; a fájlban nincs olvasható adat', async () => {
		const json = JSON.stringify(makeBackup({ accounts, categories, transactions: [tx({ type: 'expense', amount: 4242, date: '2026-09-01', description: 'Titkos vásárlás' })] }));
		const enc = await encryptBackup(json, 'helyes-jelszo');
		expect(enc).not.toContain('Titkos');
		expect(enc).not.toContain('4242');
		expect(isEncryptedBackup(enc)).toBe(true);
		expect(isEncryptedBackup(json)).toBe(false);
		const dec = await decryptBackup(enc, 'helyes-jelszo');
		expect(dec.ok).toBe(true);
		if (dec.ok) expect(dec.json).toBe(json);
		// a sima beolvasó jelzi, hogy jelszó kell
		const r = parseBackup(enc);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.encrypted).toBe(true);
	}, 20000);

	it('rossz jelszóval és módosított fájllal hibát ad', async () => {
		const enc = await encryptBackup('{"x":1}', 'helyes-jelszo');
		const bad = await decryptBackup(enc, 'rossz-jelszo');
		expect(bad.ok).toBe(false);
		const env = JSON.parse(enc);
		env.data = env.data.slice(0, -4) + 'AAAA';
		expect((await decryptBackup(JSON.stringify(env), 'helyes-jelszo')).ok).toBe(false);
		expect((await decryptBackup('nem json', 'x')).ok).toBe(false);
		expect((await decryptBackup('{"app":"masik"}', 'x')).ok).toBe(false);
	}, 20000);

	it('két titkosítás eltér (véletlen só és IV)', async () => {
		const a = JSON.parse(await encryptBackup('{}', 'jelszo-1234'));
		const b = JSON.parse(await encryptBackup('{}', 'jelszo-1234'));
		expect(a.kdf.salt).not.toBe(b.kdf.salt);
		expect(a.cipher.iv).not.toBe(b.cipher.iv);
	}, 20000);

	it('jelszó hossza', () => {
		expect(passwordError('rovid')).toBeTruthy();
		expect(passwordError('elegendo-hosszu')).toBeNull();
	});
});
