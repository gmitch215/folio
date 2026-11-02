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

/** The constants of the decision. A re-calibration changes these and nothing else. */
export interface IterationAdmissionConstants {
	/** Wall of the pooled path that does not shrink with the loop: dispatch, join, validation. */
	fixedMs: number;
	/** The pooled path has to beat the serial one by this factor, before and after each batch. */
	margin: number;
}

/**
 * Fitted on a Mac sweep of `scripts/research/iteration-admission.ts` and checked on the rig at widths
 * 8 and 4; a re-calibration updates only these two numbers.
 *
 * `fixedMs` 2 is the smallest value at which no cell of the Mac sweep (18 cells, 4 KiB to 4 MiB
 * by 8 to 128 iterations, width 8) dispatched and lost. The pooled wall minus the batch time
 * measured 0.1 to 2.9 ms there with the input copy left out of the timing; the prototype's rows
 * bracket 3 to 8 ms but include that copy. The loop is not worth dispatching when the serial time
 * of its remaining iterations is below `fixedMs * margin`.
 *
 * `margin` 1.25 is the speedup a batch has to show over the serial time of its iterations for
 * the loop to keep dispatching. A batch that misses it twice in a row ends the dispatch, and so
 * does one batch whose wall passes `batchCollapse` times that serial time.
 */
export const iterationAdmissionConstants: IterationAdmissionConstants = {
	fixedMs: 2,
	margin: 1.25
};

/**
 * With the second chance on, a loop whose remaining serial time is under the floor but over this
 * fraction of it is admitted as a probe: its first timed batch has to beat the serial time of its
 * iterations by the margin, or the dispatch ends there. The floor was fitted on a build with the
 * full read scan and no read windows, so it is the least certain number in the decision.
 */
export const probeFraction = 0.5;

export interface AdmitInput {
	plainIterationMs: number;
	trip: number;
	width: number;
	constants?: IterationAdmissionConstants;
	secondChance?: boolean;
}

/**
 * Decides before the first dispatch from the measured serial time of iteration 0, which has
 * already run. Admits when at least two iterations are left for at least two workers and their
 * serial time exceeds `fixedMs * margin`. Whether dispatch pays is then checked per batch.
 */
export function admitIteration({
	plainIterationMs: t0,
	trip,
	width,
	constants = iterationAdmissionConstants,
	secondChance = false
}: AdmitInput): IterationAdmission {
	const remaining = trip - 1;
	const remainingSerialMs = remaining * t0;
	const floorMs = constants.fixedMs * constants.margin;
	const able = Number.isFinite(t0) && remaining >= 2 && width >= 2;
	const admitted = able && remainingSerialMs > floorMs;
	if (secondChance && able && !admitted && remainingSerialMs > floorMs * probeFraction)
		return { plainIterationMs: t0, remainingSerialMs, floorMs, admitted: true, probe: true };
	return { plainIterationMs: t0, remainingSerialMs, floorMs, admitted };
}

/** True when a batch did not beat the serial time of its iterations by the margin. */
export function batchLoses(
	batchWallMs: number,
	batchSerialMs: number,
	constants: IterationAdmissionConstants = iterationAdmissionConstants
): boolean {
	return batchWallMs * constants.margin > batchSerialMs;
}

/** Batch wall over serial time past which one batch is a verdict, with no second batch to confirm. */
export const batchCollapse = 1.5;

/** True when a batch took clearly longer than the serial time of its iterations. */
export function batchCollapses(batchWallMs: number, batchSerialMs: number): boolean {
	return batchWallMs > batchSerialMs * batchCollapse;
}

/**
 * Test and sweep seam, module state and not an option. `scale` multiplies the measured time of
 * iteration 0 before the first decision and `batchScale` the wall of each batch before the batch
 * rule, and divides the bound of a batch; `force` admits any loop with an iteration left after
 * iteration 0 and never stops on the batch rule or the bound. The structural stops
 * (`log-exhausted`, `frame-carried dependence`, `dependency`) are not affected. `trace` records
 * one entry per batch in the admission report. `gate` false keeps read windows armed whatever the
 * counted batch says, so a sweep can compare the two.
 * @internal
 */
export const admissionSeam = {
	scale: 1,
	batchScale: 1,
	force: false,
	trace: false,
	gate: true,
	estimator: 'median' as 'min' | 'median' | 'mean' | 'q75'
};

/**
 * The serial estimate the probe holds after a block: the lower of the last two block means, the
 * median of every block mean so far, or the mean of every probed iteration.
 * @internal
 */
export function probeEstimate(
	kind: 'min' | 'median' | 'mean' | 'q75',
	last: number,
	per: number,
	means: number[],
	mean: number
): number {
	if (kind === 'mean') return mean;
	if (kind === 'min') return Math.min(last, per);
	const sorted = [...means].sort((x, y) => x - y);
	if (kind === 'q75')
		return sorted[Math.min(sorted.length - 1, Math.ceil(0.75 * sorted.length) - 1)]!;
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** `admitIteration` through the seam; what the host function calls. */
export function decideAdmission(
	plainIterationMs: number,
	trip: number,
	width: number,
	secondChance = false
) {
	const decision = admitIteration({
		plainIterationMs: plainIterationMs * admissionSeam.scale,
		trip,
		width,
		secondChance
	});
	if (admissionSeam.force && trip >= 2 && width >= 2) decision.admitted = true;
	return decision;
}

/** The serial time per iteration as far as the run knows it, and the scale from tracked time. */
export interface IterationEstimate {
	/** Serial milliseconds per iteration. */
	estimateMs: number;
	/** Serial time over tracked time, fixed by the first batch; undefined before it. */
	kappa?: number;
	/** The same scale for batches that run on read windows; fixed by the first of them. */
	kappaWindows?: number;
	/** The serial time both scales are fitted to: the estimate before the first batch. */
	referenceMs?: number;
}

/**
 * Updates the estimate from the worker-side times of the iterations a batch completed, with no
 * host call per iteration. The first batch fixes `kappa` as the serial estimate over the least
 * tracked time, at most 1 because a tracked iteration is never faster than a plain one. The least
 * time, not the median, because the iteration that the estimate came from may be the smallest of
 * a batch that is mostly large, and the median would then read its size as the tracking cost. The
 * estimate is then the mean tracked time times `kappa`: a batch of iterations dearer than the
 * earlier estimate raises it, and a batch of cheaper ones lowers it. When the first iteration was
 * larger than every iteration of the batch, `kappa` is capped and the estimate is the tracked
 * mean, an upper bound on the serial time. Times of zero or less are ignored. A batch on read
 * windows is cheaper to track than the first, so it has its own scale, fitted the same way to the
 * same reference the first time one runs; the unwindowed scale would read its time as serial time.
 */
export function refineEstimate(
	before: IterationEstimate,
	trackedMs: readonly number[],
	windows = false
): IterationEstimate {
	const ran = trackedMs.filter((ms) => ms > 0);
	if (!ran.length) return before;
	const referenceMs = before.referenceMs ?? before.estimateMs;
	const learned = windows ? before.kappaWindows : before.kappa;
	const kappa = learned ?? Math.min(1, referenceMs / Math.min(...ran));
	return {
		kappa: windows ? before.kappa : kappa,
		kappaWindows: windows ? kappa : before.kappaWindows,
		referenceMs,
		estimateMs: (kappa * ran.reduce((sum, ms) => sum + ms, 0)) / ran.length
	};
}

/**
 * Whether `remaining` more iterations at `perIterationMs` each are worth dispatching, through the
 * seam. The pool asks it with the online estimate before each batch after the first and after the
 * timed serial blocks of a refused loop.
 *
 * With `last`, the wall and size of the last timed batch, a loop under the floor still goes on
 * when the batches it has seen say so: the pooled cost of what is left is the batch wall times the
 * batches that cover it, and that times the margin has to be under their serial time. The floor
 * prices the wake-up and the learning batch, which a loop that is running has already paid.
 */
export function decideRemaining(
	perIterationMs: number,
	remaining: number,
	width: number,
	last?: { wallMs: number; count: number }
) {
	if (decideAdmission(perIterationMs, remaining + 1, width).admitted) return true;
	if (!last || remaining < 2 || width < 2 || !(last.count > 0)) return false;
	const pooled = Math.ceil(remaining / last.count) * last.wallMs * admissionSeam.batchScale;
	return remaining * perIterationMs > pooled * iterationAdmissionConstants.margin;
}

/** `batchLoses` through the seam; what the host function passes the pool. */
export function decideBatch(batchWallMs: number, batchSerialMs: number): boolean {
	if (admissionSeam.force) return false;
	return batchLoses(batchWallMs * admissionSeam.batchScale, batchSerialMs);
}

/** `batchCollapses` through the seam; what the host function passes the pool. */
export function decideCollapse(batchWallMs: number, batchSerialMs: number): boolean {
	if (admissionSeam.force) return false;
	return batchCollapses(batchWallMs * admissionSeam.batchScale, batchSerialMs);
}

/** Speedup below which a batch cannot pay even with free dispatch, validation and joins. */
export const boundFloor = 1;

/**
 * The best speedup a batch could reach: the serial time of the iterations it completed over the
 * time `width` workers need for them at the tracked time they showed. Wake, join and validation
 * only add to the wall, so a bound under one means the loop cannot win at this tracking cost.
 */
export function batchBound(
	perIterationMs: number,
	trackedMs: readonly number[],
	width: number
): number {
	const ran = trackedMs.filter((ms) => ms > 0);
	if (!ran.length || !(perIterationMs > 0) || width < 1) return Infinity;
	const mean = ran.reduce((sum, ms) => sum + ms, 0) / ran.length;
	return (ran.length * perIterationMs) / (Math.ceil(ran.length / width) * mean);
}

/**
 * A loop whose first batch bounds the speedup above this has tracking cost to spare: realized
 * speedups ran at about half the bound (aes-ctr 1.2 of 2.3, lz4-compress 1.2 of 2.4,
 * aes-cbc-decrypt 1.2 of 2.0 on the Mac sweep), so such a loop goes on to full batches on its
 * read windows. A loop under it gets one short batch on them first.
 */
export const proofBound = 2;

/** True when the bound of a batch is under `boundFloor`, through the seam; what the host passes. */
export function decideBound(bound: number): boolean {
	if (admissionSeam.force) return false;
	return bound / admissionSeam.batchScale < boundFloor;
}

/**
 * The wall and the serial time of the next batch of `next` iterations, from a batch that ran. Its
 * wall minus the time its workers needed for the iterations it completed is the cost that does
 * not shrink with the batch: wake, join and validation. The next batch pays that plus the
 * workers' share of its own iterations. Validation grows with the batch, so the wall comes out
 * low and a projected loss is a loss.
 */
export function projectBatch(
	wallMs: number,
	trackedMs: readonly number[],
	perIterationMs: number,
	next: number,
	width: number
): { wallMs: number; serialMs: number } | undefined {
	const ran = trackedMs.filter((ms) => ms > 0);
	if (!ran.length || !(perIterationMs > 0) || next < 1 || width < 1) return undefined;
	const mean = ran.reduce((sum, ms) => sum + ms, 0) / ran.length;
	const fixed = Math.max(0, wallMs - Math.ceil(ran.length / width) * mean);
	return { wallMs: Math.ceil(next / width) * mean + fixed, serialMs: next * perIterationMs };
}

/** True when a bound is low enough that the first batch on read windows should be a short one. */
export function decideProof(bound: number): boolean {
	if (admissionSeam.force) return false;
	return bound / admissionSeam.batchScale < proofBound;
}
