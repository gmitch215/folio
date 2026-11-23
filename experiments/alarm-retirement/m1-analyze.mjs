import { existsSync, readFileSync } from 'node:fs';
import { readTail } from './floor-tail.mjs';

// usage: node m1-analyze.mjs <out dir> <tail.jsonl>
// row combinations per reset kind and variant, reset counts with Wilson intervals, successor cost
const [outDir, tailPath] = process.argv.slice(2);
if (!outDir || !tailPath) throw new Error('usage: m1-analyze.mjs <out dir> <tail.jsonl>');
const records = (p) =>
	existsSync(p)
		? readFileSync(p, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const trials = records(`${outDir}/trials.jsonl`).filter((t) => t.label !== 'smoke');
const chains = records(`${outDir}/chains.jsonl`);
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
		wallMs: e.wallTime,
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
const median = (xs) => {
	const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};
const tally = (xs) => {
	const t = {};
	for (const x of xs) t[x ?? 'null'] = (t[x ?? 'null'] ?? 0) + 1;
	return Object.entries(t)
		.map(([k, v]) => `${k || '(none)'}:${v}`)
		.join(' ');
};

console.log('rows of the event after the reset, by kind and variant (read from a fresh stub)');
console.log(
	'kind    variant n   event class            rows after (count)           3 s later (count)'
);
const cells = {};
for (const t of trials.filter((x) => x.label === 'grid')) {
	(cells[`${t.kind} ${t.variant}`] ??= []).push(t);
}
for (const [cell, ts] of Object.entries(cells).sort()) {
	const [kind, variant] = cell.split(' ');
	console.log(
		`${kind.padEnd(7)} ${variant.padEnd(7)} ${String(ts.length).padEnd(3)} ${tally(ts.map((t) => t.eventCls)).padEnd(22)} ${tally(ts.map((t) => t.tags)).padEnd(28)} ${tally(ts.map((t) => t.lateTags))}`
	);
}

console.log('\ntail view of the killed events (outcome and exception of the DO invocation)');
for (const [cell, ts] of Object.entries(cells).sort()) {
	const tl = ts.map((t) => {
		const i = inv[`${t.object} e`];
		return i ? `${i.outcome}|${i.exception.slice(0, 60)}|cpu${i.cpuMs}` : 'no-tail-event';
	});
	console.log(`${cell}: ${tally(tl)}`);
}

console.log('\nstorage chains: resets with Wilson 95%');
const byArm = {};
for (const c of chains) (byArm[c.arm] ??= []).push(c);
for (const [arm, cs] of Object.entries(byArm)) {
	const resets = cs.filter((c) => c.resetEv !== null);
	const other = cs.filter((c) => c.stopCls && c.resetEv === null);
	const evs = cs.reduce((n, c) => n + c.events.length, 0);
	const okEvs = cs.reduce((n, c) => n + c.events.filter((e) => e.cls === 'ok').length, 0);
	const retire = cs.reduce((n, c) => n + c.events.filter((e) => e.isoChanged).length, 0);
	console.log(
		`${arm}: chains with a reset ${interval(resets.length, cs.length)}; other stops ${other.length}; events ${evs} (ok ${okEvs}); isolate changes on ok events ${retire}`
	);
	console.log(`  reset event number: ${resets.map((c) => c.resetEv).join(',')}`);
	console.log(`  rows of the reset event: ${tally(resets.map((c) => c.resetTags))}`);
	const full = arm === 'orig' ? 'mx' : 'mxyz';
	let incompleteBefore = 0;
	for (const c of cs) {
		const last = c.stopCls ? c.events.length : c.events.length + 1;
		for (let e = 1; e < last; e++) if (c.perEventTags[e] !== full) incompleteBefore++;
	}
	console.log(`  ok events before a stop whose rows are not ${full}: ${incompleteBefore}`);
	console.log(
		`  stop events that are not storage resets: ${tally(other.map((c) => `${c.stopCls}:${c.events.at(-1).error?.slice(0, 80)}`))}`
	);
	console.log(
		`  rows of those stop events: ${tally(other.map((c) => c.perEventTags[c.events.at(-1).ev] ?? ''))}`
	);
	console.log(`  stop event number: ${other.map((c) => c.events.at(-1).ev).join(',')}`);
}

console.log('\nsuccessor cost: first request after the reset against the warm one right after');
console.log(
	'source        n   fail(median,max)  toFirstOk ms (median)  first wall  warm wall  first cpu  warm cpu  instance differs at +3 s'
);
const sources = {
	'memory-during': trials.filter(
		(t) => t.label === 'grid' && t.kind === 'memory' && t.variant === 'during'
	),
	'memory-after': trials.filter(
		(t) => t.label === 'grid' && t.kind === 'memory' && t.variant === 'after'
	),
	'cpu-during': trials.filter(
		(t) => t.label === 'grid' && t.kind === 'cpu' && t.variant === 'during'
	),
	'cpu-after': trials.filter(
		(t) => t.label === 'grid' && t.kind === 'cpu' && t.variant === 'after'
	)
};
const row = (name, items) => {
	const rbs = items.map((x) => x.rb).filter((r) => r.firstWallMs !== null);
	const cpu1 = items.map((x) => inv[`${x.object} ${x.rb.firstTag}`]?.cpuMs ?? null);
	const cpu2 = items.map((x) => inv[`${x.object} ${x.rb.warmTag}`]?.cpuMs ?? null);
	const fails = rbs.map((r) => r.failures);
	const changed = items.filter((x) => x.rb.lateInst !== x.rb.firstInst).length;
	console.log(
		`${name.padEnd(13)} ${String(items.length).padEnd(3)} ${`${median(fails)},${Math.max(0, ...fails)}`.padEnd(17)} ${String(median(rbs.map((r) => r.toFirstSuccessMs))).padEnd(22)} ${String(median(rbs.map((r) => r.firstWallMs))).padEnd(11)} ${String(median(rbs.map((r) => r.warmWallMs))).padEnd(10)} ${`${median(cpu1)} (n${cpu1.filter((x) => x !== null).length})`.padEnd(10)} ${`${median(cpu2)} (n${cpu2.filter((x) => x !== null).length})`.padEnd(9)} ${changed}`
	);
};
for (const [name, items] of Object.entries(sources)) row(name, items);
const rowChain = (arm) => {
	const items = chains
		.filter((c) => c.arm === arm && c.resetEv !== null && c.rb)
		.map((c) => ({ object: c.object, rb: c.rb }));
	if (items.length) row(`storage-${arm}`, items);
};
rowChain('m1');
rowChain('orig');
rowChain('nowait');
const warmChains = chains.filter((c) => c.resetEv === null && c.stopCls === null);
console.log(`(chains that ended with no reset and no error: ${warmChains.length})`);

console.log('\nunreachable time and failures after each reset (per source)');
for (const [name, items] of Object.entries(sources)) {
	console.log(
		`${name}: toFirstOk ms ${items.map((x) => x.rb.toFirstSuccessMs).join(',')} | failures ${items.map((x) => x.rb.failures).join(',')}`
	);
}
for (const arm of Object.keys(byArm)) {
	const rs = byArm[arm].filter((c) => c.resetEv !== null && c.rb);
	if (rs.length)
		console.log(
			`storage-${arm}: toFirstOk ms ${rs.map((c) => c.rb.toFirstSuccessMs).join(',')} | failures ${rs.map((c) => c.rb.failures).join(',')} | first errors ${tally(rs.flatMap((c) => c.rb.errors))}`
		);
}
