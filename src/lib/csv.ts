/**
 * CSV olvasás és írás (Excel-barát). Az export pontosvesszős, UTF-8 BOM-mal és tizedesvesszővel,
 * mert a magyar Excel így nyitja meg helyesen; az import a `;`, `,` és tabulátor elválasztót is
 * felismeri, és a windows-1250 kódolású (banki) fájlokat is kezeli.
 */

/** Az elválasztó kitalálása az első néhány sor alapján (idézőjelen kívüli előfordulások száma). */
export function detectDelimiter(text: string): ';' | ',' | '\t' {
	const sample = text.replace(/^﻿/, '').split(/\r?\n/).slice(0, 5).join('\n');
	const count = (d: string) => {
		let inQuotes = false;
		let n = 0;
		for (const ch of sample) {
			if (ch === '"') inQuotes = !inQuotes;
			else if (!inQuotes && ch === d) n++;
		}
		return n;
	};
	const scores: [';' | ',' | '\t', number][] = [
		[';', count(';')],
		['\t', count('\t')],
		[',', count(',')]
	];
	scores.sort((a, b) => b[1] - a[1]);
	return scores[0][1] > 0 ? scores[0][0] : ';';
}

/** RFC 4180 szerinti beolvasás: idézőjeles mezők, kettőzött idézőjel, sortörés a mezőben, CRLF. */
export function parseCsv(text: string, delimiter: string = detectDelimiter(text)): string[][] {
	const src = text.replace(/^﻿/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let wasQuoted = false;
	const endField = () => {
		row.push(field);
		field = '';
		wasQuoted = false;
	};
	const endRow = () => {
		endField();
		// a teljesen üres sorokat kihagyjuk
		if (row.length > 1 || row[0] !== '' || wasQuoted) rows.push(row);
		row = [];
	};
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else inQuotes = false;
			} else field += ch;
		} else if (ch === '"' && field === '') {
			inQuotes = true;
			wasQuoted = true;
		} else if (ch === delimiter) endField();
		else if (ch === '\r') {
			if (src[i + 1] === '\n') i++;
			endRow();
		} else if (ch === '\n') endRow();
		else field += ch;
	}
	if (field !== '' || row.length > 0 || wasQuoted) endRow();
	return rows;
}

const needsQuotes = (s: string, delimiter: string) => s.includes(delimiter) || /["\r\n]/.test(s);

export function toCsv(rows: readonly (readonly string[])[], delimiter = ';'): string {
	return rows
		.map((r) =>
			r.map((cell) => (needsQuotes(cell, delimiter) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(delimiter)
		)
		.join('\r\n');
}

/**
 * Képlet-injektálás ellen (CSV-injection): az Excel a `=`, `+`, `-`, `@` jellel kezdődő szöveget
 * képletként futtatná. Az ilyen szöveges cellák elé aposztróf kerül.
 */
export function sanitizeCell(s: string): string {
	return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** A `sanitizeCell` inverze importáláskor. */
export function unsanitizeCell(s: string): string {
	return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

/** A fájl bájtjaiból szöveg: UTF-8, ennek hibája esetén windows-1250 (magyar banki exportok). */
export function decodeCsvBytes(buf: ArrayBuffer): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buf);
	} catch {
		try {
			return new TextDecoder('windows-1250').decode(buf);
		} catch {
			return new TextDecoder('utf-8').decode(buf);
		}
	}
}
