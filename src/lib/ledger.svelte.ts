/**
 * A memóriában tartott főkönyv (számlák, kategóriák, tranzakciók, ismétlődők, sablonok, célok,
 * mentett szűrők) Svelte-állapotként. Minden módosítás előbb az IndexedDB-be íródik, aztán frissül a memória.
 */
import { clock } from './clock.svelte';
import { activeCurrency, convertMinor, findCurrency, setActiveCurrency } from './currency';
import { CORRECTION_CATEGORY } from './db/defaults';
import { generateDemoTransactions } from './db/demo';
import { makeBackup } from './db/backup';
import { emptyData, type LedgerData, type LedgerRepo } from './db/repo';
import { todayISO } from './dates';
import type { ImportPlan } from './csvImport';
import { PALETTE } from './palette';
import { stamp } from './sync/stamp';
import { accountBalances, accountUsage, categoryUsage } from './queries';
import { fold } from './text';
import { dueItems, nextOccurrence } from './recurring';
import {
	DEFAULT_PREFS,
	MAX_AMOUNT,
	categoryTypeFor,
	type Account,
	type AccountType,
	type Backup,
	type Category,
	type CategoryType,
	type Goal,
	type Prefs,
	type Recurring,
	type SavedFilter,
	type Template,
	type Transaction,
	type TxInput
} from './types';
import type { AccountValues, GoalInput, RecurringInput, TemplateInput } from './validation';

export class LedgerError extends Error {}

const byOrder = <T extends { sortOrder: number; name: string }>(a: T, b: T) =>
	a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'hu');

/** A `patch` mezői a csoportos módosításhoz. */
export interface BulkPatch {
	categoryId?: number;
	accountId?: number;
	addTags?: string[];
	removeTags?: string[];
}

class Ledger {
	private repo: LedgerRepo | null = null;
	private channel: BroadcastChannel | null = null;

	accounts = $state.raw<Account[]>([]);
	categories = $state.raw<Category[]>([]);
	transactions = $state.raw<Transaction[]>([]);
	recurring = $state.raw<Recurring[]>([]);
	templates = $state.raw<Template[]>([]);
	goals = $state.raw<Goal[]>([]);
	filters = $state.raw<SavedFilter[]>([]);
	prefs = $state.raw<Prefs>(DEFAULT_PREFS);
	/** A beállítások utolsó módosításának ideje (a szinkronhoz). */
	prefsUpdatedAt = $state.raw(0);
	loaded = $state(false);

	catById = $derived(new Map(this.categories.map((c) => [c.id, c])));
	accById = $derived(new Map(this.accounts.map((a) => [a.id, a])));
	activeAccounts = $derived(this.accounts.filter((a) => !a.archived).sort(byOrder));
	hasDemo = $derived(this.transactions.some((t) => t.demo));
	/** Az esedékes (mára vagy korábbra járó) ismétlődő tételek; a „ma" reaktív. */
	due = $derived(dueItems(this.recurring, clock.today));

	/** Aktív (nem archivált) kategóriák típus szerint. */
	activeCategories(type: CategoryType): Category[] {
		return this.categories.filter((c) => c.type === type && !c.archived).sort(byOrder);
	}
	allCategories(type: CategoryType): Category[] {
		return this.categories.filter((c) => c.type === type).sort(byOrder);
	}

	attach(repo: LedgerRepo) {
		this.repo = repo;
		if (typeof BroadcastChannel !== 'undefined' && !this.channel) {
			this.channel = new BroadcastChannel('koltsegvetes-sync');
			// Másik lapon történt módosítás: újratöltjük a memóriát.
			this.channel.onmessage = () => {
				if (this.loaded) void this.load();
			};
		}
	}

	private get db(): LedgerRepo {
		if (!this.repo) throw new LedgerError('Az adatbázis nincs megnyitva');
		return this.repo;
	}

	/**
	 * Minden helyi módosítás után hívódik (a szinkronmotor ebből tudja, hogy van feltöltetlen változás).
	 * A `reloadFromDb` nem hívja: a szinkron saját átvétele nem számít helyi módosításnak.
	 */
	onChange: (() => void) | null = null;

	private notify() {
		this.channel?.postMessage('changed');
		this.onChange?.();
	}

	/** Az adatbázis tartalmának újratöltése, ha azt a szinkron írta át; a többi lapot is értesíti. */
	async reloadFromDb() {
		await this.load();
		this.channel?.postMessage('changed');
	}

	async load() {
		const data = await this.db.loadAll();
		const { prefs, updatedAt } = await this.db.getPrefs();
		setActiveCurrency(prefs.currency);
		this.prefs = prefs;
		this.prefsUpdatedAt = updatedAt;
		this.accounts = data.accounts;
		this.categories = data.categories;
		this.transactions = data.transactions;
		this.recurring = data.recurring;
		this.templates = data.templates;
		this.goals = data.goals;
		this.filters = data.filters;
		this.loaded = true;
	}

	/** Zároláskor a memóriából is kikerülnek az adatok. */
	clear() {
		this.accounts = [];
		this.categories = [];
		this.transactions = [];
		this.recurring = [];
		this.templates = [];
		this.goals = [];
		this.filters = [];
		this.loaded = false;
	}

	/** Az összes adat a mentéshez / átváltáshoz. */
	private data(): LedgerData {
		return {
			accounts: this.accounts,
			categories: this.categories,
			transactions: this.transactions,
			recurring: this.recurring,
			templates: this.templates,
			goals: this.goals,
			filters: this.filters
		};
	}

	// --- tranzakciók ---

	async addTx(input: TxInput, extra: { recurringId?: number } = {}): Promise<Transaction> {
		const now = stamp();
		const row = await this.db.add<Transaction>('transactions', {
			...input,
			tags: [...input.tags],
			...(input.splits ? { splits: input.splits.map((s) => ({ ...s })) } : {}),
			...(extra.recurringId != null ? { recurringId: extra.recurringId } : {}),
			createdAt: now,
			updatedAt: now
		});
		this.transactions = [...this.transactions, row];
		this.notify();
		return row;
	}

	async updateTx(id: number, input: TxInput): Promise<Transaction> {
		const cur = this.transactions.find((t) => t.id === id);
		if (!cur) throw new LedgerError('A tétel nem található');
		const next: Transaction = { ...cur, ...input, tags: [...input.tags], id, updatedAt: stamp() };
		// A felosztás nem öröklődik: ha az új értékben nincs, a régi is eltűnik.
		if (!input.splits) delete next.splits;
		await this.db.put('transactions', next);
		this.transactions = this.transactions.map((t) => (t.id === id ? next : t));
		this.notify();
		return next;
	}

	/** Törli a tételt, és visszaadja a pillanatképet a „Visszavonás"-hoz. */
	async deleteTx(id: number): Promise<Transaction> {
		const cur = this.transactions.find((t) => t.id === id);
		if (!cur) throw new LedgerError('A tétel nem található');
		await this.db.remove('transactions', id);
		this.transactions = this.transactions.filter((t) => t.id !== id);
		this.notify();
		return cur;
	}

	/** Több tétel törlése egyszerre (csoportos művelet); a pillanatképek a visszavonáshoz. */
	async deleteTxs(ids: number[]): Promise<Transaction[]> {
		const gone = new Set(ids);
		const snapshots = this.transactions.filter((t) => gone.has(t.id));
		if (snapshots.length === 0) return [];
		await this.db.removeMany('transactions', snapshots.map((t) => t.id));
		this.transactions = this.transactions.filter((t) => !gone.has(t.id));
		this.notify();
		return snapshots;
	}

	private refsOk(t: Transaction): boolean {
		return (
			this.accById.has(t.accountId) &&
			(t.toAccountId == null || this.accById.has(t.toAccountId)) &&
			(t.splits && t.splits.length > 0
				? t.splits.every((s) => this.catById.has(s.categoryId))
				: t.categoryId == null || this.catById.has(t.categoryId))
		);
	}

	/**
	 * Törlés visszavonása: ugyanazzal az azonosítóval visszakerül a tétel. Az `updatedAt` frissül, hogy a
	 * visszaállított tétel az összefésülésnél az újabb legyen a törlési jelölőnél.
	 */
	async restoreTx(snapshot: Transaction): Promise<void> {
		if (this.transactions.some((t) => t.id === snapshot.id)) return;
		if (!this.refsOk(snapshot)) throw new LedgerError('A tétel kategóriája vagy számlája időközben megszűnt');
		const row = { ...snapshot, updatedAt: stamp() };
		await this.db.put('transactions', row);
		this.transactions = [...this.transactions, row];
		this.notify();
	}

	async restoreTxs(snapshots: Transaction[]): Promise<number> {
		const have = new Set(this.transactions.map((t) => t.id));
		const now = stamp(snapshots.length);
		const back = snapshots
			.filter((s) => !have.has(s.id) && this.refsOk(s))
			.map((s, i) => ({ ...s, updatedAt: now + i }));
		if (back.length === 0) return 0;
		await this.db.putMany('transactions', back);
		this.transactions = [...this.transactions, ...back];
		this.notify();
		return back.length;
	}

	/**
	 * Csoportos módosítás. A nem alkalmazható tételeket kihagyja (átvezetés kategóriával, más típusú
	 * kategória, felosztott tétel kategóriával, azonos forrás- és célszámla), és megszámolja.
	 */
	async updateTxs(ids: number[], patch: BulkPatch): Promise<{ changed: number; skipped: number }> {
		const target = new Set(ids);
		const cat = patch.categoryId != null ? this.catById.get(patch.categoryId) : undefined;
		if (patch.categoryId != null && !cat) throw new LedgerError('A kategória nem található');
		if (patch.accountId != null && !this.accById.has(patch.accountId)) throw new LedgerError('A számla nem található');
		const now = stamp();
		const changedRows: Transaction[] = [];
		let skipped = 0;
		const next = this.transactions.map((t) => {
			if (!target.has(t.id)) return t;
			let row = { ...t };
			if (cat) {
				const ok = categoryTypeFor(t.type) === cat.type && !(t.splits && t.splits.length > 0);
				if (!ok) {
					skipped++;
					return t;
				}
				row.categoryId = cat.id;
			}
			if (patch.accountId != null) {
				if (t.type === 'transfer' && t.toAccountId === patch.accountId) {
					skipped++;
					return t;
				}
				row.accountId = patch.accountId;
			}
			if (patch.addTags?.length || patch.removeTags?.length) {
				const tags = new Set(row.tags);
				for (const g of patch.removeTags ?? []) tags.delete(g);
				for (const g of patch.addTags ?? []) tags.add(g);
				row.tags = [...tags].slice(0, 10);
			}
			row = { ...row, updatedAt: now };
			changedRows.push(row);
			return row;
		});
		await this.db.putMany('transactions', changedRows);
		this.transactions = next;
		this.notify();
		return { changed: changedRows.length, skipped };
	}

	/** Meglévő tételek felülírása a megadott állapotra (a csoportos módosítás visszavonása); az `updatedAt` frissül. */
	async replaceTxs(rows: Transaction[]): Promise<void> {
		const now = stamp(rows.length);
		const stamped = rows.map((r, i) => ({ ...r, updatedAt: now + i }));
		const by = new Map(stamped.map((r) => [r.id, r]));
		const present = stamped.filter((r) => this.transactions.some((t) => t.id === r.id) && this.refsOk(r));
		await this.db.putMany('transactions', present);
		this.transactions = this.transactions.map((t) => (by.has(t.id) && present.includes(by.get(t.id)!) ? by.get(t.id)! : t));
		this.notify();
	}

	/** Több tétel hozzáadása egyszerre (CSV-import). */
	async addTxs(inputs: TxInput[]): Promise<Transaction[]> {
		if (inputs.length === 0) return [];
		const now = stamp(inputs.length);
		const rows = await this.db.addMany<Transaction>(
			'transactions',
			inputs.map((input, i) => ({
				...input,
				tags: [...input.tags],
				...(input.splits ? { splits: input.splits.map((s) => ({ ...s })) } : {}),
				createdAt: now + i,
				updatedAt: now + i
			}))
		);
		this.transactions = [...this.transactions, ...rows];
		this.notify();
		return rows;
	}

	/**
	 * CSV-import végrehajtása: a hiányzó kategóriák és számlák létrejönnek (csak amit a beolvasott,
	 * nem duplikált sorok használnak), majd a tételek egyetlen tranzakcióban kerülnek be.
	 */
	async importPlan(plan: ImportPlan): Promise<{ added: number; categories: number; accounts: number }> {
		const rows = plan.rows.filter((r) => !r.duplicate);
		const accIds = new Map<string, number>();
		const catIds = new Map<string, number>();
		let newAccounts = 0;
		let newCategories = 0;

		const needAccount = (name: string) => rows.some((r) => [r.account, r.toAccount].some((a) => a && 'newName' in a && a.newName === name));
		for (const name of plan.newAccounts) {
			if (!needAccount(name)) continue;
			const key = fold(name);
			if (accIds.has(key)) continue;
			const existing = this.accounts.find((a) => fold(a.name) === key);
			const acc = existing ?? (await this.addAccount({ name: name.slice(0, 40), initialBalance: 0, type: 'checking' }));
			if (!existing) newAccounts++;
			accIds.set(key, acc.id);
		}
		for (const c of plan.newCategories) {
			const used = rows.some((r) => r.category && 'newName' in r.category && r.category.newName === c.name && r.category.type === c.type);
			if (!used) continue;
			const key = `${c.type}|${fold(c.name)}`;
			if (catIds.has(key)) continue;
			const existing = this.categories.find((x) => x.type === c.type && fold(x.name) === fold(c.name));
			const cat =
				existing ??
				(await this.addCategory(c.type, {
					name: c.name.slice(0, 40),
					color: PALETTE[(this.categories.length + newCategories) % PALETTE.length],
					icon: ''
				}));
			if (!existing) newCategories++;
			catIds.set(key, cat.id);
		}

		const accId = (ref: { id: number } | { newName: string } | null) =>
			ref === null ? null : 'id' in ref ? ref.id : (accIds.get(fold(ref.newName)) ?? null);
		const inputs: TxInput[] = [];
		for (const r of rows) {
			const accountId = accId(r.account);
			if (accountId === null) continue;
			let categoryId: number | null = null;
			if (r.category) {
				categoryId = 'id' in r.category ? r.category.id : (catIds.get(`${r.category.type}|${fold(r.category.newName)}`) ?? null);
			}
			inputs.push({ ...r.input, categoryId, accountId, toAccountId: accId(r.toAccount) });
		}
		const added = await this.addTxs(inputs);
		return { added: added.length, categories: newCategories, accounts: newAccounts };
	}

	// --- kategóriák ---

	async addCategory(
		type: CategoryType,
		v: { name: string; color: string; icon: string; monthlyBudget?: number | null }
	): Promise<Category> {
		const order = Math.max(0, ...this.categories.filter((c) => c.type === type).map((c) => c.sortOrder));
		const now = stamp();
		const row = await this.db.add<Category>('categories', {
			name: v.name,
			type,
			color: v.color,
			icon: v.icon,
			monthlyBudget: type === 'expense' ? (v.monthlyBudget ?? null) : null,
			archived: false,
			sortOrder: order + 1,
			createdAt: now,
			updatedAt: now
		});
		this.categories = [...this.categories, row];
		this.notify();
		return row;
	}

	async updateCategory(
		id: number,
		v: { name: string; color: string; icon: string; monthlyBudget?: number | null }
	) {
		const cur = this.catById.get(id);
		if (!cur) throw new LedgerError('A kategória nem található');
		const next: Category = { ...cur, name: v.name, color: v.color, icon: v.icon, updatedAt: stamp() };
		if (v.monthlyBudget !== undefined && cur.type === 'expense') next.monthlyBudget = v.monthlyBudget;
		await this.db.put('categories', next);
		this.categories = this.categories.map((c) => (c.id === id ? next : c));
		this.notify();
	}

	/** Havi keret beállítása/törlése (null). */
	async setCategoryBudget(id: number, budget: number | null) {
		const cur = this.catById.get(id);
		if (!cur) throw new LedgerError('A kategória nem található');
		if (budget != null && (!Number.isInteger(budget) || budget <= 0 || budget > MAX_AMOUNT)) {
			throw new LedgerError('A keret pozitív összeg legyen');
		}
		const next = { ...cur, monthlyBudget: budget, updatedAt: stamp() };
		await this.db.put('categories', next);
		this.categories = this.categories.map((c) => (c.id === id ? next : c));
		this.notify();
	}

	async setCategoryArchived(id: number, archived: boolean) {
		const cur = this.catById.get(id);
		if (!cur) throw new LedgerError('A kategória nem található');
		const next = { ...cur, archived, updatedAt: stamp() };
		await this.db.put('categories', next);
		this.categories = this.categories.map((c) => (c.id === id ? next : c));
		this.notify();
	}

	/** Üzleti szabály: kategória csak akkor törölhető, ha nincs hozzá tranzakció (különben archiválni kell). */
	async deleteCategory(id: number) {
		if ((categoryUsage(this.transactions, this.recurring).get(id) ?? 0) > 0) {
			throw new LedgerError('Ehhez a kategóriához vannak tételek – archiváld helyette');
		}
		await this.db.remove('categories', id);
		this.categories = this.categories.filter((c) => c.id !== id);
		// A sablonokból kiürül a megszűnt kategória (a sablon megmarad).
		const at = stamp();
		const stale = this.templates.filter((t) => t.categoryId === id).map((t) => ({ ...t, categoryId: null, updatedAt: at }));
		if (stale.length) {
			await this.db.putMany('templates', stale);
			this.templates = this.templates.map((t) => stale.find((s) => s.id === t.id) ?? t);
		}
		this.notify();
	}

	/** Felfelé/lefelé mozgatás a saját (azonos típusú, nem archivált) csoportján belül. */
	async moveCategory(id: number, dir: -1 | 1) {
		const cur = this.catById.get(id);
		if (!cur) throw new LedgerError('A kategória nem található');
		const group = this.categories.filter((c) => c.type === cur.type && !c.archived).sort(byOrder);
		const changed = reorder(group, id, dir, stamp());
		if (!changed.length) return;
		await this.db.putMany('categories', changed);
		const by = new Map(changed.map((c) => [c.id, c]));
		this.categories = this.categories.map((c) => by.get(c.id) ?? c);
		this.notify();
	}

	/** Az egyeztetés korrekciós tételeinek kategóriája: ha nincs, létrejön. */
	private async correctionCategory(type: CategoryType): Promise<Category> {
		const found = this.categories.find((c) => c.type === type && c.name === CORRECTION_CATEGORY.name);
		if (found) {
			if (found.archived) await this.setCategoryArchived(found.id, false);
			return this.catById.get(found.id)!;
		}
		return this.addCategory(type, CORRECTION_CATEGORY);
	}

	// --- számlák ---

	async addAccount(v: Pick<AccountValues, 'name' | 'initialBalance'> & { type?: AccountType }): Promise<Account> {
		const order = Math.max(0, ...this.accounts.map((a) => a.sortOrder));
		const now = stamp();
		const row = await this.db.add<Account>('accounts', {
			name: v.name,
			type: v.type ?? 'checking',
			initialBalance: v.initialBalance,
			archived: false,
			sortOrder: order + 1,
			createdAt: now,
			updatedAt: now
		});
		this.accounts = [...this.accounts, row];
		this.notify();
		return row;
	}

	async updateAccount(id: number, v: Pick<AccountValues, 'name' | 'initialBalance'> & { type?: AccountType }) {
		const cur = this.accById.get(id);
		if (!cur) throw new LedgerError('A számla nem található');
		const next = { ...cur, ...v, type: v.type ?? cur.type, updatedAt: stamp() };
		await this.db.put('accounts', next);
		this.accounts = this.accounts.map((a) => (a.id === id ? next : a));
		this.notify();
	}

	async setAccountArchived(id: number, archived: boolean) {
		const cur = this.accById.get(id);
		if (!cur) throw new LedgerError('A számla nem található');
		const next = { ...cur, archived, updatedAt: stamp() };
		await this.db.put('accounts', next);
		this.accounts = this.accounts.map((a) => (a.id === id ? next : a));
		this.notify();
	}

	async deleteAccount(id: number) {
		if ((accountUsage(this.transactions, this.recurring).get(id) ?? 0) > 0) {
			throw new LedgerError('Ehhez a számlához vannak tételek – archiváld helyette');
		}
		await this.db.remove('accounts', id);
		this.accounts = this.accounts.filter((a) => a.id !== id);
		// A célok és sablonok hivatkozása kiürül (maguk megmaradnak).
		const at = stamp();
		const goals = this.goals.filter((g) => g.accountId === id).map((g) => ({ ...g, accountId: null, updatedAt: at }));
		const templates = this.templates
			.filter((t) => t.accountId === id || t.toAccountId === id)
			.map((t) => ({
				...t,
				accountId: t.accountId === id ? null : t.accountId,
				toAccountId: t.toAccountId === id ? null : t.toAccountId,
				updatedAt: at
			}));
		if (goals.length) {
			await this.db.putMany('goals', goals);
			this.goals = this.goals.map((g) => goals.find((x) => x.id === g.id) ?? g);
		}
		if (templates.length) {
			await this.db.putMany('templates', templates);
			this.templates = this.templates.map((t) => templates.find((x) => x.id === t.id) ?? t);
		}
		this.notify();
	}

	async moveAccount(id: number, dir: -1 | 1) {
		if (!this.accById.has(id)) throw new LedgerError('A számla nem található');
		const group = this.accounts.filter((a) => !a.archived).sort(byOrder);
		const changed = reorder(group, id, dir, stamp());
		if (!changed.length) return;
		await this.db.putMany('accounts', changed);
		const by = new Map(changed.map((a) => [a.id, a]));
		this.accounts = this.accounts.map((a) => by.get(a.id) ?? a);
		this.notify();
	}

	/**
	 * Egyenleg-egyeztetés: a számla nyilvántartott egyenlegét a valós egyenlegre igazítja egy
	 * korrekciós tétellel (bevétel, ha a valós nagyobb; kiadás, ha kisebb). Ha nincs eltérés, nem csinál semmit.
	 */
	async reconcileAccount(
		accountId: number,
		actual: number,
		opts: { date?: string; note?: string } = {}
	): Promise<{ transaction: Transaction; difference: number } | null> {
		const acc = this.accById.get(accountId);
		if (!acc) throw new LedgerError('A számla nem található');
		if (!Number.isInteger(actual) || Math.abs(actual) > MAX_AMOUNT) throw new LedgerError('Érvénytelen egyenleg');
		const current = accountBalances(this.accounts, this.transactions).get(accountId) ?? 0;
		const difference = actual - current;
		if (difference === 0) return null;
		const type = difference > 0 ? 'income' : 'expense';
		const category = await this.correctionCategory(type);
		const transaction = await this.addTx({
			type,
			amount: Math.abs(difference),
			date: opts.date ?? todayISO(),
			description: 'Egyenleg-egyeztetés',
			categoryId: category.id,
			accountId,
			toAccountId: null,
			note: opts.note ?? '',
			tags: ['korrekció']
		});
		return { transaction, difference };
	}

	// --- ismétlődő tételek ---

	async addRecurring(v: RecurringInput): Promise<Recurring> {
		const now = stamp();
		const row = await this.db.add<Recurring>('recurring', {
			...v,
			tags: [...v.tags],
			lastHandled: null,
			active: true,
			createdAt: now,
			updatedAt: now
		});
		this.recurring = [...this.recurring, row];
		this.notify();
		return row;
	}

	async updateRecurring(id: number, v: RecurringInput) {
		const cur = this.recurring.find((r) => r.id === id);
		if (!cur) throw new LedgerError('Az ismétlődő tétel nem található');
		const next: Recurring = { ...cur, ...v, tags: [...v.tags], updatedAt: stamp() };
		await this.db.put('recurring', next);
		this.recurring = this.recurring.map((r) => (r.id === id ? next : r));
		this.notify();
	}

	async setRecurringActive(id: number, active: boolean) {
		const cur = this.recurring.find((r) => r.id === id);
		if (!cur) throw new LedgerError('Az ismétlődő tétel nem található');
		const next = { ...cur, active, updatedAt: stamp() };
		await this.db.put('recurring', next);
		this.recurring = this.recurring.map((r) => (r.id === id ? next : r));
		this.notify();
	}

	async deleteRecurring(id: number) {
		await this.db.remove('recurring', id);
		this.recurring = this.recurring.filter((r) => r.id !== id);
		this.notify();
	}

	/**
	 * Az ismétlődő tétel esedékes előfordulásának feldolgozása: `approve` = létrejön a tétel,
	 * különben csak kihagyja. Csak a szabály legkorábbi feldolgozatlan előfordulása dolgozható fel
	 * (időrendben), és ha közben másik lapon már feldolgozták, nem duplikál.
	 */
	async handleRecurring(
		ruleId: number,
		date: string,
		mode: 'approve' | 'skip',
		opts: { amount?: number } = {}
	): Promise<Transaction | null> {
		const rule = this.recurring.find((r) => r.id === ruleId);
		if (!rule) throw new LedgerError('Az ismétlődő tétel nem található');
		if (nextOccurrence(rule) !== date) throw new LedgerError('Előbb a korábbi előfordulást dolgozd fel');
		if (mode === 'approve' && rule.type !== 'transfer' && rule.categoryId != null && !this.catById.has(rule.categoryId)) {
			throw new LedgerError('Az ismétlődő tétel kategóriája megszűnt');
		}
		let row: Omit<Transaction, 'id'> | null = null;
		if (mode === 'approve') {
			const now = stamp();
			row = {
				type: rule.type,
				amount: opts.amount ?? rule.amount,
				date,
				description: rule.description,
				categoryId: rule.categoryId,
				accountId: rule.accountId,
				toAccountId: rule.toAccountId,
				note: rule.note,
				tags: [...rule.tags],
				recurringId: rule.id,
				createdAt: now,
				updatedAt: now
			};
		}
		const res = await this.db.applyRecurring(rule.id, rule.lastHandled, date, row);
		if (!res) {
			// Másutt már feldolgozták: a memóriát az adatbázishoz igazítjuk.
			await this.load();
			return null;
		}
		this.recurring = this.recurring.map((r) => (r.id === rule.id ? res.rule : r));
		if (res.tx) this.transactions = [...this.transactions, res.tx];
		this.notify();
		return res.tx;
	}

	// --- sablonok ---

	async addTemplate(v: TemplateInput): Promise<Template> {
		const order = Math.max(0, ...this.templates.map((t) => t.sortOrder));
		const now = stamp();
		const row = await this.db.add<Template>('templates', {
			...v,
			tags: [...v.tags],
			sortOrder: order + 1,
			createdAt: now,
			updatedAt: now
		});
		this.templates = [...this.templates, row];
		this.notify();
		return row;
	}

	async renameTemplate(id: number, name: string) {
		const cur = this.templates.find((t) => t.id === id);
		if (!cur) throw new LedgerError('A sablon nem található');
		const next = { ...cur, name, updatedAt: stamp() };
		await this.db.put('templates', next);
		this.templates = this.templates.map((t) => (t.id === id ? next : t));
		this.notify();
	}

	async deleteTemplate(id: number) {
		await this.db.remove('templates', id);
		this.templates = this.templates.filter((t) => t.id !== id);
		this.notify();
	}

	async moveTemplate(id: number, dir: -1 | 1) {
		const group = [...this.templates].sort(byOrder);
		const changed = reorder(group, id, dir, stamp());
		if (!changed.length) return;
		await this.db.putMany('templates', changed);
		const by = new Map(changed.map((t) => [t.id, t]));
		this.templates = this.templates.map((t) => by.get(t.id) ?? t);
		this.notify();
	}

	// --- megtakarítási célok ---

	async addGoal(v: GoalInput): Promise<Goal> {
		const order = Math.max(0, ...this.goals.map((g) => g.sortOrder));
		const now = stamp();
		const row = await this.db.add<Goal>('goals', { ...v, archived: false, sortOrder: order + 1, createdAt: now, updatedAt: now });
		this.goals = [...this.goals, row];
		this.notify();
		return row;
	}

	async updateGoal(id: number, v: GoalInput) {
		const cur = this.goals.find((g) => g.id === id);
		if (!cur) throw new LedgerError('A cél nem található');
		const next = { ...cur, ...v, updatedAt: stamp() };
		await this.db.put('goals', next);
		this.goals = this.goals.map((g) => (g.id === id ? next : g));
		this.notify();
	}

	/** Kézi befizetés (vagy kivétel, negatív összeggel) a célhoz; 0 alá nem mehet. */
	async addToGoal(id: number, delta: number) {
		const cur = this.goals.find((g) => g.id === id);
		if (!cur) throw new LedgerError('A cél nem található');
		if (!Number.isInteger(delta)) throw new LedgerError('Érvénytelen összeg');
		const next = { ...cur, saved: Math.max(0, Math.min(MAX_AMOUNT, cur.saved + delta)), updatedAt: stamp() };
		await this.db.put('goals', next);
		this.goals = this.goals.map((g) => (g.id === id ? next : g));
		this.notify();
	}

	async moveGoal(id: number, dir: -1 | 1) {
		const group = this.goals.filter((g) => !g.archived).sort(byOrder);
		const changed = reorder(group, id, dir, stamp());
		if (!changed.length) return;
		await this.db.putMany('goals', changed);
		const by = new Map(changed.map((g) => [g.id, g]));
		this.goals = this.goals.map((g) => by.get(g.id) ?? g);
		this.notify();
	}

	async setGoalArchived(id: number, archived: boolean) {
		const cur = this.goals.find((g) => g.id === id);
		if (!cur) throw new LedgerError('A cél nem található');
		const next = { ...cur, archived, updatedAt: stamp() };
		await this.db.put('goals', next);
		this.goals = this.goals.map((g) => (g.id === id ? next : g));
		this.notify();
	}

	async deleteGoal(id: number) {
		await this.db.remove('goals', id);
		this.goals = this.goals.filter((g) => g.id !== id);
		this.notify();
	}

	// --- mentett szűrők ---

	async addFilter(name: string, query: string): Promise<SavedFilter> {
		const now = stamp();
		const row = await this.db.add<SavedFilter>('filters', { name, query, createdAt: now, updatedAt: now });
		this.filters = [...this.filters, row];
		this.notify();
		return row;
	}

	async deleteFilter(id: number) {
		await this.db.remove('filters', id);
		this.filters = this.filters.filter((f) => f.id !== id);
		this.notify();
	}

	// --- beállítások ---

	/** Összes havi keret (null = nincs). */
	async setTotalBudget(budget: number | null) {
		if (budget != null && (!Number.isInteger(budget) || budget <= 0 || budget > MAX_AMOUNT)) {
			throw new LedgerError('A keret pozitív összeg legyen');
		}
		const next = { ...this.prefs, totalBudget: budget };
		const at = stamp();
		await this.db.setPrefs(next, at);
		this.prefs = next;
		this.prefsUpdatedAt = at;
		this.notify();
	}

	/**
	 * Pénznemváltás: az összes összeg (tételek, felosztások, kezdőegyenlegek, keretek, ismétlődők,
	 * sablonok, célok) átszámolódik az árfolyammal. `rate` = hány jelenlegi pénznem egy új pénznem
	 * (pl. HUF-ról EUR-ra váltva: 395, mert 1 EUR = 395 Ft). Mindent vagy semmit.
	 */
	async switchCurrency(code: string, rate: number) {
		const from = activeCurrency();
		const to = findCurrency(code);
		if (!to) throw new LedgerError('Ismeretlen pénznem');
		if (to.code === from.code) throw new LedgerError('Ez már a jelenlegi pénznem');
		if (!Number.isFinite(rate) || rate <= 0) throw new LedgerError('Az árfolyam pozitív szám legyen');
		const conv = (n: number) => convertMinor(n, from, to, rate);
		const check = (n: number) => {
			if (Math.abs(n) > MAX_AMOUNT) throw new LedgerError('Az átváltott összeg túl nagy lenne – ellenőrizd az árfolyamot');
			return n;
		};
		const nullable = (n: number | null) => (n == null ? null : check(conv(n)));

		const data = this.data();
		const next: LedgerData = {
			accounts: data.accounts.map((a) => ({ ...a, initialBalance: check(conv(a.initialBalance)) })),
			categories: data.categories.map((c) => ({ ...c, monthlyBudget: nullable(c.monthlyBudget) })),
			transactions: data.transactions.map((t) => {
				const amount = check(conv(t.amount));
				if (!t.splits || t.splits.length === 0) return { ...t, amount };
				// A részek összege az átváltás után is egyezzen a tétel összegével: a különbség a legnagyobb részre kerül.
				const parts = t.splits.map((s) => ({ ...s, amount: conv(s.amount) }));
				const diff = amount - parts.reduce((sum, p) => sum + p.amount, 0);
				let big = 0;
				parts.forEach((p, i) => {
					if (p.amount > parts[big].amount) big = i;
				});
				parts[big].amount += diff;
				if (parts.some((p) => p.amount <= 0)) {
					// Extrém árfolyamnál a felosztás értelmét vesztené: egyetlen kategóriába olvad.
					const { splits: _s, ...rest } = t;
					return { ...rest, amount };
				}
				return { ...t, amount, splits: parts };
			}),
			recurring: data.recurring.map((r) => ({ ...r, amount: check(conv(r.amount)) })),
			templates: data.templates.map((t) => ({ ...t, amount: nullable(t.amount) })),
			goals: data.goals.map((g) => ({ ...g, target: check(conv(g.target)), saved: check(conv(g.saved)) })),
			// A mentett szűrők összegkorlátai (min/max) a régi pénznemben vannak megadva: eldobjuk azokat.
			filters: data.filters.map((f) => ({ ...f, query: stripAmountParams(f.query) }))
		};
		const prefs: Prefs = { currency: to.code, totalBudget: nullable(this.prefs.totalBudget) };
		await this.db.replaceAll(next, prefs);
		await this.load();
		this.notify();
	}

	// --- példaadatok, mentés ---

	async loadDemoData(today: string = todayISO()): Promise<number> {
		const generated = generateDemoTransactions(today, this.accounts, this.categories);
		if (generated.length === 0) return 0;
		// A generátor saját időbélyeget ad; a főkönyv szigorúan növekvő sorozatához igazítjuk.
		const base = stamp(generated.length);
		const rows = generated.map((t, i) => ({ ...t, createdAt: base + i, updatedAt: base + i }));
		const added = await this.db.addMany<Transaction>('transactions', rows);
		await this.db.startEpoch(); // az adatok egésze változott: a szinkron új korszakot lát
		this.transactions = [...this.transactions, ...added];
		this.notify();
		return added.length;
	}

	async removeDemoData(): Promise<number> {
		const ids = this.transactions.filter((t) => t.demo).map((t) => t.id);
		if (ids.length === 0) return 0;
		await this.db.removeMany('transactions', ids);
		await this.db.startEpoch(); // az adatok egésze változott: a szinkron új korszakot lát
		const gone = new Set(ids);
		this.transactions = this.transactions.filter((t) => !gone.has(t.id));
		this.notify();
		return ids.length;
	}

	exportBackup(): Backup {
		return makeBackup({ ...this.data(), prefs: this.prefs });
	}

	async importBackup(backup: Backup) {
		const { prefs, ...data } = backup;
		const rest: LedgerData = { ...emptyData(), ...data };
		await this.db.replaceAll(rest, prefs);
		await this.load();
		this.notify();
	}
}

/** A mentett szűrő lekérdezéséből eltávolítja az összeghatárokat (`min`, `max`). */
export function stripAmountParams(query: string): string {
	const sp = new URLSearchParams(query);
	sp.delete('min');
	sp.delete('max');
	return sp.toString();
}

/**
 * Egy csoport (már rendezett lista) egyik elemét egy hellyel arrébb teszi, és a teljes csoportot
 * 1..n sorszámra igazítja. Visszaadja a ténylegesen megváltozott sorokat (ha van `updatedAt`, azzal bélyegezve).
 */
export function reorder<T extends { id: number; sortOrder: number }>(
	group: T[],
	id: number,
	dir: -1 | 1,
	updatedAt?: number
): T[] {
	const i = group.findIndex((x) => x.id === id);
	const j = i + dir;
	if (i < 0 || j < 0 || j >= group.length) return [];
	const list = [...group];
	[list[i], list[j]] = [list[j], list[i]];
	const changed: T[] = [];
	list.forEach((x, idx) => {
		if (x.sortOrder !== idx + 1) changed.push({ ...x, sortOrder: idx + 1, ...(updatedAt !== undefined ? { updatedAt } : {}) });
	});
	return changed;
}

export const ledger = new Ledger();
