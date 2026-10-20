import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'vitest';
import { memoryImports } from '../../src/memory.ts';
import { Folio, suspending } from '../../src/node.ts';

function wasm(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

test('bytes, ArrayBuffer and compiled modules keep native initialization and owned state', async () => {
	const bytes = wasm(`(module
		(import "host" "start" (func $start)) (start $start)
		(memory (export "memory") 1 2) (data (i32.const 8) "folio")
		(global $value (mut i32) (i32.const 3))
		(func (export "step") (result i32) (global.set $value (i32.add (global.get $value) (i32.const 1))) (global.get $value))
		(func (export "grow") (result i32) (memory.grow (i32.const 1))))`);
	for (const input of [
		bytes,
		Uint8Array.from(bytes).buffer,
		new WebAssembly.Module(Uint8Array.from(bytes))
	]) {
		let starts = 0;
		const folio = await Folio.open(input, {
			imports: {
				host: {
					start: () => {
						starts++;
					}
				}
			}
		});
		try {
			assert.equal(starts, 1);
			assert.equal(
				new TextDecoder().decode(new Uint8Array(folio.memory.buffer, 8, 5)),
				'folio'
			);
			assert.deepEqual(
				(
					await folio.runAll([
						{ export: 'step', args: [] },
						{ export: 'step', args: [] }
					])
				).values,
				[4, 5]
			);
			assert.equal((await folio.run('grow')).values[0], 1);
			assert.equal(folio.memory.buffer.byteLength, 131072);
			assert.equal(folio.memories['exports.memory'], folio.memory);
		} finally {
			await folio.close();
		}
	}
});

test('imported ordinary memory is allocated from its original limits', async () => {
	const bytes = wasm(
		'(module (import "heap" "arena" (memory 2 3)) (func (export "put") (i32.store (i32.const 12) (i32.const 71))))'
	);
	assert.deepEqual(memoryImports(bytes), [
		{ module: 'heap', name: 'arena', initial: 2, maximum: 3, shared: false, memory64: false }
	]);
	const folio = await Folio.open(bytes);
	try {
		assert.equal(folio.memory.buffer.byteLength, 131072);
		assert.equal(folio.memory.buffer instanceof SharedArrayBuffer, false);
		await folio.run('put');
		assert.equal(new Uint32Array(folio.memory.buffer)[3], 71);
	} finally {
		await folio.close();
	}
	await assert.rejects(
		Folio.open(new WebAssembly.Module(Uint8Array.from(bytes))),
		/provide imported memory heap.arena/
	);
});

test('native externref results preserve identity including Promise objects', async () => {
	const bytes = wasm(
		'(module (func (export "echo") (param externref) (result externref) (local.get 0)))'
	);
	const folio = await Folio.open(bytes);
	try {
		const object = { original: true };
		const promise = Promise.resolve(19);
		const report = await folio.runAll([
			{ export: 'echo', args: [object] },
			{ export: 'echo', args: [promise] }
		]);
		assert.equal(report.values[0], object);
		assert.equal(report.values[1], promise);
		assert.equal(report.reason, 'opaque-input');
	} finally {
		await folio.close();
	}
});

test('opaque numeric coercions execute once at the native call site', async () => {
	const bytes = readFileSync(new URL('../../build/fixture.wasm', import.meta.url));
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
	const folio = await Folio.open(bytes, { memory, workers: 2 });
	try {
		let coerced = 0;
		const pointer = {
			valueOf() {
				coerced++;
				return 1024;
			}
		};
		const report = await folio.run('program', [pointer, 3, 1]);
		assert.equal(coerced, 1);
		assert.equal(report.mode, 'serial');
		assert.equal(report.reason, 'opaque-input');
	} finally {
		await folio.close();
	}
});

test('native host exceptions keep exact identity and stop following effects', async () => {
	const bytes = wasm(
		'(module (import "host" "effect" (func $effect (param i32))) (func (export "main") (param i32) (call $effect (local.get 0))))'
	);
	const failure = { reason: 'same identity' };
	const effects: number[] = [];
	const folio = await Folio.open(bytes, {
		imports: {
			host: {
				effect(value: number) {
					effects.push(value);
					if (value === 2) throw failure;
				}
			}
		}
	});
	try {
		await assert.rejects(
			folio.runAll([1, 2, 3].map((value) => ({ export: 'main', args: [value] }))),
			(error) => error === failure
		);
		assert.deepEqual(effects, [1, 2]);
	} finally {
		await folio.close();
	}
});

test('JSPI suspends the original stack, preserves effect order and joins close', async () => {
	const bytes = wasm(
		'(module (import "host" "effect" (func $effect (param i32) (result i32))) (func (export "main") (param i32) (result i32) (i32.add (call $effect (local.get 0)) (i32.const 7))))'
	);
	const effects: number[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const folio = await Folio.open(bytes, {
		promising: ['main'],
		imports: {
			host: {
				effect: suspending(async (value: number) => {
					effects.push(value);
					if (value === 3) await gate;
					return value * 2;
				})
			}
		}
	});
	assert.deepEqual(
		(await folio.runAll([1, 2].map((value) => ({ export: 'main', args: [value] })))).values,
		[9, 11]
	);
	const running = folio.run('main', [3]);
	await assert.rejects(folio.run('main', [4]), /active run/);
	let closed = false;
	const closing = folio.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	assert.equal(closed, false);
	release();
	assert.deepEqual((await running).values, [13]);
	await closing;
	assert.deepEqual(effects, [1, 2, 3]);
});

test('invalid promising configuration is rejected before a start effect', async () => {
	const bytes = wasm('(module (import "host" "start" (func $start)) (start $start))');
	let starts = 0;
	await assert.rejects(
		Folio.open(bytes, {
			promising: ['missing'],
			imports: {
				host: {
					start() {
						starts++;
					}
				}
			}
		}),
		/unknown promising/
	);
	assert.equal(starts, 0);
});

test('worker limits and per-entry diagnostics remain explicit', async () => {
	const source = readFileSync(new URL('../../build/fixture.wasm', import.meta.url));
	const folio = await Folio.open(source, { workers: 4 });
	try {
		assert.equal(folio.inspect('program').nativeGuard, true);
		assert.equal(folio.inspect('increment').automatic, false);
		assert.ok(folio.inspect('increment').diagnostics.length);
		const report = await folio.run('program', [1024, 40, 10000], { maximumWorkers: 2 });
		assert.equal(report.mode, 'native-shared');
		assert.equal(report.workers, 2);
		assert.equal(report.regions, 2);
		assert.equal(
			(await folio.run('program', [1024, 40, 10000], { maximumWorkers: 1 })).mode,
			'serial'
		);
		await assert.rejects(
			folio.run('program', [1024, 40, 10000], { maximumWorkers: 0 }),
			/maximumWorkers/
		);
	} finally {
		await folio.close();
	}
});

test('speculative return values retain native NaN payload bits across the worker port', async () => {
	const source = wasm(
		'(module (import "env" "memory" (memory 1 4 shared)) (func (export "read") (param i32) (result f64) (f64.load (local.get 0))))'
	);
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory }
	});
	const folio = await Folio.open(source, { memory, workers: 2 });
	try {
		const bits = (value: unknown) => {
			const view = new DataView(new ArrayBuffer(8));
			view.setFloat64(0, value as number, true);
			return view.getBigUint64(0, true);
		};
		for (const payload of [0x7ff0123456789abcn, 0xfff8123456789abcn]) {
			new DataView(memory.buffer).setBigUint64(0, payload, true);
			const expected = bits((native.exports.read as CallableFunction)(0));
			const report = await folio.runAll([
				{ export: 'read', args: [0] },
				{ export: 'read', args: [0] }
			]);
			assert.equal(report.mode, 'speculative');
			assert.deepEqual(report.values.map(bits), [expected, expected]);
		}
	} finally {
		await folio.close();
	}
});

test('import and export names do not alias JavaScript prototype properties', async () => {
	const source = wasm(
		'(module (import "__proto__" "arena" (memory 1 2)) (func (export "__proto__") (result i32) (memory.size)) (func (export "constructor") (result i32) (i32.const 5)))'
	);
	const folio = await Folio.open(source);
	try {
		assert.deepEqual((await folio.run('__proto__')).values, [1]);
		assert.deepEqual((await folio.run('constructor')).values, [5]);
		assert.equal(folio.inspect('toString').automatic, false);
		assert.equal(folio.inspect('constructor').automatic, false);
	} finally {
		await folio.close();
	}
});

test('multiple imported memories bind distinct original allocations', async () => {
	// Two imported wasm32 memories, with no function body for Binaryen to rewrite.
	const source = Uint8Array.from([
		0, 97, 115, 109, 1, 0, 0, 0, 2, 21, 2, 3, 101, 110, 118, 1, 97, 2, 1, 1, 2, 3, 101, 110,
		118, 1, 98, 2, 1, 1, 2
	]);
	assert.equal(WebAssembly.validate(source), true);
	const folio = await Folio.open(source);
	try {
		assert.notEqual(folio.memories['env.a'], folio.memories['env.b']);
		new Uint8Array(folio.memories['env.a']!.buffer)[0] = 71;
		assert.equal(new Uint8Array(folio.memories['env.b']!.buffer)[0], 0);
		assert.throws(() => folio.memory, /no single bound/);
	} finally {
		await folio.close();
	}
});

test('native import accessors retain their original lookup order and receiver', async () => {
	const source = wasm(
		'(module (import "host" "first" (func $first)) (import "host" "memory" (memory 1 2)) (import "host" "last" (func $last)) (func $start (call $first) (call $last)) (start $start))'
	);
	const module = new WebAssembly.Module(Uint8Array.from(source));
	const make = () => {
		const events: string[] = [];
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
		const namespace = {
			get first() {
				assert.equal(this, namespace);
				events.push('first');
				return () => {
					events.push('call-first');
				};
			},
			get memory() {
				assert.equal(this, namespace);
				events.push('memory');
				return memory;
			},
			get last() {
				assert.equal(this, namespace);
				events.push('last');
				return () => {
					events.push('call-last');
				};
			}
		};
		const imports = {
			get host() {
				assert.equal(this, imports);
				events.push('host');
				return namespace;
			}
		};
		return { imports, events };
	};
	const expected = make(),
		actual = make();
	new WebAssembly.Instance(module, expected.imports);
	const folio = await Folio.open(source, { imports: actual.imports });
	try {
		assert.deepEqual(actual.events, expected.events);
	} finally {
		await folio.close();
	}
});

test('native modules, bytes and shared memories from another realm retain their brands', async () => {
	const source = readFileSync(new URL('../../build/fixture.wasm', import.meta.url));
	const foreign = runInNewContext(
		`({
		bytes: new Uint8Array(source),
		buffer: new Uint8Array(source).buffer,
		module: new WebAssembly.Module(new Uint8Array(source)),
		memory: new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true })
	})`,
		{ source: [...source] }
	);
	assert.equal(foreign.module instanceof WebAssembly.Module, false);
	assert.equal(foreign.memory instanceof WebAssembly.Memory, false);
	for (const input of [foreign.bytes, foreign.buffer, foreign.module]) {
		const folio = await Folio.open(input, { memory: foreign.memory, workers: 2 });
		try {
			assert.equal(folio.memory, foreign.memory);
			const report = await folio.run('program', [1024, 37, 10000] as const);
			assert.equal(report.mode, input === foreign.module ? 'serial' : 'native-shared');
		} finally {
			await folio.close();
		}
	}
});
