import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { decodeResults, encodeFrame } from '../../src/frames.ts';
import { inlineGlobals, inlineLane } from '../../src/inline.ts';
import type { ManagedArtifact, ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { memoryImports } from '../../src/memory.ts';
import { encodeRangesFrame, RangeSet } from '../../src/ranges.ts';
import type { TransactionResult } from '../../src/transaction.ts';

function wasm(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	module.setFeatures(binaryen.Features.All);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}
const compile = (bytes: Uint8Array) => new WebAssembly.Module(Uint8Array.from(bytes));

// the artifact a build step makes: the callout module and the inline module of the same regions
function artifact(bytes: Uint8Array): ManagedArtifact {
	const plan = prepare(bytes, { minimumRegionWork: 0 }).control;
	assert.ok(plan);
	const { coordinator, transactional, workerOriginal, ...control } = plan;
	return {
		original: compile(bytes),
		coordinator: compile(coordinator),
		transactional: compile(transactional),
		inline: compile(inlineLane(workerOriginal)),
		control,
		memories: memoryImports(bytes)
	};
}
function lanes(
	program: ManagedArtifact,
	mode: 'callout' | 'inline',
	count = 4,
	logEntries?: number
): ManagedLaneTransport[] {
	return Array.from({ length: count }, () => {
		const lane = new FolioLane(program.transactional!, {
			initial: program.control!.initial,
			maximum: program.control!.maximum,
			...(mode === 'inline' ? { inline: { module: program.inline!, logEntries } } : {})
		});
		return {
			execute: async (frame) => lane.execute(new Uint8Array(frame)),
			close: async () => lane.close()
		};
	});
}
function serial(program: ManagedArtifact, seed: (bytes: Uint8Array) => void, name = 'main') {
	const instance = new WebAssembly.Instance(program.original, {});
	const memory = instance.exports.memory as WebAssembly.Memory;
	seed(new Uint8Array(memory.buffer));
	const value = (instance.exports[name] as CallableFunction)();
	return { value, memory: new Uint8Array(memory.buffer) };
}
// the same program through ManagedFolio on callout lanes, inline lanes and a serial run
async function agree(
	text: string,
	seed: (bytes: Uint8Array) => void,
	options: { logEntries?: number; ranges?: boolean } = {}
) {
	const program = artifact(wasm(text));
	const expected = serial(program, seed);
	const reports: Record<string, Awaited<ReturnType<ManagedFolio['run']>>> = {};
	for (const mode of ['callout', 'inline'] as const) {
		const pool = new ManagedFolio(program, {
			lanes: lanes(program, mode, 4, options.logEntries),
			...(options.ranges === false ? {} : { ranges: {} })
		});
		try {
			seed(new Uint8Array(pool.memory.buffer));
			const report = await pool.run('main');
			assert.deepEqual(report.values, [expected.value], mode);
			assert.equal(
				Buffer.compare(new Uint8Array(pool.memory.buffer), expected.memory),
				0,
				mode
			);
			assert.equal(report.transportFallbacks, 0, mode);
			reports[mode] = report;
		} finally {
			await pool.close();
		}
	}
	return reports as { callout: any; inline: any };
}

const put8 = '(func $put8 (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))';
const sum = `(func $sum (param $p i32) (param $n i32) (param $out i32)
	(local $i i32) (local $s i32)
	(block $done (loop $each
		(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
		(local.set $s (i32.add (local.get $s) (i32.load8_u (i32.add (local.get $p) (local.get $i)))))
		(local.set $i (i32.add (local.get $i) (i32.const 1)))
		(br $each)))
	(i32.store (local.get $out) (local.get $s)))`;
const noise = (bytes: Uint8Array) => {
	let state = 7;
	for (let i = 0; i < bytes.length; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		bytes[i] = (state >>> 16) | 1;
	}
};

test('disjoint regions on inline lanes give the serial result and the same regions as callout lanes', async () => {
	const calls = [0, 1, 2, 3, 4, 5, 6, 7]
		.map(
			(k) =>
				`(call $sum (i32.const ${65536 + k * 4096}) (i32.const 4000) (i32.const ${k * 64}))`
		)
		.join(' ');
	const text = `(module (memory (export "memory") 2 2 shared) ${sum}
		(func (export "main") (result i32) ${calls} (i32.load (i32.const 64))))`;
	for (const ranges of [true, false]) {
		const { callout, inline } = await agree(text, noise, { ranges });
		assert.equal(inline.regions, callout.regions);
		assert.equal(inline.replayed, 0);
		assert.equal(inline.fallbacks, 0);
	}
});

test('a true conflict is detected on inline lanes and replayed to the serial result', async () => {
	const text = `(module (memory (export "memory") 1 1 shared)
		(func $bump (param i32) (i32.store (local.get 0) (i32.add (i32.load (local.get 0)) (i32.const 1))))
		(func (export "main") (result i32)
			(call $bump (i32.const 0)) (call $bump (i32.const 0)) (call $bump (i32.const 0))
			(call $bump (i32.const 128))
			(i32.load (i32.const 0))))`;
	const { inline } = await agree(text, (bytes) => bytes.fill(3));
	assert.ok(inline.replayed >= 2, JSON.stringify(inline));
});

test('two lanes writing different bytes of one write granule merge exactly, with neighbors untouched', async () => {
	// bytes 0 and 1 share a 32-byte write granule and a 64-byte read granule; the rest is nonzero
	const text = `(module (memory (export "memory") 1 1 shared) ${put8}
		(func (export "main") (result i32)
			(call $put8 (i32.const 0) (i32.const 0))
			(call $put8 (i32.const 1) (i32.const 0))
			(call $put8 (i32.const 31) (i32.const 9))
			(call $put8 (i32.const 32) (i32.const 0))
			(i32.load (i32.const 0))))`;
	for (const ranges of [true, false]) await agree(text, noise, { ranges });
});

test('a write of zero into unshipped nonzero bytes is not lost to the lane zero fill', async () => {
	const text = `(module (memory (export "memory") 2 2 shared) ${put8}
		(func (export "main") (result i32)
			(call $put8 (i32.const 70000) (i32.const 0))
			(call $put8 (i32.const 80000) (i32.const 0))
			(i32.load8_u (i32.const 70000))))`;
	const { inline } = await agree(text, noise);
	assert.equal(inline.rangeFallbacks.snapshot + inline.rangeFallbacks.serial, 0);
});

test('a log-exhausting region falls back to the owner and the result stays serial', async () => {
	// 16 stores a granule apart log 16 entries; a log of 4 exhausts
	const stores = Array.from(
		{ length: 16 },
		(_, k) => `(i32.store8 (i32.add (local.get 0) (i32.const ${k * 32})) (i32.const ${k + 1}))`
	).join(' ');
	const text = `(module (memory (export "memory") 1 1 shared)
		(func $spread (param i32) ${stores})
		(func (export "main") (result i32)
			(call $spread (i32.const 0)) (call $spread (i32.const 4096)) (call $spread (i32.const 8192))
			(i32.add (i32.load8_u (i32.const 31)) (i32.load8_u (i32.const 4127)))))`;
	const { inline } = await agree(text, noise, { logEntries: 4 });
	assert.ok(inline.fallbacks >= 1, JSON.stringify(inline));
	await agree(text, noise, { logEntries: 64 });
});

// direct lane results, callout against inline, on the exports of one module
function pair(text: string, logEntries?: number) {
	const bytes = wasm(text);
	const callout = prepare(bytes).transactional;
	assert.ok(callout);
	const make = (inline: boolean) =>
		new FolioLane(compile(inline ? inlineLane(bytes) : callout), {
			initial: 2,
			maximum: 2,
			...(inline ? { inline: { module: compile(inlineLane(bytes)), logEntries } } : {})
		});
	return { callout: make(false), inline: make(true) };
}
const claim = { session: 'lane', epoch: 1, sequence: 1 };
function run(
	lane: FolioLane,
	memory: Uint8Array,
	shipped: RangeSet | undefined,
	calls: { export: string; args: number[] }[],
	fuel = 1000000
) {
	const header = { ...claim, calls, fuel, maxBytes: 262144 };
	const frame = shipped
		? encodeRangesFrame(header, memory, shipped).frame
		: encodeFrame(header, memory);
	return decodeResults(lane.execute(frame), claim, {
		maximumFrameBytes: 1 << 26,
		memoryBytes: memory.length,
		maxBytes: 262144,
		calls: calls.length
	});
}
const applied = (memory: Uint8Array, result: TransactionResult) => {
	const copy = memory.slice();
	for (const [address, value] of result.writes) copy[address] = value;
	return copy;
};
const cover = (reads: number[], granule: number) =>
	RangeSet.of(reads.map((a) => [Math.floor(a / granule) * granule, granule] as [number, number]));

const probe = `(module (import "env" "memory" (memory 2 2 shared))
	(func (export "peek") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func (export "poke") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
	(func (export "copy") (param i32 i32 i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)))
	(func (export "fill") (param i32 i32 i32) (memory.fill (local.get 0) (local.get 1) (local.get 2)))
	(func (export "wide") (param i32) (result i64) (i64.load (local.get 0)))
	(func (export "divide") (param i32) (result i32)
		(i32.div_u (i32.const 9) (i32.load8_u (local.get 0))))
	(func (export "spin") (loop $again (br $again)))
	(func (export "outside") (param i32) (result i32) (i32.load (local.get 0))))`;

test('lane results: reads are the callout reads at 64-byte granules and the writes apply to the same memory', () => {
	const { callout, inline } = pair(probe);
	const memory = new Uint8Array(131072);
	noise(memory);
	const calls = [
		{ export: 'peek', args: [100] },
		{ export: 'poke', args: [200, 0] },
		{ export: 'poke', args: [201, memory[201]!] },
		{ export: 'copy', args: [4096, 70, 150] },
		{ export: 'fill', args: [9000, 5, 100] },
		{ export: 'wide', args: [63] },
		{ export: 'poke', args: [300, 5] },
		{ export: 'peek', args: [300] }
	];
	for (const shipped of [undefined, RangeSet.of([[0, 65536]])]) {
		const a = run(callout, memory, shipped, calls);
		const b = run(inline, memory, shipped, calls);
		a.forEach((left, index) => {
			const right = b[index]!;
			const label = `${calls[index]!.export} ${shipped ? 'ranges' : 'snapshot'}`;
			assert.equal(right.value, left.value, label);
			assert.equal(right.trap, left.trap, label);
			assert.equal(Boolean(right.exhausted), Boolean(left.exhausted), label);
			assert.deepEqual(applied(memory, right), applied(memory, left), label);
			const wanted = cover(left.reads, 64);
			const got = RangeSet.fromAddresses(right.reads);
			assert.equal(wanted.subtract(got).length, 0, `${label}: every callout read is covered`);
			// extra bytes are own-written granules read back, only in the poke and peek pair
			if (!['peek', 'poke', 'copy', 'fill', 'wide'].includes(calls[index]!.export)) return;
			assert.ok(got.subtract(wanted).length <= (left.writes.length ? 64 : 0), label);
		});
	}
});

test('lane results: a call sees the shipped bytes, never an earlier call of the same frame', () => {
	const { inline } = pair(probe);
	const memory = new Uint8Array(131072).fill(7);
	const results = run(inline, memory, undefined, [
		{ export: 'poke', args: [10, 99] },
		{ export: 'peek', args: [10] },
		{ export: 'fill', args: [0, 1, 4000] },
		{ export: 'peek', args: [10] }
	]);
	assert.deepEqual(
		results.map((r) => r.value),
		[undefined, 7, undefined, 7]
	);
	const again = run(inline, memory, undefined, [{ export: 'peek', args: [4000] }]);
	assert.equal(again[0]!.value, 7);
});

test('lane results: traps, the arena guard, fuel and log exhaustion match the callout lane', () => {
	const { callout, inline } = pair(probe, 2);
	const memory = new Uint8Array(131072).fill(1);
	memory[40] = 0;
	const calls = [
		{ export: 'divide', args: [40] },
		{ export: 'outside', args: [131072 - 2] },
		{ export: 'outside', args: [131072] },
		{ export: 'outside', args: [131072 + 64] },
		{ export: 'outside', args: [1 << 24] },
		{ export: 'spin', args: [] },
		{ export: 'fill', args: [0, 3, 200] },
		{ export: 'peek', args: [5] }
	];
	const a = run(callout, memory, undefined, calls, 5000);
	const b = run(inline, memory, undefined, calls, 5000);
	a.forEach((left, index) => {
		const right = b[index]!;
		const label = `${calls[index]!.export} ${calls[index]!.args}`;
		assert.equal(right.trap, left.trap, label);
		assert.equal(right.errorKind, left.errorKind, label);
		// the callout lane has no log, so only the inline lane exhausts on the fill
		if (calls[index]!.export !== 'fill')
			assert.equal(Boolean(right.exhausted), Boolean(left.exhausted), label);
	});
	assert.equal(b[5]!.exhausted, true);
	assert.equal(b[6]!.exhausted, true, 'a 200 byte fill needs 7 granules and the log holds 2');
	assert.equal(b[7]!.value, 1, 'the lane is clean after the exhausted calls');
	assert.match(b[0]!.trap!, /divide|zero/);
	assert.equal(b[2]!.trap, 'memory access out of bounds');
});

test('lane results: a ranged frame reports a written granule that was not shipped as an escape', () => {
	const { inline } = pair(probe);
	const memory = new Uint8Array(131072).fill(9);
	const shipped = RangeSet.of([[0, 4096]]);
	const [result] = run(inline, memory, shipped, [{ export: 'poke', args: [8200, 0] }]);
	const lost = RangeSet.fromAddresses(result!.reads).subtract(shipped);
	assert.ok(lost.contains(8192, 32), 'the whole write granule is asked for');
	assert.deepEqual(result!.escapes?.[0], [8192, 32]);
});

test('the globals the lane sets are the ones the lowering exports', () => {
	const names = Object.values(inlineGlobals);
	for (const name of [
		'__folio_rb',
		'__folio_wb',
		'__folio_lp',
		'__folio_ll',
		'__folio_sa',
		'__folio_al',
		'__folio_ae',
		'__folio_xv'
	])
		assert.ok(names.includes(name as never), name);
});

test('a shipped boundary inside a read granule is reported as an escape of the unshipped half', () => {
	const { inline } = pair(probe);
	const memory = new Uint8Array(131072).fill(5);
	const shipped = RangeSet.of([[0, 4128]]);
	const [result] = run(inline, memory, shipped, [{ export: 'peek', args: [4100] }]);
	assert.equal(result!.value, 5);
	assert.deepEqual(result!.escapes, [[4128, 32]]);
});
