import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { prepareContext } from './compiler.ts';
import { TaskPool } from './tasks.ts';

const PAGE = 65536;

/** Options for `SlicePool.open`. */
export interface SlicePoolOptions {
	/**
	 * The shared memory every worker runs on. It must be a shared memory with a declared maximum
	 * that leaves room for one private stack per worker. The pool grows it by that much at open.
	 */
	memory: WebAssembly.Memory;
	/** Worker count. The default is the available parallelism, at most 8. */
	workers?: number;
	/**
	 * Bytes of private stack per worker, a multiple of 65,536. Only a module that keeps a stack
	 * pointer global gets stacks. The default is 65,536.
	 */
	stackBytes?: number;
	/**
	 * A module specifier or URL whose default export returns the imports the module needs besides
	 * its memory. Each worker loads it, because functions do not cross threads.
	 */
	imports?: string | URL;
}

/** Options for one `SlicePool.run`. */
export interface SliceRunOptions {
	/** Calls per slice. The default splits the range evenly over the workers. */
	grain?: number;
	/**
	 * Runs the same slices serially on a copy of the memory taken before the run and compares the
	 * result and every byte below the stacks. A difference throws `SliceConflictError`. It costs
	 * a serial execution and a memory copy, and is meant for tests and canaries.
	 */
	audit?: boolean;
}

/** What one `run` did. */
export interface SliceReport {
	slices: number;
	workers: number;
	wallMs: number;
	/** The value each slice's last call returned, in slice order. */
	results: (number | bigint | undefined)[];
	audited: boolean;
}

/** The audit found the parallel run differs from the serial one. */
export class SliceConflictError extends Error {
	readonly kind: 'memory' | 'result';
	/** First differing byte for `memory`, the slice index for `result`. */
	readonly at: number;

	constructor(kind: 'memory' | 'result', at: number) {
		super(
			kind === 'memory'
				? `slices differ from the serial run at byte ${at}; the calls are not independent`
				: `slice ${at} returned a different value than the serial run`
		);
		this.name = 'SliceConflictError';
		this.kind = kind;
		this.at = at;
	}
}

const encoder = (_: string, value: unknown) =>
	typeof value === 'bigint' ? { $bigint: value.toString() } : value;
const decoder = (_: string, value: unknown) =>
	value && typeof value === 'object' && '$bigint' in value
		? BigInt((value as { $bigint: string }).$bigint)
		: value;

/** @internal */
export const encodeValues = (values: unknown): string => JSON.stringify(values, encoder);
/** @internal */
export const decodeValues = (text: string): unknown => JSON.parse(text, decoder);

/**
 * Marks the imported memory of a module as shared by setting its limits flag. The module has to
 * declare a maximum already.
 * @internal
 */
export function sharedMemoryImport(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes.length);
	out.set(bytes);
	let at = 8;
	const leb = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = out[at++]!;
			value |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		return value;
	};
	const skip = (length: number) => (at += length);
	while (at < out.length) {
		const id = out[at++]!;
		const size = leb();
		const end = at + size;
		if (id === 2) {
			for (let count = leb(); count > 0; count--) {
				skip(leb());
				skip(leb());
				const kind = out[at++]!;
				if (kind === 2) {
					if (out[at] === 1) out[at] = 3;
					else if (out[at] !== 3) throw new Error('the memory import needs a maximum');
					return out;
				}
				if (kind === 0) leb();
				else if (kind === 1) {
					at++;
					const flags = out[at++]!;
					leb();
					if (flags & 1) leb();
				} else if (kind === 3) at += 2;
			}
		}
		at = end;
	}
	throw new Error('the module imports no memory');
}

/**
 * Runs slices of a call range on several threads over one shared memory, in place. The caller
 * declares that the calls are independent and nothing tracks reads or writes, so a program that
 * touches state the serial program would share returns a different result; `audit` finds that.
 * Nothing is copied into a private context, which is why a bandwidth-bound kernel can win here
 * while a route that copies its input first cannot. The module runs unmodified except for its
 * memory import, which is marked shared. A module that keeps a stack pointer global gets one
 * private stack per worker; any other mutable global, a start function or a data segment that
 * is dropped refuses the module.
 * @since 1.1.0
 */
export class SlicePool {
	readonly #memory: WebAssembly.Memory;
	readonly #module: WebAssembly.Module;
	readonly #tasks: TaskPool;
	readonly #workers: Worker[];
	readonly #stack?: { name: string; tops: number[]; base: number };
	readonly #importSlot: { module: string; name: string };
	readonly #extra: WebAssembly.Imports;
	readonly #exports: Set<string>;
	#closed = false;

	private constructor(
		memory: WebAssembly.Memory,
		module: WebAssembly.Module,
		tasks: TaskPool,
		workers: Worker[],
		stack: { name: string; tops: number[]; base: number } | undefined,
		slot: { module: string; name: string },
		extra: WebAssembly.Imports
	) {
		this.#memory = memory;
		this.#module = module;
		this.#tasks = tasks;
		this.#workers = workers;
		this.#stack = stack;
		this.#importSlot = slot;
		this.#extra = extra;
		this.#exports = new Set(
			WebAssembly.Module.exports(module)
				.filter((item) => item.kind === 'function')
				.map((item) => item.name)
		);
	}

	/** The shared memory. Write the records into it after `open`, and read the results from it. */
	get memory(): WebAssembly.Memory {
		return this.#memory;
	}

	/** Worker count. */
	get size(): number {
		return this.#workers.length;
	}

	/** First byte of the private stacks, or undefined when the module has no stack pointer. */
	get stackBase(): number | undefined {
		return this.#stack?.base;
	}

	/**
	 * Compiles the module, grows the memory by one stack per worker when the module has a stack
	 * pointer, and starts the workers. Opening applies the module's data segments to the memory,
	 * so write the records after it returns.
	 */
	static async open(bytes: Uint8Array, options: SlicePoolOptions): Promise<SlicePool> {
		const { memory } = options;
		if (Object.prototype.toString.call(memory.buffer) !== '[object SharedArrayBuffer]')
			throw new TypeError('slices need a shared memory');
		const plan = prepareContext(bytes);
		if (plan.reasons.length)
			throw new TypeError(`module cannot run on slices: ${plan.reasons.join('; ')}`);
		if (plan.globals.length > 1)
			throw new TypeError(
				`module keeps ${plan.globals.length} mutable globals; slices handle at most a stack pointer`
			);
		let patched: Uint8Array<ArrayBuffer>;
		try {
			patched = sharedMemoryImport(Uint8Array.from(plan.bytes));
		} catch (error) {
			throw new TypeError(`module cannot take a shared memory: ${(error as Error).message}`);
		}
		const module = new WebAssembly.Module(patched);
		const slot = WebAssembly.Module.imports(module).find((item) => item.kind === 'memory');
		if (!slot) throw new TypeError('module must import its memory');
		const width = options.workers ?? Math.max(1, Math.min(availableParallelism(), 8));
		if (!Number.isSafeInteger(width) || width < 1) throw new RangeError('invalid worker count');
		let stack: { name: string; tops: number[]; base: number } | undefined;
		if (plan.globals.length) {
			const bytesPerStack = options.stackBytes ?? PAGE;
			if (
				!Number.isSafeInteger(bytesPerStack) ||
				bytesPerStack < PAGE ||
				bytesPerStack % PAGE
			)
				throw new RangeError('stackBytes must be a positive multiple of 65536');
			const base = memory.buffer.byteLength;
			try {
				memory.grow((width * bytesPerStack) / PAGE);
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
				throw new RangeError(
					`the memory maximum leaves no room for ${width} stacks of ${bytesPerStack} bytes`
				);
			}
			stack = {
				name: plan.globals[0]!,
				base,
				tops: Array.from(
					{ length: width },
					(_, index) => base + (index + 1) * bytesPerStack
				)
			};
		}
		const extra = options.imports
			? ((await import(String(options.imports))).default() as WebAssembly.Imports)
			: {};
		const tasks = new TaskPool(width);
		const workers: Worker[] = [];
		const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
		try {
			await Promise.all(
				Array.from({ length: width }, (_, index) => {
					const link = tasks.link(index);
					return new Promise<void>((resolve, reject) => {
						const worker = new Worker(
							new URL(`./slices-worker.${extension}`, import.meta.url),
							{
								workerData: {
									module,
									memory,
									link,
									slot,
									stack: stack && { name: stack.name, top: stack.tops[index] },
									imports: options.imports && String(options.imports)
								},
								transferList: [link.port]
							}
						);
						workers.push(worker);
						worker.once('message', () => resolve());
						worker.once('error', reject);
					});
				})
			);
		} catch (error) {
			tasks.close();
			await Promise.all(workers.map((worker) => worker.terminate()));
			throw error;
		}
		return new SlicePool(memory, module, tasks, workers, stack, slot, extra);
	}

	/**
	 * Calls the exported function `entry` for the range `[0, count)` in slices, one slice per task.
	 * `args(from, to)` returns the i32 (or i64 as bigint) arguments of the call for a slice, in the
	 * owner thread. The caller guarantees the slices are independent.
	 */
	async run(
		entry: string,
		count: number,
		args: (from: number, to: number) => (number | bigint)[],
		options: SliceRunOptions = {}
	): Promise<SliceReport> {
		if (this.#closed) throw new Error('slice pool is closed');
		if (!this.#exports.has(entry)) throw new TypeError(`module exports no function ${entry}`);
		if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid count');
		const width = this.#workers.length;
		const grain = options.grain ?? Math.max(1, Math.ceil(count / width));
		if (!Number.isSafeInteger(grain) || grain < 1) throw new RangeError('invalid grain');
		const slices: [number, number][] = [];
		for (let from = 0; from < count; from += grain)
			slices.push([from, Math.min(from + grain, count)]);
		const before = options.audit ? new Uint8Array(this.#memory.buffer).slice() : undefined;
		const calls = slices.map(([from, to]) => encodeValues(args(from, to)));
		const start = performance.now();
		const done = await this.#tasks.run(calls.map((call) => [entry, call] as [string, string]));
		const wallMs = performance.now() - start;
		const results = done.map((item) => {
			const text = item.text();
			return (text ? decodeValues(text) : undefined) as number | bigint | undefined;
		});
		if (before) this.#audit(entry, calls, results, before);
		return { slices: slices.length, workers: width, wallMs, results, audited: Boolean(before) };
	}

	#audit(
		entry: string,
		calls: string[],
		results: (number | bigint | undefined)[],
		before: Uint8Array
	): void {
		const after = new Uint8Array(this.#memory.buffer).slice();
		const copy = new WebAssembly.Memory({
			initial: before.length / PAGE,
			maximum: before.length / PAGE,
			shared: true
		});
		const { module: moduleName, name } = this.#importSlot;
		const imports = {
			...this.#extra,
			[moduleName]: { ...(this.#extra[moduleName] ?? {}), [name]: copy }
		};
		const instance = new WebAssembly.Instance(this.#module, imports);
		// instantiating applied the data segments over the copy; put the snapshot back
		new Uint8Array(copy.buffer).set(before);
		if (this.#stack)
			(instance.exports[this.#stack.name] as WebAssembly.Global).value = this.#stack.tops[0]!;
		const run = instance.exports[entry] as CallableFunction;
		calls.forEach((call, index) => {
			const serial = run(...(decodeValues(call) as (number | bigint)[])) as
				number | bigint | undefined;
			if (serial !== results[index]) throw new SliceConflictError('result', index);
		});
		const limit = this.#stack?.base ?? Math.min(before.length, after.length);
		const reference = new Uint8Array(copy.buffer);
		for (let at = 0; at < limit; at++)
			if (after[at] !== reference[at]) throw new SliceConflictError('memory', at);
	}

	/** Stops the workers. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#tasks.close();
		await Promise.all(this.#workers.map((worker) => worker.terminate()));
	}
}
