import { readFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { serveAffine, type AffineLayout } from '../../src/folds/affine.ts';
import type { TaskLink } from '../../src/node/tasks.ts';

const { link, wasm, layout } = workerData as {
	link: TaskLink;
	wasm: string;
	layout: AffineLayout;
};

serveAffine(link, { module: new WebAssembly.Module(readFileSync(wasm)), layout });
