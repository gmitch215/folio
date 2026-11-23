import { appendFileSync, mkdirSync } from 'node:fs';

// 12 cells (L x F), one fresh object per trial, shuffled; each trial reads storage after F + 5 s
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
const samples = Number(process.env.SAMPLES ?? 10);
const conc = Number(process.env.CONC ?? 6);
const LS = [2, 4, 8];
const FS = [1, 5, 10, 15];
const RESET = 'Internal error in Durable Object storage caused object to be reset';
mkdirSync(out, { recursive: true });
const file = `${out}/trials.jsonl`;
const run = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const jobs = [];
for (let k = 0; k < samples; k++) for (const L of LS) for (const F of FS) jobs.push({ L, F, k });

function shuffle(list) {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
}
shuffle(jobs);

const retryTrials = [];
const retryChains = [];

const classOf = (msg) => {
	if (msg.includes('code was updated')) return 'code_update';
	if (msg.includes(RESET)) return 'storage_reset';
	if (msg.includes('exceeded timeout')) return 'storage_timeout';
	if (/memory limit/i.test(msg)) return 'memory';
	if (/cpu time|cpu limit|exceeded cpu/i.test(msg)) return 'cpu';
	return 'other';
};

async function trial(job, order) {
	const object = `floor-${run}-L${job.L}-F${job.F}-k${job.k}-a${job.attempt ?? 1}`;
	const t0 = Date.now();
	let reply = null;
	let clientError = null;
	try {
		const res = await fetch(`${base}/?do=${object}&L=${job.L}&F=${job.F}`);
		reply = await res.json();
	} catch (e) {
		clientError = String(e).slice(0, 300);
	}
	const reqWallMs = Date.now() - t0;
	const ok = reply?.ok === true;
	const error = clientError ?? (ok ? null : (reply?.error ?? 'no reply'));
	const cls = ok ? 'ok' : clientError ? 'client' : classOf(error);
	if (cls === 'code_update' && !job.attempt) retryTrials.push({ ...job, attempt: 2 });

	await sleep(t0 + job.F * 1000 + 5000 - Date.now());
	let read = null;
	let readError = null;
	try {
		const res = await fetch(`${base}/read?do=${object}`);
		const r = await res.json();
		read = r.ok === true ? r.body : null;
		readError = r.ok === true ? null : (r.error ?? 'no read reply');
	} catch (e) {
		readError = String(e).slice(0, 300);
	}
	const rec = {
		order,
		L: job.L,
		F: job.F,
		k: job.k,
		attempt: job.attempt ?? 1,
		object,
		ok,
		cls,
		error,
		reqWallMs,
		slices: ok ? reply.body.slices : null,
		actualMs: ok ? reply.body.actualMs : null,
		markerRows: read?.markerRows ?? null,
		effectRows: read?.effectRows ?? null,
		alarmAt: read?.alarmAt ?? null,
		readCls: read ? 'ok' : classOf(readError ?? ''),
		readError
	};
	appendFileSync(file, `${JSON.stringify(rec)}\n`);
	console.log(
		`order=${order} L=${job.L} F=${job.F} k=${job.k} cls=${cls} actualMs=${rec.actualMs} alarmAt=${rec.alarmAt} readCls=${rec.readCls}`
	);
}

// warm arm: one object per chain, EVENTS back-to-back events of length L, alarm set at each event's start
const CHAINS = Number(process.env.CHAINS ?? 5);
const EVENTS = Number(process.env.EVENTS ?? 24);
const WARM_FS = [5, 10, 15];
const wfile = `${out}/chains.jsonl`;
const wjobs = [];
for (let c = 0; c < CHAINS; c++)
	for (const L of LS) for (const F of WARM_FS) wjobs.push({ L, F, c });
shuffle(wjobs);

async function chain(job, order) {
	const object = `warm-${run}-L${job.L}-F${job.F}-c${job.c}-a${job.attempt ?? 1}`;
	const events = [];
	for (let ev = 1; ev <= EVENTS; ev++) {
		const t0 = Date.now();
		let reply = null;
		let clientError = null;
		try {
			const res = await fetch(`${base}/?do=${object}&L=${job.L}&F=${job.F}`);
			reply = await res.json();
		} catch (e) {
			clientError = String(e).slice(0, 300);
		}
		const ok = reply?.ok === true;
		const error = clientError ?? (ok ? null : (reply?.error ?? 'no reply'));
		events.push({
			ev,
			ok,
			cls: ok ? 'ok' : clientError ? 'client' : classOf(error),
			error,
			wallMs: Date.now() - t0,
			iso: ok ? reply.body.iso : null,
			slices: ok ? reply.body.slices : null,
			actualMs: ok ? reply.body.actualMs : null
		});
	}
	if (events.some((e) => e.cls === 'code_update') && !job.attempt)
		retryChains.push({ ...job, attempt: 2 });
	appendFileSync(
		wfile,
		`${JSON.stringify({ order, L: job.L, F: job.F, c: job.c, attempt: job.attempt ?? 1, object, events })}\n`
	);
	console.log(
		`chain order=${order} L=${job.L} F=${job.F} c=${job.c} resets=${events.filter((e) => e.cls === 'storage_reset').length}`
	);
}

async function pool(list, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: conc }, async () => {
			while (next < list.length) {
				const i = next++;
				await fn(list[i], i);
			}
		})
	);
}

await pool(jobs, trial);
console.log(`requeue trials=${retryTrials.length}`);
await pool(retryTrials, trial);
await pool(wjobs, chain);
console.log(`requeue chains=${retryChains.length}`);
await pool(retryChains, chain);
await sleep(30000);
console.log(`trials=${jobs.length} chains=${wjobs.length}`);
console.log(file);
console.log(wfile);
