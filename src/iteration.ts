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
import type { IterationAdmission, IterationStop } from './iteration-admission.ts';
import {
	type IterationArena,
	type IterationArenaOptions,
	iterationArena,
	iterationEntryBytes,
	iterationGranules
} from './iteration-layout.ts';

export {
	iterationArena,
	iterationArenaBytes,
	iterationArguments,
	iterationEntryBytes,
	iterationFit,
	iterationFrameShadow,
	iterationGranules
} from './iteration-layout.ts';
export type { IterationArena, IterationArenaOptions } from './iteration-layout.ts';

/** Pool construction options. */
export interface IterationPoolOptions extends IterationArenaOptions {
	/** Start of the arena, 64-byte aligned, in memory the caller keeps free while the pool is open. */
	arenaBase: number;
	/** Workers; defaults to up to four. */
	width?: number;
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
	batches: number;
	failedBatches: number;
	undoEntries: number;
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
	/**
	 * Iterations the owner ran as the serial program without dispatching them: iteration 0, the
	 * rest of a loop after a stop, or all of them when admission refused the loop.
	 */
	serial: number;
	/** What ended the dispatch early, or why admission refused the loop. */
	stopped?: IterationStop;
	/** What the admission callback saw and chose; set when the job had one. */
	admission?: IterationAdmission;
}

/** What a worker returns for one iteration. */
export interface IterationOutcome {
	index: number;
	/** 0 ran, 1 trapped, 2 undo log exhausted */
	status: number;
	entries: number;
	/** sorted write granules (32 bytes) from the undo log */
	written: Int32Array;
	/** [start, length] runs of read granules (64 bytes) */
	reads: Int32Array;
	/** written bit per frame byte, one i32 per 32-byte frame granule; empty when nothing was written */
	frameWritten: Uint32Array;
	/** bit per frame byte the iteration read before writing it, same layout; empty when none */
	frameExposed: Uint32Array;
}

const newReport = (workers: number): IterationReport => ({
	workers,
	regions: 0,
	replayed: 0,
	rolledBack: 0,
	fallbacks: 0,
	traps: 0,
	exhausted: 0,
	batches: 0,
	failedBatches: 0,
	undoEntries: 0,
	conflicts: { raw: 0, war: 0, waw: 0, frame: 0 },
	dispatchMs: 0,
	validationMs: 0,
	rollbackMs: 0,
	replayMs: 0,
	workerRunMs: 0,
	workerScanMs: 0,
	serial: 0
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

/**
 * Index of the first outcome that cannot keep its writes, or -1. Writes land in place, so every
 * ordered pair is checked three ways: RAW marks the reader, WAR the earlier reader, WAW the earlier
 * writer. A fourth check covers the frame, which each iteration owns as a private copy: an
 * iteration fails when it read a frame byte before writing it that an earlier iteration wrote, and
 * counts once. Works on the returned lists, never on dense bitmaps.
 */
export function iterationVerdict(
	outcomes: readonly (Pick<IterationOutcome, 'status' | 'written' | 'reads'> &
		Partial<Pick<IterationOutcome, 'frameWritten' | 'frameExposed'>>)[],
	skip: readonly ('raw' | 'war' | 'waw' | 'frame')[] = []
): {
	first: number;
	firstFailure: number;
	frameFirst: number;
	conflicts: { raw: number; war: number; waw: number; frame: number };
} {
	const conflicts = { raw: 0, war: 0, waw: 0, frame: 0 };
	let frameFirst = outcomes.length;
	let firstFailure = outcomes.length;
	outcomes.forEach((o, k) => {
		if (o.status) firstFailure = Math.min(firstFailure, k);
	});
	let first = firstFailure;
	for (let j = 0; j < outcomes.length; j++) {
		for (let k = j + 1; k < outcomes.length; k++) {
			const a = outcomes[j]!;
			const b = outcomes[k]!;
			if (!skip.includes('raw') && hitsReads(a.written, b.reads)) {
				conflicts.raw++;
				first = Math.min(first, k);
			}
			if (!skip.includes('war') && hitsReads(b.written, a.reads)) {
				conflicts.war++;
				first = Math.min(first, j);
			}
			if (!skip.includes('waw') && hitsWrites(a.written, b.written)) {
				conflicts.waw++;
				first = Math.min(first, j);
			}
		}
	}
	if (!skip.includes('frame')) {
		// the frame bytes written by the iterations before k, against the bytes k read unwritten
		let union: Uint32Array | undefined;
		outcomes.forEach((o, k) => {
			const exposed = o.frameExposed;
			if (union && exposed?.length && exposed.some((word, w) => word & (union![w] ?? 0))) {
				conflicts.frame++;
				first = Math.min(first, k);
				frameFirst = Math.min(frameFirst, k);
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
		conflicts
	};
}

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
	readonly #u8: Uint8Array;
	readonly #u32: Uint32Array;
	#closed = false;

	private constructor(memory: WebAssembly.Memory, arena: IterationArena, width: number) {
		this.#memory = memory;
		this.arena = arena;
		this.width = width;
		this.#report = newReport(0);
		this.#u8 = new Uint8Array(memory.buffer);
		this.#u32 = new Uint32Array(memory.buffer);
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
			frame: frameSize > 0
		});
		const module = new WebAssembly.Module(Uint8Array.from(lowered));
		const pool = new IterationPool(memory, arena, width);
		pool.#u8.fill(0, arena.stamp, arena.stamp + 64);
		pool.#u8.fill(0, arena.rmaps, arena.wmaps + arena.batch * arena.wsize);
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

	// blocks the owner thread until the worker replies, the idiom of TaskPool.join
	#join(link: Link): {
		done?: IterationOutcome[];
		runMs?: number;
		scanMs?: number;
		error?: string;
	} {
		for (;;) {
			const seen = Atomics.load(link.signal, 0);
			const message = receiveMessageOnPort(link.port);
			if (message) return message.message;
			Atomics.wait(link.signal, 0, seen);
		}
	}

	/** Runs the loop to completion with ordered validation. Blocks the calling thread. */
	run(job: IterationJob): IterationReport {
		if (this.#closed) throw new Error('iteration pool is closed');
		if (this.#memory.buffer.byteLength !== this.arena.memoryBytes)
			throw new Error('memory changed size while the iteration pool was open');
		if (!Number.isSafeInteger(job.trip) || job.trip < 0)
			throw new RangeError('invalid trip count');
		const A = this.arena;
		const report = (this.#report = newReport(Math.min(this.width, Math.max(job.trip, 0))));
		let plainMs = 0;
		let from = 0;
		if (job.admit && job.trip > 0) {
			// iteration 0 is the serial program's own first iteration, so its writes stay
			const t = performance.now();
			report.serial = 1;
			job.replay(0);
			plainMs = performance.now() - t;
			from = 1;
			report.admission = job.admit(plainMs);
			if (!report.admission.admitted) {
				report.stopped = 'no-admission';
				for (let k = 1; k < job.trip; k++) {
					report.serial++;
					job.replay(k);
				}
				return report;
			}
		}
		let stopped = false;
		let slow = 0;
		for (let first = from; first < job.trip; first += A.batch) {
			const count = Math.min(A.batch, job.trip - first);
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
				continue;
			}
			report.batches++;
			const t0 = performance.now();
			const outcomes = this.#dispatch(first, count, job, report);
			report.regions += outcomes.length;
			const t1 = performance.now();
			report.dispatchMs += t1 - t0;
			for (const o of outcomes) {
				report.undoEntries += o.entries;
				if (o.status === 1) report.traps++;
				if (o.status === 2) report.exhausted++;
			}
			const v = iterationVerdict(outcomes, job.skip);
			report.conflicts.raw += v.conflicts.raw;
			report.conflicts.war += v.conflicts.war;
			report.conflicts.waw += v.conflicts.waw;
			report.conflicts.frame += v.conflicts.frame;
			const t2 = performance.now();
			report.validationMs += t2 - t1;
			let replays = 0;
			if (v.first < 0) this.#commitFrame(job, outcomes, count);
			else {
				replays = count - v.first;
				report.failedBatches++;
				if (v.firstFailure === v.first) report.fallbacks++;
				this.#rollback(first, outcomes, v.first);
				report.rolledBack += outcomes.length - v.first;
				this.#commitFrame(job, outcomes, v.first);
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
			const serialMs = count * plainMs;
			if (report.admission) {
				report.admission.batchWallMs = wallMs;
				report.admission.batchSerialMs = serialMs;
			}
			// the first batch also pays for waking the workers, so a batch that is merely slow is not a
			// verdict until a second one confirms it
			slow = job.admit && job.loses?.(wallMs, serialMs) ? slow + 1 : 0;
			const collapsed = job.admit && job.collapses?.(wallMs, serialMs);
			const stop = outcomes.some((o) => o.status === 2)
				? 'log-exhausted'
				: v.frameFirst >= 0
					? 'frame-carried dependence'
					: replays * 2 > count
						? 'dependency'
						: (slow >= 2 || collapsed) && first + count < job.trip
							? 'no-admission'
							: undefined;
			if (stop) {
				report.stopped ??= stop;
				stopped = true;
			}
		}
		return report;
	}

	#dispatch(
		first: number,
		count: number,
		job: IterationJob,
		report: IterationReport
	): IterationOutcome[] {
		this.#control[0] = 0;
		Atomics.store(this.#u32, this.arena.stamp / 4, 0);
		const used = this.#links.slice(0, Math.min(this.width, count));
		const message = {
			first,
			count,
			entry: job.entry,
			frameBase: job.frameBase,
			reverse: job.schedule === 'reverse'
		};
		for (const link of used) link.port.postMessage(message);
		const outcomes: IterationOutcome[] = [];
		let failure: string | undefined;
		for (const link of used) {
			const reply = this.#join(link);
			if (reply.error !== undefined) failure ??= reply.error;
			else {
				outcomes.push(...reply.done!);
				report.workerRunMs += reply.runMs!;
				report.workerScanMs += reply.scanMs!;
			}
		}
		if (failure !== undefined) throw new Error(`iteration worker failed: ${failure}`);
		return outcomes.sort((a, b) => a.index - b.index);
	}

	// the written frame bytes of the first `kept` iterations of a batch, in order, into the owner frame
	#commitFrame(job: IterationJob, outcomes: IterationOutcome[], kept: number): void {
		const A = this.arena;
		if (!A.frameBytes) return;
		for (let k = 0; k < kept; k++) {
			const o = outcomes[k]!;
			const slot = o.index - outcomes[0]!.index;
			const frame = A.slots + (slot + 1) * A.slotBytes - A.frameBytes;
			o.frameWritten.forEach((word, g) => {
				for (let b = 0; b < 32; b++)
					if ((word >>> b) & 1) {
						const at = 32 * g + b;
						this.#u8[job.frameBase + at] = this.#u8[frame + at]!;
					}
			});
		}
	}

	// newest stamp first across every iteration being rolled back
	#rollback(first: number, outcomes: IterationOutcome[], from: number): void {
		const A = this.arena;
		const entries: { stamp: number; address: number; data: number }[] = [];
		for (let k = from; k < outcomes.length; k++) {
			const o = outcomes[k]!;
			const base = A.logs + (o.index - first) * A.logBytes;
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
