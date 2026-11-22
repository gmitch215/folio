import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE = 65536;
export const GROUP = 16 * PAGE;
export const SIGNAL = 1024;
export const SAVED_LCG = 2048;
export const SAVED_LEFT = 2056;
export const K_WORD = 2064;

const here = dirname(fileURLToPath(import.meta.url));

export class Kill extends Error {}

export function loadModules() {
	const read = (name) => new WebAssembly.Module(readFileSync(join(here, 'runs', name)));
	return {
		guest: read('guest.wasm'),
		nopoll: read('guest-nopoll.wasm'),
		hash: read('hash.wasm')
	};
}

export function newMemory(pages) {
	return new WebAssembly.Memory({ initial: pages, maximum: pages });
}

export function hashOf(mods, memory) {
	const { exports } = new WebAssembly.Instance(mods.hash, { env: { memory } });
	return {
		pages: memory.buffer.byteLength / PAGE,
		hashPages: exports.hashPages,
		hashes: new BigUint64Array(exports.hashes.buffer)
	};
}

export function sha256(memory) {
	return createHash('sha256').update(new Uint8Array(memory.buffer)).digest('hex');
}

export function setPeriod(memory, k) {
	new DataView(memory.buffer).setInt32(K_WORD, k, true);
}

function instantiate(mods, memory, onYield) {
	const { exports } = new WebAssembly.Instance(mods.guest, {
		env: { memory, yield: new WebAssembly.Suspending(onYield) }
	});
	return {
		memory,
		quiesce: exports.quiesce,
		work: WebAssembly.promising(exports.work),
		resume: WebAssembly.promising(exports.resume_from_memory)
	};
}

// One guest call per job. A yield is an event boundary; onYield runs while the guest is suspended.
// A thrown Kill discards the instance and calls restore(), which returns { memory, steps }.
export async function execute({ mods, memory, steps, k, onYield, restore }) {
	setPeriod(memory, k);
	const state = { current: null };
	const handler = () => onYield(state);
	state.current = instantiate(mods, memory, handler);
	let pending = state.current.work(steps);
	for (;;) {
		try {
			const value = await pending;
			return { value, memory: state.current.memory };
		} catch (err) {
			if (!(err instanceof Kill) || !restore) throw err;
			const next = await restore();
			state.current = instantiate(mods, next.memory, handler);
			pending = state.current.resume(next.steps);
		}
	}
}
