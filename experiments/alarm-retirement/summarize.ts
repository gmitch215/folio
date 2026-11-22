import { existsSync, readFileSync } from 'node:fs';

// reads first-event.jsonl and chain.jsonl from one run directory and prints the tables
const dir = process.argv[2];
if (!dir) throw new Error('usage: summarize.ts <run dir>');

type Row = Record<string, any>;

const load = (f: string): Row[] =>
	existsSync(f)
		? readFileSync(f, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Row)
		: [];
const first = load(`${dir}/first-event.jsonl`);
const chain = load(`${dir}/chain.jsonl`);

const z = 1.959963984540054;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
function wilson(k: number, n: number): [number, number] {
	if (n === 0) return [0, 1];
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = (p + (z * z) / (2 * n)) / d;
	const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
	return [Math.max(0, c - h), Math.min(1, c + h)];
}
const ci = (k: number, n: number) => {
	const [lo, hi] = wilson(k, n);
	return `${k}/${n} [${pct(lo)}, ${pct(hi)}]`;
};
const armsOf = (rows: Row[]): string[] => [...new Set(rows.map((r) => r.arm as string))];
const med = (a: number[]) => {
	if (a.length === 0) return 'n/a';
	const s = [...a].sort((x, y) => x - y);
	return String(s[s.length >> 1]);
};
const span = (a: number[]) =>
	a.length === 0
		? 'n/a'
		: `${med(a)} (min ${Math.min(...a)}, max ${Math.max(...a)}, n ${a.length})`;
const STATES = ['both', 'neither', 'M-only', 'E-only'];

console.log(`first-event rows ${first.length}, chain rows ${chain.length}`);

console.log('');
console.log('## First event');
console.log(
	'| Arm | n | ok | reset | other | instance changed | read fail | reset rate (95%) | reset samples both/neither/M-only/E-only | alarm ahead at read-back, ms (median) |'
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |');
for (const arm of armsOf(first)) {
	const r = first.filter((x) => x.arm === arm);
	const rs = r.filter((x) => x.eventCls === 'storage_reset');
	const states = STATES.map((s) => rs.filter((x) => x.state === s).length).join('/');
	const ahead = r
		.map((x) => x.readAlarmAheadMs as number | null)
		.filter((x): x is number => typeof x === 'number');
	console.log(
		`| ${arm} | ${r.length} | ${r.filter((x) => x.eventCls === 'ok').length} | ${rs.length} | ${r.filter((x) => x.eventCls !== 'ok' && x.eventCls !== 'storage_reset').length} | ${r.filter((x) => x.instChanged === true).length} | ${r.filter((x) => !x.readOk).length} | ${ci(rs.length, r.length)} | ${states} | ${med(ahead)} |`
	);
}

const chains = new Map<string, Row[]>();
for (const r of chain) chains.set(r.object, [...(chains.get(r.object) ?? []), r]);

console.log('');
console.log('## Chains');
console.log(
	'| Arm | chains | events | ok | reset | other | chains with reset (95%) | reset chains with isolate change before first reset | chains with isolate change | retirements | resets | resets per retirement | first retirement or reset, event (median, min, max, n) | alarmRuns at first event, median | existingMs null / non-null on ok events |'
);
console.log(
	'| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |'
);
for (const arm of armsOf(chain)) {
	const seqs = [...chains.values()]
		.filter((ev) => ev[0]?.arm === arm)
		.map((ev) => ev.slice().sort((a, b) => a.ev - b.ev));
	const r = chain.filter((x) => x.arm === arm);
	let withReset = 0;
	let withChange = 0;
	let beforeReset = 0;
	let retire = 0;
	let resets = 0;
	const firstEv: number[] = [];
	const runsAtFirst: number[] = [];
	for (const ev of seqs) {
		let prev: string | null = null;
		let lastRuns: number | null = null;
		let first: number | null = null;
		let firstRuns: number | null = null;
		let chainRetire = 0;
		let chainReset = 0;
		let changeBefore = false;
		for (const x of ev) {
			if (x.reset) {
				chainReset++;
				if (first === null) {
					first = x.ev;
					firstRuns = lastRuns;
				}
				continue;
			}
			if (!x.eventOk) continue;
			if (prev !== null && x.iso !== prev) {
				chainRetire++;
				if (first === null) {
					first = x.ev;
					firstRuns = x.alarmRuns;
					changeBefore = true;
				}
			}
			prev = x.iso;
			lastRuns = x.alarmRuns;
		}
		if (chainReset > 0) {
			withReset++;
			if (changeBefore) beforeReset++;
		}
		if (chainRetire > 0) withChange++;
		retire += chainRetire;
		resets += chainReset;
		if (first !== null) {
			firstEv.push(first);
			if (firstRuns !== null) runsAtFirst.push(firstRuns);
		}
	}
	const okRows = r.filter((x) => x.eventOk);
	const exist = okRows.filter((x) => typeof x.existingMs === 'number').length;
	const per = retire > 0 ? (resets / retire).toFixed(2) : 'n/a';
	console.log(
		`| ${arm} | ${seqs.length} | ${r.length} | ${okRows.length} | ${r.filter((x) => x.reset).length} | ${r.filter((x) => !x.eventOk && !x.reset).length} | ${ci(withReset, seqs.length)} | ${beforeReset} | ${withChange} | ${retire} | ${resets} | ${per} | ${span(firstEv)} | ${med(runsAtFirst)} | ${okRows.length - exist} / ${exist} |`
	);
}

console.log('');
console.log('## Isolate changes on ok events, by event index');
const bins: [number, number][] = [
	[1, 3],
	[4, 6],
	[7, 12],
	[13, 24]
];
console.log('| Arm | 1-3 | 4-6 | 7-12 | 13-24 |');
console.log('| --- | --- | --- | --- | --- |');
for (const arm of armsOf(chain)) {
	const cells = bins.map(([lo, hi]) => {
		const evs = chain.filter((e) => e.arm === arm && e.ev >= lo && e.ev <= hi && e.eventOk);
		return `${evs.filter((e) => e.isoChanged === true).length}/${evs.length}`;
	});
	console.log(`| ${arm} | ${cells.join(' | ')} |`);
}

console.log('');
console.log('## Failures other than storage reset');
const bad = [...first, ...chain].filter(
	(x) => x.eventCls !== 'ok' && x.eventCls !== 'storage_reset'
);
const counts = new Map<string, number>();
for (const x of bad) {
	const key = `${x.arm} ${x.eventCls}: ${x.eventError}`;
	counts.set(key, (counts.get(key) ?? 0) + 1);
}
if (counts.size === 0) console.log('none');
for (const [k, n] of counts) console.log(`${n} x ${k}`);
