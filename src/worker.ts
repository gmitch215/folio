import { parentPort, threadId, workerData } from 'node:worker_threads';
import { SpeculationLimit, transaction } from './transaction.ts';
import { numberBits, restoreNumbers } from './values.ts';

const { module, nativeModule, memory, importModule, importName } = workerData;
const nativeInstance = new WebAssembly.Instance(nativeModule, {
	[importModule]: { [importName]: memory }
});
let active: ReturnType<typeof transaction>;
const instance = new WebAssembly.Instance(module, {
	[importModule]: { [importName]: memory },
	folio: {
		...(importModule === 'folio' ? { [importName]: memory } : {}),
		load: (...args: [number, number, number, number]) => active.load(...args),
		store: (...args: [number, number, number, number]) => active.store(...args),
		load64: (...args: [number, number, number, number]) => active.load64(...args),
		store64: (...args: [number, bigint, number, number]) => active.store64(...args),
		copy: (...args: [number, number, number]) => active.copy(...args),
		fill: (...args: [number, number, number]) => active.fill(...args),
		exhausted: () => {
			throw new SpeculationLimit('speculative instruction budget');
		}
	}
});
function execute(
	call: { export: string; args: any[] },
	argumentBits: any,
	fuel: number,
	maxBytes: number,
	native: boolean,
	profile: boolean
) {
	if (argumentBits !== undefined) call.args = restoreNumbers(call.args, argumentBits) as any[];
	const start = profile ? performance.now() : 0;
	const cpuStart = profile ? process.threadCpuUsage() : undefined;
	if (!native) active = transaction(memory, maxBytes);
	let value: unknown;
	let error: unknown;
	try {
		if (native) {
			value = (nativeInstance.exports[call.export] as CallableFunction)(...call.args);
		} else {
			(instance.exports.__folio_set_fuel as CallableFunction)(fuel);
			value = (instance.exports[call.export] as CallableFunction)(...call.args);
		}
	} catch (caught) {
		error = caught;
	}
	const result = native
		? { value, reads: [], writes: [], ...(error ? { trap: String(error) } : {}) }
		: active.result(value, error);
	const cpu = profile ? process.threadCpuUsage(cpuStart) : undefined;
	const timing = cpu
		? { wallMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000 }
		: undefined;
	const encoded = native ? undefined : numberBits(value);
	return {
		...result,
		...(encoded === undefined ? {} : { numberBits: encoded }),
		...(timing ? { timing } : {})
	};
}
parentPort!.on('message', ({ id, call, calls, argumentBits, fuel, maxBytes, native, profile }) => {
	if (calls) {
		let remaining = maxBytes;
		const results = calls.map((call: { export: string; args: any[] }, index: number) => {
			if (remaining <= 0)
				return {
					reads: [],
					writes: [],
					exhausted: true,
					...(profile ? { timing: { wallMs: 0, cpuMs: 0 } } : {})
				};
			const result = execute(call, argumentBits?.[index], fuel, remaining, false, profile);
			remaining -= result.reads.length + result.writes.length;
			return result;
		});
		parentPort!.postMessage({ id, results });
	} else
		parentPort!.postMessage({
			id,
			...execute(call, argumentBits, fuel, maxBytes, native, profile)
		});
});
parentPort!.postMessage({
	ready: true,
	threadId,
	shared: memory.buffer instanceof SharedArrayBuffer
});
