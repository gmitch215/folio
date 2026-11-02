import { chunkRanges, type FoldChunk } from './fold.ts';
import { serveTasks, type TaskLink, type TaskPool, type TaskResult } from './tasks.ts';

/** `gf2` is affine over GF(2)^bits (xor), `z2w` is affine over Z/2^bits (add, multiply). */
export type AffineRing = 'gf2' | 'z2w';

/** Where the state, the pointer and the length sit in the entry's parameter list. */
export interface AffineLayout {
	entry: string;
	state: number;
	ptr: number;
	len: number;
	bits: 32 | 64;
}

/** One check the probe ran. `trials` counts the trials run, which is fewer than asked on a failure. */
export interface AffineCheck {
	ring: AffineRing;
	name: string;
	trials: number;
	passed: boolean;
}

/**
 * The recovered model: T(s, x) = A(|x|) s + T(0, x) over `ring`, with A(|x|) the `align`-byte
 * operator raised to the power |x| / align. `operator` is the columns of that operator over GF(2),
 * or its multiplier over Z/2^bits.
 */
export interface AffineModel {
	kind: 'model';
	ring: AffineRing;
	bits: 32 | 64;
	align: number;
	layout: AffineLayout;
	operator: bigint[] | bigint;
	checks: AffineCheck[];
	calls: number;
}

/** The probe found no affine structure, or no streaming shape. `reason` names the check. */
export interface AffineRefusal {
	kind: 'refusal';
	reason: string;
	checks: AffineCheck[];
	calls: number;
}

export interface AffineProbeOptions {
	/** Seed of the PRNG that draws states and data. The default is fixed. */
	seed?: number;
	/** Trials per check. The default is 32. */
	trials?: number;
	/** Every probed length is a multiple of this, for kernels that take whole blocks. */
	align?: number;
}

export interface AffineSubject {
	module: WebAssembly.Module | Uint8Array;
	layout: AffineLayout;
}

export interface AffineFoldOptions {
	/** `exact` validates every boundary. `audit` reruns a sample of chunks. The default is `exact`. */
	mode?: 'exact' | 'audit';
	/** State before the first byte. The default is 0. */
	initial?: bigint;
	/** Explicit chunk ranges. The default splits the input into `pool.width` aligned chunks. */
	chunks?: FoldChunk[];
	/** Audit mode: chunks to rerun from their predicted start. The default is 2. */
	audit?: number;
	/** Audit mode: seed of the sample. The default is 1. */
	seed?: number;
}

export interface AffineFoldResult {
	mode: 'exact' | 'audit';
	state: bigint;
	chunks: number;
	tasks: number;
	/** Chunk boundaries where the real end state equalled the predicted start of the next chunk. */
	validated: number;
	/** The first chunk whose real end state differed from the prediction, or -1. */
	mismatchAt: number;
	/** Audit mode: the chunks that were rerun. */
	audited: number[];
	/** Bytes that ran again serially after a mismatch. */
	fallbackBytes: number;
}

/** The task name `serveAffine` answers: `affine:<start state in hex>`. */
export const AFFINE_TASK = 'affine';

const DATA = 1 << 20;
const PAGE = 65536;

type Wasm = (...args: (number | bigint)[]) => number | bigint;

export const mask = (bits: number) => (1n << BigInt(bits)) - 1n;

export function mulberry(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
}

/** One private instance of the kernel, the memory it exports and a count of calls into it. */
class Kernel {
	readonly #fn: Wasm;
	readonly #memory: WebAssembly.Memory;
	readonly arity: number;
	layout: AffineLayout = { entry: '', state: 0, ptr: 1, len: 2, bits: 32 };
	calls = 0;

	constructor(module: WebAssembly.Module | Uint8Array, entry: string) {
		const compiled =
			module instanceof WebAssembly.Module
				? module
				: new WebAssembly.Module(module as Uint8Array<ArrayBuffer>);
		if (WebAssembly.Module.imports(compiled).length)
			throw new Error('the kernel imports something; only freestanding modules are probed');
		const exports = new WebAssembly.Instance(compiled, {}).exports;
		const fn = exports[entry];
		const memory = exports.memory;
		if (typeof fn !== 'function') throw new Error(`no function export ${entry}`);
		if (!(memory instanceof WebAssembly.Memory))
			throw new Error('the kernel exports no memory');
		this.#fn = fn as Wasm;
		this.#memory = memory;
		this.arity = fn.length;
		this.layout.entry = entry;
	}

	#ensure(end: number): void {
		const have = this.#memory.buffer.byteLength;
		if (have < end) this.#memory.grow(Math.ceil((end - have) / PAGE));
	}

	place(at: number, bytes: Uint8Array): void {
		this.#ensure(at + bytes.length);
		new Uint8Array(this.#memory.buffer, at, bytes.length).set(bytes);
	}

	/** The raw call: every argument is passed as given. */
	raw(args: (number | bigint)[]): number | bigint {
		this.calls++;
		return this.#fn(...args);
	}

	call(state: bigint, ptr: number, len: number, layout = this.layout): bigint {
		const args: (number | bigint)[] = [0, 0, 0];
		args[layout.state] =
			layout.bits === 32 ? Number(BigInt.asIntN(32, state)) : BigInt.asIntN(64, state);
		args[layout.ptr] = ptr;
		args[layout.len] = len;
		return BigInt.asUintN(layout.bits, BigInt(this.raw(args)));
	}

	run(state: bigint, input: Uint8Array): bigint {
		this.place(DATA, input);
		return this.call(state, DATA, input.length);
	}
}

// #region gf2 and z2w arithmetic

export function gfApply(columns: bigint[], vector: bigint): bigint {
	let out = 0n;
	for (let k = 0; vector; k++, vector >>= 1n) if (vector & 1n) out ^= columns[k]!;
	return out;
}

export const gfMul = (a: bigint[], b: bigint[]) => b.map((column) => gfApply(a, column));

interface Powers {
	squares: bigint[][];
	byUnits: Map<number, bigint[]>;
	byMultiplier: Map<number, bigint>;
}

const powers = new WeakMap<AffineModel, Powers>();

function powersOf(model: AffineModel): Powers {
	let found = powers.get(model);
	if (!found) {
		found = { squares: [], byUnits: new Map(), byMultiplier: new Map() };
		if (model.ring === 'gf2') found.squares.push(model.operator as bigint[]);
		powers.set(model, found);
	}
	return found;
}

function matrixPower(model: AffineModel, units: number): bigint[] {
	const cache = powersOf(model);
	const cached = cache.byUnits.get(units);
	if (cached) return cached;
	let result = Array.from({ length: model.bits }, (_, k) => 1n << BigInt(k));
	for (let n = units, k = 0; n > 0; n = Math.floor(n / 2), k++) {
		if (!cache.squares[k])
			cache.squares[k] = gfMul(cache.squares[k - 1]!, cache.squares[k - 1]!);
		if (n % 2 === 1) result = gfMul(cache.squares[k]!, result);
	}
	cache.byUnits.set(units, result);
	return result;
}

function multiplierPower(model: AffineModel, units: number): bigint {
	const cache = powersOf(model);
	const cached = cache.byMultiplier.get(units);
	if (cached !== undefined) return cached;
	const modulus = 1n << BigInt(model.bits);
	let result = 1n;
	let base = model.operator as bigint;
	for (let n = units; n > 0; n = Math.floor(n / 2)) {
		if (n % 2 === 1) result = (result * base) % modulus;
		base = (base * base) % modulus;
	}
	cache.byMultiplier.set(units, result);
	return result;
}

/**
 * The state-dependent part of T(state, x) for a chunk of `length` bytes: A(length) state. The
 * operator comes from repeated squaring and is cached per length. `length` must be a multiple of
 * `model.align`.
 */
export function advance(model: AffineModel, state: bigint, length: number): bigint {
	if (!Number.isSafeInteger(length) || length < 0 || length % model.align)
		throw new RangeError(`length ${length} is not a multiple of ${model.align}`);
	const units = length / model.align;
	if (model.ring === 'gf2') return gfApply(matrixPower(model, units), state);
	return (multiplierPower(model, units) * state) & mask(model.bits);
}

/** T(start, x) predicted from `offset` = T(0, x): A(length) start combined with the offset. */
export function predictEnd(
	model: AffineModel,
	start: bigint,
	length: number,
	offset: bigint
): bigint {
	const moved = advance(model, start, length);
	return model.ring === 'gf2' ? moved ^ offset : (moved + offset) & mask(model.bits);
}

// #endregion

/**
 * Probes `entry`, a function (state, pointer, length) -> state, in a private instance of `module`
 * and decides by trial whether its state transition is affine over GF(2)^bits or over Z/2^bits.
 * It recovers the parameter roles, checks affinity, data independence, homogeneity (the operator
 * for L bytes is the L-th power of the one-unit operator), additivity and streaming composition,
 * and returns the model or the check that failed. Every call into the kernel is counted.
 * A pass is evidence on the sampled inputs only; `foldAffine` in `exact` mode is what makes the
 * result independent of the probe.
 */
export function probeAffine(
	module: WebAssembly.Module | Uint8Array,
	entry: string,
	options: AffineProbeOptions = {}
): AffineModel | AffineRefusal {
	const trials = options.trials ?? 32;
	const align = options.align ?? 1;
	if (!Number.isSafeInteger(trials) || trials < 1) throw new RangeError('invalid trial count');
	if (!Number.isSafeInteger(align) || align < 1) throw new RangeError('invalid alignment');
	const kernel = new Kernel(module, entry);
	const checks: AffineCheck[] = [];
	const refuse = (reason: string): AffineRefusal => ({
		kind: 'refusal',
		reason,
		checks,
		calls: kernel.calls
	});
	try {
		return probe(kernel, checks, refuse, trials, align, options.seed ?? 0x9e3779b9);
	} catch (error) {
		return refuse(`the kernel trapped: ${(error as Error).message}`);
	}
}

function probe(
	kernel: Kernel,
	checks: AffineCheck[],
	refuse: (reason: string) => AffineRefusal,
	trials: number,
	align: number,
	seed: number
): AffineModel | AffineRefusal {
	if (kernel.arity !== 3) return refuse(`expected 3 parameters, found ${kernel.arity}`);
	const rng = mulberry(seed);
	const word = (bits: number) =>
		bits === 32 ? BigInt(rng()) : (BigInt(rng()) << 32n) | BigInt(rng());
	const bytes = (length: number) => {
		const out = new Uint8Array(length);
		for (let i = 0; i < length; i += 4) {
			const value = rng();
			for (let k = 0; k < 4 && i + k < length; k++) out[i + k] = (value >>> (8 * k)) & 255;
		}
		return out;
	};
	const units = (most: number) => align * (1 + (rng() % Math.max(1, Math.floor(most / align))));
	const rounded = (length: number) => Math.ceil(length / align) * align;

	// parameter types: the combination of numbers and bigints the engine accepts for zeros
	let types: ('i32' | 'i64')[] | undefined;
	let result: 'i32' | 'i64' = 'i32';
	for (let pattern = 0; pattern < 8 && !types; pattern++) {
		const kinds = [0, 1, 2].map((k) => ((pattern >> k) & 1 ? 'i64' : 'i32') as 'i32' | 'i64');
		try {
			const value = kernel.raw(kinds.map((kind) => (kind === 'i64' ? 0n : 0)));
			types = kinds;
			result = typeof value === 'bigint' ? 'i64' : 'i32';
		} catch (error) {
			if (!(error instanceof TypeError)) {
				types = kinds;
				result = 'i32';
			}
		}
	}
	if (!types) return refuse('no combination of i32 and i64 parameters was accepted');
	const bits = result === 'i64' ? 64 : 32;

	// roles: the order of (state, pointer, length) under which the kernel composes over a split
	const orders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0]
	];
	let layout: AffineLayout | undefined;
	for (const [state, ptr, len] of orders as [number, number, number][]) {
		if (types[state] !== result || types[ptr] !== 'i32' || types[len] !== 'i32') continue;
		const candidate: AffineLayout = { entry: kernel.layout.entry, state, ptr, len, bits };
		const T = (s: bigint, at: number, length: number) => kernel.call(s, at, length, candidate);
		try {
			const sample = bytes(rounded(256));
			kernel.place(DATA, sample);
			const probeLength = units(16);
			if (T(0n, DATA, probeLength) === T(word(bits) | 1n, DATA, probeLength)) continue;
			const other = Uint8Array.from(sample);
			other[0] = other[0]! ^ 0x55;
			kernel.place(DATA + 4096, other);
			if (T(0n, DATA, probeLength) === T(0n, DATA + 4096, probeLength)) continue;
			let composes = true;
			for (let i = 0; i < 6 && composes; i++) {
				const s = word(bits);
				const a = units(100);
				const b = units(100);
				composes = T(s, DATA, a + b) === T(T(s, DATA, a), DATA + a, b);
			}
			if (!composes) continue;
		} catch {
			continue;
		}
		layout = candidate;
		break;
	}
	if (!layout)
		return refuse('no parameter order is a streaming update over (state, pointer, length)');
	kernel.layout = layout;
	const T = (s: bigint, at: number, length: number) => kernel.call(s, at, length);

	const ringOps = (ring: AffineRing) => {
		const modulus = 1n << BigInt(bits);
		return ring === 'gf2'
			? { plus: (a: bigint, b: bigint) => a ^ b, minus: (a: bigint, b: bigint) => a ^ b }
			: {
					plus: (a: bigint, b: bigint) => (a + b) % modulus,
					minus: (a: bigint, b: bigint) => (a - b + modulus) % modulus
				};
	};

	const run = (ring: AffineRing, name: string, count: number, body: (i: number) => boolean) => {
		for (let i = 0; i < count; i++)
			if (!body(i)) {
				checks.push({ ring, name, trials: i + 1, passed: false });
				return false;
			}
		checks.push({ ring, name, trials: count, passed: true });
		return true;
	};

	const failures: string[] = [];
	for (const ring of ['gf2', 'z2w'] as AffineRing[]) {
		const { plus, minus } = ringOps(ring);
		const additive = run(ring, 'additivity of the state part', trials, () => {
			const length = units(4096);
			kernel.place(DATA, bytes(length));
			const s1 = word(bits);
			const s2 = word(bits);
			const zero = T(0n, DATA, length);
			const lhs = T(plus(s1, s2), DATA, length);
			return lhs === minus(plus(T(s1, DATA, length), T(s2, DATA, length)), zero);
		});
		if (!additive) {
			failures.push(`${ring} additivity`);
			continue;
		}

		// the align-byte operator: columns T(e_k, x) - T(0, x) over GF(2), T(1, x) - T(0, x) over Z
		const unitData = bytes(align);
		kernel.place(DATA, unitData);
		const zeroUnit = T(0n, DATA, align);
		const operator =
			ring === 'gf2'
				? Array.from({ length: bits }, (_, k) =>
						minus(T(1n << BigInt(k), DATA, align), zeroUnit)
					)
				: minus(T(1n, DATA, align), zeroUnit);
		const model: AffineModel = {
			kind: 'model',
			ring,
			bits,
			align,
			layout,
			operator,
			checks,
			calls: 0
		};
		const A = (s: bigint, length: number) => advance(model, s, length);

		const independent = run(ring, 'data independence of the state part', trials, () => {
			const length = units(4096);
			const x = bytes(length);
			const y = bytes(length);
			const s = word(bits);
			kernel.place(DATA, x);
			const fromX = minus(T(s, DATA, length), T(0n, DATA, length));
			kernel.place(DATA, y);
			return fromX === minus(T(s, DATA, length), T(0n, DATA, length));
		});
		const homogeneous = (): boolean => {
			const lengths = [1, 2, 7, 64, 1000, 65537].map(rounded);
			let tried = 0;
			for (const length of lengths) {
				kernel.place(DATA, bytes(length));
				for (let i = 0; i < 4; i++, tried++) {
					const s = word(bits);
					if (minus(T(s, DATA, length), T(0n, DATA, length)) !== A(s, length)) {
						checks.push({
							ring,
							name: 'homogeneity',
							trials: tried + 1,
							passed: false
						});
						return false;
					}
				}
			}
			checks.push({ ring, name: 'homogeneity', trials: tried, passed: true });
			return true;
		};
		const additiveData = () =>
			run(ring, 'additivity of the data part', trials, () => {
				const a = units(2048);
				const b = units(2048);
				kernel.place(DATA, bytes(a + b));
				const whole = T(0n, DATA, a + b);
				return whole === plus(A(T(0n, DATA, a), b), T(0n, DATA + a, b));
			});
		const streaming = () =>
			run(ring, 'streaming composition', trials, () => {
				const a = units(2048);
				const b = units(2048);
				kernel.place(DATA, bytes(a + b));
				const s = word(bits);
				return T(s, DATA, a + b) === T(T(s, DATA, a), DATA + a, b);
			});
		if (independent && homogeneous() && additiveData() && streaming()) {
			model.calls = kernel.calls;
			return model;
		}
		const failed = checks.filter((c) => c.ring === ring && !c.passed)[0]!;
		return refuse(`${ring} passed additivity and failed ${failed.name}`);
	}
	return refuse(`not affine over either ring: failed ${failures.join(' and ')}`);
}

/**
 * Runs on the worker side. Instantiates the kernel privately and answers `affine:<hex state>`
 * tasks: the input is the chunk, the output is the 8-byte little-endian end state.
 */
export function serveAffine(link: TaskLink, subject: AffineSubject): void {
	const kernel = new Kernel(subject.module, subject.layout.entry);
	kernel.layout = subject.layout;
	serveTasks(link, (name, input) => {
		const [task, hex] = name.split(':');
		if (task !== AFFINE_TASK || !hex) throw new Error(`unknown task ${name}`);
		const end = kernel.run(BigInt(`0x${hex}`), input as Uint8Array);
		const out = new Uint8Array(8);
		new DataView(out.buffer).setBigUint64(0, end, true);
		return out;
	});
}

/** The serial reference: one call over all the bytes in a private instance. */
export function affineSerial(
	subject: AffineSubject
): (input: Uint8Array, state?: bigint) => bigint {
	const kernel = new Kernel(subject.module, subject.layout.entry);
	kernel.layout = subject.layout;
	return (input, state = 0n) => kernel.run(BigInt.asUintN(subject.layout.bits, state), input);
}

function checkRanges(chunks: FoldChunk[], length: number, align: number): void {
	let at = 0;
	chunks.forEach((chunk, index) => {
		if (chunk.start !== at || chunk.end <= chunk.start)
			throw new RangeError(`chunk ${index} is not contiguous`);
		if (index < chunks.length - 1 && chunk.end % align !== 0)
			throw new RangeError(`chunk ${index} ends at ${chunk.end}, not a multiple of ${align}`);
		at = chunk.end;
	});
	if (at !== length) throw new RangeError(`chunks cover ${at} of ${length} bytes`);
}

/** What `foldExact` needs from a state representation. */
export interface ExactHooks<State> {
	/** The state every chunk but the first starts from in pass 1. */
	zero: State;
	/** Starts the task that runs bytes [from, to) from `start`, returns its handle. */
	submit(start: State, from: number, to: number): string;
	/** Joins a task and decodes its end state. */
	end(handle: string): State;
	/** The end state of a chunk of `length` bytes from `start`, given its end state from zero. */
	predict(start: State, length: number, offset: State): State;
	equal(a: State, b: State): boolean;
}

export interface ExactOutcome<State> {
	state: State;
	validated: number;
	mismatchAt: number;
	fallbackBytes: number;
}

/**
 * The two pass exact fold over at least two chunks. The result is the serial state by induction:
 * every pass 2 chunk ran from the start state its predecessor's end state is compared with. The
 * first disagreement hands the rest of the input to one serial task.
 */
export function foldExact<State>(
	chunks: FoldChunk[],
	length: number,
	initial: State,
	hooks: ExactHooks<State>
): ExactOutcome<State> {
	const n = chunks.length;
	const size = (chunk: FoldChunk) => chunk.end - chunk.start;
	const first = Array.from({ length: n - 1 }, (_, i) =>
		hooks.submit(i === 0 ? initial : hooks.zero, chunks[i]!.start, chunks[i]!.end)
	);
	const predicted: State[] = [initial];
	const second: string[] = [''];
	for (let i = 0; i < n - 1; i++) {
		const offset = hooks.end(first[i]!);
		predicted[i + 1] =
			i === 0 ? offset : hooks.predict(predicted[i]!, size(chunks[i]!), offset);
		second[i + 1] = hooks.submit(predicted[i + 1]!, chunks[i + 1]!.start, chunks[i + 1]!.end);
	}
	const ends = second.map((handle, i) => (i ? hooks.end(handle) : hooks.zero));
	for (let i = 1; i < n; i++) {
		if (i === n - 1)
			return { state: ends[i]!, validated: n - 1, mismatchAt: -1, fallbackBytes: 0 };
		if (!hooks.equal(ends[i]!, predicted[i + 1]!)) {
			const rest = chunks[i + 1]!.start;
			const state = hooks.end(hooks.submit(ends[i]!, rest, length));
			return { state, validated: i, mismatchAt: i, fallbackBytes: length - rest };
		}
	}
	throw new Error('unreachable');
}

/**
 * Folds `input` through the kernel on `pool` workers started with `serveAffine`, and returns the
 * state the serial call over the same bytes returns.
 *
 * `exact`: pass 1 runs every chunk but the last from state zero (the first from `initial`); the
 * model turns the offsets into each chunk's predicted start; pass 2 runs chunks 1 to n-1 from
 * their predicted starts; an ordered check compares each chunk's real end state with the next
 * chunk's predicted start. If all agree, the final state is the serial one by induction, whatever
 * the model got wrong. At the first disagreement the rest of the input runs serially from the
 * last real state. This equals the serial call when the kernel composes over a split
 * (T(s, x||y) = T(T(s, x), y)), which the probe checks on samples and nothing here proves.
 *
 * `audit`: one pass from state zero, the model combines the offsets, and `audit` chunks run again
 * from their predicted starts. A disagreement reruns the whole input serially. A chunk that is not
 * sampled is trusted: the model's error in it goes undetected.
 */
export function foldAffine(
	pool: TaskPool,
	input: Uint8Array,
	model: AffineModel,
	options: AffineFoldOptions = {}
): AffineFoldResult {
	const mode = options.mode ?? 'exact';
	if (mode !== 'exact' && mode !== 'audit') throw new RangeError('invalid mode');
	const initial = BigInt.asUintN(model.bits, options.initial ?? 0n);
	const result = (
		state: bigint,
		extra: Partial<AffineFoldResult> & { tasks: number; chunks: number }
	): AffineFoldResult => ({
		mode,
		state,
		validated: 0,
		mismatchAt: -1,
		audited: [],
		fallbackBytes: 0,
		...extra
	});
	if (!input.length) return result(initial, { tasks: 0, chunks: 0 });
	const chunks = options.chunks ?? chunkRanges(input.length, pool.width, model.align);
	checkRanges(chunks, input.length, model.align);
	const n = chunks.length;
	const size = (chunk: FoldChunk) => chunk.end - chunk.start;
	let tasks = 0;
	const submit = (start: bigint, from: number, to: number) => {
		tasks++;
		return pool.submit(`${AFFINE_TASK}:${start.toString(16)}`, input.slice(from, to));
	};
	const endOf = (handle: string) => {
		const part: TaskResult = pool.join(handle);
		return (
			new DataView(part.bytes.buffer, part.bytes.byteOffset).getBigUint64(0, true) &
			mask(model.bits)
		);
	};
	const serial = (start: bigint, from: number) => endOf(submit(start, from, input.length));

	if (n === 1) return result(serial(initial, 0), { tasks, chunks: n });

	if (mode === 'exact') {
		const outcome = foldExact(chunks, input.length, initial, {
			zero: 0n,
			submit: (start, from, to) => submit(start, from, to),
			end: endOf,
			predict: (start, length, offset) => predictEnd(model, start, length, offset),
			equal: (a, b) => a === b
		});
		return result(outcome.state, {
			tasks,
			chunks: n,
			validated: outcome.validated,
			mismatchAt: outcome.mismatchAt,
			fallbackBytes: outcome.fallbackBytes
		});
	}

	const first = chunks.map((chunk, i) => submit(i === 0 ? initial : 0n, chunk.start, chunk.end));
	const predicted: bigint[] = [initial];
	chunks.forEach((chunk, i) => {
		const offset = endOf(first[i]!);
		if (i === n - 1 && size(chunk) % model.align)
			throw new RangeError(
				'audit mode needs a last chunk that is a multiple of the alignment'
			);
		predicted[i + 1] = i === 0 ? offset : predictEnd(model, predicted[i]!, size(chunk), offset);
	});
	const count = Math.min(options.audit ?? 2, n - 1);
	const rng = mulberry(options.seed ?? 1);
	const order = Array.from({ length: n - 1 }, (_, i) => i + 1);
	for (let i = order.length - 1; i > 0; i--) {
		const j = rng() % (i + 1);
		[order[i], order[j]] = [order[j]!, order[i]!];
	}
	const audited = order.slice(0, count).sort((a, b) => a - b);
	const reruns = audited.map((i) => submit(predicted[i]!, chunks[i]!.start, chunks[i]!.end));
	let mismatchAt = -1;
	audited.forEach((i, k) => {
		const end = endOf(reruns[k]!);
		if (end !== predicted[i + 1] && mismatchAt < 0) mismatchAt = i;
	});
	if (mismatchAt < 0)
		return result(predicted[n]!, { tasks, chunks: n, audited, validated: audited.length });
	return result(serial(initial, 0), {
		tasks,
		chunks: n,
		audited,
		mismatchAt,
		fallbackBytes: input.length
	});
}
