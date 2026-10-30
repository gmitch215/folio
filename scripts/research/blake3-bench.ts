import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepare, prepareContext } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { TaskPool } from '../../src/tasks.ts';
import { BASE, DATA, contextPages } from './blake3-worker.ts';
import { researchEnvironment } from './environment.ts';

const root = new URL('../../', import.meta.url).pathname;
const [output, roundsArg = '9', filesArg = '32', megabytesArg = '4', mode = 'run'] =
	process.argv.slice(2);
if (!output)
	throw new Error('usage: blake3-bench.ts OUTPUT.jsonl [ROUNDS] [FILES] [MIB] [run|forced]');
const rounds = Number(roundsArg),
	files = Number(filesArg),
	size = Number(megabytesArg) * 1048576,
	width = 8,
	warmups = 2;
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');
const bytes = new Uint8Array(
	readFileSync(join(root, 'build/research/blake3/blake3-hash-all.wasm'))
);

// inputs are pseudo-random and held in ordinary host buffers, as if read from files
const inputs = Array.from({ length: files }, (_, index) => {
	const data = new Uint8Array(size);
	let state = (0x9e3779b9 ^ Math.imul(index + 1, 2654435761)) | 0;
	for (let i = 0; i < size; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		data[i] = state & 255;
	}
	return data;
});
const pagesAll = Math.ceil((DATA + files * (size + 64)) / 65536) + 2;
const table = BASE,
	out = BASE + 8 * files;
const place = (memory: WebAssembly.Memory) => {
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer, table, 2 * files);
	let at = DATA;
	inputs.forEach((data, i) => {
		view.set(data, at);
		words[2 * i] = at;
		words[2 * i + 1] = size;
		at += size + 64;
	});
};
const digestsOf = (memory: WebAssembly.Memory) =>
	Array.from({ length: files }, (_, i) =>
		Buffer.from(memory.buffer, out + 32 * i, 32).toString('hex')
	);

const nativeMemory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
const native = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
	env: { memory: nativeMemory }
}).exports.hash_all as CallableFunction;
const nativeRun = () => {
	place(nativeMemory);
	native(table, files, out);
	return digestsOf(nativeMemory);
};
const expected = nativeRun();
const expectedSha = createHash('sha256').update(expected.join()).digest('hex');
emit({
	...researchEnvironment({ rounds, files, mebibytes: size / 1048576, width, mode }),
	wasmSha256: createHash('sha256').update(bytes).digest('hex'),
	digestsSha256: expectedSha
});

type Arm = {
	name: string;
	open: () => Promise<{
		run: () => Promise<string[]>;
		info: () => object;
		close: () => Promise<void>;
	}>;
};
const arms: Arm[] = [];
if (mode === 'forced') {
	arms.push({
		name: 'forced',
		open: async () => {
			const memory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
			const pool = await Folio.open(prepare(bytes, { minimumRegionWork: 0 }), {
				imports: { env: { memory } },
				workers: width
			});
			let report: any;
			return {
				run: async () => {
					place(pool.memory);
					report = await pool.run('hash_all', [table, files, out]);
					return digestsOf(pool.memory);
				},
				info: () => ({
					mode: report?.mode,
					workers: report?.workers,
					regions: report?.regions,
					replayed: report?.replayed,
					fallbacks: report?.fallbacks
				}),
				close: () => pool.close()
			};
		}
	});
} else {
	arms.push({
		name: 'default',
		open: async () => {
			const memory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
			const pool = await Folio.open(bytes, { imports: { env: { memory } }, workers: width });
			let report: any;
			return {
				run: async () => {
					place(pool.memory);
					report = await pool.run('hash_all', [table, files, out]);
					return digestsOf(pool.memory);
				},
				info: () => ({
					mode: report?.mode,
					workers: report?.workers,
					regions: report?.regions,
					reason: report?.reason
				}),
				close: () => pool.close()
			};
		}
	});
	arms.push({
		name: 'automatic',
		open: async () => {
			const memory = new WebAssembly.Memory({
				initial: pagesAll,
				maximum: 65536,
				shared: true
			});
			const pool = await Folio.open(bytes, { memory, workers: width });
			let report: any;
			return {
				run: async () => {
					place(pool.memory);
					report = await pool.run('hash_all', [table, files, out]);
					return digestsOf(pool.memory);
				},
				info: () => ({
					mode: report?.mode,
					extraction: report?.extraction,
					workers: report?.workers,
					regions: report?.regions,
					replayed: report?.replayed,
					fallbacks: report?.fallbacks,
					reason: report?.reason,
					serial: report?.iteration?.serial,
					stopped: report?.iteration?.stopped,
					admission: report?.iteration?.admission,
					dispatchMs: report?.iteration?.dispatchMs,
					validationMs: report?.iteration?.validationMs,
					workerRunMs: report?.iteration?.workerRunMs
				}),
				close: () => pool.close()
			};
		}
	});
	arms.push({
		name: 'explicit',
		open: async () => {
			const layout = prepareContext(bytes);
			assert.deepEqual(layout.reasons, [], 'checkpoint refused');
			const module = new WebAssembly.Module(Uint8Array.from(layout.bytes));
			const pool = new TaskPool(width),
				workers: Worker[] = [];
			await Promise.all(
				Array.from({ length: width }, async (_, index) => {
					const link = pool.link(index);
					const worker = new Worker(new URL('./blake3-worker.ts', import.meta.url), {
						workerData: { blake3Worker: true, module, layout, link, bytes: size },
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
				run: async () => {
					const results = await pool.run(
						inputs.map((data) => ['hash', data] as [string, Uint8Array])
					);
					return results.map((result) => Buffer.from(result.bytes).toString('hex'));
				},
				info: () => ({ contextPages: contextPages(size) }),
				close: async () => {
					pool.close();
					await Promise.all(workers.map((worker) => worker.terminate()));
				}
			};
		}
	});
}
void existsSync;
for (const arm of arms) {
	const open = await arm.open();
	try {
		for (let round = -warmups; round < rounds; round++) {
			const order = round % 2 ? ['arm', 'native'] : ['native', 'arm'];
			for (const which of order) {
				const cpu = process.cpuUsage(),
					start = performance.now();
				const digests = which === 'native' ? nativeRun() : await open.run();
				const wallMs = performance.now() - start,
					used = process.cpuUsage(cpu);
				assert.deepEqual(digests, expected, `${arm.name} digests differ`);
				if (round >= 0)
					emit({
						kind: 'sample',
						case: arm.name,
						arm: which === 'native' ? 'native' : arm.name,
						round,
						wallMs,
						cpuMs: (used.user + used.system) / 1000,
						load: loadavg(),
						outputSha256: expectedSha,
						passed: true,
						...(which === 'native' ? {} : { report: open.info() })
					});
			}
		}
	} finally {
		await open.close();
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
}
emit({ kind: 'closed', complete: true });
console.log('done', output);
