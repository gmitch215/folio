import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name}`);
	return value;
}

const WORKER = required('WORKER_URL');
const list = (value: string): string[] =>
	value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
const ARMS = list(process.env.ARMS ?? '');
const KINDS = ARMS.length > 0 ? [] : list(process.env.KINDS ?? 'ab,wasm,str');
const RUNGS = list(process.env.RUNGS ?? '96,128,160,176,192,208,224,256').map(Number);
const SAMPLES = Number(process.env.SAMPLES ?? 6);
const SWAP = ARMS.length === 0 && process.env.SWAP !== '0';
const SWAP_MIBS = list(process.env.SWAP_MIBS ?? '64,96,112').map(Number);
const SWAP_DELAYS = list(process.env.SWAP_DELAYS ?? '0,5000,30000').map(Number);
const OUT = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 90000);
const RUN = Date.now().toString(36);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Reply {
	ok: boolean;
	inst?: string;
	error?: string;
	held?: number;
}

type Outcome = 'ok' | 'reset' | 'other';

interface Sample {
	kind: string;
	mib: number;
	delay: number | null;
	object: string;
	outcome: Outcome;
	error: string | null;
	plainError: string | null;
	instChanged: boolean | null;
}

async function call(name: string, query: Record<string, string>): Promise<Reply> {
	const url = new URL(WORKER);
	url.searchParams.set('do', name);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		return (await res.json()) as Reply;
	} catch (error) {
		return {
			ok: false,
			error: `transport: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

async function sample(kind: string, mib: number, delay: number | null = null): Promise<Sample> {
	const object = `ladder-${RUN}-${kind}-${mib}-${delay ?? 0}-${Math.random().toString(36).slice(2, 8)}`;
	const query: Record<string, string> = { kind, mib: String(mib), touch: '1' };
	if (delay !== null) query.delay = String(delay);
	const first = await call(object, query);
	const plain = await call(object, { kind: 'free' });
	const outcome: Outcome = first.ok
		? 'ok'
		: first.error?.includes('memory limit')
			? 'reset'
			: 'other';
	const instChanged =
		first.ok && first.inst !== undefined && plain.inst !== undefined
			? first.inst !== plain.inst
			: null;
	return {
		kind,
		mib,
		delay,
		object,
		outcome,
		error: first.ok ? null : (first.error ?? 'no message'),
		plainError: plain.ok ? null : (plain.error ?? 'no message'),
		instChanged
	};
}

interface Tally {
	n: number;
	ok: number;
	reset: number;
	other: number;
	instChanged: number;
}

function tally(rows: Sample[]): Tally {
	const t: Tally = { n: rows.length, ok: 0, reset: 0, other: 0, instChanged: 0 };
	for (const r of rows) {
		t[r.outcome] += 1;
		if (r.instChanged) t.instChanged += 1;
	}
	return t;
}

const fmt = (t: Tally) =>
	`ok=${t.ok} reset=${t.reset} other=${t.other} instChanged=${t.instChanged} of ${t.n}`;

const samples: Sample[] = [];
const report = (value: unknown) => {
	mkdirSync(OUT, { recursive: true });
	const file = `${OUT}/ladder-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
	writeFileSync(file, JSON.stringify(value, null, '\t'));
	return file;
};
const config = { KINDS, RUNGS, SAMPLES, SWAP, SWAP_MIBS, SWAP_DELAYS };

for (const kind of KINDS) {
	for (const mib of RUNGS) {
		for (let i = 0; i < SAMPLES; i++) {
			const s = await sample(kind, mib);
			samples.push(s);
			console.log(`progress ${kind} ${mib} ${s.outcome}`);
			await sleep(500);
		}
	}
}

const ladder: Record<string, Record<number, Tally>> = {};
const smallest: Record<string, number | null> = {};
for (const kind of KINDS) {
	const row: Record<number, Tally> = {};
	ladder[kind] = row;
	smallest[kind] = null;
	for (const mib of RUNGS) {
		const t = tally(samples.filter((s) => s.kind === kind && s.mib === mib));
		row[mib] = t;
		console.log(`${kind} ${mib} MiB: ${fmt(t)}`);
		if (smallest[kind] === null && t.reset * 2 > SAMPLES) smallest[kind] = mib;
	}
	console.log(`${kind} smallest rung with more than half resets: ${smallest[kind] ?? 'none'}`);
}

const swapSamples: Sample[] = [];
const swapTally: Record<string, Tally> = {};
if (SWAP) {
	for (const mib of SWAP_MIBS) {
		for (const delay of SWAP_DELAYS) {
			for (let i = 0; i < SAMPLES; i++) {
				const s = await sample('swap', mib, delay);
				swapSamples.push(s);
				console.log(`progress swap ${mib} ${delay} ${s.outcome}`);
				await sleep(500);
			}
			const t = tally(swapSamples.filter((s) => s.mib === mib && s.delay === delay));
			swapTally[`${mib}/${delay}`] = t;
			console.log(`swap ${mib} MiB delay ${delay} ms: ${fmt(t)}`);
		}
	}
}

type Cls = 'ok' | 'refused' | 'memory-reset' | 'cpu-reset' | 'storage-reset' | 'other';

interface Step {
	event: string;
	outcome: Cls;
	error: string | null;
	attempted: number;
	held: number | null;
	ms: number;
	inst: string | null;
}

interface Plan {
	arm: string;
	kind: string;
	C: number;
	K: number;
	touch: boolean;
	delay: number | null;
	events: [string, Record<string, string>, number][];
}

interface ArmSample {
	cell: string;
	outcome: Cls;
	failedEvent: string | null;
	attempted: number | null;
	before: string | null;
	after: string | null;
	instChanged: boolean;
	burnMs: number;
	ms: number;
	steps: Step[];
}

function classify(r: Reply): Cls {
	if (r.ok) return 'ok';
	const e = r.error ?? '';
	if (e.includes('memory limit')) return 'memory-reset';
	if (/CPU/i.test(e)) return 'cpu-reset';
	if (/storage|Internal error/i.test(e)) return 'storage-reset';
	if (/RangeError|allocate|array buffer length/i.test(e)) return 'refused';
	return 'other';
}

const touchFlag = (touch: boolean, query: Record<string, string>) => ({
	touch: touch ? '1' : '0',
	...query
});

function plans(): Plan[] {
	const out: Plan[] = [];
	if (ARMS.includes('ceiling')) {
		for (const kind of ['ab', 'wasm']) {
			for (const C of [130, 136, 144, 152, 159]) {
				for (const touch of [false, true]) {
					const q = touchFlag(touch, {
						kind: 'chunks',
						type: kind,
						mib: String(C),
						k: '1'
					});
					out.push({
						arm: 'ceiling',
						kind,
						C,
						K: 1,
						touch,
						delay: null,
						events: [['alloc', q, C]]
					});
				}
			}
		}
	}
	if (ARMS.includes('chunks-ab') || ARMS.includes('chunks-wasm')) {
		for (const kind of ['ab', 'wasm']) {
			if (!ARMS.includes(`chunks-${kind}`)) continue;
			for (let K = 3; K <= 8; K++) {
				const q = touchFlag(false, { kind: 'chunks', type: kind, mib: '32', k: String(K) });
				out.push({
					arm: `chunks-${kind}`,
					kind,
					C: 32,
					K,
					touch: false,
					delay: null,
					events: [['alloc', q, 32 * K]]
				});
			}
		}
	}
	if (ARMS.includes('chunks-mixed')) {
		for (let K = 2; K <= 5; K++) {
			const q = touchFlag(false, { kind: 'chunks', type: 'mixed', mib: '32', k: String(K) });
			out.push({
				arm: 'chunks-mixed',
				kind: 'mixed',
				C: 32,
				K,
				touch: false,
				delay: null,
				events: [['alloc', q, 64 + 32 * K]]
			});
		}
	}
	if (ARMS.includes('two-instances')) {
		for (const delay of [0, 5000, 30000]) {
			const hold = touchFlag(false, { kind: 'wasm', mib: '96' });
			const drop = touchFlag(false, { kind: 'drop', mib: '96', delay: String(delay) });
			out.push({
				arm: 'two-instances',
				kind: 'wasm',
				C: 96,
				K: 2,
				touch: false,
				delay,
				events: [
					['hold-1', hold, 96],
					['hold-2', hold, 96],
					['drop', drop, 96]
				]
			});
		}
	}
	if (ARMS.includes('touch')) {
		for (const kind of ['ab', 'wasm']) {
			const q = touchFlag(true, { kind: 'chunks', type: kind, mib: '32', k: '6' });
			out.push({
				arm: 'touch',
				kind,
				C: 32,
				K: 6,
				touch: true,
				delay: null,
				events: [['alloc', q, 192]]
			});
		}
	}
	return out;
}

const cellKey = (p: Plan) =>
	`${p.arm} ${p.kind} C=${p.C} K=${p.K} touch=${p.touch ? 1 : 0} delay=${p.delay ?? '-'}`;

async function armSample(plan: Plan, index: number): Promise<ArmSample> {
	const object = `cum-${RUN}-${plan.arm}-${index}-${Math.random().toString(36).slice(2, 8)}`;
	const tBurn = Date.now();
	await call(object, { kind: 'burn', delay: '1500' });
	const burnMs = Date.now() - tBurn;
	const pre = await call(object, { kind: 'free' });
	const steps: Step[] = [];
	let held = 0;
	for (const [event, query, mib] of plan.events) {
		const attempted = (event === 'drop' ? 0 : held) + mib;
		const t0 = Date.now();
		const reply = await call(object, query);
		steps.push({
			event,
			outcome: classify(reply),
			error: reply.ok ? null : (reply.error ?? 'no message'),
			attempted,
			held: reply.held ?? null,
			ms: Date.now() - t0,
			inst: reply.inst ?? null
		});
		if (!reply.ok) break;
		held = reply.held ?? held;
	}
	const post = await call(object, { kind: 'free' });
	const before = pre.inst ?? null;
	const after = post.inst ?? null;
	const failed = steps.find((s) => s.outcome !== 'ok') ?? null;
	const seen = [...steps.map((s) => s.inst), after];
	return {
		cell: cellKey(plan),
		outcome: failed?.outcome ?? 'ok',
		failedEvent: failed?.event ?? null,
		attempted: failed?.attempted ?? null,
		before,
		after,
		instChanged: before !== null && seen.some((i) => i !== null && i !== before),
		burnMs,
		ms: steps.reduce((sum, s) => sum + s.ms, 0),
		steps
	};
}

const armSamples: ArmSample[] = [];
for (const plan of plans()) {
	for (let i = 0; i < SAMPLES; i++) {
		const s = await armSample(plan, i);
		armSamples.push(s);
		console.log(`progress ${s.cell} ${s.outcome}`);
		await sleep(500);
	}
}

const CLASSES: Cls[] = ['ok', 'refused', 'memory-reset', 'cpu-reset', 'storage-reset', 'other'];
const armCells = new Map<string, ArmSample[]>();
for (const s of armSamples) armCells.set(s.cell, [...(armCells.get(s.cell) ?? []), s]);
for (const [cell, rows] of armCells) {
	const counts = Object.fromEntries(
		CLASSES.map((c) => [c, rows.filter((r) => r.outcome === c).length])
	);
	const changed = rows.filter((r) => r.instChanged).length;
	console.log(
		`${cell}: ${CLASSES.map((c) => `${c}=${counts[c]}`).join(' ')} instChanged=${changed} of ${rows.length}`
	);
}

const errors: Record<string, number> = {};
for (const s of [...samples, ...swapSamples]) {
	for (const message of [s.error, s.plainError]) {
		if (message) errors[message] = (errors[message] ?? 0) + 1;
	}
}
for (const s of armSamples) {
	for (const step of s.steps) {
		if (step.error) errors[step.error] = (errors[step.error] ?? 0) + 1;
	}
}
console.log('distinct errors', JSON.stringify(errors, null, 1));

const file = report({
	started: new Date(Number.parseInt(RUN, 36)).toISOString(),
	config: { ...config, ARMS },
	ladder,
	smallest,
	swap: swapTally,
	errors,
	samples,
	swapSamples,
	arms: armSamples
});
console.log(`wrote ${file}`);
