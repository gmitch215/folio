import type { IterationRoute } from '../../src/extract.ts';
import { IterationPool, iterationArguments, type IterationReport } from '../../src/iteration.ts';
import { booted, entryValues, fit } from './iteration-diff.ts';

// shared by the redirect gate and its timing: a pool over a route, the serial program, the same call routed
export interface Rig {
	route: IterationRoute;
	original: WebAssembly.Module;
	pages: number;
	memory: WebAssembly.Memory;
	arenaBase: number;
	arenaEnd: number;
	pools: Map<number, IterationPool>;
	plain: WebAssembly.Instance;
}

export interface Run {
	bytes: Uint8Array;
	error?: unknown;
	report?: IterationReport;
}

export async function openRig(
	bytes: Uint8Array,
	route: IterationRoute,
	hostEnd: number,
	widths: number[],
	imports: WebAssembly.ModuleImports = {}
): Promise<Rig> {
	const f = fit(hostEnd);
	const memory = new WebAssembly.Memory({ initial: f.pages, maximum: f.pages, shared: true });
	const pools = new Map<number, IterationPool>();
	for (const width of widths)
		pools.set(
			width,
			await IterationPool.open(route, memory, { arenaBase: f.arenaBase, width })
		);
	const plain = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(route.module!)), {
		env: { memory, ...imports }
	});
	return {
		route,
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		pages: f.pages,
		memory,
		arenaBase: f.arenaBase,
		arenaEnd: f.arenaEnd,
		pools,
		plain
	};
}

export const closeRig = (rig: Rig) =>
	Promise.all([...rig.pools.values()].map((pool) => pool.close()));

// the serial program: the original module in place on a private memory
export function serial(
	rig: Pick<Rig, 'pages' | 'original'>,
	image: Uint8Array,
	args: number[],
	imports: WebAssembly.ModuleImports
): Run {
	const memory = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
	new Uint8Array(memory.buffer).set(image.subarray(0, memory.buffer.byteLength));
	const instance = new WebAssembly.Instance(rig.original, { env: { memory, ...imports } });
	let error: unknown;
	try {
		(instance.exports.bulk as (...a: number[]) => unknown)(...args);
	} catch (caught) {
		error = caught;
	}
	return { bytes: new Uint8Array(memory.buffer), error };
}

// the same call through the pool; no admission, so every iteration is dispatched
export function routed(rig: Rig, width: number, image: Uint8Array, args: number[]): Run {
	const { route } = rig;
	const view = new Uint8Array(rig.memory.buffer);
	const first = booted(
		{ pages: rig.pages, maximum: rig.pages, original: rig.original } as never,
		image
	);
	view.set(first.subarray(0, rig.arenaBase));
	const stack = route.stackExport
		? (rig.plain.exports[route.stackExport] as WebAssembly.Global)
		: undefined;
	const top = stack ? (stack.value as number) : 0;
	const entry = entryValues(route, args);
	const iterate = rig.plain.exports[route.iterate!] as (...a: (number | bigint)[]) => void;
	const pool = rig.pools.get(width)!;
	let error: unknown;
	try {
		pool.run({
			trip: args[route.trip!.parameter!]!,
			frameBase: top,
			entry,
			replay(k) {
				if (stack) stack.value = top;
				iterate(...iterationArguments(route.locals, entry, k, top));
			}
		});
	} catch (caught) {
		error = caught;
	}
	if (stack) stack.value = top;
	return { bytes: view.slice(), error, report: pool.report };
}

// prepares the memory once and returns a call that runs only the pool, for timing
export function launch(rig: Rig, width: number, image: Uint8Array, args: number[]) {
	const { route } = rig;
	const view = new Uint8Array(rig.memory.buffer);
	view.set(
		booted(
			{ pages: rig.pages, maximum: rig.pages, original: rig.original } as never,
			image
		).subarray(0, rig.arenaBase)
	);
	const stack = route.stackExport
		? (rig.plain.exports[route.stackExport] as WebAssembly.Global)
		: undefined;
	const top = stack ? (stack.value as number) : 0;
	const entry = entryValues(route, args);
	const iterate = rig.plain.exports[route.iterate!] as (...a: (number | bigint)[]) => void;
	const pool = rig.pools.get(width)!;
	return () => {
		const started = performance.now();
		pool.run({
			trip: args[route.trip!.parameter!]!,
			frameBase: top,
			entry,
			replay(k) {
				if (stack) stack.value = top;
				iterate(...iterationArguments(route.locals, entry, k, top));
			}
		});
		if (stack) stack.value = top;
		return { ms: performance.now() - started, report: pool.report, view };
	};
}

// first byte that differs at or above `from`, outside the arena, or -1
export function firstDifference(rig: Rig, a: Uint8Array, b: Uint8Array, from: number): number {
	const end = Math.min(a.length, b.length);
	for (let i = from; i < end; i++) {
		if (i >= rig.arenaBase && i < rig.arenaEnd) {
			i = rig.arenaEnd - 1;
			continue;
		}
		if (a[i] !== b[i]) return i;
	}
	return a.length === b.length ? -1 : end;
}
