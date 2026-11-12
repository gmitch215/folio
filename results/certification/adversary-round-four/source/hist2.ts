import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certifyStream } from '../../../../src/certify.ts';
import type { Row } from './lib.ts';

// re-runs the checker on every refused module and tallies the reason of each ring attempt
// usage: hist2.ts SHARD COUNT
const here = dirname(fileURLToPath(import.meta.url));
const [shard, count] = process.argv.slice(2).map(Number) as [number, number];
const rows = new Map<string, Row>();
for (const f of readdirSync(join(here, 'results')).sort())
	if (f.endsWith('.jsonl'))
		for (const l of readFileSync(join(here, 'results', f), 'utf8').split('\n'))
			if (l) {
				const r = JSON.parse(l) as Row;
				rows.set(r.id, r);
			}
const recs: { id: string; family: string; file: string; entry?: string }[] = [];
for (const f of readdirSync(here))
	if (/^(cg|ct|bm|wt|ds)-.*\.jsonl$/.test(f))
		for (const l of readFileSync(join(here, f), 'utf8').split('\n')) if (l) recs.push(JSON.parse(l));
const refused = recs.filter((r) => rows.get(r.id)?.checker === 'refused').filter((_, i) => i % count === shard);
const tally: Record<string, Record<string, number>> = { gf2: {}, z2w: {}, zp: {}, whole: {} };
const norm = (s: string) => s.replace(/0x[0-9a-f]+/gi, 'N').replace(/\d+/g, 'N').slice(0, 80);
let n = 0;
for (const r of refused) {
	const c = certifyStream(new Uint8Array(readFileSync(r.file)), r.entry ?? 'update');
	if (c.kind !== 'refusal') continue;
	n++;
	if (!c.attempts.length) tally.whole![norm(c.reason)] = (tally.whole![norm(c.reason)] ?? 0) + 1;
	for (const a of c.attempts) {
		const t = tally[a.ring === ('gf2' as string) ? 'gf2' : a.ring]!;
		const k = norm(a.reason);
		t[k] = (t[k] ?? 0) + 1;
	}
}
writeFileSync(join(here, 'results', `hist2-${shard}.json`), JSON.stringify({ n, tally }));
console.log('hist2', shard, n);
