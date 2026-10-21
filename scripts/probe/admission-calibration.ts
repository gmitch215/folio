import binaryen from 'binaryen';
import { appendFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { estimateWork } from '../../src/extract.ts';
import { Folio } from '../../src/node.ts';

interface Cell {
	shape: 'compute' | 'stream';
	trips: number;
	extra: number;
	count: number;
}

const memoryPages = 2049;

function source(cell: Cell): string {
	const slab = cell.shape === 'stream' ? cell.trips * 4 : 4;
	const body =
		cell.shape === 'compute'
			? `(local.set $v (i32.load (local.get $addr)))
				(loop $l
					(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 13))))
					(local.set $v (i32.xor (local.get $v) (i32.shr_u (local.get $v) (i32.const 17))))
					(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 5))))
					(local.set $i (i32.add (local.get $i) (i32.const 1)))
					(br_if $l (i32.ne (local.get $i) (local.get $n))))
				(i32.store (local.get $addr) (local.get $v))`
			: `(loop $l
					(local.set $v (i32.load (i32.add (local.get $addr) (i32.shl (local.get $i) (i32.const 2)))))
					${Array.from(
						{ length: cell.extra },
						(_, k) =>
							`(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const ${(k % 11) + 1}))))`
					).join('\n')}
					(i32.store (i32.add (local.get $addr) (i32.shl (local.get $i) (i32.const 2))) (local.get $v))
					(local.set $i (i32.add (local.get $i) (i32.const 1)))
					(br_if $l (i32.ne (local.get $i) (local.get $n))))`;
	return `(module
		(import "env" "memory" (memory $m ${memoryPages} 8192 shared))
		(func $work (param $addr i32) (param $n i32) (local $i i32) (local $v i32)
			${body})
		(func (export "run") (param $base i32) (param $count i32) (param $n i32) (local $j i32)
			(loop $outer
				(call $work
					(i32.add (local.get $base) (i32.mul (local.get $j) (i32.const ${slab})))
					(local.get $n))
				(local.set $j (i32.add (local.get $j) (i32.const 1)))
				(br_if $outer (i32.lt_u (local.get $j) (local.get $count)))))
	)`;
}

function estimate(text: string, trips: number) {
	const module = binaryen.parseText(text);
	const work = estimateWork(
		binaryen.getFunctionInfo(module.getFunction('work')).body,
		() => undefined,
		trips
	);
	module.dispose();
	return work;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

// usage: node scripts/probe/admission-calibration.ts OUTPUT.jsonl [PAIRS]
const [output, pairsArg] = process.argv.slice(2);
if (!output) throw new Error('usage: admission-calibration.ts OUTPUT.jsonl [PAIRS]');
const pairs = Number(pairsArg ?? 15);
writeFileSync(output, '');
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');
emit({
	kind: 'environment',
	node: process.version,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	pairs
});

const cells: Cell[] = [
	...[1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144].map((trips): Cell => ({
		shape: 'compute',
		trips,
		extra: 0,
		count: trips <= 256 ? 512 : 64
	})),
	...[16, 256, 4096, 65536, 1048576].map((trips): Cell => ({
		shape: 'compute',
		trips,
		extra: 0,
		count: 1
	})),
	...[0, 4, 16, 32, 64, 128, 256, 512].flatMap((extra) =>
		[256, 4096].map((trips): Cell => ({ shape: 'stream', trips, extra, count: 64 }))
	)
];

for (const cell of cells) {
	const text = source(cell);
	const bytes = binaryen.parseText(text).emitBinary();
	const work = estimate(text, cell.trips);
	const arms: { name: string; workers: number }[] = [
		{ name: 'native', workers: 0 },
		{ name: 'folio-2', workers: 2 },
		{ name: 'folio-8', workers: 8 }
	];
	const open = async (workers: number) => {
		const memory = new WebAssembly.Memory({
			initial: memoryPages,
			maximum: 8192,
			shared: true
		});
		const imports = { env: { memory } };
		const words = new Uint32Array(memory.buffer);
		for (let i = 0; i < cell.count * (cell.shape === 'stream' ? cell.trips : 1); i++)
			words[(1024 >> 2) + i] = Math.imul(i + 1, 2654435761) >>> 0;
		if (!workers) {
			const instance = new WebAssembly.Instance(
				new WebAssembly.Module(Uint8Array.from(bytes)),
				imports
			);
			return {
				memory,
				run: async () =>
					void (instance.exports.run as CallableFunction)(1024, cell.count, cell.trips),
				report: undefined as any,
				close: async () => {}
			};
		}
		const pool = await Folio.open(bytes, {
			imports,
			memory,
			workers,
			minimumRegionWork: 0
		});
		const holder: { report?: any } = {};
		return {
			memory,
			run: async () => {
				holder.report = await pool.run('run', [1024, cell.count, cell.trips]);
			},
			get report() {
				return holder.report;
			},
			close: () => pool.close()
		};
	};
	const opened = await Promise.all(arms.map((arm) => open(arm.workers)));
	const times = new Map<string, number[]>(arms.map((arm) => [arm.name, []]));
	const cpu = new Map<string, number[]>(arms.map((arm) => [arm.name, []]));
	let digests: string[] = [];
	for (let round = -2; round < pairs; round++) {
		for (let turn = 0; turn < arms.length; turn++) {
			const index = (turn + round + 2) % arms.length;
			const arm = arms[index]!;
			const instance = opened[index]!;
			const cpuStart = process.cpuUsage();
			const start = performance.now();
			await instance.run();
			const wall = performance.now() - start;
			const used = process.cpuUsage(cpuStart);
			if (round >= 0) {
				times.get(arm.name)!.push(wall);
				cpu.get(arm.name)!.push((used.user + used.system) / 1000);
			}
		}
	}
	digests = opened.map((instance) => {
		const words = new Uint32Array(instance.memory.buffer, 0, 1024 * 300);
		let hash = 0;
		for (const word of words) hash = (Math.imul(hash, 31) + word) | 0;
		return String(hash);
	});
	const nativeMedian = median(times.get('native')!);
	const row = {
		kind: 'cell',
		...cell,
		compute: work.compute,
		accesses: work.accesses,
		regionsPerRun: cell.count,
		nativeMs: nativeMedian,
		nativeNsPerRegion: (nativeMedian * 1e6) / cell.count,
		equalMemory: new Set(digests).size === 1,
		load: loadavg()[0],
		arms: Object.fromEntries(
			arms.slice(1).map((arm, k) => {
				const report = opened[k + 1]!.report;
				return [
					arm.name,
					{
						medianMs: median(times.get(arm.name)!),
						speedup: nativeMedian / median(times.get(arm.name)!),
						cpuRatio: median(cpu.get(arm.name)!) / median(cpu.get('native')!),
						pairedSpeedups: times
							.get(arm.name)!
							.map((time, i) => times.get('native')![i]! / time),
						workers: report?.workers,
						regions: report?.regions,
						replayed: report?.replayed
					}
				];
			})
		)
	};
	emit(row);
	console.log(
		cell.shape,
		cell.trips,
		cell.extra,
		'native us/region',
		row.nativeNsPerRegion / 1000,
		'compute',
		work.compute,
		'acc',
		work.accesses,
		'x2',
		(row.arms['folio-2'] as any).speedup.toFixed(3),
		'x8',
		(row.arms['folio-8'] as any).speedup.toFixed(3),
		'eq',
		row.equalMemory
	);
	for (const instance of opened) await instance.close();
}
process.exit(0);
