/**
 * A szolgáltatók nyilvántartása: azonosító → gyár. A motor innen példányosítja a kapcsolatban tárolt
 * szolgáltatót; az átirányításos bejelentkezések (Dropbox) visszatérését is itt kötjük be.
 */
import { consumeDropboxRedirect, createDropboxProvider } from './dropbox';
import { createGdriveProvider } from './gdrive';
import { createMemoryProvider } from './memory';
import type { ProviderId, ProviderStorage, SyncProvider } from './provider';

export type ProviderFactory = (storage: ProviderStorage) => SyncProvider;

export const providerFactories: Partial<Record<ProviderId, ProviderFactory>> = {
	gdrive: (storage) => createGdriveProvider(storage),
	dropbox: (storage) => createDropboxProvider(storage),
	memory: () => createMemoryProvider()
};

/** Induláskor lefutó kezelők: az átirányításos bejelentkezések eredményének feldolgozása (nem dobnak kivételt). */
export const redirectHandlers: (() => Promise<unknown>)[] = [() => consumeDropboxRedirect()];

/** A felületen felkínálható szolgáltatók sorrendje. */
export const PROVIDER_ORDER: ProviderId[] = ['gdrive', 'dropbox', 'memory'];
