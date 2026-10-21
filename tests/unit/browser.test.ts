import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { test } from 'vitest';
import type { BrowserProgram, BrowserWorkerPort } from '../../src/browser.ts';
import { BrowserFolio } from '../../src/browser.ts';
import { prepare } from '../../src/compiler.ts';
import { memoryImports } from '../../src/memory.ts';

class Bridge extends EventTarget implements BrowserWorkerPort {
	readonly worker: NodeWorker;
	terminated = false;
	constructor() {
		super();
		this.worker = new NodeWorker(
			new URL('../helpers/browser-worker-bridge.ts', import.meta.url)
		);
		this.worker.on('message', (data) =>
			this.dispatchEvent(new MessageEvent('message', { data }))
		);
		this.worker.on('error', (error) => {
			const event = new Event('error');
			Object.assign(event, { message: String(error) });
			this.dispatchEvent(event);
		});
	}
	postMessage(message: unknown) {
		this.worker.postMessage(message);
	}
	terminate() {
		this.terminated = true;
		void this.worker.terminate();
	}
}

const source = readFileSync(new URL('../../build/fixture.wasm', import.meta.url));
const prepared = prepare(source);
const program: BrowserProgram = {
	module: new WebAssembly.Module(source),
	loops: prepared.loops,
	native: prepared.native,
	reasons: prepared.reasons,
	memories: memoryImports(source)
};
const memory = () => new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });

function wasm(text: string): BrowserProgram {
	const parsed = binaryen.parseText(text);
	try {
		const bytes = parsed.emitBinary();
		return {
			module: new WebAssembly.Module(Uint8Array.from(bytes)),
			loops: {},
			reasons: ['native-only test artifact'],
			memories: memoryImports(bytes)
		};
	} finally {
		parsed.dispose();
	}
}

test('browser derives nondivisible whole-entry regions on real worker threads and restores alias marker', async () => {
	const arena = memory();
	const reference = memory();
	const words = new Uint32Array(arena.buffer);
	words[0] = 0x89abcdef;
	for (let index = 0; index < 19; index++) words[256 + index] = index + 3;
	new Uint8Array(reference.buffer).set(new Uint8Array(arena.buffer));
	const owner = new WebAssembly.Instance(program.module, { env: { memory: reference } });
	const workers: Bridge[] = [];
	const pool = await BrowserFolio.open(program, {
		memory: arena,
		workers: 4,
		minimumParallelWork: 0,
		workerFactory: () => {
			const worker = new Bridge();
			workers.push(worker);
			return worker;
		}
	});
	try {
		assert.equal(words[0], 0x89abcdef);
		assert.equal(pool.inspect('program').mechanism, 'counted-loop');
		assert.equal(pool.inspect('program').workers, 4);
		(owner.exports.program as CallableFunction)(1024, 19, 37);
		const report = await pool.run('program', [1024, 19, 37]);
		assert.equal(report.mode, 'native-shared');
		assert.equal(report.regions, 4);
		assert.deepEqual(new Uint8Array(arena.buffer), new Uint8Array(reference.buffer));
		arena.grow(1);
		reference.grow(1);
		new Uint32Array(arena.buffer)[32768] = 9;
		new Uint32Array(reference.buffer)[32768] = 9;
		(owner.exports.program as CallableFunction)(131072, 2, 17);
		assert.equal((await pool.run('program', [131072, 2, 17])).mode, 'native-shared');
		assert.deepEqual(new Uint8Array(arena.buffer), new Uint8Array(reference.buffer));
	} finally {
		await pool.close();
	}
	assert.ok(workers.every((worker) => worker.terminated));
	await assert.rejects(pool.run('program', [1024, 1, 1]), /closed/);
});

test('browser guards overlap, bounds and pointer wrap before dispatch and leaves native traps ordered', async () => {
	let runs = 0;
	const crafted = structuredClone({ loops: program.loops, native: program.native });
	// trusted metadata is widened only for exercising the runtime refusal paths
	crafted.native!.program!.accesses.push({ parameter: 3, offset: 0, bytes: 4, write: true });
	const pool = await BrowserFolio.open(
		{ ...program, ...crafted },
		{
			memory: memory(),
			workers: 2,
			minimumParallelWork: 0,
			workerFactory: () => {
				const worker = new Bridge();
				const send = worker.postMessage.bind(worker);
				worker.postMessage = (message: any) => {
					if (message.action === 'run') runs++;
					send(message);
				};
				return worker;
			}
		}
	);
	try {
		assert.equal((await pool.run('program', [1024, 4, 1, 1024])).reason, 'guard-failed');
		assert.equal(runs, 0);
		await assert.rejects(pool.run('program', [131068, 2, 1]), WebAssembly.RuntimeError);
		await assert.rejects(pool.run('program', [0xfffffffc, 2, 1]), WebAssembly.RuntimeError);
		assert.equal(runs, 0);
	} finally {
		await pool.close();
	}
});

test('browser native fallback preserves starts, data, globals, externref Promise and exception identity', async () => {
	const input = wasm(`(module
		(import "host" "start" (func $start)) (start $start)
		(import "host" "fail" (func $fail))
		(memory (export "memory") 1) (data (i32.const 8) "folio")
		(global $g (mut i32) (i32.const 4))
		(func (export "step") (result i32)
			(global.set $g (i32.add (global.get $g) (i32.const 1))) (global.get $g))
		(func (export "echo") (param externref) (result externref) (local.get 0))
		(func (export "fail") (call $fail)))`);
	let starts = 0;
	const failure = { exact: true };
	const pool = await BrowserFolio.open(input, {
		imports: {
			host: {
				start: () => starts++,
				fail: () => {
					throw failure;
				}
			}
		},
		workerFactory: () => {
			throw new Error('native modules must not create a worker');
		}
	});
	try {
		assert.equal(starts, 1);
		assert.equal((await pool.run('step')).values[0], 5);
		const promise = Promise.resolve(11);
		assert.equal((await pool.run('echo', [promise])).values[0], promise);
		const object = {};
		assert.equal((await pool.run('echo', [object])).values[0], object);
		await assert.rejects(pool.run('fail'), (error) => error === failure);
		assert.equal(
			new TextDecoder().decode(
				new Uint8Array((pool.exports.memory as WebAssembly.Memory).buffer, 8, 5)
			),
			'folio'
		);
	} finally {
		await pool.close();
	}
});

test('browser coerces opaque inputs once and keeps small workloads at the owner', async () => {
	const pool = await BrowserFolio.open(program, {
		memory: memory(),
		workers: 2,
		workerFactory: () => new Bridge()
	});
	try {
		let coerced = 0;
		const pointer = {
			valueOf() {
				coerced++;
				return 1024;
			}
		};
		assert.equal((await pool.run('program', [pointer, 3, 1])).reason, 'opaque-input');
		assert.equal(coerced, 1);
		assert.equal((await pool.run('program', [1024, 3, 1])).reason, 'small-workload');
		assert.equal((await pool.run('increment', [1024])).mode, 'serial');
	} finally {
		await pool.close();
	}
});

test('browser joins active work before close and refuses concurrent calls', async () => {
	const workers: Bridge[] = [];
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pool = await BrowserFolio.open(program, {
		memory: memory(),
		workers: 2,
		minimumParallelWork: 0,
		workerFactory: () => {
			const worker = new Bridge();
			const send = worker.postMessage.bind(worker);
			worker.postMessage = (message: any) => {
				if (message.action === 'run') void wait.then(() => send(message));
				else send(message);
			};
			workers.push(worker);
			return worker;
		}
	});
	const running = pool.run('program', [1024, 7, 37]);
	await assert.rejects(pool.run('program', [1024, 7, 37]), /active run/);
	const closing = pool.close();
	assert.ok(workers.every((worker) => !worker.terminated));
	release();
	assert.equal((await running).mode, 'native-shared');
	await closing;
	assert.ok(workers.every((worker) => worker.terminated));
});

test('browser initialization failures clean up workers and restore marker', async () => {
	const arena = memory();
	new Uint32Array(arena.buffer)[0] = 123456;
	const workers: Bridge[] = [];
	await assert.rejects(
		BrowserFolio.open(program, {
			memory: arena,
			workers: 2,
			workerFactory: (index) => {
				if (index === 1) throw new Error('injected startup failure');
				const worker = new Bridge();
				workers.push(worker);
				return worker;
			}
		}),
		/injected startup failure/
	);
	assert.equal(new Uint32Array(arena.buffer)[0], 123456);
	assert.ok(workers.every((worker) => worker.terminated));
});

test('browser joins other lanes after a direct-write error and invalidates the arena', async () => {
	let completed = 0;
	const workers: Bridge[] = [];
	const pool = await BrowserFolio.open(program, {
		memory: memory(),
		workers: 2,
		minimumParallelWork: 0,
		workerFactory: (index) => {
			const worker = new Bridge();
			const send = worker.postMessage.bind(worker);
			worker.postMessage = (message: any) => {
				if (message.action === 'run' && index === 0)
					queueMicrotask(() =>
						worker.dispatchEvent(
							new MessageEvent('message', {
								data: { sequence: message.sequence, error: 'injected lane failure' }
							})
						)
					);
				else {
					if (message.action === 'run')
						worker.addEventListener(
							'message',
							() => {
								completed++;
							},
							{ once: true }
						);
					send(message);
				}
			};
			workers.push(worker);
			return worker;
		}
	});
	await assert.rejects(pool.run('program', [1024, 7, 37]), /checkpoint recovery/);
	assert.equal(completed, 1);
	assert.ok(workers.every((worker) => worker.terminated));
	await assert.rejects(pool.run('program', [1024, 7, 37]), /checkpoint recovery/);
	await pool.close();
});

test('browser rejects copied shared allocations during the two-way alias handshake', async () => {
	const arena = memory();
	new Uint32Array(arena.buffer)[0] = 0xabcdef01;
	const workers: Bridge[] = [];
	await assert.rejects(
		BrowserFolio.open(program, {
			memory: arena,
			workers: 2,
			workerFactory: () => {
				const worker = new Bridge();
				const send = worker.postMessage.bind(worker);
				worker.postMessage = (message: any) => {
					if (message.action === 'attach') {
						const copied = memory();
						new Int32Array(copied.buffer)[0] = message.before;
						send({ ...message, memory: copied });
					} else send(message);
				};
				workers.push(worker);
				return worker;
			}
		}),
		/alias handshake failed/
	);
	assert.equal(new Uint32Array(arena.buffer)[0], 0xabcdef01);
	assert.ok(workers.every((worker) => worker.terminated));
});
