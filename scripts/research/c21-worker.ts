import { parentPort, workerData } from 'node:worker_threads';
import type { PreparedContext } from '../../src/compiler.ts';
import { InstanceCheckpoint } from '../../src/context.ts';
import { serveTasks, type TaskLink } from '../../src/tasks.ts';
import { hostMath, specOf, writeRecords } from './c21-common.ts';
import { layoutOf, type Spec } from './c21-kernels.ts';

// one private context per worker: the arena and the config exist once, every task restores first
export const contextLayout = (spec: Spec, chunk: number, inputCap: number) =>
	layoutOf(spec, chunk, Array(chunk).fill(inputCap), { arenaSlices: 1, configCopies: 1 });

/** A task is a count, then per record a length, the input bytes padded to 8, and the aux bytes. */
export const encodeTask = (
	spec: Spec,
	records: { input: Uint8Array; aux: Uint8Array }[],
	shared = false
) => {
	const size = records.reduce(
		(n, r) => n + 8 + Math.ceil(r.input.length / 8) * 8 + spec.auxBytes,
		8
	);
	const bytes = new Uint8Array(shared ? new SharedArrayBuffer(size) : new ArrayBuffer(size));
	const view = new DataView(bytes.buffer);
	view.setUint32(0, records.length, true);
	let at = 8;
	for (const r of records) {
		view.setUint32(at, r.input.length, true);
		bytes.set(r.input, at + 8);
		at += 8 + Math.ceil(r.input.length / 8) * 8;
		bytes.set(r.aux, at);
		at += spec.auxBytes;
	}
	return bytes;
};

export function taskContext(
	spec: Spec,
	module: WebAssembly.Module,
	plan: PreparedContext,
	chunk: number,
	inputCap: number
) {
	const layout = contextLayout(spec, chunk, inputCap);
	const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	const instance = new WebAssembly.Instance(module, { env: { memory, ...hostMath() } });
	const exports = instance.exports as Record<string, CallableFunction>;
	if (spec.config) exports.setup!(layout.config, 1, spec.config.nfft);
	const checkpoint = new InstanceCheckpoint(instance, plan);
	return (task: Uint8Array) => {
		checkpoint.restore();
		const view = new DataView(task.buffer, task.byteOffset, task.byteLength);
		const count = view.getUint32(0, true);
		const records: { input: Uint8Array; aux: Uint8Array }[] = [];
		let at = 8;
		for (let i = 0; i < count; i++) {
			const length = view.getUint32(at, true);
			const input = task.subarray(at + 8, at + 8 + length);
			at += 8 + Math.ceil(length / 8) * 8;
			records.push({ input, aux: task.subarray(at, at + spec.auxBytes) });
			at += spec.auxBytes;
		}
		writeRecords(memory, spec, layout, records, true);
		exports.bulk!(layout.table, count, layout.out);
		return new Uint8Array(memory.buffer.slice(layout.out, layout.out + count * spec.slot));
	};
}

if (workerData?.c21Worker) {
	const data = workerData as {
		spec: string;
		module: WebAssembly.Module;
		plan: PreparedContext;
		link: TaskLink;
		chunk: number;
		inputCap: number;
	};
	const run = taskContext(specOf(data.spec), data.module, data.plan, data.chunk, data.inputCap);
	serveTasks(data.link, (_name, input) => run(input as Uint8Array));
	parentPort!.postMessage({ ready: true });
}
