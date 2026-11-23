import { existsSync, readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

// usage: node floor-cpu-analyze.mjs <out dir> <tail.jsonl>
// per cell: resets with a Wilson 95% interval; per request: the Durable Object's CPU and wall time from the tail,
// the reset text and the first floor-worker-cpu frame; per warm chain: the events in order
const [outDir, tailPath] = process.argv.slice(2);
if (!outDir || !tailPath) throw new Error('usage: floor-cpu-analyze.mjs <out dir> <tail.jsonl>');
const records = (p) =>
	existsSync(p)
		? readFileSync(p, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const fresh = records(`${outDir}/cpu.jsonl`);
const warm = records(`${outDir}/warm.jsonl`);
const tail = existsSync(tailPath) ? readTail(tailPath) : [];

const msgOf = (l) =>
	(Array.isArray(l.message) ? l.message.join(' ') : String(l.message ?? '')).trim();
const frameOf = (e) =>
	(e.exceptions ?? [])
		.map((x) => (x.stack ?? '').split('\n').find((l) => l.includes('floor-worker-cpu')) ?? '')
		.find(Boolean)
		?.trim() ?? '-';

// one Durable Object invocation per request, in tail order: the req line names the object
const invocations = {};
for (const e of [...tail].sort((a, b) => a.eventTimestamp - b.eventTimestamp)) {
	const req = (e.logs ?? [])
		.map(msgOf)
		.map((m) => m.match(/^req (\S+) slices=(\d+) arm=(\S+)$/))
		.find(Boolean);
	if (!req) continue;
	(invocations[req[1]] ??= []).push({
		cpuMs: e.cpuTime,
		wallMs: e.wallTime,
		outcome: e.outcome,
		exception: (e.exceptions ?? []).map((x) => x.message).join(' | '),
		frame: frameOf(e),
		loopEnd: (e.logs ?? []).map(msgOf).some((m) => m.startsWith('loop-end ')),
		version: e.scriptVersion?.id ?? null
	});
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
const median = (xs) => {
	const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};

const CS = [0, 0.25, 0.5, 1, 2, 4];
console.log('fresh objects: reset rate per C, Wilson 95%');
console.log('arm    C     n  resets  other  rate    interval         median DO cpuMs  cpuMs/slice');
for (const arm of ['none', 'alarm']) {
	for (const c of CS) {
		const rs = fresh.filter((r) => r.arm === arm && r.C === c);
		const n = rs.length;
		const resets = rs.filter((r) => r.cls === 'reset').length;
		const other = rs.filter((r) => r.cls !== 'reset' && r.cls !== 'ok').length;
		const [lo, hi] = wilson(resets, n);
		const cpus = rs.map((r) => invocations[r.object]?.[0]?.cpuMs ?? null);
		const med = median(cpus);
		const slices = Math.round(c / 0.25);
		const perSlice = med !== null && slices > 0 ? (med / slices).toFixed(1) : '-';
		console.log(
			`${arm.padEnd(6)} ${String(c).padEnd(5)} ${String(n).padEnd(3)} ${String(resets).padEnd(7)} ${String(other).padEnd(6)} ${pct(n ? resets / n : null).padEnd(7)} ${lo === null ? 'n/a' : `${pct(lo)} to ${pct(hi)}`.padEnd(16)} ${String(med).padEnd(16)} ${perSlice}`
		);
	}
}

console.log('\nfresh requests: class, slices, actualMs, error, DO outcome, DO frame');
for (const r of [...fresh].sort((a, b) => a.order - b.order)) {
	const inv = invocations[r.object]?.[0];
	console.log(
		`order=${r.order} arm=${r.arm} C=${r.C} cls=${r.cls} slices=${r.slices} actualMs=${r.actualMs} codeUpdated=${r.codeUpdated} | cpuMs=${inv?.cpuMs ?? null} wallMs=${inv?.wallMs ?? null} outcome=${inv?.outcome ?? null} loopEnd=${inv?.loopEnd ?? null} version=${inv?.version ?? null} |${r.error ?? ''} | ${inv?.frame ?? '-'}`
	);
}

console.log('\nwarm chains (C = 1 s, no alarm): events in order, cls and isolate id');
for (const ch of warm) {
	const invs = invocations[ch.object] ?? [];
	const cells = ch.events.map(
		(e, i) => `${e.ev}:${e.cls}:${e.iso ?? '-'}:cpu${invs[i]?.cpuMs ?? '-'}`
	);
	const resetAt = ch.events.filter((e) => e.cls === 'reset').map((e) => e.ev);
	console.log(`c=${ch.c} resets=${resetAt.length} at=[${resetAt.join(',')}] ${cells.join(' ')}`);
}

const tallies = {};
for (const r of fresh.concat(warm.flatMap((c) => c.events))) {
	if (r.cls === 'ok') continue;
	const key = `${r.cls}: ${r.error ?? ''}`;
	tallies[key] = (tallies[key] ?? 0) + 1;
}
console.log('\nnon-ok error texts and counts');
for (const [k, v] of Object.entries(tallies)) console.log(`${v} x ${k}`);
