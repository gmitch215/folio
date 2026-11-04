import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Row } from './lib.ts';

// merge rows-*.json into modules.json and print the counts
const dir = process.argv[2];
if (!dir) throw new Error('usage: summarize.ts DIRECTORY [-v]');
const rows: Row[] = readdirSync(dir)
	.filter((f) => f.startsWith('rows-') && f.endsWith('.json'))
	.sort()
	.flatMap((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Row[]);

// a checker is only meant for its own form: stream-check for wrapper+transition, loop-check for inline loops
const formOf = (id: string) =>
	/loop$/.test(id) ? 'loop' : /stream$/.test(id) ? 'stream' : 'other';
const cross = (r: Row, k: 'stream' | 'loop') => formOf(r.id) !== 'other' && formOf(r.id) !== k;
for (const r of rows)
	for (const k of ['stream', 'loop'] as const)
		if (!r[k].accepted && cross(r, k) && r.class[k]?.includes('REFUSAL'))
			r.class[k] = 'cross-form-refusal';
writeFileSync(`${dir}/modules.json`, JSON.stringify(rows, null, 1), { flag: 'wx' });

const verbose = process.argv.includes('-v');
const t: Record<string, Record<string, number>> = { stream: {}, loop: {} };
const reasons: Record<string, Record<string, string[]>> = { stream: {}, loop: {} };
for (const r of rows)
	for (const k of ['stream', 'loop'] as const) {
		const c = r.class[k] ?? 'n/a';
		t[k]![c] = (t[k]![c] ?? 0) + 1;
		if (c === 'FALSE-REFUSAL' || c === 'refused-z2w-out-of-class') {
			if (cross(r, k)) continue;
			const key = `${c} | ${r[k].reason.replace(/\d+/g, 'N')}`;
			(reasons[k]![key] ??= []).push(r.id);
		}
	}
console.log('modules', rows.length);
for (const k of ['stream', 'loop'] as const) {
	const inForm: Record<string, number> = {};
	for (const r of rows)
		if (!cross(r, k) && r.class[k]) inForm[r.class[k]!] = (inForm[r.class[k]!] ?? 0) + 1;
	console.log('in-form', k, JSON.stringify(inForm));
}
console.log(JSON.stringify(t));
const groups: Record<string, number> = {};
for (const r of rows) groups[r.group] = (groups[r.group] ?? 0) + 1;
console.log(JSON.stringify(groups));
if (verbose)
	for (const k of ['stream', 'loop'] as const)
		for (const [key, ids] of Object.entries(reasons[k]!))
			console.log(k, ids.length, key, '::', ids.slice(0, 6).join(' '));
for (const r of rows)
	if (Object.values(r.class).some((v) => v === 'ACCEPTED-WRONG' || v === 'harness-error'))
		console.log(
			'ATTENTION',
			r.id,
			JSON.stringify(r.stream),
			JSON.stringify(r.loop),
			r.truth.firstFailure
		);
