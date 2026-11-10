import { readFileSync } from 'node:fs';
import { ensureLz4 } from './lz4-build.ts';
import type { Codec } from './lz4.ts';
import { lz4Codec } from './lz4.ts';
import { basePage } from './programs.ts';
import type { ObjectDeps } from './service.ts';
import { ExecutorObject, route } from './service.ts';
import { MemoryBackend, VirtualClock } from './store.ts';
import { buildTraceWasm } from './trace-build.ts';

const url = (path: string) => new URL(path, import.meta.url);

let modules: { dense: WebAssembly.Module; trace: WebAssembly.Module; lz4: WebAssembly.Module };
export function loadModules() {
	return (modules ??= {
		dense: new WebAssembly.Module(
			readFileSync(
				url('../../results/execution/elastic-memory/managed-envelope/source/fixture.wasm')
			)
		),
		trace: new WebAssembly.Module(buildTraceWasm()),
		lz4: new WebAssembly.Module(readFileSync(ensureLz4()))
	});
}

export const SECRET = 'local-only';
export const BASE = 'http://ladder.local';

export interface LocalWorld {
	fetchImpl: typeof fetch;
	objects: Map<string, ExecutorObject>;
	backends: Map<string, MemoryBackend>;
	clock: VirtualClock;
}

// the front Worker and its objects in process, over a fake page store and a clock that only advances when told
export function localWorld(
	options: {
		makePage?: ObjectDeps['makePage'];
		costs?: { readMs: number; writeMs: number };
		// a codec in place of the Wasm LZ4 build, for runs that do not measure the codec
		codec?: Codec;
		// a real timer for the executor's codec timings; the default is the virtual clock
		timer?: () => number;
	} = {}
): LocalWorld {
	const { dense, trace, lz4 } = loadModules();
	const clock = new VirtualClock();
	const objects = new Map<string, ExecutorObject>();
	const backends = new Map<string, MemoryBackend>();
	const objectFor = (name: string) => {
		let object = objects.get(name);
		if (!object) {
			object = new ExecutorObject({
				makeBackend: (rowBytes) => {
					const backend = new MemoryBackend(rowBytes, clock, options.costs);
					backends.set(name, backend);
					return backend;
				},
				codec: () => options.codec ?? lz4Codec(lz4),
				dense,
				trace,
				clock: options.timer ?? (() => clock.now),
				makePage: options.makePage ?? basePage,
				equal: (a, b) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(b)
			});
			objects.set(name, object);
		}
		return object;
	};
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
		route(new Request(String(input), init), objectFor, SECRET, 'LOCAL')) as typeof fetch;
	return { fetchImpl, objects, backends, clock };
}
