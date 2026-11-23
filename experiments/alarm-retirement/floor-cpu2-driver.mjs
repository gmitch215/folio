import { appendFileSync, mkdirSync } from 'node:fs';

// storage-yield arm (no alarm, C 1 to 8 s) and cadence arm (C 2 and 4 s, alarm re-arming every 2 s vs none),
// 10 fresh objects per cell, shuffled together, one request at a time. C is nominal CPU seconds (4 slices per s).
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
const N = 10;
const CELLS = [
	{ arm: 'storage', C: 1, alarm: 'none' },
	{ arm: 'storage', C: 2, alarm: 'none' },
	{ arm: 'storage', C: 4, alarm: 'none' },
	{ arm: 'storage', C: 8, alarm: 'none' },
	{ arm: 'cadence', C: 2, alarm: 'cadence' },
	{ arm: 'cadence', C: 2, alarm: 'none' },
	{ arm: 'cadence', C: 4, alarm: 'cadence' },
	{ arm: 'cadence', C: 4, alarm: 'none' }
];
mkdirSync(out, { recursive: true });
const file = `${out}/cpu2.jsonl`;
const run = Date.now();
const slicesOf = (c) => Math.round(c / 0.25);

function shuffle(list) {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
}

const jobs = [];
for (const cell of CELLS) for (let k = 0; k < N; k++) jobs.push({ ...cell, k });
shuffle(jobs);

for (let order = 0; order < jobs.length; order++) {
	const job = jobs[order];
	const object = `cpu2-${run}-${job.arm}-C${job.C}-${job.alarm}-k${job.k}`;
	const t0 = Date.now();
	let reply = null;
	let clientError = null;
	try {
		const res = await fetch(
			`${base}/?do=${object}&slices=${slicesOf(job.C)}&alarm=${job.alarm}`
		);
		reply = await res.json();
	} catch (e) {
		clientError = String(e).slice(0, 300);
	}
	const ok = reply?.ok === true;
	const error = clientError ?? (ok ? null : (reply?.error ?? 'no reply'));
	const cls = ok
		? 'ok'
		: clientError
			? 'client'
			: String(error).includes('reset')
				? 'reset'
				: 'other';
	const rec = {
		order,
		arm: job.arm,
		C: job.C,
		alarm: job.alarm,
		k: job.k,
		object,
		ok,
		cls,
		error,
		codeUpdated: String(error ?? '').includes('code was updated'),
		slices: ok ? reply.body.slices : null,
		actualMs: ok ? reply.body.actualMs : null,
		iso: ok ? reply.body.iso : null,
		reqWallMs: Date.now() - t0
	};
	appendFileSync(file, `${JSON.stringify(rec)}\n`);
	console.log(
		`order=${order} arm=${job.arm} C=${job.C} alarm=${job.alarm} k=${job.k} cls=${cls} slices=${rec.slices} actualMs=${rec.actualMs} error=${error ?? ''}`
	);
}
console.log(`trials=${jobs.length}`);
console.log(file);
