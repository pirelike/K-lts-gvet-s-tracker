/** Grafikonok segédfüggvényei: „szép" tengelybeosztás. */

/** A 0-tól `max`-ig terjedő tengely szép lépésközzel: pl. 0, 20 000, 40 000, 60 000. */
export function niceTicks(max: number, target = 4): number[] {
	if (!(max > 0)) return [0, 1];
	const rough = max / target;
	const pow = 10 ** Math.floor(Math.log10(rough));
	const norm = rough / pow;
	const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * pow;
	const ticks: number[] = [];
	for (let v = 0; v < max + step; v += step) {
		ticks.push(Math.round(v * 1e6) / 1e6);
		if (v >= max) break;
	}
	return ticks;
}
