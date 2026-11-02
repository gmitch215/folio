import { parentPort, workerData } from 'node:worker_threads';
import { serveTasks, type TaskLink } from '../../src/tasks.ts';
import { hostMath, specOf } from './c21-common.ts';

// records stay where the serial program put them: every worker runs a slice of the bulk entry on the one shared memory
if (workerData?.c21Inplace) {
	const data = workerData as {
		spec: string;
		module: WebAssembly.Module;
		memory: WebAssembly.Memory;
		link: TaskLink;
		table: number;
		out: number;
		stack?: string;
		stackTop: number;
	};
	const slot = specOf(data.spec).slot;
	const instance = new WebAssembly.Instance(data.module, {
		env: { memory: data.memory, ...hostMath() }
	});
	if (data.stack) (instance.exports[data.stack] as WebAssembly.Global).value = data.stackTop;
	const bulk = (instance.exports as Record<string, CallableFunction>).bulk!;
	serveTasks(data.link, (_name, input) => {
		const [from, to] = String(input).split(',').map(Number) as [number, number];
		bulk(data.table + 16 * from, to - from, data.out + from * slot);
		return '';
	});
	parentPort!.postMessage({ ready: true });
}
