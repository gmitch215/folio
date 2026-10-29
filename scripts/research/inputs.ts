import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { prepareContext, type PreparedContext } from '../../src/compiler.ts';
import { ContextResetError, InstanceCheckpoint } from '../../src/context.ts';
import { TaskPool, serveTasks, type TaskLink } from '../../src/tasks.ts';
import { buildCorpus, corpusImports, corpusManifest, type BuiltKernel } from './corpus.ts';
import { digest, researchEnvironment } from './environment.ts';

function context(module: WebAssembly.Module, layout: PreparedContext) {
	const open = () => {
		const host = corpusImports(),
			instance = new WebAssembly.Instance(module, host.imports);
		return {
			host,
			instance,
			checkpoint: layout.reasons.length ? undefined : new InstanceCheckpoint(instance, layout)
		};
	};
	let state = open(),
		used = false;
	return (seed: number) => {
		let recreated = false;
		if (used) {
			if (!state.checkpoint) {
				state = open();
				recreated = true;
			} else
				try {
					state.checkpoint.restore();
				} catch (error) {
					if (!(error instanceof ContextResetError)) throw error;
					state = open();
					recreated = true;
				}
		}
		used = true;
		state.host.effects.length = 0;
		(state.instance.exports.corpus_set_seed as CallableFunction)(seed);
		(state.instance.exports.initialize as CallableFunction)();
		const value = (state.instance.exports.entry as CallableFunction)();
		const bits = (value: number) => {
			const view = new DataView(new ArrayBuffer(8));
			view.setFloat64(0, value, true);
			return view.getBigUint64(0, true).toString(16).padStart(16, '0');
		};
		return {
			value: String(value),
			memorySha256: digest(new Uint8Array(state.host.memory.buffer)),
			effects: state.host.effects.map((effect) => ({
				name: effect.name,
				args: effect.args.map(bits),
				value: bits(effect.value)
			})),
			recreated
		};
	};
}

if (workerData?.corpusInputs) {
	const data = workerData as {
		module: WebAssembly.Module;
		layout: PreparedContext;
		link: TaskLink;
	};
	const run = context(data.module, data.layout);
	serveTasks(data.link, (_name, input) => JSON.stringify(run(JSON.parse(String(input)).seed)));
	parentPort!.postMessage({ ready: true });
} else if (import.meta.main) {
	const [directory] = process.argv.slice(2);
	if (!directory) throw new Error('usage: inputs.ts OUTPUT_DIRECTORY');
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	const seeds = [0, 1, 2, 3, 4, 1, 4, 2, 0, 3];
	emit(
		researchEnvironment({
			scope: 'parameterized upstream inputs; correctness, no timing claim',
			seeds,
			workers: 2
		})
	);
	const built: BuiltKernel[] =
		process.env.FOLIO_CORPUS_INPUTS_READY === '1'
			? corpusManifest.cases.map((kernel) => {
					const artifact = `build/research/corpus/artifacts/inputs/${kernel.id}.wasm`,
						bytes = Uint8Array.from(readFileSync(artifact));
					return {
						kernel,
						bytes,
						artifact,
						provenance: { artifactSha256: digest(bytes), cached: true }
					};
				})
			: buildCorpus({ runtimeInputs: true, sink: emit });
	for (const { kernel, bytes, provenance } of built) {
		const layout = prepareContext(bytes),
			module = new WebAssembly.Module(Uint8Array.from(layout.bytes));
		const pool = new TaskPool(2),
			workers: Worker[] = [];
		try {
			for (let index = 0; index < 2; index++) {
				const link = pool.link(index),
					worker = new Worker(new URL('./inputs.ts', import.meta.url), {
						workerData: { corpusInputs: true, module, layout, link },
						transferList: [link.port]
					});
				workers.push(worker);
				await new Promise<void>((resolve, reject) => {
					worker.once('message', () => resolve());
					worker.once('error', reject);
				});
			}
			const handles = seeds.map((seed) => pool.submitJson(kernel.id, { seed }));
			for (let index = 0; index < handles.length; index++) {
				const seed = seeds[index]!,
					native = context(module, layout)(seed);
				const actual = pool
					.join(handles[index]!)
					.json<ReturnType<ReturnType<typeof context>>>();
				assert.deepEqual(
					{ ...actual, recreated: false },
					native,
					`${kernel.id} seed ${seed}`
				);
				emit({
					kind: 'comparison',
					case: kernel.id,
					seed,
					worker: index % 2,
					value: actual.value,
					memorySha256: actual.memorySha256,
					effects: actual.effects,
					recreated: actual.recreated,
					checkpointRefusals: layout.reasons,
					artifactSha256: provenance.artifactSha256,
					passed: true
				});
			}
			console.log(kernel.id);
		} finally {
			pool.close();
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	}
	emit({
		kind: 'closed',
		cases: built.length,
		comparisons: built.length * seeds.length,
		complete: true
	});
}
