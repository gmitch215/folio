// usage: node copy-bandwidth.mjs ; aggregate bytes per second when 1, 2, 4 and 8 threads each copy a shared buffer into a wasm memory
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const size = 64 * 1048576;
const repeats = 4;

if (isMainThread) {
	for (const threads of [1, 2, 4, 8]) {
		const shared = new SharedArrayBuffer(size * threads);
		new Uint8Array(shared).fill(7);
		const workers = Array.from(
			{ length: threads },
			(_, index) => new Worker(new URL(import.meta.url), { workerData: { shared, index } })
		);
		await Promise.all(
			workers.map((worker) => new Promise((resolve) => worker.once('message', resolve)))
		);
		const start = performance.now();
		const done = workers.map(
			(worker) => new Promise((resolve) => worker.once('message', resolve))
		);
		for (const worker of workers) worker.postMessage('go');
		await Promise.all(done);
		const ms = performance.now() - start;
		const bytes = size * repeats * threads;
		console.log(
			JSON.stringify({
				threads,
				mebibytes: bytes / 1048576,
				ms: Number(ms.toFixed(1)),
				gigabytesPerSecond: Number((bytes / ms / 1e6).toFixed(1))
			})
		);
		for (const worker of workers) worker.terminate();
	}
} else {
	const source = new Uint8Array(workerData.shared, workerData.index * size, size);
	const target = new Uint8Array(new WebAssembly.Memory({ initial: size / 65536 }).buffer);
	target.fill(1);
	parentPort.postMessage('ready');
	parentPort.once('message', () => {
		for (let round = 0; round < repeats; round++) target.set(source, 0);
		parentPort.postMessage('done');
	});
}
