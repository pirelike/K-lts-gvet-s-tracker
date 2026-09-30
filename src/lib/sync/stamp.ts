/**
 * Szigorúan növekvő időbélyeg. A `createdAt` és az `updatedAt` innen jön, mert az azonosítók már
 * véletlen számok: egyenlő időbélyegnél nincs, ami sorrendet adna, és a szinkron „az újabb nyer"
 * szabálya is döntetlenre futna két gyors, egymás utáni módosításnál.
 */
let last = 0;

/** Az első időbélyeg egy `count` darabos blokkból: `first, first + 1, …, first + count − 1`. */
export function stamp(count = 1): number {
	const first = Math.max(Date.now(), last + 1);
	last = first + Math.max(1, count) - 1;
	return first;
}
