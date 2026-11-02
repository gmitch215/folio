import { readFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { serveContext, type ContextLayout } from '../../src/affine-state.ts';
import type { TaskLink } from '../../src/tasks.ts';

const { link, wasm, layout, context, state } = workerData as {
	link: TaskLink;
	wasm: string;
	layout: ContextLayout;
	context: Uint8Array;
	state: number[];
};

serveContext(link, { module: new WebAssembly.Module(readFileSync(wasm)), layout, context, state });
