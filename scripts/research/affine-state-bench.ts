import { appendFileSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
	bytesEqual,
	contextSubject,
	foldState,
	modelSubject,
	probeState,
	stateSerial,
	type ContextSubject,
	type StateModel
} from '../../src/affine-state.ts';
import { recordBoundaries, verifyBoundaries, type BoundaryLog } from '../../src/boundaries.ts';
import { TaskPool } from '../../src/tasks.ts';
import {
	buildContextSubjects,
	buildCorpusContextSubjects,
	corpusContext,
	corpusEntry,
	ownContext
} from './affine-state-build.ts';
import { researchEnvironment } from './environment.ts';

const [output, sessionArg = '1', roundsArg = '5', sizesArg = '1,8,64', part = 'all', only] =
	process.argv.slice(2);
if (!output)
	throw new Error(
		'usage: affine-state-bench.ts OUTPUT.jsonl [SESSION] [ROUNDS] [MIB,MIB,...] [a|b|all] [SUBJECT]'
	);
// FOLIO_AFFINE_WIDTH sets the worker count, 8 by default
const session = Number(sessionArg);
const rounds = Number(roundsArg);
const sizes = sizesArg.split(',').map(Number);
const width = Number(process.env.FOLIO_AFFINE_WIDTH ?? 8);
const warmups = 2;
const emit = (row: Record<string, unknown>) =>
	appendFileSync(output, JSON.stringify({ session, ...row }) + '\n');

const worker = new URL('./affine-context-worker.ts', import.meta.url);
const own = buildContextSubjects();
const corpus = buildCorpusContextSubjects();

const randomInput = (size: number, seed = 0x2545f491) => {
	let state = seed;
	const words = new Uint32Array(Math.ceil(size / 4));
	for (let i = 0; i < words.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		words[i] = state;
	}
	return new Uint8Array(words.buffer, 0, size);
};

function open(wasm: string, subject: ContextSubject) {
	const pool = new TaskPool(width);
	const workers: Worker[] = [];
	for (let index = 0; index < width; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(worker, {
				workerData: {
					link,
					wasm,
					layout: subject.layout,
					context: subject.context,
					state: subject.state
				},
				transferList: [link.port]
			})
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

type Arm = { name: string; expected: Uint8Array; run: () => { state: Uint8Array; info?: object } };

function measure(subject: string, mib: number, arms: Arm[], drain: () => number) {
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
				equal: bytesEqual(state, arm.expected),
				...info
			});
		}
	}
}

emit({
	...researchEnvironment({ rounds, sizes, width, warmups, session, part }),
	loadStart: loadavg()
});

// part A: state in the context, exact mode over the recovered model
if (part === 'a' || part === 'all') {
	const specs: [string, string, string, Uint8Array, number, number[]][] = [
		['crcctx', own.crcctx!, 'crcctx_update', ownContext('crcctx'), 1, sizes],
		['crclen', own.crclen!, 'crclen_update', ownContext('crclen'), 1, sizes],
		['fletcher', own.fletcher!, 'fletcher_update', ownContext('fletcher'), 1, sizes],
		['polyctx', own.polyctx!, 'polyctx_update', ownContext('polyctx'), 1, sizes],
		['last8', own.last8!, 'last8_update', ownContext('last8'), 1, sizes]
	];
	if (corpus['aes-ctr'])
		specs.push([
			'aes-ctr',
			corpus['aes-ctr'],
			corpusEntry['aes-ctr']!,
			corpusContext('aes-ctr', corpus['aes-ctr']),
			16,
			sizes.filter((s) => s <= 8)
		]);
	for (const [name, wasm, entry, context, align, mibs] of specs) {
		if (only && only !== name) continue;
		const bytes = readFileSync(wasm);
		const t0 = performance.now();
		const model = probeState(bytes, entry, { context, align });
		const probeMs = performance.now() - t0;
		if (model.kind !== 'state') {
			emit({ kind: 'refused', subject: name, reason: model.reason, calls: model.calls });
			continue;
		}
		emit({
			kind: 'discovery',
			part: 'a',
			subject: name,
			ms: probeMs,
			calls: model.calls,
			state: model.state.length,
			params: model.params.length,
			scratch: model.scratch.length,
			factors: model.factors.map((f) => `${f.ring}:${f.offsets.length}B`),
			load: loadavg()
		});
		const subject = modelSubject(new WebAssembly.Module(bytes), model);
		const run = stateSerial(subject);
		const { pool, close } = open(wasm, subject);
		const drain = () => pool.drain().reduce((sum, r) => sum + (r.cpuMs ?? 0), 0);
		try {
			for (const mib of mibs) {
				const input = randomInput(mib * 1024 * 1024);
				const expected = run(input);
				const arms: Arm[] = [
					{ name: 'serial', expected, run: () => ({ state: run(input) }) },
					{
						name: 'exact',
						expected,
						run: () => {
							const r = foldState(pool, input, model as StateModel);
							return {
								state: r.state,
								info: { tasks: r.tasks, mismatchAt: r.mismatchAt }
							};
						}
					}
				];
				emit({ kind: 'load', subject: name, mib, loadBefore: loadavg() });
				measure(name, mib, arms, drain);
				emit({ kind: 'load', subject: name, mib, loadAfter: loadavg() });
			}
		} finally {
			await close();
		}
	}
}

// part B: recorded boundary states for chains with no model
if (part === 'b' || part === 'all') {
	const specs: [string, string, string, Uint8Array][] = [
		['sha256', corpus.sha256!, corpusEntry.sha256!, corpusContext('sha256', corpus.sha256!)],
		['sha1', corpus.sha1!, corpusEntry.sha1!, corpusContext('sha1', corpus.sha1!)],
		['md5', corpus.md5!, corpusEntry.md5!, corpusContext('md5', corpus.md5!)],
		['mix8', own.mix8!, 'mix8_update', ownContext('mix8')]
	];
	for (const [name, wasm, entry, context] of specs) {
		if (only && only !== name) continue;
		const subject = contextSubject(new WebAssembly.Module(readFileSync(wasm)), entry, context);
		const run = stateSerial(subject);
		const { pool, close } = open(wasm, subject);
		const drain = () => pool.drain().reduce((sum, r) => sum + (r.cpuMs ?? 0), 0);
		try {
			for (const mib of sizes) {
				const input = randomInput(mib * 1024 * 1024);
				const chunks = 2 * width;
				const step = Math.ceil(input.length / chunks);
				const expected = run(input);
				const t0 = performance.now();
				const recorded = recordBoundaries(subject, input, { step });
				const recordMs = performance.now() - t0;
				if (!bytesEqual(recorded.state, expected))
					throw new Error(`${name} record differs`);
				const log: BoundaryLog = recorded.log;
				emit({
					kind: 'record',
					subject: name,
					mib,
					step,
					chunks: log.starts.length,
					ms: recordMs
				});
				const arms: Arm[] = [
					{ name: 'serial', expected, run: () => ({ state: run(input) }) },
					{
						name: 'record',
						expected,
						run: () => ({ state: recordBoundaries(subject, input, { step }).state })
					}
				];
				const verify = (name: string, data: Uint8Array, want: Uint8Array) =>
					arms.push({
						name,
						expected: want,
						run: () => {
							const r = verifyBoundaries(pool, subject, data, log);
							return {
								state: r.state,
								info: {
									tasks: r.tasks,
									mismatchAt: r.mismatchAt,
									fallbackBytes: r.fallbackBytes
								}
							};
						}
					});
				verify('verify-identical', input, expected);
				// an edit one hundred bytes into the chunk that holds fraction p of the input
				for (const p of [0.9, 0.5, 0.1]) {
					const at = Math.floor(p * chunks) * step + 100;
					const edited = Uint8Array.from(input);
					edited[at] = edited[at]! ^ 0x5a;
					verify(`edit-${Math.round(p * 100)}`, edited, run(edited));
				}
				if (name === 'mix8') {
					// the edit moves to the last bytes of the chunk, where it is part of the state
					const at = Math.floor(0.5 * chunks) * step + step - 3;
					const edited = Uint8Array.from(input);
					edited[at] = edited[at]! ^ 0x5a;
					verify('edit-50-end-of-chunk', edited, run(edited));
				}
				emit({ kind: 'load', subject: name, mib, loadBefore: loadavg() });
				measure(name, mib, arms, drain);
				emit({ kind: 'load', subject: name, mib, loadAfter: loadavg() });
			}
		} finally {
			await close();
		}
	}
}
