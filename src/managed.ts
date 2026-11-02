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
	runsVersion,
	snapshotLength,
	type SnapshotPages,
	validateIdentity
} from './frames.ts';
import type { IterationArena } from './iteration-layout.ts';
import { iterationArena, iterationEntryBytes, iterationFit } from './iteration-layout.ts';
import type { MemoStats } from './memo.ts';
import { RegionMemo } from './memo.ts';
import type { MemoryImport } from './memory.ts';
import type { ExecutionReport } from './node.ts';
import type { RangesHeader } from './ranges.ts';
import {
	clearRanges,
	decodeRanges,
	encodeRangesFrame,
	escapes,
	FootprintCache,
	rangePage,
	RangeSet,
	restoreRanges,
	resultEscapes
} from './ranges.ts';
import { capRuns, packWrites } from './runs.ts';
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
	/** The same regions with inline tracking, from `inlineLane` at build time; used by a lane with `inline` set. */
	inline?: WebAssembly.Module;
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
	/** Ranges mode only: payload bytes sent in ranges frames. */
	rangeBytes?: number;
	/** Ranges mode only: ranges frames sent, summed over `batches` lane dispatches; `max` is the most one dispatch needed. */
	rounds?: { batches: number; total: number; max: number };
	/** Ranges mode only: ranges frames whose results had escapes and were used only to learn. */
	escapeRounds?: number;
	/** Ranges mode only: dispatches that ended in a full snapshot or in native execution at the owner. */
	rangeFallbacks?: { snapshot: number; serial: number };
	/** Ranges mode only: calls whose footprint was already cached when their dispatch began. */
	footprintHits?: number;
	/** Run encoding only: response frames that came back in runs, and in addresses from a lane that predates runs. */
	runReplies?: { runs: number; addresses: number };
	/** Memo mode only: calls answered from a recorded result instead of a lane. */
	memoHits?: number;
	/** Memo mode only: lane time the hits avoided, estimated from the recorded execution time. */
	memoSavedMs?: number;
	/** Memo mode only: bytes hashed by lookups during the run. */
	memoHashedBytes?: number;
	/** Memo mode only: results recorded during the run. */
	memoRecords?: number;
}

// the exported globals of the inline lowering, as named by `inlineGlobals` in inline.ts
const markGlobals = {
	readBitmap: '__folio_rb',
	writeBitmap: '__folio_wb',
	logPointer: '__folio_lp',
	logLimit: '__folio_ll',
	stampAddress: '__folio_sa',
	arenaLow: '__folio_al',
	arenaEnd: '__folio_ae',
	violation: '__folio_xv'
} as const;

/** Where a lane with inline tracking keeps its marks and undo log, above the program memory. */
interface LaneMarks {
	arena: IterationArena;
	ownerBytes: number;
	globals: Record<keyof typeof markGlobals, WebAssembly.Global>;
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
	ranges?: RangesHeader;
	runs?: number;
};

// workers rpc rejects serialized arguments over 32 MiB; the margin covers the other arguments and serializer tags
const rpcFrameLimit = 32 * 1048576 - 4096;

// process-local identity of a tracked module; a memo shared across artifacts keys on it
const moduleIdentities = new WeakMap<object, string>();
let moduleCount = 0;
function moduleIdentity(module: object): string {
	let id = moduleIdentities.get(module);
	if (!id) moduleIdentities.set(module, (id = `module-${++moduleCount}`));
	return id;
}

function memoTally(now: MemoStats, before: MemoStats) {
	return {
		memoHits: now.hits - before.hits,
		memoSavedMs: now.savedMs - before.savedMs,
		memoHashedBytes: now.hashedBytes - before.hashedBytes,
		memoRecords: now.recorded - before.recorded
	};
}

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
	readonly #inline?: { module: WebAssembly.Module; logEntries: number };
	#memory?: WebAssembly.Memory;
	#instance?: WebAssembly.Instance;
	#marks?: LaneMarks;
	#active?: ReturnType<typeof transaction>;
	// bytes that may be nonzero; a fresh instance can hold data segments, so it starts as everything
	#dirty: RangeSet | 'all' = 'all';
	// bytes of program memory the instance was built for
	#owned = 0;
	// what instantiation writes into a fresh memory; unknown unless the caller names the segments
	#data: RangeSet | 'all' = 'all';

	constructor(
		module: WebAssembly.Module,
		options: {
			initial: number;
			maximum: number;
			maximumMemoryBytes?: number;
			maximumFrameBytes?: number;
			/** Start and length of each active data segment of `module`; omitted means unknown. */
			dataSegments?: readonly (readonly [start: number, length: number])[];
			/**
			 * Runs the inline-tracked module instead of `module`: the marks and the undo log live in the
			 * lane's own memory above the program memory, a call's writes are read back from the log
			 * and rolled back, and its reads are reported at 64-byte granules. `logEntries` bounds the
			 * 32-byte write granules one call may log (default 8192, which is 262,144 bytes); a call
			 * that passes it is exhausted. Off unless set.
			 */
			inline?: { module: WebAssembly.Module; logEntries?: number };
		}
	) {
		this.#module = module;
		if (options.inline)
			this.#inline = {
				module: options.inline.module,
				logEntries: integer(options.inline.logEntries ?? 8192, 1, 1048576, 'log entries')
			};
		if (options.dataSegments) this.#data = RangeSet.of(options.dataSegments);
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
		if (header.ranges !== undefined && header.snapshot !== undefined)
			throw new TypeError('a frame carries a snapshot or ranges, not both');
		if (header.runs !== undefined && header.runs !== runsVersion)
			throw new TypeError('unsupported results encoding');
		const runs = header.runs === runsVersion;
		const ranged =
			header.ranges === undefined ? undefined : decodeRanges(header.ranges, payload);
		const memoryBytes = ranged ? ranged.memoryBytes : snapshotLength(header.snapshot, payload);
		const pages = memoryBytes / 65536;
		if (
			!Number.isInteger(pages) ||
			pages < this.#initial ||
			pages > this.#maximum ||
			memoryBytes > this.#maximumMemoryBytes
		)
			throw new RangeError('invalid lane snapshot');
		if (!this.#memory || !this.#instance || this.#owned !== memoryBytes) {
			const module = this.#inline?.module ?? this.#module;
			const binding = WebAssembly.Module.imports(module).filter(
				(item) => item.kind === 'memory'
			);
			if (binding.length !== 1) throw new TypeError('one lane memory required');
			this.#dirty = this.#data;
			this.#owned = memoryBytes;
			this.#marks = undefined;
			let arena: IterationArena | undefined;
			if (this.#inline) {
				const options = { batch: 1, logCapacity: this.#inline.logEntries, slotBytes: 64 };
				const fit = iterationFit(memoryBytes, options);
				if (!fit) throw new RangeError('lane arena does not fit');
				arena = iterationArena(fit.base, fit.memoryBytes, options);
			}
			const total = arena ? arena.memoryBytes / 65536 : pages;
			this.#memory = new WebAssembly.Memory({
				initial: total,
				maximum: Math.max(this.#maximum, total),
				shared: true
			});
			this.#instance = new WebAssembly.Instance(module, {
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
			if (arena) {
				const exported = this.#instance.exports;
				const globals = {} as LaneMarks['globals'];
				for (const [key, name] of Object.entries(markGlobals))
					globals[key as keyof LaneMarks['globals']] = exported[
						name
					] as WebAssembly.Global;
				globals.readBitmap.value = arena.rmaps;
				globals.writeBitmap.value = arena.wmaps;
				globals.logLimit.value =
					arena.logs + this.#inline!.logEntries * iterationEntryBytes;
				globals.stampAddress.value = arena.stamp;
				globals.arenaLow.value = memoryBytes;
				globals.arenaEnd.value = arena.memoryBytes;
				this.#marks = { arena, ownerBytes: memoryBytes, globals };
			}
		}
		const bytes = new Uint8Array(this.#memory.buffer, 0, memoryBytes);
		if (ranged) {
			// tracked stores are buffered, so only the previous frame's ranges can be nonzero
			if (this.#dirty === 'all') bytes.fill(0);
			else clearRanges(bytes, this.#dirty);
			this.#dirty = ranged.shipped;
			restoreRanges(bytes, payload, ranged.shipped);
		} else {
			this.#dirty = 'all';
			restoreSnapshot(bytes, payload, header.snapshot);
		}
		let remaining = header.maxBytes;
		const results: TransactionResult[] = [];
		for (const call of header.calls) {
			if (remaining <= 0) {
				results.push({ reads: [], writes: [], exhausted: true });
				continue;
			}
			if (this.#marks) {
				const done = this.#inlineCall(call, header.fuel, remaining, ranged?.shipped, runs);
				remaining -= done.charged;
				results.push(this.#annotate(done.result, ranged, done.lost));
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
				// ranges mode keeps the reads so escapes before the overflow still reach the owner
				const seen = ranged ? this.#active.result().reads : [];
				results.push(this.#annotate({ reads: seen, writes: [], exhausted: true }, ranged));
				continue;
			}
			const result = this.#active.result(value, error);
			remaining -= result.reads.length + result.writes.length;
			results.push(this.#annotate(result, ranged));
		}
		this.#active = undefined;
		return encodeResults(header, results, this.#maximumFrameBytes, runs);
	}

	// runs one call on the inline-tracked module, reads its marks and log back, and rolls it all back
	#inlineCall(
		call: RegionCall,
		fuel: number,
		remaining: number,
		shipped?: RangeSet,
		runs = false
	): { result: TransactionResult; charged: number; lost?: RangeSet } {
		const { arena, ownerBytes, globals } = this.#marks!;
		const entryBytes = iterationEntryBytes;
		const buffer = this.#memory!.buffer;
		const u8 = new Uint8Array(buffer);
		const u32 = new Uint32Array(buffer);
		const exports = this.#instance!.exports;
		globals.logPointer.value = arena.logs;
		globals.violation.value = 0;
		let error: unknown, value: unknown;
		try {
			(exports.__folio_set_fuel as CallableFunction)(fuel);
			const entry = exports[call.export];
			if (typeof entry !== 'function') throw new TypeError('unknown lane export');
			value = entry(...call.args);
		} catch (caught) {
			error = caught;
		}
		const end = globals.logPointer.value >>> 0;
		const limit = globals.logLimit.value >>> 0;
		if (globals.violation.value >>> 0)
			error = new WebAssembly.RuntimeError('memory access out of bounds');
		const logFull =
			error instanceof WebAssembly.RuntimeError &&
			/unreachable/.test(error.message) &&
			limit - end < entryBytes;
		// a write granule stores its prior bytes, so only bytes that changed are writes
		const entries = (end - arena.logs) / entryBytes;
		const writes: [number, number][] = [];
		const pieces: [number, Uint8Array][] = [];
		const written: [number, number][] = [];
		for (let e = 0; e < entries; e++) {
			const at = arena.logs + e * entryBytes;
			const granule = u32[at >> 2]!;
			written.push([granule, 32]);
			if (runs)
				for (let i = 0; i < 32;) {
					if (u8[granule + i] === u8[at + 8 + i]) {
						i++;
						continue;
					}
					let j = i + 1;
					while (j < 32 && u8[granule + j] !== u8[at + 8 + j]) j++;
					pieces.push([granule + i, u8.slice(granule + i, granule + j)]);
					i = j;
				}
			else
				for (let i = 0; i < 32; i++) {
					const now = u8[granule + i]!;
					if (now !== u8[at + 8 + i]) writes.push([granule + i, now]);
				}
			u8.copyWithin(granule, at + 8, at + entryBytes);
			u8[arena.wmaps + (granule >>> 8)] = 0;
		}
		// a failed call may have set a write bit before its entry was logged
		if (error) u8.fill(0, arena.wmaps, arena.wmaps + arena.wsize);
		const spans: [number, number][] = [];
		const words = new Uint32Array(buffer, arena.rmaps, arena.rsize / 4);
		for (let k = 0; k < words.length; k++) {
			const word = words[k]!;
			if (!word) continue;
			words[k] = 0;
			for (let b = 0; b < 32; b++) if ((word >>> b) & 1) spans.push([(k * 32 + b) * 64, 64]);
		}
		let reads = RangeSet.of(spans);
		// bytes of a written granule that were not shipped read as zero here, so the owner must ship them
		if (shipped) reads = reads.union(RangeSet.of(written).subtract(shipped));
		const lost = shipped ? reads.subtract(shipped) : undefined;
		const packed = runs ? packWrites(pieces) : undefined;
		const charged = reads.length + (packed ? packed.data.length : writes.length);
		const addresses = (set: RangeSet, cap: number): number[] => {
			const out: number[] = [];
			for (const [start, length] of set.spans())
				for (let i = 0; i < length && out.length < cap; i++) out.push(start + i);
			return out;
		};
		const failure =
			error instanceof SpeculationLimit || logFull
				? { exhausted: true }
				: error
					? {
							trap: error instanceof Error ? error.message : String(error),
							errorKind: error instanceof Error ? error.name : 'Error'
						}
					: {};
		if (charged > remaining)
			return {
				charged,
				lost,
				result: runs
					? {
							reads: [],
							writes: [],
							readRuns: capRuns((lost ?? RangeSet.empty).runs(), remaining),
							writeRuns: new Uint32Array(),
							writeData: new Uint8Array(),
							exhausted: true
						}
					: { reads: lost ? addresses(lost, remaining) : [], writes: [], exhausted: true }
			};
		return {
			charged,
			lost,
			result: packed
				? {
						value,
						reads: [],
						writes: [],
						readRuns: capRuns(reads.clip(ownerBytes).runs(), remaining),
						writeRuns: packed.runs,
						writeData: packed.data,
						...failure
					}
				: {
						value,
						reads: addresses(reads.clip(ownerBytes), remaining),
						writes,
						...failure
					}
		};
	}

	#annotate(
		result: TransactionResult,
		ranged?: { shipped: RangeSet },
		known?: RangeSet
	): TransactionResult {
		if (!ranged) return result;
		const lost = known ?? escapes(result.reads, ranged.shipped);
		if (!lost.count) return result;
		return {
			...result,
			escapes: lost.spans(),
			inconclusive: Boolean(result.trap || result.exhausted)
		};
	}

	/** Drops the instance and its memory; a later frame builds them again. */
	close(): void {
		this.#dirty = 'all';
		this.#active = this.#instance = this.#memory = this.#marks = undefined;
		this.#owned = 0;
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
	readonly #ranges?: { maxRounds: number; cache: FootprintCache };
	readonly #memo?: RegionMemo;
	#memoModule = '';
	readonly #runs: boolean;
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
			/** Largest arena a run may snapshot; the default is 31 MiB. */
			maximumSnapshotBytes?: number;
			/** Largest request frame a lane transport accepts. A larger frame is not sent and the call falls back to the owner. The default is the snapshot limit plus 1 MiB, capped below the 32 MiB Workers RPC argument limit. */
			maximumFrameBytes?: number;
			promising?: readonly string[];
			/** `dense` (default) sends the whole snapshot; `auto` elides zero pages, which lanes from 1.0.0 reject. */
			snapshotEncoding?: 'auto' | 'dense';
			/**
			 * Ships learned byte ranges instead of a snapshot. Off unless set, and the lanes must come
			 * from a release that reads ranges frames. A batch whose lane reads unshipped bytes is
			 * retried with a wider footprint, at most `maxRounds` frames (default 3), then falls back
			 * to a full snapshot, or to native execution at the owner when none fits the limits.
			 */
			ranges?: { maxRounds?: number; cacheEntries?: number };
			/**
			 * Asks lanes to answer in runs: sorted `[start, length]` read and write runs with the
			 * written bytes once, which the owner validates and commits as intervals instead of one
			 * address at a time. Off unless set. A lane that predates runs ignores the request and
			 * answers in addresses, which the owner still decodes and validates exactly; the report's
			 * `runReplies` counts both. A lane that answers in a version the owner does not know is
			 * refused.
			 */
			runs?: boolean;
			/**
			 * Reuses recorded results of regions whose read bytes are unchanged; see `RegionMemo`.
			 * Off unless set. Hits go through the same ordered validation as lane results.
			 */
			memo?: { bytes?: number; entries?: number };
		}
	) {
		if (options.runs !== undefined && typeof options.runs !== 'boolean')
			throw new TypeError('invalid runs option');
		this.#runs = options.runs === true;
		if (options.memo) {
			this.#memo = new RegionMemo(options.memo);
			this.#memoModule = moduleIdentity(artifact.transactional ?? artifact.original);
		}
		this.#artifact = artifact;
		this.#snapshotEncoding = options.snapshotEncoding ?? 'dense';
		if (!['auto', 'dense'].includes(this.#snapshotEncoding))
			throw new TypeError('invalid snapshot encoding');
		if (options.ranges)
			this.#ranges = {
				maxRounds: integer(options.ranges.maxRounds ?? 3, 1, 8, 'range rounds'),
				cache: new FootprintCache(
					integer(options.ranges.cacheEntries ?? 1024, 1, 65536, 'footprint cache size')
				)
			};
		this.#lanes = options.lanes;
		integer(this.#lanes.length, 1, 64, 'lane count');
		this.#maximumSnapshotBytes = integer(
			options.maximumSnapshotBytes ?? 31 * 1048576,
			65536,
			0x100000000,
			'snapshot limit'
		);
		this.#maximumFrameBytes = integer(
			options.maximumFrameBytes ??
				Math.min(this.#maximumSnapshotBytes + 1048576, rpcFrameLimit),
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
		const memoBefore = this.#memo?.stats;
		let snapshotBytes = 0;
		let transportFallbacks = 0;
		const tally = {
			rangeBytes: 0,
			rounds: { batches: 0, total: 0, max: 0 },
			escapeRounds: 0,
			rangeFallbacks: { snapshot: 0, serial: 0 },
			footprintHits: 0
		};
		const runReplies = { runs: 0, addresses: 0 };
		const finish = (report: ExecutionReport): ManagedReport => ({
			...report,
			backend: 'managed-coherent',
			memoryMode: 'copied',
			transportBytes: bytes,
			transportFallbacks,
			...(this.#ranges ? tally : {}),
			...(this.#runs ? { runReplies } : {}),
			...(this.#memo ? memoTally(this.#memo.stats, memoBefore!) : {})
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
			dispatch: (lane, calls, generation) =>
				this.#memoized(lane, calls, generation, async (lane, calls, generation) => {
					const exhausted = () =>
						calls.map(() => ({ reads: [], writes: [], exhausted: true }));
					const identify = (): FrameIdentity => ({
						session: this.#session,
						epoch,
						sequence: ++this.#sequence
					});
					const exchange = async (frame: Uint8Array, identity: FrameIdentity) => {
						bytes.sent += frame.length;
						const response = await this.#lanes[lane]!.execute(frame);
						bytes.received += response.length;
						const decoded = decodeResults(response, identity, {
							maximumFrameBytes: this.#maximumFrameBytes,
							memoryBytes: this.memory.buffer.byteLength,
							maxBytes: this.#maxBytes,
							calls: calls.length,
							runs: this.#runs
						});
						if (this.#runs) runReplies[decoded[0]?.readRuns ? 'runs' : 'addresses']++;
						return decoded;
					};
					const snapshotFrame = (identity: FrameIdentity) => {
						if (this.memory.buffer.byteLength > this.#maximumSnapshotBytes)
							throw new RangeError(
								`snapshot of ${this.memory.buffer.byteLength} bytes exceeds the limit of ${this.#maximumSnapshotBytes} bytes`
							);
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
								...(this.#runs ? { runs: runsVersion } : {}),
								...(snapshot!.snapshot ? { snapshot: snapshot!.snapshot } : {})
							},
							snapshot!.payload,
							this.#maximumFrameBytes
						);
						snapshotBytes += this.memory.buffer.byteLength;
						return frame;
					};
					// a round with escapes only teaches the footprint; its results are never returned
					const learn = async (): Promise<TransactionResult[] | undefined> => {
						const ranges = this.#ranges!;
						const keys = calls.map((call) =>
							FootprintCache.key(call.export, call.args)
						);
						let footprint = RangeSet.empty;
						for (const key of keys) {
							const known = ranges.cache.get(key);
							if (!known) continue;
							tally.footprintHits++;
							footprint = footprint.union(known);
						}
						tally.rounds.batches++;
						let rounds = 0;
						try {
							while (rounds < ranges.maxRounds) {
								const identity = identify();
								const memory = new Uint8Array(this.memory.buffer);
								let sent: ReturnType<typeof encodeRangesFrame>;
								try {
									sent = encodeRangesFrame(
										{
											...identity,
											calls,
											fuel: this.#fuel,
											maxBytes: this.#maxBytes,
											...(this.#runs ? { runs: runsVersion } : {})
										},
										memory,
										footprint,
										this.#maximumFrameBytes
									);
								} catch (error) {
									if (!(error instanceof RangeError)) throw error;
									this.diagnostics.push(
										`ranges frame not sent: ${error.message}`
									);
									return undefined;
								}
								rounds++;
								tally.rounds.total++;
								tally.rangeBytes += sent.shipped.length;
								const results = await exchange(sent.frame, identity);
								// the lane's own escape list is not trusted; the read set decides
								const lost = results.map((result) =>
									resultEscapes(result, sent.shipped)
								);
								if (lost.every((set) => !set.count)) return results;
								tally.escapeRounds++;
								lost.forEach((set, index) => {
									if (!set.count) return;
									const grown = set.round(rangePage, memory.length);
									ranges.cache.learn(keys[index]!, grown);
									footprint = footprint.union(grown);
								});
							}
							return undefined;
						} finally {
							tally.rounds.max = Math.max(tally.rounds.max, rounds);
						}
					};
					try {
						if (this.#ranges) {
							const done = await learn();
							if (done) return done;
							const identity = identify();
							let frame: Uint8Array;
							try {
								frame = snapshotFrame(identity);
							} catch (error) {
								if (!(error instanceof RangeError)) throw error;
								tally.rangeFallbacks.serial++;
								this.diagnostics.push(
									`ranges exhausted; native fallback: ${error.message}`
								);
								return exhausted();
							}
							tally.rangeFallbacks.snapshot++;
							return await exchange(frame, identity);
						}
						const identity = identify();
						return await exchange(snapshotFrame(identity), identity);
					} catch (error) {
						transportFallbacks++;
						this.diagnostics.push(
							`lane unavailable; native fallback: ${error instanceof Error ? error.message : String(error)}`
						);
						return exhausted();
					}
				})
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

	/**
	 * Answers calls from the memo where it can, sends the rest to `execute`, and records their clean
	 * results. Lookups and records read canonical memory, which no commit changes until every lane
	 * of the batch has returned.
	 */
	async #memoized(
		lane: number,
		calls: RegionCall[],
		generation: number,
		execute: (
			lane: number,
			calls: RegionCall[],
			generation: number
		) => Promise<TransactionResult[]>
	): Promise<TransactionResult[]> {
		const memo = this.#memo;
		if (!memo) return execute(lane, calls, generation);
		const memory = new Uint8Array(this.memory.buffer);
		const keys = calls.map((call) =>
			RegionMemo.keyOf(this.#memoModule, call.export, call.args)
		);
		const hits = await Promise.all(
			keys.map((key) =>
				key === undefined ? undefined : memo.lookup(key, memory, { runs: this.#runs })
			)
		);
		const missing = calls.filter((_, index) => !hits[index]);
		const started = performance.now();
		const fresh = missing.length ? await execute(lane, missing, generation) : [];
		const ms = missing.length ? (performance.now() - started) / missing.length : 0;
		const results: TransactionResult[] = [];
		let next = 0;
		for (let index = 0; index < calls.length; index++) {
			const hit = hits[index];
			if (hit) {
				results.push(hit.result);
				continue;
			}
			const result = fresh[next++]!;
			results.push(result);
			const key = keys[index];
			if (key !== undefined) await memo.record(key, memory, result, ms);
		}
		return results;
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
