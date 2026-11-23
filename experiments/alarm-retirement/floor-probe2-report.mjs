// usage: node floor-probe2-report.mjs <probe jsonl> <tail.jsonl>
// one row per request: variant, status, actualMs, slices, the error text, the first Floor frame, the version id,
// and whether the tail holds an alarm line for the object (the alarm handler logs `alarm <object>`)
import { existsSync, readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

const [probePath, tailPath] = process.argv.slice(2);
if (!probePath || !tailPath)
	throw new Error('usage: floor-probe2-report.mjs <probe jsonl> <tail.jsonl>');
const recs = readFileSync(probePath, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l));
const tail = existsSync(tailPath) ? readTail(tailPath) : [];

const alarmed = new Set();
const byObject = {};
for (const e of tail) {
	for (const l of e.logs ?? []) {
		const msg = (
			Array.isArray(l.message) ? l.message.join(' ') : String(l.message ?? '')
		).trim();
		const m = msg.match(/^alarm (\S+)$/);
		if (m) alarmed.add(m[1]);
	}
	const obj = new URL(e.event?.request?.url ?? 'http://x/').searchParams.get('do');
	if (!obj) continue;
	const t = (byObject[obj] ??= { version: null, stacks: [] });
	t.version ??= e.scriptVersion?.id ?? null;
	for (const x of e.exceptions ?? []) {
		const frame = (x.stack ?? '').split('\n').find((l) => l.includes('floor-worker')) ?? '';
		t.stacks.push(frame.trim());
	}
}

console.log('variant object status actualMs slices error | stack frame | alarm line | version');
for (const r of recs) {
	const t = byObject[r.object] ?? { version: null, stacks: [] };
	const frame = [...new Set(t.stacks)].join(' ; ') || '-';
	console.log(
		`${r.variant} ${r.object} ${r.status} ${r.actualMs} ${r.slices} "${r.error ?? ''}" | ${frame} | ${alarmed.has(r.object) ? 'alarm' : 'none'} | ${t.version}`
	);
}
