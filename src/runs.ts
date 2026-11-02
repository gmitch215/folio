/**
 * Run-encoded tracking: reads and writes as sorted, non-touching `[start, length]` runs in a flat
 * `Uint32Array`. A run set is canonical when every length is at least 1 and each start lies past
 * the end of the run before it, so `[0, 4]` followed by `[4, 4]` is not canonical.
 */

/** Bytes covered by a flat run list. */
export function runBytes(runs: ArrayLike<number>): number {
	let total = 0;
	for (let i = 1; i < runs.length; i += 2) total += runs[i]!;
	return total;
}

/** Canonical runs from addresses sorted ascending; a repeated address counts once. */
export function runsOfSorted(addresses: ArrayLike<number>): Uint32Array {
	const out: number[] = [];
	let end = -1;
	for (let i = 0; i < addresses.length; i++) {
		const address = addresses[i]!;
		if (address === end) {
			out[out.length - 1]!++;
			end++;
		} else if (address > end) {
			out.push(address, 1);
			end = address + 1;
		}
	}
	return Uint32Array.from(out);
}

/** Runs for written bytes given as `[address, value]` pairs in any order, with their bytes. */
export function writeRunsOf(pairs: readonly (readonly [number, number])[]): {
	runs: Uint32Array;
	data: Uint8Array;
} {
	const order = Uint32Array.from(pairs, (pair) => pair[0]).sort();
	const values = new Map<number, number>();
	for (const [address, value] of pairs) values.set(address, value);
	const runs = runsOfSorted(order);
	const data = new Uint8Array(runBytes(runs));
	let at = 0;
	for (let i = 0; i < runs.length; i += 2)
		for (let k = 0; k < runs[i + 1]!; k++) data[at++] = values.get(runs[i]! + k)!;
	return { runs, data };
}

/**
 * Canonical runs from written pieces in any order; pieces that touch merge. Pieces must not
 * overlap. The bytes are copied once, in address order.
 */
export function packWrites(pieces: readonly (readonly [start: number, data: Uint8Array])[]): {
	runs: Uint32Array;
	data: Uint8Array;
} {
	const sorted = pieces.filter((piece) => piece[1].length).sort((a, b) => a[0] - b[0]);
	const runs: number[] = [];
	let total = 0;
	for (const [start, data] of sorted) {
		const last = runs.length - 2;
		if (last >= 0 && start <= runs[last]! + runs[last + 1]!)
			runs[last + 1] = Math.max(runs[last + 1]!, start + data.length - runs[last]!);
		else runs.push(start, data.length);
	}
	for (let i = 1; i < runs.length; i += 2) total += runs[i]!;
	const out = new Uint8Array(total);
	let base = 0,
		run = 0;
	for (const [start, data] of sorted) {
		while (start >= runs[run * 2]! + runs[run * 2 + 1]!) {
			base += runs[run * 2 + 1]!;
			run++;
		}
		out.set(data, base + start - runs[run * 2]!);
	}
	return { runs: Uint32Array.from(runs), data: out };
}

/** Keeps the first `cap` bytes of a run list. */
export function capRuns(runs: Uint32Array, cap: number): Uint32Array {
	let left = Math.max(0, cap);
	for (let i = 1; i < runs.length; i += 2) {
		if (runs[i]! <= left) {
			left -= runs[i]!;
			continue;
		}
		const out = runs.slice(0, i + 1);
		if (left) out[i] = left;
		else return runs.slice(0, i - 1);
		return out;
	}
	return runs;
}

/**
 * Throws unless `runs` is canonical and every byte lies below `limit`. A frame decoder calls it
 * on every run list it reads, so the rest of the owner can rely on the form.
 */
export function checkRuns(runs: ArrayLike<number>, limit: number, label: string): void {
	let end = -1;
	for (let i = 0; i < runs.length; i += 2) {
		const start = runs[i]!,
			length = runs[i + 1]!;
		if (length < 1 || start <= end) throw new TypeError(`non-canonical lane ${label} runs`);
		if (start + length > limit) throw new RangeError(`lane ${label} outside arena`);
		end = start + length;
	}
}

/**
 * Bytes written so far in one batch, as sorted non-touching intervals. `overlaps` is the
 * conflict test of the owner: true when any read run shares a byte with an interval.
 */
export class DirtyRuns {
	// parallel arrays, ascending; end is exclusive
	#starts: number[] = [];
	#ends: number[] = [];

	get count(): number {
		return this.#starts.length;
	}

	/** First interval whose end lies past `at`. */
	#after(at: number, from = 0): number {
		let low = from,
			high = this.#ends.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (this.#ends[mid]! <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}

	has(address: number): boolean {
		const i = this.#after(address);
		return i < this.#starts.length && this.#starts[i]! <= address;
	}

	/** Adds `[start, start + length)`; intervals it touches or overlaps merge. */
	add(start: number, length: number): void {
		if (length < 1) return;
		let end = start + length;
		// ascending writes append: the common case, since a batch walks its output forward
		const top = this.#ends.length - 1;
		if (top < 0 || start > this.#ends[top]!) {
			this.#starts.push(start);
			this.#ends.push(end);
			return;
		}
		if (start === this.#ends[top]) {
			this.#ends[top] = end;
			return;
		}
		// touching intervals merge: the first one whose end reaches start
		const first = this.#after(start - 1);
		let last = first;
		while (last < this.#starts.length && this.#starts[last]! <= end) {
			end = Math.max(end, this.#ends[last]!);
			last++;
		}
		const merged = first < last ? Math.min(start, this.#starts[first]!) : start;
		this.#starts.splice(first, last - first, merged);
		this.#ends.splice(first, last - first, end);
	}

	/** True when any byte of the canonical run list lies in the set. */
	overlaps(runs: ArrayLike<number>): boolean {
		if (!this.#starts.length) return false;
		let i = 0;
		for (let r = 0; r < runs.length; r += 2) {
			const start = runs[r]!,
				end = start + runs[r + 1]!;
			i = this.#after(start, i);
			if (i === this.#starts.length) return false;
			if (this.#starts[i]! < end) return true;
		}
		return false;
	}

	/** Every dirty byte as one canonical run list. */
	runs(): Uint32Array {
		const out = new Uint32Array(this.#starts.length * 2);
		this.#starts.forEach((start, i) => {
			out[i * 2] = start;
			out[i * 2 + 1] = this.#ends[i]! - start;
		});
		return out;
	}
}
