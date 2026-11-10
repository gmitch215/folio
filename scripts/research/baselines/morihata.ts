// reimplementation of the inference in Morihata and Sato, PLDI 2021 (read in full text), on a Wasm stream entry
// scope: one reduction variable (the state word), the semirings of the paper's prototype except (max, x),
// no loop decomposition, no nested loops, no array index inference

export type SemiringName = 'add-mul' | 'max-add' | 'max-min' | 'min-max' | 'or-and' | 'and-or';

export interface Semiring {
	name: SemiringName;
	signed: boolean;
	method: 'inverse' | 'lattice' | 'multiplicative';
	zero: bigint;
	one: bigint;
	add(a: bigint, b: bigint): bigint;
	mul(a: bigint, b: bigint): bigint;
	sample(next: () => number): bigint;
	z?: bigint;
	zinv?: bigint;
}

const INF = 1n << 30n;
const Z = 1n << 28n;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const small = (next: () => number) => BigInt(next() % 2049) - 1024n;

export const semirings: Semiring[] = [
	{
		name: 'add-mul',
		signed: false,
		method: 'inverse',
		zero: 0n,
		one: 1n,
		add: (a, b) => a + b,
		mul: (a, b) => a * b,
		sample: (next) => BigInt(next() % 1024)
	},
	{
		name: 'max-add',
		signed: true,
		method: 'multiplicative',
		zero: -INF,
		one: 0n,
		add: max,
		mul: (a, b) => (a <= -INF || b <= -INF ? -INF : a + b),
		sample: small,
		z: -Z,
		zinv: Z
	},
	{
		name: 'max-min',
		signed: true,
		method: 'lattice',
		zero: -INF,
		one: INF,
		add: max,
		mul: min,
		sample: small
	},
	{
		name: 'min-max',
		signed: true,
		method: 'lattice',
		zero: INF,
		one: -INF,
		add: min,
		mul: max,
		sample: small
	},
	{
		name: 'or-and',
		signed: false,
		method: 'lattice',
		zero: 0n,
		one: 1n,
		add: max,
		mul: min,
		sample: (next) => BigInt(next() & 1)
	},
	{
		name: 'and-or',
		signed: false,
		method: 'lattice',
		zero: 1n,
		one: 0n,
		add: min,
		mul: max,
		sample: (next) => BigInt(next() & 1)
	}
];

export const semiringOf = (name: SemiringName) => semirings.find((s) => s.name === name)!;

export type UnsupportedClass =
	'state-outside-class' | 'end-to-end-mismatch' | 'imports' | 'side-effect' | 'entry-failed';

export class Unsupported extends Error {
	cls: UnsupportedClass;
	constructor(cls: UnsupportedClass, message: string) {
		super(message);
		this.cls = cls;
	}
}

export interface StreamSubject {
	module: Uint8Array;
	entry: string;
	bits?: 32 | 64;
}

export interface Stream {
	bits: 32 | 64;
	call(state: bigint, input: Uint8Array): bigint;
}

const DATA = 1 << 20;
const PAGE = 65536;

export function openStream(subject: StreamSubject): Stream {
	const bits = subject.bits ?? 32;
	const compiled = new WebAssembly.Module(subject.module as Uint8Array<ArrayBuffer>);
	if (WebAssembly.Module.imports(compiled).length)
		throw new Unsupported('imports', 'the entry module imports something');
	const exports = new WebAssembly.Instance(compiled, {}).exports;
	const fn = exports[subject.entry];
	const memory = exports.memory;
	if (typeof fn !== 'function' || !(memory instanceof WebAssembly.Memory))
		throw new Unsupported(
			'entry-failed',
			`no function export ${subject.entry} or no exported memory`
		);
	const run = fn as (...args: (number | bigint)[]) => number | bigint;
	return {
		bits,
		call(state, input) {
			const need = DATA + input.length;
			if (memory.buffer.byteLength < need)
				memory.grow(Math.ceil((need - memory.buffer.byteLength) / PAGE));
			new Uint8Array(memory.buffer, DATA, input.length).set(input);
			const word = bits === 64 ? BigInt.asIntN(64, state) : Number(BigInt.asIntN(32, state));
			let result: number | bigint;
			try {
				result = run(word, DATA, input.length);
			} catch (error) {
				throw new Unsupported('entry-failed', `the entry trapped: ${String(error)}`);
			}
			const after = new Uint8Array(memory.buffer, DATA, input.length);
			for (let i = 0; i < input.length; i++)
				if (after[i] !== input[i])
					throw new Unsupported('side-effect', 'the entry writes its input');
			return BigInt.asUintN(bits, BigInt(result));
		}
	};
}

const decode = (s: Semiring, bits: number, word: bigint) => {
	if (!s.signed) return word;
	const v = BigInt.asIntN(bits, word);
	return v >= INF / 2n ? INF : v <= -INF / 2n ? -INF : v;
};
const encode = (bits: number, value: bigint) => BigInt.asUintN(bits, value);

type Body = (value: bigint) => bigint;

// the coefficient templates of section 3.2: constant term, then the coefficient of the one variable
function coefficients(s: Semiring, f: Body): [bigint, bigint] {
	const a0 = f(s.zero);
	if (s.method === 'inverse') return [a0, f(s.one) - a0];
	if (s.method === 'lattice') return [a0, f(s.one)];
	return [a0, s.mul(f(s.zinv!), s.z!)];
}

const apply = (s: Semiring, [a0, a1]: [bigint, bigint], w: bigint) => s.add(a0, s.mul(a1, w));

export function mulberry(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
}

export interface BodyCheck {
	semiring: SemiringName;
	accepted: boolean;
	trials: number;
	failure?: string;
}

// random testing of the loop body on one element (a byte): the inferred polynomial must equal the body
export function checkBody(stream: Stream, s: Semiring, trials = 1000, seed = 1): BodyCheck {
	const next = mulberry(seed);
	for (let t = 0; t < trials; t++) {
		const x = Uint8Array.of(next() & 255);
		const w = s.sample(next);
		const f: Body = (v) => decode(s, stream.bits, stream.call(encode(stream.bits, v), x));
		const want = f(w);
		const got = apply(s, coefficients(s, f), w);
		if (want !== got)
			return {
				semiring: s.name,
				accepted: false,
				trials: t + 1,
				failure: `x=${x[0]} w=${w}: body ${want}, polynomial ${got}`
			};
	}
	return { semiring: s.name, accepted: true, trials };
}

export type Summary = [bigint, bigint];

export function summarize(stream: Stream, s: Semiring, chunk: Uint8Array): Summary {
	return coefficients(s, (v) =>
		decode(s, stream.bits, stream.call(encode(stream.bits, v), chunk))
	);
}

export const compose = (s: Semiring, first: Summary, second: Summary): Summary => [
	s.add(second[0], s.mul(second[1], first[0])),
	s.mul(second[1], first[1])
];

export function finish(stream: Stream, s: Semiring, summary: Summary, initial: bigint): bigint {
	const value = apply(s, summary, decode(s, stream.bits, encode(stream.bits, initial)));
	return encode(stream.bits, value);
}

export function split(input: Uint8Array, width: number): Uint8Array[] {
	const size = Math.ceil(input.length / width);
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < input.length; at += size) chunks.push(input.subarray(at, at + size));
	return chunks;
}

export type Summarizer = (chunk: Uint8Array, index: number) => Summary | Promise<Summary>;

// the parallel fold: every chunk summary is independent, the composition is the combine
export async function foldChunks(
	stream: Stream,
	s: Semiring,
	input: Uint8Array,
	initial: bigint,
	width: number,
	summarizer: Summarizer = (chunk) => summarize(stream, s, chunk)
): Promise<bigint> {
	const summaries = await Promise.all(split(input, width).map(summarizer));
	return finish(
		stream,
		s,
		summaries.reduce((a, b) => compose(s, a, b)),
		initial
	);
}

export const serial = (stream: Stream, input: Uint8Array, initial: bigint) =>
	stream.call(initial, input);

// what the coefficients look like over all 256 elements, for the report
export function describeCombine(stream: Stream, s: Semiring): string {
	const a0s = new Set<bigint>();
	const a1s = new Set<bigint>();
	let identity = true;
	for (let x = 0; x < 256; x++) {
		const bytes = Uint8Array.of(x);
		const [a0, a1] = coefficients(s, (v) =>
			decode(s, stream.bits, stream.call(encode(stream.bits, v), bytes))
		);
		a0s.add(a0);
		a1s.add(a1);
		if (a0 !== BigInt(x)) identity = false;
	}
	const ops: Record<SemiringName, string> = {
		'add-mul': '+ and x',
		'max-add': 'max and +',
		'max-min': 'max and min',
		'min-max': 'min and max',
		'or-and': 'or and and',
		'and-or': 'and and or'
	};
	const a1 =
		a1s.size === 1 ? `a1 = ${[...a1s][0]}` : `a1 takes ${a1s.size} values over the 256 bytes`;
	const a0 = identity ? 'a0 = x' : `a0 takes ${a0s.size} values over the 256 bytes`;
	return `s' = a0 (+) a1 (x) s over (${ops[s.name]}); ${a0}; ${a1}; chunks compose as (b0 (+) b1 (x) a0, b1 (x) a1)`;
}

export type Verdict =
	| {
			verdict: 'supported';
			semiring: SemiringName;
			accepted: SemiringName[];
			combine: string;
			bodyTrials: number;
			sampleBytes: number;
	  }
	| {
			verdict: 'unsupported';
			cls: UnsupportedClass;
			reason: string;
			checks: BodyCheck[];
	  };

export interface BaselineOptions {
	trials?: number;
	seed?: number;
	sampleBytes?: number;
	width?: number;
	initial?: bigint;
}

const bytesOf = (seed: number, size: number) => {
	const next = mulberry(seed);
	return Uint8Array.from({ length: size }, () => next() & 255);
};

// infer by sampling, then run the split on a sample of the stream and keep the verdict only if it equals serial
export async function infer(
	subject: StreamSubject,
	options: BaselineOptions = {}
): Promise<Verdict> {
	const trials = options.trials ?? 1000;
	const seed = options.seed ?? 1;
	const sampleBytes = options.sampleBytes ?? 16384;
	const width = options.width ?? 4;
	const initial = options.initial ?? 0n;
	const checks: BodyCheck[] = [];
	let stream: Stream;
	try {
		stream = openStream(subject);
		for (const s of semirings) checks.push(checkBody(stream, s, trials, seed));
	} catch (error) {
		if (!(error instanceof Unsupported)) throw error;
		return { verdict: 'unsupported', cls: error.cls, reason: error.message, checks };
	}
	const accepted = checks.filter((c) => c.accepted).map((c) => c.semiring);
	if (!accepted.length)
		return {
			verdict: 'unsupported',
			cls: 'state-outside-class',
			reason: `no semiring reproduces the body; first failures: ${checks.map((c) => `${c.semiring} (${c.failure})`).join('; ')}`,
			checks
		};
	const sample = bytesOf(seed + 1, sampleBytes);
	const mismatched: string[] = [];
	for (const name of accepted) {
		const s = semiringOf(name);
		try {
			const parallel = await foldChunks(stream, s, sample, initial, width);
			if (parallel === serial(stream, sample, initial))
				return {
					verdict: 'supported',
					semiring: name,
					accepted,
					combine: describeCombine(stream, s),
					bodyTrials: trials,
					sampleBytes
				};
			mismatched.push(name);
		} catch (error) {
			if (!(error instanceof Unsupported)) throw error;
			mismatched.push(`${name} (${error.message})`);
		}
	}
	return {
		verdict: 'unsupported',
		cls: 'end-to-end-mismatch',
		reason: `accepted by body sampling (${accepted.join(', ')}) but the split fold differs from serial on a ${sampleBytes} byte sample under ${mismatched.join(', ')}`,
		checks
	};
}
