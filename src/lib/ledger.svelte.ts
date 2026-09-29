/**
 * A memóriában tartott főkönyv (számlák, kategóriák, tranzakciók) Svelte-állapotként.
 * Minden módosítás előbb az IndexedDB-be íródik, aztán frissül a memória.
 */
import { generateDemoTransactions } from './db/demo';
import { makeBackup } from './db/backup';
import type { LedgerRepo } from './db/repo';
import { todayISO } from './dates';
import type {
	Account,
	Backup,
	Category,
	CategoryType,
	Transaction,
	TxInput
} from './types';
import type { CategoryFormValues } from './validation';
import { accountUsage, categoryUsage } from './queries';

export class LedgerError extends Error {}

const byOrder = <T extends { sortOrder: number; name: string }>(a: T, b: T) =>
	a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'hu');

class Ledger {
	private repo: LedgerRepo | null = null;
	private channel: BroadcastChannel | null = null;

	accounts = $state.raw<Account[]>([]);
	categories = $state.raw<Category[]>([]);
	transactions = $state.raw<Transaction[]>([]);
	loaded = $state(false);

	catById = $derived(new Map(this.categories.map((c) => [c.id, c])));
	accById = $derived(new Map(this.accounts.map((a) => [a.id, a])));
	activeAccounts = $derived(this.accounts.filter((a) => !a.archived).sort(byOrder));
	hasDemo = $derived(this.transactions.some((t) => t.demo));

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

	private notify() {
		this.channel?.postMessage('changed');
	}

	async load() {
		const data = await this.db.loadAll();
		this.accounts = data.accounts;
		this.categories = data.categories;
		this.transactions = data.transactions;
		this.loaded = true;
	}

	/** Zároláskor a memóriából is kikerülnek az adatok. */
	clear() {
		this.accounts = [];
		this.categories = [];
		this.transactions = [];
		this.loaded = false;
	}

	// --- tranzakciók ---

	async addTx(input: TxInput): Promise<Transaction> {
		const now = Date.now();
		const row = await this.db.add<Transaction>('transactions', {
			...input,
			tags: [...input.tags],
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
		const next: Transaction = { ...cur, ...input, tags: [...input.tags], id, updatedAt: Date.now() };
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

	/** Törlés visszavonása: ugyanazzal az azonosítóval visszakerül a tétel. */
	async restoreTx(snapshot: Transaction): Promise<void> {
		if (this.transactions.some((t) => t.id === snapshot.id)) return;
		const refsOk =
			this.accById.has(snapshot.accountId) &&
			(snapshot.toAccountId == null || this.accById.has(snapshot.toAccountId)) &&
			(snapshot.categoryId == null || this.catById.has(snapshot.categoryId));
		if (!refsOk) throw new LedgerError('A tétel kategóriája vagy számlája időközben megszűnt');
		await this.db.put('transactions', snapshot);
		this.transactions = [...this.transactions, snapshot];
		this.notify();
	}

	// --- kategóriák ---

	async addCategory(type: CategoryType, v: CategoryFormValues): Promise<Category> {
		const order = Math.max(0, ...this.categories.filter((c) => c.type === type).map((c) => c.sortOrder));
		const row = await this.db.add<Category>('categories', {
			name: v.name,
			type,
			color: v.color,
			icon: v.icon,
			monthlyBudget: null,
			archived: false,
			sortOrder: order + 1,
			createdAt: Date.now()
		});
		this.categories = [...this.categories, row];
		this.notify();
		return row;
	}

	async updateCategory(id: number, v: Pick<CategoryFormValues, 'name' | 'color' | 'icon'>) {
		const cur = this.catById.get(id);
		if (!cur) throw new LedgerError('A kategória nem található');
		const next = { ...cur, name: v.name, color: v.color, icon: v.icon };
		await this.db.put('categories', next);
		this.categories = this.categories.map((c) => (c.id === id ? next : c));
		this.notify();
	}

	async setCategoryArchived(id: number, archived: boolean) {
		const cur = this.catById.get(id);
		if (!cur) throw new LedgerError('A kategória nem található');
		const next = { ...cur, archived };
		await this.db.put('categories', next);
		this.categories = this.categories.map((c) => (c.id === id ? next : c));
		this.notify();
	}

	/** Üzleti szabály: kategória csak akkor törölhető, ha nincs hozzá tranzakció (különben archiválni kell). */
	async deleteCategory(id: number) {
		if ((categoryUsage(this.transactions).get(id) ?? 0) > 0) {
			throw new LedgerError('Ehhez a kategóriához vannak tételek – archiváld helyette');
		}
		await this.db.remove('categories', id);
		this.categories = this.categories.filter((c) => c.id !== id);
		this.notify();
	}

	// --- számlák ---

	async addAccount(v: { name: string; initialBalance: number }): Promise<Account> {
		const order = Math.max(0, ...this.accounts.map((a) => a.sortOrder));
		const row = await this.db.add<Account>('accounts', {
			name: v.name,
			initialBalance: v.initialBalance,
			archived: false,
			sortOrder: order + 1,
			createdAt: Date.now()
		});
		this.accounts = [...this.accounts, row];
		this.notify();
		return row;
	}

	async updateAccount(id: number, v: { name: string; initialBalance: number }) {
		const cur = this.accById.get(id);
		if (!cur) throw new LedgerError('A számla nem található');
		const next = { ...cur, ...v };
		await this.db.put('accounts', next);
		this.accounts = this.accounts.map((a) => (a.id === id ? next : a));
		this.notify();
	}

	async setAccountArchived(id: number, archived: boolean) {
		const cur = this.accById.get(id);
		if (!cur) throw new LedgerError('A számla nem található');
		const next = { ...cur, archived };
		await this.db.put('accounts', next);
		this.accounts = this.accounts.map((a) => (a.id === id ? next : a));
		this.notify();
	}

	async deleteAccount(id: number) {
		if ((accountUsage(this.transactions).get(id) ?? 0) > 0) {
			throw new LedgerError('Ehhez a számlához vannak tételek – archiváld helyette');
		}
		await this.db.remove('accounts', id);
		this.accounts = this.accounts.filter((a) => a.id !== id);
		this.notify();
	}

	// --- példaadatok, mentés ---

	async loadDemoData(today: string = todayISO()): Promise<number> {
		const rows = generateDemoTransactions(today, this.accounts, this.categories);
		if (rows.length === 0) return 0;
		const added = await this.db.addMany<Transaction>('transactions', rows);
		this.transactions = [...this.transactions, ...added];
		this.notify();
		return added.length;
	}

	async removeDemoData(): Promise<number> {
		const ids = this.transactions.filter((t) => t.demo).map((t) => t.id);
		if (ids.length === 0) return 0;
		await this.db.removeMany('transactions', ids);
		const gone = new Set(ids);
		this.transactions = this.transactions.filter((t) => !gone.has(t.id));
		this.notify();
		return ids.length;
	}

	exportBackup(): Backup {
		return makeBackup({
			accounts: this.accounts,
			categories: this.categories,
			transactions: this.transactions
		});
	}

	async importBackup(backup: Backup) {
		await this.db.replaceAll(backup);
		await this.load();
		this.notify();
	}
}

export const ledger = new Ledger();
