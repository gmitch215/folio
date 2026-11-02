import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Tally, TimedTransport } from '../../experiments/corpus-lanes/measure.ts';
import { emptyTally, measuring } from '../../experiments/corpus-lanes/measure.ts';
import { prepare } from '../../src/compiler.ts';
import { inlineLane } from '../../src/inline.ts';
import type { ManagedArtifact, ManagedReport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { memoryImports } from '../../src/memory.ts';
import { clearOutput, hostMath, outputOf, recordsOf, specOf, writeRecords } from './c21-common.ts';
import { layoutOf } from './c21-kernels.ts';

const root = new URL('../../', import.meta.url).pathname;
// drivers rebuilt with `C21_OUT=build/research/x1 node scripts/research/c21-kernels.ts`
export const driverDir = join(root, 'build/research/x1');
/** Builds the ManagedArtifact for a corpus driver; minimumRegionWork 0 admits every pure region. */
export function artifactOf(bytes: Uint8Array): ManagedArtifact | undefined {
	const plan = prepare(bytes, { minimumRegionWork: 0 }).control;
	if (!plan) return undefined;
	const { coordinator, transactional, workerOriginal, ...control } = plan;
	return {
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		coordinator: new WebAssembly.Module(Uint8Array.from(coordinator)),
		transactional: new WebAssembly.Module(Uint8Array.from(transactional)),
		inline: new WebAssembly.Module(Uint8Array.from(inlineLane(workerOriginal))),
		control,
		memories: memoryImports(bytes)
	};
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

export interface DriverOptions {
	id: string;
	n: number;
	/** Records per region call; 0 runs `bulk`, whose loop makes one call per record. */
	k?: number;
	width?: number;
	repeats?: number;
	maxTransactionBytes?: number;
	fuel?: number;
	ranges?: boolean;
	/** Lanes run the inline-tracked module. */
	inline?: boolean;
	/** Lanes answer in runs. */
	runs?: boolean;
	maximumFrameBytes?: number;
}

/** Runs a driver serial and through ManagedFolio with in-process lanes; one row per run. */
export async function runDriver(o: DriverOptions) {
	const spec = specOf(o.id);
	const bytes = new Uint8Array(readFileSync(join(driverDir, `${o.id}.wasm`)));
	const artifact = artifactOf(bytes);
	if (!artifact) throw new Error('no control plan');
	const k = o.k ?? 0;
	const width = o.width ?? 4;
	const repeats = o.repeats ?? 3;
	const records = recordsOf(spec, o.n);
	const layout = layoutOf(
		spec,
		o.n,
		records.map((r) => r.input.length)
	);
	const entry = k ? 'bulk_chunks' : 'bulk';
	const args = k ? [layout.table, o.n, layout.out, k] : [layout.table, o.n, layout.out];
	const original = new WebAssembly.Module(Uint8Array.from(bytes));
	let expected = new Uint8Array(0);
	const serialWalls: number[] = [];
	for (let i = 0; i < repeats; i++) {
		const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
		const instance = new WebAssembly.Instance(original, {
			env: { memory, ...hostMath() }
		});
		writeRecords(memory, spec, layout, records);
		const began = performance.now();
		(instance.exports[entry] as CallableFunction)(...args);
		serialWalls.push(performance.now() - began);
		expected = outputOf(memory, spec, layout, o.n).slice();
	}
	const tally = emptyTally();
	const lanes = Array.from({ length: width }, () => {
		const lane = new FolioLane(artifact.transactional!, {
			initial: artifact.control!.initial,
			maximum: artifact.control!.maximum,
			...(o.inline ? { inline: { module: artifact.inline! } } : {})
		});
		const timed: TimedTransport = {
			lastMs: 0,
			execute: async (frame) => {
				const copy = new Uint8Array(frame);
				const began = performance.now();
				const response = new Uint8Array(lane.execute(copy));
				timed.lastMs = performance.now() - began;
				return response;
			},
			close: async () => lane.close()
		};
		return measuring(timed, tally);
	});
	const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	const pool = new ManagedFolio(artifact, {
		lanes,
		imports: { env: { memory, ...hostMath() } },
		memory,
		...(o.ranges === false ? {} : { ranges: {} }),
		...(o.runs ? { runs: true } : {}),
		...(o.maxTransactionBytes ? { maxTransactionBytes: o.maxTransactionBytes } : {}),
		...(o.fuel ? { fuel: o.fuel } : {}),
		...(o.maximumFrameBytes ? { maximumFrameBytes: o.maximumFrameBytes } : {})
	});
	const runs: any[] = [];
	try {
		for (let i = 0; i < repeats; i++) {
			writeRecords(memory, spec, layout, records);
			clearOutput(memory, spec, layout, o.n);
			const before = JSON.parse(JSON.stringify(tally)) as Tally;
			const began = performance.now();
			const report = await pool.run(entry, args, { maximumWorkers: width });
			const wall = performance.now() - began;
			const exact = Buffer.compare(outputOf(memory, spec, layout, o.n), expected) === 0;
			runs.push({
				wallMs: wall,
				exact,
				report,
				requests: tally.requests - before.requests,
				laneMs: tally.laneMs - before.laneMs,
				calls: tally.calls - before.calls,
				reads: tally.reads - before.reads,
				writes: tally.writes - before.writes,
				exhaustedCalls: tally.exhaustedCalls - before.exhaustedCalls,
				requestRows: tally.perRequest.slice(before.perRequest.length)
			});
		}
	} finally {
		await pool.close();
	}
	const serialMs = median(serialWalls);
	const warm = runs[runs.length - 1];
	return {
		id: o.id,
		inline: Boolean(o.inline),
		runs: Boolean(o.runs),
		n: o.n,
		k,
		width,
		serialMs,
		serialUsPerRecord: (serialMs * 1000) / o.n,
		cold: summarizeRun(runs[0], o.n),
		warm: summarizeRun(warm, o.n),
		exact: runs.every((run) => run.exact),
		warmRequests: warm.requestRows as Tally['perRequest'],
		layoutBytes: layout.pages * 65536,
		diagnostics: pool.diagnostics.slice(0, 3)
	};
}

function summarizeRun(run: any, n: number) {
	const report = run.report as ManagedReport;
	return {
		wallMs: Number(run.wallMs.toFixed(2)),
		exact: run.exact,
		regions: report.regions,
		replayed: report.replayed,
		fallbacks: report.fallbacks,
		mode: report.mode,
		requests: run.requests,
		laneMs: Number(run.laneMs.toFixed(2)),
		laneUsPerRecord: Number(((run.laneMs * 1000) / n).toFixed(1)),
		ownerMs: Number((run.wallMs - run.laneMs).toFixed(2)),
		trackedPerRecord: Math.round((run.reads + run.writes) / n),
		reads: run.reads,
		writes: run.writes,
		exhaustedCalls: run.exhaustedCalls,
		sent: report.transportBytes.sent,
		received: report.transportBytes.received,
		rangeBytes: report.rangeBytes ?? 0,
		rounds: report.rounds,
		escapeRounds: report.escapeRounds ?? 0,
		rangeFallbacks: report.rangeFallbacks,
		footprintHits: report.footprintHits ?? 0,
		transportFallbacks: report.transportFallbacks
	};
}

/** Smallest fuel at which no call of a two-record run is exhausted, by bisection. */
export async function fuelPerRecord(id: string): Promise<number> {
	const clean = async (fuel: number) => {
		const row = await runDriver({
			id,
			n: 2,
			width: 2,
			repeats: 2,
			fuel,
			maxTransactionBytes: 1048576
		});
		return row.warm.exhaustedCalls === 0 && row.exact;
	};
	let high = 1000000000;
	if (!(await clean(high))) return Infinity;
	let low = 0;
	while (high - low > Math.max(1, high * 0.01)) {
		const mid = Math.floor((low + high) / 2);
		if (await clean(mid)) high = mid;
		else low = mid;
	}
	return high;
}

if (import.meta.main) {
	const [command, id, ...rest] = process.argv.slice(2);
	const number = (index: number, fallback: number) => Number(rest[index] ?? fallback);
	if (command === 'run') {
		const row = await runDriver({
			id: id!,
			n: number(0, 16),
			k: number(1, 0),
			repeats: number(2, 3),
			maxTransactionBytes: number(3, 0) || undefined,
			fuel: number(4, 0) || undefined,
			ranges: rest[5] !== 'snapshot',
			inline: rest[6] === 'inline',
			runs: rest[7] === 'runs'
		});
		console.log(JSON.stringify(row));
	} else if (command === 'fuel') {
		console.log(JSON.stringify({ id, fuelPerRecord: await fuelPerRecord(id!) }));
	} else
		throw new Error('usage: corpus-lanes.ts run <id> [n k repeats maxBytes fuel] | fuel <id>');
}
