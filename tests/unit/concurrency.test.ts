import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import type { Arm, Level, Sample, TraceEvent } from '../../experiments/concurrency/plan.ts';
import {
	ARMS,
	attribute,
	cpuOverWall,
	decide,
	durableObjectCalls,
	INVOCATION_CAP,
	invocations,
	join,
	KS,
	lcg,
	LEVELS,
	overlapIndex,
	plan,
	price,
	PRICES,
	quantile,
	scaleRounds,
	schedule,
	SEED,
	summarize,
	topLevel,
	withinTolerance
} from '../../experiments/concurrency/plan.ts';
import { analyze, describePlan, tailEvents } from '../../experiments/concurrency/run.ts';

const REPS = 12;

// one cell of a synthetic run; lanes are (cpu, wall) pairs as the tail would report them
function cell(
	arm: Arm,
	level: Level,
	k: number,
	rep: number,
	clientWallMs: number,
	lanes: [number, number][] = []
): Sample {
	return {
		rep,
		rid: rep * 1000 + ARMS.indexOf(arm) * 100 + LEVELS.indexOf(level) * 10 + k,
		arm,
		level,
		k,
		rounds: 0,
		status: 200,
		clientWallMs,
		exact: true,
		calls: Array.from({ length: k }, (_, slot) => ({
			slot,
			ok: true,
			isolate: `i${arm}${slot}`,
			instance: `n${arm}${slot}`,
			entered: 1000 + slot * (lanes[slot]?.[1] ?? 0),
			...(lanes[slot] ? { cpuMs: lanes[slot]![0], wallMs: lanes[slot]![1] } : {})
		}))
	};
}

// a full set of cells for one arm: wall1 and wall4 at each level, lane events from `lane`
function run(
	arm: Arm,
	walls: Record<Level, [number, number]>,
	lane: (level: Level, slot: number) => [number, number]
) {
	const cpu = { empty: 0, low: 70, high: 340 };
	return Array.from({ length: REPS }, (_, rep) =>
		LEVELS.flatMap((level) =>
			KS.map((k) =>
				cell(
					arm,
					level,
					k,
					rep,
					walls[level][k === 1 ? 0 : 1],
					Array.from({ length: k }, (_, slot) =>
						level === 'empty'
							? [0, 3]
							: (([c, w]) => [Math.min(c, cpu[level]), w])(lane(level, slot))
					) as [number, number][]
				)
			)
		)
	).flat();
}

test('the schedule runs every cell once a repetition, rotates and reverses', () => {
	for (let rep = 0; rep < REPS + 1; rep++) {
		const cells = schedule(rep);
		assert.equal(cells.length, ARMS.length * LEVELS.length * KS.length);
		assert.equal(new Set(cells.map((c) => `${c.arm}-${c.level}-${c.k}`)).size, cells.length);
	}
	const key = (rep: number) => schedule(rep).map((c) => `${c.arm}-${c.level}-${c.k}`);
	assert.notDeepEqual(key(0), key(1));
	assert.notDeepEqual(key(0), key(2));
	// repetition 1 rotates the blocks by one, so its last block was first and reversal puts it first
	assert.deepEqual([schedule(1)[0]!.level, schedule(1)[0]!.k], ['empty', 1]);
	assert.deepEqual([schedule(0)[0]!.level, schedule(0)[0]!.k], ['empty', 1]);
	// every arm leads a block in some repetition
	const leaders = new Set(Array.from({ length: 10 }, (_, rep) => schedule(rep)[0]!.arm));
	assert.ok(leaders.size >= 3);
});

test('invocation counts per cell follow the arm shape', () => {
	assert.equal(invocations('worker', 1), 2);
	assert.equal(invocations('worker-one', 4), 5);
	assert.equal(invocations('do-same', 4), 5);
	assert.equal(invocations('direct', 4), 4);
	assert.equal(topLevel('direct', 4), 4);
	assert.equal(topLevel('do-hint', 4), 1);
	assert.equal(durableObjectCalls('do-hint', 4), 4);
	assert.equal(durableObjectCalls('worker', 4), 0);
});

test('the live plan stays under the cap and the dry run prints it', () => {
	const p = plan();
	assert.equal(p.cellsPerRep, 30);
	assert.equal(p.perRep, 99);
	assert.equal(p.perRepTopLevel, 39);
	assert.equal(p.expected, 13 * 99 + 2 * p.calibrationRequests + 13 + 4 + 13);
	assert.ok(p.withinCap);
	assert.ok(p.expected < INVOCATION_CAP);
	assert.ok(!plan(30).withinCap);
	const text = describePlan().join('\n');
	assert.match(text, /within the cap/);
	assert.match(text, /list-rate price/);
	assert.doesNotMatch(text, /drupflare|gmux|thunder|bastion|paisley/i);
});

test('price multiplies counts by the list rates', () => {
	const result = price({
		workerRequests: 1e6,
		cpuMs: 1e6,
		durableObjectRequests: 1e6,
		durableObjectGbSeconds: 1e6
	});
	assert.equal(result.usd.workerRequests, PRICES.workersRequestsPerMillion);
	assert.equal(result.usd.cpu, PRICES.workersCpuPerMillionMs);
	assert.equal(result.usd.durableObjectRequests, PRICES.durableObjectRequestsPerMillion);
	assert.equal(result.usd.durableObjectDuration, PRICES.durableObjectGbSecondsPerMillion);
	assert.ok(Math.abs(result.total - (0.3 + 0.02 + 0.15 + 12.5)) < 1e-9);
	assert.equal(PRICES.durableObjectBilledGb, 0.128);
	assert.ok(plan().price.total < 0.1);
});

test('the overlap index divides net wall of four by net wall of one', () => {
	assert.equal(overlapIndex(305, 25, 90, 20), 4);
	assert.equal(overlapIndex(100, 25, 90, 20), 75 / 70);
	assert.equal(overlapIndex(100, 25, 22, 20), null);
	assert.equal(cpuOverWall([]), null);
	assert.equal(
		cpuOverWall([
			{ cpuMs: 70, wallMs: 70 },
			{ cpuMs: 70, wallMs: 210 }
		]),
		140 / 280
	);
	assert.equal(quantile([5, 1, 3, 2, 4], 0.9), 5);
	assert.equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
});

test('calibration scales rounds toward the target and checks the tolerance', () => {
	assert.equal(scaleRounds(1_000_000, 10, 70), 7_000_000);
	assert.equal(scaleRounds(1_000_000, 0, 70), 10_000_000);
	assert.equal(scaleRounds(3_000_000_000, 10, 340), 4_000_000_000);
	assert.ok(withinTolerance(60, 70));
	assert.ok(!withinTolerance(40, 70));
	assert.equal(lcg(0), SEED);
	assert.equal(lcg(1_000_000), 1794897017);
});

test('tail events join to calls through the lane log line', () => {
	const line = (rid: number, slot: number) =>
		JSON.stringify({ probe: 'concurrency-lane', rid, slot });
	const events: TraceEvent[] = [
		{ cpuTime: 68, wallTime: 80, logs: [{ message: [line(7, 0)] }] },
		{ cpuTime: 70, wallTime: 900, logs: [{ message: ['not json', 3, line(7, 1)] }] },
		{
			cpuTime: 1,
			wallTime: 1,
			logs: [{ message: [JSON.stringify({ probe: 'other', rid: 7, slot: 2 })] }]
		},
		{ cpuTime: 2, wallTime: 2 }
	];
	const trace = attribute(events);
	assert.equal(trace.size, 2);
	const [joined] = join([{ ...cell('worker', 'low', 4, 0, 100), rid: 7 }], trace);
	assert.deepEqual(
		joined!.calls.map((c) => [c.cpuMs, c.wallMs]),
		[
			[68, 80],
			[70, 900],
			[undefined, undefined],
			[undefined, undefined]
		]
	);
});

test('a tail log cut mid-event keeps the complete events', () => {
	const whole = JSON.stringify({ logs: [], cpuTime: 1, wallTime: 2, outcome: 'ok' });
	assert.equal(tailEvents(`${whole}${whole}`).length, 2);
	assert.equal(tailEvents(`${whole}${whole}{"logs":[{"mess`).length, 2);
	assert.equal(tailEvents(`${whole}\n${whole}\n{"logs": [`).length, 2);
	assert.equal(tailEvents('').length, 0);
});

test('the decision rule separates serialized lanes from overlapped ones', () => {
	// serialized: four calls of 70 ms queue to 70, 140, 210 and 280 ms of wall
	const queued = (level: Level, slot: number): [number, number] => [
		level === 'low' ? 70 : 340,
		(level === 'low' ? 70 : 340) * (slot + 1)
	];
	const serial = run('worker', { empty: [20, 25], low: [90, 305], high: [360, 1385] }, queued);
	// overlapped: every call takes about its own cpu
	const parallel = run(
		'direct',
		{ empty: [20, 25], low: [90, 100], high: [360, 380] },
		(level) => [level === 'low' ? 70 : 340, level === 'low' ? 78 : 350]
	);
	// index passes but the lane events show waiting
	const waiting = run(
		'do-same',
		{ empty: [20, 25], low: [90, 100], high: [360, 380] },
		(level) => [level === 'low' ? 70 : 340, level === 'low' ? 200 : 900]
	);
	const verdicts = decide(summarize([...serial, ...parallel, ...waiting]));
	const of = (arm: Arm, level: Level) =>
		verdicts.find((v) => v.arm === arm && v.level === level)!;
	assert.equal(of('worker', 'low').pass, false);
	assert.ok(Math.abs(of('worker', 'low').index! - 4) < 1e-9);
	assert.equal(of('worker', 'high').pass, false);
	assert.equal(of('direct', 'low').pass, true);
	assert.equal(of('direct', 'high').pass, true);
	assert.ok(of('direct', 'high').index! <= 1.5);
	assert.equal(of('do-same', 'low').pass, false);
	assert.ok(of('do-same', 'low').index! <= 1.5);
	assert.ok(of('do-same', 'low').cpuOverWall! < 0.8);
	// arms with no samples cannot be judged
	assert.equal(of('do-hint', 'low').pass, null);
	assert.equal(of('worker', 'low').isolates, 4);
});

test('failed and inexact requests leave the medians and stay in the counts', () => {
	const samples = run(
		'direct',
		{ empty: [20, 25], low: [90, 100], high: [360, 380] },
		(level) => [level === 'low' ? 70 : 340, level === 'low' ? 78 : 350]
	);
	const target = samples.find((s) => s.level === 'low' && s.k === 4 && s.rep === 0)!;
	target.status = 503;
	target.clientWallMs = 9999;
	const inexact = samples.find((s) => s.level === 'low' && s.k === 4 && s.rep === 1)!;
	inexact.exact = false;
	const row = summarize(samples).find(
		(r) => r.arm === 'direct' && r.level === 'low' && r.k === 4
	)!;
	assert.equal(row.requests, REPS);
	assert.equal(row.failures, 2);
	assert.equal(row.usable, REPS - 2);
	assert.equal(row.wallMs, 100);
	assert.equal(row.wallMax, 100);
	assert.equal(row.eventCoverage, 1);
	assert.equal(row.isolatesPerRequest, 4);
});

test('too few usable samples gives no verdict', () => {
	const samples = run('direct', { empty: [20, 25], low: [90, 100], high: [360, 380] }, () => [
		70, 78
	]).filter((s) => s.rep < 3);
	assert.equal(decide(summarize(samples)).find((v) => v.arm === 'direct')!.pass, null);
});

test('analyze reads the tail files of every script and applies the rule', async () => {
	const directory = mkdtempSync(joinPath(tmpdir(), 'folio-concurrency-'));
	try {
		const url = pathToFileURL(`${directory}/`);
		const samples = run('direct', { empty: [20, 25], low: [90, 100], high: [360, 380] }, () => [
			70, 78
		]);
		const lines = samples.flatMap((s) =>
			s.calls.map((c) =>
				JSON.stringify({
					logs: [
						{
							message: [
								JSON.stringify({
									probe: 'concurrency-lane',
									rid: s.rid,
									slot: c.slot
								})
							]
						}
					],
					cpuTime: s.level === 'empty' ? 0 : s.level === 'low' ? 70 : 340,
					wallTime: s.level === 'empty' ? 3 : s.level === 'low' ? 78 : 350,
					outcome: 'ok'
				})
			)
		);
		// the first lane's log ends mid-event, as a tail stopped by an interrupt does
		writeFileSync(joinPath(directory, 'tail-a-l1.jsonl'), `${lines.join('')}{"logs":[{"mes`);
		const result = await analyze(url, ['a', 'a-l1', 'a-l2'], samples);
		assert.equal(result.tail.calls, result.tail.callsWithCpu);
		assert.equal(result.tail.events, lines.length);
		const verdict = result.verdicts.find((v) => v.arm === 'direct' && v.level === 'high')!;
		assert.equal(verdict.pass, true);
		assert.ok(Math.abs(verdict.cpuOverWall! - 340 / 350) < 1e-9);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
