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
