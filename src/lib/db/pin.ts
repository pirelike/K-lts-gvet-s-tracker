/**
 * PIN-kezelés. A PIN-t nem tároljuk, csak egy sózott PBKDF2-SHA256 hash-t, ami az eszközön marad.
 * Fontos: ez alkalmazászár (véletlen belenézés ellen), nem titkosítás – az adatok a böngészőben
 * titkosítatlanul vannak. Az eszköz és a böngészőprofil védelmét nem helyettesíti.
 */

export const PIN_MIN = 4;
export const PIN_MAX = 8;
const ITERATIONS = 210_000;

export interface PinRecord {
	algo: 'PBKDF2-SHA256';
	iterations: number;
	salt: string;
	hash: string;
	createdAt: number;
}

export interface PinAttempts {
	failures: number;
	/** Epoch ms; addig nem lehet újra próbálkozni. */
	lockedUntil: number;
}

export function pinFormatError(pin: string): string | null {
	if (!/^\d+$/.test(pin)) return 'A PIN csak számjegyekből állhat';
	if (pin.length < PIN_MIN || pin.length > PIN_MAX) return `A PIN ${PIN_MIN}–${PIN_MAX} számjegy legyen`;
	return null;
}

/** A hash-eléshez szükséges Web Crypto csak biztonságos környezetben (HTTPS / localhost) érhető el. */
export function cryptoAvailable(): boolean {
	return typeof crypto !== 'undefined' && !!crypto.subtle;
}

const toB64 = (buf: ArrayBuffer | Uint8Array) => {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		key,
		256
	);
	return toB64(bits);
}

export async function createPinRecord(pin: string): Promise<PinRecord> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return {
		algo: 'PBKDF2-SHA256',
		iterations: ITERATIONS,
		salt: toB64(salt),
		hash: await derive(pin, salt, ITERATIONS),
		createdAt: Date.now()
	};
}

export async function verifyPin(pin: string, rec: PinRecord): Promise<boolean> {
	const hash = await derive(pin, fromB64(rec.salt), rec.iterations);
	if (hash.length !== rec.hash.length) return false;
	let diff = 0;
	for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ rec.hash.charCodeAt(i);
	return diff === 0;
}

/** 5 hibás próba után növekvő várakozás: 30 mp, 1, 2, 4 … legfeljebb 15 perc. */
export function lockoutMs(failures: number): number {
	if (failures < 5) return 0;
	return Math.min(30_000 * 2 ** (failures - 5), 15 * 60_000);
}
