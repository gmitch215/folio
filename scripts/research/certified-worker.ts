import { workerData } from 'node:worker_threads';
import type { AffineLayout } from '../../src/folds/affine.ts';
import { serveCertified } from '../../src/folds/certified.ts';
import type { TaskLink } from '../../src/node/tasks.ts';

const { link, module, memory, layout } = workerData as {
	link: TaskLink;
	module: WebAssembly.Module;
	memory: WebAssembly.Memory;
	layout: AffineLayout;
};

serveCertified(link, { module, memory, layout });
