/** What the admission decision saw and chose for one owner call's loop. */
export interface IterationAdmission {
	/** Predicted wall of the pooled run, the probe included. */
	predictedParallelMs: number;
	/** Predicted wall of the owner running the loop itself. */
	predictedSerialMs: number;
	/** Tracked time of iteration 0 on the owner thread, as the probe measured it. */
	firstIterationMs: number;
	admitted: boolean;
}

/** The constants of the model. A re-calibration changes these and nothing else. */
export interface IterationAdmissionConstants {
	/** Tracked time of an iteration over its untracked time on one thread. */
	trackingFactor: number;
	/** Wall of the pooled path that does not shrink with the loop: dispatch, join, validation. */
	fixedMs: number;
	/** Added to the ideal wall per extra worker, for shared bandwidth, clocks and uneven inputs. */
	imbalancePerWorker: number;
	/** The pooled wall must beat the serial wall by this factor. */
	margin: number;
}

/**
 * Calibrated on the rig by `scripts/research/iteration-admission.ts`; a re-calibration updates only
 * these four numbers.
 *
 * `trackingFactor` 1.4 is the single-thread tracked over native cost of BLAKE3 at 64 KiB to 4 MiB
 * (6b section 6: 1.38 to 1.45). On the rig the width 1 tracked batch time over the paired native wall is
 * 1.50 (32 x 4 MiB) and 1.69 (128 x 256 KiB), lower bounds because the native wall includes the
 * input copy, and the Mac sweep gives 1.5 to 1.8 from 256 KiB up, so 1.4 admits slightly too much.
 *
 * `imbalancePerWorker` 0.05 fits the rig's tracked dispatch time against its width 1 time over
 * the ideal: 32 x 4 MiB gave 1.01, 1.03 and 1.29 at widths 2, 4 and 8, and 128 x 256 KiB gave
 * 1.03, 1.12 and 1.45. The model gives 1.05, 1.15 and 1.35.
 *
 * `fixedMs` 2 is the smallest value at which no cell of the Mac sweep (18 cells, 4 KiB to 4 MiB
 * by 8 to 128 iterations, width 8) dispatched and lost. The pooled wall minus probe minus batch
 * time measured 0.1 to 2.9 ms there with the input copy left out of the timing; 6b's rows bracket
 * 3 to 8 ms but include that copy.
 *
 * `margin` 1.25 is the speedup the pooled path has to promise before it is worth its cost.
 */
export const iterationAdmissionConstants: IterationAdmissionConstants = {
	trackingFactor: 1.4,
	fixedMs: 2,
	imbalancePerWorker: 0.05,
	margin: 1.25
};

export interface AdmitInput {
	firstIterationMs: number;
	trip: number;
	width: number;
	constants?: IterationAdmissionConstants;
}

/**
 * Decides from the measured grain. Serial wall is `trip * t0 / trackingFactor`. Parallel wall is
 * the fixed cost, plus the probe (one tracked iteration), plus `ceil(trip / workers)` rounds of
 * `t0` stretched by the imbalance of that many workers. Admits when the parallel wall times the
 * margin is within the serial wall and at least two iterations run on at least two workers. The
 * rounds are the makespan of equal iterations; unequal ones are what the imbalance term is for.
 */
export function admitIteration({
	firstIterationMs: t0,
	trip,
	width,
	constants = iterationAdmissionConstants
}: AdmitInput): IterationAdmission {
	const workers = Math.min(width, trip);
	const imbalance = 1 + constants.imbalancePerWorker * (workers - 1);
	const rounds = workers > 0 ? Math.ceil(trip / workers) : 0;
	const predictedParallelMs = constants.fixedMs + t0 + rounds * t0 * imbalance;
	const predictedSerialMs = (trip * t0) / constants.trackingFactor;
	const admitted =
		Number.isFinite(t0) &&
		trip >= 2 &&
		workers >= 2 &&
		predictedParallelMs * constants.margin <= predictedSerialMs;
	return { predictedParallelMs, predictedSerialMs, firstIterationMs: t0, admitted };
}

/**
 * Test and sweep seam, module state and not an option. `scale` multiplies the measured grain
 * before the decision; `force` admits any loop of two or more iterations whatever the numbers say.
 * @internal
 */
export const admissionSeam = { scale: 1, force: false };

/** `admitIteration` through the seam; what the host function calls. */
export function decideAdmission(firstIterationMs: number, trip: number, width: number) {
	const decision = admitIteration({
		firstIterationMs: firstIterationMs * admissionSeam.scale,
		trip,
		width
	});
	if (admissionSeam.force && trip >= 2 && width >= 2) decision.admitted = true;
	return decision;
}
