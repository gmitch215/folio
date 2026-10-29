import type { ExecutionProfile, ExecutionReport } from './node.ts';
import type { TransactionResult } from './transaction.ts';

export interface RegionCall {
	export: string;
	args: readonly (number | bigint)[];
}

function trap(result: TransactionResult): void {
	if (!result.trap) return;
	if (result.errorKind === 'TypeError') throw new TypeError(result.trap);
	if (result.errorKind === 'RangeError') throw new RangeError(result.trap);
	throw new WebAssembly.RuntimeError(result.trap);
}

/** Owns only effect-free regions. The original Wasm stack remains the coordinator. */
export class Coordinator {
	readonly report: ExecutionReport;
	readonly #queue: RegionCall[] = [];
	readonly #memory: WebAssembly.Memory;
	readonly #workerMemory: WebAssembly.Memory;
	readonly #width: number;
	readonly #dispatch: (
		worker: number,
		calls: RegionCall[],
		generation: number
	) => Promise<TransactionResult[]>;
	readonly #native: (call: RegionCall) => void;
	readonly #profile?: ExecutionProfile;
	readonly #pending?: { value: unknown };
	#armed = false;
	#polls = 0;
	#generation = 0;
	#flushing?: Promise<void>;

	constructor(options: {
		memory: WebAssembly.Memory;
		workerMemory: WebAssembly.Memory;
		width: number;
		profile: boolean;
		/** Wasm global the generated barriers read; raised while regions are queued or running. */
		pending?: { value: unknown };
		dispatch: (
			worker: number,
			calls: RegionCall[],
			generation: number
		) => Promise<TransactionResult[]>;
		native: (call: RegionCall) => void;
	}) {
		this.#pending = options.pending;
		this.#memory = options.memory;
		this.#workerMemory = options.workerMemory;
		this.#width = options.width;
		this.#dispatch = options.dispatch;
		this.#native = options.native;
		this.#profile = options.profile
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
		this.report = {
			values: [],
			workers: 0,
			regions: 0,
			replayed: 0,
			fallbacks: 0,
			mode: 'serial',
			extraction: 'control-flow',
			memoryMode: this.#memory === this.#workerMemory ? 'shared' : 'snapshot',
			snapshotBytes: 0,
			...(this.#profile ? { profile: this.#profile } : {})
		};
	}

	enqueue(call: RegionCall): Promise<void> | undefined {
		if (!this.#armed) {
			this.#armed = true;
			if (this.#pending) this.#pending.value = 1;
		}
		this.#queue.push(call);
		this.report.regions++;
		// Amortize transport/join cost without changing per-region validation order.
		return this.#queue.length >= this.#width * 16 ? this.flush() : undefined;
	}

	/** Bounded polling also joins an earlier trapping region before an infinite loop. */
	poll(): Promise<void> | undefined {
		if (++this.#polls < 1024) return undefined;
		this.#polls = 0;
		return this.flush();
	}

	flush(): Promise<void> | undefined {
		if (this.#flushing) return this.#flushing;
		if (!this.#queue.length) {
			this.#settle();
			return undefined;
		}
		const batch = this.#queue.splice(0);
		const pending = this.#execute(batch);
		this.#flushing = pending;
		return pending.finally(() => {
			this.#flushing = undefined;
			this.#settle();
		});
	}

	#settle(): void {
		if (!this.#armed || this.#queue.length) return;
		this.#armed = false;
		if (this.#pending) this.#pending.value = 0;
	}

	async #execute(batch: RegionCall[]): Promise<void> {
		if (batch.length === 1) {
			// An observation boundary left no independent companion. Keep the work
			// at its original owner; IPC and a full ordinary-memory snapshot buy nothing.
			if (this.report.mode === 'serial') this.report.reason = 'single-region';
			this.#native(batch[0]!);
			return;
		}
		if (this.report.reason === 'single-region') delete this.report.reason;
		if (this.#memory !== this.#workerMemory) {
			try {
				const pages = this.#memory.buffer.byteLength / 65536;
				const current = this.#workerMemory.buffer.byteLength / 65536;
				if (pages > current) this.#workerMemory.grow(pages - current);
				new Uint8Array(this.#workerMemory.buffer).set(new Uint8Array(this.#memory.buffer));
				this.report.snapshotBytes! += this.#memory.buffer.byteLength;
			} catch (error) {
				if (!(error instanceof RangeError)) throw error;
				// A failed optimization allocation must not introduce a program trap.
				this.report.fallbacks++;
				for (const call of batch) this.#native(call);
				return;
			}
		}
		this.report.mode = 'speculative';
		const width = Math.min(this.#width, batch.length);
		this.report.workers = Math.max(this.report.workers, width);
		const lanes = Array.from({ length: width }, (_, lane) =>
			batch.filter((_, index) => index % width === lane)
		);
		const generation = ++this.#generation;
		const outcomes = await Promise.allSettled(
			lanes.map((calls, i) => this.#dispatch(i, calls, generation))
		);
		const failure = outcomes.find((outcome) => outcome.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
		const dirty = new Set<number>();
		const canonical = new Uint8Array(this.#memory.buffer);
		const shared = new Uint8Array(this.#workerMemory.buffer);
		const observe = (result: TransactionResult) => {
			if (!this.#profile) return;
			this.#profile.workerWallMs.push(result.timing!.wallMs);
			this.#profile.workerCpuMs.push(result.timing!.cpuMs);
			this.#profile.readBytes += result.reads.length;
			this.#profile.writeBytes += result.writes.length;
		};
		const commit = (result: TransactionResult) => {
			const start = this.#profile ? performance.now() : 0;
			for (const [address, value] of result.writes) {
				canonical[address] = value;
				if (this.#memory !== this.#workerMemory) shared[address] = value;
				dirty.add(address);
			}
			if (this.#profile) this.#profile.commitMs += performance.now() - start;
		};
		for (let i = 0; i < batch.length; i++) {
			const outcome = outcomes[i % width] as PromiseFulfilledResult<TransactionResult[]>;
			let result = outcome.value[Math.floor(i / width)]!;
			observe(result);
			const start = this.#profile ? performance.now() : 0;
			const conflict = result.reads.some((address) => dirty.has(address));
			if (this.#profile) this.#profile.validationMs += performance.now() - start;
			if (result.exhausted || conflict) {
				if (result.exhausted) this.report.fallbacks++;
				else {
					this.report.replayed++;
					this.report.reason = 'dependency';
				}
				if (!result.exhausted) {
					const replayStart = this.#profile ? performance.now() : 0;
					result = (await this.#dispatch(0, [batch[i]!], ++this.#generation))[0]!;
					observe(result);
					if (this.#profile) this.#profile.replayMs += performance.now() - replayStart;
				}
				if (result.exhausted) {
					// Unknown native write footprints invalidate every later speculative result.
					for (let rest = i; rest < batch.length; rest++) this.#native(batch[rest]!);
					return;
				}
			}
			commit(result);
			trap(result);
		}
	}
}
