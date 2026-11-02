/** The untracked fixed-point sweep over explicit-state chunks, and an instance to run chunks in. */

export const base = 1 << 20;

export interface Job {
	from: number;
	to: number;
	state: number;
}

/** Returns each job's end state, in order. Serial and pooled executors share the engine. */
export type Exec = (jobs: Job[]) => number[];

export type Guess = 'zero' | 'warm';

export interface FixedPoint {
	result: number;
	/** Passes including the warm pre-pass, if any. This is the sweep count. */
	passes: number;
	/** Passes that reran chunks after the first. */
	loopPasses: number;
	chunkRuns: number;
}

const range = (k: number) => Array.from({ length: k }, (_, i) => i);

/**
 * Chunk i starts from an assumed state. Each pass reruns the chunks marked for it; after the pass,
 * every chunk whose assumed start differs from the previous chunk's computed end takes that end
 * and is marked. Stops when a pass marks nothing. Chunk 0 always starts from the real state.
 * `warm` first runs every chunk from zero and starts chunk i from its own zero-run end.
 */
export function fixedPoint(bounds: number[], guess: Guess, exec: Exec): FixedPoint {
	const k = bounds.length - 1;
	const job = (i: number, state: number): Job => ({
		from: bounds[i]!,
		to: bounds[i + 1]!,
		state
	});
	const starts: number[] = new Array(k).fill(0);
	const ends: number[] = new Array(k).fill(0);
	let passes = 0;
	let loopPasses = 0;
	let chunkRuns = 0;
	if (guess === 'warm') {
		const warm = exec(range(k).map((i) => job(i, 0)));
		passes++;
		chunkRuns += k;
		for (let i = 1; i < k; i++) starts[i] = warm[i]!;
	}
	let marked = range(k);
	for (;;) {
		if (loopPasses > k + 2) throw new Error('no fixed point within k + 2 passes');
		const out = exec(marked.map((i) => job(i, starts[i]!)));
		passes++;
		loopPasses++;
		chunkRuns += marked.length;
		marked.forEach((i, j) => (ends[i] = out[j]!));
		marked = [];
		for (let i = 1; i < k; i++) {
			if (starts[i] !== ends[i - 1]) {
				starts[i] = ends[i - 1]!;
				marked.push(i);
			}
		}
		if (!marked.length) break;
	}
	return { result: ends[k - 1]!, passes, loopPasses, chunkRuns };
}

/**
 * The k-way split: boundary i is floor(i * length / k) plus one byte, so the pair and quartet
 * formats do not start aligned at every boundary. sha256c needs 64-byte blocks and gets no shift.
 */
export function bounds(length: number, k: number, subject: string): number[] {
	const shift = subject === 'sha256c' ? 0 : 1;
	return range(k + 1).map((i) =>
		i === 0 ? 0 : i === k ? length : Math.floor((i * length) / k) + shift
	);
}

type Exports = { memory: WebAssembly.Memory } & Record<
	string,
	WebAssembly.ExportValue | ((state: number, ptr: number, len: number) => number)
>;

/** One private instance; the input is copied once at `base` and chunks are read in place. */
export class Instance {
	readonly #run: (state: number, ptr: number, len: number) => number;
	readonly #memory: WebAssembly.Memory;

	constructor(module: WebAssembly.Module, entry: string) {
		const exports = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
		this.#memory = exports.memory;
		this.#run = exports[entry] as (state: number, ptr: number, len: number) => number;
	}

	/** Copies `input` in at `base`, growing memory first. */
	load(input: Uint8Array): void {
		const need = base + input.length;
		const pages = Math.ceil((need - this.#memory.buffer.byteLength) / 65536);
		if (pages > 0) this.#memory.grow(pages);
		new Uint8Array(this.#memory.buffer).set(input, base);
	}

	/** One call over `[from, to)` of the loaded input, from `state`. */
	run(state: number, from: number, to: number): number {
		return this.#run(state | 0, base + from, to - from) >>> 0;
	}
}
