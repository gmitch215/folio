import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepare, prepareContext, type PreparedContext } from '../../src/compiler.ts';
import { TaskPool } from '../../src/tasks.ts';
import { census } from '../probe/purity-census.ts';
import { kernelContext, type ResetMode } from './corpus-worker.ts';
import { corpusManifest } from './corpus.ts';
import { digest, researchEnvironment } from './environment.ts';

/** Diagnostic ABI change only: preserve every byte except the imported memory's shared flag. */
export function sharedDiagnostic(input: Uint8Array) {
	const bytes = input.slice();
	let cursor = 8,
		changed = false;
	const unsigned = () => {
		let result = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[cursor++]!;
			result += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return result;
	};
	const name = () => {
		const size = unsigned();
		cursor += size;
	};
	while (cursor < bytes.length) {
		const section = bytes[cursor++]!,
			size = unsigned(),
			end = cursor + size;
		if (section === 2) {
			const count = unsigned();
			for (let index = 0; index < count; index++) {
				name();
				name();
				const kind = bytes[cursor++]!;
				if (kind === 0) unsigned();
				else if (kind === 2) {
					assert.equal(
						bytes[cursor],
						1,
						'diagnostic requires wasm32 memory with maximum'
					);
					bytes[cursor++] = 3;
					unsigned();
					unsigned();
					changed = true;
				} else throw new Error('diagnostic supports only function and memory imports');
			}
		}
		cursor = end;
	}
	assert.ok(changed && WebAssembly.validate(bytes));
	return bytes;
}

type Result = ReturnType<ReturnType<typeof kernelContext>>;
const comparable = (rows: Result[]) => rows.map(({ value, sha256 }) => ({ value, sha256 }));
const resetMode = (process.env.FOLIO_CORPUS_RESET ?? 'whole') as ResetMode;
assert.ok(['whole', 'pages', 'checkpoint'].includes(resetMode), 'invalid reset mode');

export async function ordinary(
	module: WebAssembly.Module,
	width: number,
	layout?: PreparedContext,
	mode: ResetMode = resetMode
) {
	const workers: Worker[] = [],
		pending = new Map<
			number,
			{ resolve: (value: Result[]) => void; reject: (error: Error) => void }
		>();
	let sequence = 0;
	await Promise.all(
		Array.from({ length: width }, async () => {
			const worker = new Worker(new URL('./corpus-worker.ts', import.meta.url), {
				workerData: { researchKernel: true, module, resetMode: mode, layout }
			});
			workers.push(worker);
			await new Promise<void>((resolve, reject) => {
				worker.on('error', reject);
				worker.on('message', (message) => {
					if (message.ready) resolve();
					else {
						const item = pending.get(message.id)!;
						pending.delete(message.id);
						if (message.error) item.reject(new Error(message.error));
						else item.resolve(JSON.parse(message.output));
					}
				});
			});
		})
	);
	return {
		run: async (jobs: number, repeats: number, batch: number, verify = false) => {
			const replies: Promise<Result[]>[] = [];
			for (let index = 0; index < jobs; index += batch) {
				const id = sequence++;
				replies.push(
					new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
				);
				workers[(index / batch) % width]!.postMessage({
					id,
					input: JSON.stringify({ jobs: Math.min(batch, jobs - index), repeats, verify })
				});
			}
			return (await Promise.all(replies)).flat();
		},
		close: async () => {
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	};
}

export async function tasks(
	module: WebAssembly.Module,
	width: number,
	layout?: PreparedContext,
	mode: ResetMode = resetMode
) {
	const pool = new TaskPool(width),
		workers: Worker[] = [];
	await Promise.all(
		Array.from({ length: width }, async (_, index) => {
			const link = pool.link(index),
				worker = new Worker(new URL('./corpus-worker.ts', import.meta.url), {
					workerData: { researchKernel: true, module, link, resetMode: mode, layout },
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
		run: async (jobs: number, repeats: number, batch: number, verify = false) => {
			const handles: string[] = [];
			for (let index = 0; index < jobs; index += batch)
				handles.push(
					pool.submitJson('entry', {
						jobs: Math.min(batch, jobs - index),
						repeats,
						verify
					})
				);
			return handles.flatMap((handle) => pool.join(handle).json<Result[]>());
		},
		close: async () => {
			pool.close();
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	};
}

if (import.meta.main) {
	const [directory, pairsArg = '7', repeatsArg = '8', ...selected] = process.argv.slice(2);
	if (!directory)
		throw new Error('usage: corpus-mechanisms.ts OUTPUT_DIRECTORY [PAIRS] [REPEATS] [CASE...]');
	const pairs = Number(pairsArg),
		repeats = Number(repeatsArg),
		jobs = 16;
	assert.ok(
		Number.isSafeInteger(pairs) && pairs > 0 && Number.isSafeInteger(repeats) && repeats > 0
	);
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	emit(
		researchEnvironment({
			pairs,
			repeats,
			jobs,
			selected,
			resetMode,
			verificationIncluded: false,
			scope: 'explicit independent operations; not automatic extraction'
		})
	);
	for (const kernel of corpusManifest.cases.filter(
		(item) => !selected.length || selected.includes(item.id)
	)) {
		const bytes = new Uint8Array(
			readFileSync(`build/research/corpus/artifacts/${kernel.id}.wasm`)
		);
		const layout = resetMode === 'checkpoint' ? prepareContext(bytes) : undefined;
		const module = new WebAssembly.Module(Uint8Array.from(layout?.bytes ?? bytes)),
			prepared = prepare(bytes),
			diagnostic = prepare(sharedDiagnostic(bytes));
		const forced = prepare(bytes, { minimumRegionWork: 0 });
		emit({
			kind: 'coverage',
			checkpointRefusals: layout?.reasons,
			case: kernel.id,
			sha256: digest(bytes),
			original: {
				reasons: prepared.reasons,
				controlReasons: prepared.controlReasons,
				loops: Object.keys(prepared.loops),
				entries: prepared.control?.entries
			},
			sharedDiagnostic: {
				reasons: diagnostic.reasons,
				controlReasons: diagnostic.controlReasons,
				loops: Object.keys(diagnostic.loops),
				entries: diagnostic.control?.entries
			},
			admissionDisabled: {
				reasons: forced.reasons,
				controlReasons: forced.controlReasons,
				loops: Object.keys(forced.loops),
				entries: forced.control?.entries
			},
			census: census(bytes, kernel.id)
		});
		const run = kernelContext(module, resetMode, layout);
		const native = {
			run: async (count: number, times: number, _batch: number, verify = false) =>
				Array.from({ length: count }, () => run(times, verify)),
			close: async () => {}
		};
		const arms: {
			name: string;
			width: number;
			batch: number;
			instance: typeof native | Awaited<ReturnType<typeof tasks>>;
			startupMs: number;
		}[] = [{ name: 'native', width: 1, batch: 1, instance: native, startupMs: 0 }];
		try {
			for (const width of [1, 2, 4, 8]) {
				for (const mode of ['ordinary', 'tasks'] as const) {
					const start = performance.now(),
						instance = await (mode === 'tasks' ? tasks : ordinary)(
							module,
							width,
							layout
						);
					const startupMs = performance.now() - start;
					arms.push({ name: `${mode}-${width}`, width, batch: 1, instance, startupMs });
					// Same pool and same operations; only dispatch batching changes.
					arms.push({
						name: `${mode}-${width}-batched`,
						width,
						batch: Math.max(1, jobs / width),
						instance,
						startupMs
					});
				}
			}
			const expected = comparable(await native.run(jobs, repeats, 1));
			const verified = comparable(await native.run(jobs, repeats, 1, true));
			for (const arm of arms)
				emit({ kind: 'opened', case: kernel.id, arm: arm.name, startupMs: arm.startupMs });
			for (let round = -2; round < pairs; round++) {
				for (let turn = 0; turn < arms.length; turn++) {
					const arm = arms[(turn + round + 2) % arms.length]!;
					const cpu = process.cpuUsage(),
						start = performance.now();
					const output = await arm.instance.run(jobs, repeats, arm.batch);
					const wallMs = performance.now() - start,
						used = process.cpuUsage(cpu);
					assert.deepEqual(comparable(output), expected);
					// inspect the state left by the timed batch without executing or resetting it
					assert.deepEqual(
						comparable(await arm.instance.run(arm.width, 0, 1, true)),
						Array.from({ length: arm.width }, () => verified[0])
					);
					if (round >= 0)
						emit({
							kind: 'sample',
							case: kernel.id,
							arm: arm.name,
							round,
							wallMs,
							cpuMs: (used.user + used.system) / 1000,
							operations: jobs * repeats,
							messages: Math.ceil(jobs / arm.batch),
							restoredBytes: output.reduce((sum, row) => sum + row.restoredBytes, 0),
							resetMode,
							recreated: output.reduce((sum, row) => sum + row.recreated, 0),
							verification: 'timed final context state and every return',
							outputSha256: digest(JSON.stringify(verified)),
							passed: true,
							load: loadavg(),
							phases: output.reduce(
								(sum, row) => ({
									resetMs: sum.resetMs + row.resetMs,
									computeMs: sum.computeMs + row.computeMs,
									digestMs: sum.digestMs + row.digestMs
								}),
								{ resetMs: 0, computeMs: 0, digestMs: 0 }
							)
						});
				}
			}
			console.log(kernel.id);
		} finally {
			for (const instance of new Set(arms.map((arm) => arm.instance))) await instance.close();
		}
	}
	emit({ kind: 'closed', complete: true });
}
