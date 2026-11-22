import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Kind = 'rows' | 'blob' | 'abort';
type Order = 'plain' | 'blocked';
type End = 'return' | 'sync';
type Phase = 'throwaway' | 'counted';
type Outcome =
	'ok' | 'storage-reset' | 'memory' | 'cpu' | 'storage-timeout' | 'client-timeout' | 'other';

interface Rung {
	label: string;
	kind: Kind;
	n: number;
}

interface Reply {
	ok: boolean;
	body?: {
		inst: string;
		seq: number;
		rowsLogical: number;
		rowsWritten: number | null;
		bytes: number;
		dbBytes: number;
		syncMs: number | null;
	};
	error?: string;
}

interface Probe {
	rung: string;
	order: Order;
	phase: Phase;
	index: number;
	object: string;
	requested: number;
	lastInst: string | null;
}

interface Sample extends Omit<Probe, 'lastInst'> {
	outcome: Outcome;
	error: string | null;
	inst: string | null;
	instChanged: boolean;
	wallMs: number;
	rowsLogical: number | null;
	rowsWritten: number | null;
	bytes: number | null;
	dbBytes: number | null;
	syncMs: number | null;
}

interface Tally {
	events: number;
	counts: Record<Outcome, number>;
	instChanges: number;
	wallMedianMs: number;
	wallMaxMs: number;
	resetRate: number;
	resetLow: number;
	resetHigh: number;
	firstOther: string | null;
}

const DEFAULT_RUNGS =
	'rows:2000,rows:10000,rows:40000,rows:100000,blob:1,blob:4,blob:8,blob:16,blob:32';
const OUTCOMES: Outcome[] = [
	'ok',
	'storage-reset',
	'memory',
	'cpu',
	'storage-timeout',
	'client-timeout',
	'other'
];

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`set ${name}`);
	return value;
}

function list(value: string): string[] {
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function positiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer`);
	return value;
}

function isKind(value: string): value is Kind {
	return value === 'rows' || value === 'blob' || value === 'abort';
}

function parseRung(text: string): Rung {
	const [kind = '', count = ''] = text.split(':');
	const n = Number(count);
	if (!isKind(kind) || !Number.isSafeInteger(n) || n < 1) throw new Error(`bad rung ${text}`);
	return { label: text, kind, n };
}

function parseOrder(text: string): Order {
	if (text === 'plain' || text === 'blocked') return text;
	throw new Error(`bad order ${text}`);
}

function parseEnd(text: string): End {
	if (text === 'return' || text === 'sync') return text;
	throw new Error(`bad end ${text}`);
}

const WORKER = required('WORKER_URL');
const RUNGS = list(process.env.RUNGS ?? DEFAULT_RUNGS).map(parseRung);
const ORDERS = list(process.env.ORDERS ?? 'plain').map(parseOrder);
const END = parseEnd(process.env.END ?? 'return');
const EVENTS = positiveInt('EVENTS', 6);
const OBJECTS = positiveInt('OBJECTS', 2);
const STOP_AFTER = positiveInt('STOP_AFTER', 2);
const MAX_WALL_MS = positiveInt('MAX_WALL_MS', 180000);
const BURN = positiveInt('BURN', 2000000000);
const OUT = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function classify(error: string, timedOut: boolean): Outcome {
	if (timedOut) return 'client-timeout';
	if (error.includes('Internal error in Durable Object storage')) return 'storage-reset';
	if (error.includes('memory limit')) return 'memory';
	if (error.includes('CPU time limit')) return 'cpu';
	if (error.includes('storage operation exceeded timeout')) return 'storage-timeout';
	return 'other';
}

function redact(error: unknown, url: URL): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.split(url.href).join('<url>').split(url.host).join('<host>');
}

async function send(probe: Probe, query: Record<string, string>): Promise<Sample> {
	const url = new URL(WORKER);
	url.searchParams.set('do', probe.object);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	const started = performance.now();
	let reply: Reply;
	let timedOut = false;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(MAX_WALL_MS) });
		reply = (await res.json()) as Reply;
	} catch (error) {
		timedOut =
			typeof error === 'object' &&
			error !== null &&
			'name' in error &&
			error.name === 'TimeoutError';
		reply = {
			ok: false,
			error: timedOut ? 'client timeout' : `transport: ${redact(error, url)}`
		};
	}
	const wallMs = performance.now() - started;
	const body = reply.ok ? reply.body : undefined;
	const inst = body?.inst ?? null;
	return {
		rung: probe.rung,
		order: probe.order,
		phase: probe.phase,
		index: probe.index,
		object: probe.object,
		requested: probe.requested,
		outcome: reply.ok ? 'ok' : classify(reply.error ?? '', timedOut),
		error: reply.ok ? null : (reply.error ?? 'no message'),
		inst,
		instChanged: inst !== null && probe.lastInst !== null && inst !== probe.lastInst,
		wallMs,
		rowsLogical: body?.rowsLogical ?? null,
		rowsWritten: body?.rowsWritten ?? null,
		bytes: body?.bytes ?? null,
		dbBytes: body?.dbBytes ?? null,
		syncMs: body?.syncMs ?? null
	};
}

async function cell(rung: Rung, order: Order): Promise<Sample[]> {
	const out: Sample[] = [];
	for (let o = 0; o < OBJECTS; o++) {
		const object = `ladder-${RUN}-${rung.kind}${rung.n}-${order}-${o}`;
		const warm = await send(
			{
				rung: rung.label,
				order,
				phase: 'throwaway',
				index: 0,
				object,
				requested: 1,
				lastInst: null
			},
			{ kind: 'rows', n: '1', order: 'plain', end: END }
		);
		out.push(warm);
		let lastInst = warm.outcome === 'ok' ? warm.inst : null;
		for (let i = 0; i < EVENTS; i++) {
			const query: Record<string, string> = {
				kind: rung.kind,
				n: String(rung.n),
				order,
				end: END
			};
			if (order === 'blocked') query.burn = String(BURN);
			const s = await send(
				{
					rung: rung.label,
					order,
					phase: 'counted',
					index: i,
					object,
					requested: rung.n,
					lastInst
				},
				query
			);
			out.push(s);
			if (s.outcome === 'ok') lastInst = s.inst;
		}
	}
	return out;
}

function median(xs: number[]): number {
	if (xs.length === 0) return NaN;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2
		? (sorted[mid] ?? NaN)
		: ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
}

function wilson(k: number, n: number): [number, number] {
	if (n === 0) return [NaN, NaN];
	const z = 1.959964;
	const p = k / n;
	const denom = 1 + (z * z) / n;
	const centre = p + (z * z) / (2 * n);
	const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [(centre - spread) / denom, (centre + spread) / denom];
}

function tally(samples: Sample[]): Tally {
	const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
	let instChanges = 0;
	let firstOther: string | null = null;
	const walls: number[] = [];
	for (const s of samples) {
		counts[s.outcome] += 1;
		walls.push(s.wallMs);
		if (s.instChanged) instChanges += 1;
		if (s.outcome === 'other' && firstOther === null) firstOther = s.error;
	}
	const [resetLow, resetHigh] = wilson(counts['storage-reset'], samples.length);
	return {
		events: samples.length,
		counts,
		instChanges,
		wallMedianMs: median(walls),
		wallMaxMs: walls.length ? Math.max(...walls) : NaN,
		resetRate: samples.length ? counts['storage-reset'] / samples.length : NaN,
		resetLow,
		resetHigh,
		firstOther
	};
}

function line(label: string, order: Order, t: Tally): string {
	const c = t.counts;
	const pct = (x: number) => (100 * x).toFixed(2);
	return [
		`${label} ${order}: events=${t.events}`,
		`ok=${c.ok} storage=${c['storage-reset']} memory=${c.memory} cpu=${c.cpu}`,
		`storageTimeout=${c['storage-timeout']} clientTimeout=${c['client-timeout']} other=${c.other}`,
		`instChanges=${t.instChanges}`,
		`wall median=${Math.round(t.wallMedianMs)}ms max=${Math.round(t.wallMaxMs)}ms`,
		`storageRate=${pct(t.resetRate)}% [${pct(t.resetLow)}, ${pct(t.resetHigh)}]`
	].join(' ');
}

const samples: Sample[] = [];
const cells: { rung: string; order: Order; tally: Tally }[] = [];
const stopped: { kind: Kind; reason: string }[] = [];
const stoppedKinds = new Set<Kind>();

for (const rung of RUNGS) {
	if (stoppedKinds.has(rung.kind)) {
		console.log(`skip ${rung.label}: ${rung.kind} climb stopped`);
		continue;
	}
	let resets = 0;
	let timeouts = 0;
	for (const order of ORDERS) {
		const got = await cell(rung, order);
		samples.push(...got);
		const counted = tally(got.filter((s) => s.phase === 'counted'));
		cells.push({ rung: rung.label, order, tally: counted });
		resets += counted.counts['storage-reset'];
		timeouts += counted.counts['client-timeout'];
		console.log(line(rung.label, order, counted));
		const requested = samples.reduce((sum, s) => sum + s.requested, 0);
		console.log(`running requested inserts=${requested}`);
	}
	if (resets >= STOP_AFTER) {
		stoppedKinds.add(rung.kind);
		stopped.push({ kind: rung.kind, reason: `${resets} storage resets at ${rung.label}` });
		console.log(`stop ${rung.kind}: ${resets} storage resets at ${rung.label}`);
	}
	if (timeouts > 0) {
		stoppedKinds.add(rung.kind);
		stopped.push({ kind: rung.kind, reason: `${timeouts} client timeouts at ${rung.label}` });
		console.log(`stop ${rung.kind}: ${timeouts} client timeouts at ${rung.label}`);
	}
}

const throwaways = tally(samples.filter((s) => s.phase === 'throwaway'));
console.log(`throwaway events: ${line('throwaway', 'plain', throwaways)}`);

const errors: Record<string, number> = {};
for (const s of samples) {
	if (s.error) errors[s.error] = (errors[s.error] ?? 0) + 1;
}
console.log('distinct errors', JSON.stringify(errors, null, 1));

const requestedTotal = samples.reduce((sum, s) => sum + s.requested, 0);
const writtenTotal = samples.reduce((sum, s) => sum + (s.rowsWritten ?? 0), 0);
const unmeasured = samples.filter((s) => s.outcome === 'ok' && s.rowsWritten === null).length;

mkdirSync(OUT, { recursive: true });
const file = `${OUT}/commit-ladder-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(
	file,
	JSON.stringify(
		{
			run: RUN,
			config: {
				RUNGS: RUNGS.map((r) => r.label),
				ORDERS,
				END,
				EVENTS,
				OBJECTS,
				STOP_AFTER,
				MAX_WALL_MS,
				BURN
			},
			stopped,
			cells,
			throwaways,
			errors,
			requestedTotal,
			writtenTotal,
			unmeasured,
			samples
		},
		null,
		'\t'
	)
);
console.log(
	`requested inserts=${requestedTotal} rowsWritten=${writtenTotal} unmeasured=${unmeasured}`
);
console.log(`wrote ${file}`);
