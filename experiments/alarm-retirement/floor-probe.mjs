import { appendFileSync, mkdirSync } from 'node:fs';

// three L=2 F=15 requests per mode, one at a time, fresh objects; modes run in the order get, wait, both
// exit 0 when every mode has 3 of 3 requests within 1 s of 2,000 ms with no code-updated error
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const out = process.env.OUT;
if (!out) throw new Error('set OUT');
mkdirSync(out, { recursive: true });
const file = `${out}/probe.jsonl`;
const run = Date.now();
const MODES = ['get', 'wait', 'both'];
const N = 3;
const passByMode = {};

for (const mode of MODES) {
	passByMode[mode] = 0;
	for (let i = 0; i < N; i++) {
		const object = `smoke-${mode}-${run}-${i}`;
		const t0 = Date.now();
		let status = null;
		let reply = null;
		let clientError = null;
		try {
			const res = await fetch(`${base}/?do=${object}&L=2&F=15&mode=${mode}`);
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
		if (pass) passByMode[mode]++;
		const rec = {
			mode,
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
			`mode=${mode} i=${i} status=${status} ok=${ok} actualMs=${actualMs} slices=${slices} codeUpdated=${codeUpdated} pass=${pass} error=${error ?? ''}`
		);
	}
}
for (const mode of MODES) console.log(`pass ${mode}: ${passByMode[mode]} of ${N}`);
const allPass = MODES.every((m) => passByMode[m] === N);
console.log(`all modes pass: ${allPass}`);
process.exit(allPass ? 0 : 1);
