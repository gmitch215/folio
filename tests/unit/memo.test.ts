import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { kernelSource } from '../../experiments/ranges/kernel.ts';
import { BASE, MAX_PAGES, seedPartitions } from '../../experiments/ranges/layout.ts';
import { prepare } from '../../src/compiler.ts';
import { Coordinator } from '../../src/coordinator.ts';
import type { ManagedArtifact, ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { RegionMemo } from '../../src/memo.ts';
import { memoryImports } from '../../src/memory.ts';
import type { TransactionResult } from '../../src/transaction.ts';

const key = RegionMemo.keyOf('module', 'region', [1, 2])!;

function artifact(bytes: Uint8Array): ManagedArtifact {
	const program = prepare(bytes, { minimumRegionWork: 0 });
	const plan = program.control;
	if (!plan)
		return {
			original: new WebAssembly.Module(Uint8Array.from(bytes)),
			memories: memoryImports(bytes)
		};
	const { coordinator, transactional, workerOriginal: _, ...control } = plan;
	return {
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		coordinator: new WebAssembly.Module(Uint8Array.from(coordinator)),
		transactional: new WebAssembly.Module(Uint8Array.from(transactional)),
		control,
		memories: memoryImports(bytes)
	};
}

function lanes(program: ManagedArtifact, count = 4): ManagedLaneTransport[] {
	return Array.from({ length: count }, () => {
		const executor = new FolioLane(program.transactional!, {
			initial: program.control!.initial,
			maximum: program.control!.maximum
		});
		return {
			execute: async (frame) => executor.execute(frame),
			close: async () => executor.close()
		};
	});
}

function wasm(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	module.setFeatures(binaryen.Features.All);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

const put = '(func $put (param i32 i32) (i32.store (local.get 0) (local.get 1)))';

test('keys keep exact integers apart and refuse arguments that do not round trip', () => {
	assert.equal(RegionMemo.keyOf('m', 'f', [-0]), undefined);
	assert.equal(RegionMemo.keyOf('m', 'f', [1.5]), undefined);
	assert.equal(RegionMemo.keyOf('m', 'f', [NaN]), undefined);
	assert.equal(RegionMemo.keyOf('m', 'f', [Infinity]), undefined);
	assert.notEqual(RegionMemo.keyOf('m', 'f', [1]), RegionMemo.keyOf('m', 'f', [1n]));
	assert.notEqual(RegionMemo.keyOf('m', 'f', [1]), RegionMemo.keyOf('m', 'g', [1]));
});

test('two modules sharing one memo do not hit each other for the same export and arguments', async () => {
	const memo = new RegionMemo();
	const memory = new Uint8Array(16);
	const first = RegionMemo.keyOf('module-a', 'f', [1])!;
	const second = RegionMemo.keyOf('module-b', 'f', [1])!;
	assert.notEqual(first, second);
	await memo.record(first, memory, { value: 'a', reads: [3], writes: [[10, 1]] });
	assert.equal(await memo.lookup(second, memory), undefined);
	assert.equal((await memo.lookup(first, memory))?.result.value, 'a');
	await memo.record(second, memory, { value: 'b', reads: [3], writes: [[10, 2]] });
	const hit = await memo.lookup(second, memory);
	assert.equal(hit?.result.value, 'b');
	assert.deepEqual(hit?.result.writes, [[10, 2]]);
});

test('a recorded result is reused while its read bytes hold and misses when one changes', async () => {
	const memo = new RegionMemo();
	const memory = new Uint8Array(64);
	memory[3] = 7;
	assert.ok(await memo.record(key, memory, { value: 9, reads: [3, 4], writes: [[10, 1]] }, 2));
	assert.deepEqual(await memo.lookup(key, memory), {
		result: { value: 9, reads: [3, 4], writes: [[10, 1]] },
		ms: 2
	});
	memory[50] = 1;
	assert.ok(await memo.lookup(key, memory), 'a byte outside the read set still hits');
	memory[4] = 1;
	assert.equal(await memo.lookup(key, memory), undefined);
	assert.deepEqual(
		[memo.stats.lookups, memo.stats.hits, memo.stats.misses, memo.stats.savedMs],
		[3, 2, 1, 4]
	);
});

test('a memory of another size never hits', async () => {
	const memo = new RegionMemo();
	await memo.record(key, new Uint8Array(64), { reads: [3], writes: [] });
	assert.equal(await memo.lookup(key, new Uint8Array(128)), undefined);
});

test('two recurring input states of one key both hit', async () => {
	const memo = new RegionMemo();
	const first = new Uint8Array(16),
		second = new Uint8Array(16);
	second[3] = 1;
	await memo.record(key, first, { value: 'first', reads: [3], writes: [] });
	await memo.record(key, second, { value: 'second', reads: [3], writes: [] });
	assert.equal((await memo.lookup(key, first))?.result.value, 'first');
	assert.equal((await memo.lookup(key, second))?.result.value, 'second');
});

test('entries per key evict the oldest first', async () => {
	const memo = new RegionMemo({ entries: 1 });
	const first = new Uint8Array(16),
		second = new Uint8Array(16);
	second[3] = 1;
	await memo.record(key, first, { reads: [3], writes: [] });
	await memo.record(key, second, { reads: [3], writes: [] });
	assert.equal(await memo.lookup(key, first), undefined);
	assert.ok(await memo.lookup(key, second));
	assert.equal(memo.stats.evictions, 1);
});

test('the byte budget evicts the least recently used entry', async () => {
	const probe = new RegionMemo();
	await probe.record(key, new Uint8Array(16), { reads: [3], writes: [] });
	const cost = probe.stats.storedBytes;
	const memo = new RegionMemo({ bytes: cost * 2 });
	const states = [0, 1, 2].map((value) => {
		const memory = new Uint8Array(16);
		memory[3] = value;
		return memory;
	});
	await memo.record(key, states[0]!, { value: 0, reads: [3], writes: [] });
	await memo.record(key, states[1]!, { value: 1, reads: [3], writes: [] });
	assert.ok(await memo.lookup(key, states[0]!));
	await memo.record(key, states[2]!, { value: 2, reads: [3], writes: [] });
	assert.equal(await memo.lookup(key, states[1]!), undefined);
	assert.ok(await memo.lookup(key, states[0]!));
	assert.ok(await memo.lookup(key, states[2]!));
	assert.equal(memo.stats.evictions, 1);
	assert.equal(memo.stats.storedBytes, cost * 2);
});

test('traps, exhaustion, inconclusive results and escapes are never recorded', async () => {
	const memo = new RegionMemo();
	const memory = new Uint8Array(16);
	const refused: TransactionResult[] = [
		{ reads: [3], writes: [], trap: 'unreachable', errorKind: 'RuntimeError' },
		{ reads: [3], writes: [], exhausted: true },
		{ reads: [3], writes: [], inconclusive: true },
		{ reads: [3], writes: [], escapes: [[8, 1]] }
	];
	for (const result of refused) assert.equal(await memo.record(key, memory, result), false);
	assert.equal(memo.stats.recorded, 0);
	assert.equal(await memo.lookup(key, memory), undefined);
});

test('a recorded result cannot be changed through the caller or through a hit', async () => {
	const memo = new RegionMemo();
	const memory = new Uint8Array(16);
	const write: [number, number] = [10, 1];
	const source: TransactionResult = { value: 1, reads: [3], writes: [write] };
	await memo.record(key, memory, source);
	write[1] = 200;
	source.reads.push(4);
	source.writes.push([11, 2]);
	const first = await memo.lookup(key, memory);
	assert.deepEqual(first?.result, { value: 1, reads: [3], writes: [[10, 1]] });
	first!.result.writes.push([0, 0]);
	assert.deepEqual((await memo.lookup(key, memory))?.result.writes, [[10, 1]]);
});

test('record refuses malformed sets, and a result identical to a held one is not held twice', async () => {
	const memo = new RegionMemo();
	const memory = new Uint8Array(16);
	const malformed: TransactionResult[] = [
		{ reads: [3], writes: [[10, 256]] },
		{ reads: [3], writes: [[16, 1]] },
		{ reads: [16], writes: [] },
		{ reads: [3], writes: [[1, 1.5]] }
	];
	for (const bad of malformed) await assert.rejects(memo.record(key, memory, bad), RangeError);
	assert.equal(memo.stats.recorded, 0);
	assert.equal(await memo.record(key, memory, { reads: [3], writes: [] }), true);
	assert.equal(await memo.record(key, memory, { reads: [3], writes: [] }), false);
	assert.equal(memo.stats.recorded, 1);
});

test('probe counts repeats of (key, read bytes) and records nothing', async () => {
	const memory = new Uint8Array(32);
	memory[3] = 1;
	const outside = new Uint8Array(32);
	outside[3] = 1;
	outside[30] = 9;
	const changed = new Uint8Array(32);
	changed[3] = 2;
	const report = await RegionMemo.probe([
		{ key: 'k', memory, reads: [3] },
		{ key: 'k', memory: outside, reads: [3] },
		{ key: 'k', memory: changed, reads: [3] },
		{ key: 'k', memory, reads: [3, 4] }
	]);
	assert.deepEqual(report, { observations: 4, distinct: 3, repeats: 1, repeatRate: 0.25 });
});

test('clear drops every entry and resets the counters; invalid limits are refused', async () => {
	const memo = new RegionMemo();
	await memo.record(key, new Uint8Array(16), { reads: [3], writes: [] });
	memo.clear();
	assert.deepEqual(memo.stats, {
		lookups: 0,
		hits: 0,
		misses: 0,
		hashedBytes: 0,
		recordedBytes: 0,
		storedBytes: 0,
		recorded: 0,
		evictions: 0,
		savedMs: 0
	});
	assert.equal(await memo.lookup(key, new Uint8Array(16)), undefined);
	assert.throws(() => new RegionMemo({ entries: 0 }), RangeError);
	assert.throws(() => new RegionMemo({ bytes: 0 }), RangeError);
});

// the kernel rewrites four partitions per wave; each call reads and writes its own partition
const kernelArgs = [BASE, 2, 8];

function seed(target: WebAssembly.Memory, patch?: (bytes: Uint8Array) => void) {
	const bytes = new Uint8Array(target.buffer);
	bytes.fill(0);
	seedPartitions(bytes);
	patch?.(bytes);
}

function kernel(options: { ranges?: object; fuel?: number; runs?: boolean } = {}) {
	const program = artifact(kernelSource());
	const memory = new WebAssembly.Memory({ initial: 2, maximum: MAX_PAGES, shared: true });
	const reference = new WebAssembly.Memory({ initial: 2, maximum: MAX_PAGES, shared: true });
	const native = new WebAssembly.Instance(program.original, { env: { memory: reference } });
	const pool = new ManagedFolio(program, {
		lanes: lanes(program),
		memory,
		memo: {},
		...options
	});
	async function pass(patch?: (bytes: Uint8Array) => void) {
		seed(reference, patch);
		const expected = (native.exports.main as CallableFunction)(...kernelArgs);
		seed(memory, patch);
		const report = await pool.run('main', kernelArgs);
		assert.deepEqual(report.values, [expected]);
		assert.deepEqual(new Uint8Array(memory.buffer), new Uint8Array(reference.buffer));
		return report;
	}
	return { pool, pass };
}

test('the kernel answers a repeated call from the memo, a change inside the read set misses, and a change outside it hits', async () => {
	const { pool, pass } = kernel();
	try {
		const first = await pass();
		assert.equal(first.memoHits, 0);
		assert.ok(first.memoRecords! > 0);
		const second = await pass();
		assert.equal(second.memoHits, second.regions);
		assert.ok(second.memoSavedMs! >= 0);
		assert.ok(second.memoHashedBytes! > 0);
		const inside = await pass((bytes) => {
			bytes[BASE + 5]! ^= 1;
		});
		assert.ok(inside.memoHits! < inside.regions!);
		const outside = await pass((bytes) => {
			bytes[0]! ^= 0xff;
		});
		assert.equal(outside.memoHits, outside.regions);
	} finally {
		await pool.close();
	}
});

test('the memo composes with ranges and stays exact', async () => {
	const { pool, pass } = kernel({ ranges: {} });
	try {
		await pass();
		const repeated = await pass();
		assert.equal(repeated.memoHits, repeated.regions);
		assert.equal(repeated.escapeRounds, 0);
	} finally {
		await pool.close();
	}
});

test('a run that exhausts its fuel records nothing and still equals the native run', async () => {
	const { pool, pass } = kernel({ fuel: 20 });
	try {
		const report = await pass();
		assert.equal(report.memoRecords, 0);
		assert.equal(report.memoHits, 0);
	} finally {
		await pool.close();
	}
});

test('without the memo option a report carries no memo counters', async () => {
	const program = artifact(kernelSource());
	const memory = new WebAssembly.Memory({ initial: 2, maximum: MAX_PAGES, shared: true });
	const pool = new ManagedFolio(program, { lanes: lanes(program), memory });
	try {
		seed(memory);
		const report = await pool.run('main', kernelArgs);
		assert.equal(report.memoHits, undefined);
		assert.equal(report.memoRecords, undefined);
	} finally {
		await pool.close();
	}
});

test('a run-encoded result records as addresses, and a runs lookup returns its writes as runs', async () => {
	const memo = new RegionMemo();
	const memory = new Uint8Array(64);
	memory[3] = 7;
	const runKey = RegionMemo.keyOf('module', 'runs', [1])!;
	assert.ok(
		await memo.record(key, memory, {
			value: 9,
			reads: [3, 4, 5],
			writes: [
				[10, 1],
				[11, 2],
				[20, 9]
			]
		})
	);
	assert.ok(
		await memo.record(runKey, memory, {
			value: 9,
			reads: [],
			writes: [],
			readRuns: Uint32Array.of(3, 3),
			writeRuns: Uint32Array.of(10, 2, 20, 1),
			writeData: Uint8Array.of(1, 2, 9)
		})
	);
	const tuples = await memo.lookup(key, memory);
	const runs = await memo.lookup(runKey, memory, { runs: true });
	assert.deepEqual(runs?.result.reads, [3, 4, 5]);
	assert.deepEqual(runs?.result.writes, []);
	assert.deepEqual(runs?.result.writeRuns, Uint32Array.of(10, 2, 20, 1));
	assert.deepEqual(runs?.result.writeData, Uint8Array.of(1, 2, 9));
	assert.deepEqual(tuples?.result.writes, [
		[10, 1],
		[11, 2],
		[20, 9]
	]);
	assert.deepEqual(await memo.lookup(runKey, memory), {
		result: {
			value: 9,
			reads: [3, 4, 5],
			writes: [
				[10, 1],
				[11, 2],
				[20, 9]
			]
		},
		ms: 0
	});
	memory[4] = 1;
	assert.equal(await memo.lookup(runKey, memory, { runs: true }), undefined);
});

test('the memo composes with runs: a hit commits its write set as runs and stays exact', async () => {
	const { pool, pass } = kernel({ runs: true });
	try {
		await pass();
		const repeated = await pass();
		assert.equal(repeated.memoHits, repeated.regions);
		const inside = await pass((bytes) => {
			bytes[BASE + 5]! ^= 1;
		});
		assert.ok(inside.memoHits! < inside.regions!);
		const outside = await pass((bytes) => {
			bytes[0]! ^= 0xff;
		});
		assert.equal(outside.memoHits, outside.regions);
	} finally {
		await pool.close();
	}
});

test('a hit committed as runs conflicts and commits like the same hit committed as tuples', async () => {
	const outcome = async (runs: boolean, reads: number[]) => {
		const memory = new WebAssembly.Memory({ initial: 1 });
		const first: TransactionResult = runs
			? {
					reads: [0],
					writes: [],
					writeRuns: Uint32Array.of(100, 4),
					writeData: Uint8Array.of(5, 5, 5, 5)
				}
			: {
					reads: [0],
					writes: [
						[100, 5],
						[101, 5],
						[102, 5],
						[103, 5]
					]
				};
		const second: TransactionResult = { reads, writes: [[200, 9]] };
		const coordinator = new Coordinator({
			memory,
			workerMemory: memory,
			width: 1,
			profile: false,
			dispatch: async (_worker, _calls, generation) =>
				generation === 1 ? [first, second] : [{ reads: [], writes: [[200, 9]] }],
			native: () => {
				throw new Error('native fallback is not expected');
			}
		});
		coordinator.enqueue({ export: 'first', args: [] });
		coordinator.enqueue({ export: 'second', args: [] });
		await coordinator.flush();
		const bytes = new Uint8Array(memory.buffer);
		return {
			replayed: coordinator.report.replayed,
			bytes: [...bytes.subarray(100, 104), bytes[200]]
		};
	};
	for (const [reads, replayed] of [
		[[104], 0],
		[[101], 1]
	] as const) {
		const tuples = await outcome(false, [...reads]);
		assert.deepEqual(await outcome(true, [...reads]), tuples);
		assert.equal(tuples.replayed, replayed);
	}
});

test('a stale recorded read is not reused after an earlier write in the same run changes its byte', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 2 shared) ${put}
		(func $copy (param i32 i32) (i32.store (local.get 1) (i32.load (local.get 0))))
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 3))
			(call $copy (i32.const 0) (i32.const 8))
			(call $copy (i32.const 8) (i32.const 12))
			(i32.load (i32.const 12))))`)
	);
	const pool = new ManagedFolio(program, { lanes: lanes(program), memo: {} });
	const native = new WebAssembly.Instance(program.original);
	const reference = native.exports.memory as WebAssembly.Memory;
	try {
		for (const initial of [0, 5, 0]) {
			for (const arena of [pool.memory, reference])
				new Uint32Array(arena.buffer, 0, 4).fill(initial);
			const expected = (native.exports.main as CallableFunction)();
			new Uint32Array(pool.memory.buffer, 0, 4).fill(initial);
			const report = await pool.run('main');
			assert.deepEqual(report.values, [expected]);
			assert.equal(expected, 3);
			assert.deepEqual(new Uint8Array(pool.memory.buffer), new Uint8Array(reference.buffer));
		}
	} finally {
		await pool.close();
	}
});
