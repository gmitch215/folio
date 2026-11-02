import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest';
import { iterationShapes, runIterationPrograms } from '../../scripts/research/differential.ts';
import type { Plan, Rig } from '../../scripts/research/iteration-diff.ts';
import {
	blake3File,
	blake3Rig,
	digests,
	disjoint,
	dstCell,
	firstDifference,
	generate,
	iterationRun,
	planImage,
	randomSeeds,
	sameError,
	serialRun,
	srcCell,
	wat,
	watRig
} from '../../scripts/research/iteration-diff.ts';
import { prepare } from '../../src/compiler.ts';
import { inlineEntryBytes, lowerInline } from '../../src/inline.ts';
import {
	admissionSeam,
	admitIteration,
	batchBound,
	batchCollapses,
	batchLoses,
	decideAdmission,
	decideBatch,
	decideBound,
	decideCollapse,
	decideProof,
	decideRemaining,
	iterationAdmissionConstants,
	probeEstimate,
	probeFraction,
	projectBatch,
	proofBound,
	refineEstimate
} from '../../src/iteration-admission.ts';
import { iterationOwner } from '../../src/iteration-owner.ts';
import type { IterationOutcome, IterationReport } from '../../src/iteration.ts';
import {
	IterationPool,
	discoverWindow,
	iterationArena,
	iterationArenaBytes,
	iterationArguments,
	iterationEntryBytes,
	iterationFit,
	iterationFrameShadow,
	iterationLogCeiling,
	iterationVerdict,
	iterationWindowCopy,
	pairwiseConflicts,
	tabledConflicts
} from '../../src/iteration.ts';
import type { ExecutionReport } from '../../src/node.ts';
import { Folio } from '../../src/node.ts';

const widths = [1, 2, 4, 8];
let rig: Rig;
let small: Rig;

beforeAll(async () => {
	rig = await watRig(widths);
	small = await watRig(
		[2],
		{ logCapacity: 5 },
		wasm(ownerSource(spillItem, { maximum: wat.pages }))
	);
});
afterAll(async () => {
	await rig?.close();
	await small?.close();
});

// runs a plan serially and on the pool; equal means the same memory outside the stack and arena
function compare(
	on: Rig,
	width: number,
	plan: Plan,
	extra: Parameters<typeof iterationRun>[4] = {}
) {
	const { image, args } = planImage(plan);
	const want = serialRun(on, image, args);
	const got = iterationRun(on, width, image, args, extra);
	return {
		want,
		got,
		equal:
			firstDifference(on, want.bytes, got.bytes) === -1 && sameError(want.error, got.error),
		report: got.report!
	};
}

// writes (value and 7) 32-byte cells of private heap beside the dst store; the stack stays untracked
const spillItem = `
	(i32.store (local.get $dst) (i32.const 1))
	(local.set $s (i32.and (i32.load (local.get $src)) (i32.const 7)))
	(block $out (loop $each
		(br_if $out (i32.eqz (local.get $s)))
		(local.set $s (i32.sub (local.get $s) (i32.const 1)))
		(i32.store
			(i32.add
				(i32.add (i32.const 0x40000)
					(i32.shl (i32.sub (local.get $dst) (i32.const 0x30000)) (i32.const 3)))
				(i32.shl (local.get $s) (i32.const 5)))
			(i32.const 5))
		(br $each)))`;

const rawPlan = (n: number): Plan => {
	const plan = disjoint(n);
	for (let i = 3; i < n; i += 4) plan.src[i] = dstCell(i - 1);
	return plan;
};
const warPlan = (n: number): Plan => {
	const plan = disjoint(n);
	plan.src[5] = dstCell(20);
	return plan;
};
const wawPlan = (n: number): Plan => {
	const plan = disjoint(n);
	for (let i = 1; i < n; i += 2) plan.dst[i] = dstCell(i - 1);
	return plan;
};

test('the arena holds slots, logs and bitmaps over the whole memory', () => {
	const memory = 8 << 20;
	const a = iterationArena(1 << 20, memory, { batch: 4, logCapacity: 10, slotBytes: 4096 });
	assert.equal(a.slots, a.base + 4096);
	assert.equal(a.stamp, a.slots + 4 * 4096);
	assert.equal(a.logBytes, 448);
	assert.equal(a.rsize, memory / 64 / 8);
	assert.equal(a.wsize, memory / 32 / 8);
	assert.equal(a.base + a.bytes, a.wmaps + 4 * a.wsize);
	assert.equal(
		iterationArenaBytes(memory, { batch: 4, logCapacity: 10, slotBytes: 4096 }),
		a.bytes
	);
	assert.equal(iterationEntryBytes, inlineEntryBytes(32));
	for (const bad of [{ batch: 0 }, { logCapacity: 0 }, { slotBytes: 100 }])
		assert.throws(() => iterationArena(0, memory, bad), RangeError);
	assert.throws(() => iterationArena(8, memory), RangeError);
	assert.throws(() => iterationArena(0, 0), RangeError);
	assert.throws(() => iterationArena(0, memory, { frameBytes: -1 }), RangeError);
	// a tracked frame adds one shadow per slot after the write bitmaps and moves nothing else
	const framed = iterationArena(1 << 20, memory, {
		batch: 4,
		logCapacity: 10,
		slotBytes: 4096,
		frameBytes: 1920
	});
	assert.equal(framed.wmaps, a.wmaps);
	assert.equal(framed.frameShadow, a.wmaps + 4 * a.wsize);
	assert.equal(framed.frameSlotBytes, iterationFrameShadow(1920).bytes);
	assert.equal(framed.bytes, a.bytes + 4 * framed.frameSlotBytes);
	// 60 granules: 240 bytes of written bits, 4 of pad, the exposed bits, 4 of pad, 64-aligned
	assert.deepEqual(iterationFrameShadow(1920), { exposed: 244, bytes: 512 });
	assert.deepEqual(iterationFrameShadow(0), { exposed: 0, bytes: 0 });
	assert.equal(a.frameSlotBytes, 0);
});

test('iteration arguments advance strided locals and keep the rest', () => {
	const locals = [
		{ local: 0, kind: 'stride', stride: 8, argument: 0 },
		{ local: 5, kind: 'invariant', argument: 1 },
		{ local: 4, kind: 'induction', stride: -1 },
		{ local: 3, kind: 'frame', argument: 2 }
	] as const;
	assert.deepEqual(iterationArguments(locals, { 0: 100, 5: 7n }, 3, 999), [124, 7n, 999]);
	assert.deepEqual(iterationArguments(locals, { 0: 2 ** 31 - 4, 5: 0 }, 1, 0)[0], -(2 ** 31) + 4);
	assert.throws(() => iterationArguments(locals, { 0: 1 }, 0, 0), RangeError);
});

test('iteration arguments read a run-time step from the loop-entry values', () => {
	const stepped = (stride: number) =>
		[
			{ local: 1, kind: 'stride', stride, strideLocal: 7, argument: 0 },
			{ local: 7, kind: 'invariant', argument: 1 }
		] as const;
	assert.deepEqual(iterationArguments(stepped(1), { 1: 100, 7: 24 }, 3, 0), [172, 24]);
	assert.deepEqual(iterationArguments(stepped(-1), { 1: 100, 7: 24 }, 3, 0), [28, 24]);
	assert.deepEqual(iterationArguments(stepped(1), { 1: 100, 7: -8 }, 3, 0), [76, -8]);
	assert.deepEqual(iterationArguments(stepped(1), { 1: 100, 7: 0 }, 5, 0), [100, 0]);
	assert.deepEqual(iterationArguments(stepped(1), { 1: 100, 7: 24 }, 0, 0), [100, 24]);
	// modulo 2^32, also where the product passes 2^53
	assert.deepEqual(
		iterationArguments(stepped(1), { 1: 8, 7: 2 ** 31 }, 3, 0)[0],
		(8 + 2 ** 31) | 0
	);
	assert.deepEqual(
		iterationArguments(stepped(1), { 1: 0, 7: 0x7fffffff }, 0x7fffffff, 0)[0],
		Math.imul(0x7fffffff, 0x7fffffff)
	);
	assert.throws(() => iterationArguments(stepped(1), { 1: 100 }, 1, 0), RangeError);
});

test('the verdict applies RAW, WAR and WAW to the returned lists', () => {
	const o = (
		written: number[],
		reads: number[],
		status = 0,
		frameWritten: number[] = [],
		frameExposed: number[] = []
	): IterationOutcome => ({
		index: 0,
		status,
		entries: written.length,
		runMs: 0,
		written: Int32Array.from(written),
		reads: Int32Array.from(reads),
		frameWritten: Uint32Array.from(frameWritten),
		frameExposed: Uint32Array.from(frameExposed)
	});
	// write granules are 32 bytes, read runs [start, length] are 64-byte granules
	const free = iterationVerdict([o([0], [10, 1]), o([2], [12, 1]), o([4], [14, 2])]);
	assert.deepEqual(free, {
		first: -1,
		firstFailure: -1,
		frameFirst: -1,
		conflicts: { raw: 0, war: 0, waw: 0, frame: 0 }
	});
	const raw = iterationVerdict([o([6], []), o([], [2, 2]), o([], [9, 1])]);
	assert.equal(raw.first, 1);
	assert.equal(raw.conflicts.raw, 1);
	const war = iterationVerdict([o([], [3, 1]), o([], []), o([6, 7], [])]);
	assert.equal(war.first, 0);
	assert.equal(war.conflicts.war, 1);
	const waw = iterationVerdict([o([], []), o([9], []), o([9, 11], [])]);
	assert.equal(waw.first, 1);
	assert.equal(waw.conflicts.waw, 1);
	assert.equal(iterationVerdict([o([], []), o([], [], 1)]).first, 1);
	assert.equal(iterationVerdict([o([6], []), o([], [3, 1])], ['raw']).first, -1);
	// frame bits are one i32 per 32-byte granule: an iteration fails when it read a byte before
	// writing it that an earlier iteration wrote
	const carried = iterationVerdict([
		o([], [], 0, [0b10000]),
		o([], [], 0, [], [0b1]),
		o([], [], 0, [], [0b11000]),
		o([], [], 0, [], [0b10000])
	]);
	assert.equal(carried.first, 2);
	assert.equal(carried.frameFirst, 2);
	assert.equal(carried.conflicts.frame, 2);
	// a write after the read, a read of a byte nobody wrote, and data beside a written byte are free
	const clear = iterationVerdict([
		o([], [], 0, [], [0b10000]),
		o([], [], 0, [0b10000], []),
		o([], [], 0, [0b1000], [0b1])
	]);
	assert.equal(clear.first, -1);
	assert.equal(clear.conflicts.frame, 0);
	// a write in a later granule word does not meet a read in the first
	assert.equal(iterationVerdict([o([], [], 0, [0, 1]), o([], [], 0, [], [1, 0])]).first, -1);
	assert.equal(iterationVerdict([o([], [], 0, [1]), o([], [], 0, [], [1])], ['frame']).first, -1);
});

test('disjoint footprints equal the serial run with no replays at widths 1, 2, 4 and 8', () => {
	for (const width of widths) {
		for (const n of [1, 5, 32, 70]) {
			const r = compare(rig, width, disjoint(n));
			assert.ok(r.equal, `width ${width} n ${n}`);
			assert.equal(r.report.replayed, 0);
			assert.equal(r.report.failedBatches, 0);
			assert.equal(r.report.regions, n);
			assert.ok(r.report.undoEntries > 0);
		}
	}
	assert.equal(compare(rig, 4, disjoint(0)).report.batches, 0);
});

test('RAW, WAR and WAW each force replays and still equal the serial run', () => {
	const cases = [
		['raw', rawPlan(32)],
		['war', warPlan(32)],
		['waw', wawPlan(32)]
	] as const;
	for (const width of widths) {
		for (const [kind, plan] of cases) {
			const r = compare(rig, width, plan);
			assert.ok(r.equal, `${kind} width ${width}`);
			assert.ok(r.report.replayed > 0, `${kind} width ${width}`);
			assert.ok(r.report.conflicts[kind] > 0, `${kind} width ${width}`);
			assert.equal(r.report.rolledBack, r.report.replayed);
		}
	}
});

test('a batch keeps the iterations before the first failure', () => {
	const plan = rawPlan(96);
	for (let i = 3; i < 88; i += 4) if (i < 56 || i >= 64) plan.src[i] = srcCell(i);
	const r = compare(rig, 4, plan);
	assert.ok(r.equal);
	assert.equal(r.report.batches, 3);
	assert.equal(r.report.failedBatches, 2);
	assert.equal(r.report.replayed, 10);
	assert.equal(r.report.stopped, undefined);
});

test('a batch that replays more than half of its iterations ends the dispatch', () => {
	// the first failure is iteration 43, so 21 of the 32 iterations of the second batch replay
	const plan = rawPlan(72);
	for (let i = 3; i < 40; i += 4) plan.src[i] = srcCell(i);
	const r = compare(rig, 4, plan);
	assert.ok(r.equal);
	assert.equal(r.report.batches, 2);
	assert.equal(r.report.regions, 64);
	assert.equal(r.report.stopped, 'dependency');
	assert.equal(r.report.replayed, 64 - 43);
	assert.equal(r.report.serial, 8);
	assert.ok(r.report.conflicts.raw > 0);
});

test('without the WAR and WAW checks a reversed schedule diverges from the serial run', () => {
	const cases = [
		['raw', rawPlan(32)],
		['war', warPlan(32)],
		['waw', wawPlan(32)]
	] as const;
	for (const [kind, plan] of cases) {
		const full = compare(rig, 1, plan, { schedule: 'reverse' });
		assert.ok(full.equal, `${kind} with every check`);
		assert.ok(full.report.replayed > 0);
		const weak = compare(rig, 1, plan, { schedule: 'reverse', skip: [kind] });
		assert.equal(weak.equal, false, `${kind} without its check`);
		assert.equal(weak.report.replayed, 0);
	}
	// the reader rule alone, the rule of a RAW-only validator, misses the other two hazards
	for (const plan of [warPlan(32), wawPlan(32)]) {
		const raw = compare(rig, 1, plan, { schedule: 'reverse', skip: ['war', 'waw'] });
		assert.equal(raw.equal, false);
	}
});

test('a genuine trap in one iteration ends as the serial run does', () => {
	for (const width of [1, 2, 4]) {
		const plan = disjoint(20);
		plan.dst[11] = 0x7ffffff0;
		const r = compare(rig, width, plan);
		assert.ok(r.equal, `width ${width}`);
		assert.ok(r.want.error instanceof WebAssembly.RuntimeError);
		assert.ok(r.got.error instanceof WebAssembly.RuntimeError);
		assert.ok(r.report.traps >= 1);
		assert.ok(r.report.fallbacks >= 1);
		assert.ok(r.report.replayed >= 1);
	}
});

test('an iteration that exhausts its undo log falls back and the result is equal', () => {
	const quiet = disjoint(16);
	quiet.values = Array(16).fill(0);
	const control = compare(small, 2, quiet);
	assert.ok(control.equal);
	assert.equal(control.report.exhausted, 0);
	const plan = disjoint(16);
	plan.values = Array.from({ length: 16 }, (_, i) => (i === 9 ? 7 : 0));
	const r = compare(small, 2, plan);
	assert.ok(r.equal);
	assert.ok(r.report.exhausted >= 1);
	assert.equal(r.report.traps, 0);
	assert.ok(r.report.fallbacks >= 1);
	assert.ok(r.report.replayed >= 1);
});

test('an exhausted undo log ends the dispatch even when few iterations replay', () => {
	const plan = disjoint(70);
	plan.values = Array.from({ length: 70 }, (_, i) => (i === 30 ? 7 : 0));
	const r = compare(small, 2, plan);
	assert.ok(r.equal);
	assert.equal(r.report.exhausted, 1);
	assert.equal(r.report.stopped, 'log-exhausted');
	assert.equal(r.report.batches, 1);
	// the rig's memory is at its declared maximum, so there is no room for a grown log
	assert.equal(r.report.logGrowths, 0);
	assert.equal(r.report.retried, 0);
	// iteration 30 replays, and 31 too when the other worker had claimed it before the abort; the rest
	// of the batch never starts and 32 to 69 never dispatch
	assert.ok(r.report.rolledBack >= 1 && r.report.rolledBack <= 2);
	assert.equal(r.report.replayed, r.report.rolledBack);
	assert.equal(r.report.replayed + r.report.serial, 40);
});

// a rig whose memory may grow, so a batch with an exhausted log can be retried with a larger one
const growRig = (logCeiling: number, maximum = 2048) =>
	watRig([2], { logCapacity: 5, logCeiling, maximum }, wasm(ownerSource(spillItem, { maximum })));
const exhaustingPlan = (n: number, at: number) => {
	const plan = disjoint(n);
	plan.values = Array.from({ length: n }, (_, i) => (i === at ? 7 : 0));
	return plan;
};

test('an exhausted undo log is retried once with a grown log and the result equals the serial run', async () => {
	const grow = await growRig(64);
	try {
		const pool = grow.pools.get(2)!;
		const before = grow.memory.buffer.byteLength;
		assert.equal(pool.memoryBytes, before);
		const r = compare(grow, 2, exhaustingPlan(16, 9));
		assert.ok(r.equal);
		assert.equal(r.report.logGrowths, 1);
		assert.ok(r.report.exhausted >= 1);
		// the other worker may have claimed some of 10 to 15 before the failure stopped the claims
		assert.ok(r.report.retried >= 1 && r.report.retried <= 7);
		assert.equal(r.report.stopped, undefined);
		assert.equal(r.report.replayed, 0);
		assert.equal(r.report.rolledBack, 0);
		// the iterations before the failing one stay, the rest run again, so each runs once
		assert.equal(r.report.regions, 16);
		assert.equal(r.report.traps, 0);
		assert.ok(r.report.maxLogEntries > 5 && r.report.maxLogEntries <= 64);
		// the pages came from the memory and stay for the next call
		const after = grow.memory.buffer.byteLength;
		assert.ok(after > before);
		assert.equal(pool.memoryBytes, after);
		const again = compare(grow, 2, exhaustingPlan(16, 4));
		assert.ok(again.equal);
		assert.equal(again.report.logGrowths, 1);
		assert.equal(again.report.stopped, undefined);
		assert.equal(grow.memory.buffer.byteLength, after);
		// a loop whose iterations fit the default log never asks for the pages
		const quiet = compare(grow, 2, exhaustingPlan(16, 99));
		assert.ok(quiet.equal);
		assert.equal(quiet.report.logGrowths, 0);
		assert.equal(quiet.report.retried, 0);
	} finally {
		await grow.close();
	}
});

test('an iteration that overruns the ceiling stops the dispatch after the one retry', async () => {
	// the same loop with a ceiling of 6 entries, which the failing iteration needs more than
	const grow = await growRig(6);
	try {
		const r = compare(grow, 2, exhaustingPlan(16, 9));
		assert.ok(r.equal);
		assert.equal(r.report.logGrowths, 1);
		assert.equal(r.report.stopped, 'log-exhausted');
		assert.ok(r.report.exhausted >= 2);
		assert.equal(r.report.failedBatches, 1);
		// iterations 9 to 15 are left after the retry: replayed after the failing batch or serial
		assert.equal(r.report.replayed + r.report.serial, 7);
		assert.equal(r.report.regions - r.report.replayed, 9);
	} finally {
		await grow.close();
	}
	// a ceiling at the capacity, or a memory that cannot grow, leaves today's behavior
	for (const [ceiling, maximum] of [
		[5, 2048],
		[64, wat.pages]
	] as const) {
		const off = await growRig(ceiling, maximum);
		try {
			const before = off.memory.buffer.byteLength;
			const r = compare(off, 2, exhaustingPlan(16, 9));
			assert.ok(r.equal);
			assert.equal(r.report.logGrowths, 0);
			assert.equal(r.report.stopped, 'log-exhausted');
			assert.equal(off.memory.buffer.byteLength, before);
		} finally {
			await off.close();
		}
	}
});

test('a batch that shows a hazard is not retried on a grown log', async () => {
	// iterations 1 and 3 and so on write what the one before wrote; the grown log would not help
	const grow = await growRig(64);
	try {
		const plan = exhaustingPlan(16, 9);
		for (let i = 1; i < 9; i += 2) plan.dst[i] = dstCell(i - 1);
		const r = compare(grow, 2, plan);
		assert.ok(r.equal);
		assert.ok(r.report.conflicts.waw > 0);
		assert.equal(r.report.logGrowths, 0);
		assert.equal(r.report.retried, 0);
		assert.equal(r.report.stopped, 'log-exhausted');
		// without the hazard the same loop is retried and dispatched
		const clean = compare(grow, 2, exhaustingPlan(16, 9));
		assert.ok(clean.equal);
		assert.equal(clean.report.logGrowths, 1);
	} finally {
		await grow.close();
	}
});

test('the log ceiling defaults to 64 times the default capacity and must be a positive integer', async () => {
	assert.equal(iterationLogCeiling, 64 * 2048);
	const grow = await growRig(64);
	try {
		for (const logCeiling of [0, -1, 1.5, Number.NaN])
			await assert.rejects(
				IterationPool.open(
					grow.route,
					new WebAssembly.Memory({
						initial: wat.pages,
						maximum: wat.pages,
						shared: true
					}),
					{ arenaBase: wat.arena, logCeiling }
				),
				RangeError
			);
	} finally {
		await grow.close();
	}
});

test('the overlap family replays at every width and the disjoint family never does', () => {
	for (const width of widths) {
		for (const n of [8, 32, 50]) {
			const clean = compare(rig, width, disjoint(n));
			assert.ok(clean.equal);
			assert.equal(clean.report.replayed, 0, `disjoint width ${width} n ${n}`);
			for (const make of [rawPlan, wawPlan]) {
				const r = compare(rig, width, make(n));
				assert.ok(r.equal);
				assert.ok(r.report.replayed > 0, `${make.name} width ${width} n ${n}`);
			}
		}
	}
});

test('seeded random programs equal the serial run', () => {
	const rows = randomSeeds(rig, 1, 16);
	assert.deepEqual(
		rows.filter((row) => !row.equal),
		[]
	);
	assert.ok(rows.some((row) => row.replayed > 0));
});

test('the pool refuses what it cannot run', async () => {
	await assert.rejects(
		IterationPool.open({ eligible: false, locals: [], diagnostics: [] }, rig.memory, {
			arenaBase: rig.arenaBase
		}),
		TypeError
	);
	await assert.rejects(
		IterationPool.open(rig.route, rig.memory, { arenaBase: rig.arenaBase + 1, width: 1 }),
		RangeError
	);
	await assert.rejects(
		IterationPool.open(rig.route, rig.memory, { arenaBase: 1 << 21, width: 1 }),
		RangeError
	);
	const other = await watRig([1]);
	await other.close();
	assert.throws(() => other.pools.get(1)!.run({ trip: 1, frameBase: 0, entry: {}, replay() {} }));
	await other.close();
});

test('the pool refuses a bad width, a slot below the frame size and a bad trip count', async () => {
	for (const width of [0, 65, 1.5])
		await assert.rejects(
			IterationPool.open(rig.route, rig.memory, { arenaBase: rig.arenaBase, width }),
			/invalid worker count/
		);
	await assert.rejects(
		IterationPool.open(rig.route, rig.memory, {
			arenaBase: rig.arenaBase,
			width: 1,
			logCapacity: 64,
			slotBytes: wat.frame
		}),
		/slot is smaller than the frame/
	);
	await assert.rejects(
		IterationPool.open(rig.route, new WebAssembly.Memory({ initial: 1, maximum: 1 }), {
			arenaBase: rig.arenaBase,
			width: 1
		}),
		/requires shared memory/
	);
	const pool = rig.pools.get(1)!;
	const job = { frameBase: 0, entry: {}, replay() {} };
	for (const trip of [-1, 1.5, Number.NaN])
		assert.throws(() => pool.run({ ...job, trip }), /invalid trip count/);
	// a run of zero iterations does nothing and reports no workers
	const none = pool.run({ ...job, trip: 0 });
	assert.deepEqual([none.regions, none.workers, none.batches], [0, 0, 0]);
	const spare = await watRig([2]);
	await spare.pools.get(2)![Symbol.asyncDispose]();
	assert.throws(() => spare.pools.get(2)!.run({ ...job, trip: 1 }), /iteration pool is closed/);
	await spare.close();
});

test('the BLAKE3 consumer hashes through the executor to the native digests', async () => {
	const sizes = [0, 1, 63, 64, 1024, 1025, 2048, 4100, 3000];
	const subject = await blake3Rig(sizes, [1, 4], {});
	try {
		const want = serialRun(subject.rig, subject.image, subject.args);
		assert.equal(want.error, undefined);
		for (const width of [1, 4]) {
			const got = iterationRun(subject.rig, width, subject.image, subject.args);
			assert.equal(got.error, undefined);
			assert.equal(firstDifference(subject.rig, want.bytes, got.bytes), -1);
			assert.equal(got.report!.replayed, 0);
			assert.equal(got.report!.regions, sizes.length);
			assert.equal(
				digests(got, subject.out, sizes.length),
				digests(want, subject.out, sizes.length)
			);
		}
		assert.equal(
			Buffer.from(want.bytes.subarray(subject.out, subject.out + 32)).toString('hex'),
			'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
		);
		subject.rig.memory.grow(1);
		const grown = iterationRun(subject.rig, 1, subject.image, subject.args);
		assert.match(String((grown.error as Error).message), /changed size/);
	} finally {
		await subject.rig.close();
	}
});

const accepts = (plainIterationMs: number) => ({
	plainIterationMs,
	remainingSerialMs: 0,
	floorMs: 0,
	admitted: true
});

test('iteration 0 runs first on the owner and the batches cover the rest', () => {
	// the family reads a value its owner stored in the frame; nothing writes it, so it dispatches
	const run = compare(rig, 4, disjoint(40), { admit: accepts });
	assert.ok(run.equal);
	assert.equal(run.report.serial, 1);
	assert.equal(run.report.regions, 39);
	assert.equal(run.report.batches, 2);
	assert.equal(run.report.replayed, 0);
	assert.equal(run.report.conflicts.frame, 0);
	assert.equal(run.report.stopped, undefined);
	// iteration 0 reads a cell iteration 3 writes: it ran first, so the read sees the old value
	const plan = disjoint(70);
	plan.src[0] = dstCell(3);
	const early = compare(rig, 4, plan, { admit: accepts });
	assert.ok(early.equal);
	assert.equal(early.report.replayed, 0);
	// a read of what iteration 0 wrote is the serial order and no conflict
	const later = disjoint(70);
	later.src[3] = dstCell(0);
	const after = compare(rig, 4, later, { admit: accepts });
	assert.ok(after.equal);
	assert.equal(after.report.replayed, 0);
	assert.equal(after.report.conflicts.raw, 0);
});

test('a refusal after iteration 0 runs the rest serially', () => {
	const seen: number[] = [];
	const plan = disjoint(40);
	const { image, args } = planImage(plan);
	const refuse = (plainIterationMs: number) => {
		seen.push(plainIterationMs);
		return { ...accepts(plainIterationMs), admitted: false };
	};
	const refused = iterationRun(rig, 4, image, args, { admit: refuse });
	assert.equal(refused.error, undefined);
	assert.equal(seen.length, 1);
	assert.ok(seen[0]! > 0);
	assert.equal(refused.report!.regions, 0);
	assert.equal(refused.report!.batches, 0);
	assert.equal(refused.report!.replayed, 0);
	assert.equal(refused.report!.serial, 40);
	assert.equal(refused.report!.stopped, 'no-admission');
	assert.equal(refused.report!.admission!.admitted, false);
	const want = serialRun(rig, image, args);
	assert.equal(firstDifference(rig, want.bytes, refused.bytes), -1);
	// iteration 0 of an empty loop is not run, and `admit` is not called
	const empty = compare(rig, 4, disjoint(0), { admit: () => assert.fail('no iteration') });
	assert.equal(empty.report.serial, 0);
});

test('the batch callback ends the dispatch after two batches in a row that lose', () => {
	const seen: number[][] = [];
	const loses = (wall: number, serial: number) => {
		seen.push([wall, serial]);
		return true;
	};
	const stopped = compare(rig, 4, disjoint(70), { admit: accepts, loses });
	assert.ok(stopped.equal);
	assert.equal(stopped.report.batches, 2);
	assert.equal(stopped.report.regions, 64);
	assert.equal(stopped.report.replayed, 0);
	assert.equal(stopped.report.serial, 1 + 5);
	assert.equal(stopped.report.stopped, 'no-admission');
	assert.equal(seen.length, 2);
	assert.ok(seen[1]![0]! > 0);
	assert.equal(stopped.report.admission!.batchWallMs, seen[1]![0]);
	assert.equal(stopped.report.admission!.batchSerialMs, seen[1]![1]);
	// the last batch has nothing after it to stop
	const whole = compare(rig, 4, disjoint(33), { admit: accepts, loses });
	assert.ok(whole.equal);
	assert.equal(whole.report.regions, 32);
	assert.equal(whole.report.stopped, undefined);
	assert.equal(whole.report.replayed, 0);
	const kept = compare(rig, 4, disjoint(70), { admit: accepts, loses: () => false });
	assert.equal(kept.report.batches, 3);
	assert.equal(kept.report.stopped, undefined);
	// one batch that collapses is a verdict by itself
	const collapsed = compare(rig, 4, disjoint(70), {
		admit: accepts,
		loses: () => false,
		collapses: () => true
	});
	assert.ok(collapsed.equal);
	assert.equal(collapsed.report.batches, 1);
	assert.equal(collapsed.report.stopped, 'no-admission');
	// a slow batch followed by a fast one is not a verdict
	let calls = 0;
	const once = compare(rig, 4, disjoint(100), {
		admit: accepts,
		loses: () => calls++ === 0 || calls === 3
	});
	assert.ok(once.equal);
	assert.equal(once.report.batches, 4);
	assert.equal(once.report.stopped, undefined);
});

test('a refused loop is timed in serial blocks and dispatched once the remaining iterations pay', () => {
	const refuse = (plainIterationMs: number) => ({
		...accepts(plainIterationMs),
		admitted: false
	});
	// iteration 0, then blocks of 1, 2 and 4 iterations end at iterations 2, 4 and 8
	const asked: number[][] = [];
	let calls = 0;
	const late = compare(rig, 4, disjoint(40), {
		admit: refuse,
		reconsider: (ms, remaining) => {
			asked.push([ms, remaining]);
			return ++calls === 3;
		}
	});
	assert.ok(late.equal);
	assert.deepEqual(
		asked.map((a) => a[1]),
		[38, 36, 32]
	);
	assert.ok(asked.every((a) => Number.isFinite(a[0]!) && a[0]! >= 0));
	assert.equal(late.report.admission!.admitted, true);
	assert.equal(late.report.admission!.readmittedAt, 8);
	assert.equal(late.report.stopped, undefined);
	assert.equal(late.report.serial, 8);
	assert.equal(late.report.regions, 32);
	assert.equal(late.report.batches, 1);
	assert.equal(late.report.replayed, 0);
	// never worth it: the blocks grow to a batch, every block asks, and the loop stays serial
	const never: number[] = [];
	const refused = compare(rig, 4, disjoint(40), {
		admit: refuse,
		reconsider: (_, remaining) => {
			never.push(remaining);
			return false;
		}
	});
	assert.ok(refused.equal);
	assert.deepEqual(never, [38, 36, 32, 24, 8]);
	assert.equal(refused.report.stopped, 'no-admission');
	assert.equal(refused.report.admission!.readmittedAt, undefined);
	assert.equal(refused.report.serial, 40);
	assert.equal(refused.report.batches, 0);
	// without a reconsider callback a refusal is final, as before
	const final = compare(rig, 4, disjoint(40), { admit: refuse });
	assert.equal(final.report.serial, 40);
	assert.equal(final.report.admission!.readmittedAt, undefined);
});

test('the estimate is asked before each later batch, and a no ends the dispatch', () => {
	const asked: number[][] = [];
	const stopped = compare(rig, 4, disjoint(100), {
		admit: accepts,
		reconsider: (ms, remaining) => {
			asked.push([ms, remaining]);
			return false;
		}
	});
	assert.ok(stopped.equal);
	// the first batch is dispatched without asking; the second is not dispatched
	assert.equal(asked.length, 1);
	assert.equal(asked[0]![1], 100 - 33);
	assert.equal(stopped.report.batches, 1);
	assert.equal(stopped.report.regions, 32);
	assert.equal(stopped.report.stopped, 'no-admission');
	assert.equal(stopped.report.serial, 1 + 67);
	// what it was asked with is the estimate the report holds, and the batch rule saw its multiple
	assert.equal(asked[0]![0], stopped.report.admission!.estimateMs);
	assert.ok(asked[0]![0]! > 0);
	const seen: number[][] = [];
	const yes: number[] = [];
	const kept = compare(rig, 4, disjoint(100), {
		admit: accepts,
		loses: (wall, serial) => {
			seen.push([wall, serial]);
			return false;
		},
		reconsider: (_, remaining) => {
			yes.push(remaining);
			return true;
		}
	});
	assert.ok(kept.equal);
	assert.deepEqual(yes, [67, 35, 3]);
	assert.equal(kept.report.batches, 4);
	assert.equal(kept.report.stopped, undefined);
	assert.equal(seen.length, 4);
	assert.equal(kept.report.admission!.batchSerialMs, seen[3]![1]);
});

test('the pool checks every iteration of the batch for a read of a byte an earlier one wrote', async () => {
	const rigOf = (item: string) =>
		watRig([4], {}, wasm(ownerSource(item, { maximum: wat.pages })));
	const frame = (bytes: Uint8Array) => Buffer.from(bytes.subarray(PAGE - wat.frame, PAGE));
	for (const [name, item, replayed] of [
		['k > 0', lateItem(afterFirst), 31],
		['k = 5', lateItem(atIteration(5)), 32 - 5],
		['last of the batch', lateItem(atIteration(31)), 32 - 31]
	] as const) {
		const late = await rigOf(item);
		try {
			const run = compare(late, 4, distinct(40));
			assert.ok(run.equal, name);
			assert.ok(frame(run.want.bytes).equals(frame(run.got.bytes)), name);
			assert.ok(run.report.conflicts.frame > 0, name);
			assert.equal(run.report.failedBatches, 1, name);
			assert.equal(run.report.batches, 1, name);
			assert.equal(run.report.replayed, replayed, name);
			// without the frame check the later iteration keeps a stale read
			const weak = compare(late, 4, distinct(40), { skip: ['frame'] });
			assert.equal(weak.equal, false, `${name} without its check`);
			assert.equal(weak.report.conflicts.frame, 0);
		} finally {
			await late.close();
		}
	}
});

// #region Folio.run on the iteration route
const PAGE = 65536;

// the loops of these programs are far below the cost of a dispatch, so the tests that follow force
// admission; the ones about the decision set the seam themselves
beforeEach(() => {
	admissionSeam.scale = 1;
	admissionSeam.batchScale = 1;
	admissionSeam.force = true;
});
afterEach(() => {
	admissionSeam.scale = 1;
	admissionSeam.batchScale = 1;
	admissionSeam.force = false;
});
const readConsumer = () => new Uint8Array(readFileSync(blake3File));

// the owner frame of the BLAKE3 consumer sits at the top of its first stack page
const consumerFrame = () => {
	const bytes = readConsumer();
	const frame = prepare(bytes).iterationRoute!.frame!;
	const module = binaryen.readBinary(bytes);
	try {
		const init = binaryen.getExpressionInfo(
			binaryen.getGlobalInfo(module.getGlobal(frame.global)).init
		) as unknown as { value: number };
		return [init.value - frame.size, init.value] as const;
	} finally {
		module.dispose();
	}
};
const frameOf = (memory: WebAssembly.Memory, [from, to]: readonly [number, number]) =>
	Buffer.from(new Uint8Array(memory.buffer, from, to - from));

function wasm(text: string): Uint8Array {
	binaryen.setDebugInfo(true);
	const module = binaryen.parseText(text);
	try {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		module.setFeatures(binaryen.Features.All & ~compact);
		assert.ok(module.validate());
		return module.emitBinary();
	} finally {
		module.dispose();
		binaryen.setDebugInfo(false);
	}
}

// an owner whose loop calls $item once per table entry; `item` is the body of $item
const ownerSource = (
	item: string,
	options: {
		guard?: boolean;
		extra?: string;
		maximum?: number;
		shared?: boolean;
		result?: boolean;
	} = {}
) => `(module
	(import "env" "memory" (memory ${wat.pages} ${options.maximum ?? 128}${options.shared ? ' shared' : ''}))
	(global $sp (mut i32) (i32.const 65536))
	(func $item (param $t i32) (param $f i32) (local $src i32) (local $dst i32) (local $s i32)
		(local.set $src (i32.load (local.get $t)))
		(local.set $dst (i32.load offset=4 (local.get $t)))
		${item})
	(func $run (export "run") (param $t i32) (param $n i32) ${options.result ? '(result i32)' : ''} (local $frame i32) (local $c i32)
		(local.set $frame (i32.sub (global.get $sp) (i32.const 64)))
		(global.set $sp (local.get $frame))
		(i32.store (local.get $frame) (i32.const 0))
		(block $done
			${options.guard === false ? '' : '(br_if $done (i32.eqz (local.get $n)))'}
			(local.set $c (local.get $n))
			(loop $each
				(call $item (local.get $t) (local.get $frame))
				(local.set $t (i32.add (local.get $t) (i32.const 8)))
				(br_if $each (local.tee $c (i32.sub (local.get $c) (i32.const 1))))))
		(global.set $sp (i32.add (local.get $frame) (i32.const 64)))
		${options.result ? '(i32.add (local.get $t) (local.get $c))' : ''})
	${options.extra ?? ''})`;

const plainItem = `(i32.store (local.get $dst) (i32.add (i32.load (local.get $src)) (i32.const 3)))`;
const stackItem = `
	(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
	(global.set $sp (local.get $s))
	(i32.store (local.get $s) (i32.const 99))
	(i32.store (local.get $dst)
		(i32.add (i32.load offset=48 (local.get $f)) (i32.load (local.get $s))))
	(global.set $sp (i32.add (local.get $s) (i32.const 16)))`;
const carriedItem = `
	(i32.store (local.get $f) (i32.add (i32.load (local.get $f)) (i32.load (local.get $src))))
	(i32.store (local.get $dst) (i32.load (local.get $f)))`;
const trapItem = `
	(if (i32.eq (i32.load (local.get $src)) (i32.const 777)) (then (unreachable)))
	${plainItem}`;

// memory outside the stack zone [0, 65536); the program's own pages end where the arena begins
const programPages = (memory: WebAssembly.Memory, pages: number) =>
	new Uint8Array(memory.buffer, PAGE, (pages - 1) * PAGE);

interface Outcome {
	value?: unknown;
	report?: ExecutionReport;
	error?: unknown;
	memory: WebAssembly.Memory;
}

// the serial program on a plain memory, and the same call through Folio.run
async function both(
	source: Uint8Array,
	plan: Plan,
	workers: number,
	trips = plan.src.length,
	entry = 'run',
	options: { iterationLogCeiling?: number; iterationSecondChance?: boolean } = {}
) {
	const { image, args } = planImage(plan);
	args[1] = trips;
	const memory = new WebAssembly.Memory({ initial: wat.pages, maximum: 128 });
	new Uint8Array(memory.buffer).set(image);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory }
	});
	const want: Outcome = { memory };
	try {
		want.value = (instance.exports[entry] as CallableFunction)(...args);
	} catch (error) {
		want.error = error;
	}
	const folio = await Folio.open(source, { workers, ...options });
	new Uint8Array(folio.memory.buffer).set(image);
	const got: Outcome = { memory: folio.memory };
	try {
		got.report = await folio.run(entry, args);
	} catch (error) {
		got.error = error;
	}
	const equal =
		Buffer.compare(
			programPages(want.memory, wat.pages),
			programPages(got.memory, wat.pages)
		) === 0 &&
		sameError(want.error, got.error) &&
		want.value === got.report?.values[0];
	return { want, got, equal, folio };
}

const sizes = [0, 1, 63, 64, 1024, 1025, 2048, 4100, 3000, 700, 5, 9000];

// inputs and the entry table of the BLAKE3 consumer, in the pages its import declares
// with `chain`, every fourth entry hashes the digest of the entry before it
function consumerImage(memory: WebAssembly.Memory, chain = false) {
	const bytes = new Uint8Array(memory.buffer);
	const view = new DataView(memory.buffer);
	const table = 0x11000;
	const out = table + 64 * 16;
	let at = out + 32 * sizes.length + 64;
	sizes.forEach((size, i) => {
		bytes.set(generate(i, size), at);
		const earlier = chain && i % 4 === 3;
		view.setUint32(table + 8 * i, earlier ? out + 32 * (i - 1) : at, true);
		view.setUint32(table + 8 * i + 4, earlier ? 32 : size, true);
		at += ((size + 63) & ~63) + 64;
	});
	return [table, sizes.length, out];
}

function consumerReference(chain = false) {
	const memory = new WebAssembly.Memory({ initial: 16, maximum: 65536 });
	const args = consumerImage(memory, chain);
	const instance = new WebAssembly.Instance(
		new WebAssembly.Module(Uint8Array.from(readConsumer())),
		{
			env: { memory }
		}
	);
	(instance.exports.hash_all as CallableFunction)(...args);
	return { memory, args };
}

test('Folio.run sends the BLAKE3 consumer loop to workers under default options', async () => {
	const want = consumerReference();
	for (const workers of [2, 4]) {
		const folio = await Folio.open(readConsumer(), { workers, profile: workers === 2 });
		try {
			const args = consumerImage(folio.memory);
			// the declared 16 pages, then the arena above them
			assert.ok(folio.memory.buffer.byteLength > 16 * PAGE);
			assert.equal(folio.capabilities.automaticRegions, 'iteration');
			for (let round = 0; round < 2; round++) {
				const report = await folio.run('hash_all', args);
				assert.deepEqual(report.values, [sizes.length]);
				assert.equal(report.extraction, 'iteration');
				assert.equal(report.mode, 'speculative');
				assert.equal(report.workers, workers);
				assert.equal(report.regions, sizes.length - 1);
				assert.equal(report.iteration!.regions, sizes.length - 1);
				assert.equal(report.iteration!.serial, 1);
				assert.equal(report.iteration!.replayed, 0);
				assert.equal(report.iteration!.stopped, undefined);
				assert.deepEqual(report.iteration!.conflicts, { raw: 0, war: 0, waw: 0, frame: 0 });
				assert.equal(report.reason, undefined);
				assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
				// the committed owner frame is the frame the serial program leaves
				assert.ok(
					frameOf(folio.memory, consumerFrame()).equals(
						frameOf(want.memory, consumerFrame())
					)
				);
				if (workers === 2) assert.ok(report.profile!.wallMs > 0);
			}
			// a raw export call bypasses the route and runs the original loop
			(folio.exports.hash_all as CallableFunction)(...args);
			assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
			assert.equal(
				Buffer.from(
					programPages(folio.memory, 16).subarray(
						0x11000 - PAGE + 64 * 16,
						0x11000 - PAGE + 64 * 16 + 32
					)
				).toString('hex'),
				'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
			);
		} finally {
			await folio.close();
		}
	}
});

test('BLAKE3 entries that hash an earlier digest replay and equal the native run', async () => {
	const want = consumerReference(true);
	const folio = await Folio.open(readConsumer(), { workers: 4 });
	try {
		const report = await folio.run('hash_all', consumerImage(folio.memory, true));
		assert.equal(report.extraction, 'iteration');
		assert.ok(report.iteration!.replayed > 0);
		assert.equal(report.reason, 'dependency');
		assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
	} finally {
		await folio.close();
	}
});

test('one worker, a single iteration and parallel off keep the serial program', async () => {
	const want = consumerReference();
	const one = await Folio.open(readConsumer(), { workers: 1 });
	const four = await Folio.open(readConsumer(), { workers: 4 });
	try {
		const args = consumerImage(one.memory);
		const report = await one.run('hash_all', args);
		assert.equal(report.mode, 'serial');
		assert.equal(report.iteration, undefined);
		assert.equal(one.capabilities.automaticRegions, 'none');
		assert.deepEqual(programPages(one.memory, 16), programPages(want.memory, 16));
		consumerImage(four.memory);
		const off = await four.run('hash_all', args, { parallel: 'off' });
		assert.equal(off.mode, 'serial');
		assert.equal(off.reason, 'requested');
		assert.equal(off.iteration, undefined);
		assert.deepEqual(programPages(four.memory, 16), programPages(want.memory, 16));
		const few = await four.run('hash_all', [args[0]!, 1, args[2]!]);
		assert.equal(few.mode, 'serial');
		assert.equal(few.reason, 'no-admission');
		const capped = await four.run('hash_all', args, { maximumWorkers: 1 });
		assert.equal(capped.reason, 'single-region');
		assert.deepEqual(programPages(four.memory, 16), programPages(want.memory, 16));
	} finally {
		await one.close();
		await four.close();
	}
});

test('a host memory is grown for the arena when it is shared and refused otherwise', async () => {
	const want = consumerReference();
	const shared = new WebAssembly.Memory({ initial: 16, maximum: 4096, shared: true });
	const grown = await Folio.open(readConsumer(), { workers: 2, memory: shared });
	const unshared = await Folio.open(readConsumer(), {
		workers: 2,
		memory: new WebAssembly.Memory({ initial: 16, maximum: 4096 })
	});
	try {
		assert.equal(grown.memory, shared);
		assert.ok(shared.buffer.byteLength > 16 * PAGE);
		const report = await grown.run('hash_all', consumerImage(grown.memory));
		assert.equal(report.extraction, 'iteration');
		assert.deepEqual(programPages(grown.memory, 16), programPages(want.memory, 16));
		assert.equal(unshared.memory.buffer.byteLength, 16 * PAGE);
		const result = await unshared.run('hash_all', consumerImage(unshared.memory));
		assert.equal(result.mode, 'serial');
		assert.equal(result.reason, 'no-arena');
		assert.match(unshared.diagnostics.join('\n'), /iteration route refused: the host memory/);
		assert.deepEqual(programPages(unshared.memory, 16), programPages(want.memory, 16));
	} finally {
		await Promise.all([grown.close(), unshared.close()]);
	}
	// a shared host memory that cannot grow, and a declared maximum below the arena
	const cases = [
		{
			source: wasm(ownerSource(plainItem, { shared: true })),
			memory: new WebAssembly.Memory({
				initial: wat.pages,
				maximum: wat.pages,
				shared: true
			}),
			detail: /cannot hold an arena/
		},
		{
			source: wasm(ownerSource(plainItem, { maximum: 40 })),
			memory: undefined,
			detail: /declared maximum of 40 pages/
		}
	];
	for (const { source, memory, detail } of cases) {
		const folio = await Folio.open(source, { workers: 2, memory });
		try {
			const { image, args } = planImage(disjoint(20));
			new Uint8Array(folio.memory.buffer).set(image);
			const report = await folio.run('run', args);
			assert.equal(report.mode, 'serial');
			assert.equal(report.reason, 'no-arena');
			assert.match(folio.diagnostics.join('\n'), detail);
			assert.equal(folio.memory.buffer.byteLength, wat.pages * PAGE);
			assert.equal(new Uint32Array(folio.memory.buffer, dstCell(19), 1)[0], 100 + 3 * 19 + 3);
		} finally {
			await folio.close();
		}
	}
});

test('a frame-carried accumulator is replayed and the run equals the serial program', async () => {
	const source = wasm(ownerSource(carriedItem));
	const plan = disjoint(40);
	plan.values = Array.from({ length: 40 }, (_, i) => 5 + i);
	const run = await both(source, plan, 4);
	try {
		assert.ok(run.equal);
		assert.equal(run.got.report!.reason, 'frame-carried dependence');
		assert.equal(run.got.report!.iteration!.stopped, 'frame-carried dependence');
		// iteration 0 ran serially, iteration 2 reads what 1 wrote, and 33 to 39 never dispatch
		assert.equal(run.got.report!.iteration!.rolledBack, 31);
		assert.equal(run.got.report!.iteration!.replayed, 31);
		assert.equal(run.got.report!.iteration!.serial, 1 + 7);
		assert.equal(run.got.report!.extraction, 'iteration');
		// the serial program sums the cells; a private frame per iteration would not
		const sums = new Uint32Array(run.want.memory.buffer, dstCell(0), 1);
		assert.equal(sums[0], 5);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(39), 1)[0], (5 + 44) * 20);
	} finally {
		await run.folio.close();
	}
});

// an owner whose iteration writes frame cell 4 from its source and reads it back only where
// `cond` holds, so iteration k sees what iteration k - 1 stored there in the serial program
const lateItem = (cond: string) => `
	(if ${cond}
		(then (i32.store (local.get $dst) (i32.add (i32.load offset=4 (local.get $f)) (i32.const 1))))
		(else (i32.store (local.get $dst) (i32.load (local.get $src)))))
	(i32.store offset=4 (local.get $f) (i32.load (local.get $src)))`;
const atIteration = (k: number) => `(i32.eq (local.get $src) (i32.const ${srcCell(k)}))`;
const afterFirst = `(i32.ne (local.get $src) (i32.const ${srcCell(0)}))`;
const ownerFrameBytes = (memory: WebAssembly.Memory) => frameOf(memory, [PAGE - wat.frame, PAGE]);
const distinct = (n: number): Plan => ({
	...disjoint(n),
	values: Array.from({ length: n }, (_, i) => 5 + i)
});

test('a frame read after an earlier iteration wrote the byte is replayed at any iteration', async () => {
	// every case must equal the serial program, the dependence is named, and the owner frame matches
	const cases: {
		name: string;
		item: string;
		trips: number;
		caught: boolean;
		batches?: number;
	}[] = [
		{ name: 'every iteration', item: carriedItem, trips: 40, caught: true, batches: 1 },
		{ name: 'k > 0', item: lateItem(afterFirst), trips: 40, caught: true, batches: 1 },
		{ name: 'k > 0 of two', item: lateItem(afterFirst), trips: 2, caught: false, batches: 1 },
		{ name: 'k = 5', item: lateItem(atIteration(5)), trips: 40, caught: true, batches: 1 },
		{
			name: 'k = 1, after iteration 0',
			item: lateItem(atIteration(1)),
			trips: 70,
			caught: false,
			batches: 3
		},
		{ name: 'k = 2', item: lateItem(atIteration(2)), trips: 70, caught: true, batches: 1 },
		{
			name: 'last of the batch',
			item: lateItem(atIteration(31)),
			trips: 40,
			caught: true,
			batches: 1
		},
		{
			name: 'first of the second batch',
			item: lateItem(atIteration(33)),
			trips: 40,
			caught: false,
			batches: 2
		},
		{ name: 'k = 50', item: lateItem(atIteration(50)), trips: 70, caught: true, batches: 2 }
	];
	for (const item of cases) {
		const run = await both(wasm(ownerSource(item.item)), distinct(item.trips), 4);
		try {
			const counts = run.got.report!.iteration!;
			assert.ok(run.equal, item.name);
			assert.ok(
				ownerFrameBytes(run.got.memory).equals(ownerFrameBytes(run.want.memory)),
				item.name
			);
			assert.equal(counts.conflicts.frame > 0, item.caught, item.name);
			assert.equal(counts.batches, item.batches, item.name);
			if (item.caught)
				assert.equal(run.got.report!.reason, 'frame-carried dependence', item.name);
		} finally {
			await run.folio.close();
		}
	}
});

test('a frame dependence across a batch boundary is carried through the owner frame', async () => {
	// iteration 33 reads what iteration 32, the last of the first batch, stored
	const run = await both(wasm(ownerSource(lateItem(atIteration(33)))), distinct(40), 4);
	try {
		assert.ok(run.equal);
		assert.equal(run.got.report!.iteration!.batches, 2);
		assert.equal(run.got.report!.iteration!.replayed, 0);
		assert.equal(run.got.report!.iteration!.conflicts.frame, 0);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(33), 1)[0], 5 + 32 + 1);
	} finally {
		await run.folio.close();
	}
});

test('a late frame read ends the dispatch: the rest of the loop runs serially', async () => {
	const run = await both(wasm(ownerSource(lateItem(atIteration(5)))), distinct(100), 4);
	try {
		const counts = run.got.report!.iteration!;
		assert.ok(run.equal);
		assert.equal(counts.batches, 1);
		assert.equal(counts.regions, 32);
		// iteration 0 ran serially, 1 to 4 keep their writes, 5 to 32 replay, 33 to 99 never dispatch
		assert.equal(counts.rolledBack, 28);
		assert.equal(counts.replayed, 28);
		assert.equal(counts.serial, 1 + 67);
		assert.equal(counts.stopped, 'frame-carried dependence');
	} finally {
		await run.folio.close();
	}
});

test('a frame read of data the loop never writes does not conflict and still dispatches', async () => {
	// every iteration reads the owner's frame cell 0 and writes cell 4, in the same granule
	const item = `
		(i32.store offset=4 (local.get $f) (i32.load (local.get $src)))
		(i32.store (local.get $dst) (i32.add (i32.load (local.get $f)) (i32.load offset=4 (local.get $f))))`;
	const run = await both(wasm(ownerSource(item)), distinct(40), 4);
	try {
		assert.ok(run.equal);
		assert.ok(ownerFrameBytes(run.got.memory).equals(ownerFrameBytes(run.want.memory)));
		const counts = run.got.report!.iteration!;
		// data the owner stored before the loop and no iteration writes is not a dependence
		assert.equal(run.got.report!.extraction, 'iteration');
		assert.equal(run.got.report!.reason, undefined);
		assert.equal(counts.regions, 39);
		assert.equal(counts.replayed, 0);
		assert.equal(counts.stopped, undefined);
		assert.equal(counts.conflicts.frame, 0);
	} finally {
		await run.folio.close();
	}
});

test('a heap conflict replays and equals the serial program', async () => {
	const source = wasm(ownerSource(plainItem));
	const plan = disjoint(40);
	for (let i = 3; i < 40; i += 4) plan.src[i] = dstCell(i - 1);
	const run = await both(source, plan, 4);
	try {
		assert.ok(run.equal);
		assert.ok(run.got.report!.iteration!.replayed > 0);
		assert.equal(run.got.report!.reason, 'dependency');
		assert.equal(run.got.report!.iteration!.stopped, 'dependency');
	} finally {
		await run.folio.close();
	}
	const clean = await both(source, disjoint(40), 4);
	try {
		assert.ok(clean.equal);
		assert.equal(clean.got.report!.replayed, 0);
	} finally {
		await clean.folio.close();
	}
});

test('replayed iterations use the owner stack below the frame', async () => {
	// the callee frame must land below the owner frame; on the frame it would read its own write
	const source = wasm(ownerSource(stackItem));
	const run = await both(source, disjoint(40), 4);
	try {
		assert.ok(run.equal);
		// iteration 0 runs through the owner stack too
		assert.equal(run.got.report!.iteration!.serial, 1);
		assert.equal(run.got.report!.iteration!.replayed, 0);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(7), 1)[0], 99);
	} finally {
		await run.folio.close();
	}
	const plan = disjoint(40);
	for (let i = 3; i < 40; i += 4) plan.src[i] = dstCell(i - 1);
	const conflict = await both(wasm(ownerSource(stackItem + plainItem)), plan, 4);
	try {
		assert.ok(conflict.equal);
		assert.ok(conflict.got.report!.iteration!.replayed > 0);
	} finally {
		await conflict.folio.close();
	}
});

test('an export that reaches the owner dispatches, and admission applies to it', async () => {
	const wrapper =
		'(func $wrap (export "wrap") (param $t i32) (param $n i32) (call $run (local.get $t) (local.get $n)))';
	const source = wasm(ownerSource(plainItem, { extra: wrapper }));
	const { image, args } = planImage(disjoint(40));
	const folio = await Folio.open(source, { workers: 4 });
	try {
		new Uint8Array(folio.memory.buffer).set(image);
		const few = await folio.run('wrap', [args[0]!, 1]);
		assert.equal(few.mode, 'serial');
		assert.equal(few.reason, 'no-admission');
		assert.equal(few.iteration, undefined);
		const many = await folio.run('wrap', args);
		assert.equal(many.extraction, 'iteration');
		assert.equal(many.iteration!.regions, 39);
		const none = await folio.run('wrap', [args[0]!, 0]);
		assert.equal(none.reason, 'no-parallel-plan');
	} finally {
		await folio.close();
	}
});

test('a trap in iteration j is the serial trap and keeps the earlier iterations', async () => {
	const source = wasm(ownerSource(trapItem));
	const plan = disjoint(40);
	plan.values = Array.from({ length: 40 }, (_, i) => (i === 13 ? 777 : 100 + i));
	const run = await both(source, plan, 4);
	try {
		assert.ok(run.want.error instanceof WebAssembly.RuntimeError);
		assert.ok(run.got.error instanceof WebAssembly.RuntimeError);
		assert.ok(run.equal);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(12), 1)[0], 100 + 12 + 3);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(14), 1)[0], 0xab00000e);
	} finally {
		await run.folio.close();
	}
});

test('a trip count of zero at loop entry runs the original loop and is not dispatched', async () => {
	// without a guard the program runs the loop 2^32 times; the sentinel makes serial stop at once.
	// the call goes through a wrapper so the host function, not the entry check, sees the zero
	const wrapper =
		'(func $wrap (export "wrap") (param $t i32) (param $n i32) (call $run (local.get $t) (local.get $n)))';
	const source = wasm(ownerSource(trapItem, { guard: false, extra: wrapper }));
	const plan = disjoint(20);
	plan.values = Array.from({ length: 20 }, (_, i) => (i === 5 ? 777 : 100 + i));
	const run = await both(source, plan, 4, 0, 'wrap');
	try {
		assert.ok(run.want.error instanceof WebAssembly.RuntimeError);
		assert.ok(run.equal);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(4), 1)[0], 100 + 4 + 3);
	} finally {
		await run.folio.close();
	}
});

test('a worker that cannot start fails the open, closes the pool and leaves the memory usable', async () => {
	// the module declares 32 pages; a one page memory fails to link inside every worker
	const small = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
	await assert.rejects(
		IterationPool.open(rig.route, small, {
			arenaBase: 0,
			width: 2,
			batch: 1,
			logCapacity: 4,
			slotBytes: 128
		}),
		/memory|import|link/i
	);
	const refused = iterationOwner(wasm(ownerSource(plainItem)), {
		eligible: false,
		locals: [],
		diagnostics: []
	});
	assert.deepEqual(refused, { reason: 'no-arena', detail: 'route is not eligible' });
});

test('an owner called twice in one run reports the sum of both calls', async () => {
	const twice =
		'(func $wrap (export "wrap") (param $t i32) (param $n i32) (call $run (local.get $t) (local.get $n)) (call $run (local.get $t) (local.get $n)))';
	const clean = await both(
		wasm(ownerSource(plainItem, { extra: twice })),
		disjoint(40),
		4,
		40,
		'wrap'
	);
	try {
		const counts = clean.got.report!.iteration!;
		assert.ok(clean.equal);
		assert.equal(clean.got.report!.regions, 78);
		assert.deepEqual([counts.regions, counts.batches, counts.workers], [78, 4, 4]);
		assert.equal(counts.serial, 2);
		assert.equal(counts.admission!.admitted, true);
	} finally {
		await clean.folio.close();
	}
	const carried = await both(
		wasm(ownerSource(carriedItem, { extra: twice })),
		distinct(40),
		4,
		40,
		'wrap'
	);
	try {
		const counts = carried.got.report!.iteration!;
		assert.ok(carried.equal);
		// the first call is carried and records the verdict, so the second runs serially without a
		// batch: the conflicts and replays of the first call only
		assert.equal(counts.stopped, 'frame-carried dependence');
		assert.ok(counts.conflicts.frame >= 1);
		assert.equal(counts.replayed, 31);
		assert.equal(counts.batches, 1);
		assert.equal(carried.got.report!.reason, 'frame-carried dependence');
	} finally {
		await carried.folio.close();
	}
});

test('a loop that follows a pointer the owner stored in its frame dispatches', async () => {
	// the pointer is loop-invariant frame data; a poisoned first iteration would have trapped on it
	const item = `
		(i32.store (local.get $dst) (i32.add (i32.load (i32.load (local.get $f))) (i32.load (local.get $src))))`;
	const run = await both(wasm(ownerSource(item)), distinct(40), 4);
	try {
		assert.ok(run.equal);
		assert.equal(run.got.report!.extraction, 'iteration');
		assert.equal(run.got.report!.reason, undefined);
		assert.equal(run.got.report!.iteration!.replayed, 0);
		assert.equal(run.got.report!.iteration!.regions, 39);
	} finally {
		await run.folio.close();
	}
});

test('imports that supply the memory, too many workers and a bad worker limit are named', async () => {
	const source = wasm(ownerSource(plainItem));
	const { image, args } = planImage(disjoint(40));
	const supplied = new WebAssembly.Memory({ initial: wat.pages, maximum: 128 });
	const bound = await Folio.open(source, { workers: 2, imports: { env: { memory: supplied } } });
	try {
		new Uint8Array(bound.memory.buffer).set(image);
		const report = await bound.run('run', args);
		assert.equal(report.mode, 'serial');
		assert.equal(report.reason, 'no-arena');
		assert.match(bound.diagnostics.join('\n'), /supplied through imports/);
		assert.equal(new Uint32Array(bound.memory.buffer, dstCell(39), 1)[0], 100 + 3 * 39 + 3);
	} finally {
		await bound.close();
	}
	// a pool that cannot start: the run stays serial, says why and does not retry
	const open = vi.spyOn(IterationPool, 'open').mockRejectedValueOnce(new Error('no threads'));
	const wide = await Folio.open(source, { workers: 4 });
	try {
		new Uint8Array(wide.memory.buffer).set(image);
		const report = await wide.run('run', args);
		assert.equal(report.mode, 'serial');
		assert.equal(report.reason, 'workers-unavailable');
		assert.match(wide.diagnostics.join('\n'), /iteration workers unavailable: no threads/);
		assert.equal(new Uint32Array(wide.memory.buffer, dstCell(39), 1)[0], 100 + 3 * 39 + 3);
		assert.equal((await wide.run('run', args)).reason, 'workers-unavailable');
		assert.equal(open.mock.calls.length, 1);
	} finally {
		open.mockRestore();
		await wide.close();
	}
	const folio = await Folio.open(source, { workers: 4 });
	try {
		new Uint8Array(folio.memory.buffer).set(image);
		await assert.rejects(folio.run('run', args, { maximumWorkers: 0 }), RangeError);
		await assert.rejects(folio.run('run', args, { maximumWorkers: 65 }), RangeError);
		// a smaller limit reopens the pool at that width and the default width reopens it again
		assert.equal((await folio.run('run', args, { maximumWorkers: 2 })).workers, 2);
		assert.equal((await folio.run('run', args)).workers, 4);
		assert.equal((await folio.run('run', args, { maximumWorkers: 1 })).reason, 'single-region');
	} finally {
		await folio.close();
	}
});

test('an owner with function, table, global and tag imports keeps their order', async () => {
	const imports =
		'(import "env" "f" (func $imp (param i32))) (import "env" "t" (table 1 funcref)) (import "env" "g" (global $ig i32)) (import "env" "e" (tag $tg (param i32)))';
	const source = wasm(ownerSource(plainItem).replace('(global $sp', `${imports}\n(global $sp`));
	const route = prepare(source).iterationRoute!;
	assert.ok(route.eligible, route.diagnostics.join('; '));
	const built = iterationOwner(source, route);
	assert.ok('owner' in built);
	const order = (bytes: Uint8Array) =>
		WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(bytes)))
			.filter((item) => item.module === 'env')
			.map((item) => `${item.name}:${item.kind}`);
	assert.deepEqual(
		order((built as { owner: { module: Uint8Array } }).owner.module),
		order(source)
	);
	const supplied = {
		env: {
			f() {},
			t: new WebAssembly.Table({ initial: 1, element: 'anyfunc' }),
			g: new WebAssembly.Global({ value: 'i32', mutable: false }, 1),
			e: new (WebAssembly as any).Tag({ parameters: ['i32'] })
		}
	};
	const { image, args } = planImage(disjoint(40));
	const folio = await Folio.open(source, { workers: 4, imports: supplied });
	try {
		new Uint8Array(folio.memory.buffer).set(image);
		const report = await folio.run('run', args);
		assert.equal(report.extraction, 'iteration');
		assert.equal(new Uint32Array(folio.memory.buffer, dstCell(39), 1)[0], 100 + 3 * 39 + 3);
	} finally {
		await folio.close();
	}
});

test('locals the code after the loop reads get the values the loop leaves', async () => {
	const source = wasm(ownerSource(plainItem, { result: true }));
	for (const trips of [1, 8, 40]) {
		const run = await both(source, disjoint(40), 4, trips);
		try {
			assert.ok(run.equal, `trips ${trips}`);
			assert.equal(typeof run.want.value, 'number');
			assert.equal(run.got.report!.extraction, trips >= 8 ? 'iteration' : undefined);
		} finally {
			await run.folio.close();
		}
	}
});

const strideSource = (body: string, result: string) =>
	wasm(`(module
	(import "env" "memory" (memory ${wat.pages} 128))
	(global $sp (mut i32) (i32.const 65536))
	(func $item (param $src i32) (param $dst i32)
		(i32.store (local.get $dst) (i32.add (i32.load (local.get $src)) (i32.const 3))))
	(func $run (export "run") (param $in i32) (param $out i32) (param $n i32) (param $step i32) (result i32)
		(local $frame i32) (local $c i32)
		(local.set $frame (i32.sub (global.get $sp) (i32.const 64)))
		(global.set $sp (local.get $frame))
		(block $done
			(br_if $done (i32.eqz (local.get $n)))
			(local.set $c (local.get $n))
			(loop $each
				${body}
				(br_if $each (local.tee $c (i32.sub (local.get $c) (i32.const 1))))))
		(global.set $sp (i32.add (local.get $frame) (i32.const 64)))
		${result}))`);

const bump = (local: string, by: number) =>
	`(local.set ${local} (i32.add (local.get ${local}) (i32.const ${by})))`;
const copy = (out: string) => `(call $item (local.get $in) ${out})`;
const strideShapes: [string, string, string, number, number, boolean][] = [
	[
		'an update before the call, the other update after it, both read after the loop',
		`${bump('$in', 4)} ${copy('(local.get $out)')} ${bump('$out', 32)}`,
		'(i32.add (local.get $in) (i32.add (local.get $out) (local.get $c)))',
		wat.dst,
		0,
		false
	],
	[
		'one call before an update and another call after it',
		`${copy('(local.get $out)')} ${bump('$in', 4)} ${bump('$out', 32)}
		${copy('(i32.add (local.get $out) (i32.const 0x4000))')}`,
		'(i32.add (local.get $in) (local.get $out))',
		wat.dst,
		0,
		false
	],
	[
		'a positive run-time stride applied before the call',
		`(local.set $out (i32.add (local.get $out) (local.get $step))) ${copy('(local.get $out)')} ${bump('$in', 4)}`,
		'(i32.add (local.get $in) (local.get $c))',
		wat.dst,
		32,
		false
	],
	[
		'a subtracted run-time stride after the call',
		`${copy('(local.get $out)')} ${bump('$in', 4)} (local.set $out (i32.sub (local.get $out) (local.get $step)))`,
		'(local.get $c)',
		wat.dst + 0x1000,
		32,
		false
	],
	[
		'a negative run-time stride',
		`${copy('(local.get $out)')} ${bump('$in', 4)} (local.set $out (i32.add (local.get $out) (local.get $step)))`,
		'(local.get $c)',
		wat.dst + 0x1000,
		-32,
		false
	],
	[
		'a zero run-time stride, which makes every iteration write one cell',
		`${copy('(local.get $out)')} ${bump('$in', 4)} (local.set $out (i32.add (local.get $out) (local.get $step)))`,
		'(local.get $c)',
		wat.dst,
		0,
		true
	]
];

for (const [name, body, result, out, step, conflicts] of strideShapes) {
	test(`Folio.run equals the serial program for ${name}`, async () => {
		const source = strideSource(body, result);
		assert.equal(prepare(source).iterationRoute!.eligible, true);
		const args = [wat.src, out, 40, step];
		const fill = (memory: WebAssembly.Memory) => {
			const words = new Uint32Array(memory.buffer, wat.src, 128);
			words.forEach((_, i) => (words[i] = i * 7 + 1));
		};
		const memory = new WebAssembly.Memory({ initial: wat.pages, maximum: 128 });
		fill(memory);
		const serial = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
			env: { memory }
		});
		const want = (serial.exports.run as CallableFunction)(...args);
		for (const workers of [2, 4]) {
			const folio = await Folio.open(source, { workers });
			try {
				fill(folio.memory);
				const report = await folio.run('run', args);
				assert.deepEqual(report.values, [want], `value at width ${workers}`);
				assert.deepEqual(
					programPages(folio.memory, wat.pages),
					programPages(memory, wat.pages),
					`memory at width ${workers}`
				);
				assert.equal(report.extraction, 'iteration');
				if (!conflicts) assert.equal(report.iteration!.regions, 39);
				assert.equal(report.iteration!.replayed > 0, conflicts);
			} finally {
				await folio.close();
			}
		}
	});
}

test('a module that executes memory.size stays serial with a named reason', async () => {
	const source = wasm(
		ownerSource(plainItem, { extra: '(func $peek (export "peek") (result i32) (memory.size))' })
	);
	const run = await both(source, disjoint(40), 4);
	try {
		assert.ok(run.equal);
		assert.equal(run.got.report!.mode, 'serial');
		assert.equal(run.got.report!.reason, 'memory-size-observed');
		assert.equal(run.got.report!.iteration, undefined);
		assert.equal(run.folio.memory.buffer.byteLength, wat.pages * PAGE);
		assert.equal(run.folio.capabilities.automaticRegions, 'none');
		assert.match(run.folio.diagnostics.join('\n'), /memory\.size/);
	} finally {
		await run.folio.close();
	}
});

test('a program an older route covers keeps its route and its report', async () => {
	const fixture = new Uint8Array(
		readFileSync(new URL('../../build/fixture.wasm', import.meta.url))
	);
	assert.equal(prepare(fixture, { minimumRegionWork: 0 }).iterationRoute!.eligible, true);
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
	new Uint32Array(memory.buffer, 1024, 37).fill(1);
	const folio = await Folio.open(fixture, { minimumRegionWork: 0, memory, workers: 4 });
	try {
		assert.equal(folio.memory.buffer.byteLength, 2 * PAGE);
		assert.notEqual(folio.capabilities.automaticRegions, 'iteration');
		const report = await folio.run('program', [1024, 37, 17], { parallel: 'speculate' });
		assert.equal(report.mode, 'speculative');
		assert.equal(report.regions, 4);
		assert.equal(report.extraction, undefined);
		assert.equal(report.iteration, undefined);
	} finally {
		await folio.close();
	}
});

test('close terminates the iteration workers, twice over, and the pool opens at the first dispatch', async () => {
	const terminated: Worker[] = [];
	const terminate = Worker.prototype.terminate;
	Worker.prototype.terminate = function (this: Worker) {
		terminated.push(this);
		return terminate.call(this);
	};
	try {
		const folio = await Folio.open(readConsumer(), { workers: 3 });
		const args = consumerImage(folio.memory);
		await folio.run('hash_all', args, { parallel: 'off' });
		assert.equal(terminated.length, 0);
		await folio.run('hash_all', [args[0]!, 2, args[2]!]);
		assert.equal(terminated.length, 0);
		await folio.run('hash_all', args);
		const closing = folio.close();
		assert.equal(folio.close(), closing);
		await closing;
		await folio.close();
		assert.equal(terminated.length, 3);
		assert.ok(terminated.every((worker) => worker.threadId === -1));
		await assert.rejects(folio.run('hash_all', args), /closed/);
		const early = await Folio.open(readConsumer(), { workers: 2 });
		await early.close();
		assert.equal(terminated.length, 3);
	} finally {
		Worker.prototype.terminate = terminate;
	}
});

test('the arena fit is a fixed point and the owner refuses a defined memory', () => {
	for (const start of [PAGE, 16 * PAGE, 200 * PAGE]) {
		const fit = iterationFit(start)!;
		assert.equal(fit.base, start);
		assert.ok(fit.base + fit.bytes <= fit.memoryBytes);
		assert.ok(fit.base + iterationArenaBytes(fit.memoryBytes - PAGE) > fit.memoryBytes - PAGE);
		assert.equal(fit.memoryBytes, fit.pages * PAGE);
	}
	assert.equal(iterationFit(60000 * PAGE), undefined);
	const defined = wasm(ownerSource(plainItem).replace(/\(import[^\n]*\n/, '(memory 32 32)\n'));
	const route = prepare(defined).iterationRoute!;
	assert.ok(route.eligible);
	const refused = iterationOwner(defined, route);
	assert.ok('reason' in refused);
	assert.equal(refused.reason, 'no-arena');
	assert.match(refused.detail, /imported memory/);
});

test('the owner builder refuses a route it cannot place and renames what the module already uses', () => {
	const source = wasm(ownerSource(plainItem));
	const route = prepare(source).iterationRoute!;
	assert.ok(route.eligible);
	const missing = iterationOwner(source, { ...route, owner: 'missing' });
	assert.ok('reason' in missing);
	assert.match(missing.detail, /not found/);
	const flat = iterationOwner(source, { ...route, owner: 'item' });
	assert.ok('reason' in flat);
	assert.match(flat.detail, /loop not found/);
	const taken = wasm(
		ownerSource(plainItem, {
			extra: '(func $__folio_iterate (export "x")) (export "__folio_owner_stack" (global $sp))'
		}).replace('(global $sp', '(import "__folio_iteration" "z" (func))\n(global $sp')
	);
	const built = iterationOwner(taken, prepare(taken).iterationRoute!, 'sp');
	assert.ok('owner' in built, 'detail' in built ? String(built.detail) : '');
	assert.equal(built.owner.namespace, '__folio_iteration_');
	assert.equal(built.owner.stackExport, '__folio_owner_stack_');
});

test('a loop that is the whole body of the owner is lowered and runs on workers', async () => {
	const source = wasm(`(module
		(import "env" "memory" (memory 4 1024))
		(global $sp (mut i32) (i32.const 65536))
		(func $item (param $in i32) (param $out i32) (local $s i32)
			(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
			(global.set $sp (local.get $s))
			(i32.store (local.get $s) (i32.add (i32.load (local.get $in)) (i32.const 1)))
			(i32.store (local.get $out) (i32.load (local.get $s)))
			(global.set $sp (i32.add (local.get $s) (i32.const 16))))
		(func $run (export "run") (param $in i32) (param $out i32) (param $n i32)
			(loop $each
				(call $item (local.get $in) (local.get $out))
				(local.set $in (i32.add (local.get $in) (i32.const 4)))
				(local.set $out (i32.add (local.get $out) (i32.const 4)))
				(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))))`);
	const route = prepare(source).iterationRoute!;
	assert.ok(route.eligible, route.diagnostics.join('; '));
	const folio = await Folio.open(source, { workers: 2 });
	try {
		const words = new Uint32Array(folio.memory.buffer, 0x4000, 48);
		for (let i = 0; i < 24; i++) words[i] = i * 7;
		const report = await folio.run('run', [0x4000, 0x4000 + 4 * 24, 24]);
		assert.equal(report.extraction, 'iteration');
		for (let i = 0; i < 24; i++) assert.equal(words[24 + i], i * 7 + 1);
	} finally {
		await folio.close();
	}
});

test('admission checks the remaining serial time against the dispatch floor at the boundaries', () => {
	const constants = { fixedMs: 2, margin: 1.25 };
	const decide = (plainIterationMs: number, trip: number, width: number) =>
		admitIteration({ plainIterationMs, trip, width, constants });
	// the remaining iterations are trip - 1, and their serial time must exceed fixedMs * margin
	const near = decide(0.5001, 6, 4);
	assert.equal(near.plainIterationMs, 0.5001);
	assert.equal(near.remainingSerialMs, 5 * 0.5001);
	assert.equal(near.floorMs, 2.5);
	assert.equal(near.admitted, true);
	assert.equal(decide(0.5, 6, 4).admitted, false);
	assert.equal(decide(0.5, 6, 4).remainingSerialMs, 2.5);
	// iteration 0 already ran, so two iterations are left at trip 3 and one at trip 2
	assert.equal(decide(1e6, 3, 8).admitted, true);
	assert.equal(decide(1e6, 2, 8).admitted, false);
	assert.equal(decide(1e6, 1, 8).admitted, false);
	assert.equal(decide(1e6, 0, 8).admitted, false);
	assert.equal(decide(1e6, 0, 8).remainingSerialMs, -1e6);
	// one worker never pays off; two do, whatever the loop is
	assert.equal(decide(1e6, 64, 1).admitted, false);
	assert.equal(decide(1e6, 64, 2).admitted, true);
	assert.equal(decide(1e6, 64, 0).admitted, false);
	// an unmeasurable or negative time is refused
	assert.equal(decide(-1, 128, 8).admitted, false);
	assert.equal(decide(Number.POSITIVE_INFINITY, 128, 8).admitted, false);
	assert.equal(decide(Number.NaN, 128, 8).admitted, false);
	assert.equal(decide(0, 128, 8).admitted, false);
	// the constants default to the module's, and there are two of them
	assert.deepEqual(Object.keys(iterationAdmissionConstants).sort(), ['fixedMs', 'margin']);
	assert.deepEqual(
		admitIteration({ plainIterationMs: 5, trip: 64, width: 4 }),
		admitIteration({
			plainIterationMs: 5,
			trip: 64,
			width: 4,
			constants: iterationAdmissionConstants
		})
	);
});

test('a batch loses when its wall times the margin exceeds the serial time of its iterations', () => {
	const constants = { fixedMs: 2, margin: 1.25 };
	assert.equal(batchLoses(8, 10, constants), false);
	assert.equal(batchLoses(8.0001, 10, constants), true);
	assert.equal(batchLoses(1, 100, constants), false);
	assert.equal(batchLoses(100, 1, constants), true);
	assert.equal(batchLoses(0, 0, constants), false);
	assert.equal(batchLoses(0.001, 0, constants), true);
	assert.equal(batchLoses(10, 10, { ...constants, margin: 1 }), false);
	assert.equal(batchLoses(10.001, 10, { ...constants, margin: 1 }), true);
	assert.equal(batchLoses(8, 10), batchLoses(8, 10, iterationAdmissionConstants));
});

test('a batch collapses only when its wall is well past the serial time of its iterations', () => {
	assert.equal(batchCollapses(15, 10), false);
	assert.equal(batchCollapses(15.001, 10), true);
	assert.equal(batchCollapses(10, 10), false);
	assert.equal(batchCollapses(0.001, 0), true);
	assert.equal(batchCollapses(0, 0), false);
});

test('the admission seam scales the measured times and forces a loop with iterations left', () => {
	admissionSeam.force = false;
	admissionSeam.scale = 1;
	const plain = decideAdmission(0.01, 32, 8);
	assert.equal(plain.admitted, false);
	admissionSeam.scale = 1e6;
	const scaled = decideAdmission(0.01, 32, 8);
	assert.equal(scaled.plainIterationMs, 1e4);
	assert.equal(scaled.admitted, true);
	admissionSeam.scale = 1;
	admissionSeam.force = true;
	const forced = decideAdmission(0.01, 32, 8);
	assert.equal(forced.admitted, true);
	assert.equal(forced.remainingSerialMs, plain.remainingSerialMs);
	assert.equal(decideAdmission(0.01, 2, 8).admitted, true);
	assert.equal(decideAdmission(0.01, 1, 8).admitted, false);
	assert.equal(decideAdmission(0.01, 32, 1).admitted, false);
	// the batch rule: the wall is scaled, force never stops
	admissionSeam.force = false;
	assert.equal(decideBatch(1, 10), false);
	admissionSeam.batchScale = 100;
	assert.equal(decideBatch(1, 10), true);
	assert.equal(decideCollapse(1, 10), true);
	admissionSeam.batchScale = 1;
	assert.equal(decideCollapse(1, 10), false);
	admissionSeam.force = true;
	admissionSeam.batchScale = 100;
	assert.equal(decideBatch(1, 10), false);
	assert.equal(decideCollapse(1, 10), false);
});

test('the estimate follows the workers in both directions and caps its scale at one', () => {
	const first = { estimateMs: 1 };
	// iterations as dear as iteration 0 on the tracked module: the estimate stays at the plain time
	const same = refineEstimate(first, Array(8).fill(1.4));
	assert.equal(same.kappa, 1 / 1.4);
	assert.ok(Math.abs(same.estimateMs - 1) < 1e-12);
	// ten times cheaper than iteration 0: it falls, and a tracked time is never read as faster than
	// plain, so the scale caps at 1 and the estimate is the tracked mean, an upper bound
	const cheaper = refineEstimate(first, Array(8).fill(0.1));
	assert.equal(cheaper.kappa, 1);
	assert.ok(Math.abs(cheaper.estimateMs - 0.1) < 1e-12);
	// one iteration of 140 among 31 of 1.4: the least time fixes the scale and the mean raises the estimate
	const dearer = refineEstimate(first, [...Array(31).fill(1.4), 140]);
	assert.equal(dearer.kappa, 1 / 1.4);
	assert.ok(Math.abs(dearer.estimateMs - (31 * 1.4 + 140) / 32 / 1.4) < 1e-12);
	assert.ok(dearer.estimateMs > 4 && dearer.estimateMs < 5);
	// iteration 0 was the smallest of a batch that is half large: the median would read 140 ms as the
	// tracking cost and put the estimate at 0.5 ms, the least time keeps it at the real mean
	const step = refineEstimate(first, [...Array(16).fill(1.4), ...Array(16).fill(140)]);
	assert.equal(step.kappa, 1 / 1.4);
	assert.ok(Math.abs(step.estimateMs - (16 * 1.4 + 16 * 140) / 32 / 1.4) < 1e-12);
	// later batches keep the scale, so a loop that gets dearer keeps raising the estimate
	const later = refineEstimate(dearer, Array(8).fill(14));
	assert.equal(later.kappa, dearer.kappa);
	assert.ok(Math.abs(later.estimateMs - 10) < 1e-12);
	const falling = refineEstimate(later, Array(8).fill(0.14));
	assert.ok(Math.abs(falling.estimateMs - 0.1) < 1e-12);
	// nothing completed, nothing learned
	assert.equal(refineEstimate(first, []), first);
	assert.equal(refineEstimate(first, [0, -1]), first);
});

test('the remaining-work decision is the admission rule on what is left, through the seam', () => {
	admissionSeam.force = false;
	admissionSeam.scale = 1;
	const floor = iterationAdmissionConstants.fixedMs * iterationAdmissionConstants.margin;
	assert.equal(decideRemaining(floor / 10 + 1e-9, 10, 4), true);
	assert.equal(decideRemaining(floor / 10, 10, 4), false);
	assert.equal(decideRemaining(1e6, 1, 4), false);
	assert.equal(decideRemaining(1e6, 10, 1), false);
	assert.equal(decideRemaining(Number.NaN, 10, 4), false);
	admissionSeam.scale = 1e6;
	assert.equal(decideRemaining(1e-3, 10, 4), true);
	admissionSeam.scale = 1;
	admissionSeam.force = true;
	assert.equal(decideRemaining(1e-9, 10, 4), true);
	// force admits one iteration left, as for iteration 0, and none left is nothing to dispatch
	assert.equal(decideRemaining(1e-9, 1, 4), true);
	assert.equal(decideRemaining(1e-9, 0, 4), false);
});

test('a loop of trivial iterations is refused with the numbers and equals the serial program', async () => {
	admissionSeam.force = false;
	admissionSeam.scale = 1e-6;
	const source = wasm(ownerSource(plainItem));
	const run = await both(source, disjoint(16), 4);
	try {
		assert.ok(run.equal);
		const report = run.got.report!;
		assert.equal(report.mode, 'serial');
		assert.equal(report.reason, 'no-admission');
		assert.equal(report.extraction, undefined);
		const counts = report.iteration!;
		assert.equal(counts.regions, 0);
		assert.equal(counts.batches, 0);
		assert.equal(counts.replayed, 0);
		assert.equal(counts.serial, 16);
		assert.equal(counts.stopped, 'no-admission');
		const admission = counts.admission!;
		assert.equal(admission.admitted, false);
		assert.ok(admission.plainIterationMs >= 0);
		assert.ok(admission.remainingSerialMs < admission.floorMs);
		assert.equal(
			admission.floorMs,
			iterationAdmissionConstants.fixedMs * iterationAdmissionConstants.margin
		);
		assert.equal(admission.batchWallMs, undefined);
		// iteration 0 kept its writes and a second run is the same
		const again = await run.folio.run('run', [planImage(disjoint(16)).args[0]!, 16]);
		assert.equal(again.reason, 'no-admission');
	} finally {
		await run.folio.close();
	}
});

// a loop the pre-check admits (scale) whose batches the seam can make win or lose
async function seamed(plan: Plan, source: Uint8Array, batchScale: number) {
	admissionSeam.force = false;
	admissionSeam.scale = 1e9;
	admissionSeam.batchScale = batchScale;
	return both(source, plan, 4);
}

test('a batch that collapses against the serial time ends the dispatch after the first batch', async () => {
	const source = wasm(ownerSource(plainItem));
	const lost = await seamed(disjoint(80), source, 1e9);
	try {
		assert.ok(lost.equal);
		const report = lost.got.report!;
		const counts = report.iteration!;
		assert.equal(report.extraction, 'iteration');
		assert.equal(report.reason, 'no-admission');
		assert.equal(counts.batches, 1);
		assert.equal(counts.regions, 32);
		assert.equal(counts.rolledBack, 0);
		// iteration 0 ran serially, 1 to 32 were dispatched, 33 to 79 ran serially
		assert.equal(counts.replayed, 0);
		assert.equal(counts.serial, 1 + 47);
		assert.equal(counts.stopped, 'no-admission');
		assert.equal(counts.admission!.admitted, true);
		assert.ok(counts.admission!.batchWallMs! > 0);
		assert.ok(counts.admission!.batchSerialMs! > 0);
	} finally {
		await lost.folio.close();
	}
	const won = await seamed(disjoint(80), source, 1e-9);
	try {
		assert.ok(won.equal);
		const counts = won.got.report!.iteration!;
		assert.equal(counts.batches, 3);
		assert.equal(counts.regions, 79);
		assert.equal(counts.replayed, 0);
		assert.equal(counts.stopped, undefined);
		assert.equal(won.got.report!.reason, undefined);
	} finally {
		await won.folio.close();
	}
});

test('a batch that exhausts the undo log ends the dispatch with the named reason', async () => {
	// every iteration fills 2176 write granules in one region, past the 2048 the log holds
	const item = '(memory.fill (local.get $dst) (i32.load (local.get $src)) (i32.const 69632))';
	const plan = distinct(100);
	plan.dst = plan.dst.map(() => 0x40000);
	const run = await both(wasm(ownerSource(item)), plan, 4);
	try {
		assert.ok(run.equal);
		const report = run.got.report!;
		const counts = report.iteration!;
		assert.equal(report.reason, 'log-exhausted');
		assert.equal(counts.stopped, 'log-exhausted');
		assert.equal(counts.batches, 1);
		// every iteration fails, so each worker claims one and then stops; a late worker claims none
		assert.ok(counts.exhausted >= 1 && counts.exhausted <= 32);
		assert.equal(counts.exhausted, counts.regions);
		assert.equal(counts.replayed, counts.regions);
		assert.ok(counts.regions >= 1 && counts.regions <= 4);
		assert.equal(counts.replayed + counts.serial, 100);
		assert.equal(new Uint8Array(run.got.memory.buffer)[0x40000], 5 + 99);
		// the memory is at its declared 128 pages, which leaves no room for a grown log
		assert.equal(counts.logGrowths, 0);
		assert.equal(counts.retried, 0);
	} finally {
		await run.folio.close();
	}
});

test('a loop whose iterations overrun the undo log is retried on a grown log and stays dispatched', async () => {
	// every iteration fills 2176 write granules in a region of its own; the memory may grow
	const item = '(memory.fill (local.get $dst) (i32.load (local.get $src)) (i32.const 69632))';
	const plan = distinct(8);
	plan.dst = plan.dst.map((_, i) => 0x40000 + 0x11000 * i);
	const run = await both(wasm(ownerSource(item, { maximum: 4096 })), plan, 4, undefined, 'run', {
		iterationLogCeiling
	});
	try {
		assert.ok(run.equal);
		const report = run.got.report!;
		const counts = report.iteration!;
		assert.equal(report.extraction, 'iteration');
		assert.equal(report.reason, undefined);
		assert.equal(counts.stopped, undefined);
		assert.equal(counts.logGrowths, 1);
		assert.ok(counts.exhausted >= 1);
		assert.ok(counts.retried >= 1);
		assert.equal(counts.regions, 7);
		assert.equal(counts.replayed, 0);
		assert.ok(counts.maxLogEntries >= 2176);
		// the owner's size check follows the pages the pool added, so a second call dispatches too
		const size = run.folio.memory.buffer.byteLength;
		const again = await run.folio.run('run', planImage(plan).args);
		assert.equal(again.extraction, 'iteration');
		assert.equal(again.iteration!.logGrowths, 1);
		assert.equal(again.reason, undefined);
		assert.equal(run.folio.memory.buffer.byteLength, size);
		// a pool of another width opens over the grown memory, with the bitmaps sized to it
		const narrower = await run.folio.run('run', planImage(plan).args, { maximumWorkers: 2 });
		assert.equal(narrower.extraction, 'iteration');
		assert.equal(narrower.workers, 2);
		assert.equal(narrower.iteration!.logGrowths, 1);
		assert.equal(
			Buffer.compare(
				programPages(run.want.memory, wat.pages),
				programPages(run.got.memory, wat.pages)
			),
			0
		);
	} finally {
		await run.folio.close();
	}
});

test('a loop where every iteration reads what the previous one wrote stops after one batch', async () => {
	const plan = disjoint(100);
	for (let i = 1; i < 100; i++) plan.src[i] = dstCell(i - 1);
	const run = await both(wasm(ownerSource(plainItem)), plan, 4);
	try {
		assert.ok(run.equal);
		const report = run.got.report!;
		const counts = report.iteration!;
		assert.equal(report.reason, 'dependency');
		assert.equal(counts.stopped, 'dependency');
		assert.equal(counts.batches, 1);
		assert.equal(counts.regions, 32);
		assert.ok(counts.conflicts.raw > 0);
		// iteration 1 reads what iteration 0 wrote serially; 2 to 32 replay, 33 to 99 never dispatch
		assert.equal(counts.replayed, 31);
	} finally {
		await run.folio.close();
	}
});

test('a loop whose measured serial time is large is admitted, and the seam forces a small one', async () => {
	const want = consumerReference();
	const folio = await Folio.open(readConsumer(), { workers: 4 });
	try {
		const args = consumerImage(folio.memory);
		admissionSeam.force = false;
		admissionSeam.scale = 1e9;
		const admitted = await folio.run('hash_all', args);
		assert.equal(admitted.extraction, 'iteration');
		assert.equal(admitted.iteration!.regions, sizes.length - 1);
		const a = admitted.iteration!.admission!;
		assert.equal(a.admitted, true);
		assert.ok(a.remainingSerialMs > a.floorMs);
		assert.ok(a.batchWallMs! > 0);
		assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
		admissionSeam.scale = 1e-6;
		const refused = await folio.run('hash_all', args);
		assert.equal(refused.mode, 'serial');
		assert.equal(refused.reason, 'no-admission');
		assert.equal(refused.iteration!.admission!.admitted, false);
		assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
		admissionSeam.force = true;
		const forced = await folio.run('hash_all', args);
		assert.equal(forced.extraction, 'iteration');
		assert.equal(forced.iteration!.admission!.admitted, true);
		assert.equal(forced.reason, undefined);
		assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
	} finally {
		admissionSeam.force = false;
		admissionSeam.scale = 1;
		admissionSeam.batchScale = 1;
		await folio.close();
	}
});

test('the generated iteration family equals the serial program at width 4 for every shape', async () => {
	// seeds 1 to 12 map onto the eight shapes, so every shape runs at least once
	const programs = Array.from({ length: 12 }, (_, i) => ({
		seed: i + 1,
		shape: iterationShapes[(i + 1) % iterationShapes.length]!
	}));
	const result = await runIterationPrograms(programs, { widths: [4], emit: () => {} });
	assert.deepEqual(result.failures, []);
	assert.equal(result.passed, programs.length);
	assert.deepEqual(Object.keys(result.shapes).sort(), [...iterationShapes].sort());
});

const lz4File = (name: string) =>
	new URL(`../../results/corpus/lz4-consumer/${name}.wasm`, import.meta.url);

test('the LZ4 consumer with a run-time slot size is accepted for its pointer step and refused for its total', () => {
	const route = prepare(
		new Uint8Array(readFileSync(lz4File('lz4-compress-all')))
	).iterationRoute!;
	assert.equal(route.eligible, false);
	assert.deepEqual(route.diagnostics, [
		'refused loop in compress_all: loop body writes a local the code after the loop reads',
		'no loop calls into the worker set'
	]);
});

// eight inputs for the fixed-slot LZ4 consumer: table, slots, the size table, then the inputs
const lz4Slot = 266240;
const lz4Inputs = [0, 1, 17, 1000, 4096, 5000, 3333, 6001].map((size, index) => {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++)
		data[i] = i % 29 < 20 ? 97 + (i % 13) : 97 + ((i * 31 + index) % 26);
	return data;
});
function lz4Image(memory: WebAssembly.Memory, inputs = lz4Inputs, slot = lz4Slot) {
	const n = inputs.length;
	const table = 1 << 20;
	const out = table + PAGE;
	const sizes = out + n * slot;
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer, table, 2 * n);
	let at = Math.ceil((sizes + 32 * n) / PAGE) * PAGE;
	inputs.forEach((data, i) => {
		view.set(data, at);
		words[2 * i] = at;
		words[2 * i + 1] = data.length;
		at += data.length + 64;
	});
	return { args: [table, n, out], end: at, sizes };
}

// a size table of packed u32 puts eight iterations in one 32-byte write granule, so the validator sees
// a write-write dependency and replays; padding each size to its own granule removes it
for (const [kind, stride, replays] of [
	['padded', 8, false],
	['slots', 1, true]
] as const) {
	test(`Folio.run on the fixed-slot LZ4 consumer with ${kind === 'padded' ? 'padded' : 'packed'} sizes equals the native run`, async () => {
		const bytes = new Uint8Array(readFileSync(lz4File(`lz4-compress-${kind}-256k`)));
		const pages = 80;
		const reference = new WebAssembly.Memory({ initial: pages, maximum: pages });
		const image = lz4Image(reference);
		const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
			env: { memory: reference }
		});
		(instance.exports.compress_slots as CallableFunction)(...image.args);
		const words = new Uint32Array(
			reference.buffer.slice(image.sizes, image.sizes + 32 * stride)
		);
		assert.ok(lz4Inputs.every((_, i) => words[i * stride]! > 0));
		for (const workers of [2, 4]) {
			const memory = new WebAssembly.Memory({ initial: pages, maximum: 4096, shared: true });
			const folio = await Folio.open(bytes, { memory, workers, iterationLogCeiling });
			try {
				lz4Image(folio.memory);
				const report = await folio.run('compress_slots', image.args);
				assert.deepEqual(report.values, [lz4Inputs.length]);
				assert.equal(report.extraction, 'iteration');
				assert.equal(report.mode, 'speculative');
				assert.equal(report.workers, workers);
				assert.equal(report.reason, replays ? 'dependency' : undefined);
				assert.equal(report.iteration!.replayed, replays ? lz4Inputs.length - 1 : 0);
				assert.equal(
					Buffer.compare(
						new Uint8Array(folio.memory.buffer, 1 << 20, image.end - (1 << 20)),
						new Uint8Array(reference.buffer, 1 << 20, image.end - (1 << 20))
					),
					0
				);
			} finally {
				await folio.close();
			}
		}
	});
}

test('Folio.run on the fixed-slot LZ4 consumer retries on a grown log and equals the native run', async () => {
	// 256 KiB of random bytes compress to about the same size, past the 2048 granules the log holds
	const inputs = Array.from({ length: 6 }, (_, i) => generate(i, 1 << 18));
	const bytes = new Uint8Array(readFileSync(lz4File('lz4-compress-padded-256k')));
	const pages = 80;
	const reference = new WebAssembly.Memory({ initial: pages, maximum: pages });
	const image = lz4Image(reference, inputs);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: { memory: reference }
	});
	(instance.exports.compress_slots as CallableFunction)(...image.args);
	for (const workers of [2, 4]) {
		const memory = new WebAssembly.Memory({ initial: pages, maximum: 4096, shared: true });
		const folio = await Folio.open(bytes, { memory, workers, iterationLogCeiling });
		try {
			lz4Image(folio.memory, inputs);
			const report = await folio.run('compress_slots', image.args);
			assert.deepEqual(report.values, [inputs.length]);
			assert.equal(report.reason, undefined);
			assert.equal(report.iteration!.stopped, undefined);
			assert.equal(report.iteration!.logGrowths, 1);
			assert.ok(report.iteration!.exhausted >= 1);
			assert.equal(report.iteration!.replayed, 0);
			assert.equal(report.iteration!.regions, inputs.length - 1);
			// 256 KiB of output is 8192 granules and the stream table adds more
			assert.ok(report.iteration!.maxLogEntries > 8192);
			assert.ok(report.iteration!.maxLogEntries <= iterationLogCeiling);
			assert.equal(
				Buffer.compare(
					new Uint8Array(folio.memory.buffer, 1 << 20, image.end - (1 << 20)),
					new Uint8Array(reference.buffer, 1 << 20, image.end - (1 << 20))
				),
				0
			);
		} finally {
			await folio.close();
		}
	}
});

test('Folio.run on the fixed-slot LZ4 consumer stops when one output passes the log ceiling', async () => {
	// 4 MiB of random bytes compress to more than 4 MiB, which is 131,072 granules and more
	const inputs = Array.from({ length: 5 }, (_, i) => generate(i, 1 << 22));
	const slot = 4214784;
	const bytes = new Uint8Array(readFileSync(lz4File('lz4-compress-padded-4m')));
	const pages = 760;
	const reference = new WebAssembly.Memory({ initial: pages, maximum: pages });
	const image = lz4Image(reference, inputs, slot);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: { memory: reference }
	});
	(instance.exports.compress_slots as CallableFunction)(...image.args);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: 4096, shared: true });
	const folio = await Folio.open(bytes, { memory, workers: 2, iterationLogCeiling });
	try {
		lz4Image(folio.memory, inputs, slot);
		const report = await folio.run('compress_slots', image.args);
		assert.deepEqual(report.values, [inputs.length]);
		assert.equal(report.reason, 'log-exhausted');
		const counts = report.iteration!;
		assert.equal(counts.stopped, 'log-exhausted');
		assert.equal(counts.logGrowths, 1);
		assert.ok(counts.exhausted >= 2);
		assert.equal(
			counts.replayed + counts.serial,
			inputs.length - counts.regions + counts.replayed
		);
		assert.equal(
			Buffer.compare(
				new Uint8Array(folio.memory.buffer, 1 << 20, image.end - (1 << 20)),
				new Uint8Array(reference.buffer, 1 << 20, image.end - (1 << 20))
			),
			0
		);
	} finally {
		await folio.close();
	}
});

const sha256File = (name: string) =>
	new URL(`../../results/corpus/sha256-consumer/${name}.wasm`, import.meta.url);

test('the SHA-256 consumer in its plain loop shape is accepted with the table step in the middle of the body', () => {
	const route = prepare(
		new Uint8Array(readFileSync(sha256File('sha256-hash-all')))
	).iterationRoute!;
	assert.equal(route.eligible, true, route.diagnostics.join('; '));
	assert.equal(route.owner, 'sha256_all');
	assert.deepEqual(route.trip, { local: 4, parameter: 1 });
	assert.deepEqual(
		route.locals.map(({ local, kind, stride }) => ({ local, kind, stride })),
		[
			{ local: 0, kind: 'stride', stride: 8 },
			{ local: 2, kind: 'stride', stride: 32 },
			{ local: 4, kind: 'induction', stride: -1 },
			{ local: 3, kind: 'frame', stride: undefined }
		]
	);
});

for (const name of ['sha256-hash-all', 'sha256-hash-helper']) {
	test(`Folio.run on the SHA-256 consumer ${name === 'sha256-hash-all' ? 'in its plain loop' : 'with a helper per input'} matches Node digests`, async () => {
		const bytes = new Uint8Array(readFileSync(sha256File(name)));
		const route = prepare(bytes).iterationRoute!;
		assert.equal(route.eligible, true);
		assert.equal(route.owner, 'sha256_all');
		// lengths around the 64-byte block and the 56-byte padding edge
		const inputs = [0, 1, 55, 56, 63, 64, 65, 1000].map((size, index) =>
			Uint8Array.from({ length: size }, (_, i) => (i * 31 + index * 7) & 255)
		);
		const table = 1 << 20;
		const out = table + PAGE;
		const data = out + PAGE;
		for (const workers of [2, 4]) {
			const memory = new WebAssembly.Memory({ initial: 20, maximum: 4096, shared: true });
			const folio = await Folio.open(bytes, { memory, workers });
			try {
				const view = new Uint8Array(folio.memory.buffer);
				const words = new Uint32Array(folio.memory.buffer, table, 2 * inputs.length);
				let at = data;
				inputs.forEach((input, i) => {
					view.set(input, at);
					words[2 * i] = at;
					words[2 * i + 1] = input.length;
					at += input.length + 64;
				});
				const report = await folio.run('sha256_all', [table, inputs.length, out]);
				assert.deepEqual(report.values, [inputs.length]);
				assert.equal(report.extraction, 'iteration');
				assert.equal(report.mode, 'speculative');
				assert.equal(report.workers, workers);
				assert.equal(report.iteration!.replayed, 0);
				inputs.forEach((input, i) =>
					assert.equal(
						Buffer.from(view.slice(out + 32 * i, out + 32 * i + 32)).toString('hex'),
						createHash('sha256').update(input).digest('hex'),
						`input ${i} at width ${workers}`
					)
				);
			} finally {
				await folio.close();
			}
		}
	});
}

test('the records example fixture dispatches its loop and matches the serial run', async () => {
	const bytes = new Uint8Array(
		readFileSync(new URL('../../build/records.wasm', import.meta.url))
	);
	const route = prepare(bytes).iterationRoute!;
	assert.equal(route.eligible, true);
	assert.equal(route.owner, 'digest_all');
	const records = 12;
	const size = 4096;
	const table = 1024;
	const out = 2048;
	const data = 1 << 17;
	const run = async (parallel?: 'off') => {
		const memory = new WebAssembly.Memory({ initial: 8, maximum: 8192, shared: true });
		const folio = await Folio.open(bytes, { memory, workers: 4 });
		try {
			const view = new Uint8Array(folio.memory.buffer);
			const words = new Uint32Array(folio.memory.buffer, table, 2 * records);
			for (let i = 0; i < records; i++) {
				words[2 * i] = data + i * size;
				words[2 * i + 1] = size - i;
				for (let j = 0; j < size; j++) view[data + i * size + j] = (i * 17 + j * 5) & 255;
			}
			const report = await folio.run('digest_all', [table, records, out], { parallel });
			return { report, digests: view.slice(out, out + 32 * records) };
		} finally {
			await folio.close();
		}
	};
	const serial = await run('off');
	const parallel = await run();
	assert.equal(parallel.report.extraction, 'iteration');
	assert.equal(parallel.report.iteration!.replayed, 0);
	assert.deepEqual(parallel.digests, serial.digests);
	assert.notDeepEqual(parallel.digests, new Uint8Array(32 * records));
});
// #endregion

// #region the private stack slot is not tracked
const slotRigOf = (item: string, extra = '') =>
	watRig([1, 2, 4], {}, wasm(ownerSource(item, { maximum: wat.pages, extra })));
const calleeStack = (body: string, bytes = 16) => `
	(local.set $s (i32.sub (global.get $sp) (i32.const ${bytes})))
	(global.set $sp (local.get $s))
	${body}
	(global.set $sp (i32.add (local.get $s) (i32.const ${bytes})))`;
const deepFunction = `(func $deep (param $n i32) (result i32) (local $s i32)
	(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
	(global.set $sp (local.get $s))
	(i32.store (local.get $s) (local.get $n))
	(local.set $n (if (result i32) (i32.eqz (local.get $n))
		(then (i32.const 0))
		(else (i32.add (i32.load (local.get $s)) (call $deep (i32.sub (local.get $n) (i32.const 1)))))))
	(global.set $sp (i32.add (local.get $s) (i32.const 16)))
	(local.get $n))`;

test('callee stack writes and reads leave no undo entry, only the heap store does', async () => {
	const subject = await slotRigOf(
		calleeStack(`
			(i32.store (local.get $s) (i32.load (local.get $src)))
			(i32.store offset=4 (local.get $s) (i32.const 5))
			(i32.store (local.get $dst)
				(i32.add (i32.load (local.get $s)) (i32.load offset=4 (local.get $s))))`)
	);
	try {
		for (const width of [1, 2, 4]) {
			for (const n of [1, 5, 32, 70]) {
				const r = compare(subject, width, disjoint(n));
				assert.ok(r.equal, `width ${width} n ${n}`);
				assert.equal(r.report.undoEntries, n, `width ${width} n ${n}`);
				assert.equal(r.report.replayed, 0);
				assert.equal(r.report.violations, 0);
			}
		}
	} finally {
		await subject.close();
	}
});

test('recursion in the callee stays in the slot and an overflow into the next slot replays', async () => {
	const shallow = await slotRigOf(
		`(i32.store (local.get $dst) (call $deep (i32.and (i32.load (local.get $src)) (i32.const 15))))`,
		deepFunction
	);
	try {
		for (const width of [1, 2, 4]) {
			const plan = disjoint(40);
			plan.values = Array.from({ length: 40 }, (_, i) => (i * 5) % 16);
			const r = compare(shallow, width, plan);
			assert.ok(r.equal, `width ${width}`);
			assert.equal(r.report.undoEntries, 40, `width ${width}`);
			assert.equal(r.report.replayed, 0);
		}
	} finally {
		await shallow.close();
	}
	// 400 levels of 16 bytes pass the 4096-byte slot of iteration 5 and write into iteration 4's
	const deep = await slotRigOf(
		`(i32.store (local.get $dst) (call $deep (i32.load (local.get $src))))`,
		deepFunction
	);
	try {
		for (const width of [1, 2, 4]) {
			const plan = disjoint(20);
			plan.values = Array.from({ length: 20 }, (_, i) => (i === 5 ? 400 : 3));
			const r = compare(deep, width, plan);
			assert.ok(r.equal, `width ${width}`);
			assert.ok(r.report.violations >= 1, `width ${width}`);
			assert.ok(r.report.traps >= 1);
			// iteration 4 owns the slot iteration 5 reached, so both replay
			assert.ok(r.report.rolledBack >= 2, `width ${width}`);
			assert.ok(r.report.replayed + r.report.serial >= 16, `width ${width}`);
		}
	} finally {
		await deep.close();
	}
});

test('a pointer into another slot is a violation and the run equals the serial program', async () => {
	// the address one slot up: another iteration's stack in a worker, plain memory in the serial run
	const subject = await slotRigOf(
		calleeStack(
			`(i32.store (local.get $dst) (i32.load (i32.add (local.get $s) (i32.const 4096))))`
		)
	);
	try {
		for (const width of [1, 2, 4]) {
			for (const schedule of ['forward', 'reverse'] as const) {
				const plan = disjoint(24);
				plan.values = Array.from({ length: 24 }, (_, i) => 1000 + i);
				const r = compare(subject, width, plan, { schedule });
				assert.ok(r.equal, `width ${width} ${schedule}`);
				assert.ok(r.report.violations >= 1, `width ${width} ${schedule}`);
				assert.ok(r.report.traps >= 1);
				assert.ok(r.report.replayed >= 1);
				assert.equal(r.report.stopped, 'dependency');
			}
		}
	} finally {
		await subject.close();
	}
});

test('the first and the last slot of the arena are guarded like the ones between', async () => {
	const { slots } = iterationArena(wat.arena, wat.pages * PAGE, { batch: 32, slotBytes: 4096 });
	for (const [name, slot] of [
		['first', 0],
		['last', 31]
	] as const) {
		const at = slots + slot * 4096 + 2048;
		const subject = await slotRigOf(`
			${plainItem}
			(if (i32.eq (local.get $src) (i32.const ${srcCell(3)}))
				(then (i32.store (i32.const ${at}) (i32.const 1))))`);
		try {
			const r = compare(subject, 2, disjoint(40));
			assert.ok(r.equal, name);
			assert.ok(r.report.violations >= 1, name);
		} finally {
			await subject.close();
		}
	}
});

test('a violation fails the iteration that owns the slot, and later ones, in the verdict', () => {
	const o = (
		status: number,
		touched?: number
	): Parameters<typeof iterationVerdict>[0][number] => ({
		status,
		written: new Int32Array(0),
		reads: new Int32Array(0),
		frameWritten: new Uint32Array(0),
		frameExposed: new Uint32Array(0),
		touched
	});
	const owner = iterationVerdict([o(0), o(0), o(0), o(1, 1), o(0)]);
	assert.equal(owner.first, 1);
	assert.equal(owner.firstFailure, 3);
	// a slot past the iterations that ran, or a later one, changes nothing
	assert.equal(iterationVerdict([o(0), o(1, 9), o(0)]).first, 1);
	assert.equal(iterationVerdict([o(0), o(1, 2), o(0)]).first, 1);
	assert.equal(iterationVerdict([o(0), o(0, 0), o(0)]).first, -1);
	assert.equal(iterationVerdict([o(0), o(1, -1)]).first, 1);
});

test('stale slot bytes from earlier batches and rolled back iterations never reach the result', async () => {
	const subject = await slotRigOf(
		calleeStack(`
			(i32.store (local.get $s) (i32.load (local.get $src)))
			(i32.store offset=8 (local.get $s) (i32.const 0x01020304))
			(i32.store (local.get $dst)
				(i32.add (i32.load (local.get $s)) (i32.load offset=8 (local.get $s))))`)
	);
	try {
		const { arena } = subject.pools.get(2)!;
		const view = new Uint8Array(subject.memory.buffer);
		for (const poison of [0xaa, 0x00, 0xff]) {
			view.fill(poison, arena.slots, arena.stamp);
			// 70 iterations are three batches over the same 32 slots; the RAW plan rolls some back
			for (const plan of [disjoint(70), rawPlan(70)]) {
				plan.values = Array.from({ length: 70 }, (_, i) => 0x10000000 + i * 977);
				const r = compare(subject, 2, plan);
				assert.ok(r.equal, `poison ${poison}`);
			}
		}
	} finally {
		await subject.close();
	}
});

test('memory.fill and memory.copy inside the callee stack are untracked and equal the serial run', async () => {
	const subject = await slotRigOf(
		calleeStack(
			`
			(memory.fill (local.get $s) (i32.load (local.get $src)) (i32.const 32))
			(memory.copy (i32.add (local.get $s) (i32.const 32)) (local.get $s) (i32.const 32))
			(i32.store (local.get $dst) (i32.load offset=36 (local.get $s)))`,
			64
		)
	);
	try {
		for (const width of [1, 2, 4]) {
			const r = compare(subject, width, disjoint(40));
			assert.ok(r.equal, `width ${width}`);
			assert.equal(r.report.undoEntries, 40, `width ${width}`);
			assert.equal(r.report.replayed, 0);
		}
	} finally {
		await subject.close();
	}
});

test('a fill that crosses from the callee stack into the owner frame is tracked and committed', async () => {
	const subject = await slotRigOf(`
		(memory.fill (i32.sub (local.get $f) (i32.const 8)) (i32.const 7) (i32.const 16))
		(i32.store (local.get $dst) (i32.load (i32.sub (local.get $f) (i32.const 4))))`);
	try {
		for (const width of [1, 2, 4]) {
			const r = compare(subject, width, disjoint(40));
			assert.ok(r.equal, `width ${width}`);
			const frame = (bytes: Uint8Array) =>
				Buffer.from(bytes.subarray(PAGE - wat.frame, PAGE));
			assert.ok(frame(r.want.bytes).equals(frame(r.got.bytes)), `frame at width ${width}`);
			assert.equal(r.report.replayed, 0);
			// the dst cell and the two write granules the fill spans
			assert.equal(r.report.undoEntries, 40 * 3, `width ${width}`);
		}
	} finally {
		await subject.close();
	}
});
// #endregion

// #region indirect calls
// callbacks through a module-local table: one writes only its own stack frame and the output cell,
// one also updates a shared word, one is a function of another type the table holds
const callbacks = `
	(type $cb (func (param i32) (param i32)))
	(table $cbs 4 funcref)
	(elem (i32.const 1) $private $shared $spare)
	(func $private (type $cb) (param $dst i32) (param $src i32) (local $s i32)
		(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $s))
		(i32.store (local.get $s) (i32.add (i32.load (local.get $src)) (i32.const 7)))
		(i32.store (local.get $dst) (i32.load (local.get $s)))
		(global.set $sp (i32.add (local.get $s) (i32.const 16))))
	(func $shared (type $cb) (param $dst i32) (param $src i32)
		(i32.store (i32.const 0x50000)
			(i32.add (i32.load (i32.const 0x50000)) (i32.load (local.get $src))))
		(i32.store (local.get $dst) (i32.load (i32.const 0x50000))))
	(func $spare (result i32) (i32.atomic.rmw.add (i32.const 0x50010) (i32.const 1)))`;
const through = (index: string) =>
	`(call_indirect $cbs (type $cb) (local.get $dst) (local.get $src) ${index})`;
const indirectSource = (index: string) => wasm(ownerSource(through(index), { extra: callbacks }));

test('an indirect callee that writes a private slot runs on workers and equals the serial run', async () => {
	const bytes = indirectSource('(i32.const 1)');
	const route = prepare(bytes, { minimumRegionWork: 0 }).iterationRoute!;
	assert.ok(route.eligible, route.diagnostics.join('; '));
	assert.ok(route.diagnostics.some((line) => line.startsWith('owner run')));
	const subject = await watRig([2, 4], {}, bytes);
	try {
		for (const width of [2, 4]) {
			const r = compare(subject, width, distinct(40));
			assert.ok(r.equal, `width ${width}`);
			assert.equal(r.report.replayed, 0);
			assert.equal(r.report.failedBatches, 0);
			assert.equal(r.report.regions, 40);
			assert.deepEqual(r.report.conflicts, { raw: 0, war: 0, waw: 0, frame: 0 });
			assert.equal(new Uint32Array(r.got.bytes.buffer, dstCell(3), 1)[0], 5 + 3 + 7);
		}
	} finally {
		await subject.close();
	}
});

test('an indirect callee that writes shared state conflicts and replays to the serial result', async () => {
	const subject = await watRig([2, 4], {}, indirectSource('(i32.const 2)'));
	try {
		for (const width of [2, 4]) {
			const r = compare(subject, width, distinct(40));
			assert.ok(r.equal, `width ${width}`);
			assert.ok(r.report.replayed > 0, `width ${width}`);
			assert.ok(r.report.conflicts.raw > 0 && r.report.conflicts.waw > 0, `width ${width}`);
		}
	} finally {
		await subject.close();
	}
});

test('an indirect call that picks the callee from the data keeps the serial result', async () => {
	// even values take the private callee, odd values the shared one
	const pick = '(i32.add (i32.const 1) (i32.and (i32.load (local.get $src)) (i32.const 1)))';
	const subject = await watRig([4], {}, indirectSource(pick));
	try {
		const r = compare(subject, 4, distinct(40));
		assert.ok(r.equal);
		assert.ok(r.report.replayed > 0);
		const private_ = compare(subject, 4, {
			...disjoint(40),
			values: Array.from({ length: 40 }, (_, i) => 2 * i)
		});
		assert.ok(private_.equal);
		assert.equal(private_.report.replayed, 0);
	} finally {
		await subject.close();
	}
});

test('Folio.run sends a loop of indirect calls to workers and matches the serial program', async () => {
	for (const [index, replays] of [
		['(i32.const 1)', false],
		['(i32.const 2)', true]
	] as const) {
		const run = await both(indirectSource(index), distinct(40), 4);
		try {
			assert.ok(run.equal, index);
			assert.equal(run.got.report!.extraction, 'iteration');
			assert.equal(run.got.report!.mode, 'speculative');
			assert.equal(run.got.report!.iteration!.replayed > 0, replays, index);
		} finally {
			await run.folio.close();
		}
	}
});

test('a table entry the loop cannot reach is a stub in the worker module', () => {
	const route = prepare(indirectSource('(i32.const 1)'), {
		minimumRegionWork: 0
	}).iterationRoute!;
	const module = binaryen.readBinary(Uint8Array.from(route.module!));
	try {
		const ids = Array.from({ length: module.getNumFunctions() }, (_, i) =>
			binaryen.getExpressionId(binaryen.getFunctionInfo(module.getFunctionByIndex(i)).body)
		);
		assert.equal(ids.filter((id) => id === binaryen.UnreachableId).length, 1);
		assert.equal(module.getNumTables(), 1);
		const segment = binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(0));
		assert.equal(segment.data.length, 3);
		assert.equal(new Set(segment.data).size, 3);
		assert.equal((binaryen.getExpressionInfo(segment.offset) as { value?: number }).value, 1);
	} finally {
		module.dispose();
	}
});

test('an unsafe table keeps the loop on the older path with the table named', () => {
	const exported = callbacks.replace(
		'(table $cbs 4 funcref)',
		'(table $cbs (export "t") 4 funcref)'
	);
	const prepared = prepare(wasm(ownerSource(through('(i32.const 1)'), { extra: exported })), {
		minimumRegionWork: 0
	});
	assert.equal(prepared.iterationRoute!.eligible, false);
	assert.ok(prepared.stackRoute!.diagnostics.includes('refused table cbs: exported table'));
});
// #endregion

// #region windows, the tabled validator and the verdict memory
const lcg = (seed: number) => {
	let s = seed >>> 0;
	return (n: number) => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s % n;
	};
};

test('the tabled validator counts the same pairs as the pairwise one', () => {
	for (let seed = 1; seed <= 60; seed++) {
		const next = lcg(seed);
		const count = 2 + next(31);
		const range = 6 + next(60);
		const outcomes = Array.from({ length: count }, () => {
			const written = [...new Set(Array.from({ length: next(14) }, () => next(range)))].sort(
				(a, b) => a - b
			);
			const runs: number[] = [];
			for (let at = next(8); at < range / 2; at += 1 + next(10)) {
				const length = 1 + next(seed % 3 ? 3 : 40);
				runs.push(at, length);
				at += length;
			}
			return { status: 0, written: Int32Array.from(written), reads: Int32Array.from(runs) };
		});
		for (const skip of [[], ['raw'], ['war', 'waw']] as const) {
			const a = tabledConflicts(outcomes, skip);
			const b = pairwiseConflicts(outcomes, skip);
			assert.deepEqual(a, b, `seed ${seed} skip ${skip.join()}`);
		}
	}
	const many = Array.from({ length: 40 }, (_, k) => ({
		status: 0,
		written: Int32Array.of(k),
		reads: Int32Array.of(k + 1, 1)
	}));
	assert.throws(() => tabledConflicts(many, []), RangeError);
	const { first, ...pairs } = pairwiseConflicts(many, []);
	assert.deepEqual(iterationVerdict(many).conflicts, { ...pairs, frame: 0 });
	assert.equal(iterationVerdict(many).first, first);
	assert.ok(pairs.raw + pairs.war > 0);
});

test('a verdict counts the frame conflicts that fall in the window words', () => {
	const o = (frameWritten: number[], frameExposed: number[]) => ({
		status: 0,
		written: new Int32Array(0),
		reads: new Int32Array(0),
		frameWritten: Uint32Array.from(frameWritten),
		frameExposed: Uint32Array.from(frameExposed)
	});
	const v = iterationVerdict([o([1, 0], []), o([], [1, 0]), o([0, 1], []), o([], [0, 1])], [], 1);
	assert.equal(v.conflicts.frame, 2);
	assert.equal(v.window, 1);
	assert.equal('window' in iterationVerdict([o([1], []), o([], [1])]), false);
});

test('a window is the span of the granules half the iterations wrote, rounded to 64 bytes', () => {
	const w = (...granules: number[]) => ({ written: Int32Array.from(granules) });
	// granule 2050 is 0x10040; every iteration writes 2050 and 2051
	const found = discoverWindow([w(2050, 2051), w(2050, 2051), w(2050, 2051, 9000)], 4096);
	assert.deepEqual(found.window, { low: 0x10040, end: 0x10080 });
	// a granule one iteration of three wrote is not shared by half
	assert.equal(discoverWindow([w(5), w(6), w(7)], 4096).window, undefined);
	assert.match(discoverWindow([w(5), w(6)], 4096).reason!, /no write granule is shared/);
	// a span over the cap names its clusters and is refused
	const far = discoverWindow([w(10, 5000), w(10, 5000)], 4096);
	assert.equal(far.window, undefined);
	assert.match(far.reason!, /over 4096: 0x140\+32 0x27100\+32/);
});

test('a window copy sits below the frame at the window offset modulo 64', () => {
	for (const frame of [0, 64, 176]) {
		for (const low of [0x10000, 0x10040, 0x105100]) {
			const top = 0x548000;
			const window = { low, end: low + 192 };
			const c = iterationWindowCopy(top, frame, window);
			assert.equal(c.copy % 64, low % 64);
			assert.equal(c.delta, c.copy - low);
			assert.ok(c.copy + 192 <= top - frame);
			assert.ok(top - frame - (c.copy + 192) < 64);
			assert.equal(c.region, top - c.copy);
			assert.equal(c.frameOffset, c.copy === 0 ? 0 : top - frame - c.copy);
		}
	}
	assert.throws(() => iterationArena(0, 1 << 20, { windowBytes: 100 }), RangeError);
	assert.ok(
		iterationArena(0, 1 << 20, { windowBytes: 1024 }).frameSlotBytes >
			iterationArena(0, 1 << 20).frameSlotBytes
	);
});

// the window items: every iteration writes the cell at 0x40000 first; the carried form reads it first
const scratchItem = `
	(i32.store (i32.const 0x40000) (i32.load (local.get $src)))
	(i32.store offset=4 (i32.const 0x40000) (i32.add (i32.load (i32.const 0x40000)) (i32.const 1)))
	(i32.store (local.get $dst) (i32.add (i32.load (i32.const 0x40000)) (i32.load offset=4 (i32.const 0x40000))))`;
const carriedWindowItem = `
	(i32.store (i32.const 0x40000) (i32.add (i32.load (i32.const 0x40000)) (i32.load (local.get $src))))
	(i32.store (local.get $dst) (i32.load (i32.const 0x40000)))`;
const edgeItem = `
	${scratchItem}
	(memory.copy (i32.add (local.get $dst) (i32.const 8)) (i32.const 0x40038) (i32.const 16))`;

test('a scratch cell every iteration writes first moves to a window and the run equals serial', async () => {
	const run = await both(wasm(ownerSource(scratchItem)), distinct(100), 4);
	try {
		assert.ok(run.equal);
		const counts = run.got.report!.iteration!;
		assert.deepEqual(counts.window, {
			low: 0x40000,
			end: 0x40040,
			source: 'discovered',
			batches: counts.window!.batches
		});
		assert.ok(counts.window!.batches >= 2);
		// the failed first batch is rolled back, two probes and the windowed batches are kept
		assert.equal(counts.replayed, 32);
		assert.equal(counts.regions, 99);
		assert.equal(counts.windowConflicts, 0);
		assert.equal(counts.stopped, undefined);
		// the second call starts on the window: no failed batch, no conflict
		const { image, args } = planImage(distinct(100));
		void image;
		const again = await run.folio.run('run', args);
		const second = again.iteration!;
		assert.equal(second.window!.source, 'given');
		assert.equal(second.replayed, 0);
		assert.equal(second.conflicts.raw + second.conflicts.waw + second.conflicts.war, 0);
	} finally {
		await run.folio.close();
	}
});

// the first iteration of the loop also fills 2176 write granules past the scratch cell, past the 2048
// of a log; the others do not. The cell is the shared location, and the fill is what a race on it
// can do to an iteration, here fixed by the iteration's position so no timing is involved
const wildItem = `
	${scratchItem}
	(if (i32.eq (local.get $src) (i32.const ${srcCell(1)}))
		(then (memory.fill (i32.const 0x50000) (i32.const 1) (i32.const 69632))))`;

test('an exhausted log in a batch that shares a scratch cell is not final: the window is probed first', async () => {
	const run = await both(wasm(ownerSource(wildItem)), distinct(100), 4);
	try {
		assert.ok(run.equal);
		const counts = run.got.report!.iteration!;
		assert.ok(counts.exhausted >= 1, 'the first batch exhausted a log');
		assert.equal(counts.stopped, undefined, 'the loop was not stopped by it');
		assert.deepEqual(counts.window && { ...counts.window, batches: 0 }, {
			low: 0x40000,
			end: 0x40040,
			source: 'discovered',
			batches: 0
		});
		assert.ok(counts.window!.batches >= 1);
		assert.ok(counts.regions > 40, 'later batches ran on the workers');
	} finally {
		await run.folio.close();
	}
});

test('an exhausted log with no scratch cell to blame still ends the dispatch', async () => {
	// the same fill, one region per iteration and no shared write
	const item = `(if (i32.lt_u (local.get $src) (i32.const ${srcCell(9)}))
		(then (memory.fill (i32.add (i32.const 0x50000) (i32.mul (i32.load (local.get $src)) (i32.const 0x11000))) (i32.const 1) (i32.const 69632))))
		(i32.store (local.get $dst) (i32.load (local.get $src)))`;
	const run = await both(wasm(ownerSource(item, { maximum: 4096 })), distinct(100), 4);
	try {
		const counts = run.got.report!.iteration!;
		assert.ok(counts.exhausted >= 1);
		assert.equal(counts.window, undefined);
		assert.equal(counts.stopped, 'log-exhausted');
	} finally {
		await run.folio.close();
	}
});

test('a window the iterations read before they write is refused by validation', async () => {
	const run = await both(wasm(ownerSource(carriedWindowItem)), distinct(60), 4);
	try {
		assert.ok(run.equal);
		const counts = run.got.report!.iteration!;
		assert.ok(counts.window);
		assert.ok(counts.windowConflicts > 0);
		assert.equal(counts.stopped, 'frame-carried dependence');
		assert.equal(run.got.report!.reason, 'frame-carried dependence');
	} finally {
		await run.folio.close();
	}
});

test('a range that crosses the window edge traps and the iteration replays serially', async () => {
	const run = await both(wasm(ownerSource(edgeItem)), distinct(80), 4);
	try {
		assert.ok(run.equal);
		const counts = run.got.report!.iteration!;
		assert.ok(counts.window);
		assert.ok(counts.traps > 0);
		assert.ok(counts.replayed > 32);
	} finally {
		await run.folio.close();
	}
});

test('a loop with no shared write names why it needs no window', async () => {
	const run = await both(wasm(ownerSource(carriedItem)), distinct(40), 4);
	try {
		assert.ok(run.equal);
		const counts = run.got.report!.iteration!;
		assert.equal(counts.window, undefined);
		assert.match(counts.windowRefused ?? 'none', /shared by half|none/);
		assert.equal(counts.batches, 1);
	} finally {
		await run.folio.close();
	}
});

test('the lowering with a window compiles with and without a stack and exports the window globals', () => {
	for (const text of [
		ownerSource(scratchItem),
		ownerSource(scratchItem).replace(/\(global \$sp[^\n]*\n/, '')
	]) {
		if (!text.includes('$sp (mut')) continue;
		const route = prepare(wasm(text), { minimumRegionWork: 0 }).iterationRoute!;
		assert.ok(route.eligible);
		const lowered = lowerInline(route.module!, { window: true });
		const names = WebAssembly.Module.exports(
			new WebAssembly.Module(Uint8Array.from(lowered))
		).map((e) => e.name);
		for (const name of ['__folio_wl', '__folio_we', '__folio_wd', '__folio_fl', '__folio_xl'])
			assert.ok(names.includes(name), name);
	}
	const plain = lowerInline(
		prepare(wasm(ownerSource(scratchItem)), { minimumRegionWork: 0 }).iterationRoute!.module!,
		{ slot: true }
	);
	const names = WebAssembly.Module.exports(new WebAssembly.Module(Uint8Array.from(plain))).map(
		(e) => e.name
	);
	assert.ok(!names.includes('__folio_wl'));
});

test('a given window the arena cannot hold is refused with the reason and the loop still equals serial', async () => {
	const rigWithWindow = await watRig([2], { windowBytes: 256, slotBytes: 8192 });
	try {
		const { image, args } = planImage(disjoint(40));
		const want = serialRun(rigWithWindow, image, args);
		for (const [window, why] of [
			[{ low: 0x40001, end: 0x40040 }, /not 64-byte aligned/],
			[{ low: 0x40000, end: 0x40400 }, /over 256/],
			[
				{ low: rigWithWindow.arenaBase, end: rigWithWindow.arenaBase + 64 },
				/overlaps the arena/
			]
		] as const) {
			const got = iterationRun(rigWithWindow, 2, image, args, { window });
			assert.equal(firstDifference(rigWithWindow, want.bytes, got.bytes), -1);
			assert.match(got.report!.windowRefused!, why);
			assert.equal(got.report!.window, undefined);
		}
		const ok = iterationRun(rigWithWindow, 2, image, args, {
			window: { low: 0x40000, end: 0x40040 }
		});
		assert.equal(firstDifference(rigWithWindow, want.bytes, ok.bytes), -1);
		assert.equal(ok.report!.window!.source, 'given');
	} finally {
		await rigWithWindow.close();
	}
});
// #endregion

test('a stop one call recorded skips the dispatch for sixteen calls and then probes again', async () => {
	const source = wasm(ownerSource(carriedItem));
	const { image, args } = planImage(distinct(40));
	const memory = new WebAssembly.Memory({ initial: wat.pages, maximum: 128 });
	new Uint8Array(memory.buffer).set(image);
	const serial = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory }
	}).exports.run as CallableFunction;
	const folio = await Folio.open(source, { workers: 4 });
	try {
		new Uint8Array(folio.memory.buffer).set(image);
		const batches: (number | undefined)[] = [];
		for (let call = 0; call < 19; call++) {
			serial(...args);
			const report = await folio.run('run', args);
			batches.push(report.iteration?.batches);
			assert.equal(report.reason, 'frame-carried dependence', `call ${call}`);
			assert.equal(
				Buffer.compare(
					programPages(memory, wat.pages),
					programPages(folio.memory, wat.pages)
				),
				0,
				`call ${call}`
			);
		}
		// one batch on the first call, none on the sixteen that follow, one again on the probe
		assert.equal(batches[0], 1);
		assert.deepEqual(batches.slice(1, 17), Array(16).fill(undefined));
		assert.equal(batches[17], 1);
	} finally {
		await folio.close();
	}
});

// #region the stall guard
// iteration 0 burns and then writes the shared cell; the others read it first and, on a stale 0,
// log a write and spin on their copy, which serially never happens
const staleCell = srcCell(0);
const staleItem = `
	(local.set $s (i32.load (local.get $src)))
	(if (i32.eq (local.get $dst) (i32.const ${dstCell(0)}))
		(then
			(local.set $src (i32.const 0x6000000))
			(loop $burn (br_if $burn (local.tee $src (i32.sub (local.get $src) (i32.const 1)))))
			(i32.store (i32.const ${staleCell}) (i32.const 1)))
		(else
			(if (i32.eqz (local.get $s)) (then (i32.store (i32.const 0x50000) (i32.const 0xdead))))
			(loop $spin (br_if $spin (i32.eqz (local.get $s))))))
	(i32.store (local.get $dst) (i32.add (local.get $s) (i32.const 1)))`;
const stalePlan = (n: number): Plan => {
	const plan = disjoint(n);
	plan.src = plan.src.map(() => staleCell);
	plan.values = Array.from({ length: n }, () => 0);
	return plan;
};

test('a worker that spins on a value another iteration changed is stopped and the result is serial', async () => {
	const stale = await watRig(
		[2],
		{ stall: { floorMs: 300, factor: 0 } },
		wasm(ownerSource(staleItem, { maximum: wat.pages }))
	);
	try {
		for (const round of [1, 2]) {
			const t = performance.now();
			const r = compare(stale, 2, stalePlan(6));
			assert.ok(performance.now() - t < 20000, `round ${round}`);
			assert.equal(r.equal, true, `round ${round}`);
			assert.equal(r.report.stopped, 'stalled');
			assert.equal(r.report.stalls, 1);
			assert.ok(r.report.stalledIterations >= 1);
			// the ghost write of the stuck iteration was rolled back: serially the cell stays 0
			assert.equal(new DataView(r.got.bytes.buffer).getUint32(0x50000, true), 0);
			assert.equal(r.report.replayed + r.report.serial >= 5, true);
		}
	} finally {
		await stale.close();
	}
});

test('a pool without the stall option has no stop poll and a stall limit must be positive', async () => {
	const bytes = wasm(ownerSource(plainItem, { shared: true }));
	assert.ok(
		lowerInline(bytes, { stop: true }).length > lowerInline(bytes, {}).length,
		'the poll adds code to the loop'
	);
	const route = prepare(bytes, { minimumRegionWork: 0 }).iterationRoute!;
	const memory = new WebAssembly.Memory({ initial: wat.pages, maximum: wat.pages, shared: true });
	for (const stall of [{ floorMs: 0 }, { floorMs: -5 }, { factor: -1 }])
		await assert.rejects(
			IterationPool.open(route, memory, { arenaBase: wat.arena, width: 1, stall }),
			RangeError
		);
});

test('two hundred batches of sixteen with the guard armed never stall', async () => {
	const armed = await watRig(
		[8],
		{ stall: true },
		wasm(ownerSource(plainItem, { maximum: wat.pages }))
	);
	try {
		for (let i = 0; i < 200; i++) {
			const r = compare(armed, 8, disjoint(16));
			assert.equal(r.equal, true, `run ${i}`);
			assert.equal(r.report.stalls, 0, `run ${i}`);
			assert.equal(r.report.stopped, undefined, `run ${i}`);
		}
	} finally {
		await armed.close();
	}
});
// #endregion

// #region second chance
const floorMs = iterationAdmissionConstants.fixedMs * iterationAdmissionConstants.margin;

test('the second chance admits a loop between half the floor and the floor as a probe', () => {
	const t = (fraction: number, trip = 101) => (fraction * floorMs) / (trip - 1);
	const off = admitIteration({ plainIterationMs: t(0.75), trip: 101, width: 4 });
	assert.equal(off.admitted, false);
	assert.equal(off.probe, undefined);
	const on = (plainIterationMs: number, trip = 101, width = 4) =>
		admitIteration({ plainIterationMs, trip, width, secondChance: true });
	const probe = on(t(0.75));
	assert.equal(probe.admitted, true);
	assert.equal(probe.probe, true);
	assert.equal(probeFraction, 0.5);
	assert.equal(on(t(0.49)).admitted, false, 'under half the floor');
	assert.equal(on(t(0.25)).admitted, false);
	// over the floor the loop is admitted outright, with no probe, as without the option
	const above = on(t(1.5));
	assert.equal(above.admitted, true);
	assert.equal(above.probe, undefined);
	assert.deepEqual(on(t(1.5)), admitIteration({ plainIterationMs: t(1.5), trip: 101, width: 4 }));
	// the structural limits of admission still hold
	assert.equal(on(t(0.75, 2), 2).admitted, false, 'one iteration left');
	assert.equal(on(t(0.75), 101, 1).admitted, false, 'one worker');
	assert.equal(on(Number.NaN).admitted, false);
	// through the seam, and force still admits a loop of any size
	admissionSeam.force = false;
	admissionSeam.scale = 1;
	assert.equal(decideAdmission(t(0.75), 101, 4, true).probe, true);
	assert.equal(decideAdmission(t(0.75), 101, 4).admitted, false);
	admissionSeam.force = true;
	assert.equal(decideAdmission(1e-9, 101, 4).admitted, true);
	admissionSeam.force = false;
});

test('the remaining-work decision trusts a timed batch for a loop under the floor', () => {
	admissionSeam.force = false;
	admissionSeam.scale = 1;
	admissionSeam.batchScale = 1;
	const perIteration = 0.02;
	const remaining = 20;
	assert.ok(remaining * perIteration < floorMs);
	// without a batch to go on the floor decides, as before
	assert.equal(decideRemaining(perIteration, remaining, 4), false);
	// a batch of 32 that took 0.1 ms: 20 iterations cost one batch, 0.1 ms * 1.25, against 0.4 ms
	assert.equal(decideRemaining(perIteration, remaining, 4, { wallMs: 0.1, count: 32 }), true);
	// the same batch at 0.3 ms: 0.375 ms against 0.4 ms is still a win, 0.33 ms is not
	assert.equal(decideRemaining(perIteration, remaining, 4, { wallMs: 0.3, count: 32 }), true);
	assert.equal(decideRemaining(perIteration, remaining, 4, { wallMs: 0.33, count: 32 }), false);
	// the batches that cover what is left are counted: 70 iterations are three batches
	assert.equal(decideRemaining(0.02, 70, 4, { wallMs: 0.4, count: 32 }), false);
	assert.equal(decideRemaining(0.02, 70, 4, { wallMs: 0.3, count: 32 }), true);
	// over the floor the answer does not depend on the batch
	assert.equal(decideRemaining(1, 20, 4), true);
	assert.equal(decideRemaining(1, 20, 4, { wallMs: 1e9, count: 32 }), true);
	// nothing to dispatch to or nothing left
	assert.equal(decideRemaining(perIteration, remaining, 1, { wallMs: 0.1, count: 32 }), false);
	assert.equal(decideRemaining(perIteration, 1, 4, { wallMs: 0.1, count: 32 }), false);
	assert.equal(decideRemaining(Number.NaN, remaining, 4, { wallMs: 0.1, count: 32 }), false);
	assert.equal(decideRemaining(perIteration, remaining, 4, { wallMs: 0.1, count: 0 }), false);
	// the seam scales the batch wall, as it does for the batch rule
	admissionSeam.batchScale = 100;
	assert.equal(decideRemaining(perIteration, remaining, 4, { wallMs: 0.1, count: 32 }), false);
	admissionSeam.batchScale = 1;
});

test('a batch on read windows has a scale of its own, fitted to the same reference', () => {
	const first = { estimateMs: 1 };
	// the learning batch tracks at 4.0 ms per iteration: the scale is 1 / 4
	const plain = refineEstimate(first, Array(8).fill(4));
	assert.equal(plain.kappa, 0.25);
	assert.equal(plain.referenceMs, 1);
	assert.equal(plain.kappaWindows, undefined);
	// the first batch on windows tracks at 1.25 ms: with the old scale the estimate read 0.31 ms
	const windowed = refineEstimate(plain, Array(32).fill(1.25), true);
	assert.equal(windowed.kappa, 0.25, 'the unwindowed scale stays');
	assert.equal(windowed.kappaWindows, 0.8);
	assert.ok(Math.abs(windowed.estimateMs - 1) < 1e-12);
	assert.equal(windowed.referenceMs, 1);
	// later batches on windows keep it, later batches without windows use the first scale
	const again = refineEstimate(windowed, Array(8).fill(2.5), true);
	assert.equal(again.kappaWindows, 0.8);
	assert.ok(Math.abs(again.estimateMs - 2) < 1e-12);
	const back = refineEstimate(windowed, Array(8).fill(4));
	assert.equal(back.kappa, 0.25);
	assert.ok(Math.abs(back.estimateMs - 1) < 1e-12);
	// a window that is no cheaper to track keeps the cap at one
	assert.equal(refineEstimate(plain, Array(8).fill(0.5), true).kappaWindows, 1);
	// a loop that never ran on windows has the same estimate as before
	assert.deepEqual(
		refineEstimate({ estimateMs: 1 }, Array(8).fill(1.4)).estimateMs,
		refineEstimate({ estimateMs: 1 }, Array(8).fill(1.4), false).estimateMs
	);
});

const probing = (plainIterationMs: number) => ({
	plainIterationMs,
	remainingSerialMs: 0,
	floorMs: 0,
	admitted: true,
	probe: true
});

test('a probe is judged on its first timed batch and an ordinary admission on its second', () => {
	const seen: (number | undefined)[] = [];
	// the batch wins: every batch is dispatched and every later question carries the last batch
	const won = compare(rig, 4, disjoint(100), {
		admit: probing,
		loses: () => false,
		reconsider: (_, __, last) => {
			seen.push(last?.count);
			return true;
		}
	});
	assert.ok(won.equal);
	assert.equal(won.report.batches, 4);
	assert.equal(won.report.stopped, undefined);
	assert.equal(won.report.admission!.probeLost, undefined);
	assert.deepEqual(seen, [32, 32, 32]);
	// the batch loses: one batch, then the rest runs serially, and the probe is marked lost
	const lost = compare(rig, 4, disjoint(100), { admit: probing, loses: () => true });
	assert.ok(lost.equal);
	assert.equal(lost.report.batches, 1);
	assert.equal(lost.report.regions, 32);
	assert.equal(lost.report.serial, 1 + 67);
	assert.equal(lost.report.stopped, 'no-admission');
	assert.equal(lost.report.admission!.probeLost, true);
	assert.equal(lost.report.replayed, 0);
	// an ordinary admission needs two slow batches and is never marked lost
	const ordinary = compare(rig, 4, disjoint(100), { admit: accepts, loses: () => true });
	assert.ok(ordinary.equal);
	assert.equal(ordinary.report.batches, 2);
	assert.equal(ordinary.report.stopped, 'no-admission');
	assert.equal(ordinary.report.admission!.probeLost, undefined);
	// a probe that collapses is lost on the one batch too
	const collapsed = compare(rig, 4, disjoint(100), {
		admit: probing,
		loses: () => false,
		collapses: () => true
	});
	assert.ok(collapsed.equal);
	assert.equal(collapsed.report.batches, 1);
	assert.equal(collapsed.report.admission!.probeLost, true);
	// a probe whose first batch conflicts is a dependence, which is its own stop and not a lost probe
	const raw = compare(rig, 4, rawPlan(100), { admit: probing, loses: () => false });
	assert.ok(raw.equal);
	assert.equal(raw.report.stopped, 'dependency');
	assert.equal(raw.report.admission!.probeLost, undefined);
});

// opens a pool and reruns the loop until the seam puts its serial time between half the floor and
// the floor, which is where the probe is admitted; the measured time of iteration 0 is noisy
async function zoned(plan: Plan, batchScale: number, trips = plan.src.length) {
	const source = wasm(ownerSource(plainItem));
	let scale = 1e4;
	for (let attempt = 0; attempt < 12; attempt++) {
		admissionSeam.force = false;
		admissionSeam.scale = scale;
		admissionSeam.batchScale = batchScale;
		const run = await both(source, plan, 4, trips, 'run', { iterationSecondChance: true });
		const a = run.got.report?.iteration?.admission;
		if (a?.probe) return run;
		await run.folio.close();
		scale *= a && a.remainingSerialMs > 0 ? (0.75 * a.floorMs) / a.remainingSerialMs : 2;
	}
	throw new Error('the seam never put the loop in the probe zone');
}

test('a probe whose batch wins is dispatched to the end, and the result is the serial one', async () => {
	const run = await zoned(disjoint(100), 1e-9);
	try {
		assert.ok(run.equal);
		const counts = run.got.report!.iteration!;
		const a = counts.admission!;
		assert.equal(a.admitted, true);
		assert.equal(a.probe, true);
		assert.ok(
			a.remainingSerialMs <= a.floorMs && a.remainingSerialMs > a.floorMs * probeFraction
		);
		assert.equal(a.probeLost, undefined);
		// iterations 0 and 1 run on the owner, which times the second for the probe
		assert.equal(counts.regions, 98);
		assert.equal(counts.serial, 2);
		assert.equal(counts.batches, 4);
		assert.equal(counts.stopped, undefined);
		assert.equal(run.got.report!.reason, undefined);
	} finally {
		admissionSeam.scale = 1;
		admissionSeam.batchScale = 1;
		await run.folio.close();
	}
});

test('a probe whose batch loses ends after one batch and the loop stays serial for 16 calls', async () => {
	const plan = disjoint(100);
	const run = await zoned(plan, 1e9);
	try {
		assert.ok(run.equal);
		const first = run.got.report!;
		assert.equal(first.iteration!.batches, 1);
		assert.equal(first.iteration!.admission!.probeLost, true);
		assert.equal(first.reason, 'no-admission');
		const { image, args } = planImage(plan);
		const batches: (number | undefined)[] = [];
		for (let call = 0; call < 16; call++) {
			new Uint8Array(run.folio.memory.buffer).set(image);
			const report = await run.folio.run('run', args);
			batches.push(report.iteration?.batches);
			assert.equal(report.reason, 'no-admission', `call ${call}`);
		}
		assert.deepEqual(batches, Array(16).fill(undefined));
	} finally {
		admissionSeam.scale = 1;
		admissionSeam.batchScale = 1;
		await run.folio.close();
	}
});

test('a probe whose first batch conflicts is not probed again for 16 calls', async () => {
	const plan = rawPlan(100);
	const run = await zoned(plan, 1);
	try {
		assert.ok(run.equal);
		const first = run.got.report!;
		assert.equal(first.reason, 'dependency');
		assert.equal(first.iteration!.admission!.probe, true);
		const { image, args } = planImage(plan);
		for (let call = 0; call < 16; call++) {
			new Uint8Array(run.folio.memory.buffer).set(image);
			const report = await run.folio.run('run', args);
			assert.equal(report.reason, 'dependency', `call ${call}`);
			assert.equal(report.iteration?.batches, undefined, `call ${call}`);
		}
	} finally {
		admissionSeam.scale = 1;
		admissionSeam.batchScale = 1;
		await run.folio.close();
	}
});

test('the second chance is off unless asked for: a loop under the floor stays serial', async () => {
	admissionSeam.force = false;
	admissionSeam.batchScale = 1;
	admissionSeam.scale = 1e4;
	const source = wasm(ownerSource(plainItem));
	let probes = 0;
	for (let attempt = 0; attempt < 4; attempt++) {
		const run = await both(source, disjoint(100), 4);
		try {
			assert.ok(run.equal);
			if (run.got.report?.iteration?.admission?.probe) probes++;
		} finally {
			await run.folio.close();
		}
	}
	admissionSeam.scale = 1;
	assert.equal(probes, 0);
});
// #endregion

// #region wrong-side admission
test('the bound is the serial time over the workers share of the tracked time', () => {
	// 8 iterations of 1 ms serial, tracked at 10 ms each, on 8 workers: one tracked iteration each
	assert.equal(batchBound(1, Array(8).fill(10), 8), 0.8);
	// the same on 4 workers: two tracked iterations each
	assert.equal(batchBound(1, Array(8).fill(10), 4), 0.4);
	// fewer iterations than workers still cost one tracked iteration
	assert.equal(batchBound(1, Array(2).fill(2), 8), 1);
	// times of zero or less are ignored, and nothing to go on is no bound
	assert.equal(batchBound(1, [0, -1, 5, 5], 2), 0.4);
	assert.equal(batchBound(1, [], 8), Infinity);
	assert.equal(batchBound(0, [1], 8), Infinity);
	assert.equal(batchBound(Number.NaN, [1], 8), Infinity);
	assert.equal(batchBound(1, [1], 0), Infinity);
	// a bound under one cannot pay; the seam turns the stop off with force
	admissionSeam.force = false;
	admissionSeam.batchScale = 1;
	assert.equal(decideBound(0.99), true);
	assert.equal(decideBound(1), false);
	// a first batch bounded under `proofBound` gets a short batch on its read windows
	assert.equal(decideProof(proofBound - 0.01), true);
	assert.equal(decideProof(proofBound), false);
	admissionSeam.force = true;
	assert.equal(decideBound(0.01), false);
	assert.equal(decideProof(0.01), false);
	admissionSeam.force = false;
});

test('the next batch is priced from the cost that did not shrink in the last one', () => {
	// 8 iterations tracked at 0.4 ms on 8 workers took 1 ms: 0.6 ms is wake, join and validation
	const next = projectBatch(1, Array(8).fill(0.4), 0.1, 32, 8)!;
	assert.ok(Math.abs(next.wallMs - 2.2) < 1e-12);
	assert.ok(Math.abs(next.serialMs - 3.2) < 1e-12);
	// a batch faster than its tracked time has no fixed cost to carry over
	assert.ok(Math.abs(projectBatch(0.2, Array(8).fill(0.4), 0.1, 32, 8)!.wallMs - 1.6) < 1e-12);
	assert.equal(projectBatch(1, [], 0.1, 32, 8), undefined);
	assert.equal(projectBatch(1, [0.4], 0, 32, 8), undefined);
	assert.equal(projectBatch(1, [0.4], 0.1, 0, 8), undefined);
	assert.equal(projectBatch(1, [0.4], 0.1, 32, 0), undefined);
	// the margin rule on the projection: 2.2 ms of wall for 3.2 ms of serial time passes, 3.2 does not
	assert.equal(batchLoses(next.wallMs, next.serialMs), false);
	assert.equal(batchLoses(3.2, next.serialMs), true);
});

test('a call after one that stopped on cost starts with one iteration per worker', () => {
	const sizes = (report: IterationReport) => report.admission!.trace!.map((step) => step.count);
	admissionSeam.trace = true;
	try {
		const keep = { admit: accepts, hopeless: () => false };
		const stop = { admit: accepts, hopeless: () => true };
		// a call that ran to the end leaves nothing behind, whatever came before
		assert.ok(compare(rig, 4, disjoint(100), keep).equal);
		const fresh = compare(rig, 4, disjoint(100), keep);
		assert.ok(fresh.equal);
		assert.deepEqual(sizes(fresh.report), [32, 32, 32, 3]);
		// a full first batch stops on cost, and the next call prices a short one first
		const lost = compare(rig, 4, disjoint(100), stop);
		assert.ok(lost.equal);
		assert.equal(lost.report.stopped, 'no-admission');
		assert.deepEqual(sizes(lost.report), [32]);
		const probed = compare(rig, 4, disjoint(100), keep);
		assert.ok(probed.equal, 'the result is the serial one');
		assert.deepEqual(sizes(probed.report), [4, 28, 32, 32, 3]);
		assert.equal(probed.report.stopped, undefined);
		assert.equal(probed.report.regions, 99);
		assert.equal(probed.report.replayed, 0);
		// a call that was not stopped clears it
		const cleared = compare(rig, 4, disjoint(100), keep);
		assert.deepEqual(sizes(cleared.report), [32, 32, 32, 3]);
		// a loop that loses is still stopped, after one iteration per worker
		compare(rig, 4, disjoint(100), stop);
		const again = compare(rig, 4, disjoint(100), stop);
		assert.ok(again.equal);
		assert.deepEqual(sizes(again.report), [4]);
		assert.equal(again.report.regions, 4);
		assert.equal(again.report.serial, 96);
		assert.equal(again.report.stopped, 'no-admission');
		// the floor on the serial time that is left is not evidence about the code
		const floor = compare(rig, 4, disjoint(100), { ...keep, reconsider: () => false });
		assert.ok(floor.equal);
		assert.equal(floor.report.stopped, 'no-admission');
		assert.deepEqual(sizes(floor.report), [4]);
		assert.deepEqual(sizes(compare(rig, 4, disjoint(100), keep).report), [32, 32, 32, 3]);
		compare(rig, 4, disjoint(100), stop);
		// a call that dispatched nothing says nothing about the code
		const refused = compare(rig, 4, disjoint(100), {
			admit: (ms) => ({ ...accepts(ms), admitted: false }),
			reconsider: () => false
		});
		assert.ok(refused.equal);
		assert.equal(refused.report.batches, 0);
		const after = compare(rig, 4, disjoint(100), keep);
		assert.deepEqual(sizes(after.report), [4, 28, 32, 32, 3]);
		compare(rig, 4, disjoint(100), keep);
	} finally {
		admissionSeam.trace = false;
	}
});

test('a batch that the tracking cost bounds under one ends the dispatch after one batch', () => {
	const bounds: number[] = [];
	const hopeless = (bound: number) => (bounds.push(bound), true);
	const run = compare(rig, 4, disjoint(100), { admit: accepts, hopeless });
	assert.ok(run.equal, 'the result is the serial one');
	assert.equal(run.report.batches, 1);
	assert.equal(run.report.regions, 32);
	assert.equal(run.report.replayed, 0);
	assert.equal(run.report.stopped, 'no-admission');
	assert.equal(bounds.length, 1);
	assert.ok(bounds[0]! > 0);
	// a loop that is not bounded keeps dispatching, and nothing stops it
	const kept = compare(rig, 4, disjoint(100), { admit: accepts, hopeless: () => false });
	assert.ok(kept.equal);
	// the call before stopped on cost, so this one starts with a short batch: 4, 28, 32, 32 and 3
	assert.equal(kept.report.batches, 5);
	assert.equal(kept.report.stopped, undefined);
	// the last batch has nothing after it to stop
	const whole = compare(rig, 4, disjoint(33), { admit: accepts, hopeless: () => true });
	assert.ok(whole.equal);
	assert.equal(whole.report.stopped, undefined);
	// a probe that is bounded is a lost probe
	const probe = compare(rig, 4, disjoint(100), {
		admit: (ms) => ({ ...accepts(ms), probe: true }),
		hopeless: () => true
	});
	assert.ok(probe.equal);
	assert.equal(probe.report.admission!.probeLost, true);
	// without `admit` there is no baseline and the callback is not asked
	const unasked = compare(rig, 4, disjoint(70), { hopeless: () => assert.fail('asked') });
	assert.equal(unasked.report.stopped, undefined);
});

test('a loop that wins is not stopped by the bound, and the real bound of a cheap loop is over one', async () => {
	admissionSeam.force = false;
	admissionSeam.scale = 1e4;
	admissionSeam.batchScale = 1e-9;
	const source = wasm(ownerSource(plainItem));
	try {
		const run = await both(source, disjoint(100), 4);
		try {
			assert.ok(run.equal);
			const counts = run.got.report!.iteration!;
			assert.equal(counts.stopped, undefined);
			assert.equal(counts.batches, 4);
			assert.equal(counts.regions, 99);
		} finally {
			await run.folio.close();
		}
	} finally {
		admissionSeam.scale = 1;
		admissionSeam.batchScale = 1;
	}
});
// #endregion

test('the probe estimate is the median of the block means, so a mix of record sizes does not pull it to the cheapest', () => {
	// block means over one size cycle of an MD5-like loop whose largest record takes 0.105 ms
	const means = [0.105 / 8, 0.105, 0.105 / 4, 0.105 / 16, 0.105 / 2];
	const last = means[4]!;
	const before = means[3]!;
	const mean = means.reduce((x, y) => x + y, 0) / means.length;
	assert.equal(admissionSeam.estimator, 'median');
	assert.equal(probeEstimate('min', before, last, means, mean), before);
	assert.equal(probeEstimate('median', before, last, means, mean), 0.105 / 4);
	assert.equal(probeEstimate('mean', before, last, means, mean), mean);
	assert.equal(probeEstimate('q75', before, last, means, mean), 0.105 / 2);
	assert.equal(probeEstimate('median', 0.01, 0.02, [0.01, 0.02], 0.015), 0.015);
	assert.equal(probeEstimate('median', 0.01, 0.01, [0.01], 0.01), 0.01);
	// 127 iterations remain and the floor is 2.5 ms: the minimum stays under it and the median clears it
	assert.ok(127 * probeEstimate('min', before, last, means, mean) < 2.5);
	assert.ok(127 * probeEstimate('median', before, last, means, mean) > 2.5);
});
