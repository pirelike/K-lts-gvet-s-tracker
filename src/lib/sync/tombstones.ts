/**
 * Törlési jelölők (tombstone) és korszak (epoch): a szinkron ezekből tudja, hogy egy hiányzó rekordot
 * töröltek (és nem még nem érkezett meg), illetve hogy az adatok egésze egyszerre cserélődött-e.
 */
import type { DataStore } from '../db/idb';
import { newId } from './ids';
import { stamp } from './stamp';

/** `${tároló}:${id}` → a törlés ideje (ms). */
export type Tombstones = Record<string, number>;

/** A jelölők ennyi ideig élnek; egy ennél tovább offline eszköz visszahozhat törölt elemeket. */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export const tombstoneKey = (store: DataStore, id: number): string => `${store}:${id}`;

/** A jelölő kulcsából a tároló és az azonosító; ismeretlen alak esetén null. */
export function parseTombstoneKey(key: string): { store: string; id: number } | null {
	const i = key.indexOf(':');
	if (i < 1) return null;
	const id = Number(key.slice(i + 1));
	return Number.isSafeInteger(id) ? { store: key.slice(0, i), id } : null;
}

/** A régi jelölők eldobása (a `now` a hívó órájáról jön, hogy tesztelhető legyen). */
export function pruneTombstones(tombstones: Tombstones, now: number = Date.now(), ttl: number = TOMBSTONE_TTL_MS): Tombstones {
	const out: Tombstones = {};
	for (const [k, at] of Object.entries(tombstones)) if (now - at <= ttl) out[k] = at;
	return out;
}

/**
 * Korszak: akkor változik, amikor az adatok egésze egyszerre cserélődik (pénznemváltás, visszatöltés,
 * példaadatok betöltése/törlése). Eltérő korszakú állapotok között nincs rekordszintű összefésülés.
 */
export interface SyncEpoch {
	id: number;
	at: number;
}

export const newEpoch = (): SyncEpoch => ({ id: newId(), at: stamp() });

export const isEpoch = (v: unknown): v is SyncEpoch =>
	typeof v === 'object' &&
	v !== null &&
	Number.isSafeInteger((v as SyncEpoch).id) &&
	Number.isSafeInteger((v as SyncEpoch).at);
