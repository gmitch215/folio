import { readFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { serveTasks, type TaskLink } from '../../src/tasks.ts';
import { base } from './sweeps-engine.ts';

const { link, wasm, entry } = workerData as { link: TaskLink; wasm: string; entry: string };

const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm)), {});
const exports = instance.exports as Record<string, unknown> & { memory: WebAssembly.Memory };
const run = exports[entry] as (state: number, ptr: number, len: number) => number;

// task `sweep:<hex start state>`; input is one chunk; output is its end state as u32
serveTasks(link, (name, input) => {
	const [task, hex] = name.split(':');
	if (task !== 'sweep' || !hex) throw new Error(`unknown task ${name}`);
	const chunk = input as Uint8Array;
	const need = base + chunk.length;
	const pages = Math.ceil((need - exports.memory.buffer.byteLength) / 65536);
	if (pages > 0) exports.memory.grow(pages);
	new Uint8Array(exports.memory.buffer).set(chunk, base);
	const end = run(Number.parseInt(hex, 16) | 0, base, chunk.length) >>> 0;
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, end, true);
	return out;
});
