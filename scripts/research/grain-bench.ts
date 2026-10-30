import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepareContext } from '../../src/compiler.ts';
import { TaskPool } from '../../src/tasks.ts';
import { grainContext } from './grain-worker.ts';

const root = new URL('../../', import.meta.url).pathname;
const [output, roundsArg = '3', warmArg = '2', variant = 'small'] = process.argv.slice(2);
if (!output) throw new Error('usage: grain-bench.ts OUTPUT.jsonl [ROUNDS] [WARMUPS] [small|stock]');
const pages = variant === 'small' ? 16 : 128;
const rounds = Number(roundsArg),
	warmups = Number(warmArg);
const raw = output;
writeFileSync(raw, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');

const bytes = new Uint8Array(
	readFileSync(join(root, `build/research/grain/aes-grain-${variant}.wasm`))
);
const layout = prepareContext(bytes);
assert.deepEqual(layout.reasons, [], 'checkpoint refused');
const module = new WebAssembly.Module(Uint8Array.from(layout.bytes));
const control = grainContext(module, layout, pages);
control.entry(false);
const expected = Buffer.from(new Uint8Array(control.memory.buffer, control.base, 65536));
emit({
	kind: 'environment',
	node: process.version,
	cpu: (await import('node:os')).cpus()[0]?.model,
	threads: (await import('node:os')).cpus().length,
	load: loadavg(),
	rounds,
	warmups,
	variant,
	reset: `InstanceCheckpoint.restore(changed), ${pages} pages compared per call`,
	outputSha256: createHash('sha256').update(expected).digest('hex'),
	wasmSha256: createHash('sha256').update(bytes).digest('hex')
});

async function open(width: number) {
	const pool = new TaskPool(width),
		workers: Worker[] = [];
	await Promise.all(
		Array.from({ length: width }, async (_, index) => {
			const link = pool.link(index);
			const worker = new Worker(new URL('./grain-worker.ts', import.meta.url), {
				workerData: {
					grainWorker: true,
					module,
					layout,
					pages,
					link,
					noReset: process.env.GRAIN_NORESET === '1'
				},
				transferList: [link.port]
			});
			workers.push(worker);
			await new Promise<void>((resolve, reject) => {
				worker.once('message', () => resolve());
				worker.once('error', reject);
			});
		})
	);
	return {
		call(result: Uint8Array) {
			const per = 4096 / width;
			const handles = Array.from({ length: width }, (_, i) =>
				pool.submit('range', `${i * per},${per}`)
			);
			const phases = { reset: 0, compute: 0, dispatch: 0, workerWall: 0 };
			handles.forEach((handle, i) => {
				const r = pool.join(handle);
				result.set(r.bytes.subarray(16), i * per * 16);
				const [resetMs, computeMs] = new Float64Array(r.bytes.slice(0, 16).buffer);
				phases.reset = Math.max(phases.reset, resetMs!);
				phases.compute = Math.max(phases.compute, computeMs!);
				phases.dispatch = Math.max(phases.dispatch, r.record.startMs - r.record.submitMs);
				phases.workerWall = Math.max(phases.workerWall, r.record.endMs - r.record.startMs);
			});
			return phases;
		},
		async close() {
			pool.close();
			await Promise.all(workers.map((w) => w.terminate()));
		}
	};
}

const result = new Uint8Array(65536);
const sample = (arm: string, width: number, round: number, run: () => unknown) => {
	result.fill(0);
	const cpu = process.cpuUsage(),
		start = performance.now();
	const extra = run();
	const wallMs = performance.now() - start,
		used = process.cpuUsage(cpu);
	assert.ok(Buffer.from(result).equals(expected), `${arm} output differs`);
	if (round >= 0)
		emit({
			kind: 'sample',
			width,
			arm,
			round,
			wallMs,
			cpuMs: (used.user + used.system) / 1000,
			load: loadavg(),
			phases: extra
		});
};
const arms = (pool: Awaited<ReturnType<typeof open>>, width: number) => ({
	control_reset: () => {
		control.entry(true);
		result.set(new Uint8Array(control.memory.buffer, control.base, 65536));
	},
	control_hot: () => {
		control.entry(false);
		result.set(new Uint8Array(control.memory.buffer, control.base, 65536));
	},
	pool: () => pool.call(result)
});
for (const width of [8, 1]) {
	const pool = await open(width);
	try {
		const a = arms(pool, width);
		for (let round = -warmups; round < rounds; round++) {
			const order =
				round % 2
					? ['pool', 'control_reset', 'control_hot']
					: ['control_hot', 'control_reset', 'pool'];
			for (const arm of order)
				sample(arm === 'pool' ? `pool` : arm, width, round, a[arm as keyof typeof a]);
		}
	} finally {
		await pool.close();
	}
	await new Promise((r) => setTimeout(r, 300));
}
emit({ kind: 'closed', load: loadavg() });
console.log('done', raw);
