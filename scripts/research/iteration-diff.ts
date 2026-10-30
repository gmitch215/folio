// the iteration executor against the serial program. `random N` runs N seeded programs, `blake3`
// runs the unmodified BLAKE3 consumer (`blake3 INPUTS BYTES WIDTH` is the large equality run, with
// an arm that sends the same call through `Folio.open` and `Folio.run` at default options)
import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { prepare } from '../../src/compiler.ts';
import type { IterationRoute } from '../../src/extract.ts';
import type { IterationArenaOptions, IterationJob, IterationReport } from '../../src/iteration.ts';
import { IterationPool, iterationArena, iterationArguments } from '../../src/iteration.ts';
import { Folio } from '../../src/node.ts';

const PAGE = 65536;
const align = (value: number, to: number) => Math.ceil(value / to) * to;

export interface Rig {
	route: IterationRoute;
	original: WebAssembly.Module;
	entry: string;
	pages: number;
	maximum: number;
	memory: WebAssembly.Memory;
	arenaBase: number;
	arenaEnd: number;
	pools: Map<number, IterationPool>;
	plain: WebAssembly.Instance;
	close(): Promise<void>;
}

export interface Run {
	bytes: Uint8Array;
	error?: unknown;
	report?: IterationReport;
}

// pages and arena base so that the arena fits above `hostEnd` with bitmaps over the whole memory
export function fit(hostEnd: number, options: IterationArenaOptions = {}) {
	const arenaBase = align(hostEnd, 64);
	for (let pages = Math.ceil((arenaBase + PAGE) / PAGE); ; pages++) {
		const bytes = iterationArena(arenaBase, pages * PAGE, options).bytes;
		if (arenaBase + bytes <= pages * PAGE)
			return { pages, arenaBase, arenaEnd: arenaBase + bytes };
	}
}

export async function openRig(
	bytes: Uint8Array,
	route: IterationRoute,
	entry: string,
	memory: { pages: number; maximum: number; arenaBase: number; arenaEnd: number },
	widths: number[],
	options: IterationArenaOptions = {}
): Promise<Rig> {
	const shared = new WebAssembly.Memory({
		initial: memory.pages,
		maximum: memory.maximum,
		shared: true
	});
	const pools = new Map<number, IterationPool>();
	for (const width of widths)
		pools.set(
			width,
			await IterationPool.open(route, shared, {
				...options,
				arenaBase: memory.arenaBase,
				width
			})
		);
	const plain = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(route.module!)), {
		env: { memory: shared }
	});
	return {
		route,
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		entry,
		pages: memory.pages,
		maximum: memory.maximum,
		memory: shared,
		arenaBase: memory.arenaBase,
		arenaEnd: memory.arenaEnd,
		pools,
		plain,
		async close() {
			await Promise.all([...pools.values()].map((pool) => pool.close()));
		}
	};
}

// loop-entry values the route can compute before the owner runs
export function entryValues(route: IterationRoute, args: readonly number[]) {
	const entry: Record<number, number> = {};
	for (const item of route.locals) {
		if (item.argument === undefined || item.kind === 'frame') continue;
		const start = item.start;
		if (!start) throw new Error(`local ${item.local} has no computable entry value`);
		entry[item.local] = 'parameter' in start ? args[start.parameter]! : start.constant;
	}
	return entry;
}

// the image as instantiation leaves it: data segments applied over the given bytes
export function booted(rig: Rig, image: Uint8Array): Uint8Array {
	const memory = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.maximum });
	new Uint8Array(memory.buffer).set(image);
	new WebAssembly.Instance(rig.original, { env: { memory } });
	return new Uint8Array(memory.buffer).slice();
}

export function serialRun(rig: Rig, image: Uint8Array, args: readonly number[]): Run {
	const memory = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.maximum });
	new Uint8Array(memory.buffer).set(image);
	const instance = new WebAssembly.Instance(rig.original, { env: { memory } });
	let error: unknown;
	try {
		(instance.exports[rig.entry] as (...a: number[]) => unknown)(...args);
	} catch (caught) {
		error = caught;
	}
	return { bytes: new Uint8Array(memory.buffer), error };
}

export function iterationRun(
	rig: Rig,
	width: number,
	image: Uint8Array,
	args: readonly number[],
	extra: Pick<IterationJob, 'schedule' | 'skip' | 'probe' | 'admit'> = {}
): Run {
	const { route } = rig;
	const view = new Uint8Array(rig.memory.buffer);
	image = booted(rig, image);
	view.set(image.subarray(0, rig.arenaBase));
	const stack = rig.plain.exports[route.stackExport!] as WebAssembly.Global;
	const size = route.frame?.size ?? 0;
	const top = stack.value as number;
	const frameBase = top - size;
	const parameter = route.trip!.parameter!;
	const probeArgs = [...args];
	probeArgs[parameter] = 0;
	const probe = serialRun(rig, image, probeArgs);
	view.set(probe.bytes.subarray(frameBase, top), frameBase);
	const entry = entryValues(route, args);
	const iterate = rig.plain.exports[route.iterate!] as (...a: (number | bigint)[]) => void;
	const pool = rig.pools.get(width)!;
	let error: unknown;
	try {
		pool.run({
			trip: args[parameter]!,
			frameBase,
			entry,
			replay(k) {
				stack.value = frameBase;
				iterate(...iterationArguments(route.locals, entry, k, frameBase));
			},
			...extra
		});
	} catch (caught) {
		error = caught;
	}
	stack.value = top;
	return { bytes: view.slice(), error, report: pool.report };
}

// first byte that differs outside the stack residue below `stackEnd` and the arena, or -1
export function firstDifference(rig: Rig, a: Uint8Array, b: Uint8Array, stackEnd = PAGE): number {
	for (let i = stackEnd; i < a.length; i++) {
		if (i >= rig.arenaBase && i < rig.arenaEnd) {
			i = rig.arenaEnd - 1;
			continue;
		}
		if (a[i] !== b[i]) return i;
	}
	return -1;
}

export const sameError = (a: unknown, b: unknown) =>
	a === undefined || b === undefined
		? a === b
		: a instanceof Error &&
			b instanceof Error &&
			a.constructor === b.constructor &&
			a.message === b.message;

// #region the WAT family
export const wat = {
	table: 0x10000,
	src: 0x20000,
	dst: 0x30000,
	cell: 64,
	arena: 0x100000,
	pages: 32,
	frame: 64
};

const family = `(module
	(import "env" "memory" (memory ${wat.pages} ${wat.pages}))
	(global $sp (mut i32) (i32.const 65536))
	(func $tri (param $n i32) (result i32) (local $f i32) (local $r i32)
		(local.set $f (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $f))
		(i32.store (local.get $f) (local.get $n))
		(local.set $r (if (result i32) (i32.eqz (local.get $n))
			(then (i32.const 0))
			(else (i32.add (i32.load (local.get $f)) (call $tri (i32.sub (local.get $n) (i32.const 1)))))))
		(global.set $sp (i32.add (local.get $f) (i32.const 16)))
		(local.get $r))
	(func $item (param $t i32) (param $scale i32) (local $s i32) (local $src i32) (local $dst i32)
		(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $s))
		(local.set $src (i32.load (local.get $t)))
		(local.set $dst (i32.load offset=4 (local.get $t)))
		(i32.store (local.get $s) (call $tri (i32.and (i32.load (local.get $src)) (i32.const 7))))
		(i32.store offset=4 (local.get $scale) (i32.load (local.get $s)))
		(i32.store (local.get $dst) (i32.add
			(i32.add (i32.load (local.get $src)) (i32.load offset=4 (local.get $scale)))
			(i32.load (local.get $scale))))
		(global.set $sp (i32.add (local.get $s) (i32.const 16))))
	(func $run (export "run") (param $t i32) (param $n i32) (local $frame i32) (local $c i32)
		(local.set $frame (i32.sub (global.get $sp) (i32.const ${wat.frame})))
		(global.set $sp (local.get $frame))
		(i32.store (local.get $frame) (i32.const 3))
		(block $done
			(br_if $done (i32.eqz (local.get $n)))
			(local.set $c (local.get $n))
			(loop $each
				(call $item (local.get $t) (local.get $frame))
				(local.set $t (i32.add (local.get $t) (i32.const 8)))
				(br_if $each (local.tee $c (i32.sub (local.get $c) (i32.const 1))))))
		(global.set $sp (i32.add (local.get $frame) (i32.const ${wat.frame}))))
)`;

export function watModule(): Uint8Array {
	binaryen.setDebugInfo(true);
	const module = binaryen.parseText(family);
	try {
		const compactImports = (binaryen.Features as unknown as { CompactImports: number })
			.CompactImports;
		module.setFeatures(binaryen.Features.All & ~compactImports);
		if (!module.validate()) throw new Error('invalid family module');
		return module.emitBinary();
	} finally {
		module.dispose();
		binaryen.setDebugInfo(false);
	}
}

export const srcCell = (i: number) => wat.src + wat.cell * i;
export const dstCell = (i: number) => wat.dst + wat.cell * i;

export async function watRig(widths: number[], options: IterationArenaOptions = {}) {
	const bytes = watModule();
	const route = prepare(bytes, { minimumRegionWork: 0 }).iterationRoute!;
	if (!route.eligible) throw new Error(route.diagnostics.join('; '));
	const settings = { batch: 32, logCapacity: 64, slotBytes: 4096, ...options };
	const arena = iterationArena(wat.arena, wat.pages * PAGE, settings);
	const memory = {
		pages: wat.pages,
		maximum: wat.pages,
		arenaBase: wat.arena,
		arenaEnd: wat.arena + arena.bytes
	};
	if (memory.arenaEnd > wat.pages * PAGE) throw new Error('arena does not fit');
	return openRig(bytes, route, 'run', memory, widths, settings);
}

/** One program of the family: where each iteration reads and writes, and the cells' values. */
export interface Plan {
	src: number[];
	dst: number[];
	values?: number[];
}

export function planImage(plan: Plan): { image: Uint8Array; args: number[] } {
	const image = new Uint8Array(wat.arena);
	const view = new DataView(image.buffer);
	const n = plan.src.length;
	for (let i = 0; i < n; i++) {
		view.setUint32(wat.table + 8 * i, plan.src[i]!, true);
		view.setUint32(wat.table + 8 * i + 4, plan.dst[i]!, true);
		view.setUint32(srcCell(i), plan.values?.[i] ?? 100 + 3 * i, true);
		view.setUint32(dstCell(i), 0xab000000 + i, true);
	}
	return { image: padded(image), args: [wat.table, n] };
}

// the executor image covers the whole memory; only the part below the arena is copied in
function padded(image: Uint8Array): Uint8Array {
	const full = new Uint8Array(wat.pages * PAGE);
	full.set(image);
	return full;
}

export const disjoint = (n: number): Plan => ({
	src: Array.from({ length: n }, (_, i) => srcCell(i)),
	dst: Array.from({ length: n }, (_, i) => dstCell(i))
});
// #endregion

// #region random programs
const rng = (seed: number) => {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Seeded plan: some iterations read another's output, some write another's output cell. */
export function randomPlan(seed: number): { plan: Plan; width: number } {
	const next = rng(seed);
	const n = 8 + Math.floor(next() * 90);
	const readProb = next() * 0.3;
	const writeProb = next() * 0.2;
	const plan = disjoint(n);
	plan.values = Array.from({ length: n }, () => Math.floor(next() * 1000));
	for (let i = 0; i < n; i++) {
		if (next() < readProb) plan.src[i] = dstCell(Math.floor(next() * n));
		if (next() < writeProb) plan.dst[i] = dstCell(Math.floor(next() * n));
	}
	return { plan, width: [2, 4, 8][seed % 3]! };
}

export function randomSeeds(rig: Rig, from: number, to: number) {
	const rows: { seed: number; n: number; width: number; replayed: number; equal: boolean }[] = [];
	for (let seed = from; seed <= to; seed++) {
		const { plan, width } = randomPlan(seed);
		const { image, args } = planImage(plan);
		const want = serialRun(rig, image, args);
		const got = iterationRun(rig, width, image, args);
		rows.push({
			seed,
			n: plan.src.length,
			width,
			replayed: got.report!.replayed,
			equal:
				firstDifference(rig, want.bytes, got.bytes) === -1 &&
				sameError(want.error, got.error)
		});
	}
	return rows;
}
// #endregion

// #region the BLAKE3 consumer
export const blake3File = new URL(
	'../../results/corpus/blake3-consumer/blake3-hash-all.wasm',
	import.meta.url
);

export function generate(index: number, size: number) {
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

export async function blake3Rig(sizes: number[], widths: number[], options: IterationArenaOptions) {
	const bytes = new Uint8Array(readFileSync(blake3File));
	const route = prepare(bytes).iterationRoute!;
	if (!route.eligible) throw new Error(route.diagnostics.join('; '));
	const n = sizes.length;
	const table = 0x11000;
	const out = table + align(8 * n, 64) + 64;
	let at = align(out + 32 * n, 64) + 64;
	const offsets = sizes.map((size) => {
		const offset = at;
		at = align(at + size, 64) + 64;
		return offset;
	});
	const { pages, arenaBase, arenaEnd } = fit(at, options);
	const rig = await openRig(
		bytes,
		route,
		'hash_all',
		{ pages, maximum: 65536, arenaBase, arenaEnd },
		widths,
		options
	);
	const image = new Uint8Array(pages * PAGE);
	const view = new DataView(image.buffer);
	sizes.forEach((size, i) => {
		image.set(generate(i, size), offsets[i]!);
		view.setUint32(table + 8 * i, offsets[i]!, true);
		view.setUint32(table + 8 * i + 4, size, true);
	});
	return { rig, image, args: [table, n, out], out };
}

// the consumer through Folio.open and Folio.run: a shared host memory the library grows for the arena
export async function folioRun(
	rig: Rig,
	bytes: Uint8Array,
	image: Uint8Array,
	args: readonly number[],
	width: number
) {
	const memory = new WebAssembly.Memory({
		initial: Math.ceil(rig.arenaBase / PAGE),
		maximum: 65536,
		shared: true
	});
	new Uint8Array(memory.buffer).set(image.subarray(0, rig.arenaBase));
	const t0 = performance.now();
	const folio = await Folio.open(bytes, { workers: width, memory });
	const t1 = performance.now();
	const first = await folio.run('hash_all', args);
	const t2 = performance.now();
	const out = new Uint8Array(folio.memory.buffer).slice(0, rig.arenaBase);
	const second = await folio.run('hash_all', args);
	const t3 = performance.now();
	const memoryBytes = folio.memory.buffer.byteLength;
	await folio.close();
	return {
		bytes: out,
		memoryBytes,
		openMs: t1 - t0,
		firstRunMs: t2 - t1,
		secondRunMs: t3 - t2,
		first,
		second
	};
}

export const digests = (run: Run, out: number, n: number) =>
	createHash('sha256')
		.update(run.bytes.subarray(out, out + 32 * n))
		.digest('hex');

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const mode = process.argv[2];
	if (mode === 'random') {
		const seeds = Number(process.argv[3] ?? 200);
		const rig = await watRig([2, 4, 8]);
		const rows = randomSeeds(rig, 1, seeds);
		await rig.close();
		const bad = rows.filter((r) => !r.equal);
		console.log(
			JSON.stringify({
				seeds,
				mismatches: bad.length,
				withReplays: rows.filter((r) => r.replayed > 0).length,
				bad
			})
		);
		process.exit(bad.length ? 1 : 0);
	} else if (mode === 'blake3') {
		const inputs = Number(process.argv[3] ?? 32);
		const size = Number(process.argv[4] ?? 4 << 20);
		const width = Number(process.argv[5] ?? 8);
		const sizes = Array.from({ length: inputs }, () => size);
		const { rig, image, args, out } = await blake3Rig(sizes, [width], {});
		const t0 = performance.now();
		const want = serialRun(rig, image, args);
		const t1 = performance.now();
		const got = iterationRun(rig, width, image, args);
		const t2 = performance.now();
		const equal = firstDifference(rig, want.bytes, got.bytes) === -1;
		await rig.close();
		const through = await folioRun(rig, readFileSync(blake3File), image, args, width);
		const folioEqual =
			firstDifference(rig, want.bytes.subarray(0, rig.arenaBase), through.bytes) === -1;
		console.log(
			JSON.stringify(
				{
					inputs,
					bytes: size,
					width,
					memoryEqual: equal,
					digestsEqual: digests(want, out, inputs) === digests(got, out, inputs),
					digest: digests(got, out, inputs),
					replayed: got.report!.replayed,
					report: got.report,
					serialMs: t1 - t0,
					executorMs: t2 - t1,
					folio: {
						memoryEqual: folioEqual,
						digestsEqual:
							digests(want, out, inputs) ===
							digests({ bytes: through.bytes }, out, inputs),
						memoryBytes: through.memoryBytes,
						openMs: through.openMs,
						firstRunMs: through.firstRunMs,
						secondRunMs: through.secondRunMs,
						first: through.first,
						second: through.second
					},
					load: loadavg()[0]
				},
				null,
				1
			)
		);
		process.exit(equal && folioEqual ? 0 : 1);
	}
}
// #endregion
