import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tot: Record<string, Record<string, number>> = { gf2: {}, z2w: {}, zp: {}, whole: {} };
let n = 0;
for (const k of [0, 1, 2]) {
	const j = JSON.parse(readFileSync(join(here, 'results', `hist2-${k}.json`), 'utf8'));
	n += j.n;
	for (const ring of Object.keys(tot))
		for (const [r, v] of Object.entries(j.tally[ring] as Record<string, number>))
			tot[ring]![r] = (tot[ring]![r] ?? 0) + v;
}
console.log('refusals re-run', n);
for (const ring of Object.keys(tot)) {
	console.log('##', ring);
	for (const [r, v] of Object.entries(tot[ring]!).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`- ${v}: ${r}`);
}
