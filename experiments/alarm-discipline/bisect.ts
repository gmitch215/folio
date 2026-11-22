import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Round-robin events over `objects` Durable Objects. Every event is recorded with its error class
// and instance id, so failures can be read against instance changes. WORKER_URL names the deployed
// bisect-worker.mjs.
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed bisect worker');
const ARM_RE = /^(control|pad-table|large-json-rows|ballast-memory|fingerprint-pass|all-features)$/;
const arm = process.env.ARM ?? 'control';
if (!ARM_RE.test(arm)) throw new Error(`bad arm ${arm}`);
const n = Number(process.env.N ?? 120);
const objects = Number(process.env.OBJECTS ?? 3);
const prefix = process.env.PREFIX ?? 'bisect';
const sync = process.env.SYNC ?? '0';
if (sync !== '0' && sync !== '1') throw new Error('SYNC must be 0 or 1');
const iters = process.env.ITERS;
const preplace = process.env.PREPLACE === '1';
const preplaceIters = process.env.PREPLACE_ITERS ?? '2.1e9';
const capRows = Number(process.env.CAP_ROWS ?? 0);
const outDir = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const ROWS_PER_EVENT = 2001;
const SEED_ROWS = 10000;
const gapMs = 200;
const run = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = {
	ok: boolean;
	error?: string;
	body?: { inst: string; seq: number; handlerMs: number };
};
type Stats = { inst: string; seq: number; databaseSize: number; rows: Record<string, number> };
type Cls = 'ok' | 'storage_generic' | 'storage_timeout' | 'cpu_limit' | 'memory' | 'other';
type Rec = {
	i: number;
	obj: number;
	idx: number;
	inst: string | null;
	instChanged: boolean | null;
	cls: Cls;
	text: string | null;
	clientMs: number;
};

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] ?? null;

const classOf = (r: Reply): Cls => {
	if (r.ok && r.body) return 'ok';
	const t = r.error ?? '';
	if (t.includes('Internal error in Durable Object storage')) return 'storage_generic';
	if (t.includes('storage operation exceeded timeout')) return 'storage_timeout';
	if (t.includes('CPU time limit')) return 'cpu_limit';
	if (t.includes('memory limit')) return 'memory';
	return 'other';
};

const callEvent = async (url: string): Promise<Reply> => {
	try {
		const res = await fetch(url);
		const text = await res.text();
		try {
			return JSON.parse(text) as Reply;
		} catch {
			return { ok: false, error: `http ${res.status}: ${text.slice(0, 160)}` };
		}
	} catch (e) {
		return { ok: false, error: `client: ${String(e).slice(0, 160)}` };
	}
};

const statOf = async (name: string): Promise<Stats | null> => {
	try {
		const res = await fetch(`${base}/?do=${name}&stat=1`);
		const j = (await res.json()) as { ok: boolean; body?: Stats };
		return j.body ?? null;
	} catch {
		return null;
	}
};

const names = Array.from({ length: objects }, (_, j) => `${prefix}-${run}-${j}`);
const lastInst = new Map<number, string>();
const pre: Record<string, unknown>[] = [];
let rowsEst = objects * SEED_ROWS;

if (preplace) {
	for (let obj = 0; obj < objects; obj++) {
		const name = names[obj] ?? '';
		const q = new URLSearchParams({ do: name, arm, sync: '0', iters: preplaceIters });
		const t0 = performance.now();
		const reply = await callEvent(`${base}/?${q.toString()}`);
		const throwMs = Math.round(performance.now() - t0);
		rowsEst += ROWS_PER_EVENT;
		const throwInst = reply.ok && reply.body ? reply.body.inst : null;
		const s = await statOf(name);
		const after = s?.inst ?? null;
		if (after !== null) lastInst.set(obj, after);
		else if (throwInst !== null) lastInst.set(obj, throwInst);
		pre.push({
			obj,
			cls: classOf(reply),
			text: reply.ok ? null : (reply.error ?? '').slice(0, 300),
			throwMs,
			throwInst,
			statInst: after,
			replaced: throwInst !== null && after !== null && after !== throwInst,
			statSeq: s?.seq ?? null
		});
		console.log(
			`${prefix} preplace obj=${obj} ${classOf(reply)} ${throwMs}ms replaced=${throwInst !== null && after !== null && after !== throwInst}`
		);
		await sleep(gapMs);
	}
}

const recs: Rec[] = [];
let aborted = false;
for (let i = 0; i < n; i++) {
	if (capRows > 0 && rowsEst + ROWS_PER_EVENT > capRows) {
		aborted = true;
		break;
	}
	const obj = i % objects;
	const idx = Math.floor(i / objects);
	const q = new URLSearchParams({ do: names[obj] ?? '', arm, sync });
	if (iters) q.set('iters', iters);
	const t0 = performance.now();
	const reply = await callEvent(`${base}/?${q.toString()}`);
	const clientMs = Math.round(performance.now() - t0);
	rowsEst += ROWS_PER_EVENT;
	const cls = classOf(reply);
	const inst = cls === 'ok' && reply.body ? reply.body.inst : null;
	const prev = lastInst.get(obj);
	const instChanged = inst === null || prev === undefined ? null : prev !== inst;
	if (inst !== null) lastInst.set(obj, inst);
	recs.push({
		i,
		obj,
		idx,
		inst,
		instChanged,
		cls,
		text: cls === 'ok' ? null : (reply.error ?? '').slice(0, 300),
		clientMs
	});
	console.log(
		`${prefix} ${i + 1}/${n} obj=${obj} ${cls} ${clientMs}ms${instChanged ? ' instChanged' : ''}`
	);
	await sleep(gapMs);
}

const counts: Record<Cls, number> = {
	ok: 0,
	storage_generic: 0,
	storage_timeout: 0,
	cpu_limit: 0,
	memory: 0,
	other: 0
};
for (const r of recs) counts[r.cls]++;
const end: Record<string, Stats | null> = {};
for (const name of names) end[name] = await statOf(name);

const out = {
	run,
	prefix,
	arm,
	sync,
	n,
	objects,
	attempted: recs.length,
	aborted,
	iters: iters ?? null,
	preplace: preplace ? { iters: preplaceIters, records: pre } : null,
	counts,
	medianClientMs: median(recs.filter((r) => r.cls === 'ok').map((r) => r.clientMs)),
	events: recs,
	end
};
mkdirSync(outDir, { recursive: true });
const file = `${outDir}/bisect-${prefix}-${run}.json`;
writeFileSync(file, `${JSON.stringify(out, null, '\t')}\n`);
console.log(
	`${prefix} sync=${sync} attempted=${recs.length}/${n} aborted=${aborted} ` +
		`ok=${counts.ok} storage_generic=${counts.storage_generic} ` +
		`storage_timeout=${counts.storage_timeout} cpu_limit=${counts.cpu_limit} ` +
		`memory=${counts.memory} other=${counts.other} medianClientMs=${out.medianClientMs}`
);
console.log(file);
