import { appendFileSync, mkdirSync } from 'node:fs';

// idle requests: three fresh objects per cell, one at a time; (2,1) is the positive control and is not a pass gate
// exit 0 when both harness cells (2,15) and (8,15) have 3 of 3 requests ok, actualMs within 1 s of L, no code-updated error
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
mkdirSync(out, { recursive: true });
const file = `${out}/probe3.jsonl`;
const run = Date.now();
const CELLS = [
	{ L: 2, F: 15, control: false },
	{ L: 8, F: 15, control: false },
	{ L: 2, F: 1, control: true },
	{ L: 8, F: 5, control: false }
];
const N = 3;
const passBy = {};

for (const cell of CELLS) {
	const key = `L${cell.L}F${cell.F}`;
	passBy[key] = 0;
	for (let i = 0; i < N; i++) {
		const object = `smoke-${key}-${run}-${i}`;
		const t0 = Date.now();
		let status = null;
		let reply = null;
		let clientError = null;
		try {
			const res = await fetch(`${base}/?do=${object}&L=${cell.L}&F=${cell.F}`);
			status = res.status;
			reply = await res.json();
		} catch (e) {
			clientError = String(e).slice(0, 300);
		}
		const ok = reply?.ok === true;
		const actualMs = ok ? (reply.body?.actualMs ?? null) : null;
		const slices = ok ? (reply.body?.slices ?? null) : null;
		const error = clientError ?? (ok ? null : (reply?.error ?? 'no reply'));
		const codeUpdated = String(error ?? '').includes('code was updated');
		const pass =
			ok && actualMs !== null && Math.abs(actualMs - cell.L * 1000) <= 1000 && !codeUpdated;
		if (pass) passBy[key]++;
		const rec = {
			variant: key,
			control: cell.control,
			i,
			object,
			status,
			ok,
			actualMs,
			slices,
			error,
			codeUpdated,
			pass,
			wallMs: Date.now() - t0
		};
		appendFileSync(file, `${JSON.stringify(rec)}\n`);
		console.log(
			`cell=${key} i=${i} status=${status} ok=${ok} actualMs=${actualMs} waits=${slices} codeUpdated=${codeUpdated} pass=${pass} error=${error ?? ''}`
		);
	}
}
for (const cell of CELLS) {
	const key = `L${cell.L}F${cell.F}`;
	console.log(`pass ${key}${cell.control ? ' (control)' : ''}: ${passBy[key]} of ${N}`);
}
const harnessPass = ['L2F15', 'L8F15'].every((k) => passBy[k] === N);
console.log(`harness cells pass: ${harnessPass}`);
process.exit(harnessPass ? 0 : 1);
