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

const overwrite = process.env.C21_OVERWRITE === '1';

/** The bytes `writeRecords` sets for a task, so a restore need not rebuild them first. */
const writtenRanges = (
	spec: Spec,
	layout: ReturnType<typeof contextLayout>,
	records: { input: Uint8Array }[]
) => {
	const ranges = [{ offset: layout.table, length: 16 * records.length }];
	let at = layout.data;
	records.forEach((record, i) => {
		ranges.push({ offset: at, length: record.input.length });
		if (spec.auxBytes)
			ranges.push({ offset: layout.aux + i * spec.auxBytes, length: spec.auxBytes });
		at += Math.ceil((record.input.length + 32) / 32) * 32;
	});
	return ranges;
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
		const t0 = performance.now();
		const reset = checkpoint.restore(
			'changed',
			overwrite ? writtenRanges(spec, layout, records) : []
		);
		const t1 = performance.now();
		writeRecords(memory, spec, layout, records, true);
		const t2 = performance.now();
		exports.bulk!(layout.table, count, layout.out);
		const t3 = performance.now();
		const result = new Uint8Array(
			memory.buffer.slice(layout.out, layout.out + count * spec.slot)
		);
		phases.restoreMs += t1 - t0;
		phases.writeMs += t2 - t1;
		phases.bulkMs += t3 - t2;
		phases.copyMs += performance.now() - t3;
		phases.tasks++;
		phases.checkedBytes += reset.checkedBytes;
		phases.copiedBytes += reset.copiedBytes;
		phases.skippedBytes += reset.skippedBytes;
		return result;
	};
}

const blank = () => ({
	tasks: 0,
	restoreMs: 0,
	writeMs: 0,
	bulkMs: 0,
	copyMs: 0,
	checkedBytes: 0,
	copiedBytes: 0,
	skippedBytes: 0
});
let phases = blank();

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
	serveTasks(data.link, (name, input) => {
		if (name !== 'stats') return run(input as Uint8Array);
		const seen = phases;
		phases = blank();
		return JSON.stringify(seen);
	});
	parentPort!.postMessage({ ready: true });
}
