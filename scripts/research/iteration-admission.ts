import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { admissionSeam, iterationAdmissionConstants } from '../../src/iteration-admission.ts';
import { Folio } from '../../src/node.ts';
import { researchEnvironment } from './environment.ts';

// sweeps iteration size by trip count on the BLAKE3 consumer and pairs the library's own decision
// (`automatic`) and a pool that always dispatches (`forced`) with a serial native run in the same
// round. timings cover the call only; copying the inputs in is outside them, as it is for a
// program whose memory already holds its data. `summary` flags every cell where the decision was
// wrong and prints the numbers the two constants of src/iteration-admission.ts are fitted to.

const root = new URL('../../', import.meta.url).pathname;
const BASE = 1 << 20;
const DATA = BASE + 65536;
const PAGE = 65536;
const distinct = 8;

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
	const [output, roundsArg = '5', widthArg = '8', sizesArg, tripsArg] = argv;
	if (!output)
		throw new Error(
			'usage: iteration-admission.ts run OUTPUT.jsonl [ROUNDS] [WIDTH] [SIZES_KIB] [TRIPS]'
		);
	const rounds = Number(roundsArg);
	const width = Number(widthArg);
	const sizes = (sizesArg ?? '4,16,64,256,1024,4096').split(',').map((v) => Number(v) * 1024);
	const trips = (tripsArg ?? '8,32,128').split(',').map(Number);
	const warmups = 2;
	writeFileSync(output, '', { flag: 'wx' });
	const emit = (row: Record<string, unknown>) =>
		appendFileSync(output, JSON.stringify(row) + '\n');
	const bytes = new Uint8Array(readFileSync(`${root}build/research/blake3/blake3-hash-all.wasm`));
	emit({
		...researchEnvironment({ rounds, width, sizes, trips, warmups }),
		constants: iterationAdmissionConstants,
		wasmSha256: createHash('sha256').update(bytes).digest('hex')
	});
	for (const size of sizes) {
		const buffers = Array.from({ length: Math.min(distinct, Math.max(...trips)) }, (_, i) =>
			generate(i, size)
		);
		for (const files of trips) {
			const pages = Math.ceil((DATA + files * (size + 64)) / PAGE) + 2;
			const table = BASE;
			const out = BASE + 8 * files;
			const place = (memory: WebAssembly.Memory) => {
				const view = new Uint8Array(memory.buffer);
				const words = new Uint32Array(memory.buffer, table, 2 * files);
				let at = DATA;
				for (let i = 0; i < files; i++) {
					view.set(buffers[i % buffers.length]!, at);
					words[2 * i] = at;
					words[2 * i + 1] = size;
					at += size + 64;
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
			for (const arm of ['automatic', 'forced'] as const) {
				admissionSeam.force = arm === 'forced';
				admissionSeam.scale = 1;
				const memory = new WebAssembly.Memory({
					initial: pages,
					maximum: 65536,
					shared: true
				});
				const folio = await Folio.open(bytes, { memory, workers: width });
				try {
					for (let round = -warmups; round < rounds; round++) {
						const order = round % 2 ? ['arm', 'native'] : ['native', 'arm'];
						for (const which of order) {
							const memoryOf = which === 'native' ? nativeMemory : folio.memory;
							place(memoryOf);
							const cpu = process.cpuUsage();
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
								size,
								trip: files,
								width,
								arm: which === 'native' ? 'native' : arm,
								pairedWith: which === 'native' ? arm : undefined,
								round,
								wallMs,
								cpuMs: (used.user + used.system) / 1000,
								load: loadavg(),
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
			console.error('cell', size, files, 'done');
		}
	}
	emit({ kind: 'closed', complete: true });
	console.log('done', output);
}

interface Sample {
	kind: string;
	size: number;
	trip: number;
	width: number;
	arm: string;
	pairedWith?: string;
	session?: number;
	round: number;
	wallMs: number;
	cpuMs: number;
	report?: {
		extraction?: string;
		regions?: number;
		replayed?: number;
		iteration?: {
			dispatchMs: number;
			validationMs: number;
			workerRunMs: number;
			stopped?: string;
			admission?: {
				plainIterationMs: number;
				remainingSerialMs: number;
				admitted: boolean;
				batchWallMs?: number;
				batchSerialMs?: number;
			};
		};
	};
}

function summarize(files: string[], jsonOutput?: string) {
	const cells = new Map<string, Sample[]>();
	let margin = iterationAdmissionConstants.margin;
	for (const [session, file] of files.entries())
		for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
			const row = JSON.parse(line);
			if (row.kind === 'environment') margin = row.constants?.margin ?? margin;
			if (row.kind !== 'sample') continue;
			row.session = session;
			const key = `${row.width}:${row.size}:${row.trip}`;
			(cells.get(key) ?? cells.set(key, []).get(key)!).push(row);
		}
	const rows: Record<string, unknown>[] = [];
	const numeric = (key: string) => key.split(':').map(Number) as [number, number, number];
	const keys = [...cells.keys()].sort((a, b) => {
		const [wa, sa, ta] = numeric(a);
		const [wb, sb, tb] = numeric(b);
		return wa - wb || sa - sb || ta - tb;
	});
	for (const key of keys) {
		const samples = cells.get(key)!;
		const [width, size, trip] = numeric(key);
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
		const forced = of('forced');
		const dispatched = auto.filter((s) => s.report?.extraction === 'iteration').length;
		const stopped = auto.filter((s) => s.report?.iteration?.stopped).length;
		const stopReason = auto.map((s) => s.report?.iteration?.stopped).find(Boolean);
		const admission = auto.flatMap((s) => s.report?.iteration?.admission ?? []);
		const nativeMs = median(of('native').map((s) => s.wallMs));
		const forcedSpeedup = median(speedups('forced'));
		const autoSpeedup = median(speedups('automatic'));
		const per = (s: Sample) => {
			const i = s.report?.iteration;
			return i && s.report?.regions ? i.workerRunMs / s.report.regions : NaN;
		};
		const fixed = median(
			forced.map((s) => {
				const i = s.report?.iteration;
				return i?.admission ? s.wallMs - i.admission.plainIterationMs - i.dispatchMs : NaN;
			})
		);
		const tracked = median(forced.map(per));
		const rounds = Math.ceil((trip - 1) / Math.min(width, trip - 1));
		const imbalance = median(
			forced.map((s) => (s.report?.iteration?.dispatchMs ?? NaN) / (rounds * per(s)))
		);
		const first = median(admission.map((a) => a.plainIterationMs));
		const batchWall = median(admission.map((a) => a.batchWallMs ?? NaN));
		const batchSerial = median(admission.map((a) => a.batchSerialMs ?? NaN));
		const wrong =
			dispatched * 2 > auto.length
				? autoSpeedup < 1
					? 'dispatched and slower than serial'
					: ''
				: forcedSpeedup >= margin
					? `refused and ${forcedSpeedup.toFixed(2)}x faster forced`
					: '';
		rows.push({
			width,
			sizeKiB: size / 1024,
			trip,
			nativeMs,
			forcedSpeedup,
			autoSpeedup,
			dispatched,
			rounds: auto.length,
			stopped,
			stopReason,
			plainIterationMs: first,
			remainingSerialMs: median(admission.map((a) => a.remainingSerialMs)),
			batchWallMs: batchWall,
			batchSerialMs: batchSerial,
			trackedPerIterationMs: tracked,
			realizedTracking: tracked / (nativeMs / trip),
			plainOverTracked: first / tracked,
			fixedMs: fixed,
			imbalance,
			wrong
		});
	}
	const f = (v: unknown, d = 2) =>
		typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '-';
	console.log(
		[
			'KiB',
			'trip',
			'native ms',
			'forced x',
			'auto x',
			'disp',
			'stop',
			'plain ms',
			'rem ser',
			'batch wall',
			'batch ser',
			'trk/it',
			'trk fac',
			'plain/trk',
			'fixed',
			'imbal',
			'verdict'
		].join('\t')
	);
	for (const r of rows)
		console.log(
			[
				r.sizeKiB,
				r.trip,
				f(r.nativeMs, 1),
				f(r.forcedSpeedup),
				f(r.autoSpeedup),
				`${r.dispatched}/${r.rounds}`,
				r.stopped ? `${r.stopped}/${r.rounds} ${r.stopReason}` : '-',
				f(r.plainIterationMs, 3),
				f(r.remainingSerialMs, 1),
				f(r.batchWallMs, 1),
				f(r.batchSerialMs, 1),
				f(r.trackedPerIterationMs, 3),
				f(r.realizedTracking),
				f(r.plainOverTracked),
				f(r.fixedMs, 1),
				f(r.imbalance),
				r.wrong || 'ok'
			].join('\t')
		);
	const wrongCells = rows.filter((r) => r.wrong);
	console.log(`${rows.length} cells, ${wrongCells.length} wrong decisions, margin ${margin}`);
	for (const r of wrongCells)
		console.log(`wrong: ${r.sizeKiB} KiB x ${r.trip} at width ${r.width}: ${r.wrong}`);
	if (jsonOutput) writeFileSync(jsonOutput, JSON.stringify({ margin, rows }, null, '\t') + '\n');
}

const [mode, ...rest] = process.argv.slice(2);
if (process.argv[1] === new URL(import.meta.url).pathname) {
	if (mode === 'run') await sweep(rest);
	else if (mode === 'summary') {
		const at = rest.indexOf('--json');
		summarize(at < 0 ? rest : rest.slice(0, at), at < 0 ? undefined : rest[at + 1]);
	} else throw new Error('usage: iteration-admission.ts run|summary ...');
}
