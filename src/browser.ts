import type { LoopPlan } from './compiler.ts';
import type { NativePlan } from './guards.ts';
import type { MemoryImport } from './memory.ts';

/** Trusted build-time metadata for a precompiled original module. No compiler runs in the browser. */
export interface BrowserProgram {
	module: WebAssembly.Module;
	loops: Record<string, LoopPlan>;
	native?: Record<string, NativePlan>;
	/** The unchanged legacy preparation reasons; only an empty list admits worker instantiation. */
	reasons: string[];
	memories?: MemoryImport[];
}

/** A dedicated module worker, or an equivalent host-supplied message port. */
export type BrowserWorkerPort = Pick<
	Worker,
	'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'
>;

/** Browser execution configuration. The caller retains exclusive ownership during open and run. */
export interface BrowserOptions {
	memory?: WebAssembly.Memory;
	imports?: WebAssembly.Imports;
	workers?: number;
	workerURL?: string | URL;
	workerFactory?: (index: number) => BrowserWorkerPort;
	minimumParallelWork?: number;
}

/** A whole-entry result. Values remain wrapped so native externref Promise identity is preserved. */
export interface BrowserExecutionReport {
	values: unknown[];
	mode: 'serial' | 'native-shared';
	workers: number;
	regions: number;
	reason?: string;
}

type Call = { export: string; args: unknown[] };

/** Counted-loop extraction over physically shared memory, without JSPI or runtime compilation. */
export class BrowserFolio {
	readonly exports: WebAssembly.Exports;
	readonly memory?: WebAssembly.Memory;
	readonly diagnostics: readonly string[];
	readonly #program: BrowserProgram;
	readonly #workers: BrowserWorkerPort[] = [];
	readonly #listeners: (() => void)[] = [];
	readonly #minimumWork: number;
	#sequence = 0;
	#closed = false;
	#busy = false;
	#failure?: Error;
	#active?: Promise<BrowserExecutionReport>;
	#closing?: Promise<void>;

	private constructor(program: BrowserProgram, options: BrowserOptions) {
		this.#program = program;
		this.#minimumWork = options.minimumParallelWork ?? 100_000;
		if (!Number.isFinite(this.#minimumWork) || this.#minimumWork < 0)
			throw new RangeError('minimumParallelWork must be finite and nonnegative');
		this.memory = options.memory;
		const descriptor = program.memories?.length === 1 ? program.memories[0] : undefined;
		const original = options.imports ?? {};
		const imports =
			descriptor && this.memory
				? new Proxy(original, {
						get: (target, module) => {
							const namespace = Reflect.get(target, module, target);
							if (module !== descriptor.module) return namespace;
							return new Proxy(namespace ?? {}, {
								get: (bindings, name) =>
									name === descriptor.name
										? this.memory
										: Reflect.get(bindings, name, bindings)
							});
						}
					})
				: original;
		this.exports = new WebAssembly.Instance(program.module, imports).exports;
		this.diagnostics = Object.freeze([...program.reasons]);
	}

	/** Opens the original instance and attaches only compiler-admitted, initialization-free workers. */
	static async open(
		program: BrowserProgram,
		options: BrowserOptions = {}
	): Promise<BrowserFolio> {
		const width = options.workers ?? 4;
		if (!Number.isInteger(width) || width < 1 || width > 32)
			throw new RangeError('workers must be an integer from 1 through 32');
		const pool = new BrowserFolio(program, options);
		const descriptor = program.memories?.length === 1 ? program.memories[0] : undefined;
		const bindings = WebAssembly.Module.imports(program.module);
		const eligible =
			width > 1 &&
			program.reasons.length === 0 &&
			Object.keys(program.native ?? {}).some((name) => Object.hasOwn(program.loops, name)) &&
			descriptor?.shared &&
			!descriptor.memory64 &&
			bindings.length === 1 &&
			bindings[0]!.kind === 'memory' &&
			bindings[0]!.module === descriptor.module &&
			bindings[0]!.name === descriptor.name &&
			pool.memory &&
			typeof SharedArrayBuffer !== 'undefined' &&
			pool.memory.buffer.byteLength >= 4 &&
			pool.memory.buffer instanceof SharedArrayBuffer;
		if (!eligible) return pool;
		const memory = pool.memory!;
		const words = new Int32Array(memory.buffer);
		const saved = Atomics.load(words, 0);
		try {
			for (let index = 0; index < width; index++) {
				const worker = options.workerFactory
					? options.workerFactory(index)
					: new Worker(
							options.workerURL ?? new URL('./browser-worker.js', import.meta.url),
							{
								type: 'module'
							}
						);
				pool.#workers.push(worker);
				const fail = () => {
					pool.#failure ??= new Error(
						'browser worker failed; shared arena requires checkpoint recovery'
					);
				};
				worker.addEventListener('error', fail);
				worker.addEventListener('messageerror', fail);
				pool.#listeners.push(() => {
					worker.removeEventListener('error', fail);
					worker.removeEventListener('messageerror', fail);
				});
				const before = (0x46100000 + index) | 0;
				const after = (before ^ 0x00ffffff) | 0;
				Atomics.store(words, 0, before);
				const result = await pool.#request(worker, {
					action: 'attach',
					module: program.module,
					memory,
					importModule: descriptor!.module,
					importName: descriptor!.name,
					before,
					after
				});
				if (result !== before || Atomics.load(words, 0) !== after)
					throw new Error('browser worker shared-memory alias handshake failed');
			}
			return pool;
		} catch (error) {
			pool.#terminate();
			throw error;
		} finally {
			Atomics.store(words, 0, saved);
		}
	}

	/** Describes counted-loop coverage; generalized control-flow extraction remains at the owner. */
	inspect(entry: string) {
		return {
			mechanism: 'counted-loop' as const,
			loop: Object.hasOwn(this.#program.loops, entry),
			nativeGuard: Object.hasOwn(this.#program.native ?? {}, entry),
			workers: this.#workers.length
		};
	}

	#request(worker: BrowserWorkerPort, message: Record<string, unknown>): Promise<unknown> {
		const sequence = ++this.#sequence;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				worker.removeEventListener('message', done);
				worker.removeEventListener('error', fail);
				worker.removeEventListener('messageerror', fail);
			};
			const fail = (event: Event) => {
				cleanup();
				reject(new Error((event as ErrorEvent).message || 'browser worker failed'));
			};
			const done = (event: MessageEvent) => {
				if (event.data?.sequence !== sequence) return;
				cleanup();
				if (event.data.error) reject(new Error(event.data.error));
				else resolve(event.data.value);
			};
			worker.addEventListener('message', done);
			worker.addEventListener('error', fail);
			worker.addEventListener('messageerror', fail);
			try {
				worker.postMessage({ ...message, sequence });
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	}

	#disjoint(calls: Call[], proved: NativePlan, plan: LoopPlan): boolean {
		const footprints = calls.map((call) =>
			proved.accesses.map((access) => {
				const first = Number(call.args[access.parameter]) >>> 0;
				const count = Number(call.args[plan.countParameter]) >>> 0;
				const step =
					plan.steps.find((item) => item.parameter === access.parameter)?.step ?? 0;
				const last = first + (count - 1) * step;
				return {
					start: Math.min(first, last) + access.offset,
					end: Math.max(first, last) + access.offset + access.bytes,
					write: access.write,
					wrap: last < 0 || last > 0xffffffff
				};
			})
		);
		for (let index = 0; index < footprints.length; index++) {
			for (const range of footprints[index]!) {
				if (range.wrap || range.start < 0 || range.end > this.memory!.buffer.byteLength)
					return false;
				for (const other of footprints.slice(0, index).flat())
					if (
						(range.write || other.write) &&
						range.start < other.end &&
						other.start < range.end
					)
						return false;
			}
		}
		return true;
	}

	/** Derives guarded regions from one ordinary call, then joins every lane before returning. */
	run(entry: string, args: unknown[] = [], options: { parallel?: 'auto' | 'off' } = {}) {
		if (this.#closed) return Promise.reject(new Error('folio is closed'));
		if (this.#failure) return Promise.reject(this.#failure);
		if (this.#busy) return Promise.reject(new Error('memory already has an active run'));
		this.#busy = true;
		const running = this.#run(entry, args, options);
		this.#active = running;
		running
			.finally(() => {
				this.#busy = false;
				if (this.#active === running) this.#active = undefined;
			})
			.catch(() => {});
		return running;
	}

	async #run(entry: string, args: unknown[], options: { parallel?: 'auto' | 'off' }) {
		const plan = Object.hasOwn(this.#program.loops, entry)
			? this.#program.loops[entry]
			: undefined;
		const proved = Object.hasOwn(this.#program.native ?? {}, entry)
			? this.#program.native![entry]
			: undefined;
		const numeric = args.every((arg) => typeof arg === 'number');
		const count = plan && numeric ? Number(args[plan.countParameter]) >>> 0 : 0;
		const work = numeric
			? proved?.workParameters.reduce(
					(value, parameter) => value * (Number(args[parameter]) >>> 0),
					count
				)
			: undefined;
		let reason =
			options.parallel === 'off'
				? 'requested'
				: !numeric
					? 'opaque-input'
					: !plan || !proved || this.#workers.length < 2
						? 'no-parallel-plan'
						: count < 2
							? 'single-region'
							: work !== undefined && work < this.#minimumWork
								? 'small-workload'
								: undefined;
		const calls: Call[] = [];
		if (!reason && plan && proved) {
			const regions = Math.min(count, this.#workers.length);
			let begin = 0;
			for (let index = 0; index < regions; index++) {
				const end = Math.floor(((index + 1) * count) / regions);
				const parameters = [...args];
				parameters[plan.countParameter] = end - begin;
				for (const { parameter, step } of plan.steps)
					parameters[parameter] =
						((Number(args[parameter]) | 0) + Math.imul(begin, step)) | 0;
				calls.push({ export: entry, args: parameters });
				begin = end;
			}
			if (!this.#disjoint(calls, proved, plan)) reason = 'guard-failed';
		}
		if (reason) {
			const value = (this.exports[entry] as CallableFunction)(...args);
			return { values: [value], mode: 'serial' as const, workers: 0, regions: 1, reason };
		}
		const outcomes = await Promise.allSettled(
			calls.map((call, index) =>
				this.#request(this.#workers[index]!, { action: 'run', call })
			)
		);
		if (outcomes.some((outcome) => outcome.status === 'rejected')) {
			this.#failure = new Error(
				'native region failed; shared arena requires checkpoint recovery'
			);
			this.#terminate();
			throw this.#failure;
		}
		return {
			values: [undefined],
			mode: 'native-shared' as const,
			workers: calls.length,
			regions: calls.length
		};
	}

	#terminate() {
		for (const detach of this.#listeners) detach();
		this.#listeners.length = 0;
		for (const worker of this.#workers) worker.terminate();
		this.#workers.length = 0;
	}

	/** Joins an active finite call before terminating dedicated workers. */
	close(): Promise<void> {
		this.#closed = true;
		return (this.#closing ??= (async () => {
			await this.#active?.catch(() => {});
			this.#terminate();
		})());
	}

	/** Joins execution and releases workers for `await using`. */
	[Symbol.asyncDispose]() {
		return this.close();
	}
}
