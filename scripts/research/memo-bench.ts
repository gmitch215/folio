import { writeFileSync } from 'node:fs';
import { kernelSource } from '../../experiments/ranges/kernel.ts';
import {
	BASE,
	MAX_PAGES,
	PARTITION,
	PARTITIONS,
	seedPartitions
} from '../../experiments/ranges/layout.ts';
import { prepare } from '../../src/compiler.ts';
import type { ManagedArtifact, ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { memoryImports } from '../../src/memory.ts';

// in-process measurement on one machine: lanes run on the main thread, so these numbers
// compare work per record, not parallel wall time. usage: node memo-bench.ts <out.jsonl>

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/research/memo-bench.ts <out.jsonl>');
const rows: Record<string, unknown>[] = [];
const emit = (row: Record<string, unknown>) => {
	rows.push(row);
	console.log(JSON.stringify(row));
};

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

// per-region min and max, from the per-run samples
function spread(samples: number[]): [number, number] {
	return [Math.min(...samples) / PARTITIONS, Math.max(...samples) / PARTITIONS];
}

function timed(runs: number, body: () => Promise<void> | void): Promise<number[]> {
	return (async () => {
		const samples: number[] = [];
		for (let i = 0; i < runs; i++) {
			const start = performance.now();
			await body();
			samples.push(performance.now() - start);
		}
		return samples;
	})();
}

async function shaSamples(size: number, runs: number): Promise<number[]> {
	const buffer = new Uint8Array(size);
	for (let i = 0; i < size; i += 4096) buffer[i] = (i >> 12) & 255;
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		await crypto.subtle.digest('SHA-256', buffer);
		samples.push(performance.now() - start);
	}
	return samples;
}

function artifact(bytes: Uint8Array): ManagedArtifact {
	const {
		coordinator,
		transactional,
		workerOriginal: _,
		...control
	} = prepare(bytes, {
		minimumRegionWork: 0
	}).control!;
	return {
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		coordinator: new WebAssembly.Module(Uint8Array.from(coordinator)),
		transactional: new WebAssembly.Module(Uint8Array.from(transactional)),
		control,
		memories: memoryImports(bytes)
	};
}

const program = artifact(kernelSource());
const lanes = (): ManagedLaneTransport[] =>
	Array.from({ length: 4 }, () => {
		const lane = new FolioLane(program.transactional!, {
			initial: program.control!.initial,
			maximum: program.control!.maximum
		});
		return {
			execute: async (frame: Uint8Array) => lane.execute(frame),
			close: async () => lane.close()
		};
	});

// each partition carries an id in two bytes, so every id is a distinct state of every region
function state(bytes: Uint8Array, id: number) {
	seedPartitions(bytes);
	for (let p = 0; p < PARTITIONS; p++) {
		bytes[BASE + p * PARTITION + 4] = id & 255;
		bytes[BASE + p * PARTITION + 5] = (id >> 8) & 255;
	}
}

const newArena = () => new WebAssembly.Memory({ initial: 2, maximum: MAX_PAGES, shared: true });

// digest throughput of the call the memo makes (SubtleCrypto SHA-256 over a fresh buffer)
for (const [label, size] of [
	['1 KiB', 1024],
	['16 KiB', 16384],
	['64 KiB', 65536],
	['8 MiB', 8 * 1048576]
] as const) {
	const samples = await shaSamples(size, size > 1e6 ? 9 : 31);
	const ms = median(samples);
	emit({
		kind: 'sha256',
		label,
		bytes: size,
		medianMs: ms,
		nsPerByte: (ms * 1e6) / size,
		mibPerSecond: size / 1048576 / (ms / 1000)
	});
}

// per-region cost of the kernel at two round counts: native, lane path, and a memo hit
for (const rounds of [4096, 16384]) {
	const nativeMemory = newArena();
	const nativeInstance = new WebAssembly.Instance(program.original, {
		env: { memory: nativeMemory }
	});
	const plain = new ManagedFolio(program as never, { lanes: lanes(), memory: newArena() });
	const memoArena = newArena();
	const memo = new ManagedFolio(program as never, {
		lanes: lanes(),
		memory: memoArena,
		memo: {}
	});
	try {
		state(new Uint8Array(nativeMemory.buffer), 1);
		const expected = (nativeInstance.exports.main as CallableFunction)(BASE, 1, rounds);
		const nativeMs = await timed(5, () => {
			state(new Uint8Array(nativeMemory.buffer), 1);
			(nativeInstance.exports.main as CallableFunction)(BASE, 1, rounds);
		});
		const laneMs = await timed(5, async () => {
			state(new Uint8Array(plain.memory.buffer), 1);
			const report = await plain.run('main', [BASE, 1, rounds]);
			if (report.values[0] !== expected) throw new Error('lane result differs from native');
		});
		state(new Uint8Array(memo.memory.buffer), 1);
		await memo.run('main', [BASE, 1, rounds]);
		let hits = 0;
		const hitMs = await timed(5, async () => {
			state(new Uint8Array(memo.memory.buffer), 1);
			const report = await memo.run('main', [BASE, 1, rounds]);
			if (report.values[0] !== expected) throw new Error('memo hit differs from native');
			hits += report.memoHits!;
		});
		emit({
			kind: 'kernel-region',
			rounds,
			partitionBytes: PARTITION,
			regionsPerRun: PARTITIONS,
			nativeMsPerRegion: median(nativeMs) / PARTITIONS,
			nativeMinMaxMs: spread(nativeMs),
			laneMsPerRegion: median(laneMs) / PARTITIONS,
			laneMinMaxMs: spread(laneMs),
			memoHitMsPerRegion: median(hitMs) / PARTITIONS,
			memoHitMinMaxMs: spread(hitMs),
			memoHitsPerRun: hits / 5
		});
	} finally {
		await plain.close();
		await memo.close();
	}
}

// repetition sweep at 4,096 rounds: K records, a share p of them repeat an earlier state
const K = 24;
const rounds = 4096;
function sequence(p: number): number[] {
	const ids: number[] = [];
	let fresh = 0;
	for (let i = 0; i < K; i++) {
		const isNew = i === 0 || Math.floor((i + 1) * (1 - p)) > Math.floor(i * (1 - p));
		if (isNew) ids.push(fresh++);
		else ids.push(ids[(i * 7) % ids.length]!);
	}
	return ids;
}
const nativeMemory = newArena();
const nativeInstance = new WebAssembly.Instance(program.original, {
	env: { memory: nativeMemory }
});
const expectedById = new Map<number, number>();
for (const id of new Set(sequence(0))) {
	state(new Uint8Array(nativeMemory.buffer), id);
	expectedById.set(id, (nativeInstance.exports.main as CallableFunction)(BASE, 1, rounds));
}
for (const run of [0, 1, 2])
	for (const p of [0, 0.25, 0.5, 0.9]) {
		const ids = sequence(p);
		const unique = new Set(ids).size;
		const arms: Record<string, { ms: number; hits: number; regions: number; hashed: number }> =
			{};
		for (const arm of ['native', 'lane', 'memo'] as const) {
			const arena = newArena();
			const pool =
				arm === 'native'
					? undefined
					: new ManagedFolio(program as never, {
							lanes: lanes(),
							memory: arena,
							...(arm === 'memo' ? { memo: { bytes: 64 * 1048576 } } : {})
						});
			const native =
				arm === 'native'
					? new WebAssembly.Instance(program.original, { env: { memory: arena } })
					: undefined;
			let hits = 0,
				hashed = 0,
				regions = 0,
				ms = 0;
			try {
				for (const id of ids) {
					state(new Uint8Array(arena.buffer), id);
					const start = performance.now();
					if (native) {
						const value = (native.exports.main as CallableFunction)(BASE, 1, rounds);
						if (value !== expectedById.get(id))
							throw new Error(`${arm} differs at id ${id}`);
					} else {
						const report = await pool!.run('main', [BASE, 1, rounds]);
						if (report.values[0] !== expectedById.get(id))
							throw new Error(`${arm} differs at id ${id}`);
						hits += report.memoHits ?? 0;
						hashed += report.memoHashedBytes ?? 0;
						regions += report.regions ?? 0;
					}
					ms += performance.now() - start;
				}
			} finally {
				await pool?.close();
			}
			arms[arm] = { ms, hits, regions, hashed };
		}
		emit({
			kind: 'repetition',
			run,
			memoHashedBytes: arms.memo!.hashed,
			p,
			records: K,
			uniqueStates: unique,
			repeatRecords: K - unique,
			nativeMs: arms.native!.ms,
			laneMs: arms.lane!.ms,
			memoMs: arms.memo!.ms,
			memoHitRate: arms.memo!.regions ? arms.memo!.hits / arms.memo!.regions : 0,
			speedupVsSerial: arms.native!.ms / arms.memo!.ms,
			speedupVsLane: arms.lane!.ms / arms.memo!.ms
		});
	}

writeFileSync(out, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
