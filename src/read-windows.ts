import { iterationGranules } from './iteration-layout.ts';

const READ = iterationGranules.read;
const WRITE = iterationGranules.write;

/** A byte range an iteration reads without per-access marks. */
export interface IterationReadWindow {
	low: number;
	bytes: number;
}

/**
 * The read windows of one loop. The strided window moves with the iteration index: iteration `k`
 * reads from the granule boundary at or below `low + (k - index) * stride`. The fixed window is the same range in every
 * iteration. Neither has to be right for a run to be correct: a load outside the window is tracked
 * as usual, and a window only costs a false conflict when another iteration writes inside it.
 */
export interface IterationReadWindows {
	strided?: { index: number; low: number; stride: number; bytes: number };
	fixed?: IterationReadWindow;
}

/** What one iteration's outcome has to hold for learning. */
export interface ReadWindowSample {
	index: number;
	status: number;
	/** sorted write granules (32 bytes) */
	written: Int32Array;
	/** [start, length] runs of read granules (64 bytes) */
	reads: Int32Array;
}

/** Smallest window worth marking: four read granules for the strided one, two for the fixed one. */
export const readWindowMinimum = { strided: 4 * READ, fixed: 2 * READ } as const;

/**
 * Loads of at most 8 bytes of one run on the module with read windows, by where they landed:
 * inside a window, tracked outside every window, or exempt (the slot's own callee stack).
 */
export interface ReadWindowCounts {
	hits: number;
	misses: number;
	exempt: number;
}

/**
 * Executed Wasm instructions of one load of at most 8 bytes, counted on the lowering with the slot
 * checks and no frame shadow (one node per instruction). The windows go before the exempt check
 * (`window` order) or after it (`exempt` order, the `exemptFirst` option). The frame shadow adds
 * 10 to a tracked load and to a miss and nothing to a hit or an exempt load.
 */
export const readWindowInstructions = {
	tracked: 50,
	frame: 10,
	exempt: 15,
	/** per window a load runs through without hitting it */
	guard: 6,
	/** a hit in the first window, and in the second, by order */
	hit: { window: [11, 17], exempt: [21, 27] }
} as const;

/** What a run of the window module is expected to cost or save, in instructions. */
export interface ReadWindowVerdict {
	/** Instructions the hits would not execute, against the lowering with no windows. */
	saved: number;
	/** Instructions the misses, the exempt loads and the marking of the windows add. */
	spent: number;
	/** The order of the two checks that costs less for these counts. */
	order: 'window' | 'exempt';
	pay: boolean;
}

/**
 * Whether read windows pay for a loop, and in which order, from the counts of a batch on them. A
 * hit replaces the mark and the slot checks of a tracked load; a miss executes the window guards on
 * top of a tracked load; an exempt load executes them too when the windows come first; and the
 * owner marks every window granule before each iteration. Windows are armed when the instructions
 * saved exceed those spent by at least `margin` of the instructions the counted tracked loads
 * cost. A window of the wrong size is still sound, so this decides cost only.
 */
export function readWindowsPay(
	counts: ReadWindowCounts,
	windows: IterationReadWindows,
	frame: boolean,
	iterations: number,
	margin = readWindowMargin
): ReadWindowVerdict {
	const c = readWindowInstructions;
	const n = (windows.strided ? 1 : 0) + (windows.fixed ? 1 : 0);
	const tracked = c.tracked + (frame ? c.frame : 0);
	const bytes = (windows.strided?.bytes ?? 0) + (windows.fixed?.bytes ?? 0);
	// one store per 512 bytes of window for the bitmap, one per 4 KiB for the summary
	const marking = Math.ceil(bytes / 512 + bytes / 4096) * 4 * Math.max(iterations, 1);
	const guards = c.guard * n;
	const verdict = (order: 'window' | 'exempt'): ReadWindowVerdict => {
		const [first, second] = c.hit[order];
		const hit = n === 2 ? (first + second) / 2 : first;
		const saved = counts.hits * (tracked - hit);
		const spent = (counts.misses + (order === 'window' ? counts.exempt : 0)) * guards + marking;
		return { saved, spent, order, pay: false };
	};
	const windowFirst = verdict('window');
	const exemptFirst = verdict('exempt');
	const best =
		exemptFirst.saved - exemptFirst.spent > windowFirst.saved - windowFirst.spent
			? exemptFirst
			: windowFirst;
	const loads = counts.hits + counts.misses;
	return { ...best, pay: best.saved - best.spent > margin * loads * tracked };
}

/** Fraction of the counted tracked loads' instructions a window run must save to be armed. */
export const readWindowMargin = 0.05;

/** Windows of iteration `k` inside `[0, memoryBytes)`, at most two. */
export function readWindowsAt(
	windows: IterationReadWindows,
	k: number,
	memoryBytes: number
): IterationReadWindow[] {
	const found: IterationReadWindow[] = [];
	const s = windows.strided;
	if (s) {
		const low = READ * Math.floor((s.low + (k - s.index) * s.stride) / READ);
		if (low >= 0 && low + s.bytes <= memoryBytes) found.push({ low, bytes: s.bytes });
	}
	if (windows.fixed && windows.fixed.low + windows.fixed.bytes <= memoryBytes)
		found.push(windows.fixed);
	return found;
}

/**
 * Whether every window of iterations `first` to `first + count - 1` stays clear of the forbidden
 * ranges (the arena, the grown logs), as `[low, end)` pairs. A load in a window skips the checks
 * that would have found an access to those ranges.
 */
export function readWindowsClear(
	windows: IterationReadWindows,
	first: number,
	count: number,
	memoryBytes: number,
	forbidden: readonly (readonly [number, number])[]
): boolean {
	const wanted = (windows.strided ? 1 : 0) + (windows.fixed ? 1 : 0);
	for (let k = first; k < first + count; k++) {
		const found = readWindowsAt(windows, k, memoryBytes);
		if (found.length !== wanted) return false;
		for (const w of found)
			for (const [low, end] of forbidden)
				if (w.low < end && w.low + w.bytes > low) return false;
	}
	return true;
}

/** Sets the read bits of every granule a window touches in the bitmap that starts at `base`. */
export function markReadWindow(u8: Uint8Array, base: number, low: number, bytes: number): void {
	const first = Math.floor(low / READ);
	const last = Math.floor((low + bytes - 1) / READ);
	for (let g = first; g <= last;) {
		if ((g & 7) === 0 && g + 7 <= last) {
			u8[base + (g >> 3)] = 0xff;
			g += 8;
			continue;
		}
		u8[base + (g >> 3)]! |= 1 << (g & 7);
		g++;
	}
}

// does a sorted list of write granules hold one that touches [low, end)
function writesTouch(sorted: Int32Array, low: number, end: number): boolean {
	let a = 0,
		b = sorted.length;
	const from = Math.floor(low / WRITE);
	while (a < b) {
		const mid = (a + b) >> 1;
		if (sorted[mid]! < from) a = mid + 1;
		else b = mid;
	}
	return a < sorted.length && sorted[a]! * WRITE < end;
}

// the value in the open interval with the most trailing zero bits, so a power-of-two record size wins
function pickStride(low: number, high: number): number {
	for (let step = 4096; step >= 1; step /= 2) {
		const candidate = (Math.ceil(high / step) - 1) * step;
		if (candidate > low && candidate < high) return candidate;
	}
	return (low + high) / 2;
}

function intersectRuns(a: number[], b: number[]): number[] {
	const out: number[] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		const low = Math.max(a[i]!, b[j]!);
		const end = Math.min(a[i]! + a[i + 1]!, b[j]! + b[j + 1]!);
		if (end > low) out.push(low, end - low);
		if (a[i]! + a[i + 1]! < b[j]! + b[j + 1]!) i += 2;
		else j += 2;
	}
	return out;
}

function subtractRange(runs: number[], low: number, end: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < runs.length; i += 2) {
		const from = runs[i]!;
		const to = from + runs[i + 1]!;
		if (to <= low || from >= end) out.push(from, to - from);
		else {
			if (from < low) out.push(from, low - from);
			if (to > end) out.push(end, to - end);
		}
	}
	return out;
}

/**
 * Windows from the read and write sets of tracked iterations that completed without a conflict.
 * The strided one follows the largest read run of each iteration when the runs line up on one
 * stride; when their lengths differ by more than a granule the window is the shortest one; the fixed one is the largest run
 * every iteration read that is not inside the strided one. A window that another iteration wrote
 * into, in the sample, is dropped: its reads would conflict. Needs three completed iterations.
 */
export function learnReadWindows(samples: readonly ReadWindowSample[]): {
	windows?: IterationReadWindows;
	reason?: string;
} {
	const done = samples.filter((s) => s.status === 0).sort((a, b) => a.index - b.index);
	if (done.length < 3) return { reason: 'fewer than three completed iterations to learn from' };
	const windows: IterationReadWindows = {};
	const why: string[] = [];
	const runsOf = (s: ReadWindowSample) => Array.from(s.reads);
	const largest = done.map((s) => {
		let start = -1,
			length = 0;
		for (let i = 0; i < s.reads.length; i += 2)
			if (s.reads[i + 1]! > length) {
				start = s.reads[i]!;
				length = s.reads[i + 1]!;
			}
		return { start, length };
	});
	const others = (k: number, low: number, end: number) =>
		done.some((s, j) => j !== k && writesTouch(s.written, low, end));
	const lengths = largest.map((l) => l.length);
	const maxLen = Math.max(...lengths);
	const minLen = Math.min(...lengths);
	if (minLen * READ < readWindowMinimum.strided)
		why.push('no read run of 256 bytes in every iteration');
	else {
		// the first byte of iteration k lies in granule start[k], so every pair of iterations bounds
		// the stride to an open interval of width 128 / distance; the stride is one value in all
		let low = -Infinity,
			high = Infinity;
		for (let i = 0; i < done.length; i++)
			for (let j = i + 1; j < done.length; j++) {
				const span = done[j]!.index - done[i]!.index;
				const delta = (largest[j]!.start - largest[i]!.start) * READ;
				low = Math.max(low, (delta - READ) / span);
				high = Math.min(high, (delta + READ) / span);
			}
		if (!(low < high)) why.push('the largest read runs do not follow one stride');
		else {
			const stride = pickStride(low, high);
			const first = done[0]!.index;
			let origin = -Infinity;
			done.forEach((o, k) => {
				origin = Math.max(origin, largest[k]!.start * READ - (o.index - first) * stride);
			});
			// off the stride's own granules a prediction can fall one granule either way
			const ragged = maxLen - minLen > 1;
			const pad = (stride / READ) % 1 === 0 && (ragged || maxLen === minLen) ? 0 : 1;
			const strided = {
				index: first,
				low: origin - pad * READ,
				stride,
				// runs of unequal length (a compressed stream) share their shortest prefix
				bytes: ((ragged ? minLen : maxLen) + 2 * pad) * READ
			};
			const at = (index: number) =>
				READ * Math.floor((strided.low + (index - strided.index) * strided.stride) / READ);
			const clash = done.some((o, k) => others(k, at(o.index), at(o.index) + strided.bytes));
			if (clash) why.push('another iteration wrote inside the strided window');
			else windows.strided = strided;
		}
	}
	let common = runsOf(done[0]!);
	for (let k = 1; k < done.length; k++) common = intersectRuns(common, runsOf(done[k]!));
	if (windows.strided) {
		const s = windows.strided;
		done.forEach((o) => {
			const low = READ * Math.floor((s.low + (o.index - s.index) * s.stride) / READ);
			common = subtractRange(common, low / READ, (low + s.bytes) / READ);
		});
	}
	let best = -1;
	for (let i = 0; i < common.length; i += 2)
		if (
			common[i + 1]! * READ >= readWindowMinimum.fixed &&
			(best < 0 || common[i + 1]! > common[best + 1]!)
		)
			best = i;
	if (best >= 0) {
		const low = common[best]! * READ;
		const bytes = common[best + 1]! * READ;
		if (done.some((s) => writesTouch(s.written, low, low + bytes)))
			why.push('an iteration wrote inside the fixed window');
		else windows.fixed = { low, bytes };
	}
	if (!windows.strided && !windows.fixed)
		return { reason: why.join('; ') || 'no read window found' };
	return { windows };
}
