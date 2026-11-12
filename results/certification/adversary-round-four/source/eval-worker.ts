import { parentPort } from 'node:worker_threads';
import { evaluate, type Rec } from './lib.ts';

parentPort!.on('message', (msg: { rec: Rec; heavy: boolean }) => {
	parentPort!.postMessage({
		row: evaluate(msg.rec, msg.heavy, (partial) => parentPort!.postMessage({ partial }))
	});
});
parentPort!.postMessage({ ready: true });
