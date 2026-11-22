import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Sequential heavy requests per arm against one object each. Counts storage resets, CPU-limit
// resets and other failures. WORKER_URL names the deployed worker.mjs; nothing else is required.
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const n = Number(process.env.N ?? 30);
const arms = (process.env.ARMS ?? 'A,B,C,D').split(',');
const iters = process.env.ITERS ?? '3e9';
const rows = process.env.ROWS ?? '20';
const kb = process.env.KB ?? '32';
const gapMs = Number(process.env.GAP ?? 200);
const outDir = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const run = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = { ok: boolean; error?: string; body?: { inst: string; handlerMs?: number } };
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

const out: Record<string, unknown> = {};
for (const arm of arms) {
	const name = `a${arm}-${run}`;
	const instances = new Set<string>();
	const ms: number[] = [];
	const handler: number[] = [];
	let ok = 0;
	let reset = 0;
	let other = 0;
	let lastOther = '';
	for (let w = 0; w < 3; w++) {
		await fetch(`${base}/?do=${name}&arm=${arm}&iters=4e8&rows=4&kb=4`).catch(() => undefined);
		await sleep(500);
	}
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		let j: Reply;
		try {
			const res = await fetch(
				`${base}/?do=${name}&arm=${arm}&iters=${iters}&rows=${rows}&kb=${kb}`
			);
			j = (await res.json()) as Reply;
		} catch (e) {
			j = { ok: false, error: `client:${String(e).slice(0, 80)}` };
		}
		if (j.ok && j.body) {
			ok++;
			instances.add(j.body.inst);
			ms.push(Math.round(performance.now() - t0));
			handler.push(j.body.handlerMs ?? 0);
		} else if (/Internal error in Durable Object storage/.test(j.error ?? '')) {
			reset++;
		} else {
			other++;
			lastOther = j.error ?? '';
		}
		await sleep(gapMs);
	}
	const row = {
		ok,
		reset,
		other,
		instances: instances.size,
		medianMs: median(ms),
		medianHandlerMs: median(handler),
		...(lastOther ? { lastOther } : {})
	};
	out[arm] = row;
	console.log(arm, JSON.stringify(row));
}
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/bare-${run}.json`, `${JSON.stringify(out, null, '\t')}\n`);
