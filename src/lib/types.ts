/**
 * Tranzakciótípusok. Az előjelet (a számlaegyenlegre gyakorolt hatást) a típus adja:
 * - `expense`  csökkenti a számlát és növeli a kiadást,
 * - `income`   növeli a számlát és a bevételt,
 * - `refund`   növeli a számlát, de a **kiadási kategória** költését csökkenti (visszavitt áru, visszatérítés),
 * - `transfer` két számla között mozgat, a statisztikákban nem szerepel.
 */
export type TxType = 'income' | 'expense' | 'transfer' | 'refund';
export type CategoryType = 'income' | 'expense';
export type AccountType = 'cash' | 'checking' | 'credit' | 'savings';

export const ACCOUNT_TYPES: AccountType[] = ['cash', 'checking', 'credit', 'savings'];
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
	cash: 'Készpénz',
	checking: 'Folyószámla',
	credit: 'Hitelkártya',
	savings: 'Megtakarítás'
};

export interface Account {
	id: number;
	name: string;
	type: AccountType;
	/** Kezdőegyenleg a pénznem legkisebb egységében (HUF-nál forint; lehet negatív is). */
	initialBalance: number;
	archived: boolean;
	sortOrder: number;
	createdAt: number;
}

export interface Category {
	id: number;
	name: string;
	type: CategoryType;
	/** #rrggbb */
	color: string;
	/** Egy emoji vagy rövid jel. */
	icon: string;
	/** Havi keret (csak kiadási kategóriánál van jelentése); null = nincs keret. */
	monthlyBudget: number | null;
	archived: boolean;
	sortOrder: number;
	createdAt: number;
}

/** Egy tétel egy kategóriára eső része (felosztott tételnél). */
export interface TxSplit {
	categoryId: number;
	/** Pozitív egész; a részek összege a tétel összege. */
	amount: number;
}

export interface Transaction {
	id: number;
	type: TxType;
	/** Mindig pozitív egész; az előjelet a `type` adja. */
	amount: number;
	/** YYYY-MM-DD (helyi naptári nap) */
	date: string;
	description: string;
	/** Átvezetésnél null. Felosztott tételnél a legnagyobb rész kategóriája. */
	categoryId: number | null;
	/** Átvezetésnél a forrásszámla. */
	accountId: number;
	/** Csak átvezetésnél: a célszámla. */
	toAccountId: number | null;
	note: string;
	/** Kisbetűs címkék, # nélkül. */
	tags: string[];
	/** Egy tétel több kategóriára bontva (pl. egy Lidl-blokk: Étel + Háztartás). Legalább 2 rész. */
	splits?: TxSplit[];
	/** Ha ismétlődő szabályból jött létre. */
	recurringId?: number;
	/** Példaadat – egy gombbal törölhető a Beállításokban. */
	demo?: boolean;
	createdAt: number;
	updatedAt: number;
}

/** Egy tranzakció beviteli (validált) alakja. */
export interface TxInput {
	type: TxType;
	amount: number;
	date: string;
	description: string;
	categoryId: number | null;
	accountId: number;
	toAccountId: number | null;
	note: string;
	tags: string[];
	splits?: TxSplit[];
}

export type Frequency = 'weekly' | 'monthly' | 'yearly';

/** Ismétlődő tétel (albérlet, előfizetés, ösztöndíj): az app megnyitásakor „esedékes tételként" jelenik meg. */
export interface Recurring {
	id: number;
	type: 'income' | 'expense' | 'transfer';
	amount: number;
	description: string;
	categoryId: number | null;
	accountId: number;
	toAccountId: number | null;
	note: string;
	tags: string[];
	frequency: Frequency;
	/** Minden n-edik hét / hónap / év (>= 1). */
	interval: number;
	/** Az első előfordulás napja; a havi/éves ismétlés ehhez a naphoz igazodik. */
	startDate: string;
	/** Utolsó előfordulás napja (üres = határozatlan ideig). */
	endDate: string | null;
	/** Az utoljára feldolgozott (jóváhagyott vagy kihagyott) előfordulás napja. */
	lastHandled: string | null;
	active: boolean;
	createdAt: number;
}

export type NewRecurring = Omit<Recurring, 'id'>;

/** Gyorsan újrahasználható tételminta. */
export interface Template {
	id: number;
	name: string;
	type: 'income' | 'expense' | 'transfer' | 'refund';
	/** null = az összeget használatkor kell megadni. */
	amount: number | null;
	description: string;
	categoryId: number | null;
	accountId: number | null;
	toAccountId: number | null;
	note: string;
	tags: string[];
	sortOrder: number;
	createdAt: number;
}

/** Megtakarítási cél: számlához kötött (a számla egyenlege a haladás) vagy kézi befizetésekkel. */
export interface Goal {
	id: number;
	name: string;
	icon: string;
	color: string;
	target: number;
	/** Kézzel követett összeg (ha nincs számlához kötve). */
	saved: number;
	accountId: number | null;
	/** YYYY-MM-DD vagy null. */
	deadline: string | null;
	archived: boolean;
	sortOrder: number;
	createdAt: number;
}

/** Mentett szűrő a tétellistához: a lista URL-lekérdezése. */
export interface SavedFilter {
	id: number;
	name: string;
	/** pl. `q=kave&cat=3` (a hónap nélkül). */
	query: string;
	createdAt: number;
}

/** Az adatokhoz tartozó beállítások (a mentésben is benne vannak). */
export interface Prefs {
	currency: string;
	/** Összes havi keret (null = nincs). */
	totalBudget: number | null;
}

export const DEFAULT_PREFS: Prefs = { currency: 'HUF', totalBudget: null };

export interface Backup {
	app: 'koltsegvetes-tracker';
	version: 2;
	exportedAt: string;
	prefs: Prefs;
	accounts: Account[];
	categories: Category[];
	transactions: Transaction[];
	recurring: Recurring[];
	templates: Template[];
	goals: Goal[];
	filters: SavedFilter[];
}

/** A mentés adattartalma (a fejléc nélkül). */
export type LedgerSnapshot = Pick<
	Backup,
	'prefs' | 'accounts' | 'categories' | 'transactions' | 'recurring' | 'templates' | 'goals' | 'filters'
>;

export const TX_TYPE_LABEL: Record<TxType, string> = {
	expense: 'Kiadás',
	income: 'Bevétel',
	transfer: 'Átvezetés',
	refund: 'Jóváírás'
};

/** Milyen típusú kategória tartozik a tranzakciótípushoz (átvezetéshez nincs). */
export function categoryTypeFor(type: TxType): CategoryType | null {
	if (type === 'transfer') return null;
	return type === 'income' ? 'income' : 'expense';
}

/** A tétel hatása a számla egyenlegére: +1, −1 (átvezetésnél 0: ott két számla mozog). */
export function balanceSign(type: TxType): 1 | -1 | 0 {
	if (type === 'income' || type === 'refund') return 1;
	if (type === 'expense') return -1;
	return 0;
}

/** A tétel kategóriánkénti részei: felosztott tételnél a felosztás, különben az egyetlen kategória. */
export function txParts(t: Pick<Transaction, 'categoryId' | 'amount' | 'splits'>): TxSplit[] {
	if (t.splits && t.splits.length > 0) return t.splits;
	return t.categoryId != null ? [{ categoryId: t.categoryId, amount: t.amount }] : [];
}

/** A legnagyobb rész kategóriája (egyenlőségnél az első) – a felosztott tétel fő kategóriája. */
export function mainCategory(splits: readonly TxSplit[]): number {
	let best = splits[0];
	for (const s of splits) if (s.amount > best.amount) best = s;
	return best.categoryId;
}

export const MAX_DESCRIPTION = 200;
export const MAX_NOTE = 2000;
export const MAX_NAME = 40;
export const MAX_TAG = 30;
export const MAX_TAGS = 10;
export const MAX_AMOUNT = 1_000_000_000_000;
export const MAX_SPLITS = 12;
