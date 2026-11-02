import {
	foldExact,
	gfApply,
	gfMul,
	mulberry,
	type AffineCheck,
	type AffineRing,
	type ExactHooks
} from './affine.ts';
import { chunkRanges, type FoldChunk } from './fold.ts';
import { serveTasks, type TaskLink, type TaskPool } from './tasks.ts';

/** Where the probe puts the context and the data in the kernel's linear memory. */
export const CONTEXT_ADDRESS = 1 << 19;
export const DATA_ADDRESS = 1 << 20;
const PAGE = 65536;
const MAX_WINDOW = 256;

/** Where the context pointer, the data pointer and the length sit in the entry's parameters. */
export interface ContextLayout {
	entry: string;
	ctx: number;
	ptr: number;
	len: number;
	/** Bytes of the context the probe examines and every task copies. At most 256. */
	window: number;
}

/**
 * What a worker needs to run a context kernel: the module, the parameter layout, the context image
 * the caller initialised, and which bytes of it are state. Every other byte of the image is held at
 * its value in `context`.
 */
export interface ContextSubject {
	module: WebAssembly.Module | Uint8Array;
	layout: ContextLayout;
	context: Uint8Array;
	state: number[];
}

/** One independent part of the state vector, with the ring it is affine over. */
export interface StateFactor {
	ring: AffineRing;
	/** Context offsets of the bytes of this factor, ascending. */
	offsets: number[];
	/** Positions of those bytes in the state vector of the model. */
	slots: number[];
	wordBytes: number;
	endian: 'le' | 'be';
	words: number;
	/** Bits per word. For `gf2` it is the width of the whole factor. */
	bits: number;
	/** `gf2`: the columns of the one-unit bit matrix. `z2w`: the words x words matrix over Z/2^bits. */
	operator: bigint[] | bigint[][];
}

export interface StateCheck extends AffineCheck {
	/** Index of the factor, or -1 for a check on the whole context. */
	factor: number;
	shape: string;
}

/** The recovered model of a state vector that lives in the context. */
export interface StateModel {
	kind: 'state';
	layout: ContextLayout;
	/** The context image the probe ran from. Bytes that are not state stay at these values. */
	context: Uint8Array;
	/** Context offsets of the state: bytes that a call both reads and writes. */
	state: number[];
	/** Bytes a call reads and never writes, and that change the result. Held at `context`. */
	params: number[];
	/** Bytes a call writes and never reads. They are not state and are not carried. */
	scratch: number[];
	factors: StateFactor[];
	align: number;
	checks: StateCheck[];
	calls: number;
}

export interface StateRefusal {
	kind: 'refusal';
	reason: string;
	checks: StateCheck[];
	calls: number;
}

export interface StateProbeOptions {
	/** Seed of the PRNG. The default is fixed. */
	seed?: number;
	/** Trials per check. The default is 32. */
	trials?: number;
	/** Every probed data length is a multiple of this. */
	align?: number;
	/** The context image as the caller's init function left it. The default is zeros. */
	context?: Uint8Array;
	/** Bytes of the context to examine, at most 256. The default is 256. */
	window?: number;
}

export interface StateFoldOptions {
	/** The state vector before the first byte. The default is the state bytes of `model.context`. */
	initial?: Uint8Array;
	chunks?: FoldChunk[];
}

export interface StateFoldResult {
	state: Uint8Array;
	chunks: number;
	tasks: number;
	validated: number;
	mismatchAt: number;
	fallbackBytes: number;
}

type Wasm = (...args: (number | bigint)[]) => number | bigint;

/** One private instance of a context kernel: put and get bytes, call it, count the calls. */
export class ContextKernel {
	readonly #fn: Wasm;
	readonly #memory: WebAssembly.Memory;
	readonly #image: Uint8Array;
	readonly arity: number;
	readonly entry: string;
	calls = 0;

	constructor(module: WebAssembly.Module | Uint8Array, entry: string) {
		this.entry = entry;
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
		this.#image = new Uint8Array(memory.buffer).slice();
		this.arity = fn.length;
	}

	#ensure(end: number): void {
		const have = this.#memory.buffer.byteLength;
		if (have < end) this.#memory.grow(Math.ceil((end - have) / PAGE));
	}

	/** Puts the memory back to what it was after instantiation. */
	restore(): void {
		new Uint8Array(this.#memory.buffer).set(this.#image);
	}

	put(at: number, bytes: Uint8Array): void {
		this.#ensure(at + bytes.length);
		new Uint8Array(this.#memory.buffer, at, bytes.length).set(bytes);
	}

	get(at: number, length: number): Uint8Array {
		return new Uint8Array(this.#memory.buffer, at, length).slice();
	}

	raw(args: (number | bigint)[]): number | bigint {
		this.calls++;
		return this.#fn(...args);
	}

	/** Copies of every byte of memory outside the given ranges, for the hidden state check. */
	outside(ranges: [number, number][]): Uint8Array {
		const all = new Uint8Array(this.#memory.buffer).slice();
		for (const [from, to] of ranges) all.fill(0, from, Math.min(to, all.length));
		return all;
	}

	/**
	 * One call: the context image at the context address, the data at the data address. Returns the
	 * context window afterwards, or undefined when the kernel traps.
	 */
	run(layout: ContextLayout, image: Uint8Array, data: Uint8Array): Uint8Array | undefined {
		this.put(CONTEXT_ADDRESS, image);
		this.put(DATA_ADDRESS, data);
		const args: (number | bigint)[] = [0, 0, 0];
		args[layout.ctx] = CONTEXT_ADDRESS;
		args[layout.ptr] = DATA_ADDRESS;
		args[layout.len] = data.length;
		try {
			this.raw(args);
		} catch (error) {
			if (error instanceof WebAssembly.RuntimeError) return undefined;
			throw error;
		}
		return this.get(CONTEXT_ADDRESS, layout.window);
	}
}

/**
 * The context image after one call of an init function, for a subject whose state starts from
 * something other than zeros. `args` gets the context address; `inputs` is placed at the data
 * address first, for init functions that take a key or an IV.
 */
export function initialContext(
	module: WebAssembly.Module | Uint8Array,
	entry: string,
	args: (ctx: number, data: number) => (number | bigint)[],
	inputs: Uint8Array = new Uint8Array(0),
	window = MAX_WINDOW
): Uint8Array {
	const kernel = new ContextKernel(module, entry);
	kernel.put(DATA_ADDRESS, inputs);
	kernel.raw(args(CONTEXT_ADDRESS, DATA_ADDRESS));
	return kernel.get(CONTEXT_ADDRESS, window);
}

/** A subject whose state is the whole window, for chains with no model. */
export function contextSubject(
	module: WebAssembly.Module | Uint8Array,
	entry: string,
	context: Uint8Array,
	layout: Partial<ContextLayout> = {}
): ContextSubject {
	const window = layout.window ?? context.length;
	const image = new Uint8Array(window);
	image.set(context.subarray(0, window));
	return {
		module,
		layout: { entry, ctx: 0, ptr: 1, len: 2, window, ...layout },
		context: image,
		state: Array.from({ length: window }, (_, i) => i)
	};
}

/** The subject a model describes, for `serveContext`. */
export function modelSubject(
	module: WebAssembly.Module | Uint8Array,
	model: StateModel
): ContextSubject {
	return { module, layout: model.layout, context: model.context, state: model.state };
}

export const pick = (image: Uint8Array, offsets: number[]): Uint8Array =>
	Uint8Array.from(offsets, (o) => image[o]!);

export function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
	return out;
}

export function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
	return out;
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

// #region factor arithmetic

type Operator = bigint[] | bigint[][];

const wordMask = (f: StateFactor) => (1n << BigInt(f.bits)) - 1n;

function toWords(f: StateFactor, bytes: Uint8Array): bigint[] {
	const out: bigint[] = [];
	for (let w = 0; w < f.words; w++) {
		let value = 0n;
		for (let t = 0; t < f.wordBytes; t++) {
			const shift = f.endian === 'le' ? t : f.wordBytes - 1 - t;
			value |= BigInt(bytes[w * f.wordBytes + t]!) << BigInt(8 * shift);
		}
		out.push(value);
	}
	return out;
}

function fromWords(f: StateFactor, words: bigint[]): Uint8Array {
	const out = new Uint8Array(f.words * f.wordBytes);
	for (let w = 0; w < f.words; w++)
		for (let t = 0; t < f.wordBytes; t++) {
			const shift = f.endian === 'le' ? t : f.wordBytes - 1 - t;
			out[w * f.wordBytes + t] = Number((words[w]! >> BigInt(8 * shift)) & 255n);
		}
	return out;
}

const plus = (f: StateFactor, a: bigint[], b: bigint[]): bigint[] =>
	f.ring === 'gf2' ? [a[0]! ^ b[0]!] : a.map((x, i) => (x + b[i]!) & wordMask(f));

const minus = (f: StateFactor, a: bigint[], b: bigint[]): bigint[] =>
	f.ring === 'gf2' ? [a[0]! ^ b[0]!] : a.map((x, i) => BigInt.asUintN(f.bits, x - b[i]!));

function applyOperator(f: StateFactor, op: Operator, v: bigint[]): bigint[] {
	if (f.ring === 'gf2') return [gfApply(op as bigint[], v[0]!)];
	return (op as bigint[][]).map((row) =>
		BigInt.asUintN(
			f.bits,
			row.reduce((sum, m, j) => sum + m * v[j]!, 0n)
		)
	);
}

function identity(f: StateFactor): Operator {
	if (f.ring === 'gf2') return Array.from({ length: f.bits }, (_, k) => 1n << BigInt(k));
	return Array.from({ length: f.words }, (_, i) =>
		Array.from({ length: f.words }, (_, j) => (i === j ? 1n : 0n))
	);
}

function multiply(f: StateFactor, a: Operator, b: Operator): Operator {
	if (f.ring === 'gf2') return gfMul(a as bigint[], b as bigint[]);
	const x = a as bigint[][];
	const y = b as bigint[][];
	return x.map((row) =>
		y[0]!.map((_, j) =>
			BigInt.asUintN(
				f.bits,
				row.reduce((sum, m, l) => sum + m * y[l]![j]!, 0n)
			)
		)
	);
}

interface Power {
	squares: Operator[];
	byUnits: Map<number, Operator>;
}

const powers = new WeakMap<StateFactor, Power>();

/** The operator for `units` align-byte steps, by repeated squaring, cached per length. */
function powerOf(f: StateFactor, units: number): Operator {
	let cache = powers.get(f);
	if (!cache) {
		cache = { squares: [f.operator], byUnits: new Map() };
		powers.set(f, cache);
	}
	const cached = cache.byUnits.get(units);
	if (cached) return cached;
	let result = identity(f);
	for (let n = units, k = 0; n > 0; n = Math.floor(n / 2), k++) {
		if (!cache.squares[k])
			cache.squares[k] = multiply(f, cache.squares[k - 1]!, cache.squares[k - 1]!);
		if (n % 2 === 1) result = multiply(f, cache.squares[k]!, result);
	}
	cache.byUnits.set(units, result);
	return result;
}

/**
 * The state vector after a chunk of `length` bytes from `start`, given `offset`, the state vector
 * after the same chunk from zero: A(length) start + offset, factor by factor. `length` must be a
 * multiple of `model.align`.
 */
export function predictState(
	model: Pick<StateModel, 'factors' | 'align' | 'state'>,
	start: Uint8Array,
	length: number,
	offset: Uint8Array
): Uint8Array {
	if (!Number.isSafeInteger(length) || length < 0 || length % model.align)
		throw new RangeError(`length ${length} is not a multiple of ${model.align}`);
	const out = new Uint8Array(model.state.length);
	for (const f of model.factors) {
		const v = toWords(f, pick(start, f.slots));
		const o = toWords(f, pick(offset, f.slots));
		const next = plus(f, applyOperator(f, powerOf(f, length / model.align), v), o);
		fromWords(f, next).forEach((b, k) => (out[f.slots[k]!] = b));
	}
	return out;
}

// #endregion

class StateTrap extends Error {
	constructor() {
		super('the kernel trapped on a random state value');
	}
}

interface Shape {
	ring: AffineRing;
	wordBytes: number;
	endian: 'le' | 'be';
	words: number;
	label: string;
}

function shapesFor(offsets: number[]): Shape[] {
	const g = offsets.length;
	const shapes: Shape[] = [
		{ ring: 'gf2', wordBytes: g, endian: 'le', words: 1, label: `GF(2)^${8 * g}` }
	];
	const contiguous = offsets.every((o, i) => i === 0 || o === offsets[i - 1]! + 1);
	if (!contiguous) return shapes;
	if (g % 4 === 0)
		shapes.push({
			ring: 'z2w',
			wordBytes: 4,
			endian: 'le',
			words: g / 4,
			label: `(Z/2^32)^${g / 4}`
		});
	if (g <= 32) {
		if (g !== 4)
			shapes.push({
				ring: 'z2w',
				wordBytes: g,
				endian: 'le',
				words: 1,
				label: `Z/2^${8 * g} little endian`
			});
		shapes.push({
			ring: 'z2w',
			wordBytes: g,
			endian: 'be',
			words: 1,
			label: `Z/2^${8 * g} big endian`
		});
	}
	return shapes;
}

/**
 * Probes `entry`, a function (context pointer, data pointer, length) that updates a context struct
 * in place, and decides by trial what its state is and whether the state transition is affine.
 *
 * It finds the parameter order under which the call composes over a split, then, from contexts the
 * function itself produced, flips each of the first `window` context bytes and records which bytes
 * the result depends on. State is the set of bytes a call both reads and writes. A byte that is read
 * and never written is a parameter and stays at its value in `options.context`. State bytes that
 * do not depend on each other form independent factors. Each factor is tested over GF(2) and over
 * Z/2^bits (as one little or big endian integer, or as 32-bit words coupled by a matrix) with the
 * five checks of `probeAffine`, with the other factors set to random bytes in every call, which
 * tests that they do not interact. A factor that is affine in no ring refuses the whole context.
 *
 * A pass is evidence on the sampled inputs only. It cannot see state outside the window, a byte
 * that is read only on rare inputs, or behaviour above the probed lengths. `foldState` in exact
 * mode does not trust the model, but its guarantee needs the state to be complete.
 */
export function probeState(
	module: WebAssembly.Module | Uint8Array,
	entry: string,
	options: StateProbeOptions = {}
): StateModel | StateRefusal {
	const trials = options.trials ?? 32;
	const align = options.align ?? 1;
	const window = options.window ?? MAX_WINDOW;
	if (!Number.isSafeInteger(trials) || trials < 1) throw new RangeError('invalid trial count');
	if (!Number.isSafeInteger(align) || align < 1) throw new RangeError('invalid alignment');
	if (!Number.isSafeInteger(window) || window < 1 || window > MAX_WINDOW)
		throw new RangeError(`the window is 1 to ${MAX_WINDOW} bytes`);
	const template = new Uint8Array(window);
	if (options.context) {
		if (options.context.length > window)
			throw new RangeError('the context is larger than the window');
		template.set(options.context);
	}
	const kernel = new ContextKernel(module, entry);
	const checks: StateCheck[] = [];
	const refuse = (reason: string): StateRefusal => ({
		kind: 'refusal',
		reason,
		checks,
		calls: kernel.calls
	});
	try {
		return probe(kernel, template, checks, refuse, trials, align, options.seed ?? 0x9e3779b9);
	} catch (error) {
		return refuse(`the kernel trapped: ${(error as Error).message}`);
	}
}

function probe(
	kernel: ContextKernel,
	template: Uint8Array,
	checks: StateCheck[],
	refuse: (reason: string) => StateRefusal,
	trials: number,
	align: number,
	seed: number
): StateModel | StateRefusal {
	const window = template.length;
	if (kernel.arity !== 3) return refuse(`expected 3 parameters, found ${kernel.arity}`);
	try {
		kernel.raw([0, 0, 0]);
	} catch (error) {
		if (error instanceof TypeError) return refuse('the parameters are not all i32');
	}
	const rng = mulberry(seed);
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

	// roles: the order of (context, pointer, data length) under which the call composes over a split
	const orders: [number, number, number][] = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0]
	];
	const streaming = (layout: ContextLayout): boolean => {
		try {
			const first = kernel.run(layout, template, bytes(units(64)));
			if (!first || bytesEqual(first, template)) return false;
			for (let i = 0; i < 6; i++) {
				const a = units(100);
				const b = units(100);
				const data = bytes(a + b);
				const whole = kernel.run(layout, template, data);
				const head = kernel.run(layout, template, data.subarray(0, a));
				const split = head && kernel.run(layout, head, data.subarray(a));
				if (!whole || !split) return false;
				// dead bytes (a partial block buffer) may differ, so compare after one more call
				const more = bytes(rounded(130));
				const x = kernel.run(layout, whole, more);
				const y = kernel.run(layout, split, more);
				if (!x || !y || !bytesEqual(x, y)) return false;
			}
			return true;
		} catch {
			return false;
		}
	};
	let layout: ContextLayout | undefined;
	for (const [ctx, ptr, len] of orders) {
		const candidate: ContextLayout = { entry: kernel.entry, ctx, ptr, len, window };
		kernel.restore();
		if (streaming(candidate)) {
			layout = candidate;
			break;
		}
	}
	if (!layout) {
		kernel.restore();
		return refuse('no parameter order is a streaming update over (context, pointer, length)');
	}
	const lay = layout;

	// hidden state: memory outside the context and the data must be the same after two identical calls
	{
		const data = bytes(units(200));
		const ranges: [number, number][] = [
			[CONTEXT_ADDRESS, CONTEXT_ADDRESS + window],
			[DATA_ADDRESS, DATA_ADDRESS + data.length]
		];
		kernel.run(layout, template, data);
		kernel.run(layout, template, data);
		const second = kernel.outside(ranges);
		kernel.run(layout, template, data);
		const third = kernel.outside(ranges);
		if (!bytesEqual(second, third))
			return refuse('memory outside the context changed between two identical calls');
	}

	// discovery: which context bytes a call writes and which bytes the result depends on. The bases
	// are contexts the function produced, plus all zeros and all ones, which carry chains reach.
	const bases: Uint8Array[] = [template];
	for (let i = 1; i < 16; i++) {
		const next = kernel.run(lay, bases[i - 1]!, bytes(units(150)));
		if (next) bases.push(next);
	}
	for (const fill of [0x00, 0xff])
		if (kernel.run(lay, new Uint8Array(window).fill(fill), bytes(align)))
			bases.push(new Uint8Array(window).fill(fill));
	const lengths = [1, 2, 3, 5, 7, 8, 9, 12, 16, 17, 31, 33, 64, 65, 100, 130];
	interface Flip {
		i: number;
		out: Uint8Array;
		after: Uint8Array | undefined;
	}
	const writes = new Set<number>();
	const flips: Flip[] = [];
	bases.forEach((base, b) => {
		const data = bytes(align * lengths[b % lengths.length]!);
		const out = kernel.run(lay, base, data);
		if (!out) return;
		for (let j = 0; j < window; j++) if (base[j] !== out[j]) writes.add(j);
		for (let i = 0; i < window; i++)
			for (const value of [0x00, 0xff, rng() & 255, rng() & 255]) {
				const image = Uint8Array.from(base);
				image[i] = value === base[i] ? value ^ 0x5a : value;
				flips.push({ i, out, after: kernel.run(lay, image, data) });
			}
	});
	const reads = new Set<number>();
	const trapSensitive = new Set<number>();
	const depends = new Map<number, Set<number>>();
	for (const { i, out, after } of flips) {
		if (!after) {
			reads.add(i);
			trapSensitive.add(i);
			continue;
		}
		for (const j of writes) {
			if (j === i ? after[i] === out[i] : after[j] === out[j]) continue;
			reads.add(i);
			if (!depends.has(i)) depends.set(i, new Set());
			depends.get(i)!.add(j);
		}
	}
	const state = [...writes].filter((i) => reads.has(i)).sort((a, b) => a - b);
	const params = [...reads].filter((i) => !writes.has(i)).sort((a, b) => a - b);
	const scratch = [...writes].filter((i) => !reads.has(i)).sort((a, b) => a - b);
	if (!state.length)
		return refuse('no byte of the context is both read and written, so nothing is carried');

	// factors: state bytes that depend on each other, or that trap when changed, share a factor
	const parent = new Map(state.map((i) => [i, i]));
	const find = (i: number): number => (parent.get(i) === i ? i : find(parent.get(i)!));
	const join = (a: number, b: number) => parent.set(find(a), find(b));
	for (const i of state) for (const j of depends.get(i) ?? []) if (parent.has(j)) join(i, j);
	const trapped = state.filter((i) => trapSensitive.has(i));
	for (const i of trapped) join(i, trapped[0]!);
	const groups = new Map<number, number[]>();
	for (const i of state) {
		const root = find(i);
		groups.set(root, [...(groups.get(root) ?? []), i]);
	}
	const sets = [...groups.values()].sort((a, b) => a[0]! - b[0]!);

	// a context with invariants traps on random state values; additivity of valid contexts that
	// share their control bytes (the same call lengths) is the evidence left
	const rejectsRandomState = (): string => {
		for (let i = 0; i < trials; i++) {
			const a = units(130);
			const made = [0, 1, 2].map(() => kernel.run(lay, template, bytes(a)));
			if (made.some((m) => !m)) break;
			const [p, q, r] = made as Uint8Array[];
			const mixed = p!.map((v, k) => v ^ q![k]! ^ r![k]!);
			const x = bytes(units(130));
			const outs = [p!, q!, r!, mixed].map((m) => kernel.run(lay, m, x));
			if (outs.some((o) => !o)) break;
			if (state.some((k) => outs[3]![k] !== (outs[0]![k]! ^ outs[1]![k]! ^ outs[2]![k]!))) {
				checks.push({
					ring: 'gf2',
					name: 'additivity on reachable states',
					trials: i + 1,
					passed: false,
					factor: -1,
					shape: 'reachable'
				});
				return `the context rejects random state values and is not additive over GF(2) on reachable states (failed at trial ${i + 1})`;
			}
		}
		return 'the context rejects random state values, so affinity over the state space cannot be shown';
	};
	const factorize = (): StateFactor[] | StateRefusal => {
		const factors: StateFactor[] = [];
		for (const [index, offsets] of sets.entries()) {
			const g = offsets.length;
			const others = state.filter((i) => !offsets.includes(i));
			const zero = new Uint8Array(g);
			const T = (s: Uint8Array, x: Uint8Array): Uint8Array => {
				const image = Uint8Array.from(template);
				for (const o of others) image[o] = rng() & 255;
				offsets.forEach((o, k) => (image[o] = s[k]!));
				const out = kernel.run(lay, image, x);
				if (!out) throw new StateTrap();
				return pick(out, offsets);
			};
			const failures: string[] = [];
			let found: StateFactor | undefined;
			for (const shape of shapesFor(offsets)) {
				const f: StateFactor = {
					ring: shape.ring,
					offsets,
					slots: offsets.map((o) => state.indexOf(o)),
					wordBytes: shape.wordBytes,
					endian: shape.endian,
					words: shape.words,
					bits: shape.ring === 'gf2' ? 8 * g : 8 * shape.wordBytes,
					operator: []
				};
				const W = (b: Uint8Array) => toWords(f, b);
				const B = (w: bigint[]) => fromWords(f, w);
				const same = (a: bigint[], b: bigint[]) => a.every((v, i) => v === b[i]);
				const run = (name: string, count: number, body: (i: number) => boolean) => {
					for (let i = 0; i < count; i++)
						if (!body(i)) {
							checks.push({
								ring: f.ring,
								name,
								trials: i + 1,
								passed: false,
								factor: index,
								shape: shape.label
							});
							return false;
						}
					checks.push({
						ring: f.ring,
						name,
						trials: count,
						passed: true,
						factor: index,
						shape: shape.label
					});
					return true;
				};
				const rand = () => bytes(g);
				const additive = run('additivity of the state part', trials, () => {
					const x = bytes(units(4096));
					const s1 = rand();
					const s2 = rand();
					const lhs = W(T(B(plus(f, W(s1), W(s2))), x));
					const rhs = minus(f, plus(f, W(T(s1, x)), W(T(s2, x))), W(T(zero, x)));
					return same(lhs, rhs);
				});
				if (!additive) {
					failures.push(`${shape.label}: additivity`);
					continue;
				}
				const ux = bytes(align);
				const base = W(T(zero, ux));
				if (f.ring === 'gf2') {
					f.operator = Array.from(
						{ length: f.bits },
						(_, k) => minus(f, W(T(B([1n << BigInt(k)]), ux)), base)[0]!
					);
				} else {
					const columns = Array.from({ length: f.words }, (_, j) => {
						const e = Array.from({ length: f.words }, (_, i) => (i === j ? 1n : 0n));
						return minus(f, W(T(B(e), ux)), base);
					});
					f.operator = Array.from({ length: f.words }, (_, i) =>
						columns.map((column) => column[i]!)
					);
				}
				const independent = run('data independence of the state part', trials, () => {
					const length = units(4096);
					const x = bytes(length);
					const y = bytes(length);
					const s = rand();
					return same(
						minus(f, W(T(s, x)), W(T(zero, x))),
						minus(f, W(T(s, y)), W(T(zero, y)))
					);
				});
				const homogeneous = (): boolean => {
					let tried = 0;
					for (const length of [1, 2, 7, 64, 1000, 65537].map(rounded)) {
						const x = bytes(length);
						for (let i = 0; i < 4; i++, tried++) {
							const s = rand();
							const want = applyOperator(f, powerOf(f, length / align), W(s));
							if (!same(minus(f, W(T(s, x)), W(T(zero, x))), want)) {
								checks.push({
									ring: f.ring,
									name: 'homogeneity',
									trials: tried + 1,
									passed: false,
									factor: index,
									shape: shape.label
								});
								return false;
							}
						}
					}
					checks.push({
						ring: f.ring,
						name: 'homogeneity',
						trials: tried,
						passed: true,
						factor: index,
						shape: shape.label
					});
					return true;
				};
				const additiveData = () =>
					run('additivity of the data part', trials, () => {
						const a = units(2048);
						const b = units(2048);
						const x = bytes(a + b);
						const whole = W(T(zero, x));
						const head = W(T(zero, x.subarray(0, a)));
						const tail = W(T(zero, x.subarray(a)));
						return same(
							whole,
							plus(f, applyOperator(f, powerOf(f, b / align), head), tail)
						);
					});
				const streamed = () =>
					run('streaming composition', trials, () => {
						const a = units(2048);
						const b = units(2048);
						const x = bytes(a + b);
						const s = rand();
						return same(W(T(s, x)), W(T(T(s, x.subarray(0, a)), x.subarray(a))));
					});
				if (independent && homogeneous() && additiveData() && streamed()) {
					found = f;
					break;
				}
				const failed = checks.filter(
					(c) => c.factor === index && c.shape === shape.label && !c.passed
				)[0]!;
				failures.push(`${shape.label}: ${failed.name}`);
			}
			if (!found)
				return refuse(
					`state bytes ${offsets[0]} to ${offsets[g - 1]} (${g} bytes) are affine in no ring: ${failures.join('; ')}`
				);
			factors.push(found);
		}
		return factors;
	};
	let factors: StateFactor[] | StateRefusal;
	try {
		factors = factorize();
	} catch (error) {
		if (!(error instanceof StateTrap)) throw error;
		return refuse(rejectsRandomState());
	}
	if (!Array.isArray(factors)) return factors;
	return {
		kind: 'state',
		layout,
		context: template,
		state,
		params,
		scratch,
		factors,
		align,
		checks,
		calls: kernel.calls
	};
}

/**
 * Runs on the worker side. Answers `ctx:<hex state>` with the end state bytes, and
 * `ctxrec:<hex state>:<step>` with the state after every `step` bytes, concatenated, the last one
 * being the end state. The context image is rebuilt from `subject.context` for every task.
 */
export function serveContext(link: TaskLink, subject: ContextSubject): void {
	const kernel = new ContextKernel(subject.module, subject.layout.entry);
	const image = (state: Uint8Array) => {
		const out = Uint8Array.from(subject.context);
		subject.state.forEach((o, k) => (out[o] = state[k]!));
		return out;
	};
	const step = (state: Uint8Array, data: Uint8Array) => {
		const out = kernel.run(subject.layout, image(state), data);
		if (!out) throw new Error('the kernel trapped');
		return pick(out, subject.state);
	};
	serveTasks(link, (name, input) => {
		const [task, hex, size] = name.split(':');
		if (!hex || (task !== 'ctx' && task !== 'ctxrec')) throw new Error(`unknown task ${name}`);
		const data = input as Uint8Array;
		let state = fromHex(hex);
		if (task === 'ctx') return step(state, data);
		const each = Number(size);
		if (!Number.isSafeInteger(each) || each < 1) throw new Error(`invalid step in ${name}`);
		const out = new Uint8Array(Math.ceil(data.length / each) * subject.state.length);
		for (let at = 0, k = 0; at < data.length; at += each, k++) {
			state = step(state, data.subarray(at, at + each));
			out.set(state, k * subject.state.length);
		}
		return out;
	});
}

/** The serial reference: one call over all the bytes on a private instance. */
export function stateSerial(
	subject: ContextSubject
): (input: Uint8Array, state?: Uint8Array) => Uint8Array {
	const kernel = new ContextKernel(subject.module, subject.layout.entry);
	return (input, state = pick(subject.context, subject.state)) => {
		const image = Uint8Array.from(subject.context);
		subject.state.forEach((o, k) => (image[o] = state[k]!));
		const out = kernel.run(subject.layout, image, input);
		if (!out) throw new Error('the kernel trapped');
		return pick(out, subject.state);
	};
}

/**
 * `foldAffine` exact mode for a state vector in the context: pass 1 runs every chunk but the last
 * from the zero state, the model turns the offsets into predicted start vectors, pass 2 runs
 * chunks 1 to n-1 from them in workers started with `serveContext`, and each end vector is compared
 * with the next predicted start. All equal: the last end vector is the serial state, by induction,
 * whatever the model got wrong. The first difference hands the rest to one serial task.
 *
 * The result is the state bytes only. Bytes a call writes and does not read (`model.scratch`, and
 * the data a call changes in place) are not returned.
 */
export function foldState(
	pool: TaskPool,
	input: Uint8Array,
	model: StateModel,
	options: StateFoldOptions = {}
): StateFoldResult {
	const initial = options.initial ?? pick(model.context, model.state);
	if (initial.length !== model.state.length) throw new RangeError('invalid initial state length');
	if (!input.length)
		return {
			state: initial,
			chunks: 0,
			tasks: 0,
			validated: 0,
			mismatchAt: -1,
			fallbackBytes: 0
		};
	const chunks = options.chunks ?? chunkRanges(input.length, pool.width, model.align);
	let at = 0;
	chunks.forEach((chunk, index) => {
		if (chunk.start !== at || chunk.end <= chunk.start)
			throw new RangeError(`chunk ${index} is not contiguous`);
		if (index < chunks.length - 1 && chunk.end % model.align !== 0)
			throw new RangeError(
				`chunk ${index} ends at ${chunk.end}, not a multiple of ${model.align}`
			);
		at = chunk.end;
	});
	if (at !== input.length) throw new RangeError(`chunks cover ${at} of ${input.length} bytes`);
	let tasks = 0;
	const submit = (start: string, from: number, to: number) => {
		tasks++;
		return pool.submit(`ctx:${start}`, input.slice(from, to));
	};
	const endOf = (handle: string) => toHex(pool.join(handle).bytes);
	if (chunks.length === 1)
		return {
			state: fromHex(endOf(submit(toHex(initial), 0, input.length))),
			chunks: 1,
			tasks,
			validated: 0,
			mismatchAt: -1,
			fallbackBytes: 0
		};
	const hooks: ExactHooks<string> = {
		zero: toHex(new Uint8Array(model.state.length)),
		submit,
		end: endOf,
		predict: (start, length, offset) =>
			toHex(predictState(model, fromHex(start), length, fromHex(offset))),
		equal: (a, b) => a === b
	};
	const outcome = foldExact(chunks, input.length, toHex(initial), hooks);
	return {
		state: fromHex(outcome.state),
		chunks: chunks.length,
		tasks,
		validated: outcome.validated,
		mismatchAt: outcome.mismatchAt,
		fallbackBytes: outcome.fallbackBytes
	};
}
