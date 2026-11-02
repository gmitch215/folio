import { availableParallelism } from 'node:os';
import { isSharedArrayBuffer } from 'node:util/types';
import {
	MessageChannel,
	type MessagePort,
	Worker,
	receiveMessageOnPort
} from 'node:worker_threads';
import type { IterationRoute } from './extract.ts';
import { inlineGlobals, lowerInline } from './inline.ts';
import {
	type IterationAdmission,
	type IterationEstimate,
	type IterationStop,
	admissionSeam,
	batchBound,
	projectBatch,
	refineEstimate
} from './iteration-admission.ts';
import {
	type IterationArena,
	type IterationArenaOptions,
	type IterationWindow,
	iterationArena,
	iterationEntryBytes,
	iterationGranules,
	iterationWindowCopy
} from './iteration-layout.ts';
import {
	type IterationReadWindows,
	type ReadWindowCounts,
	learnReadWindows,
	readWindowsClear,
	readWindowsPay
} from './read-windows.ts';

export {
	iterationArena,
	iterationArenaBytes,
	iterationArguments,
	iterationEntryBytes,
	iterationFit,
	iterationFrameShadow,
	iterationGranules,
	iterationLogCeiling,
	iterationWindowBytes,
	iterationWindowCopy
} from './iteration-layout.ts';
export type { IterationArena, IterationArenaOptions, IterationWindow } from './iteration-layout.ts';

/** Pool construction options. */
export interface IterationPoolOptions extends IterationArenaOptions {
	/** Start of the arena, 64-byte aligned, in memory the caller keeps free while the pool is open. */
	arenaBase: number;
	/** Workers; defaults to up to four. */
	width?: number;
	/**
	 * Undo entries per iteration of the log a batch is retried with after its log is exhausted.
	 * Defaults to `logCapacity`, which leaves the retry off; `iterationLogCeiling` is the grown size the tests use.
	 */
	logCeiling?: number;
	/**
	 * Learn read windows from the first batch that completes without a conflict: a load that falls
	 * in a window sets no mark and skips the slot and frame checks, because the worker marked the
	 * whole window before the iteration. The next full batch runs on a lowering that counts its
	 * loads, and the windows stay armed for the rest of the call only if the counts say they pay
	 * (`readWindowsPay`). Off by default.
	 */
	readWindows?: boolean;
	/**
	 * Keep a summary byte per 64 words of every read bitmap, set by each read mark, so a worker scans
	 * only the blocks a read touched. The scan result is the same as the full scan. Off by default.
	 */
	readSummary?: boolean;
	/**
	 * Guard a batch against an iteration that never returns. The worker module polls a stop word at
	 * every loop start. When the owner has waited past the limit it sets the word: every iteration
	 * in flight traps, is rolled back from the undo logs and rerun serially in order, and the loop
	 * ends with `stopped: 'stalled'`. Off by default; `true` takes the defaults of
	 * `IterationStallOptions`.
	 */
	stall?: boolean | IterationStallOptions;
}

/** The wait before the stall guard stops a batch: `floorMs` plus `factor` times its serial estimate. */
export interface IterationStallOptions {
	/**
	 * Times the serial time of the iterations one worker runs in a batch. Default 50, above the
	 * slowdown of tracked code over plain code by an order of magnitude.
	 */
	factor?: number;
	/** Least wait in ms, which also covers waking the workers and compiling the first iteration. Default 2000. */
	floorMs?: number;
}

/** One owner call's loop. */
export interface IterationJob {
	/** Iterations to run. An entry value of zero runs 2^32 times in the program; refuse that upstream. */
	trip: number;
	/** The owner's frame local after its prologue; the image at `[frameBase, frameBase + size)` is copied. */
	frameBase: number;
	/** Loop-entry value of every local in `route.locals` that has an `argument`, except the frame. */
	entry: Readonly<Record<number, number | bigint>>;
	/** Runs iteration `k` serially on the owner frame. A throw is the program's trap. */
	replay(k: number): void;
	/** Test hook: `reverse` makes one worker run a batch last to first. Default `forward`. */
	schedule?: 'forward' | 'reverse';
	/** Test hook, unsound: validation checks to leave out. */
	skip?: readonly ('raw' | 'war' | 'waw' | 'frame')[];
	/**
	 * A window an earlier call learned: the batches start on slot-private copies of it. Ignored when
	 * the arena reserves no window bytes or the window does not fit this call (see `report.window`).
	 */
	window?: IterationWindow;
	/** Whether a batch that conflicts may name a window and go on with it. Default true. */
	discover?: boolean;
	/**
	 * Runs iteration 0 through `replay` on the owner thread first and times it. That is the serial
	 * program's first iteration, so its writes stay and the batches cover iterations 1 to `trip - 1`
	 * from the owner frame it leaves. Called once with the time of that iteration, before anything
	 * is dispatched. A refusal runs the other iterations through `replay` and dispatches nothing.
	 * Without `admit` every iteration is dispatched.
	 */
	admit?: (plainIterationMs: number) => IterationAdmission;
	/**
	 * Called after each batch that leaves iterations behind, with its wall (dispatch, validation,
	 * rollback and replay) and the serial time of its iterations at the time of iteration 0. True
	 * ends the dispatch and runs the rest through `replay`. Only used with `admit`.
	 */
	loses?: (batchWallMs: number, batchSerialMs: number) => boolean;
	/** Like `loses`, for a batch slow enough that a second batch is not needed to confirm it. */
	collapses?: (batchWallMs: number, batchSerialMs: number) => boolean;
	/**
	 * Called after each batch with the best speedup its workers could reach at the tracked time
	 * they showed. True ends the dispatch: no later batch could pay at this tracking cost. Only
	 * used with `admit`.
	 */
	hopeless?: (bound: number) => boolean;
	/**
	 * Called with the bound of the first batch when read windows were learned from it. True makes
	 * the first batch on them one iteration per worker, which `hopeless` and the projection of the
	 * next batch then judge. Only used with `admit` and `hopeless`.
	 */
	unproven?: (bound: number) => boolean;
	/**
	 * Whether `remaining` more iterations at `perIterationMs` of serial time each are worth
	 * dispatching. Asked with the online estimate before each batch after the first, where false ends
	 * the dispatch, and after the timed serial blocks of a refused loop, where true starts it. Only
	 * used with `admit`.
	 */
	reconsider?: (
		perIterationMs: number,
		remaining: number,
		last?: { wallMs: number; count: number }
	) => boolean;
}

/** What a run did. `regions`, `replayed`, `fallbacks` and `workers` parallel `ExecutionReport`. */
export interface IterationReport {
	/** Workers that took part. */
	workers: number;
	/** Iterations run on workers, the regions of this mode. */
	regions: number;
	/** Dispatched iterations that were rolled back and rerun serially at the owner. */
	replayed: number;
	/** Iterations whose writes were undone before the rerun. */
	rolledBack: number;
	/** Batches whose first failure was a trap or an exhausted undo log, not a dependency. */
	fallbacks: number;
	/** Iterations that trapped on a worker. */
	traps: number;
	/** Iterations that exhausted their undo log. */
	exhausted: number;
	/** Iterations that trapped on an access to another iteration's stack slot. */
	violations: number;
	/** Batches in which the stall guard fired. */
	stalls: number;
	/** Iterations the stall word stopped, rolled back and rerun serially. */
	stalledIterations: number;
	batches: number;
	failedBatches: number;
	undoEntries: number;
	/** The most undo entries one completed iteration logged. */
	maxLogEntries: number;
	/** Times a batch that exhausted its log was retried with the grown log. */
	logGrowths: number;
	/** Iterations rolled back and dispatched again by such a retry. They are not in `regions`. */
	retried: number;
	/** Ordered iteration pairs by hazard. */
	conflicts: { raw: number; war: number; waw: number; frame: number };
	/** From posting a batch to the last worker reply. */
	dispatchMs: number;
	validationMs: number;
	rollbackMs: number;
	replayMs: number;
	/** Wasm time inside workers, summed. */
	workerRunMs: number;
	/** Bitmap scan and clear time inside workers, summed. */
	workerScanMs: number;
	/** Time the workers spent marking read windows before their iterations, summed. */
	workerMarkMs: number;
	/** Read bitmap words the workers scanned, summed. */
	workerScanWords: number;
	/** Read bitmap words they found non-zero. */
	workerScanSet: number;
	/**
	 * Iterations the owner ran as the serial program without dispatching them: iteration 0, the
	 * rest of a loop after a stop, or all of them when admission refused the loop.
	 */
	serial: number;
	/** What ended the dispatch early, or why admission refused the loop. */
	stopped?: IterationStop;
	/** What the admission callback saw and chose; set when the job had one. */
	admission?: IterationAdmission;
	/** Frame conflicts that fell in a window's bytes; they are also in `conflicts.frame`. */
	windowConflicts: number;
	/** The window the batches ran on, if any, and where it came from. */
	window?: {
		low: number;
		end: number;
		source: 'given' | 'discovered';
		/** Batches dispatched on it. */
		batches: number;
	};
	/** Why a window that was offered or found was not used. */
	windowRefused?: string;
	/** The read windows learned from the first clean batch, with the batches that ran on them. */
	readWindows?: IterationReadWindows & { batches: number; learnedFrom: number };
	/** Why read windows were not learned, or were dropped after a batch on them conflicted. */
	readWindowRefused?: string;
	/** What the counted batch on the read windows saw, and whether they were armed for the loop. */
	readWindowGate?: {
		iterations: number;
		counts: ReadWindowCounts;
		saved: number;
		spent: number;
		/** which check the armed module runs first for a load of at most 8 bytes */
		order: 'window' | 'exempt';
		armed: boolean;
	};
}

/** What a worker returns for one iteration. */
export interface IterationOutcome {
	index: number;
	/** 0 ran, 1 trapped, 2 undo log exhausted, 3 stopped by the stall word */
	status: number;
	entries: number;
	/** wall time of the iteration inside the worker, on the tracked module */
	runMs: number;
	/** sorted write granules (32 bytes) from the undo log */
	written: Int32Array;
	/** [start, length] runs of read granules (64 bytes) */
	reads: Int32Array;
	/** written bit per frame byte, one i32 per 32-byte frame granule; empty when nothing was written */
	frameWritten: Uint32Array;
	/** bit per frame byte the iteration read before writing it, same layout; empty when none */
	frameExposed: Uint32Array;
	/** position in the batch of the first slot this iteration reached outside its own, or -1 */
	touched?: number;
	/** loads of at most 8 bytes by where they landed, from the counting module only */
	counts?: ReadWindowCounts;
}

const newReport = (workers: number): IterationReport => ({
	workers,
	regions: 0,
	replayed: 0,
	rolledBack: 0,
	fallbacks: 0,
	traps: 0,
	exhausted: 0,
	violations: 0,
	stalls: 0,
	stalledIterations: 0,
	batches: 0,
	failedBatches: 0,
	undoEntries: 0,
	maxLogEntries: 0,
	logGrowths: 0,
	retried: 0,
	conflicts: { raw: 0, war: 0, waw: 0, frame: 0 },
	dispatchMs: 0,
	validationMs: 0,
	rollbackMs: 0,
	replayMs: 0,
	workerRunMs: 0,
	workerScanMs: 0,
	workerMarkMs: 0,
	workerScanWords: 0,
	workerScanSet: 0,
	serial: 0,
	windowConflicts: 0
});

const shift = Math.log2(iterationGranules.read / iterationGranules.write);

// sorted write granules against sorted read runs
function hitsReads(writes: Int32Array, runs: Int32Array): boolean {
	let p = 0;
	for (let i = 0; i < writes.length; i++) {
		const g = writes[i]! >> shift;
		while (p < runs.length && runs[p]! + runs[p + 1]! <= g) p += 2;
		if (p >= runs.length) return false;
		if (runs[p]! <= g) return true;
	}
	return false;
}

function hitsWrites(a: Int32Array, b: Int32Array): boolean {
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i]! === b[j]!) return true;
		if (a[i]! < b[j]!) i++;
		else j++;
	}
	return false;
}

type Verdict = {
	first: number;
	firstFailure: number;
	frameFirst: number;
	conflicts: { raw: number; war: number; waw: number; frame: number };
	/** Frame conflicts that fall in the first `windowWords` words; set only when that was asked for. */
	window?: number;
};
type VerdictInput = Pick<IterationOutcome, 'status' | 'written' | 'reads'> &
	Partial<Pick<IterationOutcome, 'frameWritten' | 'frameExposed' | 'touched'>>;
type Skip = readonly ('raw' | 'war' | 'waw' | 'frame')[];

/** Ordered pairs by hazard and the first iteration that cannot keep its writes, or -1. */
interface MemoryConflicts {
	raw: number;
	war: number;
	waw: number;
	first: number;
}

/** The pairwise form: every ordered pair against every other. Any batch size; the reference. @internal */
export function pairwiseConflicts(outcomes: readonly VerdictInput[], skip: Skip): MemoryConflicts {
	const found = { raw: 0, war: 0, waw: 0, first: outcomes.length };
	for (let j = 0; j < outcomes.length; j++) {
		for (let k = j + 1; k < outcomes.length; k++) {
			const a = outcomes[j]!;
			const b = outcomes[k]!;
			if (!skip.includes('raw') && hitsReads(a.written, b.reads)) {
				found.raw++;
				found.first = Math.min(found.first, k);
			}
			if (!skip.includes('war') && hitsReads(b.written, a.reads)) {
				found.war++;
				found.first = Math.min(found.first, j);
			}
			if (!skip.includes('waw') && hitsWrites(a.written, b.written)) {
				found.waw++;
				found.first = Math.min(found.first, j);
			}
		}
	}
	return found;
}

const bitsBelow = (k: number) => (k >= 32 ? 0xffffffff : k <= 0 ? 0 : 0xffffffff >>> (32 - k));
const popcount = (value: number) => {
	value -= (value >>> 1) & 0x55555555;
	value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
	return (Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) | 0;
};
const lowestBit = (value: number) => 31 - Math.clz32(value & -value);

// open-addressing table from a write granule to the set of iterations that wrote it, reused
const writers = { keys: new Int32Array(0), masks: new Uint32Array(0), used: new Int32Array(0) };

/**
 * `pairwiseConflicts` in time linear in the sizes of the sets, for at most 32 outcomes: one table
 * from write granule to the bit set of the iterations that wrote it, then each read granule looks
 * its two write granules up. A pair counts once however many granules it shares, so the counts
 * equal the pairwise form's. @internal
 */
export function tabledConflicts(outcomes: readonly VerdictInput[], skip: Skip): MemoryConflicts {
	const n = outcomes.length;
	if (n > 32) throw new RangeError('at most 32 outcomes');
	const found = { raw: 0, war: 0, waw: 0, first: n };
	let total = 0;
	for (const o of outcomes) total += o.written.length;
	if (!total || n < 2) return found;
	const size = 1 << Math.max(4, 32 - Math.clz32(2 * total));
	if (writers.keys.length < size) {
		writers.keys = new Int32Array(size);
		writers.masks = new Uint32Array(size);
		writers.used = new Int32Array(size >> 1);
	}
	const { keys, masks, used } = writers;
	keys.fill(0, 0, size);
	masks.fill(0, 0, size);
	const wrap = size - 1;
	const shiftBits = 32 - Math.log2(size);
	const find = (granule: number, insert: boolean): number => {
		const key = granule + 1;
		let at = Math.imul(key, 0x9e3779b1) >>> shiftBits;
		for (;;) {
			const have = keys[at]!;
			if (have === key) return at;
			if (have === 0) {
				if (!insert) return -1;
				keys[at] = key;
				return at;
			}
			at = (at + 1) & wrap;
		}
	};
	let count = 0;
	for (let k = 0; k < n; k++) {
		const bit = (1 << k) >>> 0;
		for (const granule of outcomes[k]!.written) {
			const at = find(granule, true);
			if (!masks[at]) used[count++] = at;
			masks[at] = (masks[at]! | bit) >>> 0;
		}
	}
	if (!skip.includes('waw')) {
		const rows = new Uint32Array(n);
		for (let u = 0; u < count; u++) {
			const mask = masks[used[u]!]!;
			if (mask & (mask - 1))
				for (let m = mask; m; m &= m - 1) {
					const k = lowestBit(m);
					rows[k] = (rows[k]! | (mask & bitsBelow(k))) >>> 0;
				}
		}
		let any = 0;
		for (const row of rows) {
			found.waw += popcount(row);
			any |= row;
		}
		if (any) found.first = Math.min(found.first, lowestBit(any));
	}
	if (skip.includes('raw') && skip.includes('war')) return found;
	const raw = new Uint32Array(n);
	const war = new Uint32Array(n);
	const take = (reader: number, mask: number) => {
		raw[reader] = (raw[reader]! | (mask & bitsBelow(reader))) >>> 0;
		war[reader] = (war[reader]! | (mask & ~bitsBelow(reader + 1))) >>> 0;
	};
	for (let k = 0; k < n; k++) {
		const runs = outcomes[k]!.reads;
		for (let r = 0; r < runs.length; r += 2) {
			const start = runs[r]!;
			const length = runs[r + 1]!;
			if (length > count) {
				// a run longer than the table: ask each written granule whether the run covers it
				for (let u = 0; u < count; u++) {
					const at = used[u]!;
					const read = (keys[at]! - 1) >> 1;
					if (read >= start && read < start + length) take(k, masks[at]!);
				}
				continue;
			}
			for (let g = start; g < start + length; g++) {
				const a = find(2 * g, false);
				const b = find(2 * g + 1, false);
				const mask = ((a < 0 ? 0 : masks[a]!) | (b < 0 ? 0 : masks[b]!)) >>> 0;
				if (mask) take(k, mask);
			}
		}
	}
	for (let k = 0; k < n; k++) {
		if (!skip.includes('raw') && raw[k]) {
			found.raw += popcount(raw[k]!);
			found.first = Math.min(found.first, k);
		}
		if (!skip.includes('war') && war[k]) {
			found.war += popcount(war[k]!);
			found.first = Math.min(found.first, k);
		}
	}
	return found;
}

/**
 * Index of the first outcome that cannot keep its writes, or -1. Writes land in place, so every
 * ordered pair is checked three ways: RAW marks the reader, WAR the earlier reader, WAW the earlier
 * writer. A fourth check covers the frame, which each iteration owns as a private copy: an
 * iteration fails when it read a frame byte before writing it that an earlier iteration wrote, and
 * counts once. Works on the returned lists, never on dense bitmaps. A batch of at most 32 goes
 * through `tabledConflicts`, a larger one through the pairwise form.
 *
 * `windowWords` is the number of leading frame words that belong to slot-private windows; the
 * result then also counts, as `window`, the frame conflicts that fall in them.
 */
export function iterationVerdict(
	outcomes: readonly VerdictInput[],
	skip: Skip = [],
	windowWords = 0
): Verdict {
	let frameFirst = outcomes.length;
	let firstFailure = outcomes.length;
	outcomes.forEach((o, k) => {
		if (o.status) firstFailure = Math.min(firstFailure, k);
	});
	let first = firstFailure;
	// an iteration that reached into another slot may have changed what the owner of it saw
	outcomes.forEach((o) => {
		if (o.status && o.touched !== undefined && o.touched >= 0 && o.touched < first)
			first = o.touched;
	});
	const memory =
		outcomes.length <= 32 ? tabledConflicts(outcomes, skip) : pairwiseConflicts(outcomes, skip);
	const conflicts = { raw: memory.raw, war: memory.war, waw: memory.waw, frame: 0 };
	first = Math.min(first, memory.first);
	let windowed = 0;
	if (!skip.includes('frame')) {
		// the frame bytes written by the iterations before k, against the bytes k read unwritten
		let union: Uint32Array | undefined;
		outcomes.forEach((o, k) => {
			const exposed = o.frameExposed;
			if (union && exposed?.length && exposed.some((word, w) => word & (union![w] ?? 0))) {
				conflicts.frame++;
				first = Math.min(first, k);
				frameFirst = Math.min(frameFirst, k);
				if (
					windowWords &&
					exposed.some((word, w) => w < windowWords && word & (union![w] ?? 0))
				)
					windowed++;
			}
			const written = o.frameWritten;
			if (!written?.length) return;
			union ??= new Uint32Array(written.length);
			written.forEach((word, w) => (union![w]! |= word));
		});
	}
	const none = outcomes.length;
	return {
		first: first === none ? -1 : first,
		firstFailure: firstFailure === none ? -1 : firstFailure,
		frameFirst: frameFirst === none ? -1 : frameFirst,
		conflicts,
		...(windowWords ? { window: windowed } : {})
	};
}

/**
 * The window a failed batch suggests: the span of the write granules that at least half of its
 * iterations wrote, rounded out to 64 bytes. That is where iterations share a location they write
 * every time, a scratch buffer, a context or an allocator's cursor, and `cap` bytes is the most a
 * pool holds. Half and not two, because iterations that race on a shared context also write wild
 * granules (a length read mid-update indexes anywhere), and those are rarely written twice. Whether
 * the iterations write the window before they read it is not asked here: a window that is wrong
 * only fails validation on the next batch.
 */
export function discoverWindow(
	outcomes: readonly Pick<IterationOutcome, 'written'>[],
	cap: number
): { window?: IterationWindow; reason?: string; granules: number } {
	const seen = new Map<number, number>();
	for (const o of outcomes) for (const g of o.written) seen.set(g, (seen.get(g) ?? 0) + 1);
	const need = Math.max(2, Math.ceil(outcomes.length / 2));
	const shared = [...seen]
		.filter(([, n]) => n >= need)
		.map(([g]) => g)
		.sort((x, y) => x - y);
	const granules = shared.length;
	if (!granules)
		return {
			reason: `no write granule is shared by ${need} of ${outcomes.length} iterations`,
			granules
		};
	const from = Math.floor((shared[0]! * 32) / 64) * 64;
	const end = Math.ceil(((shared[granules - 1]! + 1) * 32) / 64) * 64;
	if (end - from > cap) {
		// the clusters, split at gaps over 4 KiB, name what the span is made of
		const clusters: string[] = [];
		let at = 0;
		for (let i = 1; i <= granules; i++)
			if (i === granules || shared[i]! - shared[i - 1]! > 128) {
				clusters.push(`0x${(shared[at]! * 32).toString(16)}+${(i - at) * 32}`);
				at = i;
			}
		return {
			reason: `the shared writes span ${end - from} bytes, over ${cap}: ${clusters.slice(0, 6).join(' ')}`,
			granules
		};
	}
	return { window: { low: from, end }, granules };
}

/** Where the undo logs of a batch live and how many iterations it may hold. */
interface LogArea {
	base: number;
	capacity: number;
	bytes: number;
	inFlight: number;
}

const PAGE = 65536;

/** Iterations in the first batch of a loop that learns read windows. */
const readWindowLearnBatch = 8;

// callee stack a slot keeps below a window copy and the frame
const windowStackBytes = 4096;

interface Link {
	worker: Worker;
	port: MessagePort;
	signal: Int32Array;
}

/**
 * Runs the loop of one owner call on worker threads. Each iteration gets a private stack slot and
 * tracks its reads and writes inline. The owner validates a batch in order, rolls back the first
 * failing iteration and every later one from the undo logs, and replays them through `replay`.
 * The arena belongs to the pool until `close`.
 *
 * Each iteration runs on a private copy of the owner frame, taken from the owner frame when its
 * batch is dispatched. The lowered module tracks the frame: a written bit per frame byte, and an
 * exposed bit per 32-byte frame granule that the iteration read before it wrote the byte. An
 * iteration fails validation, like a RAW pair, when it has an exposed granule that an earlier
 * iteration of the same batch wrote (`conflicts.frame`); it and every later one in the batch roll
 * back and replay. After a batch validates, each kept
 * iteration's written frame bytes are copied into the owner frame in order, so the next batch
 * starts from the serial frame and a replay runs on it. The guarantee: a read of an owner frame
 * byte that the same iteration has not written yet, with a write by an earlier iteration of the
 * batch to that byte, is detected, and an earlier batch's writes are seen through the copy.
 * Excluded: a read of stack below the frame (callee frames, indeterminate before the callee writes
 * them) is not tracked, and imported host functions that touch memory are not seen. The shadow
 * is byte-exact for scalar accesses and ranges; a conservative read would only add reports.
 *
 * The callee stack of an iteration, the part of its slot below the frame copy, sets no marks and
 * logs no undo entries, and a rollback does not restore it. An access that reaches another slot
 * of the arena traps; the iteration fails with the owner of that slot, so both and every later one
 * replay (`violations` counts them). A program that reads callee stack before writing it sees
 * what an earlier iteration in that slot left, a rolled back one included.
 *
 * With `admit`, iteration 0 runs first on the owner and the batches cover the rest. Dispatch
 * stops after a batch that exhausted an undo log, had a frame conflict, replayed more than half of
 * its iterations, or (with `loses` and `collapses`) two batches in a row did not beat the serial
 * time of their iterations or one took far longer than it; the rest of the loop runs through
 * `replay` and `report.stopped` names the reason. Once an iteration fails, the workers start no
 * further iteration of that batch, because it and every later one replay anyway.
 */
export class IterationPool {
	readonly arena: IterationArena;
	readonly width: number;
	#report: IterationReport;
	readonly #memory: WebAssembly.Memory;
	readonly #links: Link[] = [];
	readonly #control = new Int32Array(new SharedArrayBuffer(4));
	#u8: Uint8Array;
	#u32: Uint32Array;
	#closed = false;
	#memoryBytes: number;
	readonly #ceiling: number;
	readonly #readWindows: boolean;
	readonly #stall?: { factor: number; floorMs: number };
	#stalled = false;
	#broken?: string;
	// the batch rules stopped the last call that dispatched, so the first batch of the next is short
	#cold = false;
	// the grown log, taken from pages added above the arena at the first exhaustion and kept
	#grown?: LogArea;
	readonly #route: IterationRoute;
	// lowerings besides the open-time one, by key: w the write window, r read windows with the windows
	// tested first and x with the exempt window first, c counting; each is built at its first batch
	// and sent to every worker
	readonly #variants = new Map<string, WebAssembly.Module>();

	private constructor(
		route: IterationRoute,
		memory: WebAssembly.Memory,
		arena: IterationArena,
		width: number,
		ceiling: number,
		readWindows: boolean,
		stall?: { factor: number; floorMs: number }
	) {
		this.#route = route;
		this.#readWindows = readWindows;
		this.#stall = stall;
		this.#memory = memory;
		this.arena = arena;
		this.width = width;
		this.#ceiling = ceiling;
		this.#memoryBytes = arena.memoryBytes;
		this.#report = newReport(0);
		this.#u8 = new Uint8Array(memory.buffer);
		this.#u32 = new Uint32Array(memory.buffer);
	}

	/** Bytes of memory the pool expects: the arena's memory plus any pages its grown log added. */
	get memoryBytes(): number {
		return this.#memoryBytes;
	}

	/** The report of the last run, also after a run that threw. */
	get report(): IterationReport {
		return this.#report;
	}

	/** Lowers the route's worker module inline and starts `width` workers over `memory`. */
	static async open(
		route: IterationRoute,
		memory: WebAssembly.Memory,
		options: IterationPoolOptions
	): Promise<IterationPool> {
		if (!route.eligible || !route.module || !route.iterate)
			throw new TypeError('iteration route is not eligible');
		const memoryBytes = memory.buffer.byteLength;
		if (!isSharedArrayBuffer(memory.buffer))
			throw new TypeError('iteration pool requires shared memory');
		const width = options.width ?? Math.min(4, availableParallelism());
		if (!Number.isInteger(width) || width < 1 || width > 64)
			throw new RangeError('invalid worker count');
		if (
			options.logCeiling !== undefined &&
			(!Number.isSafeInteger(options.logCeiling) || options.logCeiling < 1)
		)
			throw new RangeError('invalid log ceiling');
		const stall = options.stall
			? {
					factor: (options.stall === true ? undefined : options.stall.factor) ?? 50,
					floorMs: (options.stall === true ? undefined : options.stall.floorMs) ?? 2000
				}
			: undefined;
		if (stall && !(stall.factor >= 0 && stall.floorMs > 0))
			throw new RangeError('invalid stall limits');
		const frameSize = route.frame?.size ?? 0;
		const arena = iterationArena(options.arenaBase, memoryBytes, {
			...options,
			frameBytes: frameSize
		});
		if (arena.base + arena.bytes > arena.memoryBytes)
			throw new RangeError('arena does not fit in memory');
		if (frameSize >= arena.slotBytes) throw new RangeError('slot is smaller than the frame');
		const lowered = lowerInline(route.module, {
			readGranule: iterationGranules.read,
			writeGranule: iterationGranules.write,
			frame: frameSize > 0,
			slot: true,
			stop: Boolean(stall),
			readSummary: arena.ssize
		});
		const module = new WebAssembly.Module(Uint8Array.from(lowered));
		const pool = new IterationPool(
			route,
			memory,
			arena,
			width,
			options.logCeiling ?? arena.logCapacity,
			Boolean(options.readWindows),
			stall
		);
		pool.#u8.fill(0, arena.stamp, arena.stamp + 64);
		pool.#u8.fill(0, arena.rmaps, arena.wmaps + arena.batch * arena.wsize);
		if (arena.ssize) pool.#u8.fill(0, arena.smaps, arena.smaps + arena.batch * arena.ssize);
		const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
		try {
			await Promise.all(
				Array.from({ length: width }, () => {
					const channel = new MessageChannel();
					const signal = new SharedArrayBuffer(4);
					const worker = new Worker(
						new URL(`./iteration-worker.${extension}`, import.meta.url),
						{
							workerData: {
								module,
								memory,
								arena,
								globals: inlineGlobals,
								iterate: route.iterate,
								locals: route.locals,
								frameSize,
								port: channel.port2,
								signal,
								control: pool.#control.buffer
							},
							transferList: [channel.port2]
						}
					);
					pool.#links.push({
						worker,
						port: channel.port1,
						signal: new Int32Array(signal)
					});
					return new Promise<void>((resolve, reject) => {
						worker.once('message', () => resolve());
						worker.once('error', reject);
					});
				})
			);
		} catch (error) {
			await pool.close();
			throw error;
		}
		return pool;
	}

	// blocks the owner thread until the worker replies, the idiom of TaskPool.join; undefined when
	// the clock passes `deadline` first
	#join(
		link: Link,
		deadline = Infinity
	):
		| {
				done?: IterationOutcome[];
				runMs?: number;
				scanMs?: number;
				markMs?: number;
				scanWords?: number;
				scanSet?: number;
				error?: string;
		  }
		| undefined {
		for (;;) {
			const seen = Atomics.load(link.signal, 0);
			const message = receiveMessageOnPort(link.port);
			if (message) return message.message;
			const wait = deadline - performance.now();
			if (wait <= 0) return;
			Atomics.wait(link.signal, 0, seen, wait);
		}
	}

	/** Runs the loop to completion with ordered validation. Blocks the calling thread. */
	run(job: IterationJob): IterationReport {
		if (this.#closed) throw new Error('iteration pool is closed');
		if (this.#broken) throw new Error(this.#broken);
		if (this.#memory.buffer.byteLength !== this.#memoryBytes)
			throw new Error('memory changed size while the iteration pool was open');
		if (!Number.isSafeInteger(job.trip) || job.trip < 0)
			throw new RangeError('invalid trip count');
		const A = this.arena;
		const report = (this.#report = newReport(Math.min(this.width, Math.max(job.trip, 0))));
		// serial time per iteration as far as it is known: iteration 0, then timed serial blocks, then
		// the workers' own times scaled by `kappa`, the ratio of serial to tracked time
		let estimate: IterationEstimate = { estimateMs: 0 };
		let from = 0;
		if (job.admit && job.trip > 0) {
			// iteration 0 is the serial program's own first iteration, so its writes stay
			const t = performance.now();
			report.serial = 1;
			job.replay(0);
			const plainMs = performance.now() - t;
			estimate = { estimateMs: plainMs };
			from = 1;
			report.admission = job.admit(plainMs);
			report.admission.estimateMs = plainMs;
			if (report.admission.probe && job.trip > 3) {
				// iteration 0 runs cold, and a probe is judged on the estimate, so time one more
				const t = performance.now();
				report.serial++;
				job.replay(1);
				estimate = { estimateMs: Math.min(plainMs, performance.now() - t) };
				from = 2;
				report.admission.estimateMs = estimate.estimateMs;
			}
			if (!report.admission.admitted) {
				const probed = this.#probe(job, report, plainMs);
				if (probed.at >= job.trip) {
					report.stopped = 'no-admission';
					return report;
				}
				from = probed.at;
				estimate = { estimateMs: probed.estimate };
				report.admission.admitted = true;
				report.admission.readmittedAt = from;
			}
		}
		let stopped = false;
		let slow = 0;
		// wall and size of the last batch that was timed against the serial estimate
		let lastTimed: { wallMs: number; count: number } | undefined;
		// the estimate runs high when iteration 0 was the fastest; a probe is a gamble on the
		// estimate, so it is judged on iteration 0's own time when that is lower
		const perMs = () =>
			report.admission?.probe
				? Math.min(estimate.estimateMs, estimate.referenceMs ?? Infinity)
				: estimate.estimateMs;
		let window: IterationWindow | undefined;
		let tried = job.discover === false || !A.windowBytes;
		let probeLeft = 0;
		let rw: IterationReadWindows | undefined;
		let rwTried = !this.#readWindows;
		// the first batch on newly learned read windows is one iteration per worker: its tracked
		// cost is not known until it ran, and a loop it cannot pay for should not run a full batch.
		// So is the first batch after a call the batch rules stopped: the code may still be at its
		// baseline tier, where a full batch runs several slow iterations per worker
		let prove = Boolean(job.admit && job.hopeless) && rwTried && this.#cold;
		// learned windows are armed after one counted batch on them says they pay
		let rwCounted = false;
		let rwOrder: 'window' | 'exempt' = 'window';
		// iterations of the short learning batch, so the next batch realigns to the grid of full ones
		let offGrid = 0;
		const probes: IterationOutcome[] = [];
		let pendingStop: IterationStop | undefined;
		if (job.window) {
			tried = true;
			const why = this.#refuseWindow(job.window, job.frameBase);
			if (why) report.windowRefused = why;
			else {
				window = { low: job.window.low, end: job.window.end };
				report.window = { ...window, source: 'given', batches: 0 };
			}
		}
		let logs: LogArea = {
			base: A.logs,
			capacity: A.logCapacity,
			bytes: A.logBytes,
			inFlight: A.batch
		};
		let grown = false;
		// the batch rules ended the dispatch, as against the floor on the serial time that is left
		let costStop = false;
		for (let first = from; first < job.trip;) {
			// the first batch of a loop that may learn read windows is short, so little runs fully tracked
			const small = !rwTried && !rw && report.batches === 0;
			const counting = Boolean(rw) && !rwCounted;
			// short batches shift the grid of full ones, and a tail the floor then refuses runs
			// serially; the batch after them is cut so that the ones after that end where they would
			const full = logs.inFlight - (offGrid % logs.inFlight);
			const count = Math.min(
				probeLeft ? 1 : small ? readWindowLearnBatch : prove ? this.width : full,
				job.trip - first
			);
			if (small || prove) offGrid += count;
			else if (!probeLeft) offGrid = 0;
			if (stopped) {
				const t = performance.now();
				try {
					for (let k = 0; k < count; k++) {
						report.serial++;
						job.replay(first + k);
					}
				} finally {
					report.replayMs += performance.now() - t;
				}
				first += count;
				continue;
			}
			// the estimate has been updated by the batches before; what is left may no longer pay
			// a probe has no timed batch to go on until its first one is done
			const waiting = report.admission?.probe && !lastTimed;
			if (
				report.batches &&
				job.admit &&
				!waiting &&
				job.reconsider?.(perMs(), job.trip - first, lastTimed) === false
			) {
				report.stopped ??= 'no-admission';
				stopped = true;
				continue;
			}
			report.batches++;
			const short = prove;
			prove = false;
			const ran = window;
			if (report.window && ran) report.window.batches++;
			let usedRw: IterationReadWindows | undefined;
			if (rw) {
				if (readWindowsClear(rw, first, count, this.#memoryBytes, this.#forbidden())) {
					usedRw = rw;
					report.readWindows!.batches++;
				} else
					report.readWindowRefused ??=
						'a window of a batch leaves memory or meets the arena';
			}
			const counted = Boolean(usedRw) && counting;
			// lowering a variant happens before the batch is timed
			const variant = this.#variant(Boolean(ran), usedRw ? rwOrder : undefined, counted);
			const t0 = performance.now();
			const outcomes = this.#dispatch(
				first,
				count,
				job,
				report,
				logs,
				estimate.estimateMs,
				ran,
				usedRw,
				variant
			);
			const stalled = this.#stalled;
			if (stalled) report.stalls++;
			const t1 = performance.now();
			report.dispatchMs += t1 - t0;
			for (const o of outcomes) {
				report.undoEntries += o.entries;
				if (o.status === 3) report.stalledIterations++;
				if (o.status === 0)
					report.maxLogEntries = Math.max(report.maxLogEntries, o.entries);
				if (o.status === 1) report.traps++;
				if (o.status === 2) report.exhausted++;
				if (o.touched !== undefined && o.touched >= 0) report.violations++;
			}
			const v = iterationVerdict(
				outcomes,
				job.skip,
				ran ? Math.ceil((ran.end - ran.low) / 32) : 0
			);
			report.windowConflicts += v.window ?? 0;
			report.conflicts.raw += v.conflicts.raw;
			report.conflicts.war += v.conflicts.war;
			report.conflicts.waw += v.conflicts.waw;
			report.conflicts.frame += v.conflicts.frame;
			const t2 = performance.now();
			report.validationMs += t2 - t1;
			// an exhausted log is retried once from the first failing iteration with the grown log;
			// the iterations before it stay, and the rest are rolled back and dispatched again. A
			// hazard already found among the iterations that ran is no retry: their sets only grow, so
			// the dependence would be there again and the dispatch would end after a wasted batch
			const hazards = v.conflicts.raw + v.conflicts.war + v.conflicts.waw + v.conflicts.frame;
			// read windows are learned from the first batch that completed clean; a batch on them that
			// conflicts drops them and is not held against the loop, because the window may be the cause
			let rwExempt = false;
			if (usedRw && hazards) {
				rw = undefined;
				rwExempt = true;
				report.readWindowRefused = 'a batch on the read windows conflicted';
			} else if (counted) {
				// the first batch on the windows counts its loads, and the windows stay only if they pay;
				// it is a full batch, so counting costs the loop no extra dispatch
				rwCounted = true;
				rwExempt = !short;
				const done = outcomes.filter((o) => o.status === 0 && o.counts);
				const counts = { hits: 0, misses: 0, exempt: 0 };
				for (const o of done) {
					counts.hits += o.counts!.hits;
					counts.misses += o.counts!.misses;
					counts.exempt += o.counts!.exempt;
				}
				const verdict = readWindowsPay(counts, rw!, Boolean(A.frameBytes), done.length);
				const armed = verdict.pay || !admissionSeam.gate;
				rwOrder = verdict.order;
				report.readWindowGate = {
					iterations: done.length,
					counts,
					saved: verdict.saved,
					spent: verdict.spent,
					order: verdict.order,
					armed
				};
				if (!armed) {
					rw = undefined;
					report.readWindowRefused = 'the windows would not pay for the loop';
				}
			} else if (!rwTried && !rw) {
				const completed = outcomes.filter((o) => o.status === 0).length;
				if (hazards) {
					rwTried = true;
					report.readWindowRefused = 'the batch to learn from conflicted';
				} else if (completed >= 3) {
					rwTried = true;
					const found = learnReadWindows(outcomes);
					if (found.windows) {
						rw = found.windows;
						report.readWindows = { ...rw, batches: 0, learnedFrom: completed };
					} else report.readWindowRefused = found.reason;
				}
			}
			// a batch that conflicts is the price of learning that iterations share a scratch location.
			// Two single-iteration batches follow it; they race with nothing, so the granules both
			// wrote are the shared ones, and the loop goes on with a window over them
			if (stalled) probeLeft = 0;
			const probing = probeLeft > 0;
			let learning = false;
			const exhausted = outcomes.some((o) => o.status === 2);
			// at least half the iterations wrote some granule: a scratch location could be a window
			const shared =
				!tried && hazards && !stalled
					? discoverWindow(outcomes, Infinity).granules > 0
					: false;
			if (!tried && hazards && !shared && !stalled) {
				tried = true;
				report.windowRefused = 'no write granule is shared by half of the iterations';
			}
			// an exhausted log is grown first, the batch is dispatched again, and a window follows
			const area =
				!stalled && !grown && (!hazards || shared) && exhausted && v.first >= 0
					? this.#growLog()
					: undefined;
			// iterations that race on a shared location can run far past their log while the others of
			// the batch finish, and one that ran away says nothing about the capacity. So when some
			// iteration finished and there is no log to grow, the exhaustion is not the loop's
			// verdict: the window is probed first, and the stop stands only if there is none. If every
			// iteration ran past its log the loop needs more than the log holds, and the stop stands
			const fits = !exhausted || outcomes.some((o) => o.status === 0);
			if (shared && !area && fits) {
				tried = true;
				probeLeft = 2;
				learning = true;
			}
			if (area) {
				this.#rollback(logs, first, outcomes, v.first);
				this.#commitFrame(job, outcomes, v.first, ran);
				grown = true;
				logs = area;
				report.regions += v.first;
				report.retried += outcomes.length - v.first;
				report.logGrowths++;
				report.rollbackMs += performance.now() - t2;
				first += v.first;
				continue;
			}
			report.regions += outcomes.length;
			let replays = 0;
			if (v.first < 0) this.#commitFrame(job, outcomes, count, ran);
			else {
				replays = count - v.first;
				report.failedBatches++;
				if (v.firstFailure === v.first) report.fallbacks++;
				this.#rollback(logs, first, outcomes, v.first);
				report.rolledBack += outcomes.length - v.first;
				this.#commitFrame(job, outcomes, v.first, ran);
				const t3 = performance.now();
				report.rollbackMs += t3 - t2;
				try {
					for (let k = v.first; k < count; k++) {
						if (k < outcomes.length) report.replayed++;
						else report.serial++;
						job.replay(first + k);
					}
				} finally {
					report.replayMs += performance.now() - t3;
				}
			}
			const wallMs = performance.now() - t0;
			if (job.admit) {
				// the workers' own time per completed iteration, scaled to serial time
				estimate = refineEstimate(
					estimate,
					outcomes.filter((o) => o.status === 0).map((o) => o.runMs),
					Boolean(usedRw)
				);
			}
			const serialMs = count * perMs();
			if (report.admission && admissionSeam.trace) {
				const ran = outcomes.filter((o) => o.status === 0).map((o) => o.runMs);
				(report.admission.trace ??= []).push({
					first,
					count,
					windows: Boolean(usedRw),
					trackedMeanMs: ran.reduce((a, b) => a + b, 0) / (ran.length || 1),
					kappa: usedRw ? estimate.kappaWindows : estimate.kappa,
					estimateMs: estimate.estimateMs,
					wallMs,
					serialMs
				});
			}
			if (report.admission) {
				report.admission.batchWallMs = wallMs;
				report.admission.batchSerialMs = serialMs;
				report.admission.estimateMs = estimate.estimateMs;
			}
			// the first batch also pays for waking the workers, so a batch that is merely slow is not a
			// verdict until a second one confirms it
			const exempt = learning || probing || rwExempt;
			// a short batch that only learns pays for waking the workers and says nothing about the loop
			const timed = !exempt && !small && !short;
			// tracking cost bounds the speedup whatever the dispatch costs; read windows learned by
			// this batch will change that cost, so their first batch decides
			const windowsNext = Boolean(rw) && report.readWindows?.batches === 0;
			const tracked = outcomes.filter((o) => o.status === 0).map((o) => o.runMs);
			if (
				windowsNext &&
				job.admit &&
				job.hopeless &&
				job.unproven?.(batchBound(perMs(), tracked, this.width))
			)
				prove = true;
			let hopeless =
				!exempt &&
				!stalled &&
				!windowsNext &&
				Boolean(job.admit) &&
				job.hopeless?.(batchBound(perMs(), tracked, this.width)) === true;
			// the short batch on new read windows prices the next full one before it runs
			if (short && !hopeless && !exempt && !stalled && job.admit && job.loses) {
				const next = projectBatch(
					wallMs,
					tracked,
					perMs(),
					Math.min(logs.inFlight, job.trip - first - count),
					this.width
				);
				hopeless = next !== undefined && job.loses(next.wallMs, next.serialMs);
			}
			slow = timed && job.admit && job.loses?.(wallMs, serialMs) ? slow + 1 : 0;
			if (timed) lastTimed = { wallMs, count };
			const confirm = report.admission?.probe ? 1 : 2;
			const collapsed = timed && job.admit && job.collapses?.(wallMs, serialMs);
			const named: IterationStop | undefined = stalled
				? 'stalled'
				: outcomes.some((o) => o.status === 2)
					? 'log-exhausted'
					: v.frameFirst >= 0
						? 'frame-carried dependence'
						: replays * 2 > count
							? 'dependency'
							: (slow >= confirm || collapsed || hopeless) && first + count < job.trip
								? 'no-admission'
								: undefined;
			if (learning) pendingStop = named;
			let stop: IterationStop | undefined = stalled ? 'stalled' : exempt ? undefined : named;
			if (probing) {
				probes.push(...outcomes);
				if (--probeLeft === 0) {
					const found: { window?: IterationWindow; reason?: string } =
						probes.length === 2 && probes.every((o) => o.status === 0)
							? discoverWindow(probes, A.windowBytes)
							: { reason: 'a probe iteration did not complete' };
					const why = found.window
						? this.#refuseWindow(found.window, job.frameBase)
						: found.reason;
					if (why || !found.window) {
						report.windowRefused = why;
						stop = pendingStop;
					} else {
						window = found.window;
						report.window = { ...window, source: 'discovered', batches: 0 };
					}
				}
			}
			if (stop) {
				report.stopped ??= stop;
				if (stop === 'no-admission') costStop = true;
				if (stop === 'no-admission' && report.admission?.probe)
					report.admission.probeLost = true;
				stopped = true;
			}
			first += count;
		}
		if (probeLeft > 0 && pendingStop) report.stopped ??= pendingStop;
		if (job.admit && report.batches) this.#cold = costStop;
		return report;
	}

	// replays the rest of a refused loop in blocks of 1, 2, 4 up to a batch, timing each block. The
	// estimate is the lower of the last two blocks so one slow block is not a verdict; when
	// `reconsider` says the remaining iterations pay, dispatch starts there. Returns the index
	// reached and the estimate; the index is the trip count when nothing was dispatchable.
	#probe(
		job: IterationJob,
		report: IterationReport,
		plainMs: number
	): { at: number; estimate: number } {
		let block = 1;
		let last = plainMs;
		let estimate = plainMs;
		let k = 1;
		while (k < job.trip) {
			const size = job.reconsider ? Math.min(block, job.trip - k) : job.trip - k;
			const t = performance.now();
			for (let i = 0; i < size; i++) {
				report.serial++;
				job.replay(k + i);
			}
			const per = (performance.now() - t) / size;
			k += size;
			estimate = Math.min(last, per);
			last = per;
			block = Math.min(block * 2, this.arena.batch);
			if (report.admission) report.admission.estimateMs = estimate;
			if (k < job.trip && job.reconsider?.(estimate, job.trip - k))
				return { at: k, estimate };
		}
		return { at: k, estimate };
	}

	// pages above the arena for logs of `logCeiling` entries, one per iteration in flight. The undo
	// code writes them without marking, so no bitmap has to cover them and the program never names
	// them. Undefined when the ceiling is not above the default, the memory changed size under the
	// pool, or the memory cannot grow (its declared maximum). The pages stay for later calls.
	#growLog(): LogArea | undefined {
		if (this.#grown) return this.#grown;
		const A = this.arena;
		if (this.#ceiling <= A.logCapacity) return;
		if (this.#memory.buffer.byteLength !== this.#memoryBytes) return;
		const bytes = Math.ceil((this.#ceiling * iterationEntryBytes) / 64) * 64;
		const inFlight = Math.min(2 * this.width, A.batch);
		const pages = Math.ceil((inFlight * bytes) / PAGE);
		try {
			this.#memory.grow(pages);
		} catch (error) {
			if (error instanceof RangeError) return;
			throw error;
		}
		const base = this.#memoryBytes;
		this.#memoryBytes += pages * PAGE;
		this.#u8 = new Uint8Array(this.#memory.buffer);
		this.#u32 = new Uint32Array(this.#memory.buffer);
		return (this.#grown = { base, capacity: this.#ceiling, bytes, inFlight });
	}

	#dispatch(
		first: number,
		count: number,
		job: IterationJob,
		report: IterationReport,
		logs: LogArea,
		estimateMs: number,
		window?: IterationWindow,
		readWindows?: IterationReadWindows,
		variant = ''
	): IterationOutcome[] {
		this.#control[0] = 0;
		Atomics.store(this.#u32, this.arena.stamp / 4, 0);
		Atomics.store(this.#u32, this.arena.stamp / 4 + 1, 0);
		this.#stalled = false;
		const used = this.#links.slice(0, Math.min(this.width, count));
		const message = {
			first,
			count,
			entry: job.entry,
			frameBase: job.frameBase,
			reverse: job.schedule === 'reverse',
			logs,
			memoryBytes: this.#memoryBytes,
			window,
			readWindows,
			variant
		};
		for (const link of used) link.port.postMessage(message);
		const outcomes: IterationOutcome[] = [];
		let failure: string | undefined;
		const stall = this.#stall;
		// the wait covers the iterations one worker runs; the stop word gets the same time to take hold
		const limit = stall
			? stall.floorMs + stall.factor * Math.ceil(count / used.length) * estimateMs
			: Infinity;
		let deadline = stall ? performance.now() + limit : Infinity;
		for (const link of used) {
			let reply = this.#join(link, deadline);
			if (!reply && !this.#stalled) {
				this.#stalled = true;
				Atomics.store(this.#control, 0, 1 << 30);
				Atomics.store(this.#u32, this.arena.stamp / 4 + 1, 1);
				deadline = performance.now() + limit;
				reply = this.#join(link, deadline);
			}
			if (!reply) {
				// a worker that polls no stop word is past help, and memory may be changing under the owner
				this.#broken = `iteration worker did not stop within ${Math.round(limit)} ms of the stall word`;
				for (const l of this.#links) l.worker.terminate().catch(() => {});
				throw new Error(this.#broken);
			}
			if (reply.error !== undefined) failure ??= reply.error;
			else {
				outcomes.push(...reply.done!);
				report.workerRunMs += reply.runMs!;
				report.workerScanMs += reply.scanMs!;
				report.workerMarkMs += reply.markMs!;
				report.workerScanWords += reply.scanWords!;
				report.workerScanSet += reply.scanSet!;
			}
		}
		if (failure !== undefined) throw new Error(`iteration worker failed: ${failure}`);
		return outcomes.sort((a, b) => a.index - b.index);
	}

	// the written bytes of the first `kept` iterations of a batch, in order: frame bytes into the owner
	// frame, and window bytes into the window, so a later iteration's write wins as it does serially
	#commitFrame(
		job: IterationJob,
		outcomes: IterationOutcome[],
		kept: number,
		window?: IterationWindow
	): void {
		const A = this.arena;
		if (!A.frameBytes && !window) return;
		for (let k = 0; k < kept; k++) {
			const o = outcomes[k]!;
			const slot = o.index - outcomes[0]!.index;
			const top = A.slots + (slot + 1) * A.slotBytes;
			if (!window) {
				const frame = top - A.frameBytes;
				o.frameWritten.forEach((word, g) => {
					for (let b = 0; b < 32; b++)
						if ((word >>> b) & 1) {
							const at = 32 * g + b;
							this.#u8[job.frameBase + at] = this.#u8[frame + at]!;
						}
				});
				continue;
			}
			const w = iterationWindowCopy(top, A.frameBytes, window);
			const bytes = window.end - window.low;
			o.frameWritten.forEach((word, g) => {
				for (let b = 0; b < 32; b++)
					if ((word >>> b) & 1) {
						const at = 32 * g + b;
						if (at < bytes) this.#u8[window.low + at] = this.#u8[w.copy + at]!;
						else if (at >= w.frameOffset)
							this.#u8[job.frameBase + at - w.frameOffset] = this.#u8[w.copy + at]!;
					}
			});
		}
	}

	// why a window cannot be used for this call, or undefined when it can
	#refuseWindow(window: IterationWindow, frameBase: number): string | undefined {
		const A = this.arena;
		const bytes = window.end - window.low;
		if (!A.windowBytes) return 'the arena reserves no window bytes';
		if (!Number.isSafeInteger(window.low) || !Number.isSafeInteger(window.end) || bytes <= 0)
			return 'invalid window';
		if (window.low % 64 || window.end % 64) return 'the window is not 64-byte aligned';
		if (bytes > A.windowBytes) return `the window of ${bytes} bytes is over ${A.windowBytes}`;
		if (window.end > this.#memoryBytes) return 'the window passes the end of memory';
		const meets = (low: number, end: number) => window.low < end && window.end > low;
		if (meets(A.base, A.base + A.bytes)) return 'the window overlaps the arena';
		if (
			this.#grown &&
			meets(this.#grown.base, this.#grown.base + this.#grown.inFlight * this.#grown.bytes)
		)
			return 'the window overlaps the grown logs';
		if (A.frameBytes && meets(frameBase, frameBase + A.frameBytes))
			return 'the window overlaps the owner frame';
		if (A.slotBytes - A.frameBytes - bytes - 64 < windowStackBytes)
			return `the window leaves less than ${windowStackBytes} bytes of stack in a slot`;
	}

	// address ranges a read window must stay out of: the arena and the grown logs
	#forbidden(): [number, number][] {
		const A = this.arena;
		const found: [number, number][] = [[A.base, A.base + A.bytes]];
		if (this.#grown)
			found.push([
				this.#grown.base,
				this.#grown.base + this.#grown.inFlight * this.#grown.bytes
			]);
		return found;
	}

	// lowers the variant a batch needs once and hands it to every worker before their next batch;
	// the key is empty for the module the pool opened with
	#variant(window: boolean, order: 'window' | 'exempt' | undefined, count: boolean): string {
		const key = `${window ? 'w' : ''}${order ? (order === 'window' ? 'r' : 'x') : ''}${count ? 'c' : ''}`;
		if (!key || this.#variants.has(key)) return key;
		const lowered = lowerInline(this.#route.module!, {
			readGranule: iterationGranules.read,
			writeGranule: iterationGranules.write,
			frame: this.arena.frameBytes > 0,
			slot: true,
			window,
			stop: Boolean(this.#stall),
			readWindows: order ? 2 : 0,
			readCount: count,
			exemptFirst: order === 'exempt',
			readSummary: this.arena.ssize
		});
		const module = new WebAssembly.Module(Uint8Array.from(lowered));
		this.#variants.set(key, module);
		for (const link of this.#links) link.port.postMessage({ install: module, key });
		return key;
	}

	// newest stamp first across every iteration being rolled back
	#rollback(logs: LogArea, first: number, outcomes: IterationOutcome[], from: number): void {
		const entries: { stamp: number; address: number; data: number }[] = [];
		for (let k = from; k < outcomes.length; k++) {
			const o = outcomes[k]!;
			const base = logs.base + (o.index - first) * logs.bytes;
			for (let e = 0; e < o.entries; e++) {
				const at = base + e * iterationEntryBytes;
				entries.push({
					address: this.#u32[at / 4]!,
					stamp: this.#u32[at / 4 + 1]!,
					data: at + 8
				});
			}
		}
		entries.sort((a, b) => b.stamp - a.stamp);
		for (const e of entries)
			this.#u8.copyWithin(e.address, e.data, e.data + iterationGranules.write);
	}

	/** Stops the workers. Safe to call twice. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.all(this.#links.map((link) => link.worker.terminate()));
		for (const link of this.#links) link.port.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}
