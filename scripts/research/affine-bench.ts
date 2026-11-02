import { appendFileSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
	affineSerial,
	foldAffine,
	probeAffine,
	type AffineLayout,
	type AffineModel
} from '../../src/affine.ts';
import { crc32Combine, foldChunks } from '../../src/fold.ts';
import { TaskPool } from '../../src/tasks.ts';
import { buildAdversarial, buildMiniz, buildSubjects } from './affine-build.ts';
import { researchEnvironment } from './environment.ts';

const [output, sessionArg = '1', roundsArg = '5', sizesArg = '1,8,64', only] =
	process.argv.slice(2);
if (!output)
	throw new Error(
		'usage: affine-bench.ts OUTPUT.jsonl [SESSION] [ROUNDS] [MIB,MIB,...] [SUBJECT]'
	);
// FOLIO_AFFINE_WIDTH sets the worker count, 8 by default
const session = Number(sessionArg);
const rounds = Number(roundsArg);
const sizes = sizesArg.split(',').map(Number);
const width = Number(process.env.FOLIO_AFFINE_WIDTH ?? 8);
const warmups = 2;
const emit = (row: Record<string, unknown>) =>
	appendFileSync(output, JSON.stringify({ session, ...row }) + '\n');

const worker = new URL('./affine-worker.ts', import.meta.url);
const paths = buildSubjects();
const miniz = buildMiniz();
const subjects: [string, string, string][] = [
	...(miniz ? ([['miniz-crc32', miniz, 'mz_crc32']] as [string, string, string][]) : []),
	['crc32c', paths.crc32c!, 'crc32c'],
	['crc16', paths.crc16!, 'crc16'],
	['crc64', paths.crc64!, 'crc64'],
	['poly31', paths.poly31!, 'poly31'],
	['lcg', paths.lcg!, 'lcg']
];

const randomInput = (size: number) => {
	let state = 0x2545f491;
	const words = new Uint32Array(Math.ceil(size / 4));
	for (let i = 0; i < words.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		words[i] = state;
	}
	return new Uint8Array(words.buffer, 0, size);
};

function open(wasm: string, layout: AffineLayout) {
	const pool = new TaskPool(width);
	const workers: Worker[] = [];
	for (let index = 0; index < width; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(worker, { workerData: { link, wasm, layout }, transferList: [link.port] })
		);
	}
	return {
		pool,
		close: async () => {
			pool.close();
			await Promise.all(workers.map((w) => w.terminate()));
		}
	};
}

const cpuMs = (a: NodeJS.CpuUsage, b: NodeJS.CpuUsage) =>
	(b.user - a.user + b.system - a.system) / 1000;

type Arm = { name: string; run: () => { state: bigint; info?: object } };

function measure(subject: string, mib: number, arms: Arm[], expected: bigint, drain: () => number) {
	for (let round = -warmups; round < rounds; round++) {
		const order = round % 2 ? [...arms].reverse() : arms;
		for (const arm of order) {
			drain();
			const cpu = process.cpuUsage();
			const start = performance.now();
			const { state, info } = arm.run();
			const ms = performance.now() - start;
			const cpuTotal = cpuMs(cpu, process.cpuUsage());
			const workerCpu = drain();
			if (round < 0) continue;
			emit({
				kind: 'sample',
				subject,
				mib,
				width,
				arm: arm.name,
				round,
				ms,
				cpuMs: cpuTotal,
				workerCpuMs: workerCpu,
				equal: state === expected,
				...info
			});
		}
	}
}

emit({
	...researchEnvironment({ rounds, sizes, width, warmups, session }),
	loadStart: loadavg()
});

for (const [name, wasm, entry] of subjects) {
	if (only && only !== name) continue;
	const bytes = readFileSync(wasm);
	const t0 = performance.now();
	const model = probeAffine(bytes, entry);
	const probeMs = performance.now() - t0;
	if (model.kind !== 'model') {
		emit({ kind: 'refused', subject: name, reason: model.reason });
		continue;
	}
	emit({
		kind: 'discovery',
		subject: name,
		ring: model.ring,
		bits: model.bits,
		ms: probeMs,
		calls: model.calls,
		checks: model.checks.map((c) => `${c.name}:${c.trials}`),
		load: loadavg()
	});
	const run = affineSerial({ module: new WebAssembly.Module(bytes), layout: model.layout });
	const { pool, close } = open(wasm, model.layout);
	const drain = () => pool.drain().reduce((sum, r) => sum + (r.cpuMs ?? 0), 0);
	try {
		for (const mib of sizes) {
			const input = randomInput(mib * 1024 * 1024);
			const expected = run(input);
			const arms: Arm[] = [
				{ name: 'serial', run: () => ({ state: run(input) }) },
				{
					name: 'exact',
					run: () => {
						const r = foldAffine(pool, input, model, { mode: 'exact' });
						return {
							state: r.state,
							info: { tasks: r.tasks, mismatchAt: r.mismatchAt }
						};
					}
				},
				{
					name: 'audit',
					run: () => {
						const r = foldAffine(pool, input, model, { mode: 'audit', audit: 2 });
						return {
							state: r.state,
							info: { tasks: r.tasks, mismatchAt: r.mismatchAt }
						};
					}
				}
			];
			if (name === 'miniz-crc32')
				arms.push({
					name: 'combine',
					run: () => {
						const state = foldChunks(pool, input, {
							task: () => 'affine:0',
							initial: 0,
							combine: (acc, part, chunk) =>
								crc32Combine(
									acc,
									Number(
										new DataView(
											part.bytes.buffer,
											part.bytes.byteOffset
										).getBigUint64(0, true)
									),
									chunk.end - chunk.start
								)
						});
						return { state: BigInt(state) };
					}
				});
			emit({ kind: 'load', subject: name, mib, loadBefore: loadavg() });
			measure(name, mib, arms, expected, drain);
			emit({ kind: 'load', subject: name, mib, loadAfter: loadavg() });
		}
	} finally {
		await close();
	}
}

// the adversarial control at one size: exact falls back after a mismatch, audit may miss
if (!only || only === 'adv') {
	const mib = sizes.includes(8) ? 8 : sizes[0]!;
	const input = randomInput(mib * 1024 * 1024);
	const at = Math.floor((input.length / width) * 3.5);
	const table = Uint32Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		return c >>> 0;
	});
	let reg = 0;
	for (let i = 0; i < at; i++) reg = ((reg >>> 8) ^ table[(reg ^ input[i]!) & 255]!) >>> 0;
	const wasm = buildAdversarial(reg);
	const bytes = readFileSync(wasm);
	const model = probeAffine(bytes, 'adv') as AffineModel;
	emit({ kind: 'discovery', subject: 'adv', ring: model.ring, calls: model.calls });
	const run = affineSerial({ module: new WebAssembly.Module(bytes), layout: model.layout });
	const expected = run(input);
	const { pool, close } = open(wasm, model.layout);
	const drain = () => pool.drain().reduce((sum, r) => sum + (r.cpuMs ?? 0), 0);
	try {
		const info = (r: ReturnType<typeof foldAffine>) => ({
			tasks: r.tasks,
			mismatchAt: r.mismatchAt,
			fallbackBytes: r.fallbackBytes
		});
		const arms: Arm[] = [
			{ name: 'serial', run: () => ({ state: run(input) }) },
			{
				name: 'exact',
				run: () => {
					const r = foldAffine(pool, input, model, { mode: 'exact' });
					return { state: r.state, info: info(r) };
				}
			}
		];
		for (let seed = 1; seed <= 7; seed++)
			arms.push({
				name: `audit-seed-${seed}`,
				run: () => {
					const r = foldAffine(pool, input, model, { mode: 'audit', audit: 2, seed });
					return { state: r.state, info: info(r) };
				}
			});
		measure('adv', mib, arms, expected, drain);
	} finally {
		await close();
	}
}
