import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import {
	decodeFrame,
	decodeResults,
	encodeFrame,
	encodeResults,
	encodeSnapshot,
	restoreSnapshot,
	snapshotLength
} from '../../src/frames.ts';
import type { ManagedArtifact, ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { memoryImports } from '../../src/memory.ts';
import { encodeRangesFrame, RangeSet } from '../../src/ranges.ts';

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
function wasm(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	module.setFeatures(binaryen.Features.All);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
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
function basic(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}
const put = '(func $put (param i32 i32) (i32.store (local.get 0) (local.get 1)))';

test('sparse snapshots preserve all bytes, clear omitted pages and reject malformed page maps before writes', () => {
	const storage = new Uint8Array(5 * 65536 + 1),
		source = storage.subarray(1);
	source[0] = 17;
	source[source.length - 1] = 99;
	const encoded = encodeSnapshot(source);
	assert.deepEqual(encoded.snapshot, { memoryBytes: source.length, pages: [0, 4] });
	assert.equal(snapshotLength(encoded.snapshot, encoded.payload), source.length);
	const restored = new Uint8Array(source.length).fill(255);
	restoreSnapshot(restored, encoded.payload, encoded.snapshot);
	assert.deepEqual(restored, source);
	const zeros = encodeSnapshot(new Uint8Array(source.length));
	restoreSnapshot(restored, zeros.payload, zeros.snapshot);
	assert.ok(restored.every((byte) => byte === 0));
	for (const pages of [
		[4, 0],
		[0, 0],
		[-1, 4],
		[0, 5],
		[0, 1.5]
	]) {
		assert.throws(() =>
			restoreSnapshot(restored, encoded.payload, { memoryBytes: source.length, pages })
		);
		assert.ok(restored.every((byte) => byte === 0));
	}
	const dense = new Uint8Array(65536).fill(1),
		full = encodeSnapshot(dense);
	assert.equal(full.snapshot, undefined);
	assert.equal(full.payload, dense);
	assert.throws(() => encodeSnapshot(Uint8Array.of(1)), /page size/);
	assert.throws(() =>
		restoreSnapshot(restored, encoded.payload, { memoryBytes: 1, pages: [0, 4] })
	);
});

test('managed sparse snapshots invalidate the cached generation and clear previously nonzero pages', async () => {
	const program = artifact(
		readFileSync(new URL('../../build/generalized.wasm', import.meta.url))
	);
	const memory = new WebAssembly.Memory({ initial: 128, maximum: 8192, shared: true });
	const pool = new ManagedFolio(program, {
		memory,
		lanes: lanes(program),
		snapshotEncoding: 'auto'
	});
	const reference = new WebAssembly.Memory({ initial: 128, maximum: 8192, shared: true });
	const native = new WebAssembly.Instance(program.original, { env: { memory: reference } });
	try {
		for (let iteration = 0; iteration < 2; iteration++) {
			for (const arena of [memory, reference]) {
				const bytes = new Uint8Array(arena.buffer);
				bytes.fill(0);
				if (!iteration) bytes[7 * 65536] = 19;
				new Uint32Array(arena.buffer, 1024, 64).fill(17);
			}
			const value = (native.exports.main as CallableFunction)(1024, 64, 100);
			const report = await pool.run('main', [1024, 64, 100]);
			assert.deepEqual(report.values, [value]);
			assert.equal(report.transportFallbacks, 0);
			assert.ok(report.transportBytes.sent < report.snapshotBytes! / 4);
			assert.deepEqual(new Uint8Array(memory.buffer), new Uint8Array(reference.buffer));
		}
	} finally {
		await pool.close();
	}
});

test('dense compatibility encoding retains parallel execution with legacy frame consumers', async () => {
	const program = artifact(
		readFileSync(new URL('../../build/generalized.wasm', import.meta.url))
	);
	const transports = lanes(program).map((lane) => ({
		execute: async (frame: Uint8Array) => {
			assert.equal(decodeFrame<any>(frame, 1048576).header.snapshot, undefined);
			return lane.execute(frame);
		},
		close: lane.close
	}));
	const pool = new ManagedFolio(program, { lanes: transports, snapshotEncoding: 'dense' });
	try {
		new Uint32Array(pool.memory.buffer, 1024, 64).fill(17);
		const report = await pool.run('main', [1024, 64, 100]);
		assert.equal(report.workers, 4);
		assert.equal(report.transportFallbacks, 0);
		assert.ok(report.transportBytes.sent > report.snapshotBytes!);
	} finally {
		await pool.close();
	}
});

test('a sparse frame cannot allocate a logical arena larger than the lane memory limit', () => {
	const program = artifact(
		readFileSync(new URL('../../build/generalized.wasm', import.meta.url))
	);
	const lane = new FolioLane(program.transactional!, { initial: 2, maximum: 8192 });
	const frame = encodeFrame({
		session: 'bounded',
		epoch: 1,
		sequence: 1,
		fuel: 1000,
		maxBytes: 256,
		calls: [{ export: 'unused', args: [] }],
		snapshot: { memoryBytes: 64 * 1048576, pages: [] }
	});
	assert.throws(() => lane.execute(frame), /lane snapshot/);
	lane.close();
});

test('binary frames preserve numeric bits and reject malformed or stale results', () => {
	const identity = { session: 'test', epoch: 1, sequence: 2 };
	const bytes = encodeFrame({ ...identity, args: [3n, -0, NaN, Infinity] }, Uint8Array.of(1, 2));
	const decoded = decodeFrame<any>(bytes, 65536);
	assert.deepEqual(decoded.payload, Uint8Array.of(1, 2));
	assert.deepEqual(decoded.header.args, [3n, -0, NaN, Infinity]);
	assert.throws(() => decodeFrame(bytes.subarray(0, bytes.length - 1), 65536));
	assert.throws(() => decodeFrame(bytes, bytes.length - 1), RangeError);
	const result = encodeResults(identity, [{ value: -0, reads: [0, 7], writes: [[3, 255]] }]);
	const options = { maximumFrameBytes: 65536, memoryBytes: 8, maxBytes: 8, calls: 1 };
	assert.deepEqual(decodeResults(result, identity, options), [
		{ value: -0, reads: [0, 7], writes: [[3, 255]] }
	]);
	assert.throws(() => decodeResults(result, { ...identity, epoch: 2 }, options), /stale/);
	assert.throws(
		() => decodeResults(result, identity, { ...options, memoryBytes: 3 }),
		RangeError
	);
	assert.throws(() => decodeResults(result, identity, { ...options, calls: 2 }), TypeError);
	assert.throws(
		() =>
			decodeResults(
				encodeResults(identity, [{ reads: [], writes: [[0, 256]] }]),
				identity,
				options
			),
		RangeError
	);
});

test('unannotated inlined C executes through copied binary lanes with native-exact memory', async () => {
	const bytes = readFileSync(new URL('../../build/generalized.wasm', import.meta.url));
	const program = artifact(bytes);
	const pool = new ManagedFolio(program, { lanes: lanes(program), snapshotEncoding: 'auto' });
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
	const native = new WebAssembly.Instance(program.original, { env: { memory } });
	try {
		new Uint32Array(pool.memory.buffer, 1024, 64).fill(17);
		new Uint32Array(memory.buffer, 1024, 64).fill(17);
		const expected = (native.exports.main as CallableFunction)(1024, 64, 100);
		const report = await pool.run('main', [1024, 64, 100]);
		assert.deepEqual(report.values, [expected]);
		assert.equal(report.backend, 'managed-coherent');
		assert.equal(report.memoryMode, 'copied');
		assert.equal(report.workers, 4);
		assert.equal(report.regions, 64);
		assert.equal(report.replayed, 0);
		assert.equal(report.fallbacks, 0);
		assert.equal(report.snapshotBytes, 4 * 131072);
		assert.ok(report.transportBytes.sent < report.snapshotBytes!);
		assert.deepEqual(new Uint8Array(pool.memory.buffer), new Uint8Array(memory.buffer));
	} finally {
		await pool.close();
	}
});

test('managed validation replays dependencies and owner effects observe committed state', async () => {
	const program = artifact(
		wasm(`(module (import "host" "observe" (func $observe (param i32)))
		(memory (export "memory") 1 2) ${put}
		(func $advance (param i32) (i32.store (local.get 0)
			(i32.add (i32.load (local.get 0)) (i32.const 1))))
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 3))
			(call $advance (i32.const 0)) (call $advance (i32.const 0))
			(call $observe (i32.load (i32.const 0))) (i32.load (i32.const 0))))`)
	);
	const observed: number[] = [];
	const pool = new ManagedFolio(program, {
		lanes: lanes(program),
		imports: {
			host: {
				observe: (value: number) => {
					observed.push(value);
				}
			}
		}
	});
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, [5]);
		assert.deepEqual(observed, [5]);
		assert.equal(report.replayed, 2);
	} finally {
		await pool.close();
	}
});

test('managed traps commit their prefix and discard later speculative writes', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 2 shared) ${put}
		(func $fail (i32.store (i32.const 4) (i32.const 23)) unreachable)
		(func (export "main")
			(call $put (i32.const 0) (i32.const 17)) (call $fail)
			(call $put (i32.const 8) (i32.const 29))))`)
	);
	const pool = new ManagedFolio(program, { lanes: lanes(program) });
	try {
		await assert.rejects(pool.run('main'), WebAssembly.RuntimeError);
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 3)], [17, 23, 0]);
	} finally {
		await pool.close();
	}
});

test('missing lanes, corrupt replies, and snapshot bounds retain native execution', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 2 3 shared) ${put}
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 7))
			(call $put (i32.const 4) (i32.const 11)) (i32.load (i32.const 4))))`)
	);
	for (const transport of ['missing', 'corrupt', 'budget']) {
		const pool = new ManagedFolio(program, {
			lanes: Array.from({ length: 2 }, () => ({
				execute: async () => {
					if (transport === 'missing') throw new Error('offline');
					return new Uint8Array();
				}
			})),
			...(transport === 'budget' ? { maximumSnapshotBytes: 65536 } : {})
		});
		try {
			const report = await pool.run('main');
			assert.deepEqual(report.values, [11]);
			assert.equal(report.fallbacks, 1);
			assert.ok(report.transportFallbacks >= 1);
			assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [7, 11]);
		} finally {
			await pool.close();
		}
	}
});

test('growth refreshes snapshots and lane budgets fall back without losing owner identity', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 3) ${put}
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 7)) (call $put (i32.const 4) (i32.const 11))
			(drop (memory.grow (i32.const 1)))
			(call $put (i32.const 65536) (i32.const 13))
			(call $put (i32.const 65540) (i32.const 17)) (i32.load (i32.const 65540))))`)
	);
	const pool = new ManagedFolio(program, { lanes: lanes(program, 2), maxTransactionBytes: 8 });
	try {
		const memory = pool.memory,
			old = memory.buffer;
		const report = await pool.run('main');
		assert.deepEqual(report.values, [17]);
		assert.equal(pool.memory, memory);
		assert.equal(old.byteLength, 0);
		assert.equal(report.snapshotBytes, 2 * (65536 + 131072));
		assert.equal(new Uint32Array(memory.buffer)[16384], 13);
	} finally {
		await pool.close();
	}
});

test('native fallback preserves opaque Promise identity and close joins pending effects', async () => {
	const source = wasm(
		'(module (import "host" "read" (func $read (result externref))) (export "main" (func $read)))'
	);
	const promise = Promise.resolve({ value: 7 });
	const pool = new ManagedFolio(artifact(source), {
		lanes: [{ execute: async () => new Uint8Array() }],
		imports: { host: { read: () => promise } }
	});
	assert.equal((await pool.run('main')).values[0], promise);
	await pool.close();
	await assert.rejects(pool.run('main'), /closed/);
	assert.equal(pool.close(), pool.close());
});

test('close requested during dispatch waits for execution before releasing every lane', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 2) ${put}
		(func (export "main")
			(call $put (i32.const 0) (i32.const 7))
			(call $put (i32.const 4) (i32.const 11))))`)
	);
	const executors = lanes(program, 2);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const dispatched = new Promise<void>((resolve) => {
		started = resolve;
	});
	let closing: Promise<void> | undefined;
	let closed = 0;
	const pool = new ManagedFolio(program, {
		lanes: executors.map((executor, index) => ({
			execute: async (frame) => {
				if (index === 0) {
					closing = pool.close();
					started();
				}
				await held;
				return executor.execute(frame);
			},
			close: async () => {
				closed++;
				await executor.close?.();
			}
		}))
	});
	const pending = pool.run('main');
	await dispatched;
	await Promise.resolve();
	assert.equal(closed, 0);
	assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [0, 0]);
	release();
	await pending;
	await closing;
	assert.equal(closed, 2);
	assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [7, 11]);
});

test('synchronous disposal failures do not prevent the remaining lanes from closing', async () => {
	let closed = 0;
	const failure = new Error('first lane close failed');
	const pool = new ManagedFolio(artifact(wasm('(module (func (export "main")))')), {
		lanes: [
			{
				execute: async () => new Uint8Array(),
				close: () => {
					throw failure;
				}
			},
			{
				execute: async () => new Uint8Array(),
				close: async () => {
					closed++;
				}
			}
		]
	});
	await assert.rejects(pool.close(), (error) => error === failure);
	assert.equal(closed, 1);
});

test('close from an async owner import joins the pending native continuation', async () => {
	const runtime = WebAssembly as typeof WebAssembly & {
		Suspending: new (fn: () => Promise<number>) => WebAssembly.ImportValue;
	};
	let release!: (value: number) => void;
	const held = new Promise<number>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const imported = new Promise<void>((resolve) => {
		started = resolve;
	});
	let closing: Promise<void> | undefined;
	let closed = 0;
	const pool = new ManagedFolio(
		artifact(
			wasm(`(module
		(import "host" "read" (func $read (result i32))) (export "main" (func $read)))`)
		),
		{
			imports: {
				host: {
					read: new runtime.Suspending(() => {
						closing = pool.close();
						started();
						return held;
					})
				}
			},
			promising: ['main'],
			lanes: [
				{
					execute: async () => new Uint8Array(),
					close: async () => {
						closed++;
					}
				}
			]
		}
	);
	const pending = pool.run('main');
	await imported;
	await Promise.resolve();
	assert.equal(closed, 0);
	release(17);
	assert.deepEqual((await pending).values, [17]);
	await closing;
	assert.equal(closed, 1);
});

test('completed but lost lane results replay without repeating owner effects', async () => {
	const program = artifact(
		wasm(`(module (import "host" "observe" (func $observe (param i32)))
		(memory (export "memory") 1 2) ${put}
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 7))
			(call $put (i32.const 4) (i32.const 11))
			(call $observe (i32.load (i32.const 4))) (i32.load (i32.const 0))))`)
	);
	const observed: number[] = [];
	let completed = 0;
	const executors = lanes(program, 2);
	const pool = new ManagedFolio(program, {
		imports: {
			host: {
				observe: (value: number) => {
					observed.push(value);
				}
			}
		},
		lanes: executors.map((executor) => ({
			execute: async (frame) => {
				await executor.execute(frame);
				completed++;
				throw new Error('response lost after execution');
			},
			close: executor.close
		}))
	});
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, [7]);
		assert.deepEqual(observed, [11]);
		assert.equal(completed, 2);
		assert.equal(report.transportFallbacks, 2);
		assert.equal(report.fallbacks, 1);
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [7, 11]);
	} finally {
		await pool.close();
	}
});

test('frame encoding enforces the wire bound before constructing a full frame', () => {
	const identity = { session: 'bounded', epoch: 1, sequence: 1 };
	assert.throws(() => encodeFrame(identity, new Uint8Array(65536), 65536), RangeError);
	assert.throws(
		() =>
			encodeResults(
				identity,
				[{ reads: [], writes: Array.from({ length: 8193 }, () => [0, 1]) }],
				65536
			),
		RangeError
	);
});

test('lane stack exhaustion falls back without publishing its speculative prefix', () => {
	const module = new WebAssembly.Module(
		Uint8Array.from(
			wasm(`(module
		(import "env" "memory" (memory 1 2 shared))
		(import "folio" "store" (func $store (param i32 i32 i32 i32)))
		(func $recurse (call $recurse))
		(func (export "__folio_set_fuel") (param i32))
		(func (export "region")
			(call $store (i32.const 0) (i32.const 7) (i32.const 0) (i32.const 4)) (call $recurse)))`)
		)
	);
	const executor = new FolioLane(module, { initial: 1, maximum: 2 });
	const identity = { session: 'stack', epoch: 1, sequence: 1 };
	try {
		const response = executor.execute(
			encodeFrame(
				{ ...identity, calls: [{ export: 'region', args: [] }], fuel: 100, maxBytes: 8 },
				new Uint8Array(65536)
			)
		);
		const [result] = decodeResults(response, identity, {
			maximumFrameBytes: 1048576,
			memoryBytes: 65536,
			maxBytes: 8,
			calls: 1
		});
		assert.equal(result!.exhausted, true);
		assert.equal(result!.trap, undefined);
		assert.deepEqual(result!.writes, []);
	} finally {
		executor.close();
	}
});

test('lane retries instance allocation after a failed first construction', () => {
	const module = new WebAssembly.Module(
		Uint8Array.from(
			wasm(`(module
		(import "env" "memory" (memory 1 2 shared))
		(import "folio" "store" (func $store (param i32 i32 i32 i32)))
		(func (export "__folio_set_fuel") (param i32))
		(func (export "region")
			(call $store (i32.const 0) (i32.const 7) (i32.const 0) (i32.const 4))))`)
		)
	);
	const NativeInstance = WebAssembly.Instance;
	let attempts = 0;
	class RetryInstance extends NativeInstance {
		constructor(...args: ConstructorParameters<typeof NativeInstance>) {
			if (++attempts === 1) throw new RangeError('injected allocation failure');
			super(...args);
		}
	}
	WebAssembly.Instance = RetryInstance;
	const executor = new FolioLane(module, { initial: 1, maximum: 2 });
	const identity = { session: 'retry', epoch: 1, sequence: 1 };
	const frame = encodeFrame(
		{ ...identity, calls: [{ export: 'region', args: [] }], fuel: 100, maxBytes: 8 },
		new Uint8Array(65536)
	);
	try {
		assert.throws(() => executor.execute(frame), RangeError);
		const [result] = decodeResults(executor.execute(frame), identity, {
			maximumFrameBytes: 1048576,
			memoryBytes: 65536,
			maxBytes: 8,
			calls: 1
		});
		assert.equal(attempts, 2);
		assert.equal(result!.trap, undefined);
		assert.deepEqual(result!.writes, [
			[0, 7],
			[1, 0],
			[2, 0],
			[3, 0]
		]);
	} finally {
		WebAssembly.Instance = NativeInstance;
		executor.close();
	}
});

const framed = (memory: string, stores = 2) =>
	artifact(
		wasm(`(module (memory (export "memory") ${memory} shared) ${put}
		(func (export "main") (result i32)
			${Array.from({ length: stores }, (_, index) => `(call $put (i32.const ${index * 4}) (i32.const ${index === 1 ? 11 : index + 20}))`).join(' ')}
			(i32.load (i32.const 4))))`)
	);
async function sent(
	program: ManagedArtifact,
	options: { snapshotEncoding?: 'auto' | 'dense'; maximumFrameBytes?: number } = {}
) {
	const frames: number[] = [];
	const pool = new ManagedFolio(program, {
		lanes: lanes(program, 2).map((lane) => ({
			execute: async (frame: Uint8Array) => {
				frames.push(frame.length);
				return lane.execute(frame);
			},
			close: lane.close
		})),
		...options
	});
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, [11]);
		return { frames, fallbacks: report.transportFallbacks, diagnostics: [...pool.diagnostics] };
	} finally {
		await pool.close();
	}
}

test('a frame over the transport limit is not sent and the fallback names both sizes', async () => {
	const largestFrames: number[] = [];
	for (const stores of [2, 6]) {
		const program = framed('8 8', stores);
		const largest = Math.max(...(await sent(program)).frames);
		largestFrames.push(largest);
		const exact = await sent(program, { maximumFrameBytes: largest });
		assert.equal(exact.fallbacks, 0);
		const over = await sent(program, { maximumFrameBytes: largest - 1 });
		assert.ok(over.fallbacks >= 1);
		assert.ok(over.frames.every((length) => length < largest));
		assert.match(
			over.diagnostics.join('\n'),
			new RegExp(`frame of ${largest} bytes exceeds the limit of ${largest - 1} bytes`)
		);
	}
	assert.ok(largestFrames[0]! < largestFrames[1]!);
});

test('sparse frames fit under a limit that rejects the dense frame of the same arena', async () => {
	const program = framed('8 8');
	const dense = Math.max(...(await sent(program)).frames);
	const sparse = Math.max(...(await sent(program, { snapshotEncoding: 'auto' })).frames);
	assert.ok(sparse < dense / 4);
	const limit = { maximumFrameBytes: Math.max(sparse, 65536) };
	assert.equal((await sent(program, { ...limit, snapshotEncoding: 'auto' })).fallbacks, 0);
	assert.ok((await sent(program, limit)).fallbacks >= 1);
});

test('the default limits keep a dense frame under the 32 MiB RPC argument limit', async () => {
	const full = await sent(framed('512 512'));
	assert.deepEqual(full.frames, []);
	assert.match(
		full.diagnostics.join('\n'),
		/snapshot of 33554432 bytes exceeds the limit of 32505856 bytes/
	);
	const largest = await sent(framed('496 496'));
	assert.equal(largest.fallbacks, 0);
	assert.ok(Math.max(...largest.frames) < 32 * 1048576 - 4096);
});

// #region ranges
const kernel = `(func $run (param $offset i32) (param $words i32) (param $rounds i32)
	(local $i i32) (local $r i32) (local $x i32) (local $addr i32)
	(block $done (loop $each
		(br_if $done (i32.ge_u (local.get $i) (local.get $words)))
		(local.set $addr (i32.add (local.get $offset) (i32.shl (local.get $i) (i32.const 2))))
		(local.set $x (i32.load (local.get $addr)))
		(local.set $r (i32.const 0))
		(block $end (loop $round
			(br_if $end (i32.ge_u (local.get $r) (local.get $rounds)))
			(local.set $x (i32.xor
				(i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223))
				(i32.shr_u (local.get $x) (i32.const 15))))
			(local.set $r (i32.add (local.get $r) (i32.const 1)))
			(br $round)))
		(i32.store (local.get $addr) (local.get $x))
		(local.set $i (i32.add (local.get $i) (i32.const 1)))
		(br $each))))`;

// four partitions of `words` words from `base`, rewritten once per wave; each wave ends in an owner read
function partitioned(pages: number, words: number, rounds = 2) {
	const call = (index: number) =>
		`(call $run (i32.add (local.get $base) (i32.const ${index * words * 4})) (i32.const ${words}) (i32.const ${rounds}))`;
	return artifact(
		wasm(`(module (memory (export "memory") ${pages} ${pages} shared) ${kernel}
		(func (export "main") (param $base i32) (param $waves i32) (result i32)
			(local $wave i32) (local $sum i32)
			(loop $next
				${[0, 1, 2, 3].map(call).join(' ')}
				(local.set $sum (i32.add (local.get $sum) (i32.load (local.get $base))))
				(local.set $wave (i32.add (local.get $wave) (i32.const 1)))
				(br_if $next (i32.lt_u (local.get $wave) (local.get $waves))))
			(local.get $sum)))`)
	);
}
function seedPartitions(base: number, words: number) {
	return (bytes: Uint8Array) => {
		const view = new Uint32Array(bytes.buffer, base, words * 4);
		let state = 12345;
		for (let i = 0; i < view.length; i++) {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			view[i] = state;
		}
	};
}
// a serial native run of the same module: the oracle for value and memory
function serial(
	program: ManagedArtifact,
	seed: (bytes: Uint8Array) => void,
	runs: [string, number[]][]
) {
	const instance = new WebAssembly.Instance(program.original, {});
	const memory = instance.exports.memory as WebAssembly.Memory;
	seed(new Uint8Array(memory.buffer));
	const values = runs.map(([name, args]) =>
		(instance.exports[name] as CallableFunction)(...args)
	);
	return { values, memory: new Uint8Array(memory.buffer) };
}
function same(left: ArrayBufferLike, right: ArrayBufferLike) {
	assert.equal(Buffer.compare(new Uint8Array(left), new Uint8Array(right)), 0);
}
// a transport that copies the frame and the response, as a real wire does
function copying(lane: ManagedLaneTransport): ManagedLaneTransport {
	return {
		execute: async (frame) => new Uint8Array(await lane.execute(new Uint8Array(frame))),
		close: lane.close
	};
}
function counting(transports: ManagedLaneTransport[], frames: Uint8Array[]) {
	return transports.map((lane) => ({
		execute: async (frame: Uint8Array) => {
			frames.push(frame);
			return lane.execute(frame);
		},
		close: lane.close
	}));
}

test('ranges ship a small fraction of the snapshot bytes on an 8 MiB arena and match a serial run', async () => {
	const program = partitioned(128, 4096);
	const seed = seedPartitions(65536, 4096);
	const expected = serial(program, seed, [['main', [65536, 3]]]);
	const totals: Record<string, { sent: number; frames: number }> = {};
	for (const mode of ['snapshot', 'ranges'] as const) {
		const frames: Uint8Array[] = [];
		const pool = new ManagedFolio(program, {
			lanes: counting(lanes(program).map(copying), frames),
			...(mode === 'ranges' ? { ranges: {} } : {})
		});
		try {
			seed(new Uint8Array(pool.memory.buffer));
			const report = await pool.run('main', [65536, 3]);
			assert.deepEqual(report.values, expected.values);
			assert.equal(report.transportFallbacks, 0);
			same(pool.memory.buffer, expected.memory.buffer);
			totals[mode] = { sent: report.transportBytes.sent, frames: frames.length };
			if (mode === 'ranges') {
				assert.equal(report.rangeFallbacks!.snapshot + report.rangeFallbacks!.serial, 0);
				assert.ok(report.rangeBytes! > 0 && report.rangeBytes! < 8 * 1048576);
			}
		} finally {
			await pool.close();
		}
	}
	assert.ok(totals.ranges!.sent < totals.snapshot!.sent / 50, JSON.stringify(totals));
});

test('a footprint cache miss costs one escape round and the next call with the same key costs none', async () => {
	const program = partitioned(128, 4096);
	const seed = seedPartitions(65536, 4096);
	const expected = serial(program, seed, [
		['main', [65536, 1]],
		['main', [65536, 1]]
	]);
	const pool = new ManagedFolio(program, { lanes: lanes(program), ranges: {} });
	try {
		seed(new Uint8Array(pool.memory.buffer));
		const first = await pool.run('main', [65536, 1]);
		assert.deepEqual(first.values, [expected.values[0]]);
		assert.equal(first.footprintHits, 0);
		assert.equal(first.escapeRounds, 4);
		assert.deepEqual(first.rounds, { batches: 4, total: 8, max: 2 });
		const second = await pool.run('main', [65536, 1]);
		assert.deepEqual(second.values, [expected.values[1]]);
		assert.equal(second.footprintHits, 4);
		assert.equal(second.escapeRounds, 0);
		assert.deepEqual(second.rounds, { batches: 4, total: 4, max: 1 });
		assert.equal(second.rangeBytes, 4 * 16384);
		assert.deepEqual(second.rangeFallbacks, { snapshot: 0, serial: 0 });
		same(pool.memory.buffer, expected.memory.buffer);
	} finally {
		await pool.close();
	}
});

// each chain is a linked list with one node per 64 KiB page; main follows four of them
const chase = (hops: number) =>
	artifact(
		wasm(`(module (memory (export "memory") 32 32 shared)
		(func $chase (param $p i32) (param $hops i32) (param $out i32)
			(block $done (loop $each
				(br_if $done (i32.eqz (local.get $hops)))
				(local.set $p (i32.load (local.get $p)))
				(local.set $hops (i32.sub (local.get $hops) (i32.const 1)))
				(br $each)))
			(i32.store (local.get $out) (local.get $p)))
		(func (export "main") (result i32)
			${[0, 1, 2, 3].map((chain) => `(call $chase (i32.const ${(chain + 1) * 4 * 65536 + chain * 64}) (i32.const ${hops}) (i32.const ${(20 + chain) * 65536}))`).join(' ')}
			(i32.load (i32.const ${20 * 65536}))))`)
	);
function seedChains(bytes: Uint8Array) {
	const view = new Uint32Array(bytes.buffer);
	for (let chain = 0; chain < 4; chain++)
		for (let node = 0; node < 3; node++)
			view[((chain + 1) * 4 * 65536 + node * 65536 + chain * 64) / 4] =
				(chain + 1) * 4 * 65536 + (node + 1) * 65536 + chain * 64;
}

test('a pointer chase reads shipped zeros first and is exact after retries or after the snapshot fallback', async () => {
	const program = chase(2);
	// the chain has three links: two hops are exact after two escape rounds
	const expected = serial(program, seedChains, [['main', []]]);
	for (const [rounds, escapeRounds, snapshots] of [
		[3, 2, 0],
		[2, 2, 1]
	] as const) {
		const pool = new ManagedFolio(program, {
			lanes: lanes(program, 2),
			ranges: { maxRounds: rounds }
		});
		try {
			seedChains(new Uint8Array(pool.memory.buffer));
			const report = await pool.run('main');
			assert.deepEqual(report.values, expected.values);
			assert.equal(report.escapeRounds, escapeRounds * 2);
			assert.equal(report.rangeFallbacks!.snapshot, snapshots * 2);
			same(pool.memory.buffer, expected.memory.buffer);
		} finally {
			await pool.close();
		}
	}
});

test('a footprint that grows every round ends in a snapshot fallback within maxRounds', async () => {
	const program = chase(3);
	const expected = serial(program, seedChains, [['main', []]]);
	const frames: Uint8Array[] = [];
	const pool = new ManagedFolio(program, {
		lanes: counting(lanes(program, 2), frames),
		ranges: { maxRounds: 3 }
	});
	try {
		seedChains(new Uint8Array(pool.memory.buffer));
		const report = await pool.run('main');
		assert.deepEqual(report.values, expected.values);
		assert.equal(report.rounds!.max, 3);
		assert.equal(report.rounds!.total, 6);
		assert.equal(report.rangeFallbacks!.snapshot, 2);
		// three ranges frames and one snapshot frame per lane dispatch
		assert.equal(frames.length, 8);
		same(pool.memory.buffer, expected.memory.buffer);
		// the learned footprint is kept: the retry now needs fewer rounds
		const again = await pool.run('main');
		assert.equal(again.footprintHits, 4);
		assert.deepEqual(again.rounds, { batches: 2, total: 2, max: 1 });
		assert.deepEqual(again.rangeFallbacks, { snapshot: 0, serial: 0 });
	} finally {
		await pool.close();
	}
});

test('ranges that cannot fall back to a snapshot run natively at the owner and stay exact', async () => {
	const program = chase(3);
	const expected = serial(program, seedChains, [['main', []]]);
	const pool = new ManagedFolio(program, {
		lanes: lanes(program, 2),
		ranges: { maxRounds: 2 },
		maximumSnapshotBytes: 65536
	});
	try {
		seedChains(new Uint8Array(pool.memory.buffer));
		const report = await pool.run('main');
		assert.deepEqual(report.values, expected.values);
		assert.deepEqual(report.rangeFallbacks, { snapshot: 0, serial: 2 });
		assert.equal(report.transportFallbacks, 0);
		same(pool.memory.buffer, expected.memory.buffer);
	} finally {
		await pool.close();
	}
});

// the guard loops forever on zeros and the divide traps on zeros; real data does neither
const guarded = artifact(
	wasm(`(module (memory (export "memory") 2 2 shared)
	(func $spin (param $p i32) (param $out i32)
		(block $done (loop $again
			(br_if $done (i32.load (local.get $p)))
			(br $again)))
		(i32.store (local.get $out) (i32.load (local.get $p))))
	(func $divide (param $p i32) (param $out i32)
		(i32.store (local.get $out) (i32.div_u (i32.const 1000) (i32.load (local.get $p)))))
	(func (export "main") (result i32)
		(call $spin (i32.const 0) (i32.const 4096))
		(call $divide (i32.const 8) (i32.const 4100))
		(call $spin (i32.const 16) (i32.const 4104))
		(call $divide (i32.const 24) (i32.const 4108))
		(i32.add (i32.load (i32.const 4096)) (i32.load (i32.const 4100)))))`)
);

test('a trap or fuel exhaustion on shipped zeros is inconclusive and recovered by the next round', async () => {
	const seed = (bytes: Uint8Array) => {
		const view = new Uint32Array(bytes.buffer);
		view.set([7, 0, 5, 0, 9, 0, 4, 0]);
	};
	const expected = serial(guarded, seed, [['main', []]]);
	const pool = new ManagedFolio(guarded, {
		lanes: lanes(guarded, 2),
		fuel: 5000,
		ranges: {}
	});
	try {
		seed(new Uint8Array(pool.memory.buffer));
		const report = await pool.run('main');
		assert.deepEqual(report.values, expected.values);
		assert.ok(report.escapeRounds! >= 1);
		assert.equal(report.rangeFallbacks!.snapshot + report.rangeFallbacks!.serial, 0);
		assert.equal(report.fallbacks, 0);
		same(pool.memory.buffer, expected.memory.buffer);
	} finally {
		await pool.close();
	}
});

test('ordered validation replays dependent calls in ranges mode and equals a serial run', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 2) ${put}
		(func $advance (param i32) (i32.store (local.get 0)
			(i32.add (i32.load (local.get 0)) (i32.const 1))))
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 3))
			(call $advance (i32.const 0)) (call $advance (i32.const 0))
			(call $put (i32.const 64) (i32.const 9)) (call $advance (i32.const 64))
			(i32.add (i32.load (i32.const 0)) (i32.load (i32.const 64)))))`)
	);
	const expected = serial(program, () => {}, [['main', []]]);
	const pool = new ManagedFolio(program, { lanes: lanes(program), ranges: {} });
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, expected.values);
		assert.deepEqual(report.values, [15]);
		assert.ok(report.replayed >= 2);
		assert.equal(report.fallbacks, 0);
		same(pool.memory.buffer, expected.memory.buffer);
	} finally {
		await pool.close();
	}
});

test('a lane trap with every read shipped is final: the prefix commits and the run rejects', async () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 2 shared) ${put}
		(func $fail (i32.store (i32.const 4) (i32.const 23)) unreachable)
		(func (export "main")
			(call $put (i32.const 0) (i32.const 17)) (call $fail)
			(call $put (i32.const 8) (i32.const 29))))`)
	);
	const pool = new ManagedFolio(program, { lanes: lanes(program), ranges: {} });
	try {
		await assert.rejects(pool.run('main'), WebAssembly.RuntimeError);
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 3)], [17, 23, 0]);
	} finally {
		await pool.close();
	}
});

test('the owner recomputes escapes from the read set and ignores a lane that claims there are none', async () => {
	const program = chase(2);
	const expected = serial(program, seedChains, [['main', []]]);
	let stripped = 0;
	const forging = lanes(program, 2).map((lane) => ({
		execute: async (frame: Uint8Array) => {
			const response = await lane.execute(frame);
			const request = decodeFrame<any>(frame, 1048576).header;
			const claim = {
				session: request.session,
				epoch: request.epoch,
				sequence: request.sequence
			};
			const results = decodeResults(response, claim, {
				maximumFrameBytes: 1048576,
				memoryBytes:
					request.ranges?.memoryBytes ?? request.snapshot?.memoryBytes ?? 2097152,
				maxBytes: 262144,
				calls: request.calls.length
			});
			for (const result of results) {
				if (result.escapes) stripped++;
				delete result.escapes;
				delete result.inconclusive;
			}
			return encodeResults(claim, results);
		},
		close: lane.close
	}));
	const pool = new ManagedFolio(program, { lanes: forging, ranges: {} });
	try {
		seedChains(new Uint8Array(pool.memory.buffer));
		const report = await pool.run('main');
		assert.ok(stripped > 0);
		assert.deepEqual(report.values, expected.values);
		assert.ok(report.escapeRounds! > 0);
		same(pool.memory.buffer, expected.memory.buffer);
	} finally {
		await pool.close();
	}
});

// a hand-written tracked module: loads, stores and a divide that traps on a zero byte;
// the all-features emit packs two imports from one namespace into a form this V8 rejects
const tracked = new WebAssembly.Module(
	Uint8Array.from(
		basic(`(module
	(import "folio" "load" (func $load (param i32 i32 i32 i32) (result i32)))
	(import "folio" "store" (func $store (param i32 i32 i32 i32)))
	(import "env" "memory" (memory 2 2 shared))
	(func (export "__folio_set_fuel") (param i32))
	(func (export "peek") (param i32) (result i32)
		(call $load (local.get 0) (i32.const 0) (i32.const 1) (i32.const 0)))
	(func (export "poke") (param i32 i32)
		(call $store (local.get 0) (local.get 1) (i32.const 0) (i32.const 1)))
	(func (export "divide") (param i32) (result i32)
		(i32.div_u (i32.const 9) (call $load (local.get 0) (i32.const 0) (i32.const 1) (i32.const 0)))))`)
	)
);
const claim = { session: 'lane', epoch: 1, sequence: 1 };
const laneOptions = { initial: 2, maximum: 2 };
const decodeOptions = (calls: number) => ({
	maximumFrameBytes: 1048576,
	memoryBytes: 131072,
	maxBytes: 4096,
	calls
});
function rangesFrame(
	memory: Uint8Array,
	set: RangeSet,
	calls: { export: string; args: number[] }[]
) {
	return encodeRangesFrame({ ...claim, calls, fuel: 100, maxBytes: 4096 }, memory, set);
}

test('a lane reads zero outside the shipped ranges however many frames came before', () => {
	const lane = new FolioLane(tracked, laneOptions);
	const memory = new Uint8Array(131072);
	let state = 99,
		previous = RangeSet.empty;
	const next = (limit: number) => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return (state >>> 8) % limit;
	};
	try {
		for (let round = 0; round < 60; round++) {
			for (let i = 0; i < 64; i++) memory[next(131072)] = 1 + next(255);
			const set = RangeSet.of(
				Array.from(
					{ length: next(4) },
					() => [next(130000), 1 + next(900)] as [number, number]
				)
			);
			// half the probes land in what the previous frame shipped, where a stale byte would show
			const old = previous.spans();
			const probes = Array.from({ length: 8 }, (_, index) => {
				if (index % 2 || !old.length) return next(131072);
				const [start, length] = old[next(old.length)]!;
				return start + next(length);
			});
			if (round % 7 === 3) {
				// a snapshot frame dirties the whole memory; the next ranges frame must still see zeros
				const dense = encodeFrame(
					{ ...claim, calls: [{ export: 'peek', args: [0] }], fuel: 100, maxBytes: 4096 },
					memory
				);
				lane.execute(dense);
			}
			const { frame, shipped } = rangesFrame(
				memory,
				set,
				probes.map((address) => ({ export: 'peek', args: [address] }))
			);
			previous = shipped;
			const results = decodeResults(lane.execute(frame), claim, decodeOptions(8));
			results.forEach((result, index) => {
				const address = probes[index]!;
				assert.equal(result.value, shipped.contains(address) ? memory[address] : 0);
				assert.equal(result.escapes === undefined, shipped.contains(address));
			});
		}
	} finally {
		lane.close();
	}
});

test('tracked stores stay in the write set and never reach lane memory, so the next frame reads zero there', () => {
	const lane = new FolioLane(tracked, laneOptions);
	const memory = new Uint8Array(131072).fill(7);
	try {
		const [poke] = decodeResults(
			lane.execute(
				rangesFrame(memory, RangeSet.of([[0, 64]]), [{ export: 'poke', args: [100, 5] }])
					.frame
			),
			claim,
			decodeOptions(1)
		);
		assert.deepEqual(poke!.writes, [[100, 5]]);
		const [peek] = decodeResults(
			lane.execute(
				rangesFrame(memory, RangeSet.of([[200, 8]]), [{ export: 'peek', args: [100] }])
					.frame
			),
			claim,
			decodeOptions(1)
		);
		assert.equal(peek!.value, 0);
		assert.deepEqual(peek!.escapes, [[100, 1]]);
	} finally {
		lane.close();
	}
});

test('data segments written at instantiation do not leak into the first ranges frame', () => {
	const withData = new WebAssembly.Module(
		Uint8Array.from(
			basic(`(module
		(import "folio" "load" (func $load (param i32 i32 i32 i32) (result i32)))
		(import "env" "memory" (memory 2 2 shared))
		(data (i32.const 200) "\\09")
		(func (export "__folio_set_fuel") (param i32))
		(func (export "peek") (param i32) (result i32)
			(call $load (local.get 0) (i32.const 0) (i32.const 1) (i32.const 0))))`)
		)
	);
	const lane = new FolioLane(withData, laneOptions);
	try {
		const { frame } = rangesFrame(new Uint8Array(131072), RangeSet.empty, [
			{ export: 'peek', args: [200] }
		]);
		const [result] = decodeResults(lane.execute(frame), claim, decodeOptions(1));
		assert.equal(result!.value, 0);
	} finally {
		lane.close();
	}
});

test('a lane told its data segments clears only those on the first frame, and a wrong claim shows', () => {
	const withData = new WebAssembly.Module(
		Uint8Array.from(
			basic(`(module
		(import "folio" "load" (func $load (param i32 i32 i32 i32) (result i32)))
		(import "env" "memory" (memory 2 2 shared))
		(data (i32.const 200) "\\09")
		(func (export "__folio_set_fuel") (param i32))
		(func (export "peek") (param i32) (result i32)
			(call $load (local.get 0) (i32.const 0) (i32.const 1) (i32.const 0))))`)
		)
	);
	const first = (options: ConstructorParameters<typeof FolioLane>[1]) => {
		const lane = new FolioLane(withData, options);
		try {
			const { frame } = rangesFrame(new Uint8Array(131072), RangeSet.empty, [
				{ export: 'peek', args: [200] }
			]);
			return decodeResults(lane.execute(frame), claim, decodeOptions(1))[0]!.value;
		} finally {
			lane.close();
		}
	};
	assert.equal(first({ ...laneOptions, dataSegments: [[200, 1]] }), 0);
	assert.equal(first({ ...laneOptions, dataSegments: [] }), 9);
});

test('a lane returns escapes and flags a trap that unshipped zeros may have caused', () => {
	const lane = new FolioLane(tracked, laneOptions);
	const memory = new Uint8Array(131072);
	memory[10] = 3;
	try {
		const { frame } = rangesFrame(memory, RangeSet.of([[10, 1]]), [
			{ export: 'divide', args: [10] },
			{ export: 'divide', args: [20] },
			{ export: 'peek', args: [30] }
		]);
		const [known, trapped, clean] = decodeResults(lane.execute(frame), claim, decodeOptions(3));
		assert.equal(known!.value, 3);
		assert.equal(known!.escapes, undefined);
		assert.equal(known!.inconclusive, undefined);
		assert.notEqual(trapped!.trap, undefined);
		assert.deepEqual(trapped!.escapes, [[20, 1]]);
		assert.equal(trapped!.inconclusive, true);
		assert.deepEqual(clean!.escapes, [[30, 1]]);
		assert.equal(clean!.inconclusive, false);
	} finally {
		lane.close();
	}
});

test('a lane rejects a snapshot with ranges, malformed ranges, and a ranges payload read as a snapshot', () => {
	const lane = new FolioLane(tracked, laneOptions);
	const calls = [{ export: 'peek', args: [0] }];
	const base = { ...claim, calls, fuel: 100, maxBytes: 4096 };
	const memory = new Uint8Array(131072);
	try {
		const both = encodeFrame(
			{
				...base,
				snapshot: { memoryBytes: 131072, pages: [] },
				ranges: { memoryBytes: 131072, spans: [] }
			},
			new Uint8Array(1)
		);
		assert.throws(() => lane.execute(both), /not both/);
		for (const [spans, length, memoryBytes] of [
			[[10, 5, 12, 5], 11, 131072],
			[[10, 5, 0, 5], 11, 131072],
			[[131070, 5], 6, 131072],
			[[0, 0], 1, 131072],
			[[0], 1, 131072],
			[[], 1, 131073],
			[[0, 5], 5, 131072],
			[new Array(2050).fill(1), 1, 131072]
		] as const) {
			assert.throws(
				() =>
					lane.execute(
						encodeFrame(
							{ ...base, ranges: { memoryBytes, spans } },
							new Uint8Array(length)
						)
					),
				TypeError
			);
		}
		const { frame } = rangesFrame(memory, RangeSet.of([[0, 131072]]), calls);
		const legacy = encodeFrame(base, decodeFrame<unknown>(frame, 1 << 25).payload);
		assert.throws(() => lane.execute(legacy), /lane snapshot/);
		assert.equal(decodeResults(lane.execute(frame), claim, decodeOptions(1))[0]!.value, 0);
	} finally {
		lane.close();
	}
});

test('result frames round trip escapes and reject escape lists the read set cannot hold', () => {
	const options = { maximumFrameBytes: 65536, memoryBytes: 64, maxBytes: 16, calls: 1 };
	const result = {
		reads: [1, 2, 9],
		writes: [[3, 4]] as [number, number][],
		escapes: [
			[1, 2],
			[9, 1]
		] as [number, number][],
		inconclusive: true
	};
	assert.deepEqual(decodeResults(encodeResults(claim, [result]), claim, options), [result]);
	assert.throws(
		() =>
			decodeResults(
				encodeResults(claim, [{ ...result, escapes: [[60, 9]] }]),
				claim,
				options
			),
		RangeError
	);
	assert.throws(
		() =>
			decodeResults(
				encodeResults(claim, [
					{
						reads: [1],
						writes: [],
						escapes: [
							[1, 1],
							[2, 1]
						]
					}
				]),
				claim,
				options
			),
		TypeError
	);
});
// #endregion
