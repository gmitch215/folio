import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Worker } from 'node:worker_threads';
import { TaskPool } from '../../src/tasks.ts';
import { researchEnvironment } from './environment.ts';
import { buildSubjects, subjects, type SubjectName } from './sweeps-build.ts';
import { bounds, fixedPoint, Instance, type Exec, type Guess } from './sweeps-engine.ts';
import { kinds, makeInput } from './sweeps-inputs.ts';

const [mode, output, sessionArg = '1', roundsArg = '5', sizesArg = '65536,1048576,67108864'] =
	process.argv.slice(2);
if (!mode || !output || !['count', 'states', 'wall'].includes(mode))
	throw new Error(
		'usage: sweeps-bench.ts count|states|wall OUT.jsonl [SESSION] [ROUNDS] [BYTES,...]'
	);
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);

const session = Number(sessionArg);
const rounds = Number(roundsArg);
const sizes = sizesArg.split(',').map(Number);
const ks = [8, 32];
const guesses: Guess[] = ['zero', 'warm'];
const warmups = 2;
const width = 8;

const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');
const paths = buildSubjects();
const modules = (name: SubjectName) => new WebAssembly.Module(readFileSync(paths[name]));

const configuration = { mode, session, rounds, sizes, ks, guesses, width, warmups };
emit(researchEnvironment(configuration));

const serialExec =
	(instance: Instance): Exec =>
	(jobs) =>
		jobs.map((job) => instance.run(job.state, job.from, job.to));

const cpuMs = (a: NodeJS.CpuUsage, b: NodeJS.CpuUsage) =>
	(b.user - a.user + b.system - a.system) / 1000;

if (mode === 'count') {
	// deterministic: one session, no timing claims beyond ms per fixed point on this thread
	for (const { name } of subjects) {
		const instance = new Instance(modules(name), name);
		for (const size of sizes)
			for (const kind of kinds) {
				instance.load(makeInput(name, kind, size));
				const serial = instance.run(0, 0, size);
				for (const k of ks)
					for (const guess of guesses) {
						const t0 = performance.now();
						const fp = fixedPoint(bounds(size, k, name), guess, serialExec(instance));
						const ms = performance.now() - t0;
						emit({
							kind: 'sweep',
							subject: name,
							input: kind,
							bytes: size,
							k,
							guess,
							sweeps: fp.passes,
							loopPasses: fp.loopPasses,
							chunkRuns: fp.chunkRuns,
							equal: fp.result === serial,
							ms
						});
					}
			}
	}
}

if (mode === 'states') {
	// unreachable encodings are in the domain, so the counts are upper bounds
	const domains: Record<string, { name: SubjectName; starts: number; note: string }> = {
		utf8flag: { name: 'utf8flag', starts: 512, note: 'bits 0-7 DFA, bit 8 error flag' },
		utf8dfa: { name: 'utf8dfa', starts: 256, note: 'bits 0-7 DFA' },
		csvquote: { name: 'csvquote', starts: 2, note: 'in-quote bit' },
		csvrows: { name: 'csvrows', starts: 512, note: 'in-quote bit and 8 count bits' },
		base64ok: { name: 'base64ok', starts: 16, note: 'phase, owed, rejected' },
		rle: {
			name: 'rle',
			starts: 1 << 18,
			note: 'phase, count, value, rejected (full encoding)'
		},
		lines: { name: 'lines', starts: 2, note: 'tab parity' }
	};
	const offset = 32768;
	for (const [label, { name, starts, note }] of Object.entries(domains)) {
		const instance = new Instance(modules(name), name);
		for (const kind of kinds) {
			instance.load(makeInput(name, kind, 65536));
			for (const length of [64, 256, 1024]) {
				const ends = new Set<number>();
				for (let s = 0; s < starts; s++) ends.add(instance.run(s, offset, offset + length));
				emit({
					kind: 'states',
					subject: label,
					input: kind,
					length,
					starts,
					distinctEnds: ends.size,
					note
				});
			}
		}
	}
}

if (mode === 'wall') {
	const worker = new URL('./sweeps-worker.ts', import.meta.url);
	for (const { name } of subjects) {
		const wasm = paths[name];
		const pool = new TaskPool(width);
		const workers: Worker[] = [];
		for (let index = 0; index < width; index++) {
			const link = pool.link(index);
			workers.push(
				new Worker(worker, {
					workerData: { link, wasm, entry: name },
					transferList: [link.port]
				})
			);
		}
		const instance = new Instance(modules(name), name);
		try {
			for (const size of sizes)
				for (const kind of kinds) {
					const input = makeInput(name, kind, size);
					const pooled = (): Exec => (jobs) =>
						pool
							.runSync(
								jobs.map((job) => [
									`sweep:${(job.state >>> 0).toString(16)}`,
									input.slice(job.from, job.to)
								])
							)
							.map((r) =>
								new DataView(r.bytes.buffer, r.bytes.byteOffset, 4).getUint32(
									0,
									true
								)
							);
					const drain = () => pool.drain().reduce((sum, r) => sum + (r.cpuMs ?? 0), 0);
					instance.load(input);
					const expected = instance.run(0, 0, size);
					const arms: {
						arm: string;
						k: number;
						run: () => { state: number; fp?: object };
					}[] = [
						{
							arm: 'serial',
							k: 0,
							run: () => {
								instance.load(input);
								return { state: instance.run(0, 0, size) };
							}
						}
					];
					for (const k of ks)
						for (const guess of guesses)
							arms.push({
								arm: `${guess}-k${k}`,
								k,
								run: () => {
									const fp = fixedPoint(bounds(size, k, name), guess, pooled());
									return { state: fp.result, fp };
								}
							});
					for (let round = -warmups; round < rounds; round++) {
						const order = round % 2 ? [...arms].reverse() : arms;
						for (const { arm, k, run } of order) {
							const load = loadavg();
							drain();
							const cpu = process.cpuUsage();
							const start = performance.now();
							const { state, fp } = run();
							const ms = performance.now() - start;
							const cpuTotal = cpuMs(cpu, process.cpuUsage());
							const workerCpu = drain();
							if (round < 0) continue;
							emit({
								kind: 'sample',
								session,
								subject: name,
								input: kind,
								bytes: size,
								arm,
								k,
								round,
								ms,
								cpuMs: cpuTotal,
								workerCpuMs: workerCpu,
								equal: state === expected,
								...(fp ?? {}),
								load1: load[0]
							});
						}
					}
				}
		} finally {
			pool.close();
			await Promise.all(workers.map((w) => w.terminate()));
		}
	}
}
