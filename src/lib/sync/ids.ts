/**
 * Eszközök között ütközésmentes azonosítók. A régi, autoIncrement sorszámok kicsik (< 2^32),
 * az újak ennél mindig nagyobbak, így a kettő nem ütközik. Minden érték biztonságos egész (< 2^53).
 */

/** Az új azonosítók alsó határa: a régi sorszámok ez alatt maradnak. */
export const ID_MIN = 2 ** 32;
/** A legnagyobb biztonságos egész. */
export const ID_MAX = Number.MAX_SAFE_INTEGER;

/** Véletlen egész az `[ID_MIN, ID_MAX]` tartományból. */
export function newId(): number {
	const w = new Uint32Array(2);
	for (;;) {
		crypto.getRandomValues(w);
		// Felső 21 bit + alsó 32 bit = 53 bit.
		const id = (w[0] & 0x1fffff) * 2 ** 32 + w[1];
		if (id >= ID_MIN) return id;
	}
}

/** Az azonosító az új (eszközök közötti) tartományból való-e. */
export const isNewId = (id: number): boolean => Number.isSafeInteger(id) && id >= ID_MIN;

/**
 * Egy ismétlődő szabály egy előfordulásából képzett tranzakcióazonosító: a SHA-256 első 53 bitje.
 * Determinisztikus, így ha ugyanazt az előfordulást két eszközön hagyják jóvá, ugyanaz az id
 * keletkezik, és összefésüléskor egyetlen tétel marad belőle.
 */
export async function recurringTxId(ruleId: number, date: string): Promise<number> {
	// Az `ID_MIN` alatti érték (2^-21 esély) miatt számlálóval újrahasítunk; ez is determinisztikus.
	for (let n = 0; ; n++) {
		const input = n === 0 ? `${ruleId}|${date}` : `${ruleId}|${date}|${n}`;
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
		const view = new DataView(hash.buffer);
		const id = (view.getUint32(0) & 0x1fffff) * 2 ** 32 + view.getUint32(4);
		if (id >= ID_MIN) return id;
	}
}
