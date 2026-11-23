import type { Counts } from '../concurrency/plan.ts';
import { PRICES, price } from '../concurrency/plan.ts';
import { LEASE_MS, taskId } from './task.ts';

export { LEASE_MS, PRICES, taskId };

export const PREFIX = 'cfw-folio-lanepool-';
// lanes, and independent units per batch (four a lane)
export const WIDTH = 4;
export const UNITS = 16;
export const PAIRS = 10;
export const WARMUP_PAIRS = 1;
export const FAULT_REPS = 3;
export const FAULTS = ['burn', 'sleep'] as const;
export type Fault = (typeof FAULTS)[number];
// pre-registered line: median over the valid pairs of serial wall over pool wall
export const MIN_GAIN = 1.2;
// the cpu limit the worker deploys with; a burn runs for three times it at the fastest observed pace
export const CPU_LIMIT_MS = 5000;
export const BURN_FACTOR = 3;
// the serial arm runs UNITS units in one invocation and keeps this share of the limit free
export const CPU_MARGIN = 0.25;
export const CAL_TOLERANCE = 0.2;
// largest unit the margin allows, and the target: the top of the tolerance band still fits
export const MAX_UNIT_MS = ((1 - CPU_MARGIN) * CPU_LIMIT_MS) / UNITS;
export const TARGET_UNIT_MS = 190;
// run 1 measured 189.6 ms at this many passes on its first calibration step
export const START_PASSES = 650;
export const DEPLOY_WAIT_MS = 90000;
export const CAL_EMPTY = 5;
export const CAL_WARMUPS = 2;
// measurements at one pass count that must agree, and how far apart they may be
export const CAL_AGREE = 3;
export const CAL_SPREAD = 0.25;
export const CAL_GROWTH = 2;
export const CAL_MAX_STEPS = 6;
export const BODY_CAP = 16384;
// assumption, not a measurement: every object counted active for this long
export const ACTIVE_SECONDS_UPPER = 120;
export const COST_CAP_USD = 1;

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The pass count that moves a measured unit time to the target, assuming cost is linear in passes. */
export function scalePasses(passes: number, measuredMs: number, targetMs = TARGET_UNIT_MS) {
	return Math.max(1, Math.round((passes * targetMs) / measuredMs));
}

export const withinTolerance = (measuredMs: number, targetMs = TARGET_UNIT_MS) =>
	Math.abs(measuredMs - targetMs) <= CAL_TOLERANCE * targetMs;

/** One unit's time from a client wall of `UNITS` units, net of an empty call. */
export const unitMs = (wallMs: number, emptyMs: number, units = UNITS) =>
	(wallMs - emptyMs) / units;

/** Range of the values as a share of their median. */
export const spread = (values: number[]) =>
	(Math.max(...values) - Math.min(...values)) / median(values);

export interface CalRow {
	passes: number;
	unitMs: number;
	status: number | null;
}

export type CalStep =
	| { action: 'measure'; passes: number }
	| { action: 'done'; passes: number; unitMs: number }
	| { action: 'stop'; reason: string };

/**
 * What calibration does next. Each pass count is measured `CAL_AGREE` times on fresh objects with
 * the shape of the timed arm. The run stops, with a reason, on a failed call, on measurements that
 * disagree, or when the target is not reached in `CAL_MAX_STEPS` pass counts.
 */
export function calibrate(rows: CalRow[]): CalStep {
	const last = rows[rows.length - 1]!;
	if (last.status !== 200)
		return {
			action: 'stop',
			reason: `a calibration call returned ${last.status === null ? 'no response' : `HTTP ${last.status}`} at ${last.passes} passes`
		};
	const window = rows.filter((row) => row.passes === last.passes);
	if (window.length < CAL_AGREE) return { action: 'measure', passes: last.passes };
	const units = window.slice(-CAL_AGREE).map((row) => row.unitMs);
	if (spread(units) > CAL_SPREAD)
		return {
			action: 'stop',
			reason: `${CAL_AGREE} measurements at ${last.passes} passes disagree by more than ${CAL_SPREAD * 100} percent: ${units.map((u) => u.toFixed(1)).join(', ')} ms`
		};
	const measured = median(units);
	if (withinTolerance(measured)) return { action: 'done', passes: last.passes, unitMs: measured };
	if (new Set(rows.map((row) => row.passes)).size >= CAL_MAX_STEPS)
		return {
			action: 'stop',
			reason: `the unit did not reach ${TARGET_UNIT_MS} ms in ${CAL_MAX_STEPS} pass counts, last ${measured.toFixed(1)} ms at ${last.passes}`
		};
	const wanted = measured > 0 ? scalePasses(last.passes, measured) : last.passes * CAL_GROWTH;
	const passes = Math.round(
		Math.min(last.passes * CAL_GROWTH, Math.max(last.passes / CAL_GROWTH, wanted))
	);
	return { action: 'measure', passes };
}

/** The smallest positive cost per pass among the observations, or undefined when there is none. */
export function fastestMsPerPass(observed: number[]): number | undefined {
	const usable = observed.filter((value) => Number.isFinite(value) && value > 0);
	return usable.length ? Math.min(...usable) : undefined;
}

/** Passes for a burn of `BURN_FACTOR` times the cpu limit, from a cost per pass. */
export const burnPasses = (msPerPass: number) =>
	Math.ceil((BURN_FACTOR * CPU_LIMIT_MS) / msPerPass);

/** The error body a failed call saves: scrubbed and capped, with the headers that can carry secrets removed. */
export function scrub(text: string, secrets: string[]): string {
	return secrets
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)
		.reduce((out, secret) => out.split(secret).join('<scrubbed>'), text)
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
}

const HIDDEN_HEADERS = new Set(['set-cookie', 'cookie', 'authorization']);

export function savedFailure(body: string, headers: [string, string][], secrets: string[]) {
	return {
		body: scrub(body.slice(0, BODY_CAP), secrets),
		truncated: body.length > BODY_CAP,
		headers: Object.fromEntries(
			headers
				.filter(([key]) => !HIDDEN_HEADERS.has(key.toLowerCase()))
				.map(([key, value]) => [key, scrub(value, secrets)])
		)
	};
}

export interface Pair {
	pair: number;
	first: 'serial' | 'pool';
	serialMs: number;
	poolMs: number;
	serialStatus: number | null;
	poolStatus: number | null;
	equal: boolean;
}

export interface LaneError {
	lane: number;
	message: string;
}

export interface FaultRun {
	fault: Fault;
	rep: number;
	status: number | null;
	// the platform reset the lane (a lane call rejected) or the late lane came back
	injected: boolean;
	// every lane call that rejected, with its message
	laneErrors: LaneError[];
	// claims per task id, from the coordinator's table
	attempts: Record<string, number>;
	// accepted completions per task id, from the coordinator's outcome rows
	accepted: Record<string, number>;
	faulted: string;
	done: number;
	equal: boolean;
}

/** Order of the arms in pair `pair`: alternating, so drift touches both. */
export const pairOrder = (pair: number): 'serial' | 'pool' => (pair % 2 ? 'pool' : 'serial');

export const gain = (pair: Pair) => pair.serialMs / pair.poolMs;

/** A pair counts only when both arms returned 200. */
export const pairValid = (pair: Pair) => pair.serialStatus === 200 && pair.poolStatus === 200;

/** Whether the fault reset a lane: a rejected lane call for a burn, a first claim that reported late for a sleep. */
export function injected(
	fault: Fault,
	laneErrors: LaneError[],
	outcomes: { id: string; attempt: number }[],
	faulted: string
): boolean {
	return fault === 'burn'
		? laneErrors.length >= 1
		: outcomes.some((row) => row.id === faulted && row.attempt === 1);
}

/** The injected task ran twice, every other task once, and every task has one accepted completion. */
export function replayedExactlyOnce(run: FaultRun, units = UNITS): boolean {
	const ids = Array.from({ length: units }, (_, i) => taskId(i));
	return (
		run.done === units &&
		ids.every(
			(id) => run.attempts[id] === (id === run.faulted ? 2 : 1) && run.accepted[id] === 1
		)
	);
}

export interface Verdict {
	verdict: 'accept' | 'reject';
	gain: number | null;
	validPairs: number;
	invalidPairs: { pair: number; serialStatus: number | null; poolStatus: number | null }[];
	reasons: string[];
}

/** The pre-registered decision. Every clause must hold, or the verdict is reject. */
export function decide(pairs: Pair[], faults: FaultRun[], units = UNITS): Verdict {
	const reasons: string[] = [];
	const valid = pairs.filter(pairValid);
	const invalidPairs = pairs
		.filter((pair) => !pairValid(pair))
		.map(({ pair, serialStatus, poolStatus }) => ({ pair, serialStatus, poolStatus }));
	const measured = valid.length ? median(valid.map(gain)) : null;
	if (valid.length < PAIRS)
		reasons.push(
			`${valid.length} of ${PAIRS} pairs are valid (${pairs.length} ran, ${invalidPairs.length} had an arm that did not return 200)`
		);
	if (measured !== null && measured < MIN_GAIN)
		reasons.push(`median gain ${measured.toFixed(3)} is under ${MIN_GAIN}`);
	const unequal = valid.filter((pair) => !pair.equal).length;
	if (unequal) reasons.push(`${unequal} pairs returned outputs that differ from the serial run`);
	for (const fault of FAULTS) {
		const runs = faults.filter((run) => run.fault === fault);
		if (runs.length < FAULT_REPS)
			reasons.push(`${runs.length} of ${FAULT_REPS} ${fault} runs completed`);
		const failed = runs.filter((run) => run.status !== 200).length;
		if (failed) reasons.push(`${failed} ${fault} runs did not return 200`);
		const notInjected = runs.filter((run) => !run.injected).length;
		if (notInjected)
			reasons.push(
				`${notInjected} ${fault} runs did not reset a lane (lane calls rejected: ${runs.map((run) => run.laneErrors.length).join(', ')})`
			);
		const notReplayed = runs.filter(
			(run) => run.injected && !replayedExactlyOnce(run, units)
		).length;
		if (notReplayed) reasons.push(`${notReplayed} ${fault} runs did not replay exactly once`);
		const unequalFault = runs.filter((run) => !run.equal).length;
		if (unequalFault) reasons.push(`${unequalFault} ${fault} runs differ from the serial run`);
	}
	return {
		verdict: reasons.length ? 'reject' : 'accept',
		gain: measured,
		validPairs: valid.length,
		invalidPairs,
		reasons
	};
}

export function plan(pairs = PAIRS, warmups = WARMUP_PAIRS, faultReps = FAULT_REPS) {
	const rounds = pairs + warmups;
	// empty calls, discarded warmups and at most CAL_MAX_STEPS pass counts of CAL_AGREE calls
	const calibrationCalls = CAL_EMPTY + CAL_WARMUPS + CAL_MAX_STEPS * CAL_AGREE;
	// a pool run claims and completes each unit once, and each lane makes one empty claim
	const poolCalls = 1 + WIDTH + 2 * UNITS + WIDTH;
	const faultRuns = FAULTS.length * faultReps;
	const unitCpu = TARGET_UNIT_MS * UNITS;
	const counts: Counts = {
		// a fault run is a pool call and a state read
		workerRequests: rounds * 2 + faultRuns * 2 + calibrationCalls + 4,
		cpuMs:
			rounds * 2 * unitCpu +
			faultRuns * (unitCpu + CPU_LIMIT_MS) +
			calibrationCalls * unitCpu,
		durableObjectRequests:
			rounds * (1 + poolCalls) + faultRuns * (poolCalls + 4) + calibrationCalls + 2 * WIDTH,
		durableObjectGbSeconds:
			(rounds * 2 + faultRuns + calibrationCalls + WIDTH) *
			ACTIVE_SECONDS_UPPER *
			PRICES.durableObjectBilledGb
	};
	return {
		rounds,
		faultRuns,
		counts,
		price: price(counts),
		withinCap: price(counts).total < COST_CAP_USD
	};
}

const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 5 : 4)}`;

/** The plan as the text a dry run prints. */
export function describePlan(): string[] {
	const p = plan();
	return [
		'dry run: nothing is deployed and no Cloudflare call is made',
		`deploys: 1 Worker script with 2 Durable Object classes, deleted at the end; wait ${DEPLOY_WAIT_MS / 1000} s after deploy`,
		`timed arm: ${PAIRS} pairs after ${WARMUP_PAIRS} warmup, k = ${WIDTH} lanes, ${UNITS} units of about ${TARGET_UNIT_MS} ms (at most ${MAX_UNIT_MS.toFixed(1)} ms for a ${CPU_MARGIN * 100} percent margin under the ${CPU_LIMIT_MS} ms cpu limit)`,
		`calibration: ${CAL_EMPTY} empty calls, ${CAL_WARMUPS} warmups, then ${CAL_AGREE} fresh-object calls per pass count, stop if they differ by more than ${CAL_SPREAD * 100} percent or a call fails, at most ${CAL_MAX_STEPS} pass counts`,
		`fault arm: ${FAULT_REPS} runs each of ${FAULTS.join(' and ')}, lease ${LEASE_MS} ms, cpu limit ${CPU_LIMIT_MS} ms, burn sized for ${BURN_FACTOR} times the limit at the fastest observed pace`,
		`worker requests ${p.counts.workerRequests}, Durable Object requests ${p.counts.durableObjectRequests}, cpu at most ${p.counts.cpuMs} ms`,
		`Durable Object duration, assumed active ${ACTIVE_SECONDS_UPPER} s each: ${p.counts.durableObjectGbSeconds.toFixed(1)} GB-s (assumption, not a measurement)`,
		`list-rate price, no allowance applied (read ${PRICES.read}):`,
		`  worker requests ${usd(p.price.usd.workerRequests)}, cpu ${usd(p.price.usd.cpu)}, Durable Object requests ${usd(p.price.usd.durableObjectRequests)}, Durable Object duration ${usd(p.price.usd.durableObjectDuration)}`,
		`  total at most ${usd(p.price.total)} against a stated cap of ${usd(COST_CAP_USD)} (${p.withinCap ? 'within the cap' : 'OVER THE CAP, the run refuses to start'})`
	];
}
