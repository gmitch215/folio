import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Coordinator } from '../../src/coordinator.ts';
import { Folio } from '../../src/node.ts';

test('snapshot growth failure executes the original batch without publishing speculative writes', async () => {
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
	const mirror = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
	const effects: number[] = [];
	const scheduler = new Coordinator({
		memory,
		workerMemory: mirror,
		width: 2,
		profile: false,
		dispatch: async () => {
			throw new Error('unavailable mirror must not dispatch');
		},
		native: (call) => {
			const at = Number(call.args[0]);
			effects.push(at);
			new Uint32Array(memory.buffer)[at] = at + 7;
		}
	});
	scheduler.enqueue({ export: 'put', args: [0] });
	scheduler.enqueue({ export: 'put', args: [16384] });
	await scheduler.flush();
	assert.deepEqual(effects, [0, 16384]);
	assert.equal(scheduler.report.workers, 0);
	assert.equal(scheduler.report.fallbacks, 1);
	assert.equal(new Uint32Array(memory.buffer)[16384], 16391);
});

test('unavailable shared snapshot allocation retains a usable native instance', async () => {
	const module = binaryen.parseText(`(module (memory (export "memory") 1 2)
		(func $put (param i32) (i32.store (local.get 0) (i32.const 11)))
		(func (export "main") (result i32)
			(call $put (i32.const 0)) (call $put (i32.const 4)) (i32.load (i32.const 4))))`);
	const bytes = module.emitBinary();
	module.dispose();
	const original = WebAssembly.Memory;
	const replacement = new Proxy(original, {
		construct(target, args) {
			if (args[0]?.shared) throw new RangeError('forced shared allocation refusal');
			return Reflect.construct(target, args);
		}
	});
	let pool: Folio | undefined;
	try {
		WebAssembly.Memory = replacement;
		pool = await Folio.open(bytes, { minimumRegionWork: 0, workers: 2 });
	} finally {
		WebAssembly.Memory = original;
	}
	try {
		assert.ok(pool);
		assert.ok(pool.diagnostics.some((reason) => reason.includes('allocation unavailable')));
		assert.deepEqual((await pool.run('main')).values, [11]);
		assert.equal(pool.memory.buffer instanceof SharedArrayBuffer, false);
		assert.equal(pool.threadIds.length, 0);
	} finally {
		await pool?.close();
	}
});

test('runAll snapshot growth refusal preserves native results and trap prefixes', async () => {
	const module = binaryen.parseText(`(module (memory (export "memory") 1 3)
		(func $put (export "put") (param i32 i32) (result i32)
			(i32.store (local.get 0) (local.get 1)) (local.get 1))
		(func (export "main")
			(drop (call $put (i32.const 0) (i32.const 1)))
			(drop (call $put (i32.const 4) (i32.const 2)))))`);
	const source = module.emitBinary();
	module.dispose();
	const pool = await Folio.open(source, { minimumRegionWork: 0, workers: 2 });
	const originalGrow = WebAssembly.Memory.prototype.grow;
	let refusals = 0;
	try {
		assert.equal(pool.threadIds.length, 2);
		pool.memory.grow(1);
		WebAssembly.Memory.prototype.grow = function (pages: number): number {
			if (this.buffer instanceof SharedArrayBuffer) {
				refusals++;
				throw new RangeError('forced mirror growth refusal');
			}
			return originalGrow.call(this, pages);
		};
		const report = await pool.runAll([
			{ export: 'put', args: [0, 7] },
			{ export: 'put', args: [65536, 11] },
			{ export: 'put', args: [65540, 13] }
		]);
		assert.deepEqual(report.values, [7, 11, 13]);
		assert.equal(report.workers, 0);
		assert.equal(report.mode, 'serial');
		assert.equal(report.fallbacks, 1);
		assert.equal(report.reason, 'snapshot-unavailable');
		assert.equal(refusals, 1);
		await assert.rejects(
			pool.runAll([
				{ export: 'put', args: [4, 17] },
				{ export: 'put', args: [131072, 19] },
				{ export: 'put', args: [8, 23] }
			]),
			WebAssembly.RuntimeError
		);
		const words = new Uint32Array(pool.memory.buffer);
		assert.deepEqual(Array.from(words.slice(0, 3)), [7, 17, 0]);
		assert.equal(words[16384], 11);
		assert.equal(words[16385], 13);
		assert.equal(refusals, 2);
	} finally {
		WebAssembly.Memory.prototype.grow = originalGrow;
		await pool.close();
	}
});

test('the pending flag rises with a queued region and falls once the queue has joined', async () => {
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
	const flag = { value: 0 as unknown };
	let fail = false;
	const scheduler = new Coordinator({
		memory,
		workerMemory: memory,
		width: 2,
		profile: false,
		pending: flag,
		dispatch: async (_, calls) => {
			if (fail) throw new Error('lane lost');
			return calls.map(() => ({ reads: [], writes: [], value: undefined }) as any);
		},
		native: () => {}
	});
	assert.equal(flag.value, 0);
	scheduler.enqueue({ export: 'put', args: [0] });
	assert.equal(flag.value, 1);
	scheduler.enqueue({ export: 'put', args: [4] });
	assert.equal(flag.value, 1);
	await scheduler.flush();
	assert.equal(flag.value, 0);
	assert.equal(scheduler.flush(), undefined);
	fail = true;
	scheduler.enqueue({ export: 'put', args: [0] });
	scheduler.enqueue({ export: 'put', args: [4] });
	await assert.rejects(async () => scheduler.flush(), /lane lost/);
	assert.equal(flag.value, 0);
});

test('the pending flag stays raised while a flush is in flight and while a region is left queued', async () => {
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
	const flag = { value: 0 as unknown };
	const inFlight: unknown[] = [];
	let late: (() => void) | undefined;
	const scheduler = new Coordinator({
		memory,
		workerMemory: memory,
		width: 2,
		profile: false,
		pending: flag,
		dispatch: async (_, calls) => {
			inFlight.push(flag.value);
			await Promise.resolve();
			late?.();
			late = undefined;
			return calls.map(() => ({ reads: [], writes: [], value: undefined }) as any);
		},
		native: () => {}
	});
	scheduler.enqueue({ export: 'put', args: [0] });
	scheduler.enqueue({ export: 'put', args: [4] });
	late = () => scheduler.enqueue({ export: 'put', args: [8] });
	await scheduler.flush();
	assert.deepEqual(inFlight, [1, 1]);
	assert.equal(flag.value, 1);
	await scheduler.flush();
	assert.equal(flag.value, 0);
});
