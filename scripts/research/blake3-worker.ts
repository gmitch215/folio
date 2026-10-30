import { parentPort, workerData } from 'node:worker_threads';
import type { PreparedContext } from '../../src/compiler.ts';
import { InstanceCheckpoint } from '../../src/context.ts';
import { serveTasks, type TaskLink } from '../../src/tasks.ts';

export const BASE = 1 << 20;
export const DATA = BASE + 65536;

/** Memory pages for a context that holds one input of `bytes` after the 1 MiB layout. */
export const contextPages = (bytes: number) => Math.ceil((DATA + bytes + 64) / 65536) + 1;

/** A private initialized context that hashes one input; every call restores the checkpoint first. */
export function hashContext(module: WebAssembly.Module, layout: PreparedContext, bytes: number) {
	const pages = contextPages(bytes);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
	const instance = new WebAssembly.Instance(module, { env: { memory } });
	const hash = instance.exports.hash_all as CallableFunction;
	const checkpoint = new InstanceCheckpoint(instance, layout);
	return (input: Uint8Array) => {
		checkpoint.restore();
		new Uint8Array(memory.buffer).set(input, DATA);
		new Uint32Array(memory.buffer, BASE, 2).set([DATA, input.length]);
		hash(BASE, 1, BASE + 16);
		return new Uint8Array(memory.buffer.slice(BASE + 16, BASE + 48));
	};
}

if (workerData?.blake3Worker) {
	const data = workerData as {
		module: WebAssembly.Module;
		layout: PreparedContext;
		link: TaskLink;
		bytes: number;
	};
	const run = hashContext(data.module, data.layout, data.bytes);
	serveTasks(data.link, (_name, input) => run(input as Uint8Array));
	parentPort!.postMessage({ ready: true });
}
