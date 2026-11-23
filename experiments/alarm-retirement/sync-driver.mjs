import { appendFileSync, mkdirSync } from 'node:fs';

// sync: does a flush before a CPU kill keep the rows written before it
// MODE=smoke runs one object per arm; MODE=full runs two passes of five objects per arm
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
const mode = process.env.MODE ?? 'full';
const PER_PASS = Number(process.env.PER_PASS ?? 5);
const TRIAL_CONC = Number(process.env.TRIAL_CONC ?? 2);
const RETRY_MS = 250;
const RETRY_CAP_MS = 30000;
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

const tagsOf = (rows, ev) =>
	(rows ?? [])
		.filter((r) => r.ev === ev)
		.map((r) => r.tag)
		.sort()
		.join('');

async function readBack(object) {
	const deadline = Date.now() + RETRY_CAP_MS;
	let failures = 0;
	let first = null;
	for (let i = 0; ; i++) {
		const r = await call('/read', { do: object, t: `rb${i}` });
		if (r.ok) {
			first = r;
			break;
		}
		failures++;
		if (Date.now() >= deadline) break;
		await sleep(RETRY_MS);
	}
	let late = null;
	if (first) {
		await sleep(3000);
		late = await call('/read', { do: object, t: 'rb-late' });
	}
	return {
		failures,
		firstIso: first?.body?.iso ?? null,
		firstInst: first?.body?.inst ?? null,
		rows: first?.body?.rows ?? null,
		lateRows: late?.body?.rows ?? null
	};
}

async function trial(arm, pass, k, label) {
	const object = `sync-${run}-${arm}-p${pass}-${k}`;
	const ev = await call('/ev', { do: object, ev: 1, kind: 'cpu', sync: arm, t: 'e' });
	const rb = await readBack(object);
	const rec = {
		type: 'trial',
		label,
		arm,
		pass,
		k,
		object,
		injected: !ev.ok,
		eventCls: ev.cls,
		eventError: ev.error,
		eventWallMs: ev.wallMs,
		tags: rb.rows ? tagsOf(rb.rows, 1) : null,
		lateTags: rb.lateRows ? tagsOf(rb.lateRows, 1) : null,
		firstIso: rb.firstIso,
		firstInst: rb.firstInst,
		failures: rb.failures
	};
	save('trials.jsonl', rec);
	console.log(
		`trial ${arm} pass=${pass} k=${k} injected=${rec.injected} event=${ev.cls} rows=${rec.tags} late=${rec.lateTags} wall=${ev.wallMs} err=${String(ev.error ?? '').slice(0, 80)}`
	);
}

async function plain() {
	const object = `sync-${run}-gate`;
	const ev = await call('/ev', { do: object, ev: 1, kind: 'none', variant: 'after', t: 'e' });
	const rb = await readBack(object);
	const tags = rb.rows ? tagsOf(rb.rows, 1) : null;
	console.log(`gate event=${ev.cls} rows=${tags}`);
	return ev.ok && tags === 'mxyz';
}

async function pool(jobs, conc, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: conc }, async () => {
			while (next < jobs.length) await fn(jobs[next++]);
		})
	);
}

const ARMS = ['none', 'sync', 'syncyield'];
const rotate = (pass) => ARMS.map((_, i) => ARMS[(i + pass) % ARMS.length]);

if (!(await plain())) {
	console.log('gate failed: a plain event did not commit m, y, x, z');
	process.exit(1);
}

if (mode === 'smoke') {
	for (const arm of ARMS) await trial(arm, 0, 0, 'smoke');
	process.exit(0);
}

for (let pass = 0; pass < 2; pass++) {
	console.log(`pass ${pass} order ${rotate(pass).join(',')}`);
	for (const arm of rotate(pass)) {
		const jobs = Array.from({ length: PER_PASS }, (_, k) => k);
		await pool(jobs, TRIAL_CONC, (k) => trial(arm, pass, k, 'grid'));
	}
}
await sleep(15000);
console.log('done');
