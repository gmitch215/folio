import { workerData } from 'node:worker_threads';
import type { AffineLayout } from '../folds/affine.ts';
import { serveCertified } from '../folds/certified.ts';
import type { TaskLink } from '../node/tasks.ts';

const { link, module, memory, layout } = workerData as {
	link: TaskLink;
	module: WebAssembly.Module;
	memory: WebAssembly.Memory;
	layout: AffineLayout;
};

serveCertified(link, { module, memory, layout });
