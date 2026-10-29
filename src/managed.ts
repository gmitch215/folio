import type { RegionCall } from './coordinator.ts';
import { Coordinator } from './coordinator.ts';
import type { ControlPlan } from './extract.ts';
import type { FrameIdentity } from './frames.ts';
import {
	decodeFrame,
	decodeResults,
	encodeFrame,
	encodeResults,
	encodeSnapshot,
	restoreSnapshot,
	snapshotLength,
	type SnapshotPages,
	validateIdentity
} from './frames.ts';
import type { MemoryImport } from './memory.ts';
import type { ExecutionReport } from './node.ts';
import type { TransactionResult } from './transaction.ts';
import { SpeculationLimit, transaction } from './transaction.ts';

/** Precompiled modules for the managed backend. Nothing is compiled at request time. */
export interface ManagedArtifact {
	/** The source program; serial and fallback execution use it unchanged. */
	original: WebAssembly.Module;
	/** The JSPI coordinator that discovers and joins regions. */
	coordinator?: WebAssembly.Module;
	/** The tracked region module each lane runs. */
	transactional?: WebAssembly.Module;
	/** The control plan from `prepare`, minus the module bytes carried above. */
	control?: Omit<ControlPlan, 'coordinator' | 'workerOriginal' | 'transactional'>;
	/** Imported memory limits of the source module, from `memoryImports`. */
	memories?: readonly MemoryImport[];
}

/** One lane: sends a binary frame to a lane runtime and returns its binary response. */
export interface ManagedLaneTransport {
	/** Delivers a frame to a `FolioLane` and resolves with the response frame. */
	execute(frame: Uint8Array): Promise<Uint8Array>;
	/** Releases the lane's connection or object. */
	close?(): Promise<void>;
}

/** An `ExecutionReport` for the managed backend, which always copies snapshots. */
export interface ManagedReport extends Omit<ExecutionReport, 'memoryMode'> {
	/** Logical snapshot bytes represented across lanes; encoded traffic is in transportBytes. */
	snapshotBytes?: number;
	/** Always `managed-coherent`. */
	backend: 'managed-coherent';
	/** Lanes read copied snapshots, never shared memory. */
	memoryMode: 'copied';
	/** Encoded frame bytes sent to and received from lanes; platform internal copies are not visible. */
	transportBytes: { sent: number; received: number };
	/** Batches that ran natively at the owner after a transport failure or malformed reply. */
	transportFallbacks: number;
}

type Runtime = typeof WebAssembly & {
	Suspending?: new (fn: (...args: any[]) => any) => WebAssembly.ImportValue;
	promising?: (fn: CallableFunction) => (...args: any[]) => Promise<unknown>;
};
type ExecuteRequest = FrameIdentity & {
	calls: RegionCall[];
	fuel: number;
	maxBytes: number;
	snapshot?: SnapshotPages;
};

function integer(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new RangeError(`invalid ${label}`);
	return value;
}

/**
 * The lane runtime: runs tracked regions from a binary frame against a private copy of the
 * frozen snapshot and returns byte read and write sets. Holds no state between frames.
 */
export class FolioLane {
	readonly #module: WebAssembly.Module;
	readonly #initial: number;
	readonly #maximum: number;
	readonly #maximumFrameBytes: number;
	readonly #maximumMemoryBytes: number;
	#memory?: WebAssembly.Memory;
	#instance?: WebAssembly.Instance;
	#active?: ReturnType<typeof transaction>;

	constructor(
		module: WebAssembly.Module,
		options: {
			initial: number;
			maximum: number;
			maximumMemoryBytes?: number;
			maximumFrameBytes?: number;
		}
	) {
		this.#module = module;
		this.#initial = integer(options.initial, 0, 65536, 'initial memory');
		this.#maximum = integer(options.maximum, this.#initial, 65536, 'maximum memory');
		this.#maximumMemoryBytes = options.maximumMemoryBytes ?? 32 * 1048576;
		this.#maximumFrameBytes = options.maximumFrameBytes ?? this.#maximumMemoryBytes + 1048576;
		integer(this.#maximumMemoryBytes, 65536, 0x100000000, 'lane memory limit');
		integer(this.#maximumFrameBytes, 65536, 0x100100000, 'lane frame limit');
	}

	/** Validates the frame, runs its calls in order and returns the encoded results. */
	execute(frame: Uint8Array): Uint8Array {
		const { header, payload } = decodeFrame<ExecuteRequest>(frame, this.#maximumFrameBytes);
		validateIdentity(header);
		integer(header.fuel, 1, 1000000000, 'fuel');
		integer(header.maxBytes, 8, 1048576, 'tracking budget');
		if (!Array.isArray(header.calls) || !header.calls.length || header.calls.length > 16)
			throw new RangeError('invalid lane call count');
		for (const call of header.calls) {
			if (
				typeof call?.export !== 'string' ||
				!Array.isArray(call.args) ||
				call.args.length > 256 ||
				call.args.some((value) => typeof value !== 'number' && typeof value !== 'bigint')
			)
				throw new TypeError('invalid lane call');
		}
		const memoryBytes = snapshotLength(header.snapshot, payload);
		const pages = memoryBytes / 65536;
		if (
			!Number.isInteger(pages) ||
			pages < this.#initial ||
			pages > this.#maximum ||
			memoryBytes > this.#maximumMemoryBytes
		)
			throw new RangeError('invalid lane snapshot');
		if (!this.#memory || !this.#instance || this.#memory.buffer.byteLength !== memoryBytes) {
			const binding = WebAssembly.Module.imports(this.#module).filter(
				(item) => item.kind === 'memory'
			);
			if (binding.length !== 1) throw new TypeError('one lane memory required');
			this.#memory = new WebAssembly.Memory({
				initial: pages,
				maximum: this.#maximum,
				shared: true
			});
			this.#instance = new WebAssembly.Instance(this.#module, {
				[binding[0]!.module]: { [binding[0]!.name]: this.#memory },
				folio: {
					load: (...args: [number, number, number, number]) =>
						this.#active!.load(...args),
					store: (...args: [number, number, number, number]) =>
						this.#active!.store(...args),
					load64: (...args: [number, number, number, number]) =>
						this.#active!.load64(...args),
					store64: (...args: [number, bigint, number, number]) =>
						this.#active!.store64(...args),
					copy: (...args: [number, number, number]) => this.#active!.copy(...args),
					fill: (...args: [number, number, number]) => this.#active!.fill(...args),
					exhausted: () => {
						throw new SpeculationLimit('speculative instruction budget');
					}
				}
			});
		}
		restoreSnapshot(new Uint8Array(this.#memory.buffer), payload, header.snapshot);
		let remaining = header.maxBytes;
		const results: TransactionResult[] = [];
		for (const call of header.calls) {
			if (remaining <= 0) {
				results.push({ reads: [], writes: [], exhausted: true });
				continue;
			}
			this.#active = transaction(this.#memory, remaining);
			let error: unknown, value: unknown;
			try {
				(this.#instance!.exports.__folio_set_fuel as CallableFunction)(header.fuel);
				const entry = this.#instance!.exports[call.export];
				if (typeof entry !== 'function') throw new TypeError('unknown lane export');
				value = entry(...call.args);
			} catch (caught) {
				error = caught;
			}
			if (error instanceof RangeError) {
				results.push({ reads: [], writes: [], exhausted: true });
				continue;
			}
			const result = this.#active.result(value, error);
			remaining -= result.reads.length + result.writes.length;
			results.push(result);
		}
		this.#active = undefined;
		return encodeResults(header, results, this.#maximumFrameBytes);
	}

	/** Drops the instance and its memory; a later frame builds them again. */
	close(): void {
		this.#active = this.#instance = this.#memory = undefined;
	}
}

/**
 * The owner side of the managed backend. The original Wasm stack keeps control flow and host
 * effects, and JSPI joins regions that lanes execute over copied snapshots.
 */
export class ManagedFolio {
	/** The original native exports. */
	readonly exports: WebAssembly.Exports;
	/** Optimization refusals and fallbacks seen so far. */
	readonly diagnostics: string[] = [];
	readonly #artifact: ManagedArtifact;
	readonly #lanes: readonly ManagedLaneTransport[];
	readonly #instance: WebAssembly.Instance;
	readonly #serial = new WebAssembly.Global({ value: 'i32', mutable: true }, 1);
	readonly #pendingGlobal = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
	readonly #controlled = new Map<string, (...args: any[]) => Promise<unknown>>();
	readonly #promising = new Map<string, (...args: any[]) => Promise<unknown>>();
	readonly #maximumSnapshotBytes: number;
	readonly #maximumFrameBytes: number;
	readonly #fuel: number;
	readonly #maxBytes: number;
	readonly #snapshotEncoding: 'auto' | 'dense';
	readonly #session = crypto.randomUUID();
	#memory?: WebAssembly.Memory;
	#scheduler?: Coordinator;
	#epoch = 0;
	#sequence = 0;
	#busy = false;
	#closed = false;
	#pending?: Promise<ManagedReport>;
	#closing?: Promise<void>;

	constructor(
		artifact: ManagedArtifact,
		options: {
			lanes: readonly ManagedLaneTransport[];
			imports?: WebAssembly.Imports;
			memory?: WebAssembly.Memory;
			fuel?: number;
			maxTransactionBytes?: number;
			maximumSnapshotBytes?: number;
			maximumFrameBytes?: number;
			promising?: readonly string[];
			/** `dense` (default) sends the whole snapshot; `auto` elides zero pages, which lanes from 1.0.0 reject. */
			snapshotEncoding?: 'auto' | 'dense';
		}
	) {
		this.#artifact = artifact;
		this.#snapshotEncoding = options.snapshotEncoding ?? 'dense';
		if (!['auto', 'dense'].includes(this.#snapshotEncoding))
			throw new TypeError('invalid snapshot encoding');
		this.#lanes = options.lanes;
		integer(this.#lanes.length, 1, 64, 'lane count');
		this.#maximumSnapshotBytes = integer(
			options.maximumSnapshotBytes ?? 32 * 1048576,
			65536,
			0x100000000,
			'snapshot limit'
		);
		this.#maximumFrameBytes = integer(
			options.maximumFrameBytes ?? this.#maximumSnapshotBytes + 1048576,
			65536,
			0x100100000,
			'frame limit'
		);
		this.#fuel = integer(options.fuel ?? 100000000, 1, 1000000000, 'fuel');
		this.#maxBytes = integer(
			options.maxTransactionBytes ?? 262144,
			8,
			1048576,
			'tracking budget'
		);
		const runtime = WebAssembly as Runtime;
		const control = artifact.control;
		let module = artifact.original,
			enabled = false;
		if (
			control &&
			artifact.coordinator &&
			runtime.Suspending &&
			runtime.promising &&
			this.#lanes.length > 1
		) {
			const original = WebAssembly.Module.imports(artifact.original);
			const retained = WebAssembly.Module.imports(artifact.coordinator).filter(
				(item) => item.module !== control.namespace
			);
			if (JSON.stringify(original) === JSON.stringify(retained)) {
				module = artifact.coordinator;
				enabled = true;
			} else
				this.diagnostics.push('rewritten import sequence differs; using native execution');
		} else this.diagnostics.push('no active coordinator; using native execution');
		const supplied = options.imports ?? Object.create(null);
		const memories = WebAssembly.Module.imports(artifact.original).filter(
			(item) => item.kind === 'memory'
		);
		if (memories.length > 1 && options.memory)
			throw new TypeError('bind multiple memories by name in imports');
		const automatic = new Map<string, WebAssembly.Memory>();
		const imports = new Proxy(Object.create(null), {
			get: (_, namespace: string) => {
				if (enabled && namespace === control!.namespace) {
					const bindings: Record<string, WebAssembly.ImportValue> = {
						[control!.serialGlobal]: this.#serial,
						[control!.pendingGlobal]: this.#pendingGlobal,
						barrier: new runtime.Suspending!(() => this.#scheduler?.flush()),
						poll: new runtime.Suspending!(() => this.#scheduler?.poll())
					};
					for (const region of control!.regions)
						bindings[region.importName] = new runtime.Suspending!(
							(...args: (number | bigint)[]) => {
								if (this.#scheduler && this.#serial.value === 0)
									return this.#scheduler.enqueue({
										export: region.exportName,
										args
									});
								(this.#instance.exports[region.exportName] as CallableFunction)(
									...args
								);
							}
						);
					return bindings;
				}
				const bound = Reflect.get(supplied, namespace, supplied);
				if (!memories.some((item) => item.module === namespace)) return bound;
				if (
					bound !== undefined &&
					(bound === null || !['object', 'function'].includes(typeof bound))
				)
					return bound;
				return new Proxy(Object.create(null), {
					get: (_, name: string) => {
						if (
							!memories.some(
								(item) => item.module === namespace && item.name === name
							)
						)
							return bound === undefined
								? undefined
								: Reflect.get(bound, name, bound);
						let memory =
							(memories.length === 1 ? options.memory : undefined) ??
							(bound === undefined ? undefined : Reflect.get(bound, name, bound));
						if (memory === undefined) {
							const key = JSON.stringify([namespace, name]);
							memory = automatic.get(key);
							if (!memory) {
								const limits = artifact.memories?.find(
									(item) => item.module === namespace && item.name === name
								);
								if (!limits || limits.memory64)
									throw new TypeError(
										`provide imported memory ${namespace}.${name}`
									);
								memory = new WebAssembly.Memory({
									initial: limits.initial,
									...(limits.maximum === undefined
										? {}
										: { maximum: limits.maximum }),
									shared: limits.shared
								});
								automatic.set(key, memory);
							}
						}
						if (memories.length === 1) this.#memory = memory;
						return memory;
					}
				});
			}
		});
		this.#instance = new WebAssembly.Instance(module, imports);
		this.exports = Object.create(null);
		for (const item of WebAssembly.Module.exports(artifact.original))
			Object.defineProperty(this.exports, item.name, {
				value: this.#instance.exports[item.name],
				enumerable: true
			});
		Object.freeze(this.exports);
		if (enabled) {
			this.#memory = this.#instance.exports[control!.memoryExport] as WebAssembly.Memory;
			for (const name of control!.entries)
				this.#controlled.set(
					name,
					runtime.promising!(this.#instance.exports[name] as CallableFunction)
				);
		} else if (!this.#memory) {
			const own = Object.values(this.exports).filter(
				(item) => item instanceof WebAssembly.Memory
			);
			if (own.length === 1) this.#memory = own[0] as WebAssembly.Memory;
		}
		for (const name of options.promising ?? []) {
			if (!runtime.promising || typeof this.exports[name] !== 'function')
				throw new TypeError('invalid promising export');
			this.#promising.set(name, runtime.promising(this.exports[name] as CallableFunction));
		}
	}

	/** The canonical memory, which must fit the owner runtime. Throws when there is no unique one. */
	get memory(): WebAssembly.Memory {
		if (!this.#memory) throw new TypeError('no unique accessible memory');
		return this.#memory;
	}

	/** Runs one entry; regions go to lanes and results commit in order. One run at a time. */
	run(
		name: string,
		args: readonly unknown[] = [],
		options: { maximumWorkers?: number; parallel?: 'auto' | 'off' } = {}
	): Promise<ManagedReport> {
		if (this.#closed) return Promise.reject(new Error('folio is closed'));
		if (this.#busy) return Promise.reject(new Error('memory already has an active run'));
		const entry = this.exports[name];
		if (typeof entry !== 'function')
			return Promise.reject(new TypeError('unknown function export'));
		const width = Math.min(
			this.#lanes.length,
			integer(options.maximumWorkers ?? this.#lanes.length, 1, 64, 'maximumWorkers')
		);
		this.#busy = true;
		let resolve!: (value: ManagedReport) => void, reject!: (error: unknown) => void;
		const pending = new Promise<ManagedReport>((success, failure) => {
			resolve = success;
			reject = failure;
		});
		this.#pending = pending;
		void pending
			.finally(() => {
				this.#busy = false;
				this.#pending = undefined;
			})
			.catch(() => {});
		void this.#execute(name, entry, args, width, options.parallel === 'off').then(
			resolve,
			reject
		);
		return pending;
	}

	async #execute(
		name: string,
		entry: CallableFunction,
		args: readonly unknown[],
		width: number,
		serial: boolean
	): Promise<ManagedReport> {
		const bytes = { sent: 0, received: 0 };
		let snapshotBytes = 0;
		let transportFallbacks = 0;
		const finish = (report: ExecutionReport): ManagedReport => ({
			...report,
			backend: 'managed-coherent',
			memoryMode: 'copied',
			transportBytes: bytes,
			transportFallbacks
		});
		const controlled = this.#controlled.get(name);
		if (
			serial ||
			!controlled ||
			width < 2 ||
			args.some((value) => typeof value !== 'number' && typeof value !== 'bigint')
		) {
			const value = this.#promising.has(name)
				? await this.#promising.get(name)!(...args)
				: entry(...args);
			return finish({
				values: [value],
				workers: 0,
				regions: 1,
				replayed: 0,
				fallbacks: 0,
				mode: 'serial'
			});
		}
		const epoch = ++this.#epoch;
		let snapshotGeneration = -1,
			snapshot: ReturnType<typeof encodeSnapshot>;
		const scheduler = new Coordinator({
			memory: this.memory,
			workerMemory: this.memory,
			width,
			profile: false,
			pending: this.#pendingGlobal,
			native: (call) => {
				const previous = this.#serial.value;
				this.#serial.value = 1;
				try {
					(this.#instance.exports[call.export] as CallableFunction)(...call.args);
				} finally {
					this.#serial.value = previous;
				}
			},
			dispatch: async (lane, calls, generation) => {
				try {
					if (this.memory.buffer.byteLength > this.#maximumSnapshotBytes)
						throw new RangeError('snapshot exceeds limit');
					const identity = { session: this.#session, epoch, sequence: ++this.#sequence };
					if (snapshotGeneration !== generation) {
						const memory = new Uint8Array(this.memory.buffer);
						snapshot =
							this.#snapshotEncoding === 'dense'
								? { payload: memory }
								: encodeSnapshot(memory);
						snapshotGeneration = generation;
					}
					const frame = encodeFrame(
						{
							...identity,
							calls,
							fuel: this.#fuel,
							maxBytes: this.#maxBytes,
							...(snapshot!.snapshot ? { snapshot: snapshot!.snapshot } : {})
						},
						snapshot!.payload,
						this.#maximumFrameBytes
					);
					snapshotBytes += this.memory.buffer.byteLength;
					bytes.sent += frame.length;
					const response = await this.#lanes[lane]!.execute(frame);
					bytes.received += response.length;
					return decodeResults(response, identity, {
						maximumFrameBytes: this.#maximumFrameBytes,
						memoryBytes: this.memory.buffer.byteLength,
						maxBytes: this.#maxBytes,
						calls: calls.length
					});
				} catch (error) {
					transportFallbacks++;
					this.diagnostics.push(
						`lane unavailable; native fallback: ${error instanceof Error ? error.message : String(error)}`
					);
					return calls.map(() => ({ reads: [], writes: [], exhausted: true }));
				}
			}
		});
		this.#scheduler = scheduler;
		this.#serial.value = 0;
		try {
			let value: unknown,
				failure: unknown,
				failed = false;
			try {
				value = await controlled(...args);
			} catch (error) {
				failed = true;
				failure = error;
			}
			await scheduler.flush();
			if (failed) throw failure;
			scheduler.report.values = [value];
			scheduler.report.snapshotBytes = snapshotBytes;
			return finish(scheduler.report);
		} finally {
			this.#serial.value = 1;
			this.#pendingGlobal.value = 0;
			this.#scheduler = undefined;
		}
	}

	/** Waits for the active run, then closes every lane. A failed disposer does not skip the rest. */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			await this.#pending?.catch(() => {});
			const outcomes = await Promise.allSettled(
				this.#lanes.map(async (lane) => lane.close?.())
			);
			const failed = outcomes.find((result) => result.status === 'rejected');
			if (failed?.status === 'rejected') throw failed.reason;
		})();
		return this.#closing;
	}

	/** `await using` support; equivalent to `close()`. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}
