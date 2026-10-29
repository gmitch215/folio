import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { digest, researchEnvironment } from './environment.ts';

async function manual(module: WebAssembly.Module, memory: WebAssembly.Memory, width: number) {
	let sequence = 0;
	const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
	const workers = await Promise.all(
		Array.from({ length: width }, async () => {
			const worker = new Worker(new URL('./crossover-worker.ts', import.meta.url), {
				workerData: { module, memory }
			});
			await new Promise<void>((resolve, reject) => {
				worker.on('error', reject);
				worker.on('message', (row) => {
					if (row.ready) resolve();
					else {
						const item = pending.get(row.id)!;
						pending.delete(row.id);
						if (row.error) item.reject(new Error(row.error));
						else item.resolve();
					}
				});
			});
			return worker;
		})
	);
	return {
		run: async (count: number, rounds: number) => {
			await Promise.all(
				workers.map(
					(worker, index) =>
						new Promise<void>((resolve, reject) => {
							const begin = Math.floor((count * index) / width),
								end = Math.floor((count * (index + 1)) / width),
								id = sequence++;
							pending.set(id, { resolve, reject });
							worker.postMessage({
								id,
								args: [1024 + begin * 4, end - begin, rounds]
							});
						})
				)
			);
			return undefined;
		},
		close: async () => {
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	};
}

if (import.meta.main) {
	const [directory, pairsArg = '9'] = process.argv.slice(2),
		pairs = Number(pairsArg);
	assert.ok(directory && Number.isSafeInteger(pairs) && pairs > 0);
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	emit(
		researchEnvironment({
			pairs,
			warmup: 2,
			widths: [1, 2, 4, 8],
			synthetic: true,
			verificationIncluded: false
		})
	);
	const source = new Uint8Array(readFileSync('build/fixture.wasm'));
	// Identical memory/instructions with only the import shared bit changed for the snapshot ablation.
	const m = binaryen.readBinary(source),
		text = m.emitText();
	m.dispose();
	const unshared = binaryen.parseText(
		text.replace(/\(memory (\$[^ ]+ )?(\d+) (\d+) shared\)/, '(memory $1$2 $3)')
	);
	const unsharedBytes = unshared.emitBinary();
	unshared.dispose();
	const cells = [
		...[16, 256, 4096, 65536, 1048576].map((rounds) => ({
			kind: 'compute',
			count: 64,
			rounds,
			entry: 'program',
			pages: 2
		})),
		...[4096, 65536, 1048576].map((count) => ({
			kind: 'stream',
			count,
			rounds: 1,
			entry: 'program',
			pages: Math.max(2, Math.ceil((1024 + count * 4) / 65536))
		})),
		...['aliased_program', 'dependent_program'].map((entry) => ({
			kind: 'conflict',
			count: 64,
			rounds: 4096,
			entry,
			pages: 2
		}))
	];
	for (const cell of cells) {
		const memory = new WebAssembly.Memory({ initial: cell.pages, maximum: 8192, shared: true });
		const instance = new WebAssembly.Instance(new WebAssembly.Module(source), {
			env: { memory }
		});
		const args =
			cell.entry === 'dependent_program'
				? [1024, cell.count]
				: [1024, cell.count, cell.rounds];
		const initialize = (target: WebAssembly.Memory) => {
			new Uint8Array(target.buffer).fill(0);
			const words = new Uint32Array(target.buffer, 1024, cell.count);
			for (let index = 0; index < words.length; index++)
				words[index] = Math.imul(index + 1, 2654435761) >>> 0;
		};
		initialize(memory);
		(instance.exports[cell.entry] as CallableFunction)(...args);
		const expected = new Uint8Array(memory.buffer).slice(),
			expectedSha256 = digest(expected);
		const arms: {
			name: string;
			memory: WebAssembly.Memory;
			run: () => Promise<unknown>;
			close: () => Promise<void>;
		}[] = [
			{
				name: 'native',
				memory,
				run: async () => (instance.exports[cell.entry] as CallableFunction)(...args),
				close: async () => {}
			}
		];
		try {
			for (const width of [1, 2, 4, 8]) {
				const pool = await Folio.open(source, { memory, workers: width, profile: true });
				arms.push({
					name: `auto-${width}`,
					memory,
					run: () => pool.run(cell.entry, args),
					close: () => pool.close()
				});
				if (width > 1)
					arms.push({
						name: `tracked-${width}`,
						memory,
						run: () => pool.run(cell.entry, args, { parallel: 'speculate' }),
						close: async () => {}
					});
				if (cell.kind !== 'conflict') {
					const workers = await manual(new WebAssembly.Module(source), memory, width);
					arms.push({
						name: `manual-${width}`,
						memory,
						run: () => workers.run(cell.count, cell.rounds),
						close: workers.close
					});
				}
			}
			if (cell.kind === 'compute' && cell.rounds === 65536) {
				const unsharedMemory = new WebAssembly.Memory({
					initial: cell.pages,
					maximum: 8192
				});
				const pool = await Folio.open(prepare(unsharedBytes, { minimumRegionWork: 0 }), {
					memory: unsharedMemory,
					workers: 4,
					minimumParallelWork: 0,
					profile: true
				});
				arms.push({
					name: 'snapshot-4',
					memory: unsharedMemory,
					run: () =>
						pool.runAll(
							Array.from({ length: cell.count }, (_, index) => ({
								export: 'mix',
								args: [1024 + index * 4, cell.rounds]
							}))
						),
					close: () => pool.close()
				});
			}
			for (let round = -2; round < pairs; round++)
				for (let turn = 0; turn < arms.length; turn++) {
					const arm = arms[(turn + round + 2) % arms.length]!;
					initialize(arm.memory);
					const load = loadavg(),
						cpu = process.cpuUsage(),
						start = performance.now(),
						report = await arm.run();
					const wallMs = performance.now() - start,
						used = process.cpuUsage(cpu);
					assert.ok(
						Buffer.from(arm.memory.buffer).equals(Buffer.from(expected)),
						`${cell.entry} ${arm.name}`
					);
					if (round >= 0)
						emit({
							kind: 'sample',
							cell,
							arm: arm.name,
							round,
							wallMs,
							cpuMs: (used.user + used.system) / 1000,
							load,
							report,
							passed: true,
							verifiedBytes: expected.length,
							outputSha256: expectedSha256
						});
				}
			console.log(JSON.stringify(cell));
		} finally {
			for (const arm of arms) await arm.close();
		}
	}
	emit({ kind: 'closed', complete: true });
}
