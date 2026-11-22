/** Why the rest of a loop ran serially after the pooled path was tried or refused. */
export type IterationStop =
	'no-admission' | 'log-exhausted' | 'frame-carried dependence' | 'dependency' | 'stalled';

/** What the admission decision saw and chose for one owner call's loop. */
export interface IterationAdmission {
	/** Time of iteration 0 on the owner thread, on a plain instance and the real frame. */
	plainIterationMs: number;
	/** Serial time of the iterations after iteration 0, from `plainIterationMs`. */
	remainingSerialMs: number;
	/** The least remaining serial time worth dispatching: `fixedMs * margin`. */
	floorMs: number;
	/** The decision before the first dispatch. A later stop is `IterationReport.stopped`. */
	admitted: boolean;
	/** Wall of the last batch, dispatch to the end of its replays. */
	batchWallMs?: number;
	/** The serial time of the iterations of that batch, from the online estimate. */
	batchSerialMs?: number;
	/** The latest estimate of serial time per iteration, from iteration 0, replays or workers. */
	estimateMs?: number;
	/** Set when a refused loop was admitted after timed serial iterations; the iteration index. */
	readmittedAt?: number;
	/** Admitted as a probe: under the floor, over `probeFraction` of it, one timed batch decides. */
	probe?: boolean;
	/** The probe batch did not beat the serial time of its iterations, and the dispatch ended. */
	probeLost?: boolean;
	/** One entry per batch, only under `admissionSeam.trace`. */
	trace?: AdmissionStep[];
}

/** What the estimate and the batch rule saw after one batch. @internal */
export interface AdmissionStep {
	first: number;
	count: number;
	windows: boolean;
	trackedMeanMs: number;
	kappa?: number;
	estimateMs: number;
	wallMs: number;
	serialMs: number;
}

/** Why the iteration route is not used, in `ExecutionReport.reason`. */
export type IterationReason =
	| 'no-arena'
	| 'memory-size-observed'
	| 'import-order'
	| 'workers-unavailable'
	| 'trip-zero'
	| 'no-admission'
	| 'log-exhausted'
	| 'frame-carried dependence'
	| 'stalled';

/**
 * The read windows of one loop. The strided window moves with the iteration index: iteration `k`
 * reads from the granule boundary at or below `low + (k - index) * stride`. The fixed window is the
 * same range in every iteration. Neither has to be right for a run to be correct: a load outside
 * the window is tracked as usual, and a window only costs a false conflict when another iteration
 * writes inside it.
 */
export interface IterationReadWindows {
	strided?: { index: number; low: number; stride: number; bytes: number };
	fixed?: IterationReadWindow;
}

/**
 * Loads of at most 8 bytes of one run on the module with read windows, by where they landed:
 * inside a window, tracked outside every window, or exempt (the slot's own callee stack).
 */
export interface ReadWindowCounts {
	hits: number;
	misses: number;
	exempt: number;
}

/** A byte range an iteration reads without per-access marks. */
export interface IterationReadWindow {
	low: number;
	bytes: number;
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

/** Timing and size evidence for one joined task. Timestamps are epoch milliseconds. */
export interface TaskRecord {
	id: string;
	worker: number;
	name: string;
	submitMs: number;
	startMs: number;
	endMs: number;
	waitMs: number;
	cpuMs?: number;
	inputBytes: number;
	outputBytes: number;
}

/** What a run did: results, how it was routed and what the speculation cost. */
export interface ExecutionReport {
	/** Return values of the call, or of each call in a batch. */
	values: unknown[];
	/** Workers that executed regions; zero for a serial run. */
	workers: number;
	/** Regions discovered and dispatched. */
	regions: number;
	/** Regions that conflicted and replayed against committed state. */
	replayed: number;
	/** Regions or batches that fell back to native execution at the owner. */
	fallbacks: number;
	/** `native-shared` ran proved kernels on the shared allocation without tracking. */
	mode: 'serial' | 'speculative' | 'native-shared';
	/** Set when the control-flow extractor or the iteration route produced the regions. */
	extraction?: 'control-flow' | 'iteration';
	/** `shared` regions read the physical allocation; `snapshot` ran on a copied arena. */
	memoryMode?: 'shared' | 'snapshot';
	/** Bytes copied into the worker group for snapshot execution. */
	snapshotBytes?: number;
	/** Why a run stayed serial or left the fast path. */
	reason?:
		| 'requested'
		| 'small-workload'
		| 'no-parallel-plan'
		| 'single-region'
		| 'unsupported-module'
		| 'dependency'
		| 'guard-failed'
		| 'snapshot-unavailable'
		| 'previous-conflicts'
		| 'opaque-input'
		| IterationReason;

	/** The iteration executor's counts, summed over the owner calls of the run. */
	iteration?: IterationReport;

	/** Present when `FolioOptions.profile` is set. */
	profile?: ExecutionProfile;
}

/** Opt-in timings. Process CPU is measured once at the coordinator, not summed from these. */
export interface ExecutionProfile {
	/** Elapsed time of the whole run. */
	wallMs: number;
	/** Elapsed time of each region or batch observation on its worker. */
	workerWallMs: number[];
	/** Thread CPU time of each observation. */
	workerCpuMs: number[];
	/** Ordered dependency validation. */
	validationMs: number;
	/** Committing validated writes to canonical memory. */
	commitMs: number;
	/** Re-executing conflicted regions. */
	replayMs: number;
	/** Bytes tracked as read by speculative regions. */
	readBytes: number;
	/** Bytes tracked as written by speculative regions. */
	writeBytes: number;
}
