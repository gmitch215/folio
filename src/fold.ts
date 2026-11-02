import type { TaskPool, TaskResult } from './tasks.ts';

/** A byte range of the input, one per task. */
export interface FoldChunk {
	start: number;
	end: number;
}

/** Options for `foldChunks`. */
export interface FoldOptions<State> {
	/** Every chunk but the last starts and ends on a multiple of this. The default is 1. */
	align?: number;
	/** Explicit chunk ranges. The default splits the input into `pool.width` aligned chunks. */
	chunks?: FoldChunk[];
	/** Name of the task that runs one chunk. */
	task(chunk: FoldChunk): string;
	/** State before the first chunk. */
	initial: State;
	/** Folds one chunk's joined result into the state. Chunks arrive in order. */
	combine(state: State, part: TaskResult, chunk: FoldChunk): State;
}

const CRC_POLY = 0xedb88320;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ CRC_POLY : c >>> 1;
	return c >>> 0;
});
const crcColumn = (v: number) => ((v >>> 8) ^ CRC_TABLE[v & 0xff]!) >>> 0;
// columns of the GF(2) operator that shifts a CRC register by one zero byte
const CRC_ZERO_BYTE = Array.from({ length: 32 }, (_, k) => crcColumn((1 << k) >>> 0));

function gf2Times(matrix: number[], vector: number): number {
	let out = 0;
	for (let k = 0, v = vector >>> 0; v; k++, v >>>= 1) if (v & 1) out ^= matrix[k]!;
	return out >>> 0;
}

/** CRC-32 of A||B from the CRCs of A and B and the length of B. */
export function crc32Combine(crcA: number, crcB: number, lengthB: number): number {
	if (!Number.isSafeInteger(lengthB) || lengthB < 0) throw new RangeError('invalid length');
	// crc(AB) = M^lengthB crc(A) xor crc(B), with M the one-zero-byte operator
	let vector = crcA >>> 0;
	let matrix = CRC_ZERO_BYTE;
	for (let n = lengthB; n > 0; n = Math.floor(n / 2)) {
		if (n % 2 === 1) vector = gf2Times(matrix, vector);
		matrix = matrix.map((column) => gf2Times(matrix, column));
	}
	return (vector ^ crcB) >>> 0;
}

const ADLER_BASE = 65521;

/** Adler-32 of A||B from the sums of A and B and the length of B. */
export function adler32Combine(adlerA: number, adlerB: number, lengthB: number): number {
	if (!Number.isSafeInteger(lengthB) || lengthB < 0) throw new RangeError('invalid length');
	const s1a = adlerA & 0xffff;
	const s2a = adlerA >>> 16;
	const s1b = adlerB & 0xffff;
	const s2b = adlerB >>> 16;
	const s1 = (s1a + s1b + ADLER_BASE - 1) % ADLER_BASE;
	const s2 =
		(s2a +
			s2b +
			(((lengthB % ADLER_BASE) * ((s1a + ADLER_BASE - 1) % ADLER_BASE)) % ADLER_BASE)) %
		ADLER_BASE;
	return ((s2 << 16) | s1) >>> 0;
}

/** The 16-byte big-endian AES-CTR counter after `blocks` blocks, carrying through every byte. */
export function ctrAdvance(counter: Uint8Array, blocks: number): Uint8Array {
	if (counter.length !== 16) throw new RangeError('counter must be 16 bytes');
	if (!Number.isSafeInteger(blocks) || blocks < 0) throw new RangeError('invalid block count');
	const out = Uint8Array.from(counter);
	let carry = blocks;
	for (let i = 15; i >= 0 && carry > 0; i--) {
		const sum = out[i]! + (carry % 256);
		out[i] = sum % 256;
		carry = Math.floor(carry / 256) + Math.floor(sum / 256);
	}
	return out;
}

/** Splits `length` bytes into at most `count` ranges; all but the last are multiples of `align`. */
export function chunkRanges(length: number, count: number, align = 1): FoldChunk[] {
	if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('invalid length');
	if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('invalid chunk count');
	if (!Number.isSafeInteger(align) || align < 1) throw new RangeError('invalid alignment');
	const step = Math.max(align, Math.ceil(length / count / align) * align);
	const chunks: FoldChunk[] = [];
	for (let start = 0; start < length; start += step)
		chunks.push({ start, end: Math.min(length, start + step) });
	return chunks;
}

function checkChunks(chunks: FoldChunk[], length: number, align: number): void {
	let at = 0;
	chunks.forEach((chunk, index) => {
		if (chunk.start !== at || chunk.end <= chunk.start)
			throw new RangeError(`chunk ${index} is not contiguous`);
		const last = index === chunks.length - 1;
		if (!last && chunk.end % align !== 0)
			throw new RangeError(`chunk ${index} ends at ${chunk.end}, not a multiple of ${align}`);
		at = chunk.end;
	});
	if (at !== length) throw new RangeError(`chunks cover ${at} of ${length} bytes`);
}

/**
 * Runs one task per chunk on `pool` and folds the results in order. The input is copied into each
 * task (see `TaskPool.submit`), so the state is built from copies, not from the input buffer.
 */
export function foldChunks<State>(
	pool: TaskPool,
	input: Uint8Array,
	options: FoldOptions<State>
): State {
	const align = options.align ?? 1;
	const chunks = options.chunks ?? chunkRanges(input.length, pool.width, align);
	if (input.length) checkChunks(chunks, input.length, align);
	const handles = chunks.map((chunk) =>
		pool.submit(options.task(chunk), input.slice(chunk.start, chunk.end))
	);
	let state = options.initial;
	chunks.forEach((chunk, index) => {
		state = options.combine(state, pool.join(handles[index]!), chunk);
	});
	return state;
}
