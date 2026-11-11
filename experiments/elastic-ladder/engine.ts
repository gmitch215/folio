import type { Codec } from './lz4.ts';
import { PAGE } from './programs.ts';
import type { Backend } from './store.ts';

const LOAD = 0;
const STORE = 1;
const FILL = 2;

export interface Stats {
	ops: number;
	frameHits: number;
	coldHits: number;
	storeReads: number;
	storeWrites: number;
	compressions: number;
	decompressions: number;
	coldEvictions: number;
	// bytes held by the compressed pool now and at its peak
	coldBytes: number;
	coldPeakBytes: number;
	compressMs: number;
	decompressMs: number;
}

export const blankStats = (): Stats => ({
	ops: 0,
	frameHits: 0,
	coldHits: 0,
	storeReads: 0,
	storeWrites: 0,
	compressions: 0,
	decompressions: 0,
	coldEvictions: 0,
	coldBytes: 0,
	coldPeakBytes: 0,
	compressMs: 0,
	decompressMs: 0
});

interface Frame {
	bytes: Uint8Array;
	view: DataView;
	dirty: boolean;
}

interface Packed {
	bytes: Uint8Array;
	dirty: boolean;
}

export interface PagerOptions {
	frames: number;
	cold: number;
	pages: number;
	backend: Backend;
	codec?: Codec;
	clock?: () => number;
	// a seeded random victim in place of LRU; exactness must not depend on the policy
	randomSeed?: number;
	// evict every frame after each operation
	evictEvery?: boolean;
	// a dirty frame is written only when evicted; the end of the request writes nothing
	ephemeral?: boolean;
}

function mulberry32(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Resident frames in front of a compressed pool in front of the backend, a page in at most one tier.
// The tiers are synchronous; a remote tier supplies its own handler to runSegment instead.
export class Pager {
	readonly stats = blankStats();
	private readonly frames = new Map<number, Frame>();
	private readonly pool = new Map<number, Packed>();
	private readonly spare: Frame[] = [];
	private readonly random?: () => number;
	private readonly clock: () => number;
	private readonly scratch = new Uint8Array(PAGE);
	private readonly o: PagerOptions;

	constructor(o: PagerOptions) {
		this.o = o;
		if (o.cold > 0 && !o.codec) throw new Error('a compressed pool needs a codec');
		if (o.frames < 1) throw new Error('frames must be >= 1');
		if (o.ephemeral && o.cold > 0) throw new Error('an ephemeral pager needs cold 0');
		if (o.randomSeed !== undefined) this.random = mulberry32(o.randomSeed);
		this.clock = o.clock ?? (() => 0);
	}

	get residentFrames() {
		return this.frames.size;
	}
	get pooledPages() {
		return this.pool.size;
	}

	private victim<T>(map: Map<number, T>): number {
		if (!this.random) return map.keys().next().value!;
		const keys = [...map.keys()];
		return keys[Math.floor(this.random() * keys.length)]!;
	}

	private take(): Frame {
		const spare = this.spare.pop();
		if (spare) return spare;
		const bytes = new Uint8Array(PAGE);
		return { bytes, view: new DataView(bytes.buffer), dirty: false };
	}

	private store(page: number, bytes: Uint8Array) {
		const wrote = this.o.backend.write(page, bytes);
		if (wrote instanceof Promise) throw new Error('async backend needs an async handler');
		this.stats.storeWrites++;
	}

	private dropPooled(page: number) {
		const entry = this.pool.get(page);
		if (!entry) return;
		this.pool.delete(page);
		this.stats.coldBytes -= entry.bytes.length;
	}

	private decode(entry: Packed, into: Uint8Array) {
		const at = this.clock();
		this.o.codec!.decompress(entry.bytes, into);
		this.stats.decompressMs += this.clock() - at;
		this.stats.decompressions++;
	}

	private evictPooled() {
		const page = this.victim(this.pool);
		const entry = this.pool.get(page)!;
		this.dropPooled(page);
		this.stats.coldEvictions++;
		if (!entry.dirty) return;
		this.decode(entry, this.scratch);
		this.store(page, this.scratch);
	}

	private demote(page: number, frame: Frame) {
		if (this.o.cold > 0) {
			const at = this.clock();
			const bytes = this.o.codec!.compress(frame.bytes);
			this.stats.compressMs += this.clock() - at;
			this.stats.compressions++;
			this.pool.set(page, { bytes, dirty: frame.dirty });
			this.stats.coldBytes += bytes.length;
			this.stats.coldPeakBytes = Math.max(this.stats.coldPeakBytes, this.stats.coldBytes);
			while (this.pool.size > this.o.cold) this.evictPooled();
		} else if (frame.dirty) this.store(page, frame.bytes);
		frame.dirty = false;
		this.spare.push(frame);
	}

	private evictFrame() {
		const page = this.victim(this.frames);
		const frame = this.frames.get(page)!;
		this.frames.delete(page);
		this.demote(page, frame);
	}

	private frameFor(page: number, kind: number): Frame {
		const hit = this.frames.get(page);
		if (hit) {
			this.stats.frameHits++;
			if (kind !== LOAD) hit.dirty = true;
			this.frames.delete(page);
			this.frames.set(page, hit);
			return hit;
		}
		let dirty = kind !== LOAD;
		let packed: Packed | undefined;
		let fetched: Uint8Array | null = null;
		if (kind === FILL) this.dropPooled(page);
		else if ((packed = this.pool.get(page))) {
			this.stats.coldHits++;
			dirty = packed.dirty || kind === STORE;
			this.dropPooled(page);
		} else {
			const read = this.o.backend.read(page);
			if (read instanceof Promise) throw new Error('async backend needs an async handler');
			if (!read) throw new Error(`missing page ${page}`);
			this.stats.storeReads++;
			fetched = read;
		}
		if (this.frames.size >= this.o.frames) this.evictFrame();
		const frame = this.take();
		if (packed) this.decode(packed, frame.bytes);
		else if (fetched) frame.bytes.set(fetched);
		frame.dirty = dirty;
		this.frames.set(page, frame);
		return frame;
	}

	// one page operation; the completion is the loaded word, or 0
	handle(kind: number, at: number, value: number, width: number): number {
		this.stats.ops++;
		checkAccess(kind, at, width, this.o.pages);
		const page = Math.floor(at / PAGE);
		const offset = at % PAGE;
		const frame = this.frameFor(page, kind);
		let result = 0;
		if (kind === FILL) frame.bytes.fill(value & 255);
		else if (kind === LOAD) result = frame.view.getInt32(offset, true);
		else frame.view.setInt32(offset, value, true);
		if (this.o.evictEvery) {
			while (this.frames.size > 0) this.evictFrame();
		}
		return result;
	}

	// the bytes of a resident dirty frame, which an ephemeral run never stores
	dirtyFrame(page: number) {
		const frame = this.frames.get(page);
		return frame?.dirty ? frame.bytes : null;
	}

	// writes every dirty page to the backend; the pages stay resident and clean
	flush() {
		if (this.o.ephemeral) return;
		for (const [page, frame] of this.frames) {
			if (!frame.dirty) continue;
			this.store(page, frame.bytes);
			frame.dirty = false;
		}
		for (const [page, entry] of this.pool) {
			if (!entry.dirty) continue;
			this.decode(entry, this.scratch);
			this.store(page, this.scratch);
			entry.dirty = false;
		}
	}
}

// the access rules every tier shares; at is the page address plus the offset
function checkAccess(kind: number, at: number, width: number, pages: number) {
	const page = Math.floor(at / PAGE);
	const offset = at % PAGE;
	if (page >= pages) throw new WebAssembly.RuntimeError('out of bounds');
	if (kind === FILL ? width !== PAGE || offset !== 0 : width !== 4 || offset > PAGE - 4)
		throw new Error('unsupported access');
}

// every page in one buffer: no frames, no pool and no store, so nothing is written or read back
export class Resident {
	readonly stats = blankStats();
	private readonly bytes: Uint8Array;
	private readonly view: DataView;
	private readonly pages: number;

	constructor(pages: number) {
		this.pages = pages;
		this.bytes = new Uint8Array(pages * PAGE);
		this.view = new DataView(this.bytes.buffer);
	}

	get residentFrames() {
		return this.pages;
	}
	get pooledPages() {
		return 0;
	}

	page(page: number) {
		return this.bytes.subarray(page * PAGE, (page + 1) * PAGE);
	}

	handle(kind: number, at: number, value: number, width: number): number {
		this.stats.ops++;
		checkAccess(kind, at, width, this.pages);
		if (kind === FILL) {
			const start = Math.floor(at / PAGE) * PAGE;
			this.bytes.fill(value & 255, start, start + PAGE);
			return 0;
		}
		if (kind === LOAD) return this.view.getInt32(at, true);
		this.view.setInt32(at, value, true);
		return 0;
	}

	flush() {}
}

export type OpHandler = (
	kind: number,
	at: number,
	value: number,
	width: number
) => number | Promise<number>;

export interface Program {
	module: WebAssembly.Module;
	entry: string;
	args: number[];
	// imports besides the page operations, such as the trace feed
	extra?: Record<string, (...args: number[]) => number>;
	fuel?: number;
}

export interface Checkpoint {
	memory: Uint8Array<ArrayBuffer>;
	completion: number;
}

export type Segment =
	| { done: true; result: number; ops: number }
	| { done: false; checkpoint: Checkpoint; ops: number };

// Runs a program until it ends or quantum operations have run. The suspension is the Codex fixture's:
// Asyncify unwinds, the 64 KiB memory is the checkpoint, and the completion of the last operation
// travels with it. A synchronous handler returns a number in place; a promise unwinds and is awaited.
export async function runSegment(
	program: Program,
	handler: OpHandler,
	quantum: number,
	resume?: Checkpoint
): Promise<Segment> {
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 8192 });
	if (resume) {
		if (resume.memory.length !== PAGE) throw new Error('bad checkpoint');
		new Uint8Array(memory.buffer).set(resume.memory);
	} else {
		const data = new DataView(memory.buffer);
		data.setUint32(16, 1024, true);
		data.setUint32(20, PAGE, true);
	}
	let rewinding = Boolean(resume);
	let completion = resume?.completion ?? 0;
	let pending: { promise?: Promise<number>; yielded?: number } | undefined;
	let ops = 0;
	let exports: Record<string, any>;
	const hook = (kind: number, p: number, value: number, offset: number, width: number) => {
		if (rewinding) {
			exports.asyncify_stop_rewind();
			rewinding = false;
			return completion;
		}
		const result = handler(kind, (p >>> 0) + offset, value, width);
		if (result instanceof Promise) {
			pending = { promise: result };
			exports.asyncify_start_unwind(16);
			return 0;
		}
		if (++ops >= quantum) {
			pending = { yielded: result };
			exports.asyncify_start_unwind(16);
			return 0;
		}
		return result;
	};
	exports = new WebAssembly.Instance(program.module, {
		env: { memory },
		folio: {
			load: (p: number, o: number, w: number) => hook(LOAD, p, 0, o, w),
			store: (p: number, v: number, o: number, w: number) => hook(STORE, p, v, o, w),
			fill: (p: number, v: number, w: number) => hook(FILL, p, v, 0, w),
			copy() {
				throw new Error('unsupported');
			},
			load64() {
				throw new Error('unsupported');
			},
			store64() {
				throw new Error('unsupported');
			},
			exhausted() {
				throw new Error('fuel exhausted');
			},
			op: () => 0,
			...program.extra
		}
	}).exports;
	if (program.fuel !== undefined) exports.__folio_set_fuel(program.fuel);
	for (;;) {
		if (rewinding) exports.asyncify_start_rewind(16);
		const result = exports[program.entry]!(...program.args);
		if (!pending) return { done: true, result, ops };
		exports.asyncify_stop_unwind();
		const op = pending;
		pending = undefined;
		if (op.promise) {
			completion = await op.promise;
			if (++ops >= quantum)
				return {
					done: false,
					checkpoint: { memory: new Uint8Array(memory.buffer).slice(), completion },
					ops
				};
			rewinding = true;
			continue;
		}
		return {
			done: false,
			checkpoint: {
				memory: new Uint8Array(memory.buffer).slice(),
				completion: op.yielded!
			},
			ops
		};
	}
}
