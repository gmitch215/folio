import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { restoreImportOrder } from '../../src/import-order.ts';
import { Folio } from '../../src/node.ts';

function fixture() {
	const m = binaryen.parseText(`(module
		(import "host" "first" (func $first (param i32) (result i32)))
		(import "host" "second" (func $second (param i32) (result i32)))
		(import "env" "memory" (memory 1 2 shared))
		(func $put (param i32) (i32.store (i32.const 16) (local.get 0)))
		(func (export "run") (result i32)
			(call $put (i32.const 37))
			(call $first (call $second (i32.load (i32.const 16))))))`);
	try {
		return m.emitBinary();
	} finally {
		m.dispose();
	}
}

test('import reordering preserves per-kind indices and every observable original binding lookup', async () => {
	const bytes = fixture();
	const imports = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(bytes)));
	const desired = [
		...imports.filter((item) => item.kind === 'function'),
		...imports.filter((item) => item.kind !== 'function')
	];
	const original = restoreImportOrder(bytes, desired);
	assert.deepEqual(
		WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(original))),
		desired
	);
	const make = () => {
		const trace: string[] = [];
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
		const host = new Proxy(
			{ first: (value: number) => value + 1, second: (value: number) => value * 2 },
			{
				get: (target, key, receiver) => {
					trace.push(`host.${String(key)}`);
					return Reflect.get(target, key, receiver);
				}
			}
		);
		const env = new Proxy(
			{ memory },
			{
				get: (target, key, receiver) => {
					trace.push(`env.${String(key)}`);
					return Reflect.get(target, key, receiver);
				}
			}
		);
		return { imports: { host, env }, memory, trace };
	};
	const native = make(),
		actual = make();
	const reference = new WebAssembly.Instance(
		new WebAssembly.Module(Uint8Array.from(original)),
		native.imports
	);
	const program = prepare(original, { minimumRegionWork: 0 });
	assert.ok(program.control?.entries.includes('run'));
	const pool = await Folio.open(program, {
		minimumRegionWork: 0,
		imports: actual.imports,
		workers: 2
	});
	try {
		assert.equal(pool.inspect('run').mechanism, 'control-flow');
		assert.deepEqual(actual.trace, native.trace);
		assert.deepEqual((await pool.run('run')).values, [
			(reference.exports.run as CallableFunction)()
		]);
		assert.deepEqual(
			new Uint8Array(actual.memory.buffer),
			new Uint8Array(native.memory.buffer)
		);
	} finally {
		await pool.close();
	}
});

test('a different order inside one index space is rejected instead of corrupting call indices', () => {
	const bytes = fixture();
	const imports = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(bytes)));
	const functions = imports.filter((item) => item.kind === 'function').reverse();
	assert.throws(
		() =>
			restoreImportOrder(bytes, [
				...functions,
				...imports.filter((item) => item.kind !== 'function')
			]),
		/per-kind/
	);
});
