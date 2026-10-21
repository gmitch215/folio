import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { SpeculationLimit, transaction } from '../../src/transaction.ts';

const module = binaryen.parseText(`(module
	(import "env" "memory" (memory 1 4 shared))
	(func (export "noop") (nop))
	(func (export "copy64") (param i32 i32)
		(i64.store offset=1 align=1 (local.get 0) (i64.load offset=3 align=1 (local.get 1))))
	(func (export "copy32f") (param i32 i32)
		(f32.store offset=1 align=1 (local.get 0) (f32.load offset=3 align=1 (local.get 1))))
	(func (export "copy64f") (param i32 i32)
		(f64.store offset=1 align=1 (local.get 0) (f64.load offset=3 align=1 (local.get 1))))
	(func (export "narrow8s") (param i32) (result i64) (i64.load8_s (local.get 0)))
	(func (export "narrow8u") (param i32) (result i64) (i64.load8_u (local.get 0)))
	(func (export "narrow16s") (param i32) (result i64) (i64.load16_s align=1 (local.get 0)))
	(func (export "narrow16u") (param i32) (result i64) (i64.load16_u align=1 (local.get 0)))
	(func (export "narrow32s") (param i32) (result i64) (i64.load32_s align=1 (local.get 0)))
	(func (export "narrow32u") (param i32) (result i64) (i64.load32_u align=1 (local.get 0)))
	(func (export "put64") (param i32 i64)
		(i64.store align=1 (local.get 0) (local.get 1)))
	(func (export "put_narrow") (param i32 i64)
		(i64.store8 (local.get 0) (local.get 1))
		(i64.store16 offset=1 align=1 (local.get 0) (local.get 1))
		(i64.store32 offset=3 align=1 (local.get 0) (local.get 1)))
	(func (export "copy") (param i32 i32 i32)
		(memory.copy (local.get 0) (local.get 1) (local.get 2)))
	(func (export "fill") (param i32 i32 i32)
		(memory.fill (local.get 0) (local.get 1) (local.get 2)))
	(func (export "trap_after_fill")
		(memory.fill (i32.const 400) (i32.const 91) (i32.const 5))
		(drop (i64.load (i32.const 65532))))
)`);
module.setFeatures(binaryen.Features.Atomics | binaryen.Features.BulkMemory);
const source = module.emitBinary();
module.dispose();
const prepared = prepare(source, { minimumRegionWork: 0 });
const memory = () => new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });

function initialized(): WebAssembly.Memory {
	const shared = memory();
	const bytes = new Uint8Array(shared.buffer);
	for (let i = 0; i < 500; i++) bytes[i] = (i * 71 + 19) & 255;
	return shared;
}

test('native-valid sign-extension and saturating conversion survive worker preparation', async () => {
	const fixture = binaryen.parseText(`(module (memory (export "memory") 1 2 shared)
		(func $convert (param i32 f64)
			(i32.store (local.get 0) (i32.extend8_s (i32.trunc_sat_f64_s (local.get 1)))))
		(func (export "main") (result i32)
			(call $convert (i32.const 0) (f64.const inf))
			(call $convert (i32.const 4) (f64.const -129))
			(i32.add (i32.load (i32.const 0)) (i32.load (i32.const 4)))))`);
	fixture.setFeatures(binaryen.Features.All);
	const bytes = fixture.emitBinary();
	fixture.dispose();
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)));
	const pool = await Folio.open(bytes, { minimumRegionWork: 0, workers: 2 });
	try {
		const expected = (native.exports.main as CallableFunction)();
		const report = await pool.run('main');
		assert.deepEqual(report.values, [expected]);
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

test('typed scalar lowering retains all bits across NaN, integer and unaligned memory', async () => {
	assert.deepEqual(prepared.reasons, []);
	assert.ok(prepared.transactional);
	const actual = initialized();
	const expected = initialized();
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory: expected }
	});
	const pool = await Folio.open(prepared, { minimumRegionWork: 0, memory: actual, workers: 2 });
	try {
		const values32 = [0x7f800001, 0x7fc12345, 0xff812345, 0x80000000, 0x7f800000];
		const values64 = [
			0x7ff0000000000001n,
			0x7ff8123456789abcn,
			0xfff123456789abcdn,
			0x8000000000000000n,
			0xffffffffffffffffn
		];
		for (const [entry, bits] of [
			...values32.map((bits) => ['copy32f', BigInt(bits)] as const),
			...values64.flatMap(
				(bits) =>
					[
						['copy64f', bits],
						['copy64', bits]
					] as const
			)
		]) {
			for (const mem of [actual, expected]) {
				const view = new DataView(mem.buffer);
				view.setBigUint64(103, bits, true);
			}
			(native.exports[entry] as CallableFunction)(200, 100);
			const report = await pool.runAll(
				[
					{ export: entry, args: [200, 100] },
					{ export: 'noop', args: [] }
				],
				{ parallel: 'speculate' }
			);
			assert.equal(report.mode, 'speculative');
			assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
		}
		for (const entry of [
			'narrow8s',
			'narrow8u',
			'narrow16s',
			'narrow16u',
			'narrow32s',
			'narrow32u'
		]) {
			for (const mem of [actual, expected]) new Uint8Array(mem.buffer).fill(255, 301, 305);
			assert.deepEqual(
				(
					await pool.runAll([
						{ export: entry, args: [301] },
						{ export: 'noop', args: [] }
					])
				).values,
				[(native.exports[entry] as CallableFunction)(301), undefined]
			);
		}
		for (const entry of ['put64', 'put_narrow']) {
			for (const value of [-1n, -0x123456789abcden, 0x7fffffffffffffffn]) {
				(native.exports[entry] as CallableFunction)(301, value);
				await pool.runAll([
					{ export: entry, args: [301, value] },
					{ export: 'noop', args: [] }
				]);
				assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
			}
		}
		(native.exports.put64 as CallableFunction)(103, -1n);
		(native.exports.copy64 as CallableFunction)(200, 100);
		const conflict = await pool.runAll([
			{ export: 'put64', args: [103, -1n] },
			{ export: 'copy64', args: [200, 100] }
		]);
		assert.equal(conflict.replayed, 1);
		assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
	} finally {
		await pool.close();
	}
});

test('bulk operations preserve overlapping moves, ordered conflicts and trap prefixes', async () => {
	const actual = initialized();
	const expected = initialized();
	const native = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory: expected }
	});
	const pool = await Folio.open(prepared, { minimumRegionWork: 0, memory: actual, workers: 2 });
	try {
		for (const args of [
			[101, 100, 31],
			[100, 101, 31],
			[110, 110, 5],
			[65536, 65536, 0]
		]) {
			(native.exports.copy as CallableFunction)(...args);
			const report = await pool.runAll([
				{ export: 'copy', args },
				{ export: 'noop', args: [] }
			]);
			assert.equal(report.mode, 'speculative');
			assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
		}
		(native.exports.fill as CallableFunction)(100, 0x1234, 8);
		(native.exports.copy as CallableFunction)(200, 100, 8);
		const conflict = await pool.runAll([
			{ export: 'fill', args: [100, 0x1234, 8] },
			{ export: 'copy', args: [200, 100, 8] }
		]);
		assert.equal(conflict.replayed, 1);
		assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
		for (const [entry, args] of [
			['copy', [65535, 100, 2]],
			['copy', [100, 65535, 2]],
			['fill', [65535, 7, 2]],
			['copy', [65537, 0, 0]],
			['fill', [65537, 0, 0]],
			['trap_after_fill', []]
		] as const) {
			assert.throws(
				() => (native.exports[entry] as CallableFunction)(...args),
				WebAssembly.RuntimeError
			);
			await assert.rejects(
				pool.runAll([
					{ export: entry, args: [...args] },
					{ export: 'noop', args: [] }
				]),
				WebAssembly.RuntimeError
			);
			assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
		}
	} finally {
		await pool.close();
	}
});

test('bulk bounds validate complete ranges and budgets cap speculative growth', () => {
	const shared = initialized();
	const tx = transaction(shared, 100);
	tx.store64(10, -1n, 0, 8);
	assert.equal(tx.load64(10, 0, 8, 0), -1n);
	tx.copy(11, 10, 8);
	assert.equal(tx.load64(11, 0, 8, 0), -1n);
	const before = tx.result();
	assert.throws(() => tx.copy(65535, 0, 2), WebAssembly.RuntimeError);
	assert.throws(() => tx.copy(0, 65535, 2), WebAssembly.RuntimeError);
	assert.throws(() => tx.fill(65535, 0, 2), WebAssembly.RuntimeError);
	assert.throws(() => tx.store64(65535, 1n, 0, 8), WebAssembly.RuntimeError);
	assert.throws(() => tx.load64(65535, 0, 8, 0), WebAssembly.RuntimeError);
	assert.deepEqual(tx.result(), before);
	assert.throws(() => tx.copy(100, 200, 101), SpeculationLimit);
	assert.throws(() => tx.fill(100, 42, 101), SpeculationLimit);
	assert.deepEqual(tx.result(), before);
	assert.equal(new Uint8Array(shared.buffer)[10], (10 * 71 + 19) & 255);
});

test('additional linear memories retain native memory selection', () => {
	const bytes = Uint8Array.from([
		0, 97, 115, 109, 1, 0, 0, 0, 2, 16, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2,
		3, 1, 4, 5, 3, 1, 0, 1
	]);
	assert.equal(WebAssembly.validate(bytes), true);
	const result = prepare(bytes, { minimumRegionWork: 0 });
	assert.equal(result.transactional, undefined);
	assert.deepEqual(result.reasons, ['additional defined memory']);
});
