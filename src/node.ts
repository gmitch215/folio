import { availableParallelism } from 'node:os';
import { isArrayBuffer, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { Worker } from 'node:worker_threads';
import type { PreparedProgram } from './compiler.ts';
import { Coordinator } from './coordinator.ts';
import type { NativePlan } from './guards.ts';
import { memoryImports } from './memory.ts';
import type { TransactionResult } from './transaction.ts';
import { numberBits, restoreNumbers } from './values.ts';

interface Jspi {
	Suspending?: new (fn: (...args: any[]) => any) => WebAssembly.ImportValue;
	promising?: (fn: CallableFunction) => (...args: any[]) => Promise<unknown>;
}

/** Wraps an asynchronous host import for Wasm stack suspension. */
export function suspending<Args extends unknown[], Value>(
	fn: (...args: Args) => Promise<Value>
): WebAssembly.ImportValue {
	const runtime = WebAssembly as typeof WebAssembly & Jspi;
	if (!runtime.Suspending) throw new Error('this runtime does not support JSPI');
	return new runtime.Suspending(fn);
}

/** Source bytes, a compiled module, or a plan from `prepare`. A compiled module keeps its native path. */
export type ProgramInput = PreparedProgram | Uint8Array | ArrayBuffer | WebAssembly.Module;

/** One exported call in an ordered `runAll` batch. */
export interface Call {
	/** Name of the exported function. */
	export: string;
	/** Arguments in Wasm order; i64 parameters take bigint. */
	args: readonly unknown[];
}

/** Per-run routing and worker limits. */
export interface RunOptions {
	/** `auto` routes by plan, `off` runs the original entry, `speculate` forces tracked regions. */
	parallel?: 'auto' | 'off' | 'speculate';
	/** Bound participating workers without rebuilding the isolate group. */
	maximumWorkers?: number;
}

/** What a run did: results, how it was routed and what the speculation cost. */
export interface ExecutionReport {
	/** Return values of the call, or of each call in a batch. */
	values: unknown[];
	/** Workers that executed regions; zero for a serial run. */
	workers: number;
	/** Regions discovered and dispatched. */
	regions: number;
	/** Regions that conflicted and replayed against committed state. */
	replayed: number;
	/** Regions or batches that fell back to native execution at the owner. */
	fallbacks: number;
	/** `native-shared` ran proved kernels on the shared allocation without tracking. */
	mode: 'serial' | 'speculative' | 'native-shared';
	/** Set when the generalized control-flow extractor produced the regions. */
	extraction?: 'control-flow';
	/** `shared` regions read the physical allocation; `snapshot` ran on a copied arena. */
	memoryMode?: 'shared' | 'snapshot';
	/** Bytes copied into the worker group for snapshot execution. */
	snapshotBytes?: number;
	/** Why a run stayed serial or left the fast path. */
	reason?:
		| 'requested'
		| 'small-workload'
		| 'no-parallel-plan'
		| 'single-region'
		| 'unsupported-module'
		| 'dependency'
		| 'guard-failed'
		| 'snapshot-unavailable'
		| 'previous-conflicts'
		| 'opaque-input';

	/** Present when `FolioOptions.profile` is set. */
	profile?: ExecutionProfile;
}

/** Opt-in timings. Process CPU is measured once at the coordinator, not summed from these. */
export interface ExecutionProfile {
	/** Elapsed time of the whole run. */
	wallMs: number;
	/** Elapsed time of each region or batch observation on its worker. */
	workerWallMs: number[];
	/** Thread CPU time of each observation. */
	workerCpuMs: number[];
	/** Ordered dependency validation. */
	validationMs: number;
	/** Committing validated writes to canonical memory. */
	commitMs: number;
	/** Re-executing conflicted regions. */
	replayMs: number;
	/** Bytes tracked as read by speculative regions. */
	readBytes: number;
	/** Bytes tracked as written by speculative regions. */
	writeBytes: number;
}

/** Pool construction options. */
export interface FolioOptions {
	/** Bind an existing single imported memory instead of allocating one from the module's limits. */
	memory?: WebAssembly.Memory;
	/** Isolate count; defaults to up to four. One worker uses the native entry and creates no thread. */
	workers?: number;
	/** Host imports, memories, tables and globals as for native instantiation. */
	imports?: WebAssembly.Imports;
	/** Instruction budget per speculative region before it yields to the native head. */
	fuel?: number;
	/** Bytes of read and write tracking a lane may retain. */
	maxTransactionBytes?: number;
	/** Estimated iterations below which a proved kernel stays at its original entry. */
	minimumParallelWork?: number;
	/** Exports that return a Promise because they suspend on async host imports. */
	promising?: readonly string[];
	/** Collect execution timings; disabled by default to keep the hot path small. */
	profile?: boolean;
	/** Static admission threshold used when `open` prepares raw bytes; a prepared plan keeps its own. */
	minimumRegionWork?: number;
	/** Iterations assumed for loops with no constant bound when `open` prepares raw bytes. */
	assumedTripCount?: number;
	/**
	 * Run a call shape natively for 16 calls after two runs that mostly replayed or fell back, then
	 * probe again. A shape is the entry, width, memory size and numeric arguments. Off by default.
	 * @since 1.0.1
	 */
	adaptiveRouting?: boolean;
}

interface Pending {
	resolve(value: any): void;
	reject(error: Error): void;
}

function isModule(value: unknown): value is WebAssembly.Module {
	try {
		WebAssembly.Module.exports(value as WebAssembly.Module);
		return true;
	} catch {
		return false;
	}
}

function isMemory(value: unknown): value is WebAssembly.Memory {
	try {
		Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!.call(value);
		return true;
	} catch {
		return false;
	}
}

function throwTrap(result: TransactionResult): void {
	if (!result.trap) return;
	if (result.errorKind === 'TypeError') throw new TypeError(result.trap);
	if (result.errorKind === 'RangeError') throw new RangeError(result.trap);
	throw new WebAssembly.RuntimeError(result.trap);
}

/** A same-process isolate group; callers give it exclusive memory access during each run. */
export class Folio {
	/** Active sharing, extraction and validation mode; a one-worker pool reports none and serial. */
	get capabilities() {
		return Object.freeze({
			physicalSharing: this.#workers.length ? ('same-process' as const) : ('none' as const),
			automaticRegions: this.#workers.length
				? this.#control
					? ('control-flow' as const)
					: ('counted-loops' as const)
				: ('none' as const),
			dependence: this.#workers.length ? ('ordered-validation' as const) : ('serial' as const)
		});
	}
	/** The original native exports, for trusted host integration. Raw calls bypass tracking. */
	get exports(): WebAssembly.Exports {
		return this.#exports;
	}
	/** The unique accessible arena, including a coordinator-exposed hidden memory. Throws otherwise. */
	get memory(): WebAssembly.Memory {
		if (!this.#memory)
			throw new Error('program has no single bound or exported memory; use memories');
		return this.#memory;
	}
	/** Named imported and exported memory wrappers. */
	get memories(): Readonly<Record<string, WebAssembly.Memory>> {
		return this.#memories;
	}
	/** Module-wide reasons the optimizer refused or fell back. A refusal is not a proved dependency. */
	get diagnostics(): readonly string[] {
		return [
			...this.#program.reasons,
			...(this.#program.controlReasons ?? []),
			...(this.#control?.diagnostics ?? []),
			...this.#runtimeDiagnostics
		];
	}
	/** Whether `entry` has an automatic plan or a native guard, by which mechanism, and why not. */
	inspect(entry: string) {
		const reason =
			this.#program.loopReasons && Object.hasOwn(this.#program.loopReasons, entry)
				? this.#program.loopReasons[entry]
				: undefined;
		return Object.freeze({
			automatic:
				Object.hasOwn(this.#program.loops, entry) ||
				Boolean(this.#control?.entries.includes(entry)),
			nativeGuard: Boolean(
				this.#program.native && Object.hasOwn(this.#program.native, entry)
			),
			mechanism: this.#control?.entries.includes(entry)
				? 'control-flow'
				: Object.hasOwn(this.#program.loops, entry)
					? 'counted-loop'
					: 'native',
			diagnostics: Object.freeze([...this.diagnostics, ...(reason ? [reason] : [])])
		});
	}
	#memory?: WebAssembly.Memory;
	#workerMemory?: WebAssembly.Memory;
	#control?: NonNullable<PreparedProgram['control']>;
	#serial?: WebAssembly.Global;
	#queued?: WebAssembly.Global;
	#coordinator?: Coordinator;
	readonly #controlled = new Map<string, (...args: any[]) => Promise<unknown>>();
	readonly #workerExports = new Set<string>();
	readonly #runtimeDiagnostics: string[] = [];
	readonly #exports: WebAssembly.Exports;
	readonly #memories: Record<string, WebAssembly.Memory> = {};
	readonly #promising = new Map<string, (...args: any[]) => Promise<unknown>>();
	readonly #nativePending = new Set<Promise<unknown>>();
	/** Thread ids of the worker isolates, in start order. */
	readonly threadIds: number[] = [];
	readonly #program: PreparedProgram;
	readonly #instance: WebAssembly.Instance;
	readonly #workers: Worker[] = [];
	readonly #pending = new Map<number, Pending>();
	readonly #fuel: number;
	readonly #maxBytes: number;
	readonly #minimumWork: number;
	readonly #profile: boolean;
	readonly #adaptive: boolean;
	readonly #routing = new Map<string, { failures: number; remaining: number }>();
	#nextId = 0;
	#busy = false;
	#closed = false;
	#closing?: Promise<void>;
	#failure?: Error;

	private constructor(program: PreparedProgram, options: FolioOptions, size: number) {
		this.#program = program;
		this.#fuel = options.fuel ?? 100_000_000;
		this.#maxBytes = options.maxTransactionBytes ?? 262_144;
		this.#minimumWork = options.minimumParallelWork ?? 100_000;
		this.#profile = options.profile ?? false;
		this.#adaptive = options.adaptiveRouting ?? false;
		if (!Number.isInteger(this.#fuel) || this.#fuel < 2 || this.#fuel > 2_147_483_647)
			throw new RangeError('invalid fuel');
		if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 1)
			throw new RangeError('invalid transaction budget');
		if (!Number.isFinite(this.#minimumWork) || this.#minimumWork < 0)
			throw new RangeError('invalid work threshold');
		const native =
			program.compiled ?? new WebAssembly.Module(Uint8Array.from(program.original));
		const runtime = WebAssembly as typeof WebAssembly & Jspi;
		let executable = native;
		const control = program.control;
		if (control && size > 1 && runtime.Suspending && runtime.promising) {
			const candidate = new WebAssembly.Module(Uint8Array.from(control.coordinator));
			const originalImports = WebAssembly.Module.imports(native);
			const retainedImports = WebAssembly.Module.imports(candidate).filter(
				(item) => item.module !== control.namespace
			);
			// Binding accessors are effects too: retain the original engine lookup sequence.
			if (JSON.stringify(originalImports) === JSON.stringify(retainedImports)) {
				this.#control = control;
				executable = candidate;
				this.#serial = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
				this.#queued = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
			} else
				this.#runtimeDiagnostics.push(
					'control extraction retained native binding order: rewritten import sequence differs'
				);
		}
		const imported = WebAssembly.Module.imports(native).filter(
			(item) => item.kind === 'memory'
		);
		if (imported.length > 1 && options.memory)
			throw new TypeError('bind multiple memories by name in imports');
		let descriptors: ReturnType<typeof memoryImports> = [];
		try {
			descriptors = memoryImports(program.original);
		} catch {}
		const supplied = options.imports ?? Object.create(null);
		const automatic = new Map<string, WebAssembly.Memory>();
		let controlBindings: Record<string, WebAssembly.ImportValue> | undefined;
		// Resolve bindings when the engine asks for them, in its original order.
		// Enumerating/spreading caller namespaces would invoke accessors early or twice.
		const imports: WebAssembly.Imports = new Proxy(Object.create(null), {
			get: (_, module: string) => {
				if (this.#control && module === this.#control.namespace) {
					if (controlBindings) return controlBindings;
					const bindings: Record<string, WebAssembly.ImportValue> = {
						[this.#control.serialGlobal]: this.#serial!,
						[this.#control.pendingGlobal]: this.#queued!,
						barrier: new runtime.Suspending!(() => this.#coordinator?.flush()),
						poll: new runtime.Suspending!(() => this.#coordinator?.poll())
					};
					for (const region of this.#control.regions) {
						bindings[region.importName] = new runtime.Suspending!(
							(...args: (number | bigint)[]) => {
								if (!this.#coordinator || Number(this.#serial!.value) !== 0) {
									(this.#instance.exports[region.exportName] as CallableFunction)(
										...args
									);
									return;
								}
								return this.#coordinator.enqueue({
									export: region.exportName,
									args
								});
							}
						);
					}
					return (controlBindings = bindings);
				}
				const namespace = Reflect.get(supplied, module, supplied);
				const memories = imported.filter((item) => item.module === module);
				if (
					!memories.length ||
					(namespace !== undefined &&
						(namespace === null || !['object', 'function'].includes(typeof namespace)))
				)
					return namespace;
				return new Proxy(Object.create(null), {
					get: (_, name: string) => {
						const item = memories.find((item) => item.name === name);
						if (!item)
							return namespace === undefined
								? undefined
								: Reflect.get(namespace, name, namespace);
						let bound =
							options.memory ??
							(namespace === undefined
								? undefined
								: Reflect.get(namespace, name, namespace));
						if (bound === undefined) {
							const key = JSON.stringify([module, name]);
							bound = automatic.get(key);
							if (!bound) {
								const descriptor = descriptors.find(
									(value) => value.module === module && value.name === name
								);
								if (!descriptor || descriptor.memory64)
									throw new TypeError(
										`provide imported memory ${module}.${name}`
									);
								bound = new WebAssembly.Memory({
									initial: descriptor.initial,
									...(descriptor.maximum === undefined
										? {}
										: { maximum: descriptor.maximum }),
									shared: descriptor.shared
								});
								automatic.set(key, bound);
							}
						}
						if (isMemory(bound)) {
							this.#memories[`${module}.${name}`] = bound;
							if (imported.length === 1) this.#memory = bound;
						}
						return bound;
					}
				});
			}
		});
		// JSPI Promise resolution can assimilate an externref Promise result.
		// Only explicitly asynchronous entries get that ABI; ordinary exports
		// retain their native identity and return-value semantics.
		const promising = options.promising ?? [];
		for (const name of promising) {
			if (
				!WebAssembly.Module.exports(native).some(
					(value) => value.name === name && value.kind === 'function'
				)
			)
				throw new TypeError(`unknown promising export: ${name}`);
			if (!runtime.promising) throw new Error('this runtime does not support JSPI');
		}
		this.#instance = new WebAssembly.Instance(executable, imports);
		if (this.#control) {
			this.#exports = Object.create(null);
			for (const item of WebAssembly.Module.exports(native)) {
				Object.defineProperty(this.#exports, item.name, {
					value: this.#instance.exports[item.name],
					enumerable: true
				});
			}
			Object.preventExtensions(this.#exports);
			const arena = this.#instance.exports[this.#control.memoryExport];
			if (isMemory(arena)) this.#memory = arena;
			for (const entry of this.#control.entries) {
				this.#controlled.set(
					entry,
					runtime.promising!(this.#instance.exports[entry] as CallableFunction)
				);
			}
		} else this.#exports = this.#instance.exports;
		for (const [name, value] of Object.entries(this.#exports)) {
			if (isMemory(value)) this.#memories[`exports.${name}`] = value;
		}
		if (!imported.length) {
			const own = Object.values(this.#exports).filter(isMemory);
			if (own.length === 1) this.#memory = own[0] as WebAssembly.Memory;
		}
		Object.freeze(this.#memories);
		for (const name of promising) {
			const entry = this.#exports[name];
			this.#promising.set(name, runtime.promising!(entry as CallableFunction));
		}
	}

	/** Instantiates the program, starts the worker group and returns a ready pool. */
	static async open(input: ProgramInput, options: FolioOptions = {}): Promise<Folio> {
		const program: PreparedProgram = isModule(input)
			? {
					original: new Uint8Array(),
					compiled: input,
					loops: {},
					reasons: ['compiled module has no inspectable source bytes']
				}
			: isUint8Array(input) || isArrayBuffer(input)
				? (await import('./compiler.ts')).prepare(
						isUint8Array(input) ? input : new Uint8Array(input),
						{
							minimumRegionWork: options.minimumRegionWork,
							assumedTripCount: options.assumedTripCount
						}
					)
				: input;
		const size = options.workers ?? Math.min(4, availableParallelism());
		if (!Number.isInteger(size) || size < 1 || size > 64)
			throw new RangeError('invalid worker count');
		const pool = new Folio(program, options, size);
		const transactional = pool.#control?.transactional ?? program.transactional;
		if (!transactional || size === 1) return pool;
		if (pool.#control && !isSharedArrayBuffer(pool.memory.buffer)) {
			try {
				pool.#workerMemory = new WebAssembly.Memory({
					initial: pool.memory.buffer.byteLength / 65536,
					maximum: pool.#control.maximum,
					shared: true
				});
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
				pool.#runtimeDiagnostics.push(
					'shared worker arena allocation unavailable; using native execution'
				);
				return pool;
			}
		} else pool.#workerMemory = pool.memory;
		if (!isSharedArrayBuffer(pool.#workerMemory.buffer))
			throw new TypeError('physical sharing requires shared memory');
		const module = new WebAssembly.Module(Uint8Array.from(transactional));
		const nativeModule = new WebAssembly.Module(
			Uint8Array.from(pool.#control?.workerOriginal ?? program.original)
		);
		for (const entry of WebAssembly.Module.exports(nativeModule)) {
			if (entry.kind === 'function') pool.#workerExports.add(entry.name);
		}
		const memoryImport = WebAssembly.Module.imports(module).find(
			(item) => item.kind === 'memory'
		)!;
		try {
			await Promise.all(
				Array.from(
					{ length: size },
					() =>
						new Promise<void>((resolve, reject) => {
							const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
							const worker = new Worker(
								new URL(`./worker.${extension}`, import.meta.url),
								{
									workerData: {
										module,
										nativeModule,
										memory: pool.#workerMemory,
										importModule: memoryImport.module,
										importName: memoryImport.name
									}
								}
							);
							pool.#workers.push(worker);
							worker.on('message', (message) => {
								if (message.ready) {
									pool.threadIds.push(message.threadId);
									resolve();
								} else {
									if (message.results) {
										for (const result of message.results) {
											if (result.numberBits !== undefined)
												result.value = restoreNumbers(
													result.value,
													result.numberBits
												);
										}
									}
									if (message.numberBits !== undefined)
										message.value = restoreNumbers(
											message.value,
											message.numberBits
										);
									const pending = pool.#pending.get(message.id);
									pool.#pending.delete(message.id);
									pending?.resolve(message.results ?? message);
								}
							});
							const fail = (error: Error) => {
								pool.#failure = error;
								reject(error);
								for (const pending of pool.#pending.values()) pending.reject(error);
								pool.#pending.clear();
							};
							worker.on('error', fail);
							worker.on('exit', (code) => {
								if (!pool.#closed)
									fail(new Error(`isolate exited with code ${code}`));
							});
						})
				)
			);
			return pool;
		} catch (error) {
			await pool.close();
			throw error;
		}
	}

	async #native(call: Call): Promise<{ value: unknown }> {
		if (this.#closed) throw new Error('folio is closed');
		const entry = this.#instance.exports[call.export];
		if (typeof entry !== 'function')
			throw new TypeError(`unknown function export: ${call.export}`);
		const wrapped = this.#promising.get(call.export) ?? this.#controlled.get(call.export);
		if (!wrapped) return { value: entry(...call.args) };
		const pending = wrapped(...call.args);
		this.#nativePending.add(pending);
		try {
			return { value: await pending };
		} finally {
			this.#nativePending.delete(pending);
		}
	}

	#dispatch(worker: Worker, call: Call, native = false): Promise<TransactionResult> {
		if (this.#closed) return Promise.reject(new Error('folio is closed'));
		return new Promise((resolve, reject) => {
			const id = this.#nextId++;
			this.#pending.set(id, { resolve, reject });
			try {
				worker.postMessage({
					id,
					call,
					argumentBits: numberBits(call.args),
					native,
					profile: this.#profile,
					fuel: this.#fuel,
					maxBytes: this.#maxBytes
				});
			} catch (error) {
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	#dispatchBatch(worker: Worker, calls: readonly Call[]): Promise<TransactionResult[]> {
		if (this.#closed) return Promise.reject(new Error('folio is closed'));
		return new Promise((resolve, reject) => {
			const id = this.#nextId++;
			this.#pending.set(id, { resolve, reject });
			try {
				worker.postMessage({
					id,
					calls,
					argumentBits: calls.map((call) => numberBits(call.args)),
					profile: this.#profile,
					fuel: this.#fuel,
					maxBytes: this.#maxBytes
				});
			} catch (error) {
				this.#pending.delete(id);
				reject(error);
			}
		});
	}
	#width(options: RunOptions): number {
		const limit = options.maximumWorkers ?? this.#workers.length;
		if (
			options.maximumWorkers !== undefined &&
			(!Number.isInteger(limit) || limit < 1 || limit > 64)
		)
			throw new RangeError('invalid maximumWorkers');
		return Math.min(limit, this.#workers.length);
	}

	/** Splits compiler-recognized loops automatically; otherwise runs the original entry. */
	async run(
		entry: string,
		args: Call['args'] = [],
		options: RunOptions = {}
	): Promise<ExecutionReport> {
		const width = this.#width(options);
		const plan = Object.hasOwn(this.#program.loops, entry)
			? this.#program.loops[entry]
			: undefined;
		const proved =
			this.#program.native && Object.hasOwn(this.#program.native, entry)
				? this.#program.native[entry]
				: undefined;
		const numeric = args.every((arg) => typeof arg === 'number');
		const control = this.#controlled.get(entry);
		const routeKey =
			this.#adaptive &&
			options.parallel !== 'off' &&
			options.parallel !== 'speculate' &&
			width >= 2 &&
			(plan || control) &&
			args.every((arg) => typeof arg === 'number' || typeof arg === 'bigint')
				? JSON.stringify([
						entry,
						width,
						this.#memory?.buffer.byteLength,
						args.map((arg) => (typeof arg === 'bigint' ? `${arg}n` : arg))
					])
				: undefined;
		const history = routeKey ? this.#routing.get(routeKey) : undefined;
		if (history && history.remaining > 0) {
			history.remaining--;
			const report = await this.runAll([{ export: entry, args }], { parallel: 'off' });
			report.reason = 'previous-conflicts';
			return report;
		}
		if (
			!plan &&
			control &&
			width >= 2 &&
			options.parallel !== 'off' &&
			args.every((arg) => typeof arg === 'number' || typeof arg === 'bigint')
		) {
			const report = await this.#runControlled(control, args, width);
			this.#observeRouting(routeKey, report);
			return report;
		}
		const count =
			numeric && plan && typeof args[plan.countParameter] === 'number'
				? Number(args[plan.countParameter]) >>> 0
				: 0;
		const work = numeric
			? proved?.workParameters.reduce(
					(value, parameter) => value * (Number(args[parameter]) >>> 0),
					count
				)
			: undefined;
		if (!plan || count < 2 || !numeric || width < 2 || options.parallel === 'off') {
			const report = await this.runAll([{ export: entry, args }], { parallel: 'off' });
			report.reason =
				options.parallel === 'off'
					? 'requested'
					: !numeric
						? 'opaque-input'
						: !this.#workers.length
							? 'unsupported-module'
							: !plan
								? 'no-parallel-plan'
								: 'single-region';
			return report;
		}
		if (options.parallel !== 'speculate' && work !== undefined && work < this.#minimumWork) {
			const report = await this.runAll([{ export: entry, args }], { parallel: 'off' });
			report.reason = 'small-workload';
			return report;
		}
		const regions = Math.min(count, width);
		const calls: Call[] = [];
		let begin = 0;
		for (let index = 0; index < regions; index++) {
			const end = Math.floor(((index + 1) * count) / regions);
			const parameters = [...args];
			parameters[plan.countParameter] = end - begin;
			for (const { parameter, step } of plan.steps) {
				parameters[parameter] =
					((Number(args[parameter]) | 0) + Math.imul(begin, step)) | 0;
			}
			calls.push({ export: entry, args: parameters });
			begin = end;
		}
		const disjoint =
			proved && options.parallel !== 'speculate' && this.#disjoint(calls, proved, plan);
		const report = disjoint
			? await this.#nativeRegions(calls)
			: await this.runAll(calls, options);
		if (proved && !disjoint && options.parallel !== 'speculate' && !report.reason)
			report.reason = 'guard-failed';
		this.#observeRouting(routeKey, report);
		return { ...report, values: [undefined] };
	}

	#observeRouting(key: string | undefined, report: ExecutionReport): void {
		if (!key) return;
		const expensive =
			report.mode === 'speculative' &&
			(report.fallbacks > 0 ||
				(report.regions > 1 && report.replayed / (report.regions - 1) >= 0.5));
		if (!expensive) {
			this.#routing.delete(key);
			return;
		}
		const failures = Math.min(2, (this.#routing.get(key)?.failures ?? 0) + 1);
		if (!this.#routing.has(key) && this.#routing.size >= 256)
			this.#routing.delete(this.#routing.keys().next().value!);
		this.#routing.set(key, { failures, remaining: failures >= 2 ? 16 : 0 });
	}

	async #runControlled(
		entry: (...args: any[]) => Promise<unknown>,
		args: Call['args'],
		width: number
	): Promise<ExecutionReport> {
		if (this.#closed) throw new Error('folio is closed');
		if (this.#failure) throw this.#failure;
		if (this.#busy) throw new Error('memory already has an active run');
		this.#busy = true;
		const started = this.#profile ? performance.now() : 0;
		const coordinator = new Coordinator({
			memory: this.memory,
			workerMemory: this.#workerMemory!,
			width,
			profile: this.#profile,
			pending: this.#queued,
			dispatch: (worker, calls) => this.#dispatchBatch(this.#workers[worker]!, calls),
			native: (call) => {
				const previous = this.#serial!.value;
				this.#serial!.value = 1;
				try {
					(this.#instance.exports[call.export] as CallableFunction)(...call.args);
				} finally {
					this.#serial!.value = previous;
				}
			}
		});
		this.#coordinator = coordinator;
		this.#serial!.value = 0;
		const pending = (async () => {
			let value: unknown;
			let failed = false;
			let failure: unknown;
			try {
				value = await entry(...args);
			} catch (error) {
				failed = true;
				failure = error;
			}
			// If the original coordinator traps first, pending preceding regions still
			// own the earlier effects/trap in program order.
			await coordinator.flush();
			if (failed) throw failure;
			coordinator.report.values = [value];
			return coordinator.report;
		})();
		this.#nativePending.add(pending);
		try {
			return await pending;
		} finally {
			if (coordinator.report.profile)
				coordinator.report.profile.wallMs = performance.now() - started;
			this.#nativePending.delete(pending);
			this.#serial!.value = 1;
			this.#queued!.value = 0;
			this.#coordinator = undefined;
			this.#busy = false;
		}
	}

	#disjoint(
		calls: Call[],
		proved: NativePlan,
		plan: NonNullable<PreparedProgram['loops'][string]>
	): boolean {
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
		for (let i = 0; i < footprints.length; i++) {
			for (const range of footprints[i]!) {
				if (range.wrap || range.start < 0 || range.end > this.memory.buffer.byteLength)
					return false;
				for (const other of footprints.slice(0, i).flat()) {
					if (
						(range.write || other.write) &&
						range.start < other.end &&
						other.start < range.end
					)
						return false;
				}
			}
		}
		return true;
	}

	async #nativeRegions(calls: Call[]): Promise<ExecutionReport> {
		if (this.#closed) throw new Error('folio is closed');
		if (this.#failure) throw this.#failure;
		if (this.#busy) throw new Error('memory already has an active run');
		this.#busy = true;
		const started = this.#profile ? performance.now() : 0;
		try {
			const outcomes = await Promise.allSettled(
				calls.map((call, index) => this.#dispatch(this.#workers[index]!, call, true))
			);
			for (const outcome of outcomes) {
				if (outcome.status === 'rejected' || outcome.value.trap) {
					this.#failure = new Error(
						'native region failed; arena may contain partial writes'
					);
					await this.close();
					throw this.#failure;
				}
			}
			const results = outcomes.map(
				(outcome) => (outcome as PromiseFulfilledResult<TransactionResult>).value
			);
			return {
				values: [],
				workers: calls.length,
				regions: calls.length,
				replayed: 0,
				fallbacks: 0,
				mode: 'native-shared',
				...(this.#profile
					? {
							profile: {
								wallMs: performance.now() - started,
								workerWallMs: results.map((r) => r.timing!.wallMs),
								workerCpuMs: results.map((r) => r.timing!.cpuMs),
								validationMs: 0,
								commitMs: 0,
								replayMs: 0,
								readBytes: 0,
								writeBytes: 0
							}
						}
					: {})
			};
		} finally {
			this.#busy = false;
		}
	}

	/** Preserves call order while discovering memory dependencies at runtime. */
	async runAll(calls: readonly Call[], options: RunOptions = {}): Promise<ExecutionReport> {
		const width = this.#width(options);
		if (this.#closed) throw new Error('folio is closed');
		if (this.#failure) throw this.#failure;
		if (this.#busy) throw new Error('memory already has an active run');
		for (const call of calls) {
			if (typeof this.#instance.exports[call.export] !== 'function')
				throw new TypeError(`unknown function export: ${call.export}`);
		}
		this.#busy = true;
		const started = this.#profile ? performance.now() : 0;
		const report: ExecutionReport = {
			values: [],
			workers: 0,
			regions: calls.length,
			replayed: 0,
			fallbacks: 0,
			mode: 'serial'
		};
		const profile: ExecutionProfile | undefined = this.#profile
			? {
					wallMs: 0,
					workerWallMs: [],
					workerCpuMs: [],
					validationMs: 0,
					commitMs: 0,
					replayMs: 0,
					readBytes: 0,
					writeBytes: 0
				}
			: undefined;
		if (profile) report.profile = profile;
		const observe = (result: TransactionResult) => {
			if (!profile) return;
			profile.workerWallMs.push(result.timing!.wallMs);
			profile.workerCpuMs.push(result.timing!.cpuMs);
			profile.readBytes += result.reads.length;
			profile.writeBytes += result.writes.length;
		};
		const commit = (result: TransactionResult, bytes: Uint8Array, dirty: Set<number>) => {
			const before = profile ? performance.now() : 0;
			const shared =
				this.#workerMemory && this.#workerMemory !== this.#memory
					? new Uint8Array(this.#workerMemory.buffer)
					: undefined;
			for (const [address, value] of result.writes) {
				bytes[address] = value;
				if (shared) shared[address] = value;
				dirty.add(address);
			}
			if (profile) profile.commitMs += performance.now() - before;
		};
		try {
			const opaque = calls.some((call) =>
				call.args.some((arg) => typeof arg !== 'number' && typeof arg !== 'bigint')
			);
			const unsupported = calls.some((call) => !this.#workerExports.has(call.export));
			if (
				width < 2 ||
				calls.length < 2 ||
				options.parallel === 'off' ||
				opaque ||
				unsupported
			) {
				report.reason =
					options.parallel === 'off'
						? 'requested'
						: opaque
							? 'opaque-input'
							: !this.#workers.length || unsupported
								? 'unsupported-module'
								: 'single-region';
				for (const call of calls) report.values.push((await this.#native(call)).value);
				return report;
			}
			report.mode = 'speculative';
			report.workers = Math.min(width, calls.length);
			for (let start = 0; start < calls.length; start += width) {
				const batch = calls.slice(start, start + width);
				if (this.#workerMemory && this.#workerMemory !== this.#memory) {
					try {
						const pages = this.memory.buffer.byteLength / 65536;
						const current = this.#workerMemory.buffer.byteLength / 65536;
						if (pages > current) this.#workerMemory.grow(pages - current);
						new Uint8Array(this.#workerMemory.buffer).set(
							new Uint8Array(this.memory.buffer)
						);
						report.memoryMode = 'snapshot';
						report.snapshotBytes =
							(report.snapshotBytes ?? 0) + this.memory.buffer.byteLength;
					} catch (error) {
						if (!(error instanceof RangeError)) throw error;
						report.fallbacks++;
						report.reason = 'snapshot-unavailable';
						if (start === 0) {
							report.mode = 'serial';
							report.workers = 0;
						}
						for (const call of calls.slice(start))
							report.values.push((await this.#native(call)).value);
						return report;
					}
				}
				const outcomes = await Promise.allSettled(
					batch.map((call, index) => this.#dispatch(this.#workers[index]!, call))
				);
				const failure = outcomes.find((outcome) => outcome.status === 'rejected');
				if (failure?.status === 'rejected') {
					await this.close();
					throw failure.reason;
				}
				const dirty = new Set<number>();
				const bytes = new Uint8Array(this.memory.buffer);
				for (let index = 0; index < batch.length; index++) {
					const outcome = outcomes[index]!;
					if (outcome.status !== 'fulfilled') throw new Error('unreachable outcome');
					const result = outcome.value;
					observe(result);
					const validationStart = profile ? performance.now() : 0;
					const conflict = result.reads.some((address) => dirty.has(address));
					if (profile) profile.validationMs += performance.now() - validationStart;
					if (result.exhausted || conflict) {
						if (result.exhausted) report.fallbacks++;
						else {
							report.replayed++;
							report.reason = 'dependency';
						}
						// replay uses tracking so later validations include its actual writes
						const replayStart = profile ? performance.now() : 0;
						const replay = await this.#dispatch(this.#workers[0]!, batch[index]!);
						observe(replay);
						if (profile) profile.replayMs += performance.now() - replayStart;
						if (replay.exhausted) {
							report.values.push((await this.#native(batch[index]!)).value);
							for (let rest = index + 1; rest < batch.length; rest++)
								report.values.push((await this.#native(batch[rest]!)).value);
							break;
						}
						commit(replay, bytes, dirty);
						throwTrap(replay);
						report.values.push(replay.value);
					} else {
						commit(result, bytes, dirty);
						throwTrap(result);
						report.values.push(result.value);
					}
				}
			}
			return report;
		} finally {
			if (profile) profile.wallMs = performance.now() - started;
			this.#busy = false;
		}
	}

	/** Joins worker termination and outstanding JSPI calls. Repeated calls share one join. */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(new Error('folio is closed'));
		this.#pending.clear();
		this.#closing = Promise.all([
			...this.#workers.map((worker) => worker.terminate()),
			...Array.from(this.#nativePending, (pending) => pending.catch(() => {}))
		]).then(() => {});
		return this.#closing;
	}

	/** `await using` support; equivalent to `close()`. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}
