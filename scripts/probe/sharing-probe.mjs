import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';

if (!isMainThread) {
	const module = workerData.module;
	if (workerData.creator) {
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
		new Uint32Array(memory.buffer)[0] = 47;
		parentPort.postMessage({ memory });
	} else {
		let memory, buffer, oldView, instance;
		parentPort.on('message', (message) => {
			if (message.action === 'attach') {
				memory = message.memory;
				buffer = memory?.buffer ?? message.buffer;
				oldView = new Uint8Array(buffer);
				if (memory) instance = new WebAssembly.Instance(module, { env: { memory } });
				let sum = 0;
				for (let at = 0; at < buffer.byteLength; at += 4096) sum += oldView[at];
				parentPort.postMessage({ threadId, sum, length: buffer.byteLength });
			} else if (message.action === 'write') {
				for (let i = 0; i < 10000; i++) instance.exports.add(0, 1);
				instance.exports.write(message.address, message.value);
				parentPort.postMessage({ read: instance.exports.read(message.address) });
			} else if (message.action === 'grow') {
				const fresh = new Uint8Array(memory.buffer);
				const zero = fresh[message.address];
				instance.exports.write(message.address, 12345);
				parentPort.postMessage({
					zero,
					oldLength: oldView.byteLength,
					newLength: fresh.byteLength
				});
			}
		});
		parentPort.postMessage({ ready: true, threadId });
	}
} else {
	const mode = process.argv[2] ?? 'shared';
	const mib = Number(process.argv[3] ?? 64);
	const module = new WebAssembly.Module(
		readFileSync(new URL('../../build/sharing.wasm', import.meta.url))
	);
	const request = (worker, message) =>
		new Promise((resolve, reject) => {
			const fail = (error) => {
				worker.off('message', done);
				reject(error);
			};
			const done = (value) => {
				worker.off('error', fail);
				resolve(value);
			};
			worker.once('message', done);
			worker.once('error', fail);
			worker.postMessage(message);
		});
	const workers = [];
	try {
		for (let i = 0; i < 4; i++) {
			const worker = new Worker(new URL(import.meta.url), { workerData: { module } });
			workers.push(worker);
			await new Promise((resolve, reject) => {
				worker.once('message', resolve);
				worker.once('error', reject);
			});
		}
		globalThis.gc?.();
		const rssIdle = process.memoryUsage().rss;
		const memory =
			mode === 'shared'
				? new WebAssembly.Memory({ initial: mib * 16, maximum: 8192, shared: true })
				: undefined;
		const buffer = memory?.buffer ?? new ArrayBuffer(mib * 1024 * 1024);
		const bytes = new Uint8Array(buffer);
		for (let at = 0; at < bytes.length; at += 4096) bytes[at] = 7;
		const rssAllocated = process.memoryUsage().rss;
		const attached = [];
		for (const worker of workers)
			attached.push(
				await request(worker, {
					action: 'attach',
					memory,
					buffer: memory ? undefined : buffer
				})
			);
		globalThis.gc?.();
		const rssAttached = process.memoryUsage().rss;
		for (const result of attached) assert.equal(result.sum, (bytes.length / 4096) * 7);
		const mutations = [];
		if (memory) {
			Atomics.store(new Int32Array(memory.buffer), 0, 0);
			for (let index = 0; index < workers.length; index++) {
				mutations.push(
					request(workers[index], {
						action: 'write',
						address: 16 + index * 4,
						value: index + 100
					})
				);
			}
			await Promise.all(mutations);
			assert.equal(Atomics.load(new Int32Array(memory.buffer), 0), 40000);
			for (let index = 0; index < workers.length; index++)
				assert.equal(new Uint32Array(memory.buffer)[4 + index], index + 100);
			const oldLength = memory.buffer.byteLength;
			memory.grow(1);
			const growth = await request(workers[0], { action: 'grow', address: oldLength });
			assert.deepEqual(growth, { zero: 0, oldLength, newLength: oldLength + 65536 });
			assert.equal(new Uint32Array(memory.buffer)[oldLength / 4], 12345);
			console.log(JSON.stringify({ kind: 'growth', ...growth, passed: true }));
		}
		console.log(
			JSON.stringify({
				kind: 'sharing',
				mode,
				mib,
				isolates: attached.map((item) => item.threadId),
				rssIdle,
				rssAllocated,
				rssAttached,
				attachDelta: rssAttached - rssAllocated,
				passed: true,
				node: process.version,
				v8: process.versions.v8,
				cpu: cpus()[0].model,
				load: loadavg()
			})
		);
		if (mode === 'shared') {
			const creator = new Worker(new URL(import.meta.url), {
				workerData: { creator: true, module }
			});
			const exit = new Promise((resolve, reject) => {
				creator.once('exit', resolve);
				creator.once('error', reject);
			});
			const owned = await new Promise((resolve, reject) => {
				creator.once('message', resolve);
				creator.once('error', reject);
			});
			assert.equal(await exit, 0);
			assert.equal(new Uint32Array(owned.memory.buffer)[0], 47);
			await request(workers[0], { action: 'attach', memory: owned.memory });
			await request(workers[0], { action: 'write', address: 16, value: 999 });
			assert.equal(new Uint32Array(owned.memory.buffer)[4], 999);
			console.log(JSON.stringify({ kind: 'creator-exit', survived: true, passed: true }));
		}
	} finally {
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}
