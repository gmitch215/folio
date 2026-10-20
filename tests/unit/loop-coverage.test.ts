import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';

function fixture(payload: string, declarations = '(local $value i32) (local $mixed i32)') {
	const module = binaryen.parseText(`(module
		(import "env" "memory" (memory 2 8 shared))
		(func (export "main") (param $pointer i32) (param $count i32) (param $seed i32)
			${declarations}
			(block $exit
				(br_if $exit (i32.eqz (local.get $count)))
				(loop $again
					${payload}
					(local.set $pointer (i32.add (local.get $pointer) (i32.const 4)))
					(br_if $again
						(local.tee $count (i32.add (local.get $count) (i32.const -1))))))))`);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

async function compare(bytes: Uint8Array, split: boolean) {
	const shared = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
	const reference = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
	for (const memory of [shared, reference]) {
		const words = new Uint32Array(memory.buffer);
		for (let index = 0; index < words.length; index++)
			words[index] = Math.imul(index + 1, 0x1234567);
	}
	const control = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory: reference }
	});
	const program = prepare(bytes);
	assert.deepEqual(program.reasons, []);
	assert.equal(Boolean(program.loops.main), split);
	const pool = await Folio.open(program, { memory: shared, workers: 4 });
	try {
		for (const count of [97, 1, 0, 67]) {
			(control.exports.main as CallableFunction)(1024, count, 0x1234);
			const report = await pool.run('main', [1024, count, 0x1234], {
				parallel: 'speculate'
			});
			assert.deepEqual(new Uint8Array(shared.buffer), new Uint8Array(reference.buffer));
			if (split && count > 1) {
				assert.equal(report.mode, 'speculative');
				assert.equal(report.regions, 4);
				assert.equal(report.replayed, 0);
			} else assert.equal(report.mode, 'serial');
		}
	} finally {
		await pool.close();
	}
	return program;
}

test('inline kernels split with iteration-local temporaries and conditional definitions', async () => {
	const bytes = fixture(`
		(local.set $value (i32.load (local.get $pointer)))
		(if (i32.and (local.get $value) (i32.const 1))
			(then (local.set $mixed (i32.xor (local.get $value) (local.get $seed))))
			(else (local.set $mixed (i32.add (local.get $value) (local.get $seed)))))
		(i32.store (local.get $pointer)
			(i32.rotl (local.get $mixed) (i32.and (local.get $value) (i32.const 31))))`);
	const program = await compare(bytes, true);
	assert.equal(program.native?.main, undefined);
	assert.equal(program.loopReasons?.main, undefined);
	assert.deepEqual(program.loops.main, {
		countParameter: 1,
		steps: [{ parameter: 0, step: 4 }]
	});
});

test('select evaluates both operands before its condition and keeps local.tee definitions', async () => {
	await compare(
		fixture(`(i32.store (local.get $pointer)
			(select
				(local.tee $value (i32.load (local.get $pointer)))
				(i32.xor (local.get $value) (local.get $seed))
				(i32.const 1)))`),
		true
	);
	const carried = await compare(
		fixture(`(i32.store (local.get $pointer)
			(select
				(local.get $value)
				(i32.const 0)
				(local.tee $value (i32.load (local.get $pointer)))))`),
		false
	);
	assert.equal(carried.loopReasons?.main, 'loop-carried scalar state');
});

test('condition definitions, overwritten parameters and immutable zero locals remain splittable', async () => {
	await compare(
		fixture(`
			(if (local.tee $value (i32.load (local.get $pointer)))
				(then (local.set $seed (i32.add (local.get $value) (i32.const 11))))
				(else (local.set $seed (i32.const 19))))
			(i32.store (local.get $pointer)
				(i32.xor (local.get $seed) (local.get $mixed)))`),
		true
	);
});

test('scalar carry, partially assigned locals and escaping control retain the original entry', async () => {
	for (const payload of [
		`(local.set $seed (i32.add (local.get $seed) (i32.load (local.get $pointer))))
		 (i32.store (local.get $pointer) (local.get $seed))`,
		`(if (i32.and (i32.load (local.get $pointer)) (i32.const 1))
			(then (local.set $value (local.get $seed))))
		 (i32.store (local.get $pointer) (local.get $value))`,
		`(local.set $value (i32.add (local.get $value) (i32.const 1)))
		 (i32.store (local.get $pointer) (local.get $value))`
	]) {
		const program = await compare(fixture(payload), false);
		assert.equal(program.loopReasons?.main, 'loop-carried scalar state');
	}
	const escaped = await compare(
		fixture(`(br_if $exit (i32.eqz (i32.load (local.get $pointer))))
			(i32.store (local.get $pointer) (local.get $seed))`),
		false
	);
	assert.equal(escaped.loopReasons?.main, 'nested or escaping control flow');
});

test('remaining-count reads and additional affine writes cannot be split', async () => {
	const counted = await compare(
		fixture('(i32.store (local.get $pointer) (local.get $count))'),
		false
	);
	assert.equal(counted.loopReasons?.main, 'iteration reads the remaining count');
	const changed = await compare(
		fixture(`(local.set $pointer (i32.add (local.get $pointer) (i32.const 8)))
			(i32.store (local.get $pointer) (local.get $seed))`),
		false
	);
	assert.equal(changed.loopReasons?.main, 'loop control modified inside the iteration');
});

test('non-void reductions retain the native result and memory semantics', async () => {
	const module = binaryen.parseText(`(module
		(import "env" "memory" (memory 2 8 shared))
		(func (export "sum") (param $pointer i32) (param $count i32) (result i32)
			(local $sum i32)
			(block $exit
				(br_if $exit (i32.eqz (local.get $count)))
				(loop $again
					(local.set $sum (i32.add (local.get $sum) (i32.load (local.get $pointer))))
					(local.set $pointer (i32.add (local.get $pointer) (i32.const 4)))
					(br_if $again
						(local.tee $count (i32.add (local.get $count) (i32.const -1))))))
			(local.get $sum)))`);
	const bytes = module.emitBinary();
	module.dispose();
	const program = prepare(bytes);
	assert.deepEqual(program.loops, {});
	assert.equal(program.loopReasons?.sum, 'non-void entry requires a result merge');
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true });
	new Uint32Array(memory.buffer, 1024, 97).fill(7);
	const pool = await Folio.open(program, { memory, workers: 4 });
	try {
		const report = await pool.run('sum', [1024, 97]);
		assert.equal(report.mode, 'serial');
		assert.deepEqual(report.values, [679]);
	} finally {
		await pool.close();
	}
});
