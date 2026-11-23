import { existsSync, readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

// usage: node sync-analyze.mjs <out dir> <tail.jsonl>
// row combinations per flush arm with Wilson intervals, injected counts and the tail outcome
const [outDir, tailPath] = process.argv.slice(2);
if (!outDir || !tailPath) throw new Error('usage: sync-analyze.mjs <out dir> <tail.jsonl>');
const records = (p) =>
	existsSync(p)
		? readFileSync(p, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const trials = records(`${outDir}/trials.jsonl`).filter((t) => t.label === 'grid');
const tail = existsSync(tailPath) ? readTail(tailPath) : [];

const msgOf = (l) =>
	(Array.isArray(l.message) ? l.message.join(' ') : String(l.message ?? '')).trim();
const inv = {};
for (const e of tail) {
	const req = (e.logs ?? [])
		.map(msgOf)
		.map((m) => m.match(/^req (\S+) (\S+) /))
		.find(Boolean);
	if (!req) continue;
	inv[`${req[1]} ${req[2]}`] = {
		cpuMs: e.cpuTime,
		outcome: e.outcome,
		exception: (e.exceptions ?? []).map((x) => x.message).join(' | ')
	};
}

function wilson(k, n) {
	if (n === 0) return [null, null];
	const z = 1.96;
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = (p + (z * z) / (2 * n)) / d;
	const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
	return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const interval = (k, n) => {
	const [lo, hi] = wilson(k, n);
	return `${k}/${n} [${pct(lo)}, ${pct(hi)}]`;
};
const tally = (xs) => {
	const t = {};
	for (const x of xs) t[x ?? 'null'] = (t[x ?? 'null'] ?? 0) + 1;
	return Object.entries(t)
		.map(([k, v]) => `${k || '(none)'}:${v}`)
		.join(' ');
};

const arms = ['none', 'sync', 'syncyield'];
console.log('rows of the killed event after the reset, by flush arm (read from a fresh stub)');
for (const arm of arms) {
	const all = trials.filter((t) => t.arm === arm);
	const ts = all.filter((t) => t.injected);
	const kept = ts.filter((t) => t.tags === 'my').length;
	const lost = ts.filter((t) => t.tags === '').length;
	console.log(
		`${arm}: n=${ts.length} injected=false ${all.length - ts.length}; rows ${tally(ts.map((t) => t.tags))}; 3 s later ${tally(ts.map((t) => t.lateTags))}`
	);
	console.log(
		`  both rows kept ${interval(kept, ts.length)}; no rows ${interval(lost, ts.length)}`
	);
	console.log(
		`  by pass: ${[0, 1].map((p) => `p${p} ${tally(ts.filter((t) => t.pass === p).map((t) => t.tags))}`).join(' | ')}`
	);
	console.log(`  event result at the caller: ${tally(ts.map((t) => t.eventCls))}`);
	const tl = ts.map((t) => {
		const i = inv[`${t.object} e`];
		return i ? `${i.outcome}|${i.exception.slice(0, 60)}` : 'no-tail-event';
	});
	console.log(`  tail: ${tally(tl)}`);
	console.log(`  read-back failures before the first ok: ${tally(ts.map((t) => t.failures))}`);
	console.log(
		`  isolate ids on the first read-back: ${new Set(ts.map((t) => t.firstIso)).size} distinct of ${ts.length}`
	);
}
