import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import type { AdmissionOptions } from '../../src/extract.ts';
import { extract } from '../../src/extract.ts';

function compile(wat: string): Uint8Array {
	const module = binaryen.parseText(wat);
	const compactImports = (binaryen.Features as unknown as { CompactImports: number })
		.CompactImports;
	module.setFeatures(binaryen.Features.All & ~compactImports);
	try {
		assert.ok(module.validate());
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

function harness(
	source: Uint8Array,
	options: {
		imports?: WebAssembly.Imports;
		beforeBarrier?: () => void;
		admission?: AdmissionOptions;
	} = {}
) {
	const plan = extract(
		source,
		(bytes) => ({ transactional: bytes }),
		options.admission ?? { minimumRegionWork: 0 }
	);
	assert.ok(plan);
	assert.ok(WebAssembly.validate(Uint8Array.from(plan.coordinator)));
	assert.ok(WebAssembly.validate(Uint8Array.from(plan.workerOriginal)));
	const serial = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
	const queued = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
	const pending: { name: string; args: unknown[] }[] = [];
	let instance: WebAssembly.Instance;
	let regions = 0;
	let maximumPending = 0;
	let crossings = 0;
	const drain = () => {
		options.beforeBarrier?.();
		const previous = serial.value;
		serial.value = 1;
		try {
			while (pending.length) {
				const region = pending.shift()!;
				(instance.exports[region.name] as CallableFunction)(...region.args);
			}
		} catch (error) {
			pending.length = 0;
			throw error;
		} finally {
			serial.value = previous;
			queued.value = pending.length ? 1 : 0;
		}
	};
	const cross = () => {
		crossings++;
		drain();
	};
	const imports: Record<string, WebAssembly.ImportValue> = {
		barrier: cross,
		poll: cross,
		serial,
		[plan.pendingGlobal]: queued
	};
	for (const region of plan.regions)
		imports[region.importName] = (...args: unknown[]) => {
			pending.push({ name: region.exportName, args });
			queued.value = 1;
			regions++;
			maximumPending = Math.max(maximumPending, pending.length);
		};
	instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(plan.coordinator)), {
		...options.imports,
		[plan.namespace]: imports
	});
	return {
		plan,
		instance,
		serial,
		memory: instance.exports[plan.memoryExport] as WebAssembly.Memory,
		get regions() {
			return regions;
		},
		get maximumPending() {
			return maximumPending;
		},
		get crossings() {
			return crossings;
		},
		run(name: string, ...args: unknown[]): unknown {
			serial.value = 0;
			try {
				const result = (instance.exports[name] as CallableFunction)(...args);
				drain();
				return result;
			} catch (error) {
				drain();
				throw error;
			} finally {
				serial.value = 1;
			}
		}
	};
}

test('memory barrier helpers are shared across access sites without merging opcode attributes', () => {
	const accesses = Array.from(
		{ length: 256 },
		(_, i) => `(call $observe (i32.load (i32.const ${i * 4})))`
	).join('\n');
	const source = compile(`(module
		(import "host" "observe" (func $observe (param i32)))
		(memory (export "memory") 1 2 shared)
		(func $put (i32.store (i32.const 0) (i32.const -2130771969)))
		(func (export "run")
			(call $put)
			${accesses}
			(call $observe (i32.load8_s (i32.const 0)))
			(call $observe (i32.load8_u (i32.const 0)))
			(call $observe (i32.load8_u offset=1 (i32.const 0)))
			(call $observe (i32.load16_u (i32.const 0)))
			(call $observe (i32.load align=1 (i32.const 1))))
		(func (export "trap") (call $put)
			(call $observe (i32.load offset=4 (i32.const 65532)))))`);
	const expected: number[] = [],
		actual: number[] = [];
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		host: { observe: (value: number) => expected.push(value) }
	});
	const transformed = harness(source, {
		imports: { host: { observe: (value: number) => actual.push(value) } }
	});
	(native.exports.run as CallableFunction)();
	transformed.run('run');
	assert.deepEqual(actual, expected);
	assert.deepEqual(
		new Uint8Array(transformed.memory.buffer),
		new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
	);
	const module = binaryen.readBinary(transformed.plan.coordinator);
	try {
		// Emission strips names. Even including host-call helpers, access-site duplication cannot fit.
		assert.ok(module.getNumFunctions() < 2 * 256);
	} finally {
		module.dispose();
	}
	assert.throws(() => (native.exports.trap as CallableFunction)(), WebAssembly.RuntimeError);
	assert.throws(() => transformed.run('trap'), WebAssembly.RuntimeError);
});

test('outlining preserves locals carried through a loop backedge', () => {
	const source = compile(`(module (memory (export "memory") 1 2 shared)
		(func $put (param i32) (i32.store (i32.const 8) (local.get 0)))
		(func (export "run") (param $n i32) (local $i i32) (local $x i32)
			(block $done (loop $again
				(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
				(local.set $x (i32.add (local.get $x) (i32.const 1)))
				(i32.store (i32.const 0) (local.get $x))
				(call $put (local.get $i))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br $again)))))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const transformed = harness(source);
	transformed.run('run', 7);
	(native.exports.run as CallableFunction)(7);
	assert.deepEqual(
		new Uint8Array(transformed.memory.buffer),
		new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
	);
	assert.ok(transformed.regions > 0);
});

test('a pending trap joins before unbounded tail recursion', async () => {
	const source = compile(`(module (memory (export "memory") 1 2 shared)
		(func $bad (i32.store (i32.const 0) (i32.const 71)) (unreachable))
		(func $spin (return_call $spin))
		(func (export "run") (call $bad) (return_call $spin)))`);
	const plan = extract(source, (bytes) => ({ transactional: bytes }), { minimumRegionWork: 0 });
	assert.ok(plan);
	const child = spawn(
		process.execPath,
		[
			'-e',
			`
		process.once('message', plan => {
		const serial = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
		const queued = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
		const pending = [];
		let instance;
		const drain = () => {
			serial.value = 1;
			try {
				while (pending.length) {
					const call = pending.shift();
					instance.exports[call.name](...call.args);
				}
			} finally { serial.value = 0; queued.value = pending.length ? 1 : 0; }
		};
		const bindings = { serial, barrier: drain, poll: drain, [plan.pendingGlobal]: queued };
		for (const region of plan.regions) bindings[region.importName] = (...args) => {
			pending.push({ name: region.exportName, args }); queued.value = 1; };
		instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(plan.coordinator)), {
			[plan.namespace]: bindings
		});
		serial.value = 0;
		try { instance.exports.run(); process.send({ trapped: false }); }
		catch (error) { process.send({ trapped: error instanceof WebAssembly.RuntimeError,
			prefix: new Uint32Array(instance.exports[plan.memoryExport].buffer)[0] }); }
		process.disconnect();
		});
	`
		],
		{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
	);
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await new Promise((resolve, reject) => {
			child.once('message', resolve);
			child.once('error', reject);
			timer = setTimeout(
				() => reject(new Error('pending trap was starved by tail recursion')),
				1000
			);
			child.send({ ...plan, coordinator: Array.from(plan.coordinator) });
		});
		assert.deepEqual(result, { trapped: true, prefix: 71 });
	} finally {
		clearTimeout(timer);
		child.kill('SIGKILL');
		await exited;
	}
});

test('direct and mutual recursion stay at the original owner between extracted calls', () => {
	for (const mutual of [false, true]) {
		const source = compile(`(module (memory (export "memory") 1 2 shared)
			(func $put (param i32 i32) (i32.store (local.get 0) (local.get 1)))
			(func $a (export "recursive-a") (param i32)
				(if (local.get 0) (then (call $${mutual ? 'b' : 'a'}
					(i32.sub (local.get 0) (i32.const 1))))))
			${
				mutual
					? `(func $b (export "recursive-b") (param i32)
				(call $a (local.get 0)))`
					: ''
			}
			(func (export "run") (param i32)
				(call $put (i32.const 0) (i32.const 17))
				(call $a (local.get 0))
				(call $put (i32.const 4) (i32.const 29))))`);
		const transformed = harness(source);
		const workerExports = WebAssembly.Module.exports(
			new WebAssembly.Module(Uint8Array.from(transformed.plan.workerOriginal))
		);
		assert.ok(workerExports.every((entry) => !entry.name.startsWith('recursive-')));
		transformed.run('run', 8);
		assert.equal(transformed.regions, 2);
		assert.deepEqual([...new Uint32Array(transformed.memory.buffer, 0, 2)], [17, 29]);
		assert.ok(
			transformed.plan.diagnostics.some((reason) => reason.includes('native recursion'))
		);
	}
});

test('control extraction retains nested branches, scalar live-outs and native initialization', () => {
	const source = compile(`(module
		(memory 1 4)
		(global $seed (mut i32) (i32.const 3))
		(data (i32.const 80) "abcd")
		(func $init (global.set $seed (i32.const 9)))
		(start $init)
		(func $put (param i32 i32)
			(i32.store (local.get 0) (local.get 1)))
		(func $nested (param i32)
			(if (i32.and (local.get 0) (i32.const 1))
				(then (call $put (i32.mul (local.get 0) (i32.const 4)) (i32.const 19)))
				(else (call $put (i32.mul (local.get 0) (i32.const 4)) (i32.const 23)))))
		(func (export "run") (param i32) (result i32) (local i32 i32)
			(block $done
				(loop $again
					(br_if $done (i32.ge_u (local.get 1) (local.get 0)))
					(call $nested (local.get 1))
					(local.set 2 (i32.add (local.get 2) (local.get 1)))
					(local.set 1 (i32.add (local.get 1) (i32.const 1)))
					(br $again)))
			(call $put (i32.const 100) (global.get $seed))
			(call $put (i32.const 104) (local.get 2))
			(i32.add (local.get 2) (i32.load (i32.const 100))))
		(export "memory" (memory 0)))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const transformed = harness(source);
	assert.ok(transformed.plan.entries.includes('run'));
	assert.equal(transformed.run('run', 8), (native.exports.run as CallableFunction)(8));
	assert.deepEqual(
		new Uint8Array(transformed.memory.buffer),
		new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
	);
	assert.ok(transformed.regions >= 3);
	assert.ok(transformed.maximumPending >= 2);
	assert.equal(transformed.serial.value, 1);
});

test('control extraction drains before host effects and the first native trap', () => {
	const source = compile(`(module
		(import "env" "effect" (func $effect (param i32) (result i32)))
		(memory (export "memory") 1 4)
		(func $put (param i32 i32) (i32.store (local.get 0) (local.get 1)))
		(func (export "run") (param i32) (result i32)
			(call $put (i32.const 0) (i32.const 41))
			(call $put (i32.const 4) (i32.const 42))
			(drop (call $effect (i32.load (i32.const 4))))
			(call $put (i32.const 8) (i32.const 43))
			(i32.div_s (i32.load (i32.const 8)) (local.get 0))))`);
	let observed = 0;
	const transformed = harness(source, {
		imports: {
			env: {
				effect(value: number) {
					assert.equal(transformed.serial.value, 1);
					assert.deepEqual(
						[...new Int32Array(transformed.memory.buffer).slice(0, 2)],
						[41, 42]
					);
					observed = value;
					return 9;
				}
			}
		}
	});
	assert.throws(() => transformed.run('run', 0), WebAssembly.RuntimeError);
	assert.equal(observed, 42);
	assert.deepEqual([...new Int32Array(transformed.memory.buffer).slice(0, 3)], [41, 42, 43]);
	assert.equal(transformed.regions, 3);
});

test('control extraction preserves discarded floating-point argument bits and switch control', () => {
	const source = compile(`(module
		(memory (export "memory") 1 4)
		(func $put (param i32 f32 f64) (result i32)
			(f32.store (local.get 0) (local.get 1))
			(f64.store offset=4 align=4 (local.get 0) (local.get 2))
			(i32.const 11))
		(func (export "run") (param i32)
			(block $done
				(block $second
					(block $first
						(br_table $first $second $done (local.get 0)))
					(drop (call $put (i32.const 0)
						(f32.reinterpret_i32 (i32.const 2141266757))
						(f64.reinterpret_i64 (i64.const 9219188693200907213))))
					(br $done))
				(drop (call $put (i32.const 16) (f32.const -0) (f64.const -0))))))`);
	for (const index of [0, 1, 2]) {
		const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
		const transformed = harness(source);
		transformed.run('run', index);
		(native.exports.run as CallableFunction)(index);
		assert.deepEqual(
			new Uint8Array(transformed.memory.buffer),
			new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
		);
		assert.equal(transformed.regions, index < 2 ? 1 : 0);
	}
});

test('control extraction orders opaque SIMD functions while preserving surrounding regions', () => {
	const source = compile(`(module
		(memory (export "memory") 1 4)
		(func $put (param i32) (i32.store (local.get 0) (i32.const 71)))
		(func $opaque (i32.store (i32.const 8)
			(i32x4.extract_lane 0 (v128.const i32x4 12 13 14 15))))
		(func (export "run")
			(call $put (i32.const 0))
			(call $put (i32.const 4))
			(call $opaque)
			(call $put (i32.const 12))))`);
	const transformed = harness(source);
	transformed.run('run');
	assert.deepEqual([...new Int32Array(transformed.memory.buffer).slice(0, 4)], [71, 71, 12, 71]);
	assert.ok(
		transformed.plan.diagnostics.some((value) => value.includes('ordered native function'))
	);
	assert.equal(transformed.regions, 3);
});

test('control extraction retains direct, indirect and host tail-call results', () => {
	const source = compile(`(module
		(type $result (func (param i32) (result i32)))
		(import "env" "host" (func $host (type $result)))
		(memory (export "memory") 1 4)
		(table $table 1 funcref)
		(func $put (param i32) (i32.store (i32.const 0) (local.get 0)))
		(func $result (type $result) (param i32) (result i32)
			(i32.add (local.get 0) (i32.load (i32.const 0))))
		(elem (i32.const 0) $result)
		(func (export "direct") (param i32) (result i32)
			(call $put (local.get 0))
			(return_call $result (local.get 0)))
		(func (export "indirect") (param i32) (result i32)
			(call $put (local.get 0))
			(return_call_indirect $table (type $result) (local.get 0) (i32.const 0)))
		(func (export "host") (param i32) (result i32)
			(call $put (local.get 0))
			(return_call $host (local.get 0))))`);
	const imported = { env: { host: (value: number) => value + 7 } };
	const transformed = harness(source, { imports: imported });
	const native = new WebAssembly.Instance(
		new WebAssembly.Module(Uint8Array.from(source)),
		imported
	);
	for (const name of ['direct', 'indirect', 'host']) {
		assert.ok(transformed.plan.entries.includes(name));
		assert.equal(transformed.run(name, 12), (native.exports[name] as CallableFunction)(12));
		assert.equal(new Int32Array(transformed.memory.buffer)[0], 12);
	}
	assert.equal(transformed.regions, 3);
});

test('control extraction preserves passive data operations and reserved-name collisions', () => {
	const source = compile(`(module
		(import "__folio_control" "effect" (func $effect))
		(memory $heap (export "__folio_control_memory") 1 4)
		(global $__folio_control_serial (mut i32) (i32.const 12))
		(data $passive "abcd")
		(func $__folio_enqueue_0 (i32.store (i32.const 0) (i32.const 71)))
		(func $__folio_region_0 (nop))
		(func (export "run")
			(call $__folio_enqueue_0)
			(memory.init $passive (i32.const 16) (i32.const 0) (i32.const 4))
			(data.drop $passive)
			(call $effect)
			(call $__folio_enqueue_0)))`);
	const transformed = harness(source, { imports: { __folio_control: { effect() {} } } });
	assert.notEqual(transformed.plan.namespace, '__folio_control');
	assert.notEqual(transformed.plan.memoryExport, '__folio_control_memory');
	transformed.run('run');
	assert.equal(new Int32Array(transformed.memory.buffer)[0], 71);
	assert.equal(
		new TextDecoder().decode(new Uint8Array(transformed.memory.buffer, 16, 4)),
		'abcd'
	);
	assert.equal(transformed.regions, 2);
	assert.throws(() => transformed.run('run'), WebAssembly.RuntimeError);
});

test('inline outlining extracts memory kernels without preexisting function calls', () => {
	const source = compile(`(module
		(memory (export "memory") 1 4)
		(global $checksum (mut i32) (i32.const 0))
		(func (export "run") (param i32) (result i32) (local i32 i32 i32 i32)
			(block $done
				(loop $outer
					(br_if $done (i32.ge_u (local.get 1) (local.get 0)))
					(local.set 2 (i32.add (local.get 1) (i32.const 73)))
					(local.set 3 (i32.const 0))
					(loop $mix
						(local.set 2 (i32.add
							(i32.mul (local.get 2) (i32.const 1664525)) (i32.const 1013904223)))
						(local.set 3 (i32.add (local.get 3) (i32.const 1)))
						(br_if $mix (i32.lt_u (local.get 3) (i32.const 20))))
					(i32.store (i32.mul (local.get 1) (i32.const 4)) (local.get 2))
					(local.set 4 (i32.add (local.get 4) (local.get 1)))
					(local.set 1 (i32.add (local.get 1) (i32.const 1)))
					(br $outer)))
			(global.set $checksum (local.get 4))
			(i32.add (global.get $checksum) (i32.load (i32.const 0)))))`);
	const transformed = harness(source);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	assert.ok(transformed.plan.entries.includes('run'));
	assert.equal(transformed.run('run', 8), (native.exports.run as CallableFunction)(8));
	assert.deepEqual(
		new Uint8Array(transformed.memory.buffer),
		new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
	);
	assert.equal(transformed.regions, 8);
});

test('inline outlining preserves scalar live-outs and escaping branch targets', () => {
	const source = compile(`(module
		(memory (export "memory") 1 4)
		(global $observed (mut i32) (i32.const 0))
		(func (export "run") (param i32) (result i32) (local i32 i32)
			(block $done
				(loop $again
					(local.set 1 (i32.add (local.get 1) (i32.const 3)))
					(if (i32.gt_u (local.get 1) (local.get 0)) (then (br $done)))
					(i32.store (i32.mul (local.get 2) (i32.const 4))
						(i32.mul (local.get 1) (i32.const 7)))
					(local.set 2 (i32.add (local.get 2) (i32.const 1)))
					(br $again)))
			(global.set $observed (local.get 1))
			(i32.add (global.get $observed) (local.get 2))))`);
	for (const count of [0, 2, 3, 4, 12]) {
		const transformed = harness(source);
		const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
		assert.equal(
			transformed.run('run', count),
			(native.exports.run as CallableFunction)(count)
		);
		assert.deepEqual(
			new Uint8Array(transformed.memory.buffer),
			new Uint8Array((native.exports.memory as WebAssembly.Memory).buffer)
		);
		assert.equal(transformed.regions, Math.floor(count / 3));
	}
});

const kernelSource = (bound: string) => `
	(func $kernel (param $at i32) (param $rounds i32) (local $i i32) (local $v i32)
		(local.set $v (i32.load (local.get $at)))
		(loop $l
			(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 13))))
			(local.set $v (i32.xor (local.get $v) (i32.shr_u (local.get $v) (i32.const 17))))
			(local.set $v (i32.xor (local.get $v) (i32.shl (local.get $v) (i32.const 5))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.ne (local.get $i) ${bound})))
		(i32.store (local.get $at) (local.get $v)))`;

const scanSource = `
	(func $scan (param $n i32) (result i32) (local $i i32) (local $sum i32)
		(loop $s
			(local.set $sum (i32.add (local.get $sum)
				(i32.load (i32.shl (local.get $i) (i32.const 2)))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $s (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $sum))`;

const admission = (source: Uint8Array, options: AdmissionOptions) => {
	const refusals: string[] = [];
	const plan = extract(source, (bytes) => ({ transactional: bytes }), {
		...options,
		refused: (reason) => refusals.push(reason)
	});
	return { plan, refusals };
};

test('static admission keeps spans below the threshold inline and refuses a plan with no region', () => {
	const source = compile(`(module (memory (export "memory") 2)
		(func (export "chain") (param $n i32) (result i32) (local $i i32) (local $x i32)
			(local.set $x (i32.const 1))
			(loop $next
				(local.set $x (i32.add (i32.mul (local.get $x) (i32.const 1664525)) (i32.const 1013904223)))
				(i32.store (i32.and (i32.shl (local.get $i) (i32.const 2)) (i32.const 65532)) (local.get $x))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
			(local.get $x)))`);
	const refused = admission(source, {});
	assert.equal(refused.plan, undefined);
	assert.ok(refused.refusals.some((reason) => reason.includes('no region reached 200000')));
	const admitted = admission(source, { minimumRegionWork: 0 });
	assert.ok(admitted.plan);
	assert.ok(admitted.plan.regions.length >= 1);
});

test('a compute loop with no memory traffic clears the default threshold', () => {
	const source =
		compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource('(local.get $rounds)')}
		(func (export "run") (call $kernel (i32.const 256) (i32.const 64))
			(call $kernel (i32.const 260) (i32.const 64))))`);
	const { plan, refusals } = admission(source, {});
	assert.deepEqual(refusals, []);
	assert.ok(plan);
	assert.equal(plan.regions.length, 1);
	assert.deepEqual(plan.entries, ['run']);
});

test('memory traffic in a loop is charged to the work estimate', () => {
	const source = compile(`(module (memory (export "memory") 1 4 shared)
		(func $stream (param $at i32) (param $n i32) (local $i i32)
			(loop $l
				(i32.store (i32.add (local.get $at) (i32.shl (local.get $i) (i32.const 2)))
					(i32.xor (i32.load (i32.add (local.get $at) (i32.shl (local.get $i) (i32.const 2))))
						(i32.const 7)))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br_if $l (i32.ne (local.get $i) (local.get $n)))))
		(func (export "run") (call $stream (i32.const 0) (i32.const 64))
			(call $stream (i32.const 4096) (i32.const 64))))`);
	assert.equal(admission(source, {}).plan, undefined);
	assert.ok(admission(source, { minimumRegionWork: 0 }).plan);
});

test('the assumed trip count and constant loop bounds feed the work estimate', () => {
	const unseen =
		compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource('(i32.mul (local.get $rounds) (i32.const 3))')}
		(func (export "run") (call $kernel (i32.const 256) (i32.const 0))))`);
	assert.equal(admission(unseen, {}).plan, undefined);
	assert.equal(admission(unseen, { assumedTripCount: 10_000 }).plan, undefined);
	assert.ok(admission(unseen, { assumedTripCount: 100_000 }).plan);
	const few =
		compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource('(i32.const 4)')}
		(func (export "run") (call $kernel (i32.const 256) (i32.const 0))))`);
	assert.equal(admission(few, { assumedTripCount: 1_000_000 }).plan, undefined);
	const many =
		compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource('(i32.const 1000000)')}
		(func (export "run") (call $kernel (i32.const 256) (i32.const 0))))`);
	assert.ok(admission(many, { assumedTripCount: 1 }).plan);
	// 13 units per trip: 10,000 trips sit under the 200,000 default and 20,000 clear it
	for (const [trips, admitted] of [
		[10_000, false],
		[20_000, true]
	] as const) {
		const bounded =
			compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource(`(i32.const ${trips})`)}
		(func (export "run") (call $kernel (i32.const 256) (i32.const 0))))`);
		assert.equal(Boolean(admission(bounded, {}).plan), admitted, `trips ${trips}`);
	}
});

test('a parameter-bounded loop is checked against its arguments at each call', () => {
	const source =
		compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource('(local.get $rounds)')}
		(func (export "run") (param $rounds i32)
			(call $kernel (i32.const 256) (local.get $rounds))
			(call $kernel (i32.const 260) (local.get $rounds))))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const reference = (native.exports.memory as WebAssembly.Memory).buffer;
	for (const [rounds, regions] of [
		[64, 0],
		[2000, 0],
		[100_000, 2],
		[600_000, 2]
	] as const) {
		const transformed = harness(source, { admission: {} });
		new Uint32Array(transformed.memory.buffer).set([7, 11], 64);
		new Uint32Array(reference).set([7, 11], 64);
		transformed.run('run', rounds);
		(native.exports.run as CallableFunction)(rounds);
		assert.equal(transformed.regions, regions, `rounds ${rounds}`);
		assert.deepEqual(new Uint8Array(transformed.memory.buffer), new Uint8Array(reference));
	}
});

test('functions that never reach an admitted region keep their original bodies', () => {
	const source = compile(`(module (memory (export "memory") 1 4 shared)
		${kernelSource('(local.get $rounds)')}${scanSource}
		(func (export "run") (param $n i32) (result i32)
			(call $kernel (i32.const 256) (i32.const 64))
			(call $scan (local.get $n))))`);
	const { plan } = admission(source, {});
	assert.ok(plan);
	assert.ok(
		plan.diagnostics.some((reason) => /1 regions from 1 of 3 .*; 1 instrumented/.test(reason))
	);
	assert.deepEqual(plan.entries, ['run']);
});

test('generated barriers cross into the host only while a region is queued', () => {
	const source =
		compile(`(module (memory (export "memory") 1 4 shared) ${kernelSource('(local.get $rounds)')}
		(func (export "scanFirst") (param $n i32) (result i32) (local $i i32) (local $sum i32)
			(loop $s
				(local.set $sum (i32.add (local.get $sum)
					(i32.load (i32.shl (local.get $i) (i32.const 2)))))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br_if $s (i32.lt_u (local.get $i) (local.get $n))))
			(call $kernel (i32.const 4096) (i32.const 100000))
			(local.get $sum))
		(func (export "queueFirst") (param $n i32) (result i32) (local $i i32) (local $sum i32)
			(call $kernel (i32.const 4096) (i32.const 100000))
			(loop $s
				(local.set $sum (i32.add (local.get $sum)
					(i32.load (i32.shl (local.get $i) (i32.const 2)))))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br_if $s (i32.lt_u (local.get $i) (local.get $n))))
			(local.get $sum)))`);
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)));
	const idle = harness(source, { admission: {} });
	assert.equal(idle.run('scanFirst', 500), (native.exports.scanFirst as CallableFunction)(500));
	assert.equal(idle.crossings, 0);
	assert.equal(idle.regions, 1);
	const busy = harness(source, { admission: {} });
	assert.equal(busy.run('queueFirst', 500), (native.exports.queueFirst as CallableFunction)(500));
	assert.equal(busy.crossings, 1);
});

test('invalid admission options are rejected before any module is read', () => {
	assert.throws(() => prepare(new Uint8Array(), { minimumRegionWork: -1 }), RangeError);
	assert.throws(() => prepare(new Uint8Array(), { minimumRegionWork: Number.NaN }), RangeError);
	assert.throws(() => prepare(new Uint8Array(), { assumedTripCount: 0 }), RangeError);
	assert.throws(() => prepare(new Uint8Array(), { assumedTripCount: 1.5 }), RangeError);
});
