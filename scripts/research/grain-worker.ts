import { parentPort, workerData } from 'node:worker_threads';
import type { PreparedContext } from '../../src/compiler.ts';
import { InstanceCheckpoint } from '../../src/context.ts';
import { serveTasks, type TaskLink } from '../../src/tasks.ts';

/** a private initialized context; every call restores the checkpoint first */
export function grainContext(module: WebAssembly.Module, layout: PreparedContext, pages: number) {
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages === 16 ? 128 : 1024 });
	const instance = new WebAssembly.Instance(module, {
		env: { memory, sin: Math.sin, cos: Math.cos, floor: Math.floor, sqrt: Math.sqrt }
	});
	const x = instance.exports as Record<string, CallableFunction>;
	x.initialize!();
	const checkpoint = new InstanceCheckpoint(instance, layout);
	const base = x.corpus_output!() as number;
	return {
		x,
		memory,
		base,
		call(first: number, count: number, reset = true) {
			let t = performance.now();
			const report = reset ? checkpoint.restore() : undefined;
			const resetMs = performance.now() - t;
			t = performance.now();
			x.run_range!(first, count);
			const computeMs = performance.now() - t;
			t = performance.now();
			const slice = new Uint8Array(memory.buffer, base + first * 16, count * 16);
			const out = new Uint8Array(16 + slice.length);
			out.set(slice, 16);
			new Float64Array(out.buffer, 0, 2).set([resetMs, computeMs]);
			return { out, resetMs, computeMs, copyMs: performance.now() - t, report };
		},
		entry(reset = true) {
			const report = reset ? checkpoint.restore() : undefined;
			x.entry!();
			return report;
		}
	};
}

if (workerData?.grainWorker) {
	const data = workerData as {
		module: WebAssembly.Module;
		layout: PreparedContext;
		link: TaskLink;
		pages: number;
		noReset?: boolean;
	};
	const ctx = grainContext(data.module, data.layout, data.pages);
	serveTasks(data.link, (_name, input) => {
		const [first, count] = String(input).split(',').map(Number) as [number, number];
		return ctx.call(first, count, !data.noReset).out;
	});
	parentPort!.postMessage({ ready: true });
}
