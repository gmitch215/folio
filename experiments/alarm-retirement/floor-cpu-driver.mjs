import { appendFileSync, mkdirSync } from 'node:fs';

// arm 1 (no alarm) and arm 2 (alarm armed before the loop) fresh objects, shuffled together, one at a time;
// then arm 3, warm objects with back-to-back requests at C = 1 s. C is CPU seconds in 250 ms slices.
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
const CS = [0, 0.25, 0.5, 1, 2, 4];
const N_ARM1 = 10;
const N_ARM2 = 5;
const CHAINS = 5;
const EVENTS = 6;
const WARM_C = 1;
mkdirSync(out, { recursive: true });
const file = `${out}/cpu.jsonl`;
const wfile = `${out}/warm.jsonl`;
const run = Date.now();
const slicesOf = (c) => Math.round(c / 0.25);

function shuffle(list) {
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
}

const classOf = (ok, clientError, error) => {
	if (ok) return 'ok';
	if (clientError) return 'client';
	if (String(error).includes('reset')) return 'reset';
	return 'other';
};

async function request(object, slices, arm) {
	const t0 = Date.now();
	let reply = null;
	let clientError = null;
	try {
		const res = await fetch(`${base}/?do=${object}&slices=${slices}&arm=${arm}`);
		reply = await res.json();
	} catch (e) {
		clientError = String(e).slice(0, 300);
	}
	const ok = reply?.ok === true;
	const error = clientError ?? (ok ? null : (reply?.error ?? 'no reply'));
	return {
		object,
		ok,
		cls: classOf(ok, clientError, error),
		error,
		codeUpdated: String(error ?? '').includes('code was updated'),
		slices: ok ? reply.body.slices : null,
		actualMs: ok ? reply.body.actualMs : null,
		iso: ok ? reply.body.iso : null,
		reqWallMs: Date.now() - t0
	};
}

const fresh = [];
for (const c of CS) {
	for (let k = 0; k < N_ARM1; k++) fresh.push({ arm: 'none', c, k });
	for (let k = 0; k < N_ARM2; k++) fresh.push({ arm: 'alarm', c, k });
}
shuffle(fresh);

for (let order = 0; order < fresh.length; order++) {
	const job = fresh[order];
	const object = `cpu-${run}-${job.arm}-C${job.c}-k${job.k}`;
	const rec = {
		order,
		arm: job.arm,
		C: job.c,
		k: job.k,
		...(await request(object, slicesOf(job.c), job.arm))
	};
	appendFileSync(file, `${JSON.stringify(rec)}\n`);
	console.log(
		`order=${order} arm=${job.arm} C=${job.c} k=${job.k} cls=${rec.cls} slices=${rec.slices} actualMs=${rec.actualMs} error=${rec.error ?? ''}`
	);
}

const chains = [];
for (let c = 0; c < CHAINS; c++) chains.push(c);
shuffle(chains);
for (const c of chains) {
	const object = `warm-${run}-c${c}`;
	const events = [];
	for (let ev = 1; ev <= EVENTS; ev++) {
		events.push({ ev, ...(await request(object, slicesOf(WARM_C), 'none')) });
	}
	appendFileSync(wfile, `${JSON.stringify({ c, object, C: WARM_C, events })}\n`);
	console.log(
		`chain c=${c} cls=${events.map((e) => e.cls).join(',')} iso=${events.map((e) => e.iso).join(',')}`
	);
}

await new Promise((r) => setTimeout(r, 20000));
console.log(`fresh=${fresh.length} chains=${chains.length}`);
console.log(file);
console.log(wfile);
