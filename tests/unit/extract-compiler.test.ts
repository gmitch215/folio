import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'vitest';
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
	} = {}
) {
	const plan = extract(source, (bytes) => ({ transactional: bytes }));
	assert.ok(plan);
	assert.ok(WebAssembly.validate(Uint8Array.from(plan.coordinator)));
	assert.ok(WebAssembly.validate(Uint8Array.from(plan.workerOriginal)));
	const serial = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
	const pending: { name: string; args: unknown[] }[] = [];
	let instance: WebAssembly.Instance;
	let regions = 0;
	let maximumPending = 0;
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
		}
	};
	const imports: Record<string, WebAssembly.ImportValue> = {
		barrier: drain,
		poll: drain,
		serial
	};
	for (const region of plan.regions)
		imports[region.importName] = (...args: unknown[]) => {
			pending.push({ name: region.exportName, args });
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
	const plan = extract(source, (bytes) => ({ transactional: bytes }));
	assert.ok(plan);
	const child = spawn(
		process.execPath,
		[
			'-e',
			`
		process.once('message', plan => {
		const serial = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
		const pending = [];
		let instance;
		const drain = () => {
			serial.value = 1;
			try {
				while (pending.length) {
					const call = pending.shift();
					instance.exports[call.name](...call.args);
				}
			} finally { serial.value = 0; }
		};
		const bindings = { serial, barrier: drain, poll: drain };
		for (const region of plan.regions) bindings[region.importName] = (...args) =>
			pending.push({ name: region.exportName, args });
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
