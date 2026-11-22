import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const arms = (
	process.env.ARMS ??
	'no-alarm,alarm-2s-committed,alarm-1ms-unawaited,alarm-20min-committed,alarm-2s-committed-sliced'
).split(',');
const objects = Number(process.env.OBJECTS ?? 3);
const events = Number(process.env.EVENTS ?? 20);
const cpu = Number(process.env.CPU ?? 1000);
const gap = Number(process.env.GAP ?? 1500);
const trailGap = Number(process.env.TRAIL_GAP ?? 3000);
const samples = Number(process.env.SAMPLES ?? 20);
const outDir = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const run = Date.now();

const storageRe = /Internal error in Durable Object storage/;
const storageTimeoutRe = /exceeded timeout/;
const memoryRe = /memory limit/i;
const cpuRe = /cpu time|cpu limit|exceeded cpu/i;

const firstCpu: Record<string, number> = {
	'burn-then-write': 230,
	'alarm-unawaited-then-burn': 230,
	'alarm-awaited-then-burn': 230,
	'alarm-unawaited-short-burn': 46,
	'alarm-unawaited-long-burn': 460,
	'alarm-20min-unawaited-then-burn': 230,
	'alarm-unawaited-no-burn': 0,
	'prior-burn-then-alarm-unawaited': 230,
	'alarm-awaited-synced-then-burn': 230,
	'burn-then-alarm-unawaited': 230,
	'burn-then-alarm-awaited-sync': 230,
	'burn-then-alarm-unawaited-sync': 230,
	'burn-then-alarm-unawaited-wait': 230,
	'write-sync-then-burn-alarm-unawaited': 230,
	'burn-then-alarm-awaited-wait': 230,
	'burn-write-then-alarm-20min-unawaited': 230
};
const preCpu = 200;

type Reply = { inst: string; arm: string; seq: number; fires: number; atStart: number };

type Wrapped = { ok: boolean; error?: string; body?: Reply };

type Outcome = { ok: true; body: Reply } | { ok: false; message: string };

type Got = {
	ok: boolean;
	inst: string | null;
	fires: number | null;
	atStart: number | null;
	error: string | null;
};

type Kind = 'warm' | 'event' | 'trailing';

type Rec = {
	object: number;
	kind: Kind;
	ok: boolean;
	seq: number | null;
	inst: string | null;
	fires: number | null;
	firesAfterEnd: number | null;
	wallMs: number;
	error: string | null;
};

type Tally = { ok: number; storage: number; memory: number; cpu: number; other: number };

type Totals = {
	arm: string;
	events: number;
	counted: Tally;
	warm: Tally;
	trailingFailed: number;
	instanceChanges: number;
	fires: number;
	firesAfterEnd: number;
	firesInEvent: number;
	wallMs: number[];
	errors: string[];
	records: Rec[];
};

type FirstRec = {
	arm: string;
	sample: number;
	object: string;
	before: string | null;
	pre: Got | null;
	preChanged: boolean | null;
	event: Got & { cls: string | null; wallMs: number };
	trail: Got;
	changed: boolean | null;
	resetAfterOk: boolean;
	firesInEvent: number | null;
	firesAfterEnd: number | null;
};

const tally = (): Tally => ({ ok: 0, storage: 0, memory: 0, cpu: 0, other: 0 });

const zero = (arm: string): Totals => ({
	arm,
	events: 0,
	counted: tally(),
	warm: tally(),
	trailingFailed: 0,
	instanceChanges: 0,
	fires: 0,
	firesAfterEnd: 0,
	firesInEvent: 0,
	wallMs: [],
	errors: [],
	records: []
});

const addDistinct = (list: string[], msg: string) => {
	if (list.length < 5 && !list.includes(msg)) list.push(msg);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function wilson(k: number, n: number): [number, number] {
	if (n === 0) return [0, 1];
	const z = 1.959963984540054;
	const z2 = z * z;
	const p = k / n;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

function median(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? (s[m] ?? NaN) : ((s[m - 1] ?? NaN) + (s[m] ?? NaN)) / 2;
}

async function send(name: string, arm: string, burnCpu: number = cpu): Promise<Outcome> {
	try {
		const res = await fetch(`${base}/?do=${name}&arm=${arm}&cpu=${burnCpu}`);
		const text = await res.text();
		const wrapped = JSON.parse(text) as Wrapped;
		if (res.status === 200 && wrapped.ok && wrapped.body)
			return { ok: true, body: wrapped.body };
		return { ok: false, message: wrapped.error ?? `status ${res.status}` };
	} catch (e) {
		return { ok: false, message: `client:${String(e).slice(0, 120)}` };
	}
}

function unpack(o: Outcome): Got {
	if (o.ok)
		return {
			ok: true,
			inst: o.body.inst,
			fires: o.body.fires,
			atStart: o.body.atStart,
			error: null
		};
	return { ok: false, inst: null, fires: null, atStart: null, error: o.message };
}

function classify(c: Tally, message: string) {
	if (storageRe.test(message)) c.storage++;
	else if (memoryRe.test(message)) c.memory++;
	else if (cpuRe.test(message)) c.cpu++;
	else c.other++;
}

function eventClass(message: string): string {
	if (storageRe.test(message)) return 'storage reset';
	if (storageTimeoutRe.test(message)) return 'storage timeout';
	if (memoryRe.test(message)) return 'memory';
	if (cpuRe.test(message)) return 'cpu-limit';
	return 'other';
}

async function runArm(arm: string): Promise<Totals> {
	const t = zero(arm);
	for (let o = 0; o < objects; o++) {
		const name = `ov${arm}-${run}-${o}`;
		let last: string | null = null;
		let prev: Rec | null = null;

		const step = async (kind: Kind) => {
			const sendArm = kind === 'trailing' ? 'T' : arm;
			const t0 = performance.now();
			const outcome = await send(name, sendArm);
			const wallMs = performance.now() - t0;
			const bucket = kind === 'warm' ? t.warm : t.counted;
			if (kind === 'event') t.events++;
			const rec: Rec = {
				object: o,
				kind,
				ok: outcome.ok,
				seq: null,
				inst: null,
				fires: null,
				firesAfterEnd: null,
				wallMs,
				error: null
			};
			if (outcome.ok) {
				const b = outcome.body;
				rec.seq = b.seq;
				rec.inst = b.inst;
				rec.fires = b.fires;
				t.fires += b.fires;
				// atStart counts fires that ran before this request began, i.e. after the previous reply
				if (prev) {
					prev.firesAfterEnd = b.atStart;
					t.firesAfterEnd += b.atStart;
				}
				t.firesInEvent += b.fires - b.atStart;
				bucket.ok++;
				if (kind === 'event') {
					if (last !== null && b.inst !== last) t.instanceChanges++;
					last = b.inst;
					t.wallMs.push(wallMs);
				}
				prev = rec;
			} else {
				rec.error = outcome.message;
				addDistinct(t.errors, outcome.message);
				if (kind === 'trailing') t.trailingFailed++;
				else classify(bucket, outcome.message);
				prev = null;
			}
			t.records.push(rec);
		};

		await step('warm');
		await sleep(gap);
		for (let e = 0; e < events; e++) {
			await step('event');
			if (e < events - 1) await sleep(gap);
		}
		await sleep(trailGap);
		await step('trailing');
	}
	return t;
}

async function sampleOnce(arm: string, k: number, errors: string[]): Promise<FirstRec> {
	const object = `fe${arm}-${run}-${k}`;
	const probe = unpack(await send(object, 'P', 0));
	const before = probe.inst;

	let pre: Got | null = null;
	let preChanged: boolean | null = null;
	if (arm === 'prior-burn-then-alarm-unawaited') {
		pre = unpack(await send(object, 'PRE', preCpu));
		if (pre.error) addDistinct(errors, pre.error);
		preChanged = pre.inst !== null && before !== null ? pre.inst !== before : null;
	}

	const t0 = performance.now();
	const ev = unpack(await send(object, arm, firstCpu[arm] ?? cpu));
	const wallMs = performance.now() - t0;
	if (ev.error) addDistinct(errors, ev.error);

	await sleep(3000);
	const tr = unpack(await send(object, 'P', 0));
	if (tr.error) addDistinct(errors, tr.error);

	const resetAfterOk = ev.ok && tr.ok && tr.inst !== ev.inst;
	const after = ev.ok ? ev.inst : tr.inst;
	const changed = after !== null && before !== null ? after !== before : null;
	const firesInEvent =
		ev.ok && ev.fires !== null && ev.atStart !== null ? ev.fires - ev.atStart : null;
	const firesAfterEnd = ev.ok && tr.ok && !resetAfterOk ? tr.atStart : null;

	return {
		arm,
		sample: k,
		object,
		before,
		pre,
		preChanged,
		event: { ...ev, cls: ev.ok ? null : eventClass(ev.error ?? ''), wallMs },
		trail: tr,
		changed,
		resetAfterOk,
		firesInEvent,
		firesAfterEnd
	};
}

function summarizeFirst(arm: string, recs: FirstRec[], errors: string[]) {
	const n = recs.length;
	const ok = recs.filter((r) => r.event.ok).length;
	const count = (cls: string) => recs.filter((r) => r.event.cls === cls).length;
	const storage = count('storage reset');
	const timeout = count('storage timeout');
	const memory = count('memory');
	const cpuLimit = count('cpu-limit');
	const other = count('other');
	const failed = n - ok;
	const changed = recs.filter((r) => r.changed === true).length;
	const resetAfterOk = recs.filter((r) => r.resetAfterOk).length;
	const inEvent = recs.filter((r) => (r.firesInEvent ?? 0) > 0).length;
	const afterEnd = recs.filter((r) => (r.firesAfterEnd ?? 0) > 0).length;
	const wall = recs.map((r) => r.event.wallMs);
	const [slo, shi] = wilson(storage, n);
	const [flo, fhi] = wilson(failed, n);
	for (const r of recs) if (r.event.error) addDistinct(errors, r.event.error);
	return {
		arm,
		samples: n,
		ok,
		storageReset: storage,
		storageTimeout: timeout,
		memory,
		cpuLimit,
		other,
		instanceChanged: changed,
		resetAfterOk,
		firesInEventSamples: inEvent,
		firesAfterEndSamples: afterEnd,
		medianWallMs: Math.round(median(wall)),
		storageRate: storage / n,
		storageWilson: [slo, shi] as [number, number],
		failRate: failed / n,
		failWilson: [flo, fhi] as [number, number]
	};
}

async function runFirst(arm: string) {
	const recs: FirstRec[] = [];
	const errors: string[] = [];
	for (let k = 0; k < samples; k++) {
		recs.push(await sampleOnce(arm, k, errors));
		await sleep(gap);
	}
	const s = summarizeFirst(arm, recs, errors);
	console.log(
		`${s.arm} samples=${s.samples} ok=${s.ok} storageReset=${s.storageReset} ` +
			`storageTimeout=${s.storageTimeout} memory=${s.memory} cpuLimit=${s.cpuLimit} ` +
			`other=${s.other} instanceChanged=${s.instanceChanged} resetAfterOk=${s.resetAfterOk} ` +
			`firesInEvent>0=${s.firesInEventSamples} firesAfterEnd>0=${s.firesAfterEndSamples} ` +
			`medianWallMs=${s.medianWallMs} storageRate=${pct(s.storageRate)} ` +
			`storageWilson95=[${pct(s.storageWilson[0])}, ${pct(s.storageWilson[1])}] ` +
			`failRate=${pct(s.failRate)} failWilson95=[${pct(s.failWilson[0])}, ${pct(s.failWilson[1])}]`
	);
	if (errors.length > 0) console.log(`  errors: ${JSON.stringify(errors)}`);
	return { summary: s, errors, records: recs };
}

const out: Totals[] = [];
const firstOut: Awaited<ReturnType<typeof runFirst>>[] = [];
for (const arm of arms) {
	if (arm in firstCpu) {
		firstOut.push(await runFirst(arm));
		continue;
	}
	const t = await runArm(arm);
	out.push(t);
	const c = t.counted;
	const w = t.warm;
	const [lo, hi] = wilson(c.storage, t.events);
	console.log(
		`${t.arm} events=${t.events} ok=${c.ok} storage=${c.storage} memory=${c.memory} ` +
			`cpu=${c.cpu} other=${c.other} trailingFailed=${t.trailingFailed} ` +
			`instanceChanges=${t.instanceChanges} fires=${t.fires} firesAfterEnd=${t.firesAfterEnd} ` +
			`firesInEvent=${t.firesInEvent} medianWallMs=${Math.round(median(t.wallMs))} ` +
			`storageRate=${pct(c.storage / t.events)} wilson95=[${pct(lo)}, ${pct(hi)}]`
	);
	const withN = t.events + objects;
	const withStorage = c.storage + w.storage;
	const [wlo, whi] = wilson(withStorage, withN);
	console.log(
		`  with warm-up: events=${withN} storage=${withStorage} memory=${c.memory + w.memory} ` +
			`cpu=${c.cpu + w.cpu} other=${c.other + w.other} ` +
			`storageRate=${pct(withStorage / withN)} wilson95=[${pct(wlo)}, ${pct(whi)}]`
	);
	console.log(
		`  warm-up only: ok=${w.ok} storage=${w.storage} memory=${w.memory} cpu=${w.cpu} other=${w.other}`
	);
	if (t.errors.length > 0) console.log(`  errors: ${JSON.stringify(t.errors)}`);
}

mkdirSync(outDir, { recursive: true });
if (out.length > 0) {
	const file = `${outDir}/overlap-${run}.json`;
	writeFileSync(
		file,
		`${JSON.stringify({ run, objects, events, cpu, gap, trailGap, warmUp: true, arms: out }, null, '\t')}\n`
	);
	console.log(`wrote ${file}`);
}
if (firstOut.length > 0) {
	const file = `${outDir}/first-${run}.json`;
	writeFileSync(
		file,
		`${JSON.stringify({ run, samples, gap, firstCpu, preCpu, arms: firstOut }, null, '\t')}\n`
	);
	console.log(`wrote ${file}`);
}
