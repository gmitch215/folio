import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { Coordinator } from '../../src/coordinator.ts';
import { Folio, suspending } from '../../src/node.ts';

function wasm(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	try {
		module.setFeatures(binaryen.Features.All);
		assert.ok(module.validate());
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

const kernels = `
	(func $put (param $at i32) (param $value i32)
		(i32.store (local.get $at) (i32.add (i32.load (local.get $at)) (local.get $value))))
	(func $bad (param $at i32)
		(i32.store (local.get $at) (i32.const 91)) (unreachable))
`;

test('each generated region binding is constructed once across engine namespace lookups', async () => {
	const functions = Array.from(
		{ length: 64 },
		(_, index) =>
			`(func $put${index} (i32.store (i32.const ${index * 4}) (i32.const ${index})))`
	).join('\n');
	const calls = Array.from(
		{ length: 64 },
		(_, index) => `(call $put${index}) (call $observe)`
	).join('\n');
	const source = wasm(`(module (import "host" "observe" (func $observe))
		(memory (export "memory") 1 2 shared) ${functions}
		(func (export "run") ${calls}))`);
	const program = prepare(source, { minimumRegionWork: 0 });
	assert.ok(program.control && program.control.regions.length >= 64);
	const runtime = WebAssembly as any;
	const descriptor = Object.getOwnPropertyDescriptor(runtime, 'Suspending')!;
	const original = runtime.Suspending;
	let constructed = 0;
	Object.defineProperty(runtime, 'Suspending', {
		...descriptor,
		value: function (fn: unknown) {
			constructed++;
			return Reflect.construct(original, [fn]);
		}
	});
	let pool: Folio | undefined;
	try {
		pool = await Folio.open(program, {
			minimumRegionWork: 0,
			workers: 2,
			imports: { host: { observe() {} } }
		});
		assert.equal(constructed, program.control.regions.length + 2);
		await pool.run('run');
		assert.equal(new Uint32Array(pool.memory.buffer)[63], 63);
	} finally {
		Object.defineProperty(runtime, 'Suspending', descriptor);
		await pool?.close();
	}
});

test('single entry extracts regions across count-up loops, branches, nested calls and scalar live state', async () => {
	const source = wasm(`(module
		(import "host" "effect" (func $effect (param i32)))
		(memory (export "memory") 1 4 shared)
		(global $serial (mut i32) (i32.const 0))
		${kernels}
		(func $inner (param $n i32) (result i32) (local $i i32) (local $sum i32)
			(block $done (loop $again
				(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
				(if (i32.and (local.get $i) (i32.const 1))
					(then (call $put (i32.mul (local.get $i) (i32.const 4)) (local.get $i)))
					(else (call $put (i32.mul (local.get $i) (i32.const 4)) (i32.const 17))))
				(local.set $sum (i32.add (local.get $sum) (local.get $i)))
				(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
			(local.get $sum))
		(func (export "main") (param i32) (result i32) (local $sum i32)
			(call $effect (i32.const -1))
			(local.set $sum (call $inner (local.get 0)))
			(global.set $serial (i32.add (global.get $serial) (i32.const 1)))
			(call $effect (local.get $sum))
			(i32.add (local.get $sum) (global.get $serial))))`);
	const expectedEffects: number[] = [],
		actualEffects: number[] = [];
	const reference = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		host: { effect: (value: number) => expectedEffects.push(value) }
	});
	const pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 4,
		imports: {
			host: { effect: (value: number) => actualEffects.push(value) }
		}
	});
	try {
		assert.equal(pool.capabilities.automaticRegions, 'control-flow');
		assert.equal(pool.inspect('main').automatic, true);
		for (const count of [0, 1, 7, 23, 31]) {
			const expected = (reference.exports.main as CallableFunction)(count);
			const report = await pool.run('main', [count]);
			assert.deepEqual(report.values, [expected]);
			assert.equal(report.extraction, 'control-flow');
			assert.equal(report.regions, count);
			if (count >= 4) assert.equal(report.workers, 4);
			assert.equal(report.snapshotBytes, 0);
			assert.deepEqual(actualEffects, expectedEffects);
			assert.deepEqual(
				new Uint8Array(pool.memory.buffer),
				new Uint8Array((reference.exports.memory as WebAssembly.Memory).buffer)
			);
		}
		assert.deepEqual(Object.keys(pool.exports), Object.keys(reference.exports));
		assert.equal(Object.getPrototypeOf(pool.exports), null);
	} finally {
		await pool.close();
	}
});

test('inline heavy loops are outlined with captured locals and an owner-side scalar result', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared)
		(func (export "main") (param $n i32) (param $rounds i32) (result i32)
			(local $i i32) (local $j i32) (local $x i32) (local $sum i32)
			(block $done (loop $outer
				(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
				(local.set $x (i32.load (i32.mul (local.get $i) (i32.const 4))))
				(local.set $j (i32.const 0))
				(loop $inner
					(local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 13))))
					(local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 17))))
					(local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 5))))
					(local.set $j (i32.add (local.get $j) (i32.const 1)))
					(br_if $inner (i32.lt_u (local.get $j) (local.get $rounds))))
				(i32.store (i32.mul (local.get $i) (i32.const 4)) (local.get $x))
				(local.set $sum (i32.add (local.get $sum) (local.get $i)))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br $outer)))
			(local.get $sum)))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 4 });
	try {
		for (const [count, rounds] of [
			[1, 0],
			[2, 13],
			[19, 97],
			[67, 333]
		]) {
			for (const memory of [pool.memory, native.exports.memory as WebAssembly.Memory]) {
				const words = new Uint32Array(memory.buffer);
				for (let i = 0; i < words.length; i++) words[i] = Math.imul(i + 1, 2654435761);
			}
			const expected = (native.exports.main as CallableFunction)(count, rounds);
			const report = await pool.run('main', [count, rounds]);
			assert.equal(report.extraction, 'control-flow');
			assert.deepEqual(report.values, [expected]);
			assert.equal(report.regions, count);
			assert.equal(report.workers, count === 1 ? 0 : Math.min(count!, 4));
			assert.deepEqual(
				new Uint8Array(pool.memory.buffer),
				new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
			);
		}
	} finally {
		await pool.close();
	}
});

test('dynamic dependencies replay in order and memory observations join the extracted prefix', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared) ${kernels}
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 1))
			(call $put (i32.const 0) (i32.const 2))
			(call $put (i32.const 0) (i32.const 3))
			(call $put (i32.const 0) (i32.const 4))
			(i32.load (i32.const 0))))`);
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 4 });
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, [10]);
		assert.equal(report.regions, 4);
		assert.equal(report.workers, 4);
		assert.equal(report.replayed, 3);
	} finally {
		await pool.close();
	}
});

test('earlier worker traps commit their own prefix and suppress later coordinator effects', async () => {
	const source = wasm(`(module (import "host" "effect" (func $effect))
		(memory (export "memory") 1 2 shared) ${kernels}
		(func (export "main")
			(call $put (i32.const 0) (i32.const 7))
			(call $bad (i32.const 4))
			(call $put (i32.const 8) (i32.const 99))
			(call $effect)))`);
	let effects = 0;
	const pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 4,
		imports: {
			host: {
				effect: () => {
					effects++;
				}
			}
		}
	});
	try {
		assert.equal(pool.inspect('main').automatic, true);
		await assert.rejects(pool.run('main'), WebAssembly.RuntimeError);
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 3)], [7, 91, 0]);
		assert.equal(effects, 0);
		assert.equal(pool.exports.memory as WebAssembly.Memory, pool.memory);
	} finally {
		await pool.close();
	}
});

test('ordinary owned memory keeps initialization and ABI while snapshots grow with it', async () => {
	const source = wasm(`(module (import "host" "start" (func $start)) (start $start)
		(memory (export "memory") 1 3) (data (i32.const 0) "abcd") ${kernels}
		(func (export "main") (result i32)
			(call $put (i32.const 8) (i32.const 7))
			(call $put (i32.const 12) (i32.const 9))
			(drop (memory.grow (i32.const 1)))
			(call $put (i32.const 65536) (i32.const 11))
			(call $put (i32.const 65540) (i32.const 13))
			(i32.load (i32.const 65540))))`);
	let starts = 0;
	const pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 2,
		imports: {
			host: {
				start: () => {
					starts++;
				}
			}
		}
	});
	try {
		const memory = pool.memory;
		const old = memory.buffer;
		assert.equal(starts, 1);
		const report = await pool.run('main');
		assert.equal(starts, 1);
		assert.deepEqual(report.values, [13]);
		assert.equal(report.regions, 4);
		assert.equal(report.workers, 2);
		assert.equal(report.memoryMode, 'snapshot');
		assert.equal(report.snapshotBytes, 65536 + 131072);
		assert.equal(pool.memory, memory);
		assert.equal(memory.buffer instanceof SharedArrayBuffer, false);
		assert.equal(old.byteLength, 0);
		assert.equal(new TextDecoder().decode(new Uint8Array(memory.buffer, 0, 4)), 'abcd');
		assert.equal(new Uint32Array(memory.buffer)[16384], 11);
	} finally {
		await pool.close();
	}
});

test('asynchronous host effects observe committed bytes and synchronous reentry stays native', async () => {
	const source = wasm(`(module (import "host" "observe" (func $observe (result i32)))
		(memory (export "memory") 1 2 shared) ${kernels}
		(func (export "read") (result i32) (i32.load (i32.const 0)))
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 5))
			(call $put (i32.const 4) (i32.const 7))
			(call $observe)))`);
	let pool!: Folio;
	let observed = 0;
	pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 4,
		promising: ['main'],
		imports: {
			host: {
				observe: suspending(async () => {
					assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [5, 7]);
					observed = (pool.exports.read as CallableFunction)();
					await Promise.resolve();
					return observed;
				})
			}
		}
	});
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, [5]);
		assert.equal(report.regions, 2);
		assert.equal(observed, 5);
	} finally {
		await pool.close();
	}
});

test('budget exhaustion discards all speculative writes and executes the exact native suffix', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared) ${kernels}
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 5))
			(call $put (i32.const 4) (i32.const 7))
			(i32.load (i32.const 4))))`);
	const pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 2,
		maxTransactionBytes: 1
	});
	try {
		const report = await pool.run('main');
		assert.deepEqual(report.values, [7]);
		assert.equal(report.fallbacks, 1);
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [5, 7]);
	} finally {
		await pool.close();
	}
});

test('indirect calls and opaque SIMD keep ordered owner state between extracted regions', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared)
		(type $target (func (param i32))) (table 1 funcref)
		${kernels}
		(func $opaque (param i32)
			(call $put (local.get 0) (i32.const 3))
			(i32.store (i32.const 12) (i32x4.extract_lane 0 (v128.const i32x4 77 0 0 0))))
		(elem (i32.const 0) $opaque)
		(func (export "main") (result i32)
			(call $put (i32.const 0) (i32.const 5))
			(call $put (i32.const 4) (i32.const 7))
			(call_indirect (type $target) (i32.const 0) (i32.const 0))
			(call $put (i32.const 8) (i32.const 11))
			(i32.add (i32.load (i32.const 0)) (i32.load (i32.const 12)))))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 4 });
	try {
		const expected = (native.exports.main as CallableFunction)();
		const report = await pool.run('main');
		assert.equal(report.regions, 3);
		assert.deepEqual(report.values, [expected]);
		assert.deepEqual(
			new Uint8Array(pool.memory.buffer),
			new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
		);
	} finally {
		await pool.close();
	}
});

test('region argument encoding preserves signaling NaN payloads through real worker ports', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared)
		(func $put (param i32 f32 f64) (result i32)
			(f32.store (local.get 0) (local.get 1))
			(f64.store offset=4 align=1 (local.get 0) (local.get 2)) (i32.const 0))
		(func (export "main")
			(drop (call $put (i32.const 0) (f32.reinterpret_i32 (i32.const 2141266757))
				(f64.reinterpret_i64 (i64.const 9219188693200907213))))
			(drop (call $put (i32.const 16) (f32.const -0) (f64.const -0)))))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 2 });
	try {
		(native.exports.main as CallableFunction)();
		const report = await pool.run('main');
		assert.equal(report.workers, 2);
		assert.equal(report.regions, 2);
		assert.deepEqual(
			new Uint8Array(pool.memory.buffer),
			new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
		);
	} finally {
		await pool.close();
	}
});

test('closing a suspended coordinator joins its effect and refuses subsequent worker dispatch', async () => {
	const source = wasm(`(module (import "host" "wait" (func $wait))
		(memory (export "memory") 1 2 shared) ${kernels}
		(func (export "main")
			(call $wait)
			(call $put (i32.const 0) (i32.const 1))
			(call $put (i32.const 4) (i32.const 2))))`);
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seen = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 2,
		promising: ['main'],
		imports: {
			host: {
				wait: suspending(async () => {
					entered();
					await gate;
				})
			}
		}
	});
	const running = pool.run('main');
	const rejected = assert.rejects(running, /folio is closed/);
	await seen;
	let joined = false;
	const closing = pool.close().then(() => {
		joined = true;
	});
	await Promise.resolve();
	assert.equal(joined, false);
	release();
	await rejected;
	await closing;
	assert.equal(joined, true);
});

test('batched regions share one retained transaction budget per worker', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared)
		(func $fill (param i32 i32)
			(memory.fill (local.get 0) (local.get 1) (i32.const 4)))
		(func (export "main") (result i32)
			(call $fill (i32.const 0) (i32.const 1))
			(call $fill (i32.const 4) (i32.const 2))
			(call $fill (i32.const 8) (i32.const 3))
			(call $fill (i32.const 12) (i32.const 4))
			(call $fill (i32.const 16) (i32.const 5))
			(call $fill (i32.const 20) (i32.const 6))
			(i32.load (i32.const 20))))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const pool = await Folio.open(source, {
		minimumRegionWork: 0,
		workers: 2,
		maxTransactionBytes: 8,
		profile: true
	});
	try {
		const expected = (native.exports.main as CallableFunction)();
		const report = await pool.run('main');
		assert.deepEqual(report.values, [expected]);
		assert.ok(report.fallbacks > 0);
		assert.ok(report.profile!.writeBytes <= 16);
		assert.equal(report.regions, 6);
		assert.deepEqual(
			new Uint8Array(pool.memory.buffer),
			new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
		);
	} finally {
		await pool.close();
	}
});

test('recursive stack traps retain their native owner and ordered memory prefix', async () => {
	const source = wasm(`(module (memory (export "memory") 1 2 shared)
		(func $put (param i32 i32) (i32.store (local.get 0) (local.get 1)))
		(func $recur (param i32)
			(if (local.get 0)
				(then (call $recur (i32.sub (local.get 0) (i32.const 1))))))
		(func (export "main") (param i32)
			(call $put (i32.const 0) (i32.const 17))
			(call $recur (local.get 0))
			(call $put (i32.const 4) (i32.const 29))))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const nativeMemory = native.exports.memory as WebAssembly.Memory;
	let depth = 2048;
	let trapped = false;
	for (; depth <= 262144; depth *= 2) {
		new Uint8Array(nativeMemory.buffer).fill(0);
		try {
			(native.exports.main as CallableFunction)(depth);
		} catch (error) {
			assert.ok(error instanceof RangeError);
			trapped = true;
			break;
		}
	}
	assert.ok(trapped, 'bounded native recursion must reach the host stack limit');
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 2 });
	try {
		assert.equal(pool.inspect('main').automatic, true);
		await assert.rejects(pool.run('main', [depth]), RangeError);
		assert.deepEqual(new Uint8Array(pool.memory.buffer), new Uint8Array(nativeMemory.buffer));
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 2)], [17, 0]);
	} finally {
		await pool.close();
	}
});

test('recursive call batches and counted loops retain the native owner', async () => {
	const source = wasm(`(module (import "env" "memory" (memory 1 2 shared))
		(func $recur (export "recursive") (param i32)
			(if (local.get 0)
				(then (call $recur (i32.sub (local.get 0) (i32.const 1))))))
		(func (export "counted") (param $at i32) (param $count i32) (param $depth i32)
			(block $done
				(br_if $done (i32.eqz (local.get $count)))
				(loop $again
					(call $recur (local.get $depth))
					(i32.store (local.get $at) (i32.const 7))
					(local.set $at (i32.add (local.get $at) (i32.const 4)))
					(br_if $again (local.tee $count
						(i32.add (local.get $count) (i32.const -1))))))))`);
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 2 });
	try {
		const batch = await pool.runAll([
			{ export: 'recursive', args: [8] },
			{ export: 'recursive', args: [16] }
		]);
		assert.equal(batch.mode, 'serial');
		assert.equal(batch.workers, 0);
		const counted = await pool.run('counted', [0, 3, 8]);
		assert.equal(counted.mode, 'serial');
		assert.equal(counted.workers, 0);
		assert.equal(pool.inspect('counted').nativeGuard, false);
		assert.deepEqual([...new Uint32Array(pool.memory.buffer, 0, 3)], [7, 7, 7]);
		assert.ok(pool.diagnostics.some((reason) => reason.includes('recursive call graph')));
	} finally {
		await pool.close();
	}
});

const spinSource = `(module (memory (export "memory") 2)
	(func (export "chain") (param $n i32) (result i32) (local $i i32) (local $x i32)
		(local.set $x (i32.const 1))
		(loop $next
			(local.set $x (i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223)))
			(i32.store (i32.and (i32.shl (local.get $i) (i32.const 2)) (i32.const 65532)) (local.get $x))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $x)))`;

test('a plan with no region above the threshold leaves the entry on the original module', async () => {
	const source = wasm(spinSource);
	const prepared = prepare(source);
	assert.equal(prepared.control, undefined);
	assert.ok(prepared.controlReasons?.some((reason) => reason.includes('no region reached')));
	const counts = { flush: 0, poll: 0, enqueue: 0 };
	const proto = Coordinator.prototype as unknown as Record<
		string,
		(this: unknown, ...args: unknown[]) => unknown
	>;
	const originals = Object.fromEntries(Object.keys(counts).map((name) => [name, proto[name]!]));
	for (const name of Object.keys(counts) as (keyof typeof counts)[])
		proto[name] = function (this: unknown, ...args: unknown[]) {
			counts[name]++;
			return originals[name]!.apply(this, args);
		};
	const reference = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const pool = await Folio.open(prepared, { workers: 2 });
	try {
		const expected = (reference.exports.chain as CallableFunction)(20_000);
		const report = await pool.run('chain', [20_000]);
		assert.deepEqual(report.values, [expected]);
		assert.equal(report.mode, 'serial');
		assert.equal(report.workers, 0);
		assert.equal(pool.inspect('chain').automatic, false);
		assert.ok(pool.diagnostics.some((reason) => reason.includes('no region reached')));
		assert.deepEqual(counts, { flush: 0, poll: 0, enqueue: 0 });
	} finally {
		Object.assign(proto, originals);
		await pool.close();
	}
});

const kernelRun = `(module (memory (export "memory") 2 8 shared)
	(func $kernel (param $at i32) (param $rounds i32) (local $i i32) (local $v i32)
		(local.set $v (i32.load (local.get $at)))
		(loop $l
			(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 13))))
			(local.set $v (i32.xor (local.get $v) (i32.shr_u (local.get $v) (i32.const 17))))
			(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 5))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.ne (local.get $i) (local.get $rounds))))
		(i32.store (local.get $at) (local.get $v)))
	(func (export "run") (param $count i32) (param $rounds i32) (result i32) (local $j i32)
		(loop $o
			(call $kernel (i32.add (i32.const 1024) (i32.shl (local.get $j) (i32.const 2))) (local.get $rounds))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br_if $o (i32.lt_u (local.get $j) (local.get $count))))
		(i32.load (i32.const 1024))))`;

test('a compute-bound region still dispatches at the default threshold and a short one stays at the owner', async () => {
	const source = wasm(kernelRun);
	for (const [rounds, regions, workers] of [
		[200_000, 16, 2],
		[100, 0, 0]
	] as const) {
		const reference = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
		const seeded = new Uint32Array((reference.exports.memory as WebAssembly.Memory).buffer);
		for (let i = 0; i < 16; i++) seeded[256 + i] = Math.imul(i + 1, 2654435761) >>> 0;
		const pool = await Folio.open(source, { workers: 2 });
		try {
			new Uint32Array(pool.memory.buffer).set(seeded.subarray(256, 272), 256);
			const expected = (reference.exports.run as CallableFunction)(16, rounds);
			const report = await pool.run('run', [16, rounds]);
			assert.deepEqual(report.values, [expected]);
			assert.equal(report.regions, regions, `rounds ${rounds}`);
			assert.equal(report.workers, workers);
			assert.deepEqual(
				new Uint8Array(pool.memory.buffer, 1024, 64),
				new Uint8Array((reference.exports.memory as WebAssembly.Memory).buffer, 1024, 64)
			);
		} finally {
			await pool.close();
		}
	}
});
