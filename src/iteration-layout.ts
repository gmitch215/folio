import type { IterationLocal } from './extract.ts';

/** Granule sizes of the inline lowering the iteration executor runs. */
export const iterationGranules = { read: 64, write: 32 } as const;

/** Bytes of one undo entry: granule address, stamp, then the prior bytes of the granule. */
export const iterationEntryBytes = 8 + iterationGranules.write;

/** Sizes of the per-batch arena. Every field has a default. */
export interface IterationArenaOptions {
	/** Iterations in flight at once, one slot, bitmap pair and undo log each. Default 32. */
	batch?: number;
	/** Undo entries one iteration may log, the budget in write granules. Default 2048. */
	logCapacity?: number;
	/** Bytes of one private stack slot, a multiple of 64. Default 32768. */
	slotBytes?: number;
	/** Size of the owner frame whose reads the executor tracks, for the per-slot shadow. Default 0. */
	frameBytes?: number;
}

/** Absolute addresses of the arena parts. Slot 0 sits above one unused guard slot. */
export interface IterationArena {
	base: number;
	bytes: number;
	memoryBytes: number;
	batch: number;
	logCapacity: number;
	slotBytes: number;
	slots: number;
	stamp: number;
	logs: number;
	logBytes: number;
	rmaps: number;
	rsize: number;
	wmaps: number;
	wsize: number;
	/** Start of the frame shadows, one per slot, after the write bitmaps. */
	frameShadow: number;
	/** Bytes of one slot's frame shadow; 0 without a tracked frame. */
	frameSlotBytes: number;
	/** The tracked frame size. */
	frameBytes: number;
}

const align = (value: number, to: number) => Math.ceil(value / to) * to;

/**
 * Shadow of one tracked frame: `4 * ceil(size / 32)` bytes of written bits, one per frame byte
 * (the bits of frame granule `g`, 32 bytes, are the i32 at `4 * g`), 4 pad bytes, the exposed bits
 * in the same layout, and 4 pad bytes.
 */
export function iterationFrameShadow(frameBytes: number): { exposed: number; bytes: number } {
	if (!frameBytes) return { exposed: 0, bytes: 0 };
	const granules = Math.ceil(frameBytes / 32);
	const exposed = 4 * granules + 4;
	return { exposed, bytes: align(exposed + 4 * granules + 4, 64) };
}

/**
 * Lays out slots, the stamp word, undo logs and bitmaps from `base`. The bitmaps cover the whole
 * memory, arena included, so `bytes` depends on `memoryBytes` and not on `base`.
 */
export function iterationArena(
	base: number,
	memoryBytes: number,
	options: IterationArenaOptions = {}
): IterationArena {
	const batch = options.batch ?? 32;
	const logCapacity = options.logCapacity ?? 2048;
	const slotBytes = options.slotBytes ?? 32768;
	const frameBytes = options.frameBytes ?? 0;
	if (!Number.isSafeInteger(frameBytes) || frameBytes < 0) throw new RangeError('invalid frame');
	if (!Number.isSafeInteger(base) || base < 0 || base % 64) throw new RangeError('invalid base');
	if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0)
		throw new RangeError('invalid memory size');
	if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1024)
		throw new RangeError('invalid batch');
	if (!Number.isSafeInteger(logCapacity) || logCapacity < 1)
		throw new RangeError('invalid log capacity');
	if (!Number.isSafeInteger(slotBytes) || slotBytes < 64 || slotBytes % 64)
		throw new RangeError('invalid slot size');
	const slots = base + slotBytes;
	const stamp = slots + batch * slotBytes;
	const logs = stamp + 64;
	const logBytes = align(logCapacity * iterationEntryBytes, 64);
	const rmaps = logs + batch * logBytes;
	const rsize = align(Math.ceil(memoryBytes / (iterationGranules.read * 8)), 64);
	const wmaps = rmaps + batch * rsize;
	const wsize = align(Math.ceil(memoryBytes / (iterationGranules.write * 8)), 64);
	const frameShadow = wmaps + batch * wsize;
	const frameSlotBytes = iterationFrameShadow(frameBytes).bytes;
	const end = frameShadow + batch * frameSlotBytes;
	return {
		base,
		bytes: end - base,
		memoryBytes,
		batch,
		logCapacity,
		slotBytes,
		slots,
		stamp,
		logs,
		logBytes,
		rmaps,
		rsize,
		wmaps,
		wsize,
		frameShadow,
		frameSlotBytes,
		frameBytes
	};
}

/** Bytes the caller must keep free for a pool over a memory of `memoryBytes`. */
export const iterationArenaBytes = (
	memoryBytes: number,
	options: IterationArenaOptions = {}
): number => iterationArena(0, memoryBytes, options).bytes;

const PAGE = 65536;

/**
 * Smallest memory of whole pages that holds the arena above `startBytes`. The bitmaps cover the
 * whole memory, so the size is a fixed point: it grows until the arena it needs fits. Undefined
 * when the result would pass 65,536 pages.
 */
export function iterationFit(startBytes: number, options: IterationArenaOptions = {}) {
	const base = align(startBytes, 64);
	let pages = Math.ceil((base + PAGE) / PAGE);
	for (;;) {
		if (pages > PAGE) return;
		const bytes = iterationArenaBytes(pages * PAGE, options);
		if (base + bytes <= pages * PAGE) return { base, pages, bytes, memoryBytes: pages * PAGE };
		pages = Math.ceil((base + bytes) / PAGE);
	}
}

/**
 * Arguments of `iterate` for iteration `k`. A strided local is `entry + k * stride` modulo 2^32, or
 * `entry + k * stride * entry[strideLocal]` when its step is held in a local, an invariant local
 * keeps its entry value, and the frame local takes `frame`.
 */
export function iterationArguments(
	locals: readonly Pick<
		IterationLocal,
		'local' | 'kind' | 'argument' | 'stride' | 'strideLocal'
	>[],
	entry: Readonly<Record<number, number | bigint>>,
	k: number,
	frame: number
): (number | bigint)[] {
	const values: (number | bigint)[] = [];
	for (const item of locals) {
		if (item.argument === undefined) continue;
		if (item.kind === 'frame') {
			values[item.argument] = frame;
			continue;
		}
		const from = entry[item.local];
		if (from === undefined) throw new RangeError(`no loop-entry value for local ${item.local}`);
		if (item.strideLocal !== undefined) {
			const step = entry[item.strideLocal];
			if (step === undefined)
				throw new RangeError(`no loop-entry value for local ${item.strideLocal}`);
			const advance = Math.imul(k, Number(step));
			values[item.argument] = (Number(from) + (item.stride! < 0 ? -advance : advance)) | 0;
		} else values[item.argument] = item.stride ? (Number(from) + k * item.stride) | 0 : from;
	}
	return values;
}
