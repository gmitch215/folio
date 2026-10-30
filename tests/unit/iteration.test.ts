import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, test } from 'vitest';
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
import { inlineEntryBytes } from '../../src/inline.ts';
import {
	admissionSeam,
	admitIteration,
	decideAdmission,
	iterationAdmissionConstants
} from '../../src/iteration-admission.ts';
import { iterationOwner } from '../../src/iteration-owner.ts';
import type { IterationOutcome } from '../../src/iteration.ts';
import {
	IterationPool,
	iterationArena,
	iterationArenaBytes,
	iterationArguments,
	iterationEntryBytes,
	iterationFit,
	iterationVerdict
} from '../../src/iteration.ts';
import type { ExecutionReport } from '../../src/node.ts';
import { Folio } from '../../src/node.ts';

const widths = [1, 2, 4, 8];
let rig: Rig;
let small: Rig;

beforeAll(async () => {
	rig = await watRig(widths);
	small = await watRig([2], { logCapacity: 5 });
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

test('the verdict applies RAW, WAR and WAW to the returned lists', () => {
	const o = (written: number[], reads: number[], status = 0): IterationOutcome => ({
		index: 0,
		status,
		entries: written.length,
		written: Int32Array.from(written),
		reads: Int32Array.from(reads)
	});
	// write granules are 32 bytes, read runs [start, length] are 64-byte granules
	const free = iterationVerdict([o([0], [10, 1]), o([2], [12, 1]), o([4], [14, 2])]);
	assert.deepEqual(free, { first: -1, firstFailure: -1, conflicts: { raw: 0, war: 0, waw: 0 } });
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
	const plan = rawPlan(72);
	for (let i = 3; i < 40; i += 4) plan.src[i] = srcCell(i);
	const r = compare(rig, 4, plan);
	assert.ok(r.equal);
	assert.equal(r.report.batches, 3);
	assert.ok(r.report.failedBatches >= 1 && r.report.failedBatches < 3);
	assert.ok(r.report.replayed < 72 - 32);
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

test('the probe reports a read of the owner frame image and skips a failing first iteration', () => {
	// the family reads a value its owner stored in the frame, so the probe reports it as carried
	const frame = compare(rig, 4, disjoint(40), { probe: true });
	assert.ok(frame.equal);
	assert.equal(frame.report.probe, 'carried');
	assert.equal(frame.report.replayed, 40);
	assert.equal(frame.report.rolledBack, 32);
	assert.equal(frame.report.batches, 1);
	assert.ok(frame.report.probeMs > 0);
	// iteration 0 reads a cell iteration 3 writes: it replays, the probe cannot be checked and
	// the second batch runs serially
	const plan = disjoint(70);
	plan.src[0] = dstCell(3);
	const skipped = compare(rig, 4, plan, { probe: true });
	assert.ok(skipped.equal);
	assert.equal(skipped.report.probe, 'skipped');
	assert.equal(skipped.report.batches, 1);
	assert.equal(skipped.report.replayed, 70);
	assert.equal(compare(rig, 4, disjoint(40)).report.probe, 'off');
});

test('an admit callback sees the probe time and a refusal runs nothing', () => {
	const seen: number[] = [];
	const plan = disjoint(40);
	const refuse = (firstIterationMs: number) => {
		seen.push(firstIterationMs);
		return {
			predictedParallelMs: 2,
			predictedSerialMs: 1,
			firstIterationMs,
			admitted: false
		};
	};
	const { image, args } = planImage(plan);
	const refused = iterationRun(rig, 4, image, args, { probe: true, admit: refuse });
	assert.equal(seen.length, 1);
	assert.ok(seen[0]! >= 0);
	assert.equal(refused.report!.regions, 0);
	assert.equal(refused.report!.batches, 0);
	assert.equal(refused.report!.replayed, 0);
	assert.equal(refused.report!.probe, 'off');
	assert.ok(refused.report!.probeMs > 0);
	assert.equal(refused.report!.admission!.admitted, false);
	// the probe is undone: no output cell was written
	assert.equal(new Uint32Array(refused.bytes.buffer, dstCell(5), 1)[0], 0xab000005);
	const accept = (firstIterationMs: number) => ({
		predictedParallelMs: 1,
		predictedSerialMs: 2,
		firstIterationMs,
		admitted: true
	});
	const ran = compare(rig, 4, plan, { probe: true, admit: accept });
	assert.ok(ran.equal);
	assert.ok(ran.report.regions > 0);
	assert.equal(ran.report.admission!.admitted, true);
	// without a probe there is no measured grain and the callback is not called
	const unprobed = compare(rig, 4, plan, {
		admit: () => assert.fail('admit needs the probe')
	});
	assert.ok(unprobed.equal);
	assert.equal(unprobed.report.admission, undefined);
});

// #region Folio.run on the iteration route
const PAGE = 65536;

// the loops of these programs are far below the cost of a dispatch, so the tests that follow force
// admission; the ones about the decision set the seam themselves
beforeEach(() => {
	admissionSeam.scale = 1;
	admissionSeam.force = true;
});
afterEach(() => {
	admissionSeam.scale = 1;
	admissionSeam.force = false;
});
const readConsumer = () => new Uint8Array(readFileSync(blake3File));

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
	entry = 'run'
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
	const folio = await Folio.open(source, { workers });
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
				assert.equal(report.regions, sizes.length);
				assert.equal(report.iteration!.regions, sizes.length);
				assert.equal(report.iteration!.replayed, 0);
				assert.equal(report.iteration!.probe, 'clear');
				assert.equal(report.reason, undefined);
				assert.deepEqual(programPages(folio.memory, 16), programPages(want.memory, 16));
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

test('a frame-carried accumulator trips the probe and the run equals the serial program', async () => {
	const source = wasm(ownerSource(carriedItem));
	const plan = disjoint(40);
	plan.values = Array.from({ length: 40 }, (_, i) => 5 + i);
	const run = await both(source, plan, 4);
	try {
		assert.ok(run.equal);
		assert.equal(run.got.report!.reason, 'frame-carried dependence');
		assert.equal(run.got.report!.iteration!.probe, 'carried');
		assert.equal(run.got.report!.iteration!.replayed, 40);
		assert.equal(run.got.report!.extraction, 'iteration');
		// the serial program sums the cells; a private frame per iteration would not
		const sums = new Uint32Array(run.want.memory.buffer, dstCell(0), 1);
		assert.equal(sums[0], 5);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(39), 1)[0], (5 + 44) * 20);
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
		assert.equal(run.got.report!.iteration!.probe, 'clear');
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
		assert.equal(run.got.report!.iteration!.replayed, 40);
		assert.equal(new Uint32Array(run.got.memory.buffer, dstCell(7), 1)[0], 99);
	} finally {
		await run.folio.close();
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
		assert.equal(many.iteration!.regions, 40);
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

test('admission compares the pooled wall with the serial wall at the boundaries', () => {
	const constants = {
		trackingFactor: 1.4,
		fixedMs: 2,
		imbalancePerWorker: 0.05,
		margin: 1.25
	};
	const decide = (firstIterationMs: number, trip: number, width: number) =>
		admitIteration({ firstIterationMs, trip, width, constants });
	// serial wall is trip * t0 / 1.4; parallel is fixed + t0 + rounds * t0 * (1 + 0.05 (w - 1))
	const near = decide(1, 32, 8);
	assert.equal(near.predictedSerialMs, 32 / 1.4);
	assert.equal(near.predictedParallelMs, 2 + 1 + 4 * (1 + 0.05 * 7));
	assert.equal(near.firstIterationMs, 1);
	// the grain at which the margin is met exactly, from the same formula
	const limit = 2 / (32 / (1.4 * 1.25) - 1 - 4 * 1.35);
	assert.equal(decide(limit * 1.01, 32, 8).admitted, true);
	assert.equal(decide(limit * 0.99, 32, 8).admitted, false);
	// just under the margin the pooled wall still beats the serial wall and is refused
	const under = decide(limit * 0.99, 32, 8);
	assert.ok(under.predictedParallelMs < under.predictedSerialMs);
	assert.ok(under.predictedParallelMs * 1.25 > under.predictedSerialMs);
	// a single iteration, and two: the probe already costs one of them
	assert.equal(decide(1e6, 1, 8).admitted, false);
	assert.equal(decide(1e6, 0, 8).admitted, false);
	assert.equal(decide(1e6, 2, 8).admitted, false);
	assert.equal(decide(1e6, 16, 8).admitted, true);
	// one worker never pays off, two workers need a large loop, eight need a smaller one
	assert.equal(decide(1e6, 64, 1).admitted, false);
	assert.equal(decide(1e6, 32, 2).admitted, true);
	assert.equal(decide(1, 32, 2).admitted, false);
	assert.equal(decide(1, 64, 8).admitted, true);
	// fewer iterations than workers use as many workers as iterations
	const few = decide(10, 4, 8);
	assert.equal(few.predictedParallelMs, 2 + 10 + 1 * 10 * (1 + 0.05 * 3));
	// the ninth iteration of eight workers needs a second round
	assert.equal(decide(10, 9, 8).predictedParallelMs, 2 + 10 + 2 * 10 * (1 + 0.05 * 7));
	// a huge iteration admits, a zero or unmeasurable one does not
	assert.equal(decide(1e9, 8, 8).admitted, true);
	assert.equal(decide(0, 128, 8).admitted, false);
	assert.equal(decide(0, 128, 8).predictedParallelMs, 2);
	assert.equal(decide(Number.NaN, 128, 8).admitted, false);
	// the constants default to the module's
	assert.deepEqual(
		admitIteration({ firstIterationMs: 5, trip: 64, width: 4 }),
		admitIteration({
			firstIterationMs: 5,
			trip: 64,
			width: 4,
			constants: iterationAdmissionConstants
		})
	);
});

test('the admission seam scales the measured grain and forces a loop of two or more', () => {
	admissionSeam.force = false;
	admissionSeam.scale = 1;
	const plain = decideAdmission(0.01, 32, 8);
	assert.equal(plain.admitted, false);
	admissionSeam.scale = 1e6;
	const scaled = decideAdmission(0.01, 32, 8);
	assert.equal(scaled.firstIterationMs, 1e4);
	assert.equal(scaled.admitted, true);
	admissionSeam.scale = 1;
	admissionSeam.force = true;
	assert.equal(decideAdmission(0.01, 32, 8).admitted, true);
	assert.equal(decideAdmission(0.01, 1, 8).admitted, false);
	assert.equal(decideAdmission(0.01, 32, 1).admitted, false);
	assert.equal(decideAdmission(0.01, 32, 8).predictedParallelMs, plain.predictedParallelMs);
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
		assert.equal(counts.probe, 'off');
		assert.ok(counts.probeMs > 0);
		const admission = counts.admission!;
		assert.equal(admission.admitted, false);
		assert.ok(admission.firstIterationMs >= 0);
		assert.ok(admission.predictedParallelMs >= iterationAdmissionConstants.fixedMs);
		assert.ok(admission.predictedParallelMs > admission.predictedSerialMs);
		// the probe left no write behind and a second run is the same
		const again = await run.folio.run('run', [planImage(disjoint(16)).args[0]!, 16]);
		assert.equal(again.reason, 'no-admission');
	} finally {
		await run.folio.close();
	}
});

test('a loop whose measured grain is large is admitted, and the seam forces a small one', async () => {
	const want = consumerReference();
	const folio = await Folio.open(readConsumer(), { workers: 4 });
	try {
		const args = consumerImage(folio.memory);
		admissionSeam.force = false;
		admissionSeam.scale = 1e9;
		const admitted = await folio.run('hash_all', args);
		assert.equal(admitted.extraction, 'iteration');
		assert.equal(admitted.iteration!.regions, sizes.length);
		const a = admitted.iteration!.admission!;
		assert.equal(a.admitted, true);
		assert.ok(
			a.predictedParallelMs * iterationAdmissionConstants.margin <= a.predictedSerialMs
		);
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
// #endregion
