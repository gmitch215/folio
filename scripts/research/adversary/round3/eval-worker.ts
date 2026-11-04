import { parentPort } from 'node:worker_threads';
import { evaluate, type Spec } from './lib.ts';

// evaluates one spec at a time on request so the parent can kill a hang
parentPort!.on('message', (msg: { spec: Spec; heavy: boolean }) => {
	const row = evaluate(msg.spec, msg.heavy, (partial) => parentPort!.postMessage({ partial }));
	parentPort!.postMessage({ row });
});
parentPort!.postMessage({ ready: true });
