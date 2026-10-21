import { parentPort } from 'node:worker_threads';
import type { BrowserWorkerScope } from '../../src/browser-worker.ts';
import { installBrowserWorker } from '../../src/browser-worker.ts';

const scope: BrowserWorkerScope = {
	onmessage: null,
	postMessage: (value) => parentPort!.postMessage(value)
};
installBrowserWorker(scope);
parentPort!.on('message', (data) => scope.onmessage!({ data }));
