/** A synchronous store for chunks. `read` copies a chunk into `into` and returns its version, or undefined when absent. */
export interface SyncHolder {
	read(index: number, into: Uint8Array): number | undefined;
	write(index: number, version: number, bytes: Uint8Array): void;
}

/** The asynchronous form of `SyncHolder`. */
export interface AsyncHolder {
	read(index: number, into: Uint8Array): Promise<number | undefined>;
	write(index: number, version: number, bytes: Uint8Array): Promise<void>;
}

export interface ElasticOptions {
	/** Logical size in bytes; a whole number of chunks. */
	byteLength: number;
	/** A power of two from 4 KiB to 8 MiB. */
	chunkBytes: number;
	/** Resident window in chunks, at least 1. */
	frames: number;
}

export interface ElasticStats {
	faults: number;
	zeroFills: number;
	writeBacks: number;
	evictions: number;
	bytesIn: number;
	bytesOut: number;
	staleRefusals: number;
	hits: number;
}

/** A chunk whose holder copy is missing or at a version other than the table's. */
export class StaleChunkError extends Error {
	readonly chunk: number;
	readonly expected: number;
	readonly found: number | undefined;

	constructor(chunk: number, expected: number, found: number | undefined) {
		super(
			found === undefined
				? `chunk ${chunk} is missing from its holder; the table expects version ${expected}`
				: `chunk ${chunk} is stale; the table expects version ${expected}, the holder has ${found}`
		);
		this.name = 'StaleChunkError';
		this.chunk = chunk;
		this.expected = expected;
		this.found = found;
	}
}

const minChunkBytes = 4096;
const maxChunkBytes = 8 * 1024 * 1024;

// frame bookkeeping and the version table; the sync and async regions differ only in how they await the holder
class Window {
	readonly byteLength: number;
	readonly chunkBytes: number;
	readonly chunkCount: number;
	protected readonly buffer: ArrayBuffer;
	protected readonly frames: Uint8Array[];
	// chunk held by each frame, -1 when free
	protected readonly chunkOf: Int32Array;
	// frame holding each chunk, -1 when not resident
	protected readonly frameOf: Int32Array;
	protected readonly dirty: Uint8Array;
	protected readonly pins: Uint32Array;
	protected readonly recency: Float64Array;
	protected readonly versions: Uint32Array;
	protected readonly counts: ElasticStats = {
		faults: 0,
		zeroFills: 0,
		writeBacks: 0,
		evictions: 0,
		bytesIn: 0,
		bytesOut: 0,
		staleRefusals: 0,
		hits: 0
	};
	private clock = 0;

	constructor(options: ElasticOptions) {
		const { byteLength, chunkBytes, frames } = options;
		if (
			!Number.isInteger(chunkBytes) ||
			chunkBytes < minChunkBytes ||
			chunkBytes > maxChunkBytes ||
			(chunkBytes & (chunkBytes - 1)) !== 0
		)
			throw new RangeError('chunkBytes must be a power of two from 4 KiB to 8 MiB');
		if (
			!Number.isInteger(byteLength) ||
			byteLength < chunkBytes ||
			byteLength % chunkBytes !== 0
		)
			throw new RangeError('byteLength must be a positive whole number of chunks');
		if (!Number.isInteger(frames) || frames < 1)
			throw new RangeError('frames must be a positive integer');
		this.byteLength = byteLength;
		this.chunkBytes = chunkBytes;
		this.chunkCount = byteLength / chunkBytes;
		this.buffer = new ArrayBuffer(frames * chunkBytes);
		this.frames = Array.from(
			{ length: frames },
			(_, f) => new Uint8Array(this.buffer, f * chunkBytes, chunkBytes)
		);
		this.chunkOf = new Int32Array(frames).fill(-1);
		this.frameOf = new Int32Array(this.chunkCount).fill(-1);
		this.dirty = new Uint8Array(frames);
		this.pins = new Uint32Array(frames);
		this.recency = new Float64Array(frames);
		this.versions = new Uint32Array(this.chunkCount);
	}

	stats(): ElasticStats {
		return { ...this.counts };
	}

	snapshotTable(): Uint32Array {
		return this.versions.slice();
	}

	protected replaceTable(table: Uint32Array): void {
		if (table.length !== this.chunkCount)
			throw new RangeError(
				`table has ${table.length} entries; the region has ${this.chunkCount} chunks`
			);
		for (let f = 0; f < this.frames.length; f++)
			if (this.dirty[f] || this.pins[f])
				throw new Error(
					'restoreTable needs no dirty or pinned frame; flush and unpin first'
				);
		for (let f = 0; f < this.frames.length; f++) this.unmap(f);
		this.versions.set(table);
	}

	protected check(offset: number, length: number): void {
		if (
			!Number.isInteger(offset) ||
			!Number.isInteger(length) ||
			offset < 0 ||
			length < 0 ||
			offset + length > this.byteLength
		)
			throw new RangeError(
				`range ${offset}+${length} is outside the ${this.byteLength}-byte region`
			);
	}

	// validates a view and returns its chunk
	protected viewChunk(offset: number, length: number): number {
		this.check(offset, length);
		const index = Math.floor(offset / this.chunkBytes);
		if (length < 1 || Math.floor((offset + length - 1) / this.chunkBytes) !== index)
			throw new RangeError('a view covers 1 or more bytes inside one chunk');
		return index;
	}

	protected sliceFrame(f: number, offset: number, length: number): Uint8Array {
		const within = offset % this.chunkBytes;
		return this.frames[f]!.subarray(within, within + length);
	}

	protected frameOfView(view: Uint8Array): number {
		if (view.buffer !== this.buffer) throw new RangeError('view is not from this region');
		return Math.floor(view.byteOffset / this.chunkBytes);
	}

	protected pinFrame(f: number): void {
		this.pins[f]! += 1;
	}

	protected unpinView(view: Uint8Array, dirty: boolean): void {
		const f = this.frameOfView(view);
		if (this.pins[f] === 0) throw new Error('view is not pinned');
		this.pins[f]! -= 1;
		if (dirty) this.dirty[f] = 1;
	}

	protected markDirty(offset: number, length: number): void {
		this.check(offset, length);
		for (let at = offset; at < offset + length;) {
			const index = Math.floor(at / this.chunkBytes);
			const f = this.frameOf[index]!;
			if (f < 0)
				throw new RangeError(`chunk ${index} is not resident; pin its view to keep it`);
			this.dirty[f] = 1;
			at = (index + 1) * this.chunkBytes;
		}
	}

	protected victim(): number {
		let best = -1;
		for (let f = 0; f < this.frames.length; f++) {
			if (this.chunkOf[f]! < 0 && this.pins[f] === 0) return f;
			if (this.pins[f] === 0 && (best < 0 || this.recency[f]! < this.recency[best]!))
				best = f;
		}
		return best;
	}

	protected freeFrame(): number {
		for (let f = 0; f < this.frames.length; f++)
			if (this.chunkOf[f]! < 0 && this.pins[f] === 0) return f;
		return -1;
	}

	protected windowFull(index: number): RangeError {
		return new RangeError(
			`every frame of the ${this.frames.length}-frame window is pinned; unpin one before chunk ${index} loads`
		);
	}

	protected map(f: number, index: number): void {
		this.chunkOf[f] = index;
		this.frameOf[index] = f;
		this.dirty[f] = 0;
		this.use(f);
	}

	protected unmap(f: number): void {
		const index = this.chunkOf[f]!;
		if (index >= 0) this.frameOf[index] = -1;
		this.chunkOf[f] = -1;
		this.dirty[f] = 0;
	}

	protected use(f: number): void {
		this.recency[f] = ++this.clock;
	}

	// a never-written chunk is zero-filled; returns true when the holder must supply the bytes
	protected needsHolder(f: number, index: number): boolean {
		if (this.versions[index] !== 0) return true;
		this.frames[f]!.fill(0);
		this.counts.zeroFills++;
		return false;
	}

	protected checkStored(index: number, found: number | undefined): void {
		const expected = this.versions[index]!;
		if (found !== undefined) this.counts.bytesIn += this.chunkBytes;
		if (found === expected) return;
		this.counts.staleRefusals++;
		throw new StaleChunkError(index, expected, found);
	}

	// the version a write-back stamps; version 0 is reserved for never-written
	protected nextVersion(index: number): number {
		const version = this.versions[index]! + 1;
		if (version > 0xffffffff) throw new RangeError(`chunk ${index} has no version left`);
		return version;
	}

	protected committed(f: number, index: number, version: number): void {
		this.versions[index] = version;
		this.dirty[f] = 0;
		this.counts.writeBacks++;
		this.counts.bytesOut += this.chunkBytes;
	}
}

/**
 * A region of `byteLength` bytes held through a window of `frames` chunks in one buffer.
 *
 * The version table lives in the instance. After a restart, restore it with `restoreTable` from a
 * copy the owner persisted, or every chunk reads as never written.
 */
export class ElasticRegion extends Window {
	private readonly holder: SyncHolder;

	constructor(options: ElasticOptions & { holder: SyncHolder }) {
		super(options);
		this.holder = options.holder;
	}

	/** The same region over an asynchronous holder. */
	static async(options: ElasticOptions & { holder: AsyncHolder }): AsyncElasticRegion {
		return new AsyncElasticRegion(options);
	}

	/** A view inside one chunk, valid until the next call that can fault; `pin` keeps it longer. */
	view(offset: number, length: number): Uint8Array {
		const f = this.fault(this.viewChunk(offset, length));
		return this.sliceFrame(f, offset, length);
	}

	pin(offset: number, length: number): Uint8Array {
		const f = this.fault(this.viewChunk(offset, length));
		this.pinFrame(f);
		return this.sliceFrame(f, offset, length);
	}

	unpin(view: Uint8Array, dirty: boolean): void {
		this.unpinView(view, dirty);
	}

	read(offset: number, into: Uint8Array): void {
		this.check(offset, into.length);
		for (let done = 0; done < into.length;) {
			const at = offset + done;
			const within = at % this.chunkBytes;
			const n = Math.min(this.chunkBytes - within, into.length - done);
			const f = this.fault(Math.floor(at / this.chunkBytes));
			into.set(this.frames[f]!.subarray(within, within + n), done);
			done += n;
		}
	}

	write(offset: number, bytes: Uint8Array): void {
		this.check(offset, bytes.length);
		for (let done = 0; done < bytes.length;) {
			const at = offset + done;
			const within = at % this.chunkBytes;
			const n = Math.min(this.chunkBytes - within, bytes.length - done);
			const f = this.fault(Math.floor(at / this.chunkBytes));
			this.frames[f]!.set(bytes.subarray(done, done + n), within);
			this.dirty[f] = 1;
			done += n;
		}
	}

	touch(offset: number, length: number): void {
		this.markDirty(offset, length);
	}

	copyIntoMemory(
		memory: WebAssembly.Memory,
		pointer: number,
		offset: number,
		length: number
	): void {
		this.read(offset, new Uint8Array(memory.buffer, pointer, length));
	}

	copyFromMemory(
		memory: WebAssembly.Memory,
		pointer: number,
		offset: number,
		length: number
	): void {
		this.write(offset, new Uint8Array(memory.buffer, pointer, length));
	}

	flush(): void {
		for (let f = 0; f < this.frames.length; f++) if (this.dirty[f]) this.writeBack(f);
	}

	restoreTable(table: Uint32Array): void {
		this.replaceTable(table);
	}

	private fault(index: number): number {
		const known = this.frameOf[index]!;
		if (known >= 0) {
			this.counts.hits++;
			this.use(known);
			return known;
		}
		const f = this.victim();
		if (f < 0) throw this.windowFull(index);
		this.counts.faults++;
		if (this.chunkOf[f]! >= 0) this.evict(f);
		this.map(f, index);
		try {
			if (this.needsHolder(f, index))
				this.checkStored(index, this.holder.read(index, this.frames[f]!));
		} catch (error) {
			this.unmap(f);
			throw error;
		}
		return f;
	}

	private evict(f: number): void {
		if (this.dirty[f]) this.writeBack(f);
		this.counts.evictions++;
		this.unmap(f);
	}

	private writeBack(f: number): void {
		const index = this.chunkOf[f]!;
		const version = this.nextVersion(index);
		this.holder.write(index, version, this.frames[f]!);
		this.committed(f, index, version);
	}
}

/** The async form of `ElasticRegion`. Operations run one at a time; `prefetch` starts loads in the background. */
export class AsyncElasticRegion extends Window {
	private readonly holder: AsyncHolder;
	private readonly inflight = new Map<number, Promise<void>>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: ElasticOptions & { holder: AsyncHolder }) {
		super(options);
		this.holder = options.holder;
	}

	view(offset: number, length: number): Promise<Uint8Array> {
		return this.run(async () => {
			const f = await this.fault(this.viewChunk(offset, length));
			return this.sliceFrame(f, offset, length);
		});
	}

	pin(offset: number, length: number): Promise<Uint8Array> {
		return this.run(async () => {
			const f = await this.fault(this.viewChunk(offset, length));
			this.pinFrame(f);
			return this.sliceFrame(f, offset, length);
		});
	}

	unpin(view: Uint8Array, dirty: boolean): Promise<void> {
		return this.run(async () => this.unpinView(view, dirty));
	}

	read(offset: number, into: Uint8Array): Promise<void> {
		return this.run(() => this.readInto(offset, into));
	}

	write(offset: number, bytes: Uint8Array): Promise<void> {
		return this.run(() => this.writeFrom(offset, bytes));
	}

	touch(offset: number, length: number): Promise<void> {
		return this.run(async () => this.markDirty(offset, length));
	}

	copyIntoMemory(
		memory: WebAssembly.Memory,
		pointer: number,
		offset: number,
		length: number
	): Promise<void> {
		return this.run(() =>
			this.readInto(offset, new Uint8Array(memory.buffer, pointer, length))
		);
	}

	copyFromMemory(
		memory: WebAssembly.Memory,
		pointer: number,
		offset: number,
		length: number
	): Promise<void> {
		return this.run(() =>
			this.writeFrom(offset, new Uint8Array(memory.buffer, pointer, length))
		);
	}

	flush(): Promise<void> {
		return this.run(async () => {
			for (let f = 0; f < this.frames.length; f++) if (this.dirty[f]) await this.writeBack(f);
		});
	}

	restoreTable(table: Uint32Array): Promise<void> {
		return this.run(async () => this.replaceTable(table));
	}

	// starts loads for the missing chunks that fit in free frames; never evicts and never awaits
	prefetch(offset: number, length: number): void {
		this.check(offset, length);
		if (length === 0) return;
		const last = Math.floor((offset + length - 1) / this.chunkBytes);
		for (let index = Math.floor(offset / this.chunkBytes); index <= last; index++) {
			if (this.frameOf[index]! >= 0) continue;
			const f = this.freeFrame();
			if (f < 0) break;
			this.map(f, index);
			this.pinFrame(f);
			this.counts.faults++;
			const load: Promise<void> = this.loadAsync(f, index)
				.catch((error: unknown) => {
					this.unmap(f);
					throw error;
				})
				.finally(() => {
					this.pins[f]! -= 1;
					if (this.inflight.get(index) === load) this.inflight.delete(index);
				});
			load.catch(() => undefined);
			this.inflight.set(index, load);
		}
	}

	// waits for the loads in flight; rejects with the first failure among them
	async settled(): Promise<void> {
		const results = await Promise.allSettled([...this.inflight.values()]);
		const failed = results.find((result) => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}

	private run<T>(op: () => Promise<T>): Promise<T> {
		const next = this.queue.then(op);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async readInto(offset: number, into: Uint8Array): Promise<void> {
		this.check(offset, into.length);
		for (let done = 0; done < into.length;) {
			const at = offset + done;
			const within = at % this.chunkBytes;
			const n = Math.min(this.chunkBytes - within, into.length - done);
			const f = await this.fault(Math.floor(at / this.chunkBytes));
			into.set(this.frames[f]!.subarray(within, within + n), done);
			done += n;
		}
	}

	private async writeFrom(offset: number, bytes: Uint8Array): Promise<void> {
		this.check(offset, bytes.length);
		for (let done = 0; done < bytes.length;) {
			const at = offset + done;
			const within = at % this.chunkBytes;
			const n = Math.min(this.chunkBytes - within, bytes.length - done);
			const f = await this.fault(Math.floor(at / this.chunkBytes));
			this.frames[f]!.set(bytes.subarray(done, done + n), within);
			this.dirty[f] = 1;
			done += n;
		}
	}

	private async fault(index: number): Promise<number> {
		const pending = this.inflight.get(index);
		if (pending) {
			await pending;
			this.counts.hits++;
			return this.frameOf[index]!;
		}
		const known = this.frameOf[index]!;
		if (known >= 0) {
			this.counts.hits++;
			this.use(known);
			return known;
		}
		let f = this.victim();
		while (f < 0 && this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight.values()]);
			f = this.victim();
		}
		if (f < 0) throw this.windowFull(index);
		this.counts.faults++;
		// pinned across the awaits so a prefetch cannot take the frame between eviction and mapping
		this.pinFrame(f);
		try {
			if (this.chunkOf[f]! >= 0) await this.evict(f);
			this.map(f, index);
			try {
				await this.loadAsync(f, index);
			} catch (error) {
				this.unmap(f);
				throw error;
			}
		} finally {
			this.pins[f]! -= 1;
		}
		return f;
	}

	private async loadAsync(f: number, index: number): Promise<void> {
		if (!this.needsHolder(f, index)) return;
		this.checkStored(index, await this.holder.read(index, this.frames[f]!));
	}

	private async evict(f: number): Promise<void> {
		if (this.dirty[f]) await this.writeBack(f);
		this.counts.evictions++;
		this.unmap(f);
	}

	private async writeBack(f: number): Promise<void> {
		const index = this.chunkOf[f]!;
		const version = this.nextVersion(index);
		await this.holder.write(index, version, this.frames[f]!);
		this.committed(f, index, version);
	}
}
