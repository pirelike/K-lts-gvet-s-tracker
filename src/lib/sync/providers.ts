/**
 * A szolgáltatók nyilvántartása: azonosító → gyár. A motor innen példányosítja a kapcsolatban tárolt
 * szolgáltatót; a Google Drive és a Dropbox ide regisztrálja magát.
 */
import { createMemoryProvider } from './memory';
import type { ProviderId, ProviderStorage, SyncProvider } from './provider';

export type ProviderFactory = (storage: ProviderStorage) => SyncProvider;

export const providerFactories: Partial<Record<ProviderId, ProviderFactory>> = {
	memory: () => createMemoryProvider()
};

/** A felületen felkínálható szolgáltatók sorrendje. */
export const PROVIDER_ORDER: ProviderId[] = ['gdrive', 'dropbox', 'memory'];
