import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { admissionSeam, iterationAdmissionConstants } from '../../src/iteration-admission.ts';
import { Folio } from '../../src/node.ts';
import { researchEnvironment } from './environment.ts';

// pairs a serial native run, the library's decision (`automatic`) and a pool that always dispatches
// (`forced`) on the BLAKE3 consumer with inputs of unequal size. each sample records the load
// average, because the sweep shares its machine. `summary` compares what admission predicted from
// iteration 0 with what the loop took and says whether the decision was right.

const root = new URL('../../', import.meta.url).pathname;
const BASE = 1 << 20;
const DATA = BASE + 65536;
const PAGE = 65536;
const KiB = 1024;
const MiB = 1024 * KiB;

const geometric = (count: number, from: number, to: number) =>
	Array.from({ length: count }, (_, i) => {
		const bytes = from * Math.pow(to / from, i / (count - 1));
		return Math.round(bytes / 64) * 64;
	});
const repeat = (size: number, count: number) => Array.from({ length: count }, () => size);

export const workloads: Record<string, number[]> = {
	'a-large-first': [64 * MiB, ...repeat(64 * KiB, 31)],
	'a-large-last': [...repeat(64 * KiB, 31), 64 * MiB],
	'b-large-first': [64 * MiB, 64 * MiB, ...repeat(64 * KiB, 30)],
	'b-large-last': [...repeat(64 * KiB, 30), 64 * MiB, 64 * MiB],
	'c-ascending': geometric(32, 4 * KiB, 16 * MiB),
	'c-descending': geometric(32, 4 * KiB, 16 * MiB).reverse(),
	'd-uniform': repeat(2 * MiB, 32),
	'e-late-heavy': [...repeat(64 * KiB, 16), ...repeat(MiB, 112)],
	'f-step-refused': [...repeat(4 * KiB, 16), ...repeat(512 * KiB, 112)]
};

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
};

function generate(index: number, size: number) {
	const data = new Uint8Array(size);
	let state = (0x9e3779b9 ^ Math.imul(index + 1, 2654435761)) | 0;
	for (let i = 0; i < size; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		data[i] = state & 255;
	}
	return data;
}

async function sweep(argv: string[]) {
	const [output, roundsArg = '5', widthArg = '8', namesArg, wasmArg] = argv;
	if (!output)
		throw new Error(
			'usage: iteration-mixed.ts run OUTPUT.jsonl [ROUNDS] [WIDTH] [NAMES] [WASM]'
		);
	const rounds = Number(roundsArg);
	const width = Number(widthArg);
	const names = namesArg ? namesArg.split(',') : Object.keys(workloads);
	const warmups = 2;
	writeFileSync(output, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) =>
		appendFileSync(output, JSON.stringify(row) + '\n');
	const bytes = new Uint8Array(
		readFileSync(wasmArg ?? `${root}build/research/blake3/blake3-hash-all.wasm`)
	);
	emit({
		...researchEnvironment({ rounds, width, names, warmups }),
		constants: iterationAdmissionConstants,
		wasmSha256: createHash('sha256').update(bytes).digest('hex')
	});
	const cache = new Map<string, Uint8Array>();
	const buffer = (key: string, index: number, size: number) =>
		cache.get(`${key}:${size}`) ??
		cache.set(`${key}:${size}`, generate(index, size)).get(`${key}:${size}`)!;
	for (const name of names) {
		const sizes = workloads[name];
		if (!sizes) throw new Error(`unknown workload ${name}`);
		const files = sizes.length;
		const total = sizes.reduce((a, b) => a + b + 64, 0);
		const pages = Math.ceil((DATA + total) / PAGE) + 2;
		const table = BASE;
		const out = BASE + 8 * files;
		// a large input has its own seed, small ones cycle through 8
		const inputs = sizes.map((size, i) =>
			size >= MiB ? buffer('big', i, size) : buffer('small', i % 8, size)
		);
		const place = (memory: WebAssembly.Memory) => {
			const view = new Uint8Array(memory.buffer);
			const words = new Uint32Array(memory.buffer, table, 2 * files);
			let at = DATA;
			for (let i = 0; i < files; i++) {
				view.set(inputs[i]!, at);
				words[2 * i] = at;
				words[2 * i + 1] = sizes[i]!;
				at += sizes[i]! + 64;
			}
		};
		const digestOf = (memory: WebAssembly.Memory) =>
			createHash('sha256')
				.update(new Uint8Array(memory.buffer, out, 32 * files))
				.digest('hex');
		const nativeMemory = new WebAssembly.Memory({ initial: pages, maximum: pages });
		const hash = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
			env: { memory: nativeMemory }
		}).exports.hash_all as CallableFunction;
		const nativeRun = () => hash(table, files, out);
		place(nativeMemory);
		nativeRun();
		const expected = digestOf(nativeMemory);
		emit({ kind: 'workload', name, files, sizes, totalBytes: total });
		for (const arm of ['automatic', 'forced'] as const) {
			admissionSeam.force = arm === 'forced';
			admissionSeam.scale = 1;
			const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
			const folio = await Folio.open(bytes, { memory, workers: width });
			try {
				for (let round = -warmups; round < rounds; round++) {
					const order = round % 2 ? ['arm', 'native'] : ['native', 'arm'];
					for (const which of order) {
						const memoryOf = which === 'native' ? nativeMemory : folio.memory;
						place(memoryOf);
						const cpu = process.cpuUsage();
						const loadBefore = loadavg();
						const start = performance.now();
						let report: any;
						if (which === 'native') nativeRun();
						else report = await folio.run('hash_all', [table, files, out]);
						const wallMs = performance.now() - start;
						const used = process.cpuUsage(cpu);
						assert.equal(digestOf(memoryOf), expected, `${arm} digests differ`);
						if (round < 0) continue;
						emit({
							kind: 'sample',
							workload: name,
							trip: files,
							width,
							arm: which === 'native' ? 'native' : arm,
							pairedWith: which === 'native' ? arm : undefined,
							round,
							wallMs,
							cpuMs: (used.user + used.system) / 1000,
							load: loadBefore,
							loadAfter: loadavg(),
							...(report
								? {
										report: {
											mode: report.mode,
											extraction: report.extraction,
											reason: report.reason,
											workers: report.workers,
											regions: report.regions,
											replayed: report.replayed,
											iteration: report.iteration
										}
									}
								: {})
						});
					}
				}
			} finally {
				await folio.close();
				admissionSeam.force = false;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		console.error('workload', name, 'width', width, 'done', loadavg().join(' '));
	}
	emit({ kind: 'closed', complete: true });
	console.log('done', output);
}

interface Sample {
	kind: string;
	workload: string;
	trip: number;
	width: number;
	arm: string;
	pairedWith?: string;
	session?: number;
	round: number;
	wallMs: number;
	load: number[];
	report?: {
		extraction?: string;
		regions?: number;
		replayed?: number;
		iteration?: {
			batches: number;
			exhausted: number;
			stopped?: string;
			serial: number;
			admission?: {
				plainIterationMs: number;
				remainingSerialMs: number;
				admitted: boolean;
			};
		};
	};
}

function summarize(files: string[], jsonOutput?: string) {
	const cells = new Map<string, Sample[]>();
	let margin = iterationAdmissionConstants.margin;
	const sizesOf = new Map<string, number[]>();
	for (const [session, file] of files.entries())
		for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
			const row = JSON.parse(line);
			if (row.kind === 'environment') margin = row.constants?.margin ?? margin;
			if (row.kind === 'workload') sizesOf.set(row.name, row.sizes);
			if (row.kind !== 'sample') continue;
			row.session = session;
			const key = `${row.width}:${row.workload}`;
			(cells.get(key) ?? cells.set(key, []).get(key)!).push(row);
		}
	const rows: Record<string, unknown>[] = [];
	for (const key of [...cells.keys()].sort()) {
		const samples = cells.get(key)!;
		const [widthText, workload] = key.split(':') as [string, string];
		const width = Number(widthText);
		const of = (arm: string) => samples.filter((s) => s.arm === arm);
		const speedups = (arm: 'automatic' | 'forced') =>
			of(arm).flatMap((s) => {
				const native = samples.find(
					(n) =>
						n.arm === 'native' &&
						n.pairedWith === arm &&
						n.round === s.round &&
						n.session === s.session
				);
				return native ? [native.wallMs / s.wallMs] : [];
			});
		const auto = of('automatic');
		const dispatched = auto.filter((s) => s.report?.extraction === 'iteration').length;
		const stopped = auto.filter((s) => s.report?.iteration?.stopped).length;
		const stopReason = auto.map((s) => s.report?.iteration?.stopped).find(Boolean);
		const admission = auto.flatMap((s) => s.report?.iteration?.admission ?? []);
		const nativeMs = median(of('native').map((s) => s.wallMs));
		const forcedSpeedup = median(speedups('forced'));
		const autoSpeedup = median(speedups('automatic'));
		const plain = median(admission.map((a) => a.plainIterationMs));
		const sizes = sizesOf.get(workload)!;
		const meanSerial = nativeMs / sizes.length;
		// serial time of iterations 1.. that the first measurement predicted, against the measured rest
		const predicted = (sizes.length - 1) * plain;
		const actualRest = nativeMs - plain;
		const wrong =
			dispatched * 2 > auto.length
				? autoSpeedup < 1
					? 'dispatched and slower than serial'
					: ''
				: forcedSpeedup >= margin
					? `refused and ${forcedSpeedup.toFixed(2)}x faster forced`
					: '';
		const loads = samples.map((s) => s.load[0]!);
		rows.push({
			width,
			workload,
			trip: sizes.length,
			nativeMs,
			forcedSpeedup,
			autoSpeedup,
			dispatched,
			rounds: auto.length,
			stopped,
			stopReason,
			batches: median(auto.map((s) => s.report?.iteration?.batches ?? NaN)),
			plainIterationMs: plain,
			predictedRestMs: predicted,
			actualRestMs: actualRest,
			predictionRatio: predicted / actualRest,
			loadMin: Math.min(...loads),
			loadMax: Math.max(...loads),
			wrong
		});
	}
	const f = (v: unknown, d = 2) =>
		typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-';
	console.log(
		[
			'width',
			'workload',
			'native ms',
			'forced x',
			'auto x',
			'disp',
			'stop',
			'batches',
			'plain ms',
			'pred rest',
			'real rest',
			'pred/real',
			'load',
			'verdict'
		].join('\t')
	);
	for (const r of rows)
		console.log(
			[
				r.width,
				r.workload,
				f(r.nativeMs, 1),
				f(r.forcedSpeedup),
				f(r.autoSpeedup),
				`${r.dispatched}/${r.rounds}`,
				r.stopped ? `${r.stopped}/${r.rounds} ${r.stopReason}` : '-',
				f(r.batches, 0),
				f(r.plainIterationMs, 3),
				f(r.predictedRestMs, 1),
				f(r.actualRestMs, 1),
				f(r.predictionRatio),
				`${f(r.loadMin)}-${f(r.loadMax)}`,
				r.wrong || 'ok'
			].join('\t')
		);
	const wrongCells = rows.filter((r) => r.wrong);
	console.log(`${rows.length} cells, ${wrongCells.length} wrong decisions, margin ${margin}`);
	for (const r of wrongCells) console.log(`wrong: ${r.workload} at width ${r.width}: ${r.wrong}`);
	if (jsonOutput) writeFileSync(jsonOutput, JSON.stringify({ margin, rows }, null, '\t') + '\n');
}

const [mode, ...rest] = process.argv.slice(2);
if (process.argv[1] === new URL(import.meta.url).pathname) {
	if (mode === 'run') await sweep(rest);
	else if (mode === 'summary') {
		const at = rest.indexOf('--json');
		summarize(at < 0 ? rest : rest.slice(0, at), at < 0 ? undefined : rest[at + 1]);
	} else throw new Error('usage: iteration-mixed.ts run|summary ...');
}
