import { parentPort, workerData } from 'node:worker_threads';
import { decodeValues, encodeValues } from './slices.ts';
import { serveTasks, type TaskLink } from './tasks.ts';

const data = workerData as {
	module: WebAssembly.Module;
	memory: WebAssembly.Memory;
	link: TaskLink;
	slot: { module: string; name: string };
	stack?: { name: string; top: number };
	imports?: string;
};

(async () => {
	const extra: WebAssembly.Imports = data.imports ? (await import(data.imports)).default() : {};
	const imports = {
		...extra,
		[data.slot.module]: { ...(extra[data.slot.module] ?? {}), [data.slot.name]: data.memory }
	};
	const instance = new WebAssembly.Instance(data.module, imports);
	if (data.stack)
		(instance.exports[data.stack.name] as WebAssembly.Global).value = data.stack.top;
	serveTasks(data.link, (name, input) => {
		const result = (instance.exports[name] as CallableFunction)(
			...(decodeValues(String(input)) as (number | bigint)[])
		);
		return result === undefined ? '' : encodeValues(result);
	});
	parentPort!.postMessage({ ready: true });
})();
