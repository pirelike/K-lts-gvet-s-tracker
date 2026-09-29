export type TxType = 'income' | 'expense' | 'transfer';
export type CategoryType = 'income' | 'expense';

export interface Account {
	id: number;
	name: string;
	/** Kezdőegyenleg forintban (lehet negatív is). */
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
	/** Havi keret – a következő lépcsőben kap felületet, de a modellben már ott van. */
	monthlyBudget: number | null;
	archived: boolean;
	sortOrder: number;
	createdAt: number;
}

export interface Transaction {
	id: number;
	type: TxType;
	/** Mindig pozitív egész; az előjelet a `type` adja. */
	amount: number;
	/** YYYY-MM-DD (helyi naptári nap) */
	date: string;
	description: string;
	/** Átvezetésnél null. */
	categoryId: number | null;
	/** Átvezetésnél a forrásszámla. */
	accountId: number;
	/** Csak átvezetésnél: a célszámla. */
	toAccountId: number | null;
	note: string;
	/** Kisbetűs címkék, # nélkül. */
	tags: string[];
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
}

export interface Backup {
	app: 'koltsegvetes-tracker';
	version: 1;
	exportedAt: string;
	accounts: Account[];
	categories: Category[];
	transactions: Transaction[];
}

export const TX_TYPE_LABEL: Record<TxType, string> = {
	expense: 'Kiadás',
	income: 'Bevétel',
	transfer: 'Átvezetés'
};

export const MAX_DESCRIPTION = 200;
export const MAX_NOTE = 2000;
export const MAX_NAME = 40;
export const MAX_TAG = 30;
export const MAX_TAGS = 10;
export const MAX_AMOUNT = 1_000_000_000_000;
