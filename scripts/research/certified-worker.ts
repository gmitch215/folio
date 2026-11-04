import { workerData } from 'node:worker_threads';
import type { AffineLayout } from '../../src/affine.ts';
import { serveCertified } from '../../src/certified.ts';
import type { TaskLink } from '../../src/tasks.ts';

const { link, module, memory, layout } = workerData as {
	link: TaskLink;
	module: WebAssembly.Module;
	memory: WebAssembly.Memory;
	layout: AffineLayout;
};

serveCertified(link, { module, memory, layout });
