import { encodeFrame } from './frames.ts';

/** Page size for rounding learned footprints. */
export const rangePage = 4096;
/** Most ranges one frame carries; the header is capped at 64 KiB. */
export const maximumRanges = 1024;

/** Wire form of shipped ranges: omitted bytes are unknown, not zero. */
export interface RangesHeader {
	memoryBytes: number;
	/** Flat start, length pairs. */
	spans: number[];
}

/** A sorted set of non-overlapping, non-touching byte ranges. Operations return new sets. */
export class RangeSet {
	static readonly empty = new RangeSet([]);
	// flat start, end pairs; end is exclusive
	readonly #bounds: readonly number[];

	private constructor(bounds: readonly number[]) {
		this.#bounds = bounds;
	}

	/** Builds a set from start, length pairs in any order; overlapping and touching pairs merge. */
	static of(spans: Iterable<readonly [start: number, length: number]>): RangeSet {
		const pairs: [number, number][] = [];
		for (const [start, length] of spans) {
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(length) ||
				start < 0 ||
				length < 0
			)
				throw new RangeError('invalid range');
			if (length) pairs.push([start, start + length]);
		}
		pairs.sort((a, b) => a[0] - b[0]);
		const bounds: number[] = [];
		for (const [start, end] of pairs) {
			if (bounds.length && start <= bounds[bounds.length - 1]!)
				bounds[bounds.length - 1] = Math.max(bounds[bounds.length - 1]!, end);
			else bounds.push(start, end);
		}
		return new RangeSet(bounds);
	}

	/** Builds a set from byte addresses, as a tracked read set lists them. */
	static fromAddresses(addresses: ArrayLike<number>): RangeSet {
		const sorted = Uint32Array.from(addresses).sort();
		const bounds: number[] = [];
		for (const address of sorted) {
			if (bounds.length && address <= bounds[bounds.length - 1]!) {
				if (address === bounds[bounds.length - 1]) bounds[bounds.length - 1] = address + 1;
			} else bounds.push(address, address + 1);
		}
		return new RangeSet(bounds);
	}

	/** Builds a set from a canonical flat run list, which a frame decoder has already checked. */
	static fromRuns(runs: ArrayLike<number>): RangeSet {
		const bounds: number[] = new Array(runs.length);
		for (let i = 0; i < runs.length; i += 2) {
			bounds[i] = runs[i]!;
			bounds[i + 1] = runs[i]! + runs[i + 1]!;
		}
		return new RangeSet(bounds);
	}

	/** The set as a flat run list, start then length, in ascending order. */
	runs(): Uint32Array {
		const out = new Uint32Array(this.#bounds.length);
		for (let i = 0; i < out.length; i += 2) {
			out[i] = this.#bounds[i]!;
			out[i + 1] = this.#bounds[i + 1]! - this.#bounds[i]!;
		}
		return out;
	}

	/** Number of ranges. */
	get count(): number {
		return this.#bounds.length / 2;
	}

	/** Total bytes covered. */
	get length(): number {
		let total = 0;
		for (let i = 0; i < this.#bounds.length; i += 2)
			total += this.#bounds[i + 1]! - this.#bounds[i]!;
		return total;
	}

	/** Start, length pairs in ascending order. */
	spans(): [number, number][] {
		const out: [number, number][] = [];
		for (let i = 0; i < this.#bounds.length; i += 2)
			out.push([this.#bounds[i]!, this.#bounds[i + 1]! - this.#bounds[i]!]);
		return out;
	}

	/** True when every byte of `[start, start + length)` is in the set. */
	contains(start: number, length = 1): boolean {
		if (length <= 0) return true;
		let low = 0,
			high = this.count - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (this.#bounds[mid * 2]! > start) high = mid - 1;
			else if (this.#bounds[mid * 2 + 1]! <= start) low = mid + 1;
			else return start + length <= this.#bounds[mid * 2 + 1]!;
		}
		return false;
	}

	union(other: RangeSet): RangeSet {
		return RangeSet.of([...this.spans(), ...other.spans()]);
	}

	/** Bytes of this set that `other` does not cover. */
	subtract(other: RangeSet): RangeSet {
		const bounds: number[] = [];
		const cut = other.#bounds;
		let j = 0;
		for (let i = 0; i < this.#bounds.length; i += 2) {
			let start = this.#bounds[i]!;
			const end = this.#bounds[i + 1]!;
			while (j < cut.length && cut[j + 1]! <= start) j += 2;
			for (let k = j; k < cut.length && cut[k]! < end; k += 2) {
				if (cut[k]! > start) bounds.push(start, cut[k]!);
				start = Math.max(start, cut[k + 1]!);
			}
			if (start < end) bounds.push(start, end);
		}
		return new RangeSet(bounds);
	}

	/** Merges ranges whose gap is at most `gap` bytes; the gap bytes join the set. */
	coalesce(gap: number): RangeSet {
		const bounds: number[] = [];
		for (let i = 0; i < this.#bounds.length; i += 2) {
			if (bounds.length && this.#bounds[i]! - bounds[bounds.length - 1]! <= gap)
				bounds[bounds.length - 1] = this.#bounds[i + 1]!;
			else bounds.push(this.#bounds[i]!, this.#bounds[i + 1]!);
		}
		return new RangeSet(bounds);
	}

	/** Widens every range to whole pages, never past `limit`. */
	round(page: number, limit: number): RangeSet {
		const spans: [number, number][] = [];
		for (let i = 0; i < this.#bounds.length; i += 2) {
			const start = Math.floor(this.#bounds[i]! / page) * page;
			const end = Math.min(Math.ceil(this.#bounds[i + 1]! / page) * page, limit);
			if (start < end) spans.push([start, end - start]);
		}
		return RangeSet.of(spans);
	}

	/** Drops bytes at or past `limit`. */
	clip(limit: number): RangeSet {
		return this.subtract(RangeSet.of([[limit, Number.MAX_SAFE_INTEGER - limit]]));
	}
}

/** Bytes of a tracked read set that fall outside what was shipped. */
export function escapes(reads: ArrayLike<number>, shipped: RangeSet): RangeSet {
	return RangeSet.fromAddresses(reads).subtract(shipped);
}

/** Escapes of a decoded result, from its read runs when it has them and its addresses otherwise. */
export function resultEscapes(
	result: { reads: ArrayLike<number>; readRuns?: ArrayLike<number> },
	shipped: RangeSet
): RangeSet {
	return result.readRuns
		? RangeSet.fromRuns(result.readRuns).subtract(shipped)
		: escapes(result.reads, shipped);
}

/** Learned footprints keyed by export and arguments, bounded, least recently used out first. */
export class FootprintCache {
	readonly #entries = new Map<string, RangeSet>();
	readonly #maximum: number;

	constructor(maximumEntries = 1024) {
		if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1)
			throw new RangeError('invalid footprint cache size');
		this.#maximum = maximumEntries;
	}

	static key(name: string, args: readonly (number | bigint)[]): string {
		return JSON.stringify([
			name,
			...args.map((value) => (typeof value === 'bigint' ? `${value}n` : value))
		]);
	}

	get size(): number {
		return this.#entries.size;
	}

	get(key: string): RangeSet | undefined {
		const found = this.#entries.get(key);
		if (found) {
			this.#entries.delete(key);
			this.#entries.set(key, found);
		}
		return found;
	}

	/** Adds ranges to a key's footprint. */
	learn(key: string, added: RangeSet): void {
		const merged = (this.#entries.get(key) ?? RangeSet.empty).union(added);
		this.#entries.delete(key);
		this.#entries.set(key, merged);
		if (this.#entries.size > this.#maximum)
			this.#entries.delete(this.#entries.keys().next().value!);
	}

	clear(): void {
		this.#entries.clear();
	}
}

/**
 * Builds a ranges frame: the wanted ranges are clipped to memory, coalesced until they fit the
 * range limit, and copied out of `memory`. The payload ends with one pad byte so a lane that
 * predates ranges rejects it as a snapshot instead of reading it as one. Returns the set that
 * was shipped, which may be wider than the one asked for.
 */
export function encodeRangesFrame(
	header: object,
	memory: Uint8Array,
	wanted: RangeSet,
	maximum?: number
): { frame: Uint8Array; shipped: RangeSet } {
	if (memory.length % 65536) throw new RangeError('invalid memory page size');
	let shipped = wanted.clip(memory.length);
	for (let gap = rangePage; shipped.count > maximumRanges; gap *= 2)
		shipped = shipped.coalesce(gap);
	const spans = shipped.spans();
	const payload = new Uint8Array(shipped.length + 1);
	let offset = 0;
	for (const [start, length] of spans) {
		payload.set(memory.subarray(start, start + length), offset);
		offset += length;
	}
	const ranges: RangesHeader = { memoryBytes: memory.length, spans: spans.flat() };
	return { frame: encodeFrame({ ...header, ranges }, payload, maximum), shipped };
}

/** Checks a ranges header against its payload before any write and returns the shipped set. */
export function decodeRanges(
	ranges: RangesHeader | undefined,
	payload: Uint8Array
): { memoryBytes: number; shipped: RangeSet } {
	if (
		!ranges ||
		!Number.isSafeInteger(ranges.memoryBytes) ||
		ranges.memoryBytes < 0 ||
		ranges.memoryBytes % 65536 ||
		!Array.isArray(ranges.spans) ||
		ranges.spans.length % 2 ||
		ranges.spans.length > maximumRanges * 2
	)
		throw new TypeError('invalid ranges');
	let previous = 0,
		total = 0;
	for (let i = 0; i < ranges.spans.length; i += 2) {
		const start = ranges.spans[i]!,
			length = ranges.spans[i + 1]!;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			start < previous ||
			start + length > ranges.memoryBytes
		)
			throw new TypeError('invalid range');
		previous = start + length;
		total += length;
	}
	if (payload.length !== total + 1) throw new TypeError('ranges payload length differs');
	const pairs: [number, number][] = [];
	for (let i = 0; i < ranges.spans.length; i += 2)
		pairs.push([ranges.spans[i]!, ranges.spans[i + 1]!]);
	return { memoryBytes: ranges.memoryBytes, shipped: RangeSet.of(pairs) };
}

/** Copies a validated ranges payload into `target`; bytes outside the ranges are untouched. */
export function restoreRanges(target: Uint8Array, payload: Uint8Array, shipped: RangeSet): void {
	let offset = 0;
	for (const [start, length] of shipped.spans()) {
		target.set(payload.subarray(offset, offset + length), start);
		offset += length;
	}
}

/** Zeroes every range of `set` in `target`. */
export function clearRanges(target: Uint8Array, set: RangeSet): void {
	for (const [start, length] of set.spans()) target.fill(0, start, start + length);
}
