/** Why the rest of a loop ran serially after the pooled path was tried or refused. */
export type IterationStop =
	'no-admission' | 'log-exhausted' | 'frame-carried dependence' | 'dependency';

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
	/** The same iterations at `plainIterationMs` each. */
	batchSerialMs?: number;
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

export interface AdmitInput {
	plainIterationMs: number;
	trip: number;
	width: number;
	constants?: IterationAdmissionConstants;
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
	constants = iterationAdmissionConstants
}: AdmitInput): IterationAdmission {
	const remaining = trip - 1;
	const remainingSerialMs = remaining * t0;
	const floorMs = constants.fixedMs * constants.margin;
	const admitted =
		Number.isFinite(t0) && remaining >= 2 && width >= 2 && remainingSerialMs > floorMs;
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
 * rule; `force` admits any loop with an iteration left after iteration 0 and never stops on the
 * batch rule. The structural stops (`log-exhausted`, `frame-carried dependence`, `dependency`)
 * are not affected.
 * @internal
 */
export const admissionSeam = { scale: 1, batchScale: 1, force: false };

/** `admitIteration` through the seam; what the host function calls. */
export function decideAdmission(plainIterationMs: number, trip: number, width: number) {
	const decision = admitIteration({
		plainIterationMs: plainIterationMs * admissionSeam.scale,
		trip,
		width
	});
	if (admissionSeam.force && trip >= 2 && width >= 2) decision.admitted = true;
	return decision;
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
