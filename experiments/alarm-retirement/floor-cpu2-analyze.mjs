import { existsSync, readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

// usage: node floor-cpu2-analyze.mjs <out dir> <tail.jsonl>
// per cell: resets with a Wilson 95% interval, measured CPU from the tail, alarm invocations and their resets;
// then the sorted measured CPU of resets and of ok requests per C, to read the dose against the reset
const [outDir, tailPath] = process.argv.slice(2);
if (!outDir || !tailPath) throw new Error('usage: floor-cpu2-analyze.mjs <out dir> <tail.jsonl>');
const fresh = existsSync(`${outDir}/cpu2.jsonl`)
	? readFileSync(`${outDir}/cpu2.jsonl`, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	: [];
const tail = existsSync(tailPath) ? readTail(tailPath) : [];

const msgOf = (l) =>
	(Array.isArray(l.message) ? l.message.join(' ') : String(l.message ?? '')).trim();
const frameOf = (e) =>
	(e.exceptions ?? [])
		.map((x) => (x.stack ?? '').split('\n').find((l) => l.includes('floor-worker-cpu2')) ?? '')
		.find(Boolean)
		?.trim() ?? '-';

const reqs = {};
const alarms = {};
for (const e of [...tail].sort((a, b) => a.eventTimestamp - b.eventTimestamp)) {
	const logs = (e.logs ?? []).map(msgOf);
	const req = logs.map((m) => m.match(/^req (\S+) slices=(\d+) alarm=(\S+)$/)).find(Boolean);
	const al = logs.map((m) => m.match(/^alarm (\S+) left=(\d+)$/)).find(Boolean);
	const info = {
		cpuMs: e.cpuTime,
		wallMs: e.wallTime,
		outcome: e.outcome,
		exception: (e.exceptions ?? []).map((x) => x.message).join(' | '),
		frame: frameOf(e),
		loopEnd: logs.some((m) => m.startsWith('loop-end ')),
		version: e.scriptVersion?.id ?? null
	};
	if (req) (reqs[req[1]] ??= []).push(info);
	if (al) (alarms[al[1]] ??= []).push({ ...info, left: Number(al[2]) });
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
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const median = (xs) => {
	const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};

const CELLS = [
	['storage', 1, 'none'],
	['storage', 2, 'none'],
	['storage', 4, 'none'],
	['storage', 8, 'none'],
	['cadence', 2, 'cadence'],
	['cadence', 2, 'none'],
	['cadence', 4, 'cadence'],
	['cadence', 4, 'none']
];
console.log(
	'cell (arm C alarm): n, resets, rate, Wilson 95%, median measured cpuMs, alarm runs, alarm runs that reset'
);
for (const [arm, c, alarm] of CELLS) {
	const rs = fresh.filter((r) => r.arm === arm && r.C === c && r.alarm === alarm);
	const n = rs.length;
	const resets = rs.filter((r) => r.cls === 'reset').length;
	const [lo, hi] = wilson(resets, n);
	const cpus = rs.map((r) => reqs[r.object]?.[0]?.cpuMs ?? null);
	let alarmRuns = 0;
	let alarmResets = 0;
	for (const r of rs) {
		for (const a of alarms[r.object] ?? []) {
			alarmRuns++;
			if (String(a.exception).includes('reset')) alarmResets++;
		}
	}
	console.log(
		`${arm} C=${c} alarm=${alarm}: n=${n} resets=${resets} rate=${n ? pct(resets / n) : 'n/a'} interval=${lo === null ? 'n/a' : `${pct(lo)} to ${pct(hi)}`} medianCpuMs=${median(cpus)} alarmRuns=${alarmRuns} alarmResets=${alarmResets}`
	);
}

console.log('\nmeasured CPU ms per request (sorted), by reset or ok');
for (const [arm, c, alarm] of CELLS) {
	const rs = fresh.filter((r) => r.arm === arm && r.C === c && r.alarm === alarm);
	const cpuOf = (r) => reqs[r.object]?.[0]?.cpuMs ?? null;
	const res = rs
		.filter((r) => r.cls === 'reset')
		.map(cpuOf)
		.sort((a, b) => a - b);
	const ok = rs
		.filter((r) => r.cls === 'ok')
		.map(cpuOf)
		.sort((a, b) => a - b);
	console.log(`${arm} C=${c} alarm=${alarm}: reset [${res.join(', ')}] ok [${ok.join(', ')}]`);
}

console.log(
	'\nall requests: arm, C, alarm, cls, slices, actualMs, measured cpu, outcome, frame, error'
);
for (const r of [...fresh].sort((a, b) => a.order - b.order)) {
	const inv = reqs[r.object]?.[0];
	console.log(
		`order=${r.order} ${r.arm} C=${r.C} alarm=${r.alarm} cls=${r.cls} slices=${r.slices} actualMs=${r.actualMs} cpuMs=${inv?.cpuMs ?? null} wallMs=${inv?.wallMs ?? null} loopEnd=${inv?.loopEnd ?? null} version=${inv?.version ?? null} | ${r.error ?? ''} | ${inv?.frame ?? '-'}`
	);
}

const alarmReset = Object.entries(alarms).filter(([, runs]) =>
	runs.some((a) => String(a.exception).includes('reset'))
);
console.log(`\nalarm runs with a reset: ${alarmReset.length} objects`);
for (const [obj, runs] of alarmReset) {
	for (const a of runs)
		if (String(a.exception).includes('reset'))
			console.log(`${obj} left=${a.left} cpuMs=${a.cpuMs} | ${a.exception} | ${a.frame}`);
}
