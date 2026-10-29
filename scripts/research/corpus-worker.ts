import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import type { PreparedContext } from '../../src/compiler.ts';
import { ContextResetError, InstanceCheckpoint } from '../../src/context.ts';
import { serveTasks, type TaskInput, type TaskLink } from '../../src/tasks.ts';

export type ResetMode = 'whole' | 'pages' | 'checkpoint';

/** A private initialized context; the reset is part of every independent operation. */
export function kernelContext(
	module: WebAssembly.Module,
	resetMode: ResetMode = 'whole',
	layout?: PreparedContext
) {
	let memory!: WebAssembly.Memory, instance!: WebAssembly.Instance;
	const recreate = () => {
		memory = new WebAssembly.Memory({ initial: 128, maximum: 1024 });
		instance = new WebAssembly.Instance(module, {
			env: { memory, sin: Math.sin, cos: Math.cos, floor: Math.floor, sqrt: Math.sqrt }
		});
		(instance.exports.initialize as CallableFunction)();
	};
	recreate();
	const initialized =
		resetMode === 'checkpoint' ? new Uint8Array() : new Uint8Array(memory.buffer).slice();
	let checkpoint =
		resetMode === 'checkpoint' && !layout!.reasons.length
			? new InstanceCheckpoint(instance, layout!)
			: undefined;
	const dirtyPages: number[] = [];
	if (resetMode === 'pages') {
		// Corpus-only specialization: fixed entry, fixed input, deterministic private state.
		// Learn the exact changed pages, then restore the complete initial state before measurement.
		(instance.exports.entry as CallableFunction)();
		const after = new Uint8Array(memory.buffer);
		for (let offset = 0; offset < after.length; offset += 65536)
			if (
				!Buffer.from(after.subarray(offset, offset + 65536)).equals(
					Buffer.from(initialized.subarray(offset, offset + 65536))
				)
			)
				dirtyPages.push(offset);
		after.set(initialized);
	}
	let value: unknown;
	return (repeats: number, verify = false) => {
		let resetMs = 0,
			computeMs = 0,
			restoredBytes = 0,
			recreated = 0;
		for (let index = 0; index < repeats; index++) {
			let start = performance.now();
			const target = new Uint8Array(memory.buffer);
			if (resetMode === 'checkpoint') {
				if (!checkpoint) {
					recreate();
					recreated++;
				} else
					try {
						restoredBytes += checkpoint.restore().copiedBytes;
					} catch (error) {
						if (!(error instanceof ContextResetError)) throw error;
						recreate();
						checkpoint = new InstanceCheckpoint(instance, layout!);
						recreated++;
					}
			} else if (resetMode === 'whole') {
				target.set(initialized);
				restoredBytes += initialized.length;
			} else
				for (const offset of dirtyPages) {
					target.set(initialized.subarray(offset, offset + 65536), offset);
					restoredBytes += 65536;
				}
			resetMs += performance.now() - start;
			start = performance.now();
			value = (instance.exports.entry as CallableFunction)();
			computeMs += performance.now() - start;
		}
		const start = performance.now();
		const sha256 = verify
			? createHash('sha256').update(new Uint8Array(memory.buffer)).digest('hex')
			: '';
		return {
			value: String(value),
			sha256,
			resetMs,
			computeMs,
			digestMs: performance.now() - start,
			restoredBytes,
			recreated,
			resetMode
		};
	};
}

if (workerData?.researchKernel) {
	const data = workerData as {
		module: WebAssembly.Module;
		link?: TaskLink;
		researchKernel: true;
		resetMode?: ResetMode;
		layout?: PreparedContext;
	};
	const run = kernelContext(data.module, data.resetMode, data.layout);
	const execute = (input: TaskInput) => {
		const { repeats, jobs, verify } = JSON.parse(String(input)) as {
			repeats: number;
			jobs: number;
			verify?: boolean;
		};
		return JSON.stringify(Array.from({ length: jobs }, () => run(repeats, verify)));
	};
	if (data.link) serveTasks(data.link, (_name, input) => execute(input));
	else
		parentPort!.on('message', ({ id, input }) => {
			try {
				parentPort!.postMessage({ id, output: execute(input) });
			} catch (error) {
				parentPort!.postMessage({ id, error: String(error) });
			}
		});
	parentPort!.postMessage({ ready: true });
}
