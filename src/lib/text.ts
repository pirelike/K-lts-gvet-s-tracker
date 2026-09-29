/**
 * Kereséshez használt normalizálás: kisbetű, ékezetek nélkül, összevont szóközök.
 * Így a „kave" megtalálja a „Kávé"-t, az „ÉTEL" az „étel"-t is.
 * A szerver (SQLite `fold()` függvény) és a kliens (autocomplete) ugyanezt használja.
 */
export function fold(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLocaleLowerCase('hu')
		.replace(/\s+/g, ' ')
		.trim();
}

/** LIKE minta escape-elése (escape karakter: \). */
export function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
