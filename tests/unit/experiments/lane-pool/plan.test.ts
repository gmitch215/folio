import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CalRow, FaultRun, Pair } from '../../../../experiments/lane-pool/plan.ts';
import {
	BODY_CAP,
	burnPasses,
	CAL_GROWTH,
	CAL_MAX_STEPS,
	CAL_TOLERANCE,
	calibrate,
	CPU_LIMIT_MS,
	CPU_MARGIN,
	decide,
	fastestMsPerPass,
	FAULT_REPS,
	FAULTS,
	injected,
	MIN_GAIN,
	pairOrder,
	PAIRS,
	pairValid,
	plan,
	replayedExactlyOnce,
	savedFailure,
	scalePasses,
	scrub,
	TARGET_UNIT_MS,
	taskId,
	UNITS,
	withinTolerance
} from '../../../../experiments/lane-pool/plan.ts';
import { chunk } from '../../../../experiments/lane-pool/task.ts';

const pairs = (ratio: number, count = PAIRS, equal = true): Pair[] =>
	Array.from({ length: count }, (_, pair) => ({
		pair,
		first: pairOrder(pair),
		serialMs: 1000 * ratio,
		poolMs: 1000,
		serialStatus: 200,
		poolStatus: 200,
		equal
	}));

function faultRun(fault: FaultRun['fault'], rep: number, change: Partial<FaultRun> = {}): FaultRun {
	const faulted = taskId(2 + 3 * rep);
	const ids = Array.from({ length: UNITS }, (_, i) => taskId(i));
	return {
		fault,
		rep,
		status: 200,
		injected: true,
		laneErrors: [{ lane: 0, message: 'reset' }],
		attempts: Object.fromEntries(ids.map((id) => [id, id === faulted ? 2 : 1])),
		accepted: Object.fromEntries(ids.map((id) => [id, 1])),
		faulted,
		done: UNITS,
		equal: true,
		...change
	};
}

const faults = () =>
	FAULTS.flatMap((fault) => Array.from({ length: FAULT_REPS }, (_, i) => faultRun(fault, i + 1)));

const row = (passes: number, unitMs: number, status: number | null = 200): CalRow => ({
	passes,
	unitMs,
	status
});

test('a chunk is a pure function of its arguments and grows with passes', () => {
	assert.equal(chunk(3, 5), chunk(3, 5));
	assert.notEqual(chunk(3, 5), chunk(4, 5));
	assert.notEqual(chunk(3, 5), chunk(3, 6));
	assert.match(chunk(0, 1), /^0:[0-9a-f]{8}:\d+$/);
});

test('the decision accepts a gain at the line with exact outputs and one replay per injected reset', () => {
	const verdict = decide(pairs(MIN_GAIN), faults());
	assert.equal(verdict.verdict, 'accept');
	assert.deepEqual(verdict.reasons, []);
});

test('the decision rejects below the line, on a differing output, or a missing pair', () => {
	assert.equal(decide(pairs(MIN_GAIN - 0.01), faults()).verdict, 'reject');
	assert.equal(decide(pairs(2, PAIRS, false), faults()).verdict, 'reject');
	assert.equal(decide(pairs(2, PAIRS - 1), faults()).verdict, 'reject');
});

test('the gain is the median of the pair ratios', () => {
	const mixed = pairs(1);
	for (const pair of mixed.slice(0, 6)) pair.serialMs = 3000;
	assert.equal(decide(mixed, faults()).gain, 3);
});

test('the decision rejects a reset that was not replayed once, not injected, or not exact', () => {
	const bad = (change: Partial<FaultRun>) => {
		const all = faults();
		all[0] = { ...all[0]!, ...change };
		return decide(pairs(2), all);
	};
	const attempts = { ...faultRun('burn', 1).attempts, [taskId(5)]: 3 };
	assert.match(bad({ attempts }).reasons.join(), /did not replay exactly once/);
	assert.match(bad({ injected: false }).reasons.join(), /did not reset a lane/);
	assert.match(bad({ equal: false }).reasons.join(), /differ from the serial run/);
	assert.match(bad({ accepted: { [taskId(0)]: 2 } }).reasons.join(), /replay exactly once/);
	assert.equal(decide(pairs(2), faults().slice(1)).verdict, 'reject');
});

test('a run with a task done twice or never is not exactly once', () => {
	assert.equal(replayedExactlyOnce(faultRun('sleep', 1)), true);
	assert.equal(replayedExactlyOnce(faultRun('sleep', 1, { done: UNITS - 1 })), false);
});

test('pairs alternate which arm runs first', () => {
	assert.deepEqual([0, 1, 2, 3].map(pairOrder), ['serial', 'pool', 'serial', 'pool']);
});

test('passes scale to the target', () => {
	assert.equal(scalePasses(100, 50, 100), 200);
	assert.equal(withinTolerance(110, 100), true);
	assert.equal(withinTolerance(150, 100), false);
});

test('the priced plan is within its cap', () => {
	const p = plan();
	assert.equal(p.withinCap, true);
	assert.ok(Object.values(p.counts).every((value) => Number.isFinite(value) && value >= 0));
});

// calibration (a): run 1 measured about 120 ms and about 480 ms per unit at one pass count

test('calibration stops when three measurements at one pass count disagree', () => {
	const step = calibrate([row(466, 121), row(466, 476), row(466, 130)]);
	assert.equal(step.action, 'stop');
	assert.match(step.action === 'stop' ? step.reason : '', /disagree.*121\.0, 476\.0, 130\.0/);
});

test('calibration measures again until three agree, then reports the median', () => {
	assert.deepEqual(calibrate([row(650, TARGET_UNIT_MS)]), { action: 'measure', passes: 650 });
	const rows = [row(650, 180), row(650, 190), row(650, 200)];
	assert.deepEqual(calibrate(rows), { action: 'done', passes: 650, unitMs: 190 });
});

test('calibration rescales a stable but off-target unit, at most doubling the passes', () => {
	const near = calibrate([row(650, 100), row(650, 105), row(650, 98)]);
	assert.deepEqual(near, { action: 'measure', passes: scalePasses(650, 100) });
	const far = calibrate([row(100, 5), row(100, 5.5), row(100, 5.2)]);
	assert.deepEqual(far, { action: 'measure', passes: 100 * CAL_GROWTH });
});

test('calibration stops on a failed call and when the target is not reached in time', () => {
	const failed = calibrate([row(650, 190), row(650, 5000, 500)]);
	assert.match(failed.action === 'stop' ? failed.reason : '', /HTTP 500 at 650 passes/);
	const none = calibrate([row(650, 190, null)]);
	assert.match(none.action === 'stop' ? none.reason : '', /no response/);
	const rows = Array.from({ length: CAL_MAX_STEPS }, (_, step) => step + 1).flatMap((step) =>
		[0, 1, 2].map(() => row(step * 10, 30))
	);
	assert.match(
		(calibrate(rows) as { reason: string }).reason,
		new RegExp(`${CAL_MAX_STEPS} pass counts`)
	);
});

// unit size (b)

test('the serial arm fits under the cpu limit with the margin, at the top of the tolerance band', () => {
	const top = TARGET_UNIT_MS * (1 + CAL_TOLERANCE);
	assert.ok(UNITS * top <= (1 - CPU_MARGIN) * CPU_LIMIT_MS);
	// run 1's slow runs cost about 476 ms a unit, which does not fit
	assert.ok(UNITS * 476 > CPU_LIMIT_MS);
});

// burn (c): run 1 sized the burn at 1.02 ms a pass and the lane ran near 0.07 ms a pass

test('the burn is sized from the fastest observed pace and passes the limit at that pace', () => {
	const fastest = fastestMsPerPass([1.02, 0.29, Number.NaN, -1, 0.07])!;
	assert.equal(fastest, 0.07);
	assert.ok(burnPasses(fastest) * fastest >= 2 * CPU_LIMIT_MS);
	assert.ok(burnPasses(1.02) * 0.07 < CPU_LIMIT_MS);
	assert.equal(fastestMsPerPass([]), undefined);
	assert.equal(fastestMsPerPass([0, -3]), undefined);
});

// failed responses (d)

test('a failed response keeps its body up to the cap, scrubbed, and drops cookie headers', () => {
	const page = `<title>Worker threw exception | run-1.team.workers.dev</title> ip 203.0.113.7 token abc123 ${'x'.repeat(BODY_CAP * 2)}`;
	const saved = savedFailure(
		page,
		[
			['content-type', 'text/html'],
			['Set-Cookie', 'session=abc123'],
			['x-host', 'run-1.team.workers.dev']
		],
		['abc123', 'run-1.team.workers.dev']
	);
	assert.equal(saved.truncated, true);
	assert.ok(saved.body.length <= BODY_CAP + 100);
	assert.match(saved.body, /Worker threw exception \| <scrubbed>/);
	assert.doesNotMatch(saved.body, /workers\.dev|203\.0\.113\.7|abc123/);
	assert.deepEqual(saved.headers, { 'content-type': 'text/html', 'x-host': '<scrubbed>' });
	assert.equal(scrub('plain', ['']), 'plain');
});

test('a pair with a failed arm is invalid, reported, and never counted', () => {
	const run = pairs(2);
	for (const pair of run.slice(0, 5)) {
		pair.serialStatus = 500;
		pair.serialMs = 7500;
		pair.equal = false;
	}
	assert.equal(pairValid(run[0]!), false);
	assert.equal(pairValid(run[5]!), true);
	const verdict = decide(run, faults());
	assert.equal(verdict.verdict, 'reject');
	assert.equal(verdict.validPairs, 5);
	assert.equal(verdict.gain, 2);
	assert.deepEqual(
		verdict.invalidPairs.map((pair) => pair.pair),
		[0, 1, 2, 3, 4]
	);
	assert.match(verdict.reasons.join(), /5 of 10 pairs are valid/);
	assert.doesNotMatch(verdict.reasons.join(), /differ from the serial run/);
	const poolFailed = pairs(2);
	poolFailed[3]!.poolStatus = 502;
	assert.equal(decide(poolFailed, faults()).validPairs, PAIRS - 1);
});

test('a failed fault run is reported by its status', () => {
	const all = faults();
	all[1] = { ...all[1]!, status: 500 };
	assert.match(decide(pairs(2), all).reasons.join(), /1 burn runs did not return 200/);
});

// burn arm (e)

test('a burn counts as injected only when a lane call rejected, and the reason shows the count', () => {
	assert.equal(injected('burn', [], [], 't0005'), false);
	assert.equal(injected('burn', [{ lane: 1, message: 'cpu limit' }], [], 't0005'), true);
	assert.equal(injected('sleep', [], [{ id: 't0005', attempt: 1 }], 't0005'), true);
	assert.equal(injected('sleep', [], [{ id: 't0004', attempt: 1 }], 't0005'), false);
	const all = faults();
	for (const rep of [0, 1, 2]) all[rep] = { ...all[rep]!, injected: false, laneErrors: [] };
	assert.match(
		decide(pairs(2), all).reasons.join(),
		/3 burn runs did not reset a lane \(lane calls rejected: 0, 0, 0\)/
	);
});
