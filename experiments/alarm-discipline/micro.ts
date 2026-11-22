import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const arms = (process.env.ARMS ?? 'A,B,C,D,E').split(',');
const objects = Number(process.env.OBJECTS ?? 4);
const batch = Number(process.env.BATCH ?? 100);
const batches = Number(process.env.BATCHES ?? 5);
const outDir = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));
const run = Date.now();
const platform = /Internal error in Durable Object storage|reset/;

type Route = {
	inst: string;
	arm: string;
	n: number;
	done: number;
	failures: number;
	inserts: number;
	handlerRuns: number;
	handlerFailures: number;
	errors: string[];
	ms: number;
};

type Wrapped = { ok: boolean; error?: string; body?: Route };

type Totals = {
	arm: string;
	attempted: number;
	reported: number;
	done: number;
	failures: number;
	inserts: number;
	handlerRuns: number;
	handlerFailures: number;
	clientErrors: number;
	platformErrors: number;
	resets: number;
	rate: number;
	wilson95: [number, number];
	errors: string[];
	clientMessages: string[];
};

const zero = (arm: string): Totals => ({
	arm,
	attempted: 0,
	reported: 0,
	done: 0,
	failures: 0,
	inserts: 0,
	handlerRuns: 0,
	handlerFailures: 0,
	clientErrors: 0,
	platformErrors: 0,
	resets: 0,
	rate: 0,
	wilson95: [0, 1],
	errors: [],
	clientMessages: []
});

const addDistinct = (list: string[], msg: string) => {
	if (list.length < 5 && !list.includes(msg)) list.push(msg);
};

function wilson(k: number, n: number): [number, number] {
	if (n === 0) return [0, 1];
	const z = 1.959963984540054;
	const z2 = z * z;
	const p = k / n;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

async function runArm(arm: string): Promise<Totals> {
	const t = zero(arm);
	for (let o = 0; o < objects; o++) {
		const name = `m${arm}-${run}-${o}`;
		let last: string | null = null;
		for (let b = 0; b < batches; b++) {
			t.attempted += batch;
			let status = 0;
			let text = '';
			let wrapped: Wrapped | null = null;
			let fetchError = '';
			try {
				const res = await fetch(`${base}/?do=${name}&micro=${arm}&n=${batch}`);
				status = res.status;
				text = await res.text();
				wrapped = JSON.parse(text) as Wrapped;
			} catch (e) {
				fetchError = `fetch:${String(e).slice(0, 120)}`;
			}
			const body = wrapped?.ok === true ? wrapped.body : undefined;
			if (status === 200 && body) {
				t.reported += body.n;
				t.done += body.done;
				t.failures += body.failures;
				t.inserts += body.inserts;
				t.handlerRuns += body.handlerRuns;
				t.handlerFailures += body.handlerFailures;
				for (const msg of body.errors) addDistinct(t.errors, msg);
				if (last !== null && body.inst !== last) t.resets++;
				last = body.inst;
			} else {
				t.clientErrors++;
				if (platform.test(text)) t.platformErrors++;
				addDistinct(t.clientMessages, fetchError || wrapped?.error || `status ${status}`);
			}
		}
	}
	t.rate = t.reported === 0 ? 0 : t.failures / t.reported;
	t.wilson95 = wilson(t.failures, t.reported);
	return t;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

const out: Totals[] = [];
for (const arm of arms) {
	const t = await runArm(arm);
	out.push(t);
	const [lo, hi] = t.wilson95;
	console.log(
		`${t.arm} attempted=${t.attempted} reported=${t.reported} done=${t.done} ` +
			`failures=${t.failures} clientErrors=${t.clientErrors} ` +
			`platformErrors=${t.platformErrors} resets=${t.resets} ` +
			`rate=${pct(t.rate)} wilson95=[${pct(lo)}, ${pct(hi)}] inserts=${t.inserts}`
	);
}

mkdirSync(outDir, { recursive: true });
const file = `${outDir}/micro-${run}.json`;
writeFileSync(file, `${JSON.stringify({ run, objects, batch, batches, arms: out }, null, '\t')}\n`);
console.log(`wrote ${file}`);
