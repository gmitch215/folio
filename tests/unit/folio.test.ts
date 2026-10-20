import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { SpeculationLimit, transaction } from '../../src/transaction.ts';

const source = readFileSync(new URL('../../build/fixture.wasm', import.meta.url));
const program = prepare(source);
const memory = () => new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });

test('compiler discovers an unannotated single-entry loop and retains diagnostics', () => {
	assert.deepEqual(program.reasons, []);
	assert.deepEqual(program.loops.program, {
		countParameter: 1,
		steps: [{ parameter: 0, step: 4 }]
	});
	assert.ok(program.loops.dependent_program);
	assert.ok(program.transactional);
	assert.equal(WebAssembly.validate(Uint8Array.from(program.transactional)), true);
});

test('one entry automatically splits across distinct isolates with exact shared output', async () => {
	const shared = memory();
	const words = new Uint32Array(shared.buffer);
	for (let i = 0; i < 37; i++) words[256 + i] = i + 1;
	const reference = memory();
	new Uint8Array(reference.buffer).set(new Uint8Array(shared.buffer));
	const control = new WebAssembly.Instance(new WebAssembly.Module(source), {
		env: { memory: reference }
	});
	(control.exports.program as CallableFunction)(1024, 37, 17);
	const pool = await Folio.open(program, { memory: shared, workers: 4 });
	try {
		assert.equal(new Set(pool.threadIds).size, 4);
		assert.equal(pool.capabilities.physicalSharing, 'same-process');
		const report = await pool.run('program', [1024, 37, 17], { parallel: 'speculate' });
		assert.equal(report.regions, 4);
		assert.equal(report.replayed, 0);
		assert.equal(report.mode, 'speculative');
		assert.deepEqual(new Uint8Array(shared.buffer), new Uint8Array(reference.buffer));
		assert.deepEqual((await pool.run('program', [1024, 0, 5])).values, [undefined]);
		assert.equal((await pool.run('program', [1024, 1, 5])).mode, 'serial');
		assert.equal((await pool.run('program', [1024, 8, 5], { parallel: 'off' })).mode, 'serial');
		await assert.rejects(pool.run('program', [1024n, 8, 5]), TypeError);
	} finally {
		await pool.close();
	}
	await assert.rejects(pool.run('increment', [1024]), /closed/);
	await pool.close();
});

test('loop-carried memory dependencies replay and match sequential prefix output', async () => {
	const shared = memory();
	new Uint32Array(shared.buffer)[255] = 100;
	const pool = await Folio.open(program, { memory: shared, workers: 4 });
	try {
		const report = await pool.run('dependent_program', [1024, 37]);
		assert.equal(report.replayed, 3);
		assert.deepEqual(
			[...new Uint32Array(shared.buffer, 1024, 37)],
			Array.from({ length: 37 }, (_, i) => 101 + i)
		);
	} finally {
		await pool.close();
	}
});

test('dynamic conflicts, blind writes, overlapping bytes and ordered traps', async () => {
	const shared = memory();
	const words = new Uint32Array(shared.buffer);
	const pool = await Folio.open(program, { memory: shared, workers: 4 });
	try {
		const report = await pool.runAll(
			Array.from({ length: 8 }, () => ({ export: 'increment', args: [1024] }))
		);
		assert.deepEqual(report.values, [1, 2, 3, 4, 5, 6, 7, 8]);
		assert.equal(report.replayed, 6);
		words[300] = 0x12345678;
		const overlap = await pool.runAll([
			{ export: 'copy_word', args: [1201, 1200] },
			{ export: 'copy_word', args: [1210, 1202] }
		]);
		assert.equal(overlap.replayed, 1);
		await assert.rejects(
			pool.runAll([
				{ export: 'increment', args: [1024] },
				{ export: 'trap_after_write', args: [1028] },
				{ export: 'increment', args: [1032] }
			]),
			WebAssembly.RuntimeError
		);
		assert.equal(words[256], 9);
		assert.equal(words[257], 91);
		assert.equal(words[258], 0);
		await assert.rejects(pool.run('absent'), /unknown function/);
		await assert.rejects(
			pool.runAll([
				{ export: 'increment', args: [0n] },
				{ export: 'increment', args: [0] }
			]),
			TypeError
		);
		const pending = pool.runAll(
			Array.from({ length: 4 }, () => ({ export: 'mix', args: [1024, 1000] }))
		);
		await assert.rejects(pool.run('increment', [1024]), /active run/);
		await pending;
	} finally {
		await pool.close();
	}
});

test('speculation budgets discard partial overlays and finish at the serial head', async () => {
	for (const limits of [{ fuel: 2 }, { maxTransactionBytes: 1 }]) {
		const shared = memory();
		new Uint32Array(shared.buffer)[256] = 1;
		const reference = memory();
		new Uint32Array(reference.buffer)[256] = 1;
		const native = new WebAssembly.Instance(new WebAssembly.Module(source), {
			env: { memory: reference }
		});
		const expected = [
			(native.exports.mix as CallableFunction)(1024, 4),
			(native.exports.mix as CallableFunction)(1024, 4)
		];
		const pool = await Folio.open(program, { memory: shared, workers: 2, ...limits });
		try {
			const report = await pool.runAll([
				{ export: 'mix', args: [1024, 4] },
				{ export: 'mix', args: [1024, 4] }
			]);
			assert.deepEqual(report.values, expected);
			assert.deepEqual(new Uint8Array(shared.buffer), new Uint8Array(reference.buffer));
			assert.ok(report.fallbacks > 0);
		} finally {
			await pool.close();
		}
	}
});

test('unsupported host effects stay ordered on the native entry', async () => {
	const m = binaryen.parseText(
		'(module (import "host" "effect" (func $effect (param i32) (result i32))) (func (export "main") (param i32) (result i32) (call $effect (local.get 0))))'
	);
	const prepared = prepare(m.emitBinary());
	m.dispose();
	assert.equal(prepared.transactional, undefined);
	const effects: number[] = [];
	const pool = await Folio.open(prepared, {
		memory: memory(),
		imports: {
			host: {
				effect: (x: number) => {
					effects.push(x);
					return x;
				}
			}
		}
	});
	try {
		const report = await pool.runAll([
			{ export: 'main', args: [1] },
			{ export: 'main', args: [2] }
		]);
		assert.equal(report.mode, 'serial');
		assert.deepEqual(effects, [1, 2]);
	} finally {
		await pool.close();
	}
});

test('byte transactions preserve signs, overlays and full bounds before mutation', () => {
	const shared = memory();
	const bytes = new Uint8Array(shared.buffer);
	bytes[0] = 255;
	const tx = transaction(shared, 100);
	assert.equal(tx.load(0, 0, 1, 1), -1);
	assert.equal(tx.load(0, 0, 1, 0), 255);
	tx.store(0, 0x12345678, 0, 4);
	assert.equal(tx.load(0, 0, 4, 0), 0x12345678);
	assert.equal(bytes[0], 255);
	assert.throws(() => tx.store(bytes.length - 1, 42, 0, 4), WebAssembly.RuntimeError);
	assert.throws(() => tx.load(-1, 1, 1, 0), WebAssembly.RuntimeError);
	assert.equal(tx.result().writes.length, 4);
	assert.equal(tx.result().reads.length, 1);
	assert.equal(tx.result(undefined, new SpeculationLimit()).exhausted, true);
});

test('configuration rejects invalid counts and budgets', async () => {
	await assert.rejects(Folio.open(program, { memory: memory(), workers: 0 }), /worker count/);
	await assert.rejects(Folio.open(program, { memory: memory(), fuel: -1 }), /fuel/);
	await assert.rejects(
		Folio.open(program, { memory: memory(), maxTransactionBytes: 0 }),
		/budget/
	);
});

test('valid uncommon module shapes retain a usable serial path', () => {
	for (const body of [
		'(block $exit (br $exit) (loop $again (nop) (br $again)))',
		'(block $exit (br_if $exit (i32.eqz (local.get 0))) (loop $again (nop) (br $again)))'
	]) {
		const m = binaryen.parseText(
			`(module (import "env" "memory" (memory 2 8192 shared)) (func (export "main") (param i32) ${body}))`
		);
		const prepared = prepare(m.emitBinary());
		m.dispose();
		assert.deepEqual(prepared.loops, {});
	}
	for (const declaration of [
		'(export "__folio_set_fuel" (func $main))',
		'(global $__folio_fuel (mut i32) (i32.const 0))'
	]) {
		const m = binaryen.parseText(
			`(module (import "env" "memory" (memory 2 8192 shared)) ${declaration} (func $main (export "main") (nop)))`
		);
		binaryen.setDebugInfo(true);
		const bytes = m.emitBinary();
		binaryen.setDebugInfo(false);
		const prepared = prepare(bytes);
		m.dispose();
		assert.equal(prepared.transactional, undefined);
		assert.deepEqual(prepared.reasons, ['reserved function name']);
	}
});

test('native fallback exposes its own memory and reports no active sharing', async () => {
	const m = binaryen.parseText(
		'(module (memory (export "memory") 1) (func (export "put") (i32.store (i32.const 0) (i32.const 7))))'
	);
	const bytes = m.emitBinary();
	m.dispose();
	const prepared = prepare(bytes);
	const pool = await Folio.open(prepared, { memory: memory() });
	try {
		assert.equal(pool.capabilities.physicalSharing, 'none');
		assert.equal(pool.memory, pool.exports.memory);
		await pool.run('put');
		assert.equal(new Uint32Array(pool.memory.buffer)[0], 7);
	} finally {
		await pool.close();
	}
	assert.deepEqual(prepare(bytes, { parallel: 'off' }).reasons, [
		'parallel preparation disabled'
	]);
});

test('opaque state and generated hook collisions use the original module', async () => {
	for (const body of [
		'(global $x (mut i32) (i32.const 0)) (func (export "main") (global.set $x (i32.const 7)))',
		'(func (export "main") (drop (memory.grow (i32.const 0))))',
		'(func (export "main") (drop (memory.size)))'
	]) {
		const m = binaryen.parseText(
			`(module (import "env" "memory" (memory 2 8192 shared)) ${body})`
		);
		const prepared = prepare(m.emitBinary());
		m.dispose();
		assert.equal(prepared.transactional, undefined);
		const pool = await Folio.open(prepared, { memory: memory() });
		try {
			assert.equal((await pool.run('main')).mode, 'serial');
		} finally {
			await pool.close();
		}
	}
	const m = binaryen.parseText(
		'(module (import "folio" "load" (memory 2 8192 shared)) (func (export "main") (i32.store (i32.const 0) (i32.const 7))))'
	);
	const prepared = prepare(m.emitBinary());
	m.dispose();
	assert.deepEqual(prepared.reasons, ['reserved import namespace']);
	const pool = await Folio.open(prepared, { memory: memory() });
	try {
		await pool.runAll([
			{ export: 'main', args: [] },
			{ export: 'main', args: [] }
		]);
		assert.equal(new Uint32Array(pool.memory.buffer)[0], 7);
	} finally {
		await pool.close();
	}
});

test('guarded native regions write the shared allocation directly and match native output', async () => {
	const shared = memory(),
		reference = memory();
	for (const mem of [shared, reference]) new Uint32Array(mem.buffer, 1024, 37).fill(1);
	const control = new WebAssembly.Instance(new WebAssembly.Module(source), {
		env: { memory: reference }
	});
	(control.exports.program as CallableFunction)(1024, 37, 10000);
	const pool = await Folio.open(program, { memory: shared, workers: 4 });
	try {
		assert.deepEqual(program.native?.program?.workParameters, [2]);
		assert.equal((await pool.run('program', [1024, 37, 10000])).mode, 'native-shared');
		assert.deepEqual(new Uint8Array(shared.buffer), new Uint8Array(reference.buffer));
		assert.equal((await pool.run('program', [1024, 16, 4])).mode, 'serial');
		assert.equal(program.native?.dependent_program, undefined);
		assert.equal(program.native?.division_program, undefined);
	} finally {
		await pool.close();
	}
});

test('native guard rejects aliases, bounds and pointer wrap before concurrent writes', async () => {
	for (const entry of ['aliased_program', 'program']) {
		const shared = memory(),
			reference = memory();
		for (const mem of [shared, reference]) new Uint32Array(mem.buffer).fill(1);
		const control = new WebAssembly.Instance(new WebAssembly.Module(source), {
			env: { memory: reference }
		});
		const pool = await Folio.open(program, { memory: shared, workers: 4 });
		try {
			if (entry === 'aliased_program') {
				(control.exports[entry] as CallableFunction)(1024, 16, 10000);
				const report = await pool.run(entry, [1024, 16, 10000]);
				assert.equal(report.mode, 'speculative');
				assert.equal(report.replayed, 3);
			} else {
				for (const address of [shared.buffer.byteLength - 8, 0xfffffffc]) {
					assert.throws(
						() => (control.exports.program as CallableFunction)(address, 4, 100000),
						WebAssembly.RuntimeError
					);
					await assert.rejects(
						pool.run(entry, [address, 4, 100000]),
						WebAssembly.RuntimeError
					);
					assert.deepEqual(
						new Uint8Array(shared.buffer),
						new Uint8Array(reference.buffer)
					);
				}
			}
			assert.deepEqual(new Uint8Array(shared.buffer), new Uint8Array(reference.buffer));
		} finally {
			await pool.close();
		}
	}
});

test('cancelling native execution joins all workers before the run settles', async () => {
	const shared = memory();
	new Uint32Array(shared.buffer, 1024, 37).fill(1);
	const pool = await Folio.open(program, { memory: shared, workers: 4 });
	const running = pool.run('program', [1024, 37, 1000000]);
	const rejected = assert.rejects(running, /native region failed/);
	const closing = pool.close();
	assert.equal(pool.close(), closing);
	await rejected;
	const settled = Uint8Array.from(new Uint8Array(shared.buffer));
	await closing;
	assert.deepEqual(new Uint8Array(shared.buffer), settled);
});
