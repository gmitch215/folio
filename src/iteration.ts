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
import type { IterationAdmission } from './iteration-admission.ts';
import {
	type IterationArena,
	type IterationArenaOptions,
	iterationArena,
	iterationArguments,
	iterationEntryBytes,
	iterationGranules
} from './iteration-layout.ts';

export {
	iterationArena,
	iterationArenaBytes,
	iterationArguments,
	iterationEntryBytes,
	iterationFit,
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
	skip?: readonly ('raw' | 'war' | 'waw')[];
	/**
	 * Probe for a loop-carried dependence through the owner frame. Iteration 0 runs once on the
	 * calling thread with the frame image poisoned and its writes are recorded and undone. After the
	 * first batch validates with iteration 0 intact, a difference in the granules or bytes iteration
	 * 0 wrote outside its slot rolls the batch back and replays the whole loop. It catches a first
	 * iteration that reads a frame byte it did not write. It does not catch a read that only
	 * happens on a later iteration, a read of stale callee stack below the frame, or a read whose
	 * value does not change what iteration 0 writes. When iteration 0 itself replays, the probe
	 * cannot be checked and the rest of the loop replays serially.
	 */
	probe?: boolean;
	/**
	 * Called once after the probe with the tracked time of iteration 0, before anything is
	 * dispatched. A refusal returns a report with no iterations run; the probe is already undone.
	 * Not called without `probe`.
	 */
	admit?: (firstIterationMs: number) => IterationAdmission;
}

/** What a run did. `regions`, `replayed`, `fallbacks` and `workers` parallel `ExecutionReport`. */
export interface IterationReport {
	/** Workers that took part. */
	workers: number;
	/** Iterations run on workers, the regions of this mode. */
	regions: number;
	/** Iterations rerun serially at the owner. */
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
	conflicts: { raw: number; war: number; waw: number };
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
	 * `clear` the probe matched, `carried` it differed, `skipped` iteration 0 replayed, `off` no
	 * probe or admission refused the loop after it.
	 */
	probe: 'off' | 'clear' | 'carried' | 'skipped';
	/** Time of the probe run on the calling thread. */
	probeMs: number;
	/** What the admission callback saw and chose; set when the job had one and the probe ran. */
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
	conflicts: { raw: 0, war: 0, waw: 0 },
	dispatchMs: 0,
	validationMs: 0,
	rollbackMs: 0,
	replayMs: 0,
	workerRunMs: 0,
	workerScanMs: 0,
	probe: 'off',
	probeMs: 0
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
 * writer. Works on the returned lists, never on dense bitmaps.
 */
export function iterationVerdict(
	outcomes: readonly Pick<IterationOutcome, 'status' | 'written' | 'reads'>[],
	skip: readonly ('raw' | 'war' | 'waw')[] = []
): {
	first: number;
	firstFailure: number;
	conflicts: { raw: number; war: number; waw: number };
} {
	const conflicts = { raw: 0, war: 0, waw: 0 };
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
	const none = outcomes.length;
	return {
		first: first === none ? -1 : first,
		firstFailure: firstFailure === none ? -1 : firstFailure,
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
 * The arena belongs to the pool until `close`. The frame image is copied at the start of each
 * iteration, so a body that reads a frame byte an earlier iteration wrote is not detected by
 * validation; `IterationJob.probe` covers the first iteration only.
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
	#module?: WebAssembly.Module;
	#route?: IterationRoute;
	#probing?: WebAssembly.Instance;
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
		const arena = iterationArena(options.arenaBase, memoryBytes, options);
		if (arena.base + arena.bytes > arena.memoryBytes)
			throw new RangeError('arena does not fit in memory');
		const frameSize = route.frame?.size ?? 0;
		if (frameSize >= arena.slotBytes) throw new RangeError('slot is smaller than the frame');
		const lowered = lowerInline(route.module, {
			readGranule: iterationGranules.read,
			writeGranule: iterationGranules.write
		});
		const module = new WebAssembly.Module(Uint8Array.from(lowered));
		const pool = new IterationPool(memory, arena, width);
		pool.#module = module;
		pool.#route = route;
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
		let probe: ReturnType<IterationPool['probe']> | undefined;
		if (job.probe && job.trip > 0) {
			const t = performance.now();
			probe = this.probe(job);
			report.probeMs = performance.now() - t;
			report.probe = 'clear';
			if (job.admit) {
				report.admission = job.admit(probe.iterationMs);
				if (!report.admission.admitted) {
					report.probe = 'off';
					return report;
				}
			}
		}
		let serial = false;
		for (let first = 0; first < job.trip; first += A.batch) {
			const count = Math.min(A.batch, job.trip - first);
			if (serial) {
				const t = performance.now();
				try {
					for (let k = 0; k < count; k++) {
						report.replayed++;
						job.replay(first + k);
					}
				} finally {
					report.replayMs += performance.now() - t;
				}
				continue;
			}
			report.batches++;
			report.regions += count;
			const t0 = performance.now();
			const outcomes = this.#dispatch(first, count, job, report);
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
			const t2 = performance.now();
			report.validationMs += t2 - t1;
			if (probe && first === 0) {
				if (v.first === 0) {
					report.probe = 'skipped';
					serial = true;
				} else if (probe.status !== 0 || this.#differs(probe, outcomes[0]!)) {
					report.probe = 'carried';
					report.failedBatches++;
					report.fallbacks++;
					this.#rollback(first, outcomes, 0);
					report.rolledBack += count;
					const t3 = performance.now();
					report.rollbackMs += t3 - t2;
					try {
						for (let k = 0; k < job.trip; k++) {
							report.replayed++;
							job.replay(k);
						}
					} finally {
						report.replayMs += performance.now() - t3;
					}
					return report;
				}
			}
			if (v.first < 0) continue;
			report.failedBatches++;
			if (v.firstFailure === v.first) report.fallbacks++;
			this.#rollback(first, outcomes, v.first);
			report.rolledBack += count - v.first;
			const t3 = performance.now();
			report.rollbackMs += t3 - t2;
			try {
				for (let k = v.first; k < count; k++) {
					report.replayed++;
					job.replay(first + k);
				}
			} finally {
				report.replayMs += performance.now() - t3;
			}
		}
		return report;
	}

	/**
	 * Runs iteration 0 on slot 0 of the calling thread with the frame image poisoned, records the
	 * granules it wrote outside the slot with their final bytes, and undoes every write.
	 */
	probe(job: Pick<IterationJob, 'entry' | 'frameBase'>) {
		const A = this.arena;
		const route = this.#route!;
		const frameSize = route.frame?.size ?? 0;
		const exportsOf = (this.#probing ??= new WebAssembly.Instance(this.#module!, {
			env: { memory: this.#memory }
		})).exports as any;
		const top = A.slots + A.slotBytes;
		const frame = top - frameSize;
		if (frameSize) this.#u8.fill(0xa5, frame, top);
		const rbase = A.rmaps;
		const wbase = A.wmaps;
		const lbase = A.logs;
		const limit = lbase + A.logCapacity * iterationEntryBytes;
		exportsOf[inlineGlobals.readBitmap].value = rbase;
		exportsOf[inlineGlobals.writeBitmap].value = wbase;
		exportsOf[inlineGlobals.logPointer].value = lbase;
		exportsOf[inlineGlobals.logLimit].value = limit;
		exportsOf[inlineGlobals.stampAddress].value = A.stamp;
		Atomics.store(this.#u32, A.stamp / 4, 0);
		const stack = exportsOf[inlineGlobals.stackPointer];
		if (stack) stack.value = frameSize ? frame : top;
		let status = 0;
		const began = performance.now();
		try {
			exportsOf[route.iterate!](...iterationArguments(route.locals, job.entry, 0, frame));
		} catch {
			status = 1;
		}
		const iterationMs = performance.now() - began;
		const entries =
			((exportsOf[inlineGlobals.logPointer].value >>> 0) - lbase) / iterationEntryBytes;
		const logged: { address: number; stamp: number; data: number }[] = [];
		for (let e = 0; e < entries; e++) {
			const at = lbase + e * iterationEntryBytes;
			logged.push({
				address: this.#u32[at / 4]!,
				stamp: this.#u32[at / 4 + 1]!,
				data: at + 8
			});
		}
		const outside = logged
			.filter((e) => e.address < A.slots || e.address >= top)
			.sort((a, b) => a.address - b.address);
		const bytes = new Uint8Array(outside.length * iterationGranules.write);
		outside.forEach((e, i) =>
			bytes.set(
				this.#u8.subarray(e.address, e.address + iterationGranules.write),
				i * iterationGranules.write
			)
		);
		logged.sort((a, b) => b.stamp - a.stamp);
		for (const e of logged)
			this.#u8.copyWithin(e.address, e.data, e.data + iterationGranules.write);
		this.#u8.fill(0, rbase, rbase + A.rsize);
		this.#u8.fill(0, wbase, wbase + A.wsize);
		return {
			status,
			iterationMs,
			granules: Int32Array.from(outside, (e) => e.address >>> 5),
			bytes
		};
	}

	// does iteration 0 of the batch differ from the probe in what it wrote outside its slot
	#differs(
		probe: { granules: Int32Array; bytes: Uint8Array },
		outcome: IterationOutcome
	): boolean {
		const A = this.arena;
		const g = iterationGranules.write;
		const written = outcome.written.filter(
			(v) => v * g < A.slots || v * g >= A.slots + A.slotBytes
		);
		if (written.length !== probe.granules.length) return true;
		for (let i = 0; i < written.length; i++) {
			if (written[i] !== probe.granules[i]) return true;
			const at = written[i]! * g;
			for (let b = 0; b < g; b++)
				if (this.#u8[at + b] !== probe.bytes[i * g + b]) return true;
		}
		return false;
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
