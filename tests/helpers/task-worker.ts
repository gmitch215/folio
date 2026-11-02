import { parentPort, workerData } from 'node:worker_threads';
import { serveTasks, type TaskInput, type TaskLink } from '../../src/tasks.ts';

const { index, link } = workerData as { index: number; link: TaskLink };
const gate = new Int32Array(new SharedArrayBuffer(4));
let calls = 0;

function sleep(ms: number): void {
	Atomics.wait(gate, 0, 0, ms);
}

function spin(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until);
}

serveTasks(link, (name: string, input: TaskInput) => {
	if (name === 'isShared')
		return typeof input !== 'string' && input.buffer instanceof SharedArrayBuffer ? '1' : '0';
	if (name === 'afterWrite') {
		const bytes = input as Uint8Array;
		const flags = new Int32Array(bytes.buffer, bytes.byteOffset, 2);
		if (!(bytes.buffer instanceof SharedArrayBuffer)) {
			sleep(100);
			return String(flags[0]);
		}
		Atomics.store(flags, 1, 1);
		Atomics.notify(flags, 1);
		Atomics.wait(flags, 0, 1, 5000);
		return String(Atomics.load(flags, 0));
	}
	const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
	switch (name) {
		case 'upper':
			return text.toUpperCase();
		case 'sum':
			return String((JSON.parse(text) as number[]).reduce((a, b) => a + b, 0));
		case 'sleep':
			sleep(Number(text));
			return String(index);
		case 'spin':
			spin(Number(text));
			return text;
		case 'bytes':
			return Uint8Array.from(text.split(',').map(Number)).reverse();
		case 'where':
			return `worker ${index}`;
		case 'counter':
			return String(++calls);
		case 'fail':
			throw new Error(`refused ${text}`);
		default:
			throw new Error(`unknown task ${name}`);
	}
});

parentPort!.postMessage('ready');
