import binaryen from 'binaryen';
import { expect, test } from 'vitest';
import {
	SliceConflictError,
	SlicePool,
	sharedMemoryImport,
	type SlicePoolOptions
} from '../../src/slices.ts';

const compile = (wat: string) => {
	const module = binaryen.parseText(wat);
	try {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		module.setFeatures(binaryen.Features.All & ~compact);
		expect(module.validate()).toBeTruthy();
		return Uint8Array.from(module.emitBinary());
	} finally {
		module.dispose();
	}
};

const fill = `
	(func (export "fill") (param $ptr i32) (param $len i32) (param $value i32) (local $i i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $len)))
			(i32.store8 (i32.add (local.get $ptr) (local.get $i)) (local.get $value))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each))))`;

const plain = compile(`(module (import "env" "memory" (memory 1 8)) ${fill})`);
const withStack = compile(`(module (import "env" "memory" (memory 1 8))
	(global $sp (mut i32) (i32.const 65536))
	${fill}
	(func (export "sp") (param i32) (result i32) (global.get $sp))
	(func (export "frame") (param $value i32) (result i32)
		(global.set $sp (i32.sub (global.get $sp) (i32.const 8)))
		(i32.store (global.get $sp) (local.get $value))
		(i32.store offset=4 (global.get $sp) (i32.mul (local.get $value) (i32.const 2)))
		(local.set $value (i32.add (i32.load (global.get $sp)) (i32.load offset=4 (global.get $sp))))
		(global.set $sp (i32.add (global.get $sp) (i32.const 8)))
		(local.get $value)))`);

const memory = (maximum = 8) => new WebAssembly.Memory({ initial: 1, maximum, shared: true });

const open = async (bytes: Uint8Array, options: Partial<SlicePoolOptions> = {}) =>
	SlicePool.open(bytes, { memory: memory(), workers: 3, ...options });

test('slices write their ranges of one shared memory and the audit agrees with the serial run', async () => {
	const pool = await open(plain);
	try {
		const report = await pool.run('fill', 100, (from, to) => [1000 + from, to - from, 7], {
			audit: true
		});
		expect(report).toMatchObject({ slices: 3, workers: 3, audited: true });
		const bytes = new Uint8Array(pool.memory.buffer);
		expect(bytes.subarray(1000, 1100).every((byte) => byte === 7)).toBe(true);
		expect(bytes[999]).toBe(0);
		expect(bytes[1100]).toBe(0);
		expect(pool.stackBase).toBeUndefined();
		const grained = await pool.run('fill', 10, (from, to) => [2000 + from, to - from, 9], {
			grain: 1
		});
		expect(grained.slices).toBe(10);
		expect(new Uint8Array(pool.memory.buffer).subarray(2000, 2010)).toEqual(
			new Uint8Array(10).fill(9)
		);
		expect((await pool.run('fill', 0, () => [0, 0, 0])).slices).toBe(0);
	} finally {
		await pool.close();
	}
});

test('a module with a stack pointer gets one private stack per worker past the original memory', async () => {
	const pool = await open(withStack);
	try {
		expect(pool.stackBase).toBe(65536);
		expect(pool.memory.buffer.byteLength).toBe(4 * 65536);
		const sp = await pool.run('sp', 3, () => [0], { grain: 1 });
		expect(sp.results).toEqual([2 * 65536, 3 * 65536, 4 * 65536]);
		const frames = await pool.run('frame', 12, (from) => [from], { grain: 1, audit: true });
		expect(frames.results).toEqual(Array.from({ length: 12 }, (_, index) => index * 3));
	} finally {
		await pool.close();
	}
});

test('i64 arguments and results cross the thread boundary as bigint', async () => {
	const wide = compile(`(module (import "env" "memory" (memory 1 8))
		(func (export "twice") (param i64) (result i64) (i64.mul (local.get 0) (i64.const 2))))`);
	const pool = await open(wide, { workers: 2 });
	try {
		const big = 2n ** 62n + 5n;
		const report = await pool.run('twice', 2, (from) => [big + BigInt(from)], { grain: 1 });
		expect(report.results).toEqual([
			BigInt.asIntN(64, big * 2n),
			BigInt.asIntN(64, (big + 1n) * 2n)
		]);
	} finally {
		await pool.close();
	}
});

test('the audit throws when slices share state through a ticket counter', async () => {
	const tickets = compile(`(module (import "env" "memory" (memory 1 8 shared))
		(func (export "ticket") (param $slice i32) (result i32)
			(i32.atomic.rmw.add (i32.const 64) (i32.const 1))))`);
	const pool = await open(tickets, { workers: 4 });
	try {
		const error = await pool
			.run('ticket', 64, () => [0], { grain: 1, audit: true })
			.catch((reason) => reason);
		expect(error).toBeInstanceOf(SliceConflictError);
		expect(error.kind).toBe('result');
	} finally {
		await pool.close();
	}
});

test('the audit names the first differing byte when the results agree but the memory does not', async () => {
	const stamp = compile(`(module (import "env" "memory" (memory 1 8))
		(global $sp (mut i32) (i32.const 65536))
		(func (export "stamp") (param $slice i32) (result i32)
			(i32.store (i32.add (i32.const 300) (i32.mul (local.get $slice) (i32.const 4))) (global.get $sp))
			(i32.const 0)))`);
	const pool = await open(stamp, { workers: 4 });
	try {
		// each slice records its worker's stack pointer, which the serial run takes from worker 0
		const error = await pool
			.run('stamp', 2, (from) => [from], { grain: 1, audit: true })
			.catch((reason) => reason);
		expect(error).toBeInstanceOf(SliceConflictError);
		expect(error.kind).toBe('memory');
		expect(error.at).toBe(306);
	} finally {
		await pool.close();
	}
});

test('open and run refuse what they cannot run in place', async () => {
	await expect(
		SlicePool.open(plain, { memory: new WebAssembly.Memory({ initial: 1, maximum: 2 }) })
	).rejects.toThrow('shared memory');
	await expect(
		SlicePool.open(
			compile(`(module (import "env" "memory" (memory 1 8))
				(global $a (mut i32) (i32.const 1)) (global $b (mut i32) (i32.const 2))
				(func (export "f") (global.set $a (global.get $b))))`),
			{ memory: memory() }
		)
	).rejects.toThrow('mutable globals');
	await expect(
		SlicePool.open(compile('(module (memory (export "m") 1 2))'), { memory: memory() })
	).rejects.toThrow(TypeError);
	await expect(SlicePool.open(withStack, { memory: memory(2), workers: 3 })).rejects.toThrow(
		'no room for 3 stacks'
	);
	await expect(SlicePool.open(withStack, { memory: memory(), stackBytes: 1000 })).rejects.toThrow(
		'multiple of 65536'
	);
	await expect(SlicePool.open(plain, { memory: memory(), workers: 0 })).rejects.toThrow(
		RangeError
	);
	const pool = await open(plain, { workers: 1 });
	await expect(pool.run('missing', 1, () => [])).rejects.toThrow('exports no function');
	await expect(pool.run('fill', -1, () => [])).rejects.toThrow(RangeError);
	await expect(pool.run('fill', 1, () => [], { grain: 0 })).rejects.toThrow(RangeError);
	await pool.close();
	await expect(pool.run('fill', 1, () => [])).rejects.toThrow('closed');
});

test('a trap in a slice rejects the run', async () => {
	const trap = compile(`(module (import "env" "memory" (memory 1 8))
		(func (export "boom") (param i32) (unreachable)))`);
	const pool = await open(trap, { workers: 2 });
	try {
		await expect(pool.run('boom', 2, () => [0])).rejects.toThrow('failed on worker');
	} finally {
		await pool.close();
	}
});

test('the memory import patch marks a memory shared and refuses one without a maximum', () => {
	const bytes = compile('(module (import "env" "memory" (memory 1 4)))');
	expect(() => new WebAssembly.Module(bytes)).not.toThrow();
	const patched = sharedMemoryImport(bytes);
	const shared = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
	expect(
		() => new WebAssembly.Instance(new WebAssembly.Module(patched), { env: { memory: shared } })
	).not.toThrow();
	expect(
		() => new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: shared } })
	).toThrow(WebAssembly.LinkError);
	expect(patched).not.toEqual(bytes);
	expect(() =>
		sharedMemoryImport(compile('(module (import "env" "memory" (memory 1)))'))
	).toThrow('maximum');
	expect(() => sharedMemoryImport(compile('(module (memory 1 2))'))).toThrow('no memory');
});
