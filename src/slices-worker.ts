import { parentPort, workerData } from 'node:worker_threads';
import { decodeValues, encodeValues } from './slices.ts';
import { serveTasks, type TaskLink } from './tasks.ts';

const data = workerData as {
	module: WebAssembly.Module;
	memory: WebAssembly.Memory;
	link: TaskLink;
	slot: { module: string; name: string };
	stack?: { name: string; top: number };
	windows?: { low: number; end: number; delta: string; copy: number }[];
	imports?: string;
};

(async () => {
	const extra: WebAssembly.Imports = data.imports ? (await import(data.imports)).default() : {};
	const imports = {
		...extra,
		[data.slot.module]: { ...(extra[data.slot.module] ?? {}), [data.slot.name]: data.memory }
	};
	const instance = new WebAssembly.Instance(data.module, imports);
	const stack = data.stack && (instance.exports[data.stack.name] as WebAssembly.Global);
	if (stack) stack.value = data.stack!.top;
	for (const w of data.windows ?? [])
		(instance.exports[w.delta] as WebAssembly.Global).value = w.copy - w.low;
	serveTasks(data.link, (name, input) => {
		if (data.windows) {
			// a trap leaves the stack pointer deep, and the last slice left its own bytes in the copies
			if (stack) stack.value = data.stack!.top;
			const bytes = new Uint8Array(data.memory.buffer);
			for (const w of data.windows) bytes.copyWithin(w.copy, w.low, w.end);
		}
		const result = (instance.exports[name] as CallableFunction)(
			...(decodeValues(String(input)) as (number | bigint)[])
		);
		return result === undefined ? '' : encodeValues(result);
	});
	parentPort!.postMessage({ ready: true });
})();
