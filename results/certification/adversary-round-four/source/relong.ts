import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Row, Rec } from './lib.ts';

// rows produced before the long-length check and the window fixes were added: run those again
const here = dirname(fileURLToPath(import.meta.url));
const rows = new Map<string, Row>();
for (const f of readdirSync(join(here, 'results')).sort())
	if (f.endsWith('.jsonl') && !f.startsWith('zrelong'))
		for (const l of readFileSync(join(here, 'results', f), 'utf8').split('\n'))
			if (l) {
				const r = JSON.parse(l) as Row;
				rows.set(r.id, r);
			}
const recs = new Map<string, Rec & { sha: string }>();
for (const f of readdirSync(here))
	if (/^(cg|ct|bm|wt|ds|control)-?.*\.jsonl$/.test(f) && !/^(cgA|cgB|ctA|dsA|wt[SPDA])\.jsonl$/.test(f))
		for (const l of readFileSync(join(here, f), 'utf8').split('\n'))
			if (l) {
				const r = JSON.parse(l);
				recs.set(r.id, r);
			}
const todo = [...rows.values()].filter((r) => r.checker === 'accepted' && !r.long && !r.id.startsWith('full/'));
writeFileSync(join(here, 'zrelong.jsonl'), todo.filter((r) => recs.has(r.id)).map((r) => JSON.stringify(recs.get(r.id))).join('\n') + '\n');
console.log('relong', todo.length, 'missing manifest', todo.filter((r) => !recs.has(r.id)).length);
