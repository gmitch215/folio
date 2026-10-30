import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
	blake3Subject,
	compareInline,
	fixtureSubjects
} from '../../scripts/research/inline-diff.ts';
import { prepare } from '../../src/compiler.ts';
import type { AdmissionOptions, IterationRoute } from '../../src/extract.ts';
import { extract, iterationRoute, stackRoute } from '../../src/extract.ts';
import type { InlineOptions } from '../../src/inline.ts';
import { inlineEntryBytes, lowerInline } from '../../src/inline.ts';

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

function named(wat: string): Uint8Array {
	binaryen.setDebugInfo(true);
	try {
		return compile(wat);
	} finally {
		binaryen.setDebugInfo(false);
	}
}

const frame = `(global $sp (mut i32) (i32.const 65536))
	(func $sum (export "sum") (param $n i32) (result i32) (local $frame i32) (local $r i32)
		(local.set $frame (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $frame))
		(i32.store (local.get $frame) (local.get $n))
		(local.set $r (if (result i32) (i32.eqz (local.get $n))
			(then (i32.const 0))
			(else (i32.add (i32.load (local.get $frame))
				(call $sum (i32.sub (local.get $n) (i32.const 1)))))))
		(global.set $sp (i32.add (local.get $frame) (i32.const 16)))
		(local.get $r))
	(func $run (export "run") (param i32) (i32.store (i32.const 0) (call $sum (local.get 0))))`;

test('the stack route admits one mutable i32 global and recursion and leaves the existing routes alone', () => {
	const prepared = prepare(
		named(`(module (import "env" "memory" (memory 1 2 shared)) ${frame})`),
		{
			minimumRegionWork: 0
		}
	);
	const route = prepared.stackRoute!;
	assert.ok(route.eligible);
	assert.deepEqual(route.stack, { name: 'sp', initial: 65536 });
	assert.deepEqual(route.functions, ['sum', 'run']);
	assert.deepEqual(route.recursive, ['sum']);
	assert.deepEqual(route.constants, []);
	assert.ok(Number.isFinite(route.work.sum!.compute) && route.work.sum!.compute > 0);
	assert.ok(route.work.run!.compute > 0);
	assert.ok(route.diagnostics.includes('stack global sp'));
	assert.ok(route.diagnostics.includes('worker set: 2 of 2 functions, 1 recursive'));
	assert.ok(prepared.reasons.includes('recursive call graph retains original owner stack'));
	assert.ok(prepared.reasons.includes('global state'));
	assert.equal(prepared.control, undefined);
	assert.deepEqual(prepared.controlReasons, ['no pure function to run as a region']);
	assert.equal(prepare(compile('(module)'), { parallel: 'off' }).stackRoute, undefined);
});

test('the stack route reports every function on a call cycle and estimates mutual recursion', () => {
	const route = stackRoute(
		named(`(module (import "env" "memory" (memory 1 2 shared))
			(func $a (param i32) (result i32) (i32.load (call $b (local.get 0))))
			(func $b (param i32) (result i32)
				(if (result i32) (local.get 0) (then (call $a (i32.const 0))) (else (i32.const 4))))
			(func $self (param i32) (result i32) (i32.add (call $self (local.get 0)) (i32.const 1)))
			(func $leaf (param i32) (result i32) (i32.load (local.get 0))))`)
	);
	assert.deepEqual(route.recursive, ['a', 'b', 'self']);
	assert.deepEqual(route.functions, ['a', 'b', 'self', 'leaf']);
	for (const name of route.functions) assert.ok(Number.isFinite(route.work[name]!.compute));
});

test('a second mutable global refuses the stack route and names the global', () => {
	const route = stackRoute(
		named(`(module (import "env" "memory" (memory 1 2 shared)) ${frame}
			(global $heap (mut i32) (i32.const 0))
			(func $grow (global.set $heap (i32.add (global.get $heap) (i32.const 8)))))`)
	);
	assert.equal(route.eligible, false);
	assert.deepEqual(route.functions, []);
	assert.equal(route.stack, undefined);
	assert.deepEqual(route.diagnostics, [
		'refused global heap: second mutable global (stack candidate sp)'
	]);
});

test('a mutable global that is not an i32 is refused and takes its callers with it', () => {
	const route = stackRoute(
		named(`(module (import "env" "memory" (memory 1 2 shared))
			(global $wide (mut i64) (i64.const 0))
			(func $bump (global.set $wide (i64.add (global.get $wide) (i64.const 1))))
			(func $caller (call $bump))
			(func $leaf (param i32) (result i32) (i32.load (local.get 0))))`)
	);
	assert.deepEqual(route.functions, ['leaf']);
	assert.equal(route.stack, undefined);
	assert.ok(route.eligible);
	assert.ok(route.diagnostics.includes('refused global wide: mutable global is not i32'));
	assert.ok(route.diagnostics.includes('excluded: 1 call outside the set, 1 refused global'));
});

test('immutable globals with a constant initializer are admitted and others are refused', () => {
	const route = stackRoute(
		named(`(module (import "env" "memory" (memory 1 2 shared)) (import "env" "base" (global $base i32))
			(global $limit i32 (i32.const 4096))
			(global $derived i32 (global.get $base))
			(func $a (result i32) (global.get $limit))
			(func $b (result i32) (global.get $base))
			(func $c (result i32) (global.get $derived)))`)
	);
	assert.deepEqual(route.functions, ['a']);
	assert.deepEqual(route.constants, ['limit']);
	assert.ok(route.diagnostics.includes('refused global base: imported global'));
	assert.ok(route.diagnostics.includes('refused global derived: initializer is not a constant'));
});

test('functions with indirect calls, atomics or memory growth stay out of the worker set', () => {
	const route = stackRoute(
		named(`(module (import "env" "memory" (memory 1 2 shared)) (table 1 funcref) (type $t (func))
			(func $indirect (call_indirect (type $t) (i32.const 0)))
			(func $atomic (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1))))
			(func $grow (drop (memory.grow (i32.const 1))))
			(func $user (call $indirect))
			(func $leaf (i32.store (i32.const 0) (i32.const 1))))`)
	);
	assert.deepEqual(route.functions, ['leaf']);
	assert.ok(
		route.diagnostics.includes(
			'excluded: 1 call outside the set, 2 impure expression, 1 unsupported expression'
		)
	);
});

test('a start function leaves the stack route eligible and keeps its module-wide reason', () => {
	const prepared = prepare(
		named(`(module (import "env" "memory" (memory 1 2 shared)) ${frame}
			(func $init (i32.store (i32.const 8) (i32.const 1)))
			(start $init))`),
		{ minimumRegionWork: 0 }
	);
	assert.ok(prepared.reasons.includes('start function'));
	assert.ok(prepared.stackRoute!.eligible);
	assert.deepEqual(prepared.stackRoute!.stack, { name: 'sp', initial: 65536 });
	assert.deepEqual(prepared.stackRoute!.recursive, ['sum']);
});

test('the BLAKE3 consumer is eligible with its stack pointer and one recursive function', () => {
	const bytes = new Uint8Array(
		readFileSync(
			new URL('../../results/corpus/blake3-consumer/blake3-hash-all.wasm', import.meta.url)
		)
	);
	const prepared = prepare(bytes);
	const route = prepared.stackRoute!;
	assert.ok(route.eligible);
	assert.deepEqual(route.stack, { name: '__stack_pointer', initial: 65536 });
	assert.deepEqual(route.recursive, ['blake3_compress_subtree_wide']);
	assert.ok(route.functions.includes('hash_all'));
	assert.ok(route.diagnostics.includes('worker set: 16 of 16 functions, 1 recursive'));
	assert.ok(prepared.reasons.includes('recursive call graph retains original owner stack'));
	assert.equal(prepared.control, undefined);
	assert.ok(prepared.controlReasons!.some((reason) => reason.includes('no region reached')));
});

// #region iteration route
const ownerWat = (
	parts: {
		globals?: string;
		funcs?: string;
		pre?: string;
		body?: string;
		tail?: string;
		post?: string;
	} = {}
) => `(module
	(import "env" "memory" (memory 4 8))
	(type $t (func))
	(table 1 funcref)
	(global $sp (mut i32) (i32.const 65536))
	${parts.globals ?? ''}
	(func $tri (param $n i32) (result i32) (local $f i32) (local $r i32)
		(local.set $f (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $f))
		(i32.store (local.get $f) (local.get $n))
		(local.set $r (if (result i32) (i32.eqz (local.get $n))
			(then (i32.const 0))
			(else (i32.add (i32.load (local.get $f)) (call $tri (i32.sub (local.get $n) (i32.const 1)))))))
		(global.set $sp (i32.add (local.get $f) (i32.const 16)))
		(local.get $r))
	(func $item (param $in i32) (param $out i32) (param $scale i32) (local $s i32)
		(local.set $s (i32.sub (global.get $sp) (i32.const 16)))
		(global.set $sp (local.get $s))
		(i32.store (local.get $s) (call $tri (i32.load (local.get $in))))
		(i32.store offset=4 (local.get $scale) (i32.load (local.get $s)))
		(i32.store (local.get $out) (i32.mul (i32.load offset=4 (local.get $scale)) (i32.load (local.get $scale))))
		(global.set $sp (i32.add (local.get $s) (i32.const 16))))
	${parts.funcs ?? ''}
	(func $run (export "run") (param $in i32) (param $out i32) (param $n i32)
		(local $frame i32) (local $c i32) (local $x i32) (local $q i32)
		(local.set $frame (i32.sub (global.get $sp) (i32.const 64)))
		(global.set $sp (local.get $frame))
		(i32.store (local.get $frame) (i32.const 3))
		${parts.pre ?? ''}
		(block $done
			(br_if $done (i32.eqz (local.get $n)))
			(local.set $c (local.get $n))
			(loop $each
				(call $item (local.get $in) (local.get $out) (local.get $frame))
				${parts.body ?? ''}
				(local.set $in (i32.add (local.get $in) (i32.const 4)))
				(local.set $out (i32.add (local.get $out) (i32.const 4)))
				${parts.tail ?? '(br_if $each (local.tee $c (i32.sub (local.get $c) (i32.const 1))))'}))
		${parts.post ?? ''}
		(global.set $sp (i32.add (local.get $frame) (i32.const 64)))))`;

const routeOf = (wat: string): { bytes: Uint8Array; route: IterationRoute } => {
	const bytes = named(wat);
	return { bytes, route: iterationRoute(bytes, stackRoute(bytes)) };
};

interface Replay {
	initial: number;
	maximum: number;
	setup: (memory: Uint8Array) => void;
	entry: string;
	args: number[];
	arena: { base: number; slot: number };
	/** `private` is the route: own slot and frame image; the others are mutations of it */
	mode?: 'private' | 'owner' | 'no-copy' | 'poison' | 'unrebased';
	order?: 'forward' | 'reverse';
}

// runs the owner natively, then the schedule's iterations on one shared memory, one slot each
function replay(bytes: Uint8Array, route: IterationRoute, options: Replay) {
	assert.ok(route.eligible && route.module && route.iterate && route.stackExport);
	const mode = options.mode ?? 'private';
	const { initial, maximum } = options;
	const native = new WebAssembly.Memory({ initial, maximum });
	const module = new WebAssembly.Module(Uint8Array.from(bytes));
	const instance = new WebAssembly.Instance(module, { env: { memory: native } });
	options.setup(new Uint8Array(native.buffer));
	const image = new Uint8Array(native.buffer).slice();
	const shared = new WebAssembly.Memory({ initial, maximum, shared: true });
	new Uint8Array(shared.buffer).set(image);
	(instance.exports[options.entry] as (...args: number[]) => unknown)(...options.args);
	const expected = new Uint8Array(native.buffer).slice();

	const worker = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(route.module)), {
		env: { memory: shared }
	});
	const iterate = worker.exports[route.iterate] as (...args: number[]) => void;
	const stack = worker.exports[route.stackExport] as WebAssembly.Global;
	const top = stack.value as number;
	const size = route.frame?.size ?? 0;
	const trip = route.trip!;
	const count = trip.parameter !== undefined ? options.args[trip.parameter]! : trip.constant!;
	const view = new Uint8Array(shared.buffer);
	const owner = top - size;
	// the frame image as the owner leaves it at loop entry: its prologue run with a zero trip count
	assert.ok(trip.parameter !== undefined);
	const probe = new WebAssembly.Memory({ initial, maximum });
	new Uint8Array(probe.buffer).set(image);
	const probeArgs = [...options.args];
	probeArgs[trip.parameter] = 0;
	const entry = new WebAssembly.Instance(module, { env: { memory: probe } }).exports[
		options.entry
	];
	(entry as (...args: number[]) => unknown)(...probeArgs);
	const frameImage = new Uint8Array(probe.buffer).slice(owner, top);
	if (mode === 'owner' || mode === 'unrebased') view.set(frameImage, owner);
	const ks = [...Array(count).keys()];
	if (options.order === 'reverse') ks.reverse();
	const taken = route.locals.filter((local) => local.argument !== undefined);
	for (const k of ks) {
		const base =
			mode === 'owner' ? owner : options.arena.base + (k + 1) * options.arena.slot - size;
		stack.value = base;
		if (mode === 'private' || mode === 'unrebased') view.set(frameImage, base);
		if (mode === 'poison') view.fill(0xa5, base, base + size);
		const values: number[] = [];
		for (const local of taken) {
			const start = local.start;
			const from = !start
				? Number.NaN
				: 'parameter' in start
					? options.args[start.parameter]!
					: start.constant;
			values[local.argument!] =
				local.kind === 'frame'
					? mode === 'unrebased'
						? owner
						: base
					: (from + k * (local.stride ?? 0)) | 0;
		}
		iterate(...values);
	}
	const actual = view.slice();
	const arena = [options.arena.base, options.arena.base + count * options.arena.slot] as const;
	return { expected, actual, image, frameImage, owner, top, arena, size };
}

// first byte that differs outside the given [start, end) ranges, or -1
function firstDifference(
	a: Uint8Array,
	b: Uint8Array,
	masks: (readonly [number, number])[]
): number {
	for (let i = 0; i < a.length; i++)
		if (a[i] !== b[i] && !masks.some(([start, end]) => i >= start && i < end)) return i;
	return -1;
}

const touched = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) !== 0;

const watReplay = {
	initial: 4,
	maximum: 8,
	entry: 'run',
	args: [0x14000, 0x15000, 5],
	arena: { base: 0x20000, slot: 0x1000 },
	setup: (memory: Uint8Array) => {
		const view = new DataView(memory.buffer);
		for (let i = 0; i < 5; i++) view.setUint32(0x14000 + 4 * i, (i + 1) * 3, true);
	}
} satisfies Replay;

test('the iteration route outlines a counted loop of calls and rebases its frame', () => {
	const { bytes, route } = routeOf(ownerWat());
	assert.ok(route.eligible, route.diagnostics.join('; '));
	assert.equal(route.owner, 'run');
	assert.ok(route.loop);
	assert.deepEqual(route.trip, { local: 4, parameter: 2 });
	assert.deepEqual(route.frame, { global: 'sp', size: 64, local: 3, copy: true });
	assert.deepEqual(route.locals, [
		{ local: 0, kind: 'stride', start: { parameter: 0 }, stride: 4, argument: 0 },
		{ local: 1, kind: 'stride', start: { parameter: 1 }, stride: 4, argument: 1 },
		{ local: 4, kind: 'induction', start: { parameter: 2 }, stride: -1 },
		{ local: 3, kind: 'frame', argument: 2 }
	]);
	assert.equal(route.stackExport, '__folio_stack');
	assert.ok(WebAssembly.validate(Uint8Array.from(route.module!)));
	const imports = WebAssembly.Module.imports(
		new WebAssembly.Module(Uint8Array.from(route.module!))
	);
	assert.deepEqual(imports, [{ module: 'env', name: 'memory', kind: 'memory' }]);
	const exports = WebAssembly.Module.exports(
		new WebAssembly.Module(Uint8Array.from(route.module!))
	);
	assert.deepEqual(exports.map((item) => item.name).sort(), ['__folio_iterate', '__folio_stack']);

	const run = replay(bytes, route, watReplay);
	assert.equal(firstDifference(run.expected, run.actual, [[0, run.top], run.arena]), -1);
	const out = new Uint32Array(run.actual.buffer, 0x15000, 5);
	assert.deepEqual([...out], [18, 63, 135, 234, 360]);
	assert.ok(touched(run.actual.subarray(...run.arena), run.image.subarray(...run.arena)));
	assert.equal(
		touched(run.actual.subarray(run.owner, run.top), run.image.subarray(run.owner, run.top)),
		false
	);
});

test('the frame image is needed when the body reads what the prologue wrote', () => {
	const { bytes, route } = routeOf(ownerWat());
	const skipped = replay(bytes, route, { ...watReplay, mode: 'no-copy' });
	assert.notEqual(
		firstDifference(skipped.expected, skipped.actual, [[0, skipped.top], skipped.arena]),
		-1
	);
	const poisoned = replay(bytes, route, { ...watReplay, mode: 'poison' });
	assert.notEqual(
		firstDifference(poisoned.expected, poisoned.actual, [[0, poisoned.top], poisoned.arena]),
		-1
	);
});

test('a frame base that is not rebased passes serially and writes the owner frame', () => {
	const { bytes, route } = routeOf(ownerWat());
	const run = replay(bytes, route, { ...watReplay, mode: 'unrebased' });
	assert.equal(firstDifference(run.expected, run.actual, [[0, run.top], run.arena]), -1);
	assert.ok(touched(run.actual.subarray(run.owner, run.top), run.frameImage));
});

test('running every iteration on the owner frame passes serially and leaves the frame written', () => {
	const { bytes, route } = routeOf(ownerWat());
	for (const order of ['forward', 'reverse'] as const) {
		const shared = replay(bytes, route, { ...watReplay, mode: 'owner', order });
		assert.equal(firstDifference(shared.expected, shared.actual, [[0, shared.top]]), -1);
		const written = touched(
			shared.actual.subarray(shared.owner, shared.top),
			shared.frameImage
		);
		assert.ok(written);
	}
});

const refusal = (parts: Parameters<typeof ownerWat>[0], reason: string) => {
	const { route } = routeOf(ownerWat(parts));
	assert.equal(route.eligible, false);
	assert.equal(route.module, undefined);
	assert.ok(
		route.diagnostics.some((line) => line.includes(reason)),
		route.diagnostics.join('; ')
	);
};

test('a carried local that is not a constant stride is refused', () => {
	refusal(
		{ body: '(local.set $in (i32.load (local.get $in)))' },
		'carried local is not a constant stride'
	);
});

test('a branch that leaves the loop body is refused', () => {
	refusal({ body: '(br_if $done (i32.load (local.get $in)))' }, 'branch escapes the body');
});

test('a frame address stored to memory is refused', () => {
	refusal(
		{ body: '(i32.store (local.get $in) (local.get $frame))' },
		'frame address stored to memory'
	);
});

test('a frame address passed to a function outside the worker set is refused', () => {
	refusal(
		{
			funcs: '(func $outside (param i32) (drop (memory.grow (i32.const 0))))',
			body: '(call $outside (local.get $frame))'
		},
		'frame address passed outside the worker set'
	);
});

test('a frame object read after the loop is refused', () => {
	refusal(
		{ post: '(i32.store (local.get $out) (i32.load (local.get $frame)))' },
		'frame object read after the loop'
	);
});

test('a frame address held in a local the body reads is refused', () => {
	refusal(
		{
			pre: '(local.set $q (i32.add (local.get $frame) (i32.const 8)))',
			body: '(call $item (local.get $in) (local.get $out) (local.get $q))'
		},
		'frame address held in a local the body reads'
	);
});

test('a second mutable global refuses the iteration route with the stack route reason', () => {
	refusal(
		{
			globals: '(global $heap (mut i32) (i32.const 0))',
			funcs: '(func $bump (global.set $heap (i32.add (global.get $heap) (i32.const 1))))'
		},
		'second mutable global'
	);
});

test('an indirect call in the body is refused', () => {
	refusal({ body: '(call_indirect (type $t) (i32.const 0))' }, 'indirect call');
});

test('a trip count that is not a countdown is refused', () => {
	refusal(
		{ tail: '(br_if $each (i32.load (local.get $in)))' },
		'trip count is not computable before the loop starts'
	);
});

test('a loop body that writes a local the code after the loop reads is refused', () => {
	refusal(
		{
			body: '(local.set $x (i32.load (local.get $in)))',
			post: '(i32.store (local.get $out) (local.get $x))'
		},
		'loop body writes a local the code after the loop reads'
	);
});

test('an owner with a second loop is refused', () => {
	refusal({ pre: '(loop $again (br_if $again (i32.const 0)))' }, '2 loops, one required');
});

test('a trip count read from memory is computed at the loop entry and has no owner parameter', () => {
	const { route } = routeOf(
		ownerWat({ pre: '(local.set $n (i32.load (i32.const 1024)))' }).replace(
			'(local.set $c (local.get $n))',
			'(local.set $c (i32.load (i32.const 1024)))'
		)
	);
	assert.ok(route.eligible, route.diagnostics.join('; '));
	assert.deepEqual(route.trip, { local: 4 });
});

test('the BLAKE3 consumer loop is outlined and replays to the native result on private frames', () => {
	const bytes = new Uint8Array(
		readFileSync(
			new URL('../../results/corpus/blake3-consumer/blake3-hash-all.wasm', import.meta.url)
		)
	);
	const route = iterationRoute(bytes, stackRoute(bytes));
	assert.ok(route.eligible, route.diagnostics.join('; '));
	assert.equal(route.owner, 'hash_all');
	assert.deepEqual(route.trip, { local: 4, parameter: 1 });
	assert.deepEqual(route.frame, { global: '__stack_pointer', size: 1920, local: 3, copy: true });
	assert.deepEqual(
		route.locals.map(({ local, kind, stride, start }) => ({ local, kind, stride, start })),
		[
			{ local: 0, kind: 'stride', stride: 8, start: { parameter: 0 } },
			{ local: 2, kind: 'stride', stride: 32, start: { parameter: 2 } },
			{ local: 4, kind: 'induction', stride: -1, start: { parameter: 1 } },
			{ local: 3, kind: 'frame', stride: undefined, start: undefined }
		]
	);
	const lengths = [0, 64, 1024, 1025, 4100];
	const table = 0x11000;
	const out = 0x12000;
	const options = {
		initial: 16,
		maximum: 65536,
		entry: 'hash_all',
		args: [table, lengths.length, out],
		arena: { base: 0x80000, slot: 0x8000 },
		setup: (memory: Uint8Array) => {
			const view = new DataView(memory.buffer);
			let at = 0x20000;
			for (const [i, length] of lengths.entries()) {
				view.setUint32(table + 8 * i, at, true);
				view.setUint32(table + 8 * i + 4, length, true);
				for (let j = 0; j < length; j++) memory[at + j] = (j * 31 + i * 7 + 5) & 255;
				at += length;
			}
		}
	} satisfies Replay;
	const run = replay(bytes, route, options);
	assert.equal(firstDifference(run.expected, run.actual, [[0, run.top], run.arena]), -1);
	assert.equal(
		Buffer.from(run.actual.subarray(out, out + 32)).toString('hex'),
		'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
	);
	assert.ok(run.actual.subarray(out + 32, out + 32 * 5).some((byte) => byte !== 0));
	assert.ok(touched(run.actual.subarray(...run.arena), run.image.subarray(...run.arena)));
	assert.equal(
		touched(run.actual.subarray(run.owner, run.top), run.image.subarray(run.owner, run.top)),
		false
	);

	// the hasher is written before it is read, so a poisoned frame image changes nothing
	const poisoned = replay(bytes, route, { ...options, mode: 'poison' });
	assert.equal(
		firstDifference(poisoned.expected, poisoned.actual, [[0, poisoned.top], poisoned.arena]),
		-1
	);

	// rebase skipped: the owner's frame is written, and a serial run cannot tell either order apart
	const unrebased = replay(bytes, route, { ...options, mode: 'unrebased' });
	assert.equal(
		firstDifference(unrebased.expected, unrebased.actual, [
			[0, unrebased.top],
			unrebased.arena
		]),
		-1
	);
	assert.ok(
		touched(unrebased.actual.subarray(unrebased.owner, unrebased.top), unrebased.frameImage)
	);
	for (const order of ['forward', 'reverse'] as const) {
		const shared = replay(bytes, route, { ...options, mode: 'owner', order });
		assert.equal(firstDifference(shared.expected, shared.actual, [[0, shared.top]]), -1);
		assert.ok(touched(shared.actual.subarray(shared.owner, shared.top), shared.frameImage));
	}
});

test('prepare carries the iteration route and leaves the plan fields alone', () => {
	const bytes = named(`(module (import "env" "memory" (memory 1 2 shared)) ${frame})`);
	const prepared = prepare(bytes, { minimumRegionWork: 0 });
	assert.equal(prepared.iterationRoute!.eligible, false);
	assert.ok(prepared.iterationRoute!.diagnostics.includes('no loop calls into the worker set'));
	assert.equal(prepare(bytes, { parallel: 'off' }).iterationRoute, undefined);
	assert.equal(prepare(named(ownerWat()), { minimumRegionWork: 0 }).iterationRoute!.owner, 'run');
});
// #endregion

// #region inline tracking lowering
const ARENA = { rb: 0x10000, wb: 0x10400, lp: 0x11000, sa: 0x12000 };
const sharedModule = (body: string) =>
	`(module (import "env" "memory" (memory 4 4 shared)) ${body})`;
const granulesOf = (address: number, length: number, granule: number) =>
	length
		? Array.from(
				{
					length:
						Math.floor((address + length - 1) / granule) -
						Math.floor(address / granule) +
						1
				},
				(_, k) => Math.floor(address / granule) + k
			)
		: [];

function inlineRig(wat: string | Uint8Array, options: InlineOptions = {}) {
	const source = typeof wat === 'string' ? compile(wat) : wat;
	const entry = inlineEntryBytes(options.writeGranule);
	const make = (bytes: Uint8Array) => {
		const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
		const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
			env: { memory }
		});
		const u8 = new Uint8Array(memory.buffer);
		for (let at = 0x1000; at < 0x4000; at++) u8[at] = (at * 31 + 7) & 255;
		return { exports: instance.exports as Record<string, any>, u8 };
	};
	const native = make(source);
	const lowered = make(lowerInline(source, options));
	const x = lowered.exports;
	const bits = (base: number) => {
		const out: number[] = [];
		for (let i = 0; i < 1024; i++)
			for (let b = 0; b < 8; b++) if ((lowered.u8[base + i]! >> b) & 1) out.push(i * 8 + b);
		return out;
	};
	const rig = {
		native,
		lowered,
		reset(capacity = 64) {
			lowered.u8.fill(0, ARENA.rb, ARENA.sa + 64);
			x.__folio_rb.value = ARENA.rb;
			x.__folio_wb.value = ARENA.wb;
			x.__folio_lp.value = ARENA.lp;
			x.__folio_ll.value = ARENA.lp + capacity * entry;
			x.__folio_sa.value = ARENA.sa;
		},
		reads: () => bits(ARENA.rb),
		writes: () => bits(ARENA.wb),
		used: () => (x.__folio_lp.value - ARENA.lp) / entry,
		stamps: () => new Uint32Array(lowered.u8.buffer.slice(ARENA.sa, ARENA.sa + 4))[0]!,
		log: () =>
			Array.from({ length: rig.used() }, (_, i) => {
				const at = ARENA.lp + i * entry;
				const words = new Uint32Array(lowered.u8.buffer.slice(at, at + 8));
				return {
					address: words[0]!,
					stamp: words[1]!,
					prior: Uint8Array.from(lowered.u8.subarray(at + 8, at + entry))
				};
			}),
		same: () =>
			Buffer.from(native.u8.subarray(0x1000, 0x4000)).equals(
				Buffer.from(lowered.u8.subarray(0x1000, 0x4000))
			),
		// runs one export on the native and the lowered instance and returns the lowered footprint
		run(name: string, ...args: any[]) {
			rig.reset();
			const want = native.exports[name]!(...args);
			assert.deepEqual(x[name]!(...args), want, `${name} result`);
			assert.ok(rig.same(), `${name} memory`);
			return { reads: rig.reads(), writes: rig.writes(), used: rig.used() };
		}
	};
	return rig;
}

const accessKinds = {
	loads: [
		...['i32.load', 'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u'].map((op) => [
			op,
			'i32'
		]),
		...['i64.load', 'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u'].map((op) => [
			op,
			'i64'
		]),
		...['i64.load32_s', 'i64.load32_u'].map((op) => [op, 'i64']),
		['f32.load', 'f32'],
		['f64.load', 'f64']
	],
	stores: [
		['i32.store', '(i32.const 0x11223344)'],
		['i32.store8', '(i32.const 0x55)'],
		['i32.store16', '(i32.const 0x6677)'],
		['i64.store', '(i64.const 0x1122334455667788)'],
		['i64.store8', '(i64.const 0x99)'],
		['i64.store16', '(i64.const 0xaabb)'],
		['i64.store32', '(i64.const 0xccddeeff)'],
		['f32.store', '(f32.const 1.5)'],
		['f64.store', '(f64.const -2.25)']
	]
};
const v128 = '(v128.const i32x4 0x01020304 0x05060708 0x090a0b0c 0x0d0e0f10)';
const simdLoads = [
	'v128.load',
	'v128.load8_splat',
	'v128.load16_splat',
	'v128.load32_splat',
	'v128.load64_splat',
	'v128.load8x8_s',
	'v128.load8x8_u',
	'v128.load16x4_s',
	'v128.load16x4_u',
	'v128.load32x2_s',
	'v128.load32x2_u',
	'v128.load32_zero',
	'v128.load64_zero'
];

test('inline marks cover every plain load, store and SIMD access and change nothing else', () => {
	const functions = [
		...accessKinds.loads.map(
			([op, type]) =>
				`(func (export "${op}") (param i32) (result ${type}) (${op} (local.get 0)))`
		),
		...simdLoads.map(
			(op) =>
				`(func (export "${op}") (param i32) (result i64) (i64x2.extract_lane 0 (${op} (local.get 0))))`
		),
		...['load8_lane', 'load16_lane', 'load32_lane', 'load64_lane'].map(
			(op) =>
				`(func (export "v128.${op}") (param i32) (result i64) (i64x2.extract_lane 0 (v128.${op} 0 (local.get 0) ${v128})))`
		),
		...accessKinds.stores.map(
			([op, value]) => `(func (export "${op}") (param i32) (${op} (local.get 0) ${value}))`
		),
		`(func (export "v128.store") (param i32) (v128.store (local.get 0) ${v128}))`,
		...['store8_lane', 'store16_lane', 'store32_lane', 'store64_lane'].map(
			(op) => `(func (export "v128.${op}") (param i32) (v128.${op} 0 (local.get 0) ${v128}))`
		),
		`(func (export "offset") (param i32) (result i32) (i32.load offset=24 (local.get 0)))`
	];
	const rig = inlineRig(sharedModule(functions.join('\n')));
	let checked = 0;
	for (const name of Object.keys(rig.native.exports)) {
		const store = /store/.test(name) && !/load/.test(name);
		const { reads, writes, used } = rig.run(name, 0x2008);
		if (name === 'offset') continue;
		assert.deepEqual(reads, store ? [] : [128], `${name} reads`);
		assert.deepEqual(writes, store ? [256] : [], `${name} writes`);
		assert.equal(used, store ? 1 : 0, `${name} undo entries`);
		checked++;
	}
	assert.equal(checked, Object.keys(rig.native.exports).length - 1);
	// the offset immediate is part of the address the marks see
	assert.deepEqual(rig.run('offset', 0x1ff0), { reads: [128], writes: [], used: 0 });
	assert.deepEqual(rig.run('offset', 0x1fe0), { reads: [127], writes: [], used: 0 });
});

test('inline marks treat every atomic access as a read and a write', () => {
	const rmw = (type: string, width: string, op: string, suffix = '') =>
		`(func (export "${type}.atomic.rmw${width}.${op}${suffix}") (param i32) (result ${type}) (${type}.atomic.rmw${width}.${op}${suffix} (local.get 0) (${type}.const 3)))`;
	const cas = (type: string, width: string, suffix = '') =>
		`(func (export "${type}.atomic.rmw${width}.cmpxchg${suffix}") (param i32) (result ${type}) (${type}.atomic.rmw${width}.cmpxchg${suffix} (local.get 0) (${type}.const 1) (${type}.const 2)))`;
	const functions = [
		...['i32.atomic.load', 'i32.atomic.load8_u', 'i32.atomic.load16_u'].map(
			(op) => `(func (export "${op}") (param i32) (result i32) (${op} (local.get 0)))`
		),
		...[
			'i64.atomic.load',
			'i64.atomic.load8_u',
			'i64.atomic.load16_u',
			'i64.atomic.load32_u'
		].map((op) => `(func (export "${op}") (param i32) (result i64) (${op} (local.get 0)))`),
		...['i32.atomic.store', 'i32.atomic.store8', 'i32.atomic.store16'].map(
			(op) => `(func (export "${op}") (param i32) (${op} (local.get 0) (i32.const 9)))`
		),
		...[
			'i64.atomic.store',
			'i64.atomic.store8',
			'i64.atomic.store16',
			'i64.atomic.store32'
		].map((op) => `(func (export "${op}") (param i32) (${op} (local.get 0) (i64.const 9)))`),
		...['add', 'sub', 'and', 'or', 'xor', 'xchg'].map((op) => rmw('i32', '', op)),
		rmw('i32', '8', 'add', '_u'),
		rmw('i32', '16', 'xor', '_u'),
		...['', '8', '16', '32'].map((width) => rmw('i64', width, 'add', width ? '_u' : '')),
		cas('i32', ''),
		cas('i32', '8', '_u'),
		cas('i32', '16', '_u'),
		...['', '8', '16', '32'].map((width) => cas('i64', width, width ? '_u' : '')),
		'(func (export "notify") (param i32) (result i32) (memory.atomic.notify (local.get 0) (i32.const 1)))',
		'(func (export "wait32") (param i32) (result i32) (memory.atomic.wait32 (local.get 0) (i32.const 1) (i64.const 0)))',
		'(func (export "wait64") (param i32) (result i32) (memory.atomic.wait64 (local.get 0) (i64.const 1) (i64.const 0)))'
	];
	const rig = inlineRig(sharedModule(functions.join('\n')));
	for (const name of Object.keys(rig.native.exports)) {
		const { reads, writes, used } = rig.run(name, 0x2008);
		assert.deepEqual(reads, [128], `${name} reads`);
		assert.deepEqual(writes, [256], `${name} writes`);
		assert.equal(used, 1, `${name} undo entries`);
	}
	assert.equal(Object.keys(rig.native.exports).length, 7 + 7 + 6 + 2 + 4 + 3 + 4 + 3);
});

test('an access that crosses a granule marks both and one that ends on the boundary marks one', () => {
	const functions = [
		'(func (export "load32") (param i32) (result i32) (i32.load (local.get 0)))',
		'(func (export "load64") (param i32) (result i64) (i64.load (local.get 0)))',
		'(func (export "load128") (param i32) (result i64) (i64x2.extract_lane 0 (v128.load (local.get 0))))',
		'(func (export "store16") (param i32) (i32.store16 (local.get 0) (i32.const 1)))',
		'(func (export "store32") (param i32) (i32.store (local.get 0) (i32.const 1)))',
		'(func (export "store64") (param i32) (i64.store (local.get 0) (i64.const 1)))',
		`(func (export "store128") (param i32) (v128.store (local.get 0) ${v128}))`,
		'(func (export "store32_offset") (param i32) (i32.store offset=2 (local.get 0) (i32.const 1)))',
		`(func (export "lane") (param i32) (v128.store32_lane 0 (local.get 0) ${v128}))`
	];
	const rig = inlineRig(sharedModule(functions.join('\n')));
	// [export, address, width]; the read granule is 64 bytes, the write granule 32
	const cases: [string, number, number][] = [
		['load32', 0x203e, 4],
		['load32', 0x203c, 4],
		['load64', 0x2039, 8],
		['load64', 0x2038, 8],
		['load128', 0x2038, 16],
		['load128', 0x2030, 16],
		['store16', 0x201f, 2],
		['store16', 0x201e, 2],
		['store32', 0x201e, 4],
		['store32', 0x201c, 4],
		['store64', 0x2019, 8],
		['store64', 0x2018, 8],
		['store128', 0x2038, 16],
		['store128', 0x2030, 16],
		['store32_offset', 0x201c, 4],
		['store32_offset', 0x201a, 4],
		['lane', 0x201e, 4],
		['lane', 0x201c, 4]
	];
	for (const [name, address, width] of cases) {
		const store = name.startsWith('store') || name === 'lane';
		const effective = address + (name === 'store32_offset' ? 2 : 0);
		const { reads, writes, used } = rig.run(name, address);
		assert.deepEqual(
			reads,
			store ? [] : granulesOf(effective, width, 64),
			`${name} ${address} reads`
		);
		assert.deepEqual(
			writes,
			store ? granulesOf(effective, width, 32) : [],
			`${name} ${address} writes`
		);
		assert.equal(used, store ? writes.length : 0);
	}
	// a boundary between 64-byte granules is also one between 32-byte granules
	assert.deepEqual(rig.run('store32', 0x203e).writes, [257, 258]);
});

test('memory.copy, memory.fill and memory.init mark the granules of their ranges and nothing for zero length', () => {
	const functions = [
		'(data $d "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")',
		'(func (export "fill") (param i32 i32) (memory.fill (local.get 0) (i32.const 171) (local.get 1)))',
		'(func (export "copy") (param i32 i32 i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)))',
		'(func (export "init") (param i32 i32) (memory.init $d (local.get 0) (i32.const 3) (local.get 1)))',
		// the pointer operands run before the size, so a side effect in one of them must not move the range
		`(func (export "nested") (param i32 i32 i32)
			(memory.copy (local.get 0)
				(block (result i32) (memory.fill (i32.const 0x3f00) (i32.const 1) (i32.const 8)) (local.get 1))
				(local.get 2)))`
	];
	const rig = inlineRig(sharedModule(functions.join('\n')));
	const span = (address: number, length: number, granule: number) =>
		granulesOf(address, length, granule);
	// begins and ends in the middle of a granule
	assert.deepEqual(rig.run('fill', 0x2014, 50), {
		reads: [],
		writes: span(0x2014, 50, 32),
		used: 3
	});
	assert.deepEqual(rig.run('fill', 0x2014, 0), { reads: [], writes: [], used: 0 });
	assert.deepEqual(rig.run('fill', 0x2000, 32), { reads: [], writes: [256], used: 1 });
	assert.deepEqual(rig.run('fill', 0x2000, 33), { reads: [], writes: [256, 257], used: 2 });
	assert.deepEqual(rig.run('copy', 0x3014, 0x2030, 100), {
		reads: span(0x2030, 100, 64),
		writes: span(0x3014, 100, 32),
		used: 4
	});
	assert.deepEqual(rig.run('copy', 0x3014, 0x2030, 0), { reads: [], writes: [], used: 0 });
	// overlapping ranges, forward and backward, give the same marks as the plain ones
	assert.deepEqual(rig.run('copy', 0x2010, 0x2030, 40), {
		reads: span(0x2030, 40, 64),
		writes: span(0x2010, 40, 32),
		used: 2
	});
	assert.deepEqual(rig.run('copy', 0x2030, 0x2010, 40), {
		reads: span(0x2010, 40, 64),
		writes: span(0x2030, 40, 32),
		used: 2
	});
	assert.deepEqual(rig.run('init', 0x2014, 40), {
		reads: [],
		writes: span(0x2014, 40, 32),
		used: 2
	});
	assert.deepEqual(rig.run('init', 0x2014, 0), { reads: [], writes: [], used: 0 });
	const nested = rig.run('nested', 0x3014, 0x2030, 100);
	assert.deepEqual(nested.reads, span(0x2030, 100, 64));
	assert.deepEqual(
		nested.writes,
		[...span(0x3014, 100, 32), ...span(0x3f00, 8, 32)].sort((a, b) => a - b)
	);
});

test('the first write to a granule logs its prior bytes and a stamp and rolling back restores memory', () => {
	const functions = [
		'(func (export "store32") (param i32 i32) (i32.store (local.get 0) (local.get 1)))',
		'(func (export "store64") (param i32) (i64.store (local.get 0) (i64.const -1)))',
		'(func (export "fill") (param i32 i32) (memory.fill (local.get 0) (i32.const 0) (local.get 1)))'
	];
	const rig = inlineRig(sharedModule(functions.join('\n')));
	rig.reset();
	const before = Uint8Array.from(rig.lowered.u8.subarray(0x2000, 0x2200));
	const x = rig.lowered.exports;
	x.store32(0x2004, 7);
	assert.equal(rig.used(), 1);
	const [first] = rig.log();
	assert.equal(first!.address, 0x2000);
	assert.equal(first!.stamp, 0);
	assert.deepEqual(first!.prior, before.subarray(0, 32));
	// the same granule again appends nothing, even through another width
	x.store32(0x2008, 9);
	x.store64(0x2010);
	assert.equal(rig.used(), 1);
	x.store64(0x2040);
	x.fill(0x2078, 40);
	assert.deepEqual(
		rig.log().map((entry) => [entry.address, entry.stamp]),
		[
			[0x2000, 0],
			[0x2040, 1],
			[0x2060, 2],
			[0x2080, 3]
		]
	);
	assert.equal(rig.stamps(), 4);
	assert.ok(!Buffer.from(rig.lowered.u8.subarray(0x2000, 0x2200)).equals(Buffer.from(before)));
	// restore newest stamp first, as the validator will
	for (const entry of rig.log().sort((a, b) => b.stamp - a.stamp))
		rig.lowered.u8.set(entry.prior, entry.address);
	assert.deepEqual(Uint8Array.from(rig.lowered.u8.subarray(0x2000, 0x2200)), before);
});

test('a log that cannot hold the next entry traps and leaves the entries it has', () => {
	const rig = inlineRig(
		sharedModule('(func (export "store") (param i32) (i32.store (local.get 0) (i32.const 1)))')
	);
	const x = rig.lowered.exports;
	rig.reset(2);
	x.store(0x2000);
	x.store(0x2040);
	assert.throws(() => x.store(0x2080), WebAssembly.RuntimeError);
	assert.equal(rig.used(), 2);
	assert.deepEqual(
		rig.log().map((entry) => entry.address),
		[0x2000, 0x2040]
	);
	// a limit that is not a whole number of entries still holds only the whole ones
	rig.reset(2);
	x.__folio_ll.value += inlineEntryBytes() - 1;
	x.store(0x2000);
	x.store(0x2040);
	assert.throws(() => x.store(0x2080), WebAssembly.RuntimeError);
	assert.equal(rig.used(), 2);
	// the same granule needs no entry, so a full log still takes it
	x.store(0x2044);
});
test('the stack pointer is exported as __folio_sp and the options change the granules', () => {
	const rig = inlineRig(sharedModule(frame));
	const x = rig.lowered.exports;
	assert.equal(x.__folio_sp.value, 65536);
	x.__folio_sp.value = 0x8000;
	// three frames of 16 bytes: two share one write granule, all share one read granule
	assert.deepEqual(rig.run('sum', 2), { reads: [511], writes: [1022, 1023], used: 2 });
	assert.equal(x.__folio_sp.value, 0x8000);
	const store = '(func (export "store") (param i32) (i32.store (local.get 0) (i32.const 1)))';
	const load = '(func (export "load") (param i32) (result i32) (i32.load (local.get 0)))';
	const wide = inlineRig(sharedModule(store + load), { readGranule: 128, writeGranule: 64 });
	assert.deepEqual(wide.run('load', 0x207e), { reads: [64, 65], writes: [], used: 0 });
	assert.deepEqual(wide.run('store', 0x203e), { reads: [], writes: [128, 129], used: 2 });
	assert.equal(inlineEntryBytes(64), 72);
	const fine = inlineRig(sharedModule(store + load), { readGranule: 16, writeGranule: 16 });
	assert.deepEqual(fine.run('load', 0x200e), { reads: [0x200, 0x201], writes: [], used: 0 });
	assert.deepEqual(fine.run('store', 0x2010), { reads: [], writes: [0x201], used: 1 });
	for (const [readGranule, writeGranule] of [
		[8, 32],
		[64, 8],
		[48, 32],
		[64, 512],
		[8192, 32]
	])
		assert.throws(
			() => lowerInline(compile(sharedModule(store)), { readGranule, writeGranule }),
			RangeError
		);
});

test('a start function that stores runs unlowered and the exports are lowered', () => {
	const bytes = lowerInline(
		compile(
			sharedModule(`(func $init (i32.store (i32.const 0x2000) (i32.const 77)))
			(start $init)
			(func (export "read") (param i32) (result i32) (i32.load (local.get 0)))`)
		)
	);
	const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
	const x = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory }
	}).exports as Record<string, any>;
	const u8 = new Uint8Array(memory.buffer);
	assert.equal(u8[0x2000], 77);
	assert.ok(u8.every((byte, at) => at === 0x2000 || byte === 0));
	x.__folio_rb.value = ARENA.rb;
	assert.equal(x.read(0x2000), 77);
	assert.equal(u8[ARENA.rb + 16], 1);
});

test('the inline lowering works on an unshared memory only when asked', () => {
	const bytes = compile(`(module (import "env" "memory" (memory 4 4))
		(func (export "store") (param i32) (i32.store (local.get 0) (i32.const 1))))`);
	assert.throws(() => lowerInline(bytes), /shared memory required/);
	const memory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
	const { exports } = new WebAssembly.Instance(
		new WebAssembly.Module(Uint8Array.from(lowerInline(bytes, { requireShared: false }))),
		{ env: { memory } }
	);
	const x = exports as Record<string, any>;
	x.__folio_rb.value = ARENA.rb;
	x.__folio_wb.value = ARENA.wb;
	x.__folio_lp.value = ARENA.lp;
	x.__folio_ll.value = ARENA.lp + 400;
	x.__folio_sa.value = ARENA.sa;
	x.store(0x2000);
	assert.equal(x.__folio_lp.value, ARENA.lp + inlineEntryBytes());
	assert.equal(new Uint8Array(memory.buffer)[ARENA.wb + 32], 1);
});

test('the inline lowering refuses modules it cannot lower soundly', () => {
	const refuse = (wat: string, message: RegExp, options?: InlineOptions) =>
		assert.throws(() => lowerInline(compile(wat), options), message);
	refuse('(module (func (export "f")))', /exactly one memory/);
	refuse('(module (memory $a 1 1 shared) (memory $b 1 1 shared))', /exactly one memory/);
	refuse('(module (memory i64 1 1 shared))', /memory64/);
	refuse('(module (memory 1 1))', /shared memory required/);
	refuse(
		'(module (memory 1 1 shared) (global $x (export "__folio_rb") (mut i32) (i32.const 0)))',
		/reserved/
	);
	refuse(
		'(module (memory 1 1 shared) (func $f) (func $s (call $f)) (start $s))',
		/start function calls/
	);
	refuse(
		'(module (memory 1 1 shared) (table $t 1 funcref) (func (drop (table.get $t (i32.const 0)))))',
		/unsupported expression/
	);
	refuse(
		'(module (memory 1 1 shared) (global $g (mut i32) (i32.const 0)))',
		/not a defined mutable i32/,
		{ stack: 'missing' }
	);
});
test('inline lowering equals native on the fixtures and its marks cover the host-call footprint', () => {
	let calls = 0,
		compared = 0;
	for (const subject of fixtureSubjects()) {
		for (const report of compareInline(subject)) {
			const label = `${report.subject} ${report.call}`;
			assert.ok(report.equal, label);
			assert.equal(report.changedUnmarked, 0, label);
			assert.equal(report.oracle!.readsMissed + report.oracle!.writesMissed, 0, label);
			// the tracer is binaryen's own pass and does not see the atomic add
			if (!report.call.startsWith('add('))
				assert.ok(report.oracle!.reads + report.oracle!.writes > 0, label);
			else assert.ok(report.readGranules === 1 && report.writeGranules === 1, label);
			assert.equal(report.undoEntries, report.writeGranules, label);
			if (report.hostCall) {
				// the independent tracer sees everything the host-call tracker does
				assert.deepEqual(
					report.hostCall,
					{ ...report.hostCall, ...{ readsMissed: 0, writesMissed: 0, tracerMissed: 0 } },
					label
				);
				compared++;
			}
			calls++;
		}
	}
	assert.equal(calls, 13);
	assert.equal(compared, 10);
});

test('the BLAKE3 consumer lowered inline hashes to the native digests and marks memory', () => {
	const [report] = compareInline(
		blake3Subject([0, 1, 63, 64, 1023, 1024, 1025, 2048, 4097, 8192])
	);
	assert.ok(report!.equal);
	assert.ok(report!.readGranules > 100 && report!.writeGranules > 10);
	assert.equal(report!.undoEntries, report!.writeGranules);
	assert.equal(report!.changedUnmarked, 0);
	assert.deepEqual([report!.oracle!.readsMissed, report!.oracle!.writesMissed], [0, 0]);
});
// #endregion
