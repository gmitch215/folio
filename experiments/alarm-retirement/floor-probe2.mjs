import { appendFileSync, mkdirSync } from 'node:fs';

// three L=2 F=15 requests per pre-loop variant, one at a time, fresh objects; variants run A, B, C, D, E
// exit 0 when every variant has 3 of 3 requests within 1 s of 2,000 ms with no code-updated error
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
mkdirSync(out, { recursive: true });
const file = `${out}/probe2.jsonl`;
const run = Date.now();
const VARIANTS = ['A', 'B', 'C', 'D', 'E'];
const N = 3;
const passBy = {};

for (const v of VARIANTS) {
	passBy[v] = 0;
	for (let i = 0; i < N; i++) {
		const object = `smoke-${v}-${run}-${i}`;
		const t0 = Date.now();
		let status = null;
		let reply = null;
		let clientError = null;
		try {
			const res = await fetch(`${base}/?do=${object}&L=2&F=15&v=${v}`);
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
		const pass = ok && actualMs !== null && Math.abs(actualMs - 2000) <= 1000 && !codeUpdated;
		if (pass) passBy[v]++;
		const rec = {
			variant: v,
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
			`variant=${v} i=${i} status=${status} ok=${ok} actualMs=${actualMs} slices=${slices} codeUpdated=${codeUpdated} pass=${pass} error=${error ?? ''}`
		);
	}
}
for (const v of VARIANTS) console.log(`pass ${v}: ${passBy[v]} of ${N}`);
const allPass = VARIANTS.every((v) => passBy[v] === N);
console.log(`all variants pass: ${allPass}`);
process.exit(allPass ? 0 : 1);
