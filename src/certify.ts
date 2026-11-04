import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import type { AffineLayout, AffineModel } from './affine.ts';

/**
 * `gf2` forms are bit-level affine over xor, `z2w` forms are word-level affine over add and
 * multiply, and `zp` forms are exact integers over two 16-bit digits with a residue after every
 * reduction, for state that holds two residues mod one constant, as Adler-32 does.
 */
export type CertifiedRing = 'gf2' | 'z2w' | 'zp';

export interface CertifyOptions {
	/** Parameter positions of the state, the pointer and the length. The default is 0, 1, 2. */
	layout?: { state: number; ptr: number; len: number };
	/**
	 * Lengths below this run concretely and the rest as quotient and remainder. The default tries 4
	 * and then 16, because a smaller block is cheaper and a function with a larger unroll needs more.
	 */
	block?: number;
	/** Wall clock limit of the whole call, across the block ladder, in milliseconds. The default is 30000. */
	maxMs?: number;
	/** Restricts the analysis to one ring. The default tries `gf2`, then `z2w`, then `zp`. */
	ring?: CertifiedRing;
}

export interface CertificateRange {
	address: number;
	length: number;
	sha256: string;
}

/**
 * A call over `len` bytes at `ptr` also replaces byte `i` of that range with a fixed function of
 * the input byte and the fold state before it, and writes nothing else. When the byte step ignores
 * the input bytes, `step` is its result from state zero, which with the model gives every state
 * along the input without running the kernel, so chunks can run in place from their own start.
 */
export interface CertificateOutput {
	inPlace: true;
	step?: bigint;
}

export interface CertificateWrite {
	address: number;
	hex: string;
}

/**
 * A proof that `entry(state, ptr, len)` is, for every length of at least one byte, the left fold of
 * one affine byte step over the input, and the model of that step. The claim holds when the module
 * bytes hash to `moduleSha256`, the input range stays inside `memory` and avoids `exclusions`, and
 * the memory the proof read still holds `image` once `initialization` has run.
 */
export interface StreamCertificate {
	kind: 'certificate';
	schema: 'folio.certificate.v1';
	checker: string;
	moduleSha256: string;
	entry: string;
	ring: CertifiedRing;
	bits: 32 | 64;
	block: number;
	layout: AffineLayout;
	model: AffineModel;
	/** Present when the call also rewrites its input, which `CertificateOutput` describes. */
	output?: CertificateOutput;
	/** What a call over zero bytes returns: the state itself, or a function of it. */
	zeroLength: 'identity' | 'transforms';
	/** Memory the proof read, as it must be when the call starts. */
	image: CertificateRange[];
	/** Bytes the first call writes before it reads them, for modules that build a table lazily. */
	initialization: CertificateWrite[];
	/** Byte ranges, start inclusive and end exclusive, that an input must not overlap. */
	exclusions: [number, number][];
	stats: { paths: number; loops: number; expressions: number };
}

export interface CertificateRefusal {
	kind: 'refusal';
	reason: string;
	attempts: { ring: CertifiedRing; reason: string }[];
}

export const CHECKER = 'folio-stream-certifier-2';

// #region values

class Refusal extends Error {}

const refuse = (why: string): never => {
	throw new Refusal(why);
};

type Rel = 'eq' | 'ne' | 'ltu' | 'leu' | 'gtu' | 'geu';

/** An integer c + sum(s[k] * k) mod 2^32 over named symbols, with signed representatives. */
interface Ctl {
	t: 'c';
	c: bigint;
	s: Map<string, bigint>;
}

interface Dat {
	t: 'd';
	f: Form;
}

/** A comparison of two control values that the ranges did not decide. */
interface Prd {
	t: 'p';
	rel: Rel;
	a: Ctl;
	b: Ctl;
}

type Val = Ctl | Dat | Prd;

class Undecided extends Error {}

class Jump {
	label: string;
	value: Val | undefined;
	constructor(label: string, value: Val | undefined) {
		this.label = label;
		this.value = value;
	}
}

const RETURN = '*return';
const M32 = (1n << 32n) - 1n;
const M64 = (1n << 64n) - 1n;
const mask = (w: number) => (w === 32 ? M32 : M64);
const s32 = (x: bigint) => BigInt.asIntN(32, x);
const u32 = (x: bigint) => BigInt.asUintN(32, x);

const norm = (c: bigint, s: Map<string, bigint>): Ctl => {
	const out = new Map<string, bigint>();
	for (const [k, v] of s) {
		const n = s32(v);
		if (n) out.set(k, n);
	}
	return { t: 'c', c: s32(c), s: out };
};
const num = (v: bigint | number): Ctl => norm(BigInt(v), new Map());
const sym = (name: string): Ctl => norm(0n, new Map([[name, 1n]]));
const isNum = (a: Ctl) => a.s.size === 0;
const combine = (a: Ctl, b: Ctl, sign: bigint): Ctl => {
	const s = new Map(a.s);
	for (const [k, v] of b.s) s.set(k, (s.get(k) ?? 0n) + sign * v);
	return norm(a.c + sign * b.c, s);
};
const cadd = (a: Ctl, b: Ctl) => combine(a, b, 1n);
const csub = (a: Ctl, b: Ctl) => combine(a, b, -1n);
const scale = (a: Ctl, k: bigint): Ctl =>
	norm(a.c * k, new Map([...a.s].map(([n, v]) => [n, v * k])));
const ceq = (a: Ctl, b: Ctl) => isNum(csub(a, b)) && csub(a, b).c === 0n;
const floorDiv = (a: bigint, b: bigint) => {
	const q = a / b;
	return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};
const ceilDiv = (a: bigint, b: bigint) => -floorDiv(-a, b);

type Ranges = Map<string, [bigint, bigint]>;

/** The integer interval of the form over the symbol ranges. Unknown symbols span the whole word. */
function span(a: Ctl, ranges: Ranges): [bigint, bigint] {
	if (isNum(a)) {
		const v = u32(a.c);
		return [v, v];
	}
	let lo = a.c;
	let hi = a.c;
	for (const [k, co] of a.s) {
		const [l, h] = ranges.get(k) ?? [0n, M32];
		lo += co > 0n ? co * l : co * h;
		hi += co > 0n ? co * h : co * l;
	}
	return [lo, hi];
}

const nowrap = (a: Ctl, ranges: Ranges) => {
	const [lo, hi] = span(a, ranges);
	return lo >= 0n && hi <= M32;
};

function decide(rel: Rel, a: Ctl, b: Ctl, ranges: Ranges): Ctl | Prd {
	const yes = num(1);
	const no = num(0);
	const diff = csub(a, b);
	if (isNum(a) && isNum(b)) {
		const x = u32(a.c);
		const y = u32(b.c);
		const r = { eq: x === y, ne: x !== y, ltu: x < y, leu: x <= y, gtu: x > y, geu: x >= y }[
			rel
		];
		return r ? yes : no;
	}
	if (rel === 'eq' || rel === 'ne') {
		let equal: boolean | undefined;
		if (isNum(diff)) equal = diff.c === 0n;
		else {
			const [lo, hi] = span(diff, ranges);
			if (lo > -(1n << 32n) && hi < 1n << 32n && (lo > 0n || hi < 0n)) equal = false;
		}
		if (equal !== undefined) return (rel === 'eq') === equal ? yes : no;
	} else if (nowrap(a, ranges) && nowrap(b, ranges)) {
		const [al, ah] = span(a, ranges);
		const [bl, bh] = span(b, ranges);
		const always = { ltu: ah < bl, leu: ah <= bl, gtu: al > bh, geu: al >= bh }[rel];
		const never = { ltu: al >= bh, leu: al > bh, gtu: ah <= bl, geu: ah < bl }[rel];
		if (always) return yes;
		if (never) return no;
	}
	return { t: 'p', rel, a, b };
}

const negate = (rel: Rel): Rel =>
	(({ eq: 'ne', ne: 'eq', ltu: 'geu', geu: 'ltu', leu: 'gtu', gtu: 'leu' }) as const)[rel];

// #endregion

// #region concrete arithmetic

const BINARY = new Map<number, { op: string; bits: 32 | 64 }>();
const UNARY = new Map<number, { op: string; bits: 32 | 64 }>();
const named = binaryen as unknown as Record<string, number>;
for (const bits of [32, 64] as const) {
	for (const op of [
		'Add',
		'Sub',
		'Mul',
		'DivS',
		'DivU',
		'RemS',
		'RemU',
		'And',
		'Or',
		'Xor',
		'Shl',
		'ShrU',
		'ShrS',
		'RotL',
		'RotR',
		'Eq',
		'Ne',
		'LtS',
		'LtU',
		'LeS',
		'LeU',
		'GtS',
		'GtU',
		'GeS',
		'GeU'
	])
		BINARY.set(named[`${op}Int${bits}`]!, { op, bits });
	for (const op of ['Clz', 'Ctz', 'Popcnt', 'EqZ'])
		UNARY.set(named[`${op}Int${bits}`]!, { op, bits });
}
UNARY.set(named.ExtendS8Int32!, { op: 'Extend8S', bits: 32 });
UNARY.set(named.ExtendS16Int32!, { op: 'Extend16S', bits: 32 });
UNARY.set(named.ExtendS8Int64!, { op: 'Extend8S', bits: 64 });
UNARY.set(named.ExtendS16Int64!, { op: 'Extend16S', bits: 64 });
UNARY.set(named.ExtendS32Int64!, { op: 'Extend32S', bits: 64 });
UNARY.set(named.WrapInt64!, { op: 'Wrap', bits: 32 });
UNARY.set(named.ExtendSInt32!, { op: 'ExtendS', bits: 64 });
UNARY.set(named.ExtendUInt32!, { op: 'ExtendU', bits: 64 });

const COMPARE = new Set(['Eq', 'Ne', 'LtS', 'LtU', 'LeS', 'LeU', 'GtS', 'GtU', 'GeS', 'GeU']);

function evalBinary(op: string, bits: 32 | 64, a: bigint, b: bigint): bigint {
	const m = mask(bits);
	const sa = BigInt.asIntN(bits, a);
	const sb = BigInt.asIntN(bits, b);
	const sh = b & BigInt(bits - 1);
	const bool = (x: boolean) => (x ? 1n : 0n);
	switch (op) {
		case 'Add':
			return (a + b) & m;
		case 'Sub':
			return (a - b) & m;
		case 'Mul':
			return (a * b) & m;
		case 'And':
			return a & b;
		case 'Or':
			return a | b;
		case 'Xor':
			return a ^ b;
		case 'Shl':
			return (a << sh) & m;
		case 'ShrU':
			return a >> sh;
		case 'ShrS':
			return BigInt.asUintN(bits, sa >> sh);
		case 'RotL':
			return ((a << sh) | (a >> (BigInt(bits) - sh))) & m;
		case 'RotR':
			return ((a >> sh) | (a << (BigInt(bits) - sh))) & m;
		case 'Eq':
			return bool(a === b);
		case 'Ne':
			return bool(a !== b);
		case 'LtU':
			return bool(a < b);
		case 'LeU':
			return bool(a <= b);
		case 'GtU':
			return bool(a > b);
		case 'GeU':
			return bool(a >= b);
		case 'LtS':
			return bool(sa < sb);
		case 'LeS':
			return bool(sa <= sb);
		case 'GtS':
			return bool(sa > sb);
		case 'GeS':
			return bool(sa >= sb);
		case 'DivU':
		case 'RemU':
			if (b === 0n) return refuse('constant division by zero');
			return op === 'DivU' ? a / b : a % b;
		default:
			if (op === 'DivS' || op === 'RemS') {
				if (b === 0n || (sa === -(1n << BigInt(bits - 1)) && sb === -1n))
					return refuse('constant signed division traps');
				return BigInt.asUintN(bits, op === 'DivS' ? sa / sb : sa % sb);
			}
			return refuse(`unsupported operation ${op}`);
	}
}

function evalUnary(op: string, bits: 32 | 64, a: bigint): bigint {
	switch (op) {
		case 'EqZ':
			return a === 0n ? 1n : 0n;
		case 'Clz': {
			let n = 0;
			for (let k = bits - 1; k >= 0 && !((a >> BigInt(k)) & 1n); k--) n++;
			return BigInt(n);
		}
		case 'Ctz': {
			let n = 0;
			for (let k = 0; k < bits && !((a >> BigInt(k)) & 1n); k++) n++;
			return BigInt(n);
		}
		case 'Popcnt':
			return BigInt(a.toString(2).replaceAll('0', '').length);
		case 'Extend8S':
			return BigInt.asUintN(bits, BigInt.asIntN(8, a));
		case 'Extend16S':
			return BigInt.asUintN(bits, BigInt.asIntN(16, a));
		case 'Extend32S':
			return BigInt.asUintN(bits, BigInt.asIntN(32, a));
		case 'Wrap':
			return a & M32;
		case 'ExtendU':
			return a & M32;
		case 'ExtendS':
			return BigInt.asUintN(64, BigInt.asIntN(32, a));
		default:
			return refuse(`unsupported operation ${op}`);
	}
}

// #endregion

// #region rings

type Form = Gf2 | Zw | Zp;

interface Gf2 {
	r: 'gf2';
	w: 32 | 64;
	v: bigint[];
}

interface Zw {
	r: 'z2w';
	w: 32 | 64;
	c: bigint;
	y: bigint;
	b: Map<number, bigint>;
	a: Map<number, bigint>;
}

/**
 * The exact integer c + d0 * lo + d1 * hi + sum(b[p] * byte p) + sum(a[id] * atom id), where lo and
 * hi are the low and high 16 bits of the state and no value can leave [0, 2^w), which `fits` checks
 * after every operation that could. A `Res` atom is a form reduced mod p, kept by its reduced argument.
 */
interface Zp {
	r: 'zp';
	w: 32 | 64;
	c: bigint;
	d: [bigint, bigint];
	b: Map<number, bigint>;
	a: Map<number, bigint>;
}

/**
 * A pure function of input bytes and constants that is not affine in the bytes, kept as an opaque
 * variable. Two atoms with the same key are the same function of the same bytes, so equal forms
 * stay equal and the state part stays exact: the fold only has to be affine in the state.
 */
interface Atom {
	op: string;
	w: 32 | 64;
	extra: string;
	args: Form[];
}

type Reader = (address: number, width: number) => bigint;

interface Ring {
	name: CertifiedRing;
	state(w: 32 | 64): Form;
	bytes(pos: number, width: number, w: 32 | 64): Form;
	konst(value: bigint, w: 32 | 64): Form;
	asConst(f: Form): bigint | undefined;
	binary(op: string, a: Form, b: Form): Form;
	unary(op: string, a: Form): Form;
	equal(a: Form, b: Form): boolean;
	subst(f: Form, y: Form, shift: number): Form;
	remap(f: Form, map: Map<number, number>): Form;
	positions(f: Form): number[];
	operator(f: Form): bigint[] | bigint;
	/** The modulus of the residues, for the `zp` ring. */
	modulus?(f: Form): bigint;
	/** The value of a form that ignores the input bytes when the state is zero, if it has no atoms. */
	zeroStep(f: Form): bigint | undefined;
	lookup(index: Form, offset: number, width: number, w: 32 | 64, read: Reader): Form;
	/** The low bit of the population count, which is the xor of every bit. */
	parity(a: Form): Form;
}

// variable layout of a gf2 mask: bit 0 is the constant one, bits 1 to 64 the state, then 8 per input byte
const LOW = (1n << 65n) - 1n;
const bitVar = (pos: number, bit: number) => 1n << BigInt(65 + 8 * pos + bit);

const gf = (f: Form): Gf2 => (f.r === 'gf2' ? f : (refuse('mixed rings') as never));
const zw = (f: Form): Zw => (f.r === 'z2w' ? f : (refuse('mixed rings') as never));
const sameWidth = (a: Form, b: Form) => {
	if (a.w !== b.w) refuse('operands of different widths');
};

// gf2 atom variables live above the byte variables, 64 bits per atom
const ATOM0 = 8192;
const BYTES = (1n << BigInt(ATOM0 - 65)) - 1n;
const STATE = ((1n << 64n) - 1n) << 1n;
const atomBit = (id: number, k: number) => 1n << BigInt(ATOM0 + 64 * id + k);

let atomIds = new Map<string, number>();
let atomList: Atom[] = [];

// per-atom answers that depend only on the atom, kept so a deep chain of atoms is walked once
const freeMemo = new Map<number, boolean>();
const opaqueMemo = new Map<string, boolean>();
const positionMemo = new Map<unknown, Map<number, number[]>>();

const resetAtoms = () => {
	atomIds = new Map();
	atomList = [];
	freeMemo.clear();
	opaqueMemo.clear();
	positionMemo.clear();
};

const keyed = (m: Map<number, bigint>) => [...m].sort((p, q) => p[0] - q[0]).join(',');

const formKey = (f: Form): string =>
	f.r === 'gf2'
		? `g${f.w}:${f.v.map((m) => m.toString(16)).join('.')}`
		: f.r === 'z2w'
			? `z${f.w}:${f.c}:${f.y}:${keyed(f.b)}:${keyed(f.a)}`
			: `p${f.w}:${f.c}:${f.d.join('.')}:${keyed(f.b)}:${keyed(f.a)}`;

// wall clock limit of the analysis in progress, set by certifyStream
let deadline = Infinity;

function internAtom(op: string, w: 32 | 64, extra: string, args: Form[]): number {
	if (Date.now() > deadline) refuse('analysis time limit');
	const key = `${op}|${w}|${extra}|${args.map(formKey).join('|')}`;
	let id = atomIds.get(key);
	if (id === undefined) {
		if (atomList.length >= 50_000) refuse('too many atoms');
		id = atomList.length;
		atomList.push({ op, w, extra, args });
		atomIds.set(key, id);
	}
	return id;
}

/** The atom with every argument rewritten, for shifting or renaming byte positions. */
const rekey = (id: number, fn: (a: Form) => Form) => {
	const atom = atomList[id]!;
	return internAtom(atom.op, atom.w, atom.extra, atom.args.map(fn));
};

const moveAtoms = (m: bigint, fn: (id: number) => number): bigint => {
	let out = 0n;
	let high = m >> BigInt(ATOM0);
	for (let id = 0; high > 0n; id++, high >>= 64n) {
		const block = high & M64;
		if (block) out ^= block << BigInt(ATOM0 + 64 * fn(id));
	}
	return out;
};

const atomPositions = (ids: Iterable<number>, positions: (f: Form) => number[]) => {
	let memo = positionMemo.get(positions);
	if (!memo) positionMemo.set(positions, (memo = new Map()));
	const out = new Set<number>();
	for (const id of ids) {
		let found = memo.get(id);
		if (!found) {
			const here = new Set<number>();
			for (const arg of atomList[id]!.args) for (const p of positions(arg)) here.add(p);
			memo.set(id, (found = [...here]));
		}
		for (const p of found) out.add(p);
	}
	return out;
};

// operations on bytes alone that are not affine, which become atoms when the state is not involved
const ATOMIC = new Set([
	'And',
	'Or',
	'Xor',
	'Add',
	'Sub',
	'Mul',
	'Shl',
	'ShrU',
	'ShrS',
	'RotL',
	'RotR',
	'Eq',
	'Ne',
	'LtS',
	'LtU',
	'LeS',
	'LeU',
	'GtS',
	'GtU',
	'GeS',
	'GeU',
	'Clz',
	'Ctz',
	'Popcnt',
	'EqZ'
]);

/** The atoms a form mentions. */
const atomIdsOf = (f: Form): number[] => {
	if (f.r !== 'gf2') return [...f.a.keys()];
	const ids: number[] = [];
	for (
		let id = 0, high = f.v.reduce((a, m) => a | m, 0n) >> BigInt(ATOM0);
		high > 0n;
		id++, high >>= 64n
	)
		if (high & M64) ids.push(id);
	return ids;
};

/** Whether the form depends on the state, directly or through the arguments of an atom. */
const stateFree = (f: Form): boolean =>
	(f.r === 'gf2'
		? f.v.every((m) => (m & STATE) === 0n)
		: f.r === 'z2w'
			? f.y === 0n
			: !f.d[0] && !f.d[1]) &&
	atomIdsOf(f).every((id) => {
		let free = freeMemo.get(id);
		if (free === undefined) freeMemo.set(id, (free = atomList[id]!.args.every(stateFree)));
		return free;
	});

/** Whether the form holds an atom of the state that the ring cannot express: a residue is expressed by `zp`. */
const opaque = (ring: Ring, f: Form): boolean =>
	atomIdsOf(f).some((id) => {
		const key = `${ring.name}:${id}`;
		let found = opaqueMemo.get(key);
		if (found === undefined) {
			const at = atomList[id]!;
			found = at.args.every(stateFree)
				? false
				: ring.name === 'zp' && at.op === 'Res'
					? at.args.some((a) => opaque(ring, a))
					: true;
			opaqueMemo.set(key, found);
		}
		return found;
	});

const gf2: Ring = {
	name: 'gf2',
	state: (w) => ({ r: 'gf2', w, v: Array.from({ length: w }, (_, k) => 1n << BigInt(k + 1)) }),
	bytes: (pos, width, w) => ({
		r: 'gf2',
		w,
		v: Array.from({ length: w }, (_, k) => (k < 8 * width ? bitVar(pos, k) : 0n))
	}),
	konst: (value, w) => ({
		r: 'gf2',
		w,
		v: Array.from({ length: w }, (_, k) => ((value >> BigInt(k)) & 1n ? 1n : 0n))
	}),
	asConst(f) {
		const g = gf(f);
		let value = 0n;
		for (let k = 0; k < g.w; k++) {
			if (g.v[k] === 1n) value |= 1n << BigInt(k);
			else if (g.v[k] !== 0n) return undefined;
		}
		return value;
	},
	binary(op, a, b) {
		const x = gf(a);
		const y = gf(b);
		sameWidth(x, y);
		const ca = gf2.asConst(x);
		const cb = gf2.asConst(y);
		const map = (f: (k: number) => bigint): Form => ({
			r: 'gf2',
			w: x.w,
			v: Array.from({ length: x.w }, (_, k) => f(k))
		});
		const bit = (c: bigint, k: number) => (c >> BigInt(k)) & 1n;
		// operands that never both hold a one at a position cannot carry, so add and or are xor
		const disjoint = () =>
			x.v.every((m, k) => m === 0n || y.v[k] === 0n)
				? map((k) => x.v[k]! ^ y.v[k]!)
				: refuse(`${op} may carry`);
		const shiftOf = (c: bigint | undefined) => {
			if (c === undefined) return refuse(`${op} by a data value`);
			return Number(c & BigInt(x.w - 1));
		};
		switch (op) {
			case 'Xor':
				return map((k) => x.v[k]! ^ y.v[k]!);
			case 'And':
				if (cb !== undefined) return map((k) => (bit(cb, k) ? x.v[k]! : 0n));
				if (ca !== undefined) return map((k) => (bit(ca, k) ? y.v[k]! : 0n));
				return refuse('and of two data values');
			case 'Or':
				if (cb !== undefined) return map((k) => (bit(cb, k) ? 1n : x.v[k]!));
				if (ca !== undefined) return map((k) => (bit(ca, k) ? 1n : y.v[k]!));
				return disjoint();
			case 'Add':
				return disjoint();
			case 'Sub':
				if (cb === 0n) return x;
				if (ca === 0n) {
					// 0 - b * 2^j is one bit b spread over every position from j up
					const at = y.v.findIndex((m) => m !== 0n);
					if (at >= 0 && y.v.every((m, k) => k === at || m === 0n))
						return map((k) => (k >= at ? y.v[at]! : 0n));
					// 0 - (all ones or all zeros) is one or zero
					if (y.v.every((m) => m === y.v[0]!))
						return map((k) => (k === 0 ? y.v[0]! : 0n));
				}
				return refuse('subtraction other than the negation of one bit');
			case 'Mul': {
				const c = cb ?? ca;
				const other = cb !== undefined ? x : y;
				if (c === undefined) return refuse('product of two data values');
				if (c === 0n) return gf2.konst(0n, x.w);
				if (c === 1n) return other;
				if ((c & (c - 1n)) === 0n) {
					const s = c.toString(2).length - 1;
					return gf2.binary('Shl', other, gf2.konst(BigInt(s), x.w));
				}
				return refuse('product by a constant that is not a power of two');
			}
			case 'Shl': {
				const s = shiftOf(cb);
				return map((k) => (k < s ? 0n : x.v[k - s]!));
			}
			case 'ShrU': {
				const s = shiftOf(cb);
				return map((k) => x.v[k + s] ?? 0n);
			}
			case 'ShrS': {
				const s = shiftOf(cb);
				return map((k) => x.v[k + s] ?? x.v[x.w - 1]!);
			}
			case 'RotL': {
				const s = shiftOf(cb);
				return map((k) => x.v[(k - s + x.w) % x.w]!);
			}
			case 'RotR': {
				const s = shiftOf(cb);
				return map((k) => x.v[(k + s) % x.w]!);
			}
			default:
				return refuse(`${op} is not affine over gf2`);
		}
	},
	unary(op, a) {
		const x = gf(a);
		const ext = (n: number): Form => ({
			r: 'gf2',
			w: x.w,
			v: x.v.map((m, k) => (k < n ? m : x.v[n - 1]!))
		});
		switch (op) {
			case 'Wrap':
				return { r: 'gf2', w: 32, v: x.v.slice(0, 32) };
			case 'ExtendU':
				return { r: 'gf2', w: 64, v: [...x.v, ...Array<bigint>(32).fill(0n)] };
			case 'ExtendS':
				return { r: 'gf2', w: 64, v: [...x.v, ...Array<bigint>(32).fill(x.v[31]!)] };
			case 'Extend8S':
				return ext(8);
			case 'Extend16S':
				return ext(16);
			case 'Extend32S':
				return ext(32);
			default:
				return refuse(`${op} of a data value is not affine over gf2`);
		}
	},
	equal(a, b) {
		const x = gf(a);
		const y = gf(b);
		return x.w === y.w && x.v.every((m, k) => m === y.v[k]);
	},
	subst(f, y, shift) {
		const x = gf(f);
		const s = gf(y);
		return {
			r: 'gf2',
			w: x.w,
			v: x.v.map((m) => {
				let acc = 0n;
				const low = m & LOW;
				if (low & 1n) acc ^= 1n;
				for (let i = 0; i < 64; i++)
					if ((low >> BigInt(i + 1)) & 1n) acc ^= s.v[i] ?? refuse('state width');
				acc ^= (((m >> 65n) & BYTES) << BigInt(8 * shift)) << 65n;
				return acc ^ moveAtoms(m, (id) => rekey(id, (a) => gf2.subst(a, s, shift)));
			})
		};
	},
	remap(f, map) {
		const x = gf(f);
		return {
			r: 'gf2',
			w: x.w,
			v: x.v.map((m) => {
				let acc = m & LOW;
				for (const [from, to] of map)
					acc ^= ((m >> BigInt(65 + 8 * from)) & 255n) << BigInt(65 + 8 * to);
				return acc ^ moveAtoms(m, (id) => rekey(id, (a) => gf2.remap(a, map)));
			})
		};
	},
	parity(a) {
		const x = gf(a);
		return {
			r: 'gf2',
			w: x.w,
			v: x.v.map((_, k) => (k === 0 ? x.v.reduce((p, m) => p ^ m, 0n) : 0n))
		};
	},
	positions(f) {
		const x = gf(f);
		const union = x.v.reduce((a, m) => a | m, 0n);
		const all = (union >> 65n) & BYTES;
		const out = new Set<number>();
		for (let p = 0; all >> BigInt(8 * p) > 0n; p++)
			if ((all >> BigInt(8 * p)) & 255n) out.add(p);
		for (const p of atomPositions(atomIdsOf(x), gf2.positions)) out.add(p);
		return [...out].sort((p, q) => p - q);
	},
	operator(f) {
		const x = gf(f);
		return Array.from({ length: x.w }, (_, i) => {
			let column = 0n;
			for (let k = 0; k < x.w; k++) column |= ((x.v[k]! >> BigInt(i + 1)) & 1n) << BigInt(k);
			return column;
		});
	},
	zeroStep(f) {
		const x = gf(f);
		if (atomIdsOf(x).length) return undefined;
		return x.v.reduce((acc, m, k) => acc | ((m & 1n) << BigInt(k)), 0n);
	},
	lookup(index, offset, width, w, read) {
		const x = gf(index);
		if (x.w !== 32) return refuse('table index is not an i32');
		const free: number[] = [];
		let origin = 0;
		const linear = x.v.map((m, k) => {
			if (m & 1n) origin |= 1 << k;
			const rest = m & ~1n;
			if (rest) free.push(k);
			return rest;
		});
		if (free.length > 10) return refuse('table index has more than ten free bits');
		const at = (set: number) => {
			let e = origin;
			free.forEach((k, i) => {
				if ((set >> i) & 1) e ^= 1 << k;
			});
			return read((e >>> 0) + offset, width);
		};
		const base = at(0);
		const delta = free.map((_, i) => at(1 << i) ^ base);
		const entries: bigint[] = [];
		let affine = true;
		for (let set = 0; set < 1 << free.length; set++) {
			let expect = base;
			delta.forEach((d, i) => {
				if ((set >> i) & 1) expect ^= d;
			});
			const got = at(set);
			entries.push(got);
			if (got !== expect) affine = false;
		}
		if (!affine) {
			// a table indexed by the state is not affine and may only reach memory, like any opaque atom
			if (!stateFree(x)) opaqueWhy ||= 'table is not linear in its index bits';
			const digest = createHash('sha256').update(entries.join(',')).digest('hex');
			const id = internAtom('Table', w, `${origin}:${free.join('.')}:${digest}`, [x]);
			return { r: 'gf2', w, v: Array.from({ length: w }, (_, k) => atomBit(id, k)) };
		}
		return {
			r: 'gf2',
			w,
			v: Array.from({ length: w }, (_, j) => {
				let acc = (base >> BigInt(j)) & 1n ? 1n : 0n;
				free.forEach((k, i) => {
					if ((delta[i]! >> BigInt(j)) & 1n) acc ^= linear[k]!;
				});
				return acc;
			})
		};
	}
};

const zwNorm = (
	w: 32 | 64,
	c: bigint,
	y: bigint,
	b: Map<number, bigint>,
	a: Map<number, bigint> = new Map()
): Zw => {
	const m = mask(w);
	const bytes = new Map<number, bigint>();
	for (const [p, v] of b) if (v & m) bytes.set(p, v & m);
	const atoms = new Map<number, bigint>();
	for (const [p, v] of a) if (v & m) atoms.set(p, v & m);
	return { r: 'z2w', w, c: c & m, y: y & m, b: bytes, a: atoms };
};

const sumMaps = (p: Map<number, bigint>, q: Map<number, bigint>, sign: bigint) => {
	const out = new Map(p);
	for (const [k, v] of q) out.set(k, (out.get(k) ?? 0n) + sign * v);
	return out;
};

const scaleMap = (p: Map<number, bigint>, k: bigint) =>
	new Map([...p].map(([pos, v]): [number, bigint] => [pos, v * k]));

const rekeyMap = (p: Map<number, bigint>, fn: (id: number) => number) => {
	const out = new Map<number, bigint>();
	for (const [id, v] of p) {
		const to = fn(id);
		out.set(to, (out.get(to) ?? 0n) + v);
	}
	return out;
};

const z2w: Ring = {
	name: 'z2w',
	state: (w) => zwNorm(w, 0n, 1n, new Map()),
	bytes: (pos, width, w) =>
		zwNorm(
			w,
			0n,
			0n,
			new Map(Array.from({ length: width }, (_, j) => [pos + j, 1n << BigInt(8 * j)]))
		),
	konst: (value, w) => zwNorm(w, value, 0n, new Map()),
	asConst(f) {
		const x = zw(f);
		return x.y === 0n && x.b.size === 0 && x.a.size === 0 ? x.c : undefined;
	},
	binary(op, a, b) {
		const x = zw(a);
		const y = zw(b);
		sameWidth(x, y);
		const ca = z2w.asConst(x);
		const cb = z2w.asConst(y);
		const lin = (p: Zw, q: Zw, sign: bigint) =>
			zwNorm(
				x.w,
				p.c + sign * q.c,
				p.y + sign * q.y,
				sumMaps(p.b, q.b, sign),
				sumMaps(p.a, q.a, sign)
			);
		const times = (p: Zw, k: bigint) =>
			zwNorm(x.w, p.c * k, p.y * k, scaleMap(p.b, k), scaleMap(p.a, k));
		switch (op) {
			case 'Add':
				return lin(x, y, 1n);
			case 'Sub':
				return lin(x, y, -1n);
			case 'Mul':
				if (cb !== undefined) return times(x, cb);
				if (ca !== undefined) return times(y, ca);
				return refuse('product of two data values');
			case 'Shl':
				if (cb === undefined) return refuse('shift by a data value');
				return times(x, 1n << (cb & BigInt(x.w - 1)));
			default:
				return refuse(`${op} is not affine over z2w`);
		}
	},
	unary: (op) => refuse(`${op} of a data value is not affine over z2w`),
	equal(a, b) {
		const x = zw(a);
		const y = zw(b);
		if (
			x.w !== y.w ||
			x.c !== y.c ||
			x.y !== y.y ||
			x.b.size !== y.b.size ||
			x.a.size !== y.a.size
		)
			return false;
		for (const [k, v] of x.b) if (y.b.get(k) !== v) return false;
		for (const [k, v] of x.a) if (y.a.get(k) !== v) return false;
		return true;
	},
	subst(f, y, shift) {
		const x = zw(f);
		const s = zw(y);
		const bs = scaleMap(s.b, x.y);
		for (const [k, v] of x.b) bs.set(k + shift, (bs.get(k + shift) ?? 0n) + v);
		const moved = rekeyMap(x.a, (id) => rekey(id, (a) => z2w.subst(a, s, shift)));
		return zwNorm(x.w, x.c + x.y * s.c, x.y * s.y, bs, sumMaps(scaleMap(s.a, x.y), moved, 1n));
	},
	remap(f, map) {
		const x = zw(f);
		const bs = new Map<number, bigint>();
		for (const [k, v] of x.b) {
			const to = map.get(k) ?? k;
			bs.set(to, (bs.get(to) ?? 0n) + v);
		}
		return zwNorm(
			x.w,
			x.c,
			x.y,
			bs,
			rekeyMap(x.a, (id) => rekey(id, (a) => z2w.remap(a, map)))
		);
	},
	parity: () => refuse('parity of a data value is not affine over z2w'),
	positions(f) {
		const x = zw(f);
		const out = new Set([...x.b.keys()]);
		for (const p of atomPositions(x.a.keys(), z2w.positions)) out.add(p);
		return [...out].sort((p, q) => p - q);
	},
	operator: (f) => zw(f).y,
	zeroStep: (f) => (zw(f).a.size ? undefined : zw(f).c),
	lookup: () => refuse('a table lookup is not affine over z2w')
};

// #region zp

const DIGIT = 16;
const DMAX = (1n << BigInt(DIGIT)) - 1n;

const zpf = (f: Form): Zp => (f.r === 'zp' ? f : (refuse('mixed rings') as never));

const zpMake = (
	w: 32 | 64,
	c: bigint,
	d: [bigint, bigint],
	b: Map<number, bigint>,
	a: Map<number, bigint>
): Zp => ({
	r: 'zp',
	w,
	c,
	d,
	b: new Map([...b].filter(([, v]) => v !== 0n)),
	a: new Map([...a].filter(([, v]) => v !== 0n))
});

const zpAtom = (w: 32 | 64, id: number): Zp =>
	zpMake(w, 0n, [0n, 0n], new Map(), new Map([[id, 1n]]));

const zpLin = (p: Zp, q: Zp, sign: bigint): Zp =>
	zpMake(
		p.w,
		p.c + sign * q.c,
		[p.d[0] + sign * q.d[0], p.d[1] + sign * q.d[1]],
		sumMaps(p.b, q.b, sign),
		sumMaps(p.a, q.a, sign)
	);

const zpTimes = (p: Zp, k: bigint): Zp =>
	zpMake(p.w, p.c * k, [p.d[0] * k, p.d[1] * k], scaleMap(p.b, k), scaleMap(p.a, k));

const atomRange = (id: number): [bigint, bigint] => {
	const at = atomList[id]!;
	if (at.op === 'Res') return [0n, BigInt(at.extra) - 1n];
	if (/^(Eq|Ne|EqZ|[LG][te][SU])$/.test(at.op)) return [0n, 1n];
	if (/^(Clz|Ctz|Popcnt)$/.test(at.op)) return [0n, BigInt(at.w)];
	return [0n, mask(at.w)];
};

/** The integer interval of the form: both digits span 16 bits, a byte 8, an atom its own range. */
function zpSpan(x: Zp): [bigint, bigint] {
	let lo = x.c;
	let hi = x.c;
	const add = (k: bigint, l: bigint, h: bigint) => {
		lo += k > 0n ? k * l : k * h;
		hi += k > 0n ? k * h : k * l;
	};
	for (const k of x.d) add(k, 0n, DMAX);
	for (const k of x.b.values()) add(k, 0n, 255n);
	for (const [id, k] of x.a) add(k, ...atomRange(id));
	return [lo, hi];
}

const zpFits = (x: Zp) => {
	const [lo, hi] = zpSpan(x);
	return lo >= 0n && hi <= mask(x.w);
};

const zpChecked = (x: Zp, op: string) => (zpFits(x) ? x : refuse(`${op} may wrap`));

/**
 * The bits of `x` below and from `s` up as two forms, when every state or byte term is either a
 * multiple of 2^s or sits wholly below it, so the low part provably stays under 2^s.
 */
function zpSplit(x: Zp, s: number): { low: Zp; high: Zp } {
	if (!zpFits(x)) return refuse('a split of a value that may wrap');
	const unit = 1n << BigInt(s);
	const low = {
		d: [0n, 0n] as [bigint, bigint],
		b: new Map<number, bigint>(),
		a: new Map<number, bigint>()
	};
	const high = {
		d: [0n, 0n] as [bigint, bigint],
		b: new Map<number, bigint>(),
		a: new Map<number, bigint>()
	};
	const part = (k: bigint, to: (part: typeof low, v: bigint) => void) =>
		k % unit === 0n ? to(high, k / unit) : to(low, k);
	x.d.forEach((k, i) => part(k, (p, v) => (p.d[i] = v)));
	for (const [pos, k] of x.b) part(k, (p, v) => p.b.set(pos, v));
	for (const [id, k] of x.a) part(k, (p, v) => p.a.set(id, v));
	const cl = ((x.c % unit) + unit) % unit;
	const out = {
		low: zpMake(x.w, cl, low.d, low.b, low.a),
		high: zpMake(x.w, (x.c - cl) / unit, high.d, high.b, high.a)
	};
	const [lo, hi] = zpSpan(out.low);
	if (lo < 0n || hi >= unit)
		return refuse('the low bits of a value may carry into the high bits');
	return out;
}

/** `hi + lo` as the or of two forms, when `hi` has zeros below the bits that `lo` can set. */
function zpDisjoint(hi: Zp, lo: Zp): Zp | undefined {
	let s: number = hi.w;
	const note = (v: bigint) => {
		const m = v < 0n ? -v : v;
		if (m !== 0n) s = Math.min(s, (m & -m).toString(2).length - 1);
	};
	note(hi.c);
	hi.d.forEach(note);
	hi.b.forEach(note);
	hi.a.forEach(note);
	if (s === 0) return undefined;
	const [l, h] = zpSpan(lo);
	return l >= 0n && h < 1n << BigInt(s) ? zpLin(hi, lo, 1n) : undefined;
}

/**
 * `f` mod `p` for a form that holds a value in [0, 2^w). A residue atom stands for its argument
 * mod p, so a residue inside another one folds away and the argument is kept with every coefficient
 * reduced. A value that is already below p is the argument itself.
 */
function zpRes(p: bigint, f: Zp): Zp {
	let c = f.c;
	let d0 = f.d[0];
	let d1 = f.d[1];
	const bytes = new Map(f.b);
	const atoms = new Map<number, bigint>();
	for (const [id, k] of f.a) {
		const at = atomList[id]!;
		if (at.op === 'Res' && at.extra === String(p)) {
			const g = at.args[0] as Zp;
			c += k * g.c;
			d0 += k * g.d[0];
			d1 += k * g.d[1];
			for (const [pos, v] of g.b) bytes.set(pos, (bytes.get(pos) ?? 0n) + k * v);
			for (const [other, v] of g.a) atoms.set(other, (atoms.get(other) ?? 0n) + k * v);
		} else atoms.set(id, (atoms.get(id) ?? 0n) + k);
	}
	const red = (v: bigint) => ((v % p) + p) % p;
	const reduce = (m: Map<number, bigint>) =>
		new Map([...m].map(([k, v]): [number, bigint] => [k, red(v)]));
	const g = zpMake(f.w, red(c), [red(d0), red(d1)], reduce(bytes), reduce(atoms));
	if (!g.d[0] && !g.d[1] && !g.b.size && !g.a.size) return g;
	const [lo, hi] = zpSpan(g);
	if (lo >= 0n && hi < p) return g;
	return zpAtom(f.w, internAtom('Res', f.w, String(p), [g]));
}

/** `x` with both digits replaced by the digits of a state form and its byte positions moved by `shift`. */
function zpSubst(x: Zp, digits: () => [Zp, Zp], shift: number): Zp {
	const bytes = new Map<number, bigint>();
	for (const [pos, v] of x.b) bytes.set(pos + shift, v);
	let out = zpMake(x.w, x.c, [0n, 0n], bytes, new Map());
	if (x.d[0] !== 0n || x.d[1] !== 0n) {
		const [lo, hi] = digits();
		out = zpLin(zpLin(out, zpTimes(lo, x.d[0]), 1n), zpTimes(hi, x.d[1]), 1n);
	}
	for (const [id, k] of x.a) {
		const at = atomList[id]!;
		const moved =
			at.op === 'Res'
				? zpRes(BigInt(at.extra), zpSubst(at.args[0] as Zp, digits, shift))
				: zpAtom(
						x.w,
						rekey(id, (a) => zpSubst(zpf(a), digits, shift))
					);
		out = zpLin(out, zpTimes(moved, k), 1n);
	}
	return out;
}

function zpRemap(x: Zp, map: Map<number, number>): Zp {
	const bytes = new Map<number, bigint>();
	for (const [pos, v] of x.b) {
		const to = map.get(pos) ?? pos;
		bytes.set(to, (bytes.get(to) ?? 0n) + v);
	}
	let out = zpMake(x.w, x.c, x.d, bytes, new Map());
	for (const [id, k] of x.a) {
		const at = atomList[id]!;
		const moved =
			at.op === 'Res'
				? zpRes(BigInt(at.extra), zpRemap(at.args[0] as Zp, map))
				: zpAtom(
						x.w,
						rekey(id, (a) => zpRemap(zpf(a), map))
					);
		out = zpLin(out, zpTimes(moved, k), 1n);
	}
	return out;
}

/** The modulus and the digit matrix of a one byte step whose two digits are each reduced mod one p. */
function zpFacts(f: Form): { modulus: bigint; matrix: bigint[] } {
	const x = zpf(f);
	if (x.w !== 32) return refuse('the state is not 32 bits');
	const { low, high } = zpSplit(x, DIGIT);
	let modulus: bigint | undefined;
	// a digit is one residue atom, or an exact form below the modulus whose atoms ignore the state
	const residue = (digit: Zp) => {
		const only =
			digit.c === 0n &&
			!digit.d[0] &&
			!digit.d[1] &&
			!digit.b.size &&
			digit.a.size === 1 &&
			[...digit.a.values()][0] === 1n;
		const at = only ? atomList[[...digit.a.keys()][0]!]! : undefined;
		if (at?.op !== 'Res') return undefined;
		const q = BigInt(at.extra);
		if (modulus !== undefined && modulus !== q)
			return refuse('the digits reduce by different moduli');
		modulus = q;
		return at.args[0] as Zp;
	};
	const reduced = [low, high].map(residue);
	if (modulus === undefined) return refuse('no digit of the state is reduced');
	const p: bigint = modulus;
	if (p > 1n << BigInt(DIGIT)) return refuse('the modulus does not fit a digit');
	const rows = [low, high].map((digit, i): bigint[] => {
		const g = reduced[i] ?? digit;
		if (!stateFree(zpMake(g.w, 0n, [0n, 0n], g.b, g.a)))
			return refuse('a digit depends on the state through a second reduction');
		if (!reduced[i]) {
			const [lo, hi] = zpSpan(digit);
			if (lo < 0n || hi >= p) return refuse('a digit of the state is not reduced');
		}
		return g.d.map((v) => ((v % p) + p) % p);
	});
	return { modulus: p, matrix: rows.flat() };
}

const pow2 = (v: bigint) => (v > 0n && (v & (v - 1n)) === 0n ? v.toString(2).length - 1 : -1);

const zp: Ring = {
	name: 'zp',
	state(w) {
		if (w !== 32) return refuse('the zp ring holds a 32-bit state');
		return zpMake(w, 0n, [1n, 1n << BigInt(DIGIT)], new Map(), new Map());
	},
	bytes: (pos, width, w) =>
		zpMake(
			w,
			0n,
			[0n, 0n],
			new Map(Array.from({ length: width }, (_, j) => [pos + j, 1n << BigInt(8 * j)])),
			new Map()
		),
	konst: (value, w) => zpMake(w, value, [0n, 0n], new Map(), new Map()),
	asConst(f) {
		const x = zpf(f);
		return !x.d[0] && !x.d[1] && !x.b.size && !x.a.size ? x.c : undefined;
	},
	binary(op, a, b) {
		const x = zpf(a);
		const y = zpf(b);
		sameWidth(x, y);
		const ca = zp.asConst(x);
		const cb = zp.asConst(y);
		switch (op) {
			case 'Add':
				return zpChecked(zpLin(x, y, 1n), op);
			case 'Sub':
				return zpChecked(zpLin(x, y, -1n), op);
			case 'Mul':
				if (cb !== undefined) return zpChecked(zpTimes(x, cb), op);
				if (ca !== undefined) return zpChecked(zpTimes(y, ca), op);
				return refuse('product of two data values');
			case 'Shl':
				if (cb === undefined) return refuse('shift by a data value');
				return zpChecked(zpTimes(x, 1n << (cb & BigInt(x.w - 1))), op);
			case 'ShrU': {
				if (cb === undefined) return refuse('shift by a data value');
				const s = Number(cb & BigInt(x.w - 1));
				return s === 0 ? x : zpSplit(x, s).high;
			}
			case 'And': {
				const c = cb ?? ca;
				const other = cb !== undefined ? x : y;
				if (c === undefined) return refuse('and of two data values');
				const m = mask(x.w);
				if (c === m) return other;
				if (c === 0n) return zp.konst(0n, x.w);
				const lowBits = pow2(c + 1n);
				if (lowBits > 0) return zpSplit(other, lowBits).low;
				const highBits = pow2((~c & m) + 1n);
				if (highBits > 0)
					return zpTimes(zpSplit(other, highBits).high, 1n << BigInt(highBits));
				return refuse('and with a mask that is not a run of low or high bits');
			}
			case 'Or':
				return (
					zpDisjoint(x, y) ??
					zpDisjoint(y, x) ??
					refuse('or of values whose bits may overlap')
				);
			case 'RemU': {
				if (cb === undefined) return refuse('remainder by a data value');
				if (cb < 2n || cb > 1n << BigInt(DIGIT))
					return refuse('remainder by a modulus outside 2 to 65536');
				if (!zpFits(x)) return refuse('remainder of a value that may wrap');
				return zpRes(cb, x);
			}
			default:
				return refuse(`${op} is not affine over zp`);
		}
	},
	unary(op, a) {
		const x = zpf(a);
		switch (op) {
			case 'ExtendU':
				return x.w === 32 ? { ...x, w: 64 } : refuse('extend of a 64-bit value');
			case 'Wrap': {
				const [lo, hi] = zpSpan(x);
				return lo >= 0n && hi <= M32
					? { ...x, w: 32 }
					: refuse('wrap of a value above 32 bits');
			}
			default:
				return refuse(`${op} of a data value is not affine over zp`);
		}
	},
	equal(a, b) {
		const x = zpf(a);
		const y = zpf(b);
		if (
			x.w !== y.w ||
			x.c !== y.c ||
			x.d[0] !== y.d[0] ||
			x.d[1] !== y.d[1] ||
			x.b.size !== y.b.size ||
			x.a.size !== y.a.size
		)
			return false;
		for (const [k, v] of x.b) if (y.b.get(k) !== v) return false;
		for (const [k, v] of x.a) if (y.a.get(k) !== v) return false;
		return true;
	},
	subst(f, y, shift) {
		const s = zpf(y);
		let digits: [Zp, Zp] | undefined;
		return zpSubst(
			zpf(f),
			() => {
				if (!digits) {
					const { low, high } = zpSplit(s, DIGIT);
					digits = [low, high];
				}
				return digits;
			},
			shift
		);
	},
	remap: (f, map) => zpRemap(zpf(f), map),
	parity: () => refuse('parity of a data value is not affine over zp'),
	positions(f) {
		const x = zpf(f);
		const out = new Set([...x.b.keys()]);
		for (const p of atomPositions(x.a.keys(), zp.positions)) out.add(p);
		return [...out].sort((p, q) => p - q);
	},
	operator: (f) => zpFacts(f).matrix,
	modulus: (f) => zpFacts(f).modulus,
	zeroStep(f) {
		// the value at state zero, when every atom is a residue of a form with no atoms
		const value = (x: Zp): bigint | undefined => {
			let sum = x.c;
			for (const [id, k] of x.a) {
				const at = atomList[id]!;
				const inner = at.op === 'Res' ? value(at.args[0] as Zp) : undefined;
				if (inner === undefined) return undefined;
				sum += k * (inner % BigInt(at.extra));
			}
			return x.b.size ? undefined : sum;
		};
		return value(zpf(f));
	},
	lookup: () => refuse('a table lookup is not affine over zp')
};

// #endregion

type MakeAtom = (op: string, w: 32 | 64, extra: string, args: Form[], used: number) => Form;

// the first operation a ring kept as an atom although the state feeds it, for the reason a refusal gives
let opaqueWhy = '';

/**
 * Lets a ring keep an operation it cannot express affinely as an atom. An atom that the state
 * feeds may be stored to memory, which the output proof allows, but never reaches the state
 * itself: `Analysis.check` refuses a result that holds one.
 */
function withAtoms(ring: Ring, make: MakeAtom): void {
	const binary = ring.binary.bind(ring);
	const unary = ring.unary.bind(ring);
	const compare = /^(Eq|Ne|[LG][te][SU])$/;
	ring.binary = (op, a, b) => {
		// a value against itself needs no byte to be known
		if (a.w === b.w && ring.equal(a, b)) {
			if (op === 'And' || op === 'Or') return a;
			if (/^(Eq|Le[SU]|Ge[SU])$/.test(op)) return ring.konst(1n, 32);
			if (/^(Ne|Lt[SU]|Gt[SU])$/.test(op)) return ring.konst(0n, 32);
		}
		try {
			return binary(op, a, b);
		} catch (error) {
			if (!(error instanceof Refusal) || !ATOMIC.has(op)) throw error;
			if (a.w !== b.w) throw error;
			if (!stateFree(a) || !stateFree(b)) opaqueWhy ||= (error as Refusal).message;
			return make(op, compare.test(op) ? 32 : a.w, '', [a, b], compare.test(op) ? 1 : a.w);
		}
	};
	ring.unary = (op, a) => {
		try {
			return unary(op, a);
		} catch (error) {
			if (!(error instanceof Refusal) || !ATOMIC.has(op)) throw error;
			if (!stateFree(a)) opaqueWhy ||= error.message;
			return make(op, op === 'EqZ' ? 32 : a.w, '', [a], op === 'EqZ' ? 1 : a.w);
		}
	};
}

withAtoms(gf2, (op, w, extra, args, used) => {
	const id = internAtom(op, w, extra, args);
	return {
		r: 'gf2',
		w,
		v: Array.from({ length: w }, (_, k) => (k < used ? atomBit(id, k) : 0n))
	};
});
withAtoms(z2w, (op, w, extra, args) =>
	zwNorm(w, 0n, 0n, new Map(), new Map([[internAtom(op, w, extra, args), 1n]]))
);
withAtoms(zp, (op, w, extra, args) => zpAtom(w, internAtom(op, w, extra, args)));

// #endregion

// #region analysis

const MAXPOS = 128n;
const PH = 200;
const IMAGE = 900;
const PAGE = 65536;

interface Segment {
	start: number;
	bytes: Uint8Array;
}

class Mem {
	segments: Segment[];
	over: Map<number, number>;
	reads: [number, number][];
	limit: number;

	constructor(
		segments: Segment[],
		limit: number,
		over = new Map<number, number>(),
		reads: [number, number][] = []
	) {
		this.segments = segments;
		this.limit = limit;
		this.over = over;
		this.reads = reads;
	}

	clone(): Mem {
		return new Mem(this.segments, this.limit, new Map(this.over), this.reads);
	}

	byteAt(address: number): number | undefined {
		const written = this.over.get(address);
		if (written !== undefined) return written;
		// segments are applied in order at instantiation, so the last one that covers a byte wins
		for (let i = this.segments.length - 1; i >= 0; i--) {
			const seg = this.segments[i]!;
			if (address >= seg.start && address < seg.start + seg.bytes.length)
				return seg.bytes[address - seg.start];
		}
		// memory no segment sets is zero when a fresh instance starts; the certificate records the read
		return address < this.limit ? 0 : undefined;
	}

	read(address: number, width: number): bigint {
		let value = 0n;
		for (let i = 0; i < width; i++) {
			const b = this.byteAt(address + i);
			if (b === undefined)
				return refuse(`read of memory at ${address + i} that no segment sets`);
			value |= BigInt(b) << BigInt(8 * i);
		}
		this.reads.push([address, address + width]);
		return value;
	}

	write(address: number, width: number, value: bigint): void {
		if (address + width > this.limit) refuse('store outside the initial memory');
		if (this.over.size >= 65_536) refuse('initialization writes more than 64 KiB');
		for (let i = 0; i < width; i++)
			this.over.set(address + i, Number((value >> BigInt(8 * i)) & 255n));
	}
}

/** Input bytes, in the order a loop iteration touches them, so a read after a write can be told. */
interface Touch {
	store: boolean;
	address: Ctl;
	width: number;
}

interface Generic {
	loads: { address: Ctl; width: number; imm: bigint }[];
	/** Stores of one iteration, each a byte that already passed through `byteOf`. */
	stores: { address: Ctl; value: Form; imm: bigint }[];
	touches: Touch[];
	fresh: Set<number>;
	read: Set<number>;
	written: Set<number>;
}

/** A run of bytes the call wrote, from `start` bytes past the pointer for `length` bytes. */
interface Written {
	start: Ctl;
	length: Ctl;
	/** The value of the single byte, for a single store; a loop leaves none. */
	form?: Form;
}

interface State {
	locals: (Val | undefined)[];
	base: Ctl;
	pending: number;
	pre: Map<number, Form> | undefined;
	mem: Mem;
	gen: Generic | undefined;
	written: Written[];
}

/** The offset immediate of a load or store as the unsigned 32-bit value wasm adds to the address. */
const imm32 = (v: any): bigint => BigInt.asUintN(32, BigInt(v.offset));

const info = (expr: number): any => {
	try {
		return binaryen.getExpressionInfo(expr);
	} catch {
		return refuse(`expression kind ${binaryen.getExpressionId(expr)} has no readable form`);
	}
};

/** The bits of an i32 or i64 constant, or undefined for another type. */
function constBits(v: any): bigint | undefined {
	if (v.type === binaryen.i32) return BigInt(v.value);
	if (v.type !== binaryen.i64) return undefined;
	return typeof v.value === 'bigint'
		? v.value
		: (BigInt(v.value.high) << 32n) | BigInt(v.value.low >>> 0);
}

/** Adds every local that `expr` may set to `out`. Calls run on their own locals and set none of the caller's. */
function assigned(expr: number, out: Set<number>): void {
	const id = binaryen.getExpressionId(expr);
	if (id === binaryen.NopId || id === binaryen.ConstId || id === binaryen.LocalGetId) return;
	const v = info(expr);
	const each = (...kids: (number | undefined)[]) => {
		for (const kid of kids) if (kid) assigned(kid, out);
	};
	switch (id) {
		case binaryen.BlockId:
			return each(...v.children);
		case binaryen.LoopId:
			return each(v.body);
		case binaryen.BreakId:
			return each(v.condition, v.value);
		case binaryen.LocalSetId:
			out.add(v.index);
			return each(v.value);
		case binaryen.UnaryId:
		case binaryen.DropId:
			return each(v.value);
		case binaryen.ReturnId:
			return each(v.value);
		case binaryen.BinaryId:
			return each(v.left, v.right);
		case binaryen.SelectId:
			return each(v.ifTrue, v.ifFalse, v.condition);
		case binaryen.IfId:
			return each(v.condition, v.ifTrue, v.ifFalse);
		case binaryen.LoadId:
			return each(v.ptr);
		case binaryen.StoreId:
			return each(v.ptr, v.value);
		case binaryen.CallId:
			return each(...v.operands);
		default:
			return refuse(`unsupported expression kind ${id}`);
	}
}

const substCtl = (a: Ctl, map: Map<string, Ctl>): Ctl => {
	let out = num(a.c);
	for (const [k, co] of a.s) out = cadd(out, scale(map.get(k) ?? sym(k), co));
	return out;
};

const divideForm = (a: Ctl, den: bigint, how: 'exact' | 'floor' | 'ceil'): Ctl => {
	const s = new Map<string, bigint>();
	for (const [k, v] of a.s) {
		if (v % den !== 0n) return refuse('loop count is not a whole number of steps');
		s.set(k, v / den);
	}
	if (how === 'exact') {
		if (a.c % den !== 0n) return refuse('loop count is not a whole number of steps');
		return norm(a.c / den, s);
	}
	return norm(how === 'floor' ? floorDiv(a.c, den) : ceilDiv(a.c, den), s);
};

interface PathOutcome {
	result: Form;
	pending: number;
	base: Ctl;
	mem: Mem;
	written: Written[];
}

interface Callee {
	body: number;
	types: number[];
}

class Analysis {
	ring: Ring;
	callee: (name: string) => Callee | undefined;
	depth = 0;
	body: number;
	types: number[];
	layout: AffineLayout;
	w: 32 | 64;
	block: number;
	mem0: Mem;
	allowStore: boolean;
	f1: Form | undefined;
	/** The byte the call stores at offset 0 of one byte, as a form of the state and that byte. */
	out1: Form | undefined;
	/** True during the one byte call, which has no transform to compare a store with yet. */
	recording = false;
	zero: 'identity' | 'transforms' | undefined;
	written = new Map<number, number>();
	st!: State;
	ranges: Ranges = new Map();
	iterated = new Map<number, Form>();
	expressions = 0;
	loops = 0;
	paths = 0;

	constructor(
		ring: Ring,
		fn: Callee & { callee: (name: string) => Callee | undefined },
		layout: AffineLayout,
		block: number,
		mem0: Mem,
		allowStore: boolean,
		f1?: Form,
		out1?: Form
	) {
		this.ring = ring;
		this.body = fn.body;
		this.types = fn.types;
		this.callee = fn.callee;
		this.layout = layout;
		this.w = layout.bits;
		this.block = block;
		this.mem0 = mem0;
		this.allowStore = allowStore;
		this.f1 = f1;
		this.out1 = out1;
	}

	// #region evaluation

	exec(expr: number): Val | undefined {
		if (++this.expressions > 6_000_000) refuse('analysis budget exceeded');
		if ((this.expressions & 4095) === 0 && Date.now() > deadline) refuse('analysis time limit');
		const id = binaryen.getExpressionId(expr);
		if (id === binaryen.NopId) return undefined;
		const v = info(expr);
		switch (id) {
			case binaryen.BlockId: {
				const name: string | undefined = v.name || undefined;
				try {
					let last: Val | undefined;
					for (const child of v.children) last = this.exec(child);
					return last;
				} catch (error) {
					if (error instanceof Jump && name !== undefined && error.label === name)
						return error.value;
					throw error;
				}
			}
			case binaryen.LoopId:
				return this.loop(v);
			case binaryen.BreakId: {
				const value = v.value ? this.exec(v.value) : undefined;
				if (!v.condition) throw new Jump(v.name, value);
				const taken = this.truth(this.exec(v.condition));
				if (typeof taken !== 'boolean') throw new Undecided();
				if (taken) throw new Jump(v.name, value);
				return value;
			}
			case binaryen.LocalGetId: {
				const value = this.st.locals[v.index];
				if (!value) return refuse(`local ${v.index} read before it is defined`);
				if (!this.depth && this.st.gen?.fresh.has(v.index)) this.st.gen.read.add(v.index);
				return value;
			}
			case binaryen.LocalSetId: {
				const value = this.exec(v.value);
				if (!value) return refuse('local set without a value');
				if (value.t === 'p') return refuse('a comparison result stored in a local');
				this.st.locals[v.index] = value;
				if (!this.depth && this.st.gen) {
					this.st.gen.fresh.delete(v.index);
					this.st.gen.written.add(v.index);
				}
				return v.isTee ? value : undefined;
			}
			case binaryen.ConstId:
				if (v.type === binaryen.i32) return num(constBits(v)!);
				if (v.type === binaryen.i64)
					return { t: 'd', f: this.ring.konst(BigInt.asUintN(64, constBits(v)!), 64) };
				return refuse('non-integer constant');
			case binaryen.UnaryId:
				return this.unary(v);
			case binaryen.BinaryId:
				return this.binary(v);
			case binaryen.LoadId:
				return this.load(v);
			case binaryen.StoreId:
				return this.store(v);
			case binaryen.IfId: {
				const taken = this.truth(this.exec(v.condition));
				if (typeof taken !== 'boolean') throw new Undecided();
				const arm = taken ? v.ifTrue : v.ifFalse;
				return arm ? this.exec(arm) : undefined;
			}
			case binaryen.SelectId: {
				const a = this.exec(v.ifTrue);
				const b = this.exec(v.ifFalse);
				const taken = this.truth(this.exec(v.condition));
				if (typeof taken !== 'boolean') throw new Undecided();
				return taken ? a : b;
			}
			case binaryen.CallId:
				return this.call(v);
			case binaryen.DropId:
				this.exec(v.value);
				return undefined;
			case binaryen.ReturnId:
				throw new Jump(RETURN, v.value ? this.exec(v.value) : undefined);
			case binaryen.UnreachableId:
				return refuse('unreachable instruction');
			default:
				return refuse(`unsupported expression kind ${id}`);
		}
	}

	/** Runs an internal function on the caller's values, inline. */
	call(v: any): Val | undefined {
		if (v.isReturn) return refuse('tail call');
		if (this.depth >= 8) return refuse('calls nest deeper than eight');
		const target = this.callee(v.target);
		if (!target) return refuse(`call to ${v.target}, which is not a defined function`);
		const args = (v.operands as number[]).map((o) => this.exec(o));
		if (args.some((a) => !a || a.t === 'p')) return refuse('call argument is not a value');
		const frame = target.types.map((type, j): Val | undefined =>
			j < args.length ? args[j] : type === binaryen.i64 ? this.fromConst(64, 0n) : num(0)
		);
		const outer = this.st.locals;
		this.st.locals = frame;
		this.depth++;
		try {
			return this.exec(target.body);
		} catch (error) {
			if (error instanceof Jump && error.label === RETURN) return error.value;
			throw error;
		} finally {
			this.depth--;
			this.st.locals = outer;
		}
	}

	truth(v: Val | undefined): boolean | Prd {
		if (!v) return refuse('branch on a missing value');
		if (v.t === 'p') return v;
		if (v.t === 'd') {
			const c = this.ring.asConst(v.f);
			return c !== undefined ? c !== 0n : refuse('branch on data');
		}
		if (isNum(v)) return v.c !== 0n;
		const r = decide('ne', v, num(0), this.ranges);
		return r.t === 'c' ? r.c !== 0n : r;
	}

	constOf(v: Val): { bits: 32 | 64; v: bigint } | undefined {
		if (v.t === 'c') return isNum(v) ? { bits: 32, v: u32(v.c) } : undefined;
		if (v.t === 'd') {
			const c = this.ring.asConst(v.f);
			return c === undefined ? undefined : { bits: v.f.w, v: c };
		}
		return undefined;
	}

	fromConst(bits: 32 | 64, v: bigint): Val {
		return bits === 32 ? num(v) : { t: 'd', f: this.ring.konst(v, 64) };
	}

	dataOf(v: Val, bits: 32 | 64): Form {
		if (v.t === 'd') return v.f;
		if (v.t === 'c' && isNum(v) && bits === 32) return this.ring.konst(u32(v.c), 32);
		return refuse('a control value used as data');
	}

	unary(v: any): Val {
		const k = UNARY.get(v.op) ?? refuse(`unsupported operation ${v.op}`);
		const a = this.exec(v.value);
		if (!a) return refuse('operand without a value');
		const c = this.constOf(a);
		if (c) {
			const r = evalUnary(k.op, c.bits, c.v);
			return k.op === 'EqZ' ? num(r) : this.fromConst(k.bits, r);
		}
		if (k.op === 'EqZ') {
			if (a.t === 'p') return { t: 'p', rel: negate(a.rel), a: a.a, b: a.b };
			if (a.t === 'c') return decide('eq', a, num(0), this.ranges);
		}
		if (a.t !== 'd') return refuse(`${k.op} of a control value`);
		return { t: 'd', f: this.ring.unary(k.op, a.f) };
	}

	binary(v: any): Val {
		const k = BINARY.get(v.op) ?? refuse(`unsupported operation ${v.op}`);
		if (k.op === 'And') {
			const parity = this.parity(v);
			if (parity) return parity;
		}
		const a = this.exec(v.left);
		const b = this.exec(v.right);
		if (!a || !b) return refuse('operand without a value');
		const ca = this.constOf(a);
		const cb = this.constOf(b);
		if (ca && cb) {
			const r = evalBinary(k.op, k.bits, ca.v, cb.v);
			return COMPARE.has(k.op) ? num(r) : this.fromConst(k.bits, r);
		}
		if (a.t === 'p' || b.t === 'p') return refuse('operation on a comparison result');
		if (a.t === 'c' && b.t === 'c') return this.controlBinary(k.op, a, b);
		return {
			t: 'd',
			f: this.ring.binary(k.op, this.dataOf(a, k.bits), this.dataOf(b, k.bits))
		};
	}

	/** popcnt(x) & 1 over data, which the generic rules would refuse because the count is not affine. */
	parity(v: any): Val | undefined {
		for (const [count, one] of [
			[v.left, v.right],
			[v.right, v.left]
		] as const) {
			if (binaryen.getExpressionId(count) !== binaryen.UnaryId) continue;
			if (binaryen.getExpressionId(one) !== binaryen.ConstId) continue;
			const u = info(count);
			const c = info(one);
			if (UNARY.get(u.op)?.op !== 'Popcnt' || constBits(c) !== 1n) continue;
			const x = this.exec(u.value);
			if (!x) return refuse('operand without a value');
			const cx = this.constOf(x);
			if (cx) return this.fromConst(cx.bits, evalUnary('Popcnt', cx.bits, cx.v) & 1n);
			if (x.t !== 'd') return refuse('population count of a control value');
			return { t: 'd', f: this.ring.parity(x.f) };
		}
		return undefined;
	}

	controlBinary(op: string, a: Ctl, b: Ctl): Val {
		switch (op) {
			case 'Add':
				return cadd(a, b);
			case 'Sub':
				return csub(a, b);
			case 'Mul':
				if (isNum(b)) return scale(a, b.c);
				if (isNum(a)) return scale(b, a.c);
				return refuse('product of two control values');
			case 'Shl':
				if (isNum(b)) return scale(a, 1n << (u32(b.c) & 31n));
				return refuse('shift by a control value');
			case 'And':
				if (isNum(b)) return maskControl(a, u32(b.c));
				if (isNum(a)) return maskControl(b, u32(a.c));
				return refuse('and of two control values');
			case 'ShrU':
				if (isNum(b)) return this.shiftRight(a, Number(u32(b.c) & 31n));
				return refuse('shift by a control value');
			case 'Eq':
				return decide('eq', a, b, this.ranges);
			case 'Ne':
				return decide('ne', a, b, this.ranges);
			case 'LtU':
				return decide('ltu', a, b, this.ranges);
			case 'LeU':
				return decide('leu', a, b, this.ranges);
			case 'GtU':
				return decide('gtu', a, b, this.ranges);
			case 'GeU':
				return decide('geu', a, b, this.ranges);
			default:
				return refuse(`${op} of control values`);
		}
	}

	shiftRight(a: Ctl, s: number): Ctl {
		if (s === 0) return a;
		if (!nowrap(a, this.ranges)) return refuse('shift of a value that may wrap');
		const d = 1n << BigInt(s);
		const terms = new Map<string, bigint>();
		for (const [k, v] of a.s) {
			if (v % d !== 0n) return refuse('shift of a value with low bits set');
			terms.set(k, v / d);
		}
		return norm(floorDiv(a.c, d), terms);
	}

	load(v: any): Val {
		if (v.isAtomic) return refuse('atomic load');
		if (v.type !== binaryen.i32 && v.type !== binaryen.i64) return refuse('non-integer load');
		const bits: 32 | 64 = v.type === binaryen.i64 ? 64 : 32;
		const width: number = v.bytes;
		const addr = this.exec(v.ptr);
		if (!addr || addr.t === 'p') return refuse('load address is not a value');
		const offset = imm32(v);
		if (addr.t === 'd') {
			if (v.isSigned) return refuse('signed table load');
			const read: Reader = (a, wd) => this.st.mem.read(a, wd);
			return { t: 'd', f: this.ring.lookup(addr.f, Number(offset), width, bits, read) };
		}
		if (isNum(addr)) {
			let x = this.st.mem.read(Number(u32(addr.c) + offset), width);
			if (v.isSigned) x = BigInt.asUintN(bits, BigInt.asIntN(8 * width, x));
			return this.fromConst(bits, x);
		}
		const address = cadd(addr, num(offset));
		const gen = this.st.gen;
		if (gen) {
			if (gen.loads.length >= 64) return refuse('more than 64 input loads in one iteration');
			gen.loads.push({ address, width, imm: offset });
			gen.touches.push({ store: false, address, width });
			return this.extended(v, this.ring.bytes(PH + 8 * (gen.loads.length - 1), width, bits));
		}
		const pos = csub(address, this.st.base);
		if (!isNum(pos) || pos.c < 0n || pos.c + BigInt(width) > MAXPOS)
			return refuse('input load not at a fixed offset from the first unfolded byte');
		// the address wraps at 2^32 but the immediate does not, so the two agree only when the position covers it
		if (offset > pos.c) return refuse('a load whose immediate offset exceeds its position');
		const at = csub(address, sym('P0'));
		for (const w of this.st.written)
			if (!this.apart(at, width, w))
				return refuse('an input byte is read after the call wrote it');
		this.ensurePre();
		const c = Number(pos.c);
		this.st.pending = Math.max(this.st.pending, c + width);
		return this.extended(v, this.ring.bytes(c, width, bits));
	}

	/** Applies the sign extension of a signed load to the zero-extended bytes. */
	extended(v: any, loaded: Form): Val {
		const bits: 32 | 64 = v.type === binaryen.i64 ? 64 : 32;
		const extend = { 1: 'Extend8S', 2: 'Extend16S', 4: 'Extend32S' }[v.bytes as 1 | 2 | 4];
		if (!v.isSigned || !extend || v.bytes * 8 === bits) return { t: 'd', f: loaded };
		return { t: 'd', f: this.ring.unary(extend, loaded) };
	}

	/** Whether `width` bytes at offset `at` from the pointer lie wholly outside the run `w`. */
	apart(at: Ctl, width: number, w: Written): boolean {
		const signed = (a: Ctl): [bigint, bigint] => (isNum(a) ? [a.c, a.c] : span(a, this.ranges));
		if (signed(csub(cadd(at, num(width)), w.start))[1] <= 0n) return true;
		return signed(csub(at, cadd(w.start, w.length)))[0] >= 0n;
	}

	store(v: any): undefined {
		if (v.isAtomic) return refuse('atomic store');
		const addr = this.exec(v.ptr);
		const value = this.exec(v.value);
		if (!addr || addr.t === 'p' || !value || value.t === 'p')
			return refuse('store operand is not a value');
		if (addr.t === 'c' && isNum(addr)) {
			if (!this.allowStore || this.st.gen) return refuse('store to memory');
			const cv = this.constOf(value);
			if (!cv) return refuse('store that depends on the input or the state');
			this.st.mem.write(Number(u32(addr.c) + imm32(v)), v.bytes, cv.v);
			return undefined;
		}
		return this.output(v, addr, value);
	}

	/** The low byte of a stored value, as a form. */
	byteOf(value: Val): Form {
		const f = this.dataOf(value, value.t === 'd' ? value.f.w : 32);
		return this.ring.binary('And', f, this.ring.konst(255n, f.w));
	}

	/**
	 * A byte stored at an address that follows the pointer. In a loop it is kept for `summarize`;
	 * otherwise it must be the byte transform of the state before it, which the one byte call defines.
	 */
	output(v: any, addr: Val, value: Val): undefined {
		if (v.bytes !== 1) return refuse('a store of more than one byte');
		if (addr.t !== 'c') return refuse('store address is data');
		const address = cadd(addr, num(imm32(v)));
		const form = this.byteOf(value);
		const gen = this.st.gen;
		if (gen) {
			if (gen.stores.length >= 64) return refuse('more than 64 stores in one iteration');
			gen.stores.push({ address, value: form, imm: imm32(v) });
			gen.touches.push({ store: true, address, width: 1 });
			return undefined;
		}
		const pos = csub(address, this.st.base);
		if (!isNum(pos) || pos.c < 0n || pos.c >= MAXPOS)
			return refuse('store not at a fixed offset from the first unfolded byte');
		if (imm32(v) > pos.c) return refuse('a store whose immediate offset exceeds its position');
		this.ensurePre();
		const c = Number(pos.c);
		if (this.out1) {
			if (!this.ring.equal(form, this.ring.subst(this.out1, this.iterate(c), c)))
				return refuse('a stored byte is not the byte transform of the state before it');
		} else if (!this.recording) return refuse('a store before the one byte output is known');
		this.st.written.push({ start: csub(address, sym('P0')), length: num(1), form });
		return undefined;
	}

	ensurePre(): void {
		if (this.st.pre) return;
		const pre = new Map<number, Form>();
		this.st.locals.forEach((value, j) => {
			if (value?.t !== 'd') return;
			if (this.ring.positions(value.f).length) refuse('state mixed with input bytes');
			pre.set(j, value.f);
		});
		this.st.pre = pre;
	}

	iterate(k: number): Form {
		const cached = this.iterated.get(k);
		if (cached) return cached;
		if (!this.f1) return refuse('no one byte form yet');
		const f =
			k === 0
				? this.ring.state(this.w)
				: this.ring.subst(this.f1, this.iterate(k - 1), k - 1);
		this.iterated.set(k, f);
		return f;
	}

	snapshot(): State {
		const s = this.st;
		return {
			locals: [...s.locals],
			base: s.base,
			pending: s.pending,
			pre: s.pre && new Map(s.pre),
			mem: s.mem.clone(),
			gen: undefined,
			written: [...s.written]
		};
	}

	// #endregion

	// #region loops

	loop(v: any): undefined {
		if (v.type !== binaryen.none && v.type !== binaryen.unreachable)
			return refuse('loop with a result');
		const saved = this.snapshot();
		const nested = this.st.gen !== undefined;
		try {
			for (let i = 0; ; i++) {
				if (i > 4096) throw new Undecided();
				try {
					this.exec(v.body);
					return undefined;
				} catch (error) {
					if (error instanceof Jump && error.label === v.name) continue;
					throw error;
				}
			}
		} catch (error) {
			if (!(error instanceof Undecided)) throw error;
			if (nested) return refuse('a counted loop inside a counted loop');
			this.st = saved;
			this.summarize(v);
			return undefined;
		}
	}

	/** The effect of a counted loop whose length depends on the quotient, by induction over its iterations. */
	summarize(loop: any): void {
		const outer = this.st;
		if (outer.gen || this.depth)
			return refuse('a counted loop inside a counted loop or a call');
		const ring = this.ring;
		const bodyInfo = info(loop.body);
		const stmts: number[] =
			bodyInfo.id === binaryen.BlockId && !bodyInfo.name ? bodyInfo.children : [loop.body];
		const last = info(stmts[stmts.length - 1]!);
		let head: number | undefined;
		let tail: number | undefined;
		let exitLabel = '';
		let work: number[];
		if (
			last.id === binaryen.BreakId &&
			last.name === loop.name &&
			last.condition &&
			!last.value
		) {
			tail = last.condition;
			work = stmts.slice(0, -1);
		} else if (last.id === binaryen.BreakId && last.name === loop.name && !last.condition) {
			const first = info(stmts[0]!);
			if (first.id !== binaryen.BreakId || !first.condition || first.name === loop.name)
				return refuse('loop has no test at its head or its tail');
			head = first.condition;
			exitLabel = first.name;
			work = stmts.slice(1, -1);
		} else return refuse('loop does not end in its back edge');

		this.ensurePre();
		const pre = outer.pre!;
		const heads = new Map<number, string>();
		const writes = new Set<number>();
		for (const s of [head, tail, ...work]) if (s !== undefined) assigned(s, writes);
		const generic = outer.locals.map((value, j): Val | undefined => {
			if (!value) return undefined;
			// a local the loop never sets keeps its value, so its constants and bounds stay exact
			if (!writes.has(j) && value.t === 'c') return value;
			if (
				!writes.has(j) &&
				value.t === 'd' &&
				stateFree(value.f) &&
				!ring.positions(value.f).length
			)
				return value;
			if (value.t === 'c') {
				heads.set(j, `h${j}`);
				return sym(`h${j}`);
			}
			if (value.t === 'd') {
				const f = pre.get(j);
				return f ? { t: 'd', f } : undefined;
			}
			return refuse('a comparison held in a local across a loop');
		});
		const gen: Generic = {
			loads: [],
			stores: [],
			touches: [],
			fresh: new Set(generic.keys()),
			read: new Set(),
			written: new Set()
		};
		this.st = {
			locals: generic,
			base: outer.base,
			pending: 0,
			pre,
			mem: outer.mem.clone(),
			gen,
			written: []
		};
		let cond: Val | undefined;
		try {
			if (head !== undefined) cond = this.exec(head);
			for (const s of work) this.exec(s);
			if (tail !== undefined) cond = this.exec(tail);
		} catch (error) {
			if (error instanceof Undecided)
				return refuse('a branch inside a counted loop is undecided');
			if (error instanceof Jump) return refuse('a branch leaves a counted loop');
			throw error;
		} finally {
			this.st = outer;
		}
		const end = generic;
		this.loops++;
		if (!gen.loads.length) return refuse('counted loop with no input loads');

		const symbolsIn = (value: Val | undefined): string[] =>
			!value
				? []
				: value.t === 'c'
					? [...value.s.keys()]
					: value.t === 'p'
						? [...value.a.s.keys(), ...value.b.s.keys()]
						: [];
		const usedByOthers = (name: string, except: number) =>
			gen.loads.some((l) => l.address.s.has(name)) ||
			symbolsIn(cond).includes(name) ||
			end.some((value, j) => j !== except && symbolsIn(value).includes(name));
		const init = (j: number) => outer.locals[j] as Ctl;
		const delta = new Map<number, bigint>();
		const temps = new Set<number>();
		for (const [j, name] of heads) {
			const value = end[j];
			if (value?.t === 'c') {
				const d = csub(value, sym(name));
				if (isNum(d)) {
					delta.set(j, d.c);
					continue;
				}
			}
			if (usedByOthers(name, j) || (value?.t === 'c' && value.s.has(name)))
				return refuse(`local ${j} does not change by a fixed step`);
			temps.add(j);
		}
		const step = new Map<string, Ctl>();
		for (const [j, name] of heads)
			if (delta.has(j)) step.set(name, cadd(init(j), scale(sym('t'), delta.get(j)!)));

		const base1 = cadd(outer.base, num(outer.pending));
		let stride: bigint | undefined;
		const positions: number[] = [];
		for (const l of gen.loads) {
			const a = substCtl(l.address, step);
			const alpha = a.s.get('t') ?? 0n;
			if (stride === undefined) stride = alpha;
			else if (stride !== alpha) return refuse('loads advance by different strides');
			const c = csub(csub(a, scale(sym('t'), alpha)), base1);
			if (!isNum(c) || c.c < 0n || c.c + BigInt(l.width) > alpha)
				return refuse('a load falls outside its iteration window');
			if (l.imm > c.c) return refuse('a load whose immediate offset exceeds its position');
			positions.push(Number(c.c));
		}
		if (stride === undefined || stride < 1n || stride > 64n)
			return refuse('stride out of range');

		const live = [...gen.read].filter((j) => outer.locals[j]?.t === 'd' && pre.has(j));
		for (const j of live) {
			const have = (outer.locals[j] as Dat).f;
			const want =
				outer.pending === 0
					? pre.get(j)!
					: ring.subst(pre.get(j)!, this.iterate(outer.pending), 0);
			if (!ring.equal(have, want))
				return refuse('state at the loop is not the folded prefix');
		}
		const rename = new Map<number, number>();
		gen.loads.forEach((l, i) => {
			for (let b = 0; b < l.width; b++) rename.set(PH + 8 * i + b, positions[i]! + b);
		});
		for (const j of live) {
			let value = end[j];
			// a step that ignores the state leaves a constant, which is a form with no variables
			if (value?.t === 'c' && isNum(value) && pre.get(j)!.w === 32)
				value = { t: 'd', f: ring.konst(u32(value.c), 32) };
			if (value?.t !== 'd') return refuse('a state local stops holding data');
			const got = ring.remap(value.f, rename);
			const want = ring.subst(pre.get(j)!, this.iterate(Number(stride)), 0);
			if (!ring.equal(got, want))
				return refuse('loop body is not the byte step applied per iteration');
		}

		if (gen.stores.length) {
			if (!this.out1) return refuse('a store in a loop before the one byte output is known');
			const window = (address: Ctl, width: number) => {
				const a = substCtl(address, step);
				if ((a.s.get('t') ?? 0n) !== stride)
					return refuse('a store advances by another stride');
				const c = csub(csub(a, scale(sym('t'), stride)), base1);
				if (!isNum(c) || c.c < 0n || c.c + BigInt(width) > stride)
					return refuse('a store falls outside its iteration window');
				return Number(c.c);
			};
			const where = gen.stores.map((s) => {
				const c = window(s.address, 1);
				if (s.imm > BigInt(c))
					return refuse('a store whose immediate offset exceeds its position');
				return c;
			});
			if (where.length !== Number(stride) || new Set(where).size !== where.length)
				return refuse(
					'the stores of one iteration do not write each byte of its window once'
				);
			gen.stores.forEach((s, k) => {
				const got = ring.remap(s.value, rename);
				const want = ring.subst(this.out1!, this.iterate(where[k]!), where[k]!);
				if (!ring.equal(got, want))
					refuse('a stored byte is not the byte transform of the state before it');
			});
			const spots = gen.touches.map((t) => ({ ...t, at: window(t.address, t.width) }));
			spots.forEach((s, i) => {
				if (!s.store) return;
				for (const l of spots.slice(i + 1))
					if (!l.store && l.at < s.at + s.width && s.at < l.at + l.width)
						refuse('an input byte is read after the loop wrote it');
			});
		}

		// a state copy written in the loop that equals a live local's next value holds that local's form afterwards
		const copies = new Map<number, Form>();
		for (const j of gen.written) {
			const value = end[j];
			if (value?.t !== 'd' || live.includes(j)) continue;
			const got = ring.remap(value.f, rename);
			for (const form of pre.values())
				if (ring.equal(got, ring.subst(form, this.iterate(Number(stride)), 0))) {
					copies.set(j, form);
					break;
				}
		}

		const trips = this.trips(cond, tail !== undefined, step);
		const T = tail !== undefined ? cadd(trips, num(1)) : trips;
		if (span(T, this.ranges)[0] < (tail !== undefined ? 1n : 0n))
			return refuse('loop trip count may be negative');
		// the bytes the loop covers are computed as a form that wraps at 2^32, so they must not reach it
		if (span(T, this.ranges)[1] * stride > M32)
			return refuse('loop covers more than 2^32 bytes');

		const before = tail !== undefined ? csub(T, num(1)) : undefined;
		const lastStep = new Map<string, Ctl>();
		if (before)
			for (const [j, name] of heads)
				if (delta.has(j)) lastStep.set(name, cadd(init(j), scale(before, delta.get(j)!)));
		const locals = [...outer.locals];
		end.forEach((value, j) => {
			if (heads.has(j) && delta.has(j)) {
				locals[j] = cadd(init(j), scale(T, delta.get(j)!));
			} else if (live.includes(j)) {
				locals[j] = { t: 'd', f: pre.get(j)! };
			} else if (copies.has(j) && span(T, this.ranges)[0] >= 1n) {
				locals[j] = { t: 'd', f: copies.get(j)! };
			} else if (value?.t === 'c' && before && gen.written.has(j)) {
				locals[j] = substCtl(value, lastStep);
			} else if (
				gen.written.has(j) ||
				heads.has(j) ||
				(outer.locals[j]?.t === 'd' && !this.keeps(outer.locals[j] as Dat, writes.has(j)))
			) {
				locals[j] = undefined;
			}
		});
		this.st = {
			locals,
			base: cadd(base1, scale(T, stride)),
			pending: 0,
			pre,
			mem: outer.mem,
			gen: undefined,
			written: gen.stores.length
				? [...outer.written, { start: csub(base1, sym('P0')), length: scale(T, stride) }]
				: outer.written
		};
		if (head !== undefined) throw new Jump(exitLabel, undefined);
	}

	/** Whether a data local that the loop does not set still holds its value afterwards. */
	keeps(value: Dat, set: boolean): boolean {
		return !set && stateFree(value.f) && !this.ring.positions(value.f).length;
	}

	/** The number of iterations of the loop, as a form over the quotient. */
	trips(cond: Val | undefined, tail: boolean, step: Map<string, Ctl>): Ctl {
		if (!cond || cond.t === 'd') return refuse('loop test is not a control value');
		let rel: Rel;
		let a: Ctl;
		let b: Ctl;
		if (cond.t === 'p') [rel, a, b] = [cond.rel, cond.a, cond.b];
		else [rel, a, b] = ['ne', cond, num(0)];
		const exit = tail ? negate(rel) : rel;
		a = substCtl(a, step);
		b = substCtl(b, step);
		const d = csub(a, b);
		const slope = d.s.get('t') ?? 0n;
		const d0 = norm(d.c, new Map([...d.s].filter(([k]) => k !== 't')));
		for (const k of d0.s.keys())
			if (k !== 'Q') return refuse('loop test depends on the pointer');
		const [lo0, hi0] = span(d0, this.ranges);
		if (lo0 <= -(1n << 32n) || hi0 >= 1n << 32n) return refuse('loop test may wrap');
		let first: Ctl;
		if (exit === 'eq') {
			if (slope === 0n) {
				if (!(isNum(d0) && d0.c === 0n)) return refuse('loop test never changes');
				first = num(0);
			} else first = divideForm(scale(d0, -1n), slope, 'exact');
		} else if (exit === 'ne') {
			if (lo0 > 0n || hi0 < 0n) first = num(0);
			else if (isNum(d0) && slope !== 0n) first = num(1);
			else return refuse('loop exit is not decided');
		} else {
			const sign = exit === 'ltu' || exit === 'leu' ? 1n : -1n;
			const strict = exit === 'ltu' || exit === 'gtu';
			const e0 = scale(d0, sign);
			const s = slope * sign;
			const [lo, hi] = span(e0, this.ranges);
			const holds = strict ? hi < 0n : hi <= 0n;
			const fails = strict ? lo >= 0n : lo > 0n;
			if (holds) first = num(0);
			else if (!fails || s >= 0n) return refuse('loop exit is not reached');
			else
				first = strict
					? cadd(divideForm(e0, -s, 'floor'), num(1))
					: divideForm(e0, -s, 'ceil');
			const at = (x: Ctl) => {
				const m = new Map([['t', x]]);
				return [substCtl(a, m), substCtl(b, m)];
			};
			for (const x of [num(0), first])
				for (const value of at(x))
					if (!nowrap(value, this.ranges)) return refuse('loop test values may wrap');
		}
		if (span(first, this.ranges)[0] < 0n) return refuse('loop exits before it starts');
		return first;
	}

	// #endregion

	// #region paths

	run(n: number | undefined, r: number): PathOutcome {
		this.paths++;
		const { layout, w } = this;
		const locals: (Val | undefined)[] = this.types.map((type, j) => {
			if (j === layout.state) return { t: 'd', f: this.ring.state(w) };
			if (j === layout.ptr) return sym('P0');
			if (j === layout.len)
				return n !== undefined ? num(n) : cadd(scale(sym('Q'), BigInt(this.block)), num(r));
			if (type !== binaryen.i32 && type !== binaryen.i64) return undefined;
			return type === binaryen.i64 ? this.fromConst(64, 0n) : num(0);
		});
		this.ranges = new Map();
		if (n === undefined) this.ranges.set('Q', [1n, (M32 - BigInt(r)) / BigInt(this.block)]);
		this.st = {
			locals,
			base: sym('P0'),
			pending: 0,
			pre: undefined,
			mem: this.mem0.clone(),
			gen: undefined,
			written: []
		};
		let value: Val | undefined;
		try {
			value = this.exec(this.body);
		} catch (error) {
			if (error instanceof Jump && error.label === RETURN) value = error.value;
			else if (error instanceof Jump) return refuse('branch to an unknown label');
			else if (error instanceof Undecided) return refuse('a branch is undecided');
			else throw error;
		}
		if (!value || value.t === 'p') return refuse('the function does not return a value');
		const result =
			value.t === 'd'
				? value.f
				: isNum(value) && w === 32
					? this.ring.konst(u32(value.c), 32)
					: refuse('the result is not data');
		if (result.w !== w) return refuse('result width differs from the state');
		for (const [address, byte] of this.st.mem.over) {
			const had = this.written.get(address);
			if (had !== undefined && had !== byte) refuse('paths initialize memory differently');
			this.written.set(address, byte);
		}
		return {
			result,
			pending: this.st.pending,
			base: this.st.base,
			mem: this.st.mem,
			written: this.st.written
		};
	}

	/**
	 * Once the one byte call has written its byte, every call must write the bytes from the pointer
	 * up to its length, each once. Each store was already compared with the transform of the byte.
	 */
	tile(written: Written[], length: Ctl, first: boolean): void {
		if (!written.length) {
			if (this.out1) refuse('the call stops writing the output');
			return;
		}
		let end = num(0);
		const rest = [...written];
		while (rest.length) {
			const i = rest.findIndex((w) => ceq(w.start, end));
			if (i < 0)
				return refuse('the bytes written do not follow one another from the pointer');
			const w = rest.splice(i, 1)[0]!;
			end = cadd(w.start, w.length);
		}
		if (!ceq(end, length)) return refuse('the bytes written do not cover the input');
		if (first && !this.out1) {
			const form = written[0]!.form;
			if (!form || this.ring.positions(form).some((p) => p !== 0))
				return refuse('the output byte reads past its byte');
			this.out1 = form;
		}
	}

	check(n: number | undefined, r: number): void {
		this.recording = n === 1 && this.out1 === undefined;
		const out = this.run(n, r);
		const ring = this.ring;
		if (opaque(ring, out.result))
			return refuse(`the state passes through an operation that is not affine: ${opaqueWhy}`);
		if (n === 0) {
			if (out.written.length) return refuse('a call over zero bytes writes memory');
			if (out.pending !== 0) return refuse('a zero length call reads input');
			this.zero = ring.equal(out.result, ring.state(this.w)) ? 'identity' : 'transforms';
			return;
		}
		const length = n !== undefined ? num(n) : cadd(scale(sym('Q'), BigInt(this.block)), num(r));
		const covered = cadd(out.base, num(out.pending));
		if (!ceq(covered, cadd(sym('P0'), length)))
			return refuse('folded bytes differ from the length');
		this.tile(out.written, length, n === 1);
		if (n === 1) {
			if (this.f1) {
				if (!ring.equal(out.result, this.f1))
					return refuse('byte step differs after initialization');
				return;
			}
			if (ring.positions(out.result).some((p) => p !== 0))
				return refuse('byte step reads past its byte');
			this.f1 = out.result;
			return;
		}
		let same = ring.equal(out.result, this.iterate(out.pending));
		if (!same && span(csub(out.base, sym('P0')), this.ranges)[0] >= 1n) {
			// the folded prefix is itself one byte step, so a state that was masked or normalized is already in range
			// the image byte sits above every input position and placeholder, so it cannot merge with a real byte
			const image = ring.subst(this.f1!, ring.state(this.w), IMAGE);
			same = ring.equal(
				ring.subst(out.result, image, 0),
				ring.subst(this.iterate(out.pending), image, 0)
			);
		}
		if (!same)
			return refuse(
				n !== undefined
					? `length ${n} is not the fold of the byte step`
					: `remainder ${r} is not the fold of the byte step`
			);
	}

	runAll(): void {
		this.check(1, 0);
		this.check(0, 0);
		for (let n = 2; n < this.block; n++) this.check(n, 0);
		for (let r = 0; r < this.block; r++) this.check(undefined, r);
	}

	// #endregion
}

/**
 * `a & m` when every symbol coefficient is a multiple of 2^j: the low j bits come from the constant
 * alone, and the bits from j up are either all dropped or all kept by the mask.
 */
const maskControl = (a: Ctl, m: bigint): Ctl => {
	if (m === M32) return a;
	if (m === 0n) return num(0);
	if (isNum(a)) return num(u32(a.c) & m);
	let j = 32n;
	for (const v of a.s.values()) {
		const trailing = BigInt(v === 0n ? 32 : (v & -v).toString(2).length - 1);
		if (trailing < j) j = trailing;
	}
	if (j === 0n) return refuse('and of a value with low bits set');
	const unit = (1n << j) - 1n;
	const c = u32(a.c);
	if ((m & ~unit & M32) === 0n) return num(c & m);
	if ((m | unit) === M32) return norm((c & ~unit & M32) | (c & m & unit), a.s);
	return refuse('and with a mask that splits the symbolic bits');
};

// #endregion

// #region certificates

const compactImports = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

const merge = (ranges: [number, number][]): [number, number][] => {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const [start, end] of sorted) {
		const top = out[out.length - 1];
		if (top && start <= top[1]) top[1] = Math.max(top[1], end);
		else out.push([start, end]);
	}
	return out;
};

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

function certifyRing(
	ring: Ring,
	fn: Callee & { callee: (name: string) => Callee | undefined },
	layout: AffineLayout,
	block: number,
	segments: Segment[],
	limit: number,
	entry: string,
	moduleSha256: string
): StreamCertificate {
	const fresh = new Analysis(ring, fn, layout, block, new Mem(segments, limit), true);
	fresh.runAll();
	let final = fresh;
	if (fresh.written.size) {
		const warm = new Mem(segments, limit, new Map(fresh.written));
		final = new Analysis(ring, fn, layout, block, warm, false, fresh.f1, fresh.out1);
		final.runAll();
	}
	const f1 = fresh.f1!;
	const step = ring.positions(f1).length === 0 ? ring.zeroStep(f1) : undefined;
	const operator = ring.operator(f1);
	const model: AffineModel = {
		kind: 'model',
		ring: ring.name,
		bits: layout.bits,
		align: 1,
		layout,
		operator,
		...(ring.modulus ? { modulus: ring.modulus(f1), digits: 2 } : {}),
		calls: 0,
		checks: []
	};
	const reads = merge(final.mem0.reads);
	const image: CertificateRange[] = reads.map(([start, end]) => {
		const bytes = Array.from({ length: end - start }, (_, i) => final.mem0.byteAt(start + i)!);
		return {
			address: start,
			length: end - start,
			sha256: createHash('sha256').update(Uint8Array.from(bytes)).digest('hex')
		};
	});
	const addresses = [...fresh.written.keys()].sort((a, b) => a - b);
	const initialization: CertificateWrite[] = [];
	for (const address of addresses) {
		const top = initialization[initialization.length - 1];
		const byte = fresh.written.get(address)!;
		if (top && top.address + top.hex.length / 2 === address) top.hex += hex([byte]);
		else initialization.push({ address, hex: hex([byte]) });
	}
	const exclusions = merge([
		...reads,
		...fresh.mem0.reads,
		...initialization.map((w): [number, number] => [w.address, w.address + w.hex.length / 2])
	]);
	return {
		kind: 'certificate',
		schema: 'folio.certificate.v1',
		checker: CHECKER,
		moduleSha256,
		entry,
		ring: ring.name,
		bits: layout.bits,
		block,
		layout,
		model,
		...(fresh.out1
			? { output: { inPlace: true as const, ...(step === undefined ? {} : { step }) } }
			: {}),
		zeroLength: fresh.zero!,
		image,
		initialization,
		exclusions,
		stats: {
			paths: fresh.paths + (final === fresh ? 0 : final.paths),
			loops: fresh.loops + (final === fresh ? 0 : final.loops),
			expressions: fresh.expressions + (final === fresh ? 0 : final.expressions)
		}
	};
}

/**
 * Decides whether `entry(state, ptr, len)` in `bytes` is the byte fold of one affine step, for every
 * length of at least one byte. The proof runs the function symbolically: lengths below `block`
 * one by one, and every other length as `block * q + r` for each remainder r with `q` symbolic.
 * A loop whose trip count depends on `q` is summarized by induction over its iterations. The
 * checker either returns a certificate or the reason it could not prove the claim. Refusing says
 * nothing about the function, and an internal failure is also a refusal.
 */
export function certifyStream(
	bytes: Uint8Array,
	entry: string,
	options: CertifyOptions = {}
): StreamCertificate | CertificateRefusal {
	const blocks = options.block === undefined ? [4, 16] : [options.block];
	let result: StreamCertificate | CertificateRefusal | undefined;
	const started = Date.now();
	for (const block of blocks) {
		result = certifyAt(bytes, entry, options, block, started);
		if (result.kind === 'certificate') break;
	}
	return result!;
}

/** The number of memories a module declares, from its memory section. */
function memoryCount(bytes: Uint8Array): number {
	let cursor = 8;
	const leb = () => {
		let value = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = bytes[cursor++] ?? 0;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128 && cursor < bytes.length);
		return value;
	};
	while (cursor < bytes.length) {
		const id = bytes[cursor++]!;
		const length = leb();
		const end = cursor + length;
		if (id === 5) return leb();
		cursor = end;
	}
	return 0;
}

function certifyAt(
	bytes: Uint8Array,
	entry: string,
	options: CertifyOptions,
	block: number,
	started: number
): StreamCertificate | CertificateRefusal {
	resetAtoms();
	opaqueWhy = '';
	deadline = started + (options.maxMs ?? 30_000);
	const attempts: { ring: CertifiedRing; reason: string }[] = [];
	const fail = (reason: string): CertificateRefusal => ({ kind: 'refusal', reason, attempts });
	if (options.ring !== undefined && !['gf2', 'z2w', 'zp'].includes(options.ring))
		return fail('unknown ring');
	if (!Number.isSafeInteger(block) || block < 2 || block > 64 || (block & (block - 1)) !== 0)
		return fail('block must be a power of two from 2 to 64');
	let native: WebAssembly.Module;
	try {
		native = new WebAssembly.Module(Uint8Array.from(bytes));
	} catch {
		return fail('the bytes are not a valid module');
	}
	if (WebAssembly.Module.imports(native).length) return fail('the module has imports');
	if (memoryCount(bytes) > 1) return fail('the module has more than one memory');
	let module: binaryen.Module;
	try {
		module = binaryen.readBinary(bytes);
	} catch {
		return fail('the module cannot be read');
	}
	try {
		module.setFeatures(binaryen.Features.All & ~compactImports);
		if (module.getStart() !== 0) return fail('the module has a start function');
		const memory = module.getMemoryInfo();
		if (memory.shared || memory.is64) return fail('the memory is shared or 64-bit');
		const exported = module.getExport(entry);
		if (!exported) return fail(`no export named ${entry}`);
		const target = binaryen.getExportInfo(exported);
		if (target.kind !== binaryen.ExternalFunction) return fail(`${entry} is not a function`);
		const fn = binaryen.getFunctionInfo(module.getFunction(target.value));
		const params = binaryen.expandType(fn.params);
		const slot = options.layout ?? { state: 0, ptr: 1, len: 2 };
		if (params.length !== 3 || new Set([slot.state, slot.ptr, slot.len]).size !== 3)
			return fail('the entry takes other than three parameters');
		const stateType = params[slot.state];
		if (stateType !== binaryen.i32 && stateType !== binaryen.i64)
			return fail('the state is not an integer');
		if (fn.results !== stateType) return fail('the result type differs from the state type');
		if (params[slot.ptr] !== binaryen.i32 || params[slot.len] !== binaryen.i32)
			return fail('the pointer and length are not i32');
		const types = [...params, ...fn.vars];
		const layout: AffineLayout = {
			entry,
			state: slot.state,
			ptr: slot.ptr,
			len: slot.len,
			bits: stateType === binaryen.i64 ? 64 : 32
		};
		const segments: Segment[] = [];
		const count: number = (module as any).getNumDataSegments();
		for (let i = 0; i < count; i++) {
			let seg: any;
			try {
				seg = (module as any).getDataSegmentInfo((module as any).getDataSegmentByIndex(i));
			} catch {
				return fail('a data segment offset is not a plain constant');
			}
			if (seg.passive) return fail('the module has a passive data segment');
			segments.push({ start: seg.offset, bytes: new Uint8Array(seg.data) });
		}
		const sha = createHash('sha256').update(bytes).digest('hex');
		for (const ring of options.ring ? [{ gf2, z2w, zp }[options.ring]] : [gf2, z2w, zp]) {
			try {
				return certifyRing(
					ring,
					{
						body: fn.body,
						types,
						callee: (name) => {
							const found = module.getFunction(name);
							if (!found) return undefined;
							const f = binaryen.getFunctionInfo(found);
							return {
								body: f.body,
								types: [...binaryen.expandType(f.params), ...f.vars]
							};
						}
					},
					layout,
					block,
					segments,
					memory.initial * PAGE,
					entry,
					sha
				);
			} catch (error) {
				attempts.push({
					ring: ring.name,
					reason:
						error instanceof Refusal
							? error.message
							: `internal: ${(error as Error).message}`
				});
			}
		}
		return fail(attempts.map((a) => `${a.ring}: ${a.reason}`).join('; '));
	} finally {
		module.dispose();
	}
}

/** Re-derives the certificate from the module and compares everything except the work counters. */
export function verifyCertificate(bytes: Uint8Array, certificate: StreamCertificate): boolean {
	if (certificate.checker !== CHECKER || certificate.schema !== 'folio.certificate.v1')
		return false;
	const again = certifyStream(bytes, certificate.entry, {
		layout: certificate.layout,
		block: certificate.block,
		ring: certificate.ring
	});
	if (again.kind !== 'certificate') return false;
	const strip = ({ stats: _stats, ...rest }: StreamCertificate) =>
		JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
	return strip(again) === strip(certificate);
}

/** Whether `[ptr, ptr + len)` lies in memory and clear of every byte the proof depends on. */
export function guardInput(
	certificate: StreamCertificate,
	memoryBytes: number,
	pointer: number,
	length: number
): boolean {
	if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 0 || memoryBytes > 4294967296)
		return false;
	if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length)) return false;
	if (pointer < 0 || length < 0 || pointer > 4294967295) return false;
	const start = pointer;
	const end = start + length;
	if (end > memoryBytes) return false;
	return certificate.exclusions.every(([from, to]) => end <= from || start >= to);
}

// #endregion
