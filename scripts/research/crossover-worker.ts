import { parentPort, workerData } from 'node:worker_threads';
const { module, memory } = workerData as { module: WebAssembly.Module; memory: WebAssembly.Memory };
const instance = new WebAssembly.Instance(module, { env: { memory } });
parentPort!.on('message', ({ id, args }) => {
	try {
		(instance.exports.program as CallableFunction)(...args);
		parentPort!.postMessage({ id });
	} catch (error) {
		parentPort!.postMessage({ id, error: String(error) });
	}
});
parentPort!.postMessage({ ready: true });
