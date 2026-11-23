import { appendFileSync, mkdirSync } from 'node:fs';

// m1: rows that survive a reset (marker m, y, x, z) and the cost of the first request to the successor.
// MODE=smoke runs a few probes and prints them; MODE=full runs the grid (trials, then chains)
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
const mode = process.env.MODE ?? 'full';
const N = Number(process.env.N ?? 10);
const CHAINS = Number(process.env.CHAINS ?? 20);
const CONTROL_CHAINS = Number(process.env.CONTROL_CHAINS ?? 5);
const EVENTS = 24;
const TRIAL_CONC = Number(process.env.TRIAL_CONC ?? 2);
const CHAIN_CONC = Number(process.env.CHAIN_CONC ?? 4);
const RETRY_MS = 250;
const RETRY_CAP_MS = 30000;
const PRE_UNITS = process.env.PRE_UNITS ? Number(process.env.PRE_UNITS) : 0;
mkdirSync(out, { recursive: true });
const run = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (file, rec) => appendFileSync(`${out}/${file}`, `${JSON.stringify(rec)}\n`);

function classOf(ok, clientError, error) {
	if (ok) return 'ok';
	if (clientError) return 'client';
	const m = String(error);
	if (m.includes('Internal error in Durable Object storage caused object to be reset'))
		return 'storage_reset';
	if (m.includes('code was updated')) return 'code_update';
	if (/memory limit/i.test(m)) return 'memory';
	if (/cpu time|cpu limit|exceeded cpu/i.test(m)) return 'cpu';
	if (m.includes('exceeded timeout')) return 'storage_timeout';
	return 'other';
}

async function call(path, params) {
	const q = new URLSearchParams(params).toString();
	const t0 = Date.now();
	let reply = null;
	let clientError = null;
	try {
		const res = await fetch(`${base}${path}?${q}`, { signal: AbortSignal.timeout(180000) });
		reply = await res.json();
	} catch (e) {
		clientError = String(e).slice(0, 300);
	}
	const tEnd = Date.now();
	const ok = reply?.ok === true;
	const error = clientError ?? (ok ? null : (reply?.error ?? 'no reply'));
	return {
		ok,
		cls: classOf(ok, clientError, error),
		error,
		body: ok ? reply.body : null,
		wallMs: tEnd - t0,
		tEnd
	};
}

const tagsOf = (rows, ev) => (rows ?? []).filter((r) => r.ev === ev).map((r) => r.tag);

// the first request to the successor with retries, then a warm one right after, then one 3 s later
async function readBack(object, label) {
	const deadline = Date.now() + RETRY_CAP_MS;
	const t0 = Date.now();
	let failures = 0;
	const errors = [];
	let first = null;
	for (let i = 0; ; i++) {
		const r = await call('/read', { do: object, t: `${label}-r1a${i}` });
		if (r.ok) {
			first = { ...r, tag: `${label}-r1a${i}` };
			break;
		}
		failures++;
		errors.push(String(r.error).slice(0, 120));
		if (Date.now() >= deadline) break;
		await sleep(RETRY_MS);
	}
	const toFirstSuccessMs = first ? first.tEnd - t0 : null;
	let warm = null;
	let late = null;
	if (first) {
		warm = await call('/read', { do: object, t: `${label}-r2` });
		await sleep(3000);
		late = await call('/read', { do: object, t: `${label}-r3` });
	}
	return {
		failures,
		errors: errors.slice(0, 3),
		toFirstSuccessMs,
		firstWallMs: first?.wallMs ?? null,
		firstTag: first?.tag ?? null,
		warmWallMs: warm?.wallMs ?? null,
		warmTag: warm ? `${label}-r2` : null,
		firstInst: first?.body?.inst ?? null,
		firstIso: first?.body?.iso ?? null,
		warmInst: warm?.body?.inst ?? null,
		lateInst: late?.body?.inst ?? null,
		lateRows: late?.body?.rows ?? null,
		rows: first?.body?.rows ?? null
	};
}

async function trial(kind, variant, k, label) {
	const object = `m1-${run}-${kind}-${variant}-${k}`;
	if (PRE_UNITS) await call('/pre', { do: object, units: PRE_UNITS, t: 'pre' });
	const ev = await call('/ev', { do: object, ev: 1, kind, variant, t: 'e' });
	const rb = await readBack(object, 'rb');
	const rec = {
		type: 'trial',
		label,
		kind,
		variant,
		k,
		object,
		eventOk: ev.ok,
		eventCls: ev.cls,
		eventError: ev.error,
		eventWallMs: ev.wallMs,
		eventInst: ev.body?.inst ?? null,
		eventIso: ev.body?.iso ?? null,
		instChanged: ev.body?.inst && rb.firstInst ? ev.body.inst !== rb.firstInst : null,
		tags: rb.rows ? tagsOf(rb.rows, 1).sort().join('') : null,
		lateTags: rb.lateRows ? tagsOf(rb.lateRows, 1).sort().join('') : null,
		rb
	};
	save('trials.jsonl', rec);
	console.log(
		`trial ${kind} ${variant} k=${k} event=${ev.cls} rows=${rec.tags} late=${rec.lateTags} instChanged=${rec.instChanged} fail=${rb.failures} first=${rb.toFirstSuccessMs}/${rb.firstWallMs} warm=${rb.warmWallMs} err=${String(ev.error ?? '').slice(0, 80)}`
	);
	return rec;
}

async function chain(arm, k) {
	const orig = arm === 'orig' ? '1' : arm === 'nowait' ? '2' : '0';
	const object = `m1-${run}-chain-${arm}-${k}`;
	let prevIso = null;
	const events = [];
	let resetEv = null;
	let stopCls = null;
	let rb = null;
	for (let ev = 1; ev <= EVENTS; ev++) {
		const r = await call('/ev', {
			do: object,
			ev,
			kind: 'storage',
			variant: 'after',
			orig,
			t: `e${ev}`
		});
		const iso = r.body?.iso ?? null;
		events.push({
			ev,
			cls: r.cls,
			error: r.error,
			wallMs: r.wallMs,
			iso,
			inst: r.body?.inst ?? null,
			isoChanged: iso && prevIso ? iso !== prevIso : null
		});
		if (r.ok) prevIso = iso;
		if (!r.ok) {
			stopCls = r.cls;
			if (r.cls === 'storage_reset') resetEv = ev;
			rb = await readBack(object, `ev${ev}`);
			break;
		}
	}
	let finalRows = null;
	if (!rb) {
		const f = await call('/read', { do: object, t: 'final' });
		finalRows = f.body?.rows ?? null;
	}
	const rows = rb?.rows ?? finalRows;
	const perEvent = {};
	for (const r of rows ?? []) perEvent[r.ev] = (perEvent[r.ev] ?? '') + r.tag;
	const per = Object.fromEntries(
		Object.entries(perEvent).map(([e, t]) => [e, t.split('').sort().join('')])
	);
	const rec = {
		type: 'chain',
		arm,
		k,
		object,
		events,
		resetEv,
		stopCls,
		resetTags: resetEv && rows ? tagsOf(rows, resetEv).sort().join('') : null,
		perEventTags: per,
		rb
	};
	save('chains.jsonl', rec);
	console.log(
		`chain ${arm} k=${k} events=${events.length} stop=${stopCls} resetEv=${resetEv} resetTags=${rec.resetTags} fail=${rb?.failures ?? '-'} first=${rb?.toFirstSuccessMs ?? '-'}/${rb?.firstWallMs ?? '-'} warm=${rb?.warmWallMs ?? '-'}`
	);
}

async function pool(jobs, conc, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: conc }, async () => {
			while (next < jobs.length) {
				const j = jobs[next++];
				if (j) await fn(j);
			}
		})
	);
}

function shuffle(list) {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
}

if (mode === 'smoke') {
	const a = await trial('none', 'after', 0, 'smoke');
	const pass = a.eventOk && a.tags === 'mxyz';
	console.log(`smoke none pass=${pass}`);
	for (let k = 0; k < 3; k++) await trial('memory', 'during', k, 'smoke');
	for (let k = 0; k < 3; k++) await trial('memory', 'after', k, 'smoke');
	await trial('cpu', 'during', 0, 'smoke');
	process.exit(pass ? 0 : 1);
}

const gate = await trial('none', 'after', 0, 'gate');
if (!(gate.eventOk && gate.tags === 'mxyz')) {
	console.log('gate failed: a plain event did not commit m, y, x, z');
	process.exit(1);
}

const jobs = [];
if (mode !== 'nowait')
	for (const kind of ['memory', 'cpu'])
		for (const variant of ['during', 'after'])
			for (let k = 0; k < N; k++) jobs.push({ kind, variant, k });
shuffle(jobs);
await pool(jobs, TRIAL_CONC, (j) => trial(j.kind, j.variant, j.k, 'grid'));

const cjobs = [];
if (mode === 'nowait') for (let k = 0; k < CHAINS; k++) cjobs.push({ arm: 'nowait', k });
else {
	for (let k = 0; k < CHAINS; k++) cjobs.push({ arm: 'm1', k });
	for (let k = 0; k < CONTROL_CHAINS; k++) cjobs.push({ arm: 'orig', k });
}
shuffle(cjobs);
await pool(cjobs, CHAIN_CONC, (j) => chain(j.arm, j.k));
await sleep(15000);
console.log(`trials=${jobs.length} chains=${cjobs.length}`);
