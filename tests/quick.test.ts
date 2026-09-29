import { describe, expect, it } from 'vitest';
import { knownDescriptions } from '../src/lib/queries';
import { parseQuickEntry, type QuickContext } from '../src/lib/quick';
import { accounts, categories, tx } from './fixtures';

const TODAY = '2026-09-29'; // kedd
const history = [
	tx({ id: 1, type: 'expense', amount: 890, date: '2026-09-20', description: 'Kávé', categoryId: 1, accountId: 1 }),
	tx({ id: 2, type: 'expense', amount: 9500, date: '2026-09-02', description: 'Bérlet', categoryId: 2, accountId: 2 }),
	tx({ id: 3, type: 'income', amount: 48000, date: '2026-09-05', description: 'Ösztöndíj', categoryId: 4, accountId: 2 })
];
const ctx: QuickContext = {
	today: TODAY,
	accounts: accounts.filter((a) => !a.archived),
	categories: categories.filter((c) => !c.archived),
	known: knownDescriptions(history)
};
const p = (s: string) => parseQuickEntry(s, ctx);

describe('gyorsbevitel', () => {
	it('kávé 890 tegnap', () => {
		const r = p('kávé 890 tegnap');
		expect(r).toMatchObject({ type: 'expense', amount: 890, date: '2026-09-28', description: 'Kávé', categoryId: 1, categorySource: 'known', accountId: 1, problems: [] });
	});

	it('a szavak sorrendje mindegy; a dátum alapból ma', () => {
		const r = p('890 kávé');
		expect(r).toMatchObject({ amount: 890, description: 'Kávé', date: TODAY });
		expect(p('tegnapelőtt kávé 890').date).toBe('2026-09-27');
		expect(p('kávé ma 890').date).toBe(TODAY);
	});

	it('összegformák: ezres tagolás, k, kifejezés, Ft', () => {
		expect(p('lidl 12 500').amount).toBe(12500);
		expect(p('pizza 12k').amount).toBe(12000);
		expect(p('pizza 1,5k').amount).toBe(1500);
		expect(p('menza 1200+850').amount).toBe(2050);
		expect(p('menza 2*450').amount).toBe(900);
		expect(p('menza 890 Ft').description).toBe('Menza');
		expect(p('menza 890Ft').amount).toBe(890);
	});

	it('dátumformák: hétköznap, N napja, ISO, hónapnév, pont', () => {
		expect(p('mozi 3200 péntek').date).toBe('2026-09-25'); // az utolsó péntek
		expect(p('mozi 3200 kedden').date).toBe(TODAY); // ma kedd
		expect(p('mozi 3200 múlt kedden').date).toBe('2026-09-22');
		expect(p('mozi 3200 3 napja').date).toBe('2026-09-26');
		expect(p('mozi 3200 2026-09-15').date).toBe('2026-09-15');
		expect(p('mozi 3200 szept 12').date).toBe('2026-09-12');
		expect(p('mozi 3200 szeptember 12.').date).toBe('2026-09-12');
		expect(p('mozi 3200 12 aug').date).toBe('2026-08-12');
		expect(p('mozi 3200 09.12.').date).toBe('2026-09-12');
		expect(p('mozi 3200 2026.09.10.').date).toBe('2026-09-10');
		expect(p('mozi 3200 dec 24').date).toBe('2025-12-24'); // a jövőbeli dátum az előző évre esik
		expect(p('mozi 3200 mozi').description).toBe('Mozi mozi');
	});

	it('a dátum nem kerül a leírásba, az ezres csoport nem keveredik a dátummal', () => {
		const r = p('sör a haverokkal 3 200 szept 12');
		expect(r).toMatchObject({ amount: 3200, date: '2026-09-12', description: 'Sör a haverokkal' });
	});

	it('bevétel: + jel, szó, ismert bevételi leírás', () => {
		expect(p('+48000 ösztöndíj')).toMatchObject({ type: 'income', amount: 48000, categoryId: 4, accountId: 2 });
		expect(p('ösztöndíj 48000')).toMatchObject({ type: 'income', categoryId: 4 });
		expect(p('zsebpénz 20000')).toMatchObject({ type: 'income' });
		expect(p('20000 apa bevétel')).toMatchObject({ type: 'income', description: 'Apa' });
		expect(p('-890 kávé').type).toBe('expense');
	});

	it('jóváírás szóval', () => {
		const r = p('visszatérítés pulóver 6000');
		expect(r).toMatchObject({ type: 'refund', amount: 6000, description: 'Pulóver' });
	});

	it('számla: név, szinonima, ragozott alak', () => {
		expect(p('kávé 890 készpénzzel').accountId).toBe(1);
		expect(p('kávé 890 kp').accountId).toBe(1);
		expect(p('kávé 890 kártyával').accountId).toBe(2);
		expect(p('kávé 890 bankkártyával').accountId).toBe(2);
		expect(p('kávé 890 kártyával').description).toBe('Kávé');
		// szó, ami csak kezdődik így, nem számla
		expect(p('készpénzfelvétel 20000').description).toBe('Készpénzfelvétel');
	});

	it('címkék', () => {
		expect(p('taxi 2500 #utazás #Haverok')).toMatchObject({ tags: ['utazás', 'haverok'], description: 'Taxi' });
	});

	it('kategória a nevéből és részleges egyezésből; üres leírásnál a kategória neve', () => {
		expect(p('közlekedés 1500')).toMatchObject({ categoryId: 2, categorySource: 'name', description: 'Közlekedés' });
		expect(p('bérlet havi 9500')).toMatchObject({ categoryId: 2, categorySource: 'known' });
		expect(p('ismeretlen dolog 500')).toMatchObject({ categoryId: null, categorySource: null });
	});

	it('hiányzó összeg és leírás jelzése', () => {
		expect(p('kávé').problems[0]).toMatch(/összeg/);
		expect(p('890').problems[0]).toMatch(/mire költöttél/);
		expect(p('').problems).toHaveLength(2);
	});

	it('nem tud rosszul elsülni furcsa bemeneten', () => {
		for (const s of ['   ', '###', '+', '-', '12 500 000', 'ma', 'szept', '0', '😀 500', 'a'.repeat(300) + ' 5']) {
			expect(() => p(s)).not.toThrow();
		}
		expect(p('12 500 000').amount).toBe(12500000);
	});
});
