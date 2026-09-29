/**
 * Példaadatok egy egyetemista költségvetéséről. A dátumok a mai naphoz igazodnak
 * (az elmúlt ~3 hónap), a generálás determinisztikus – így tesztelhető.
 */
import { addDays, monthOf, shiftMonth } from '../dates';
import type { Account, Category, Transaction } from '../types';

type DemoTx = Omit<Transaction, 'id'>;

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

const round10 = (n: number) => Math.round(n / 10) * 10;

export function generateDemoTransactions(
	today: string,
	accounts: readonly Account[],
	categories: readonly Category[],
	seed = 42
): DemoTx[] {
	const rand = rng(seed);
	const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
	const range = (lo: number, hi: number) => round10(lo + rand() * (hi - lo));

	const acc = (name: string) => accounts.find((a) => a.name === name)?.id;
	const cash = acc('Készpénz');
	const card = acc('Bankkártya');
	const savings = acc('Megtakarítás');
	const cat = (type: 'income' | 'expense', name: string) =>
		categories.find((c) => c.type === type && c.name === name)?.id;
	if (cash == null || card == null || savings == null) return [];

	const out: DemoTx[] = [];
	const push = (
		date: string,
		type: 'income' | 'expense',
		catName: string,
		description: string,
		amount: number,
		accountId: number,
		tags: string[] = []
	) => {
		const categoryId = cat(type, catName);
		if (categoryId == null || date > today || amount <= 0) return;
		out.push({
			type,
			amount,
			date,
			description,
			categoryId,
			accountId,
			toAccountId: null,
			note: '',
			tags,
			demo: true,
			createdAt: 0,
			updatedAt: 0
		});
	};

	const transfer = (date: string, amount: number, from: number, to: number, description: string) => {
		if (date > today) return;
		out.push({
			type: 'transfer', amount, date, description, categoryId: null, accountId: from,
			toAccountId: to, note: '', tags: [], demo: true, createdAt: 0, updatedAt: 0
		});
	};

	// Nyitó egyenleg: a demó időszak elején már van pénz a számlákon, így nem mennek negatívba.
	const openDate = `${shiftMonth(monthOf(today), -2)}-01`;
	push(openDate, 'income', 'Egyéb', 'Áthozott megtakarítás', 220000, card);
	push(openDate, 'income', 'Egyéb', 'Áthozott készpénz', 20000, cash);

	const thisMonth = monthOf(today);
	for (const m of [shiftMonth(thisMonth, -2), shiftMonth(thisMonth, -1), thisMonth]) {
		transfer(`${m}-01`, 45000, card, cash, 'Készpénzfelvétel');
		push(`${m}-05`, 'income', 'Ösztöndíj', 'Tanulmányi ösztöndíj', 48000, card);
		push(`${m}-08`, 'income', 'Családtól', 'Zsebpénz otthonról', 30000, card);
		push(`${m}-03`, 'expense', 'Lakhatás/kollégium', 'Kollégiumi díj', 22000, card);
		push(`${m}-02`, 'expense', 'Közlekedés', 'Havi bérlet', 9500, card);
		push(`${m}-12`, 'expense', 'Előfizetések', 'Spotify', 1490, card, ['előfizetés']);
		push(`${m}-14`, 'expense', 'Előfizetések', 'Netflix', 3490, card, ['előfizetés']);
		if (m.endsWith('-11') || m.endsWith('-12') || m.endsWith('-01')) {
			push(`${m}-20`, 'income', 'Fizetés/munka', 'Diákmunka', 56000, card);
		}
	}

	for (let date = openDate; date <= today; date = addDays(date, 1)) {
		const [y, mo, d] = date.split('-').map(Number);
		const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = vasárnap
		const weekend = weekday === 0 || weekday === 6;
		if (!weekend) {
			push(date, 'expense', 'Étel', 'Egyetemi menza', pick([1190, 1290, 1390]), cash);
			if (rand() < 0.45) push(date, 'expense', 'Étel', 'Kávé', range(690, 990), cash);
		}
		if (rand() < 0.16) push(date, 'expense', 'Étel', 'Lidl', range(2500, 7800), card);
		if (rand() < 0.05) push(date, 'expense', 'Étel', 'Pizza', range(2200, 3400), card);
		if (rand() < 0.04) push(date, 'expense', 'Szórakozás', pick(['Mozi', 'Sör a haverokkal', 'Koncertjegy']), range(1800, 6500), card);
		if (rand() < 0.03) push(date, 'expense', 'Tanulás', pick(['Jegyzet nyomtatás', 'Tankönyv', 'Toll, füzet']), range(900, 9500), card, ['egyetem']);
		if (rand() < 0.02) push(date, 'expense', 'Egészség', 'Gyógyszertár', range(1200, 4800), card);
		if (rand() < 0.015) push(date, 'expense', 'Ruházat', pick(['Póló', 'Cipő', 'Farmer']), range(4990, 19990), card);
	}

	// Kirándulás címkével – a címke-szűrés kipróbálásához.
	push(addDays(today, -20), 'expense', 'Közlekedés', 'Vonatjegy Balatonra', 3800, card, ['nyaralás']);
	push(addDays(today, -19), 'expense', 'Szórakozás', 'Strandbelépő', 2900, cash, ['nyaralás']);
	push(addDays(today, -19), 'expense', 'Étel', 'Lángos a strandon', 1800, cash, ['nyaralás']);

	// Átvezetés a kártyáról a megtakarításba.
	transfer(addDays(today, -12), 15000, card, savings, 'Nyaralásra félretéve');

	out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const base = Date.now();
	out.forEach((t, i) => {
		t.createdAt = base + i;
		t.updatedAt = base + i;
	});
	return out;
}
