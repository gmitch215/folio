import { iterationSummaryShift, iterationSummaryWords } from './iteration-layout.ts';

/** Words a scan visited and words it found non-zero, summed over the calls that were given it. */
export interface ReadScanStats {
	words: number;
	set: number;
}

// one scan at a time per thread; the run being built lives here so the word loop stays flat
let start = -1;
let at = 0;
let runs: number[] = [];
let visited = 0;
let found = 0;

function visit(words: Uint32Array, from: number, to: number) {
	if (start >= 0 && at !== from) {
		runs.push(start, at * 32 - start);
		start = -1;
	}
	visited += to - from;
	for (let k = from; k < to; k++) {
		const w = words[k]!;
		if (w === 0) {
			if (start >= 0) {
				runs.push(start, k * 32 - start);
				start = -1;
			}
			continue;
		}
		words[k] = 0;
		found++;
		if (w === 0xffffffff) {
			if (start < 0) start = k * 32;
			continue;
		}
		for (let b = 0; b < 32; b++) {
			if ((w >>> b) & 1) {
				if (start < 0) start = k * 32 + b;
			} else if (start >= 0) {
				runs.push(start, k * 32 + b - start);
				start = -1;
			}
		}
	}
	at = to;
}

/**
 * Reads a read bitmap into `[start, length]` runs of granules and zeroes the words it reads. With
 * a summary only the blocks of 64 words whose byte is non-zero are read, and every summary byte is
 * zeroed; the summary must be a superset of the non-zero blocks (see `lowerInline`). Without one
 * every word is read. The summary length is a multiple of 4.
 */
export function scanReads(
	words: Uint32Array,
	summary?: Uint8Array,
	stats?: ReadScanStats
): Int32Array {
	start = -1;
	at = 0;
	runs = [];
	visited = 0;
	found = 0;
	if (!summary) visit(words, 0, words.length);
	else {
		const blocks = Math.ceil(words.length / iterationSummaryWords);
		const wide = new Uint32Array(summary.buffer, summary.byteOffset, summary.length >> 2);
		for (let i = 0; i < wide.length; i++) {
			if (wide[i] === 0) continue;
			for (let b = 4 * i; b < 4 * i + 4; b++) {
				if (!summary[b]) continue;
				summary[b] = 0;
				if (b < blocks)
					visit(
						words,
						b * iterationSummaryWords,
						Math.min(words.length, (b + 1) * iterationSummaryWords)
					);
			}
		}
	}
	if (start >= 0) runs.push(start, at * 32 - start);
	if (stats) {
		stats.words += visited;
		stats.set += found;
	}
	const out = Int32Array.from(runs);
	runs = [];
	return out;
}

/**
 * Sets the summary bytes of the blocks that the address range `[low, low + bytes)` touches, in the
 * summary of `mask + 1` bytes at `base`. A window the owner marks in the read bitmap itself is
 * summarized the same way.
 */
export function markReadSummary(
	u8: Uint8Array,
	base: number,
	mask: number,
	low: number,
	bytes: number
): void {
	if (bytes <= 0) return;
	const first = Math.floor(low / 2 ** iterationSummaryShift);
	const last = Math.floor((low + bytes - 1) / 2 ** iterationSummaryShift);
	for (let b = first; b <= last; b++) u8[base + (b & mask)] = 1;
}
