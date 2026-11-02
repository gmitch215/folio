// four partitions of 16 KiB at 64 KiB; the rest of the arena is never read or written by the kernel
export const PARTITION = 16384;
export const PARTITIONS = 4;
export const BASE = 65536;
export const ARENAS = [131072, 1048576, 8388608, 33554432] as const;
export const MAX_PAGES = 512;

export type Fill = 'zero' | 'random';
export const FILLS: readonly Fill[] = ['zero', 'random'];

const FILL_SEED = 0x2545f4914f6cdd1dn;

export interface Helpers {
	fill(at: number, length: number, seed: bigint): void;
	digest(at: number, length: number): bigint;
}

export function helpers(module: WebAssembly.Module, memory: WebAssembly.Memory): Helpers {
	const exports = new WebAssembly.Instance(module, { env: { memory } }).exports as any;
	return {
		fill: exports.fill,
		digest: (at, length) => BigInt.asUintN(64, exports.digest(at, length))
	};
}

/** The four partitions get fixed pseudo-random words, the same in every request. */
export function seedPartitions(bytes: Uint8Array) {
	const words = new Uint32Array(bytes.buffer, BASE, (PARTITION * PARTITIONS) / 4);
	let state = 12345;
	for (let i = 0; i < words.length; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		words[i] = state;
	}
}

/** Zero is the fresh memory; random fills every byte outside the partitions. */
export function fillArena(tools: Helpers, bytes: Uint8Array, fill: Fill) {
	if (fill === 'zero') return;
	tools.fill(0, BASE, FILL_SEED);
	const end = BASE + PARTITION * PARTITIONS;
	tools.fill(end, bytes.length - end, FILL_SEED ^ 0x9e3779b97f4a7c15n);
}

export const hex = (value: bigint) => value.toString(16).padStart(16, '0');
