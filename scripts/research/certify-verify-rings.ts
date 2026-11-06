import { createHash } from 'node:crypto';

// one implementation per ring, none shared with src/certify.ts

export type W = 32 | 64;

export class Refuse extends Error {}
export const refuse = (why: string): never => {
	throw new Refuse(why);
};

export interface G {
	r: 'gf2';
	w: W;
	v: bigint[];
}
export interface Z {
	r: 'z2w';
	w: W;
	c: bigint;
	y: bigint;
	b: Map<number, bigint>;
	a: Map<number, bigint>;
}
export interface P {
	r: 'zp';
	w: W;
	c: bigint;
	d: [bigint, bigint];
	b: Map<number, bigint>;
	a: Map<number, bigint>;
}
export type Form = G | Z | P;

export type Op =
	| { k: 'gf2'; cols: bigint[] }
	| { k: 'z2w'; m: bigint; bits: W }
	| { k: 'zp'; p: bigint; mat: bigint[] };

export interface Ring {
	name: 'gf2' | 'z2w' | 'zp';
	state(w: W): Form;
	byte(pos: number): Form;
	konst(v: bigint, w: W): Form;
	asConst(f: Form): bigint | undefined;
	bin(op: string, w: W, a: Form, b: Form): Form;
	un(op: string, w: W, a: Form): Form;
	assemble(parts: Form[], w: W): Form;
	split(f: Form, k: number): Form[];
	lookup(
		addr: Form,
		offset: number,
		width: number,
		read: (a: number) => number,
		memory: number
	): { value: Form; reads: number[] };
	select(w: W, a: Form, b: Form, c: Form): Form;
	key(f: Form): string;
	stateful(f: Form): boolean;
	hasBytes(f: Form): boolean;
	linear(f: Form, bits: W): Op;
	zeroConst(f: Form): bigint | undefined;
	opApply(op: Op, x: bigint): bigint;
	opPow(op: Op, n: number): Op;
	opEq(a: Op, b: Op): boolean;
}

// #region concrete arithmetic

export const MASK = (w: number) => (1n << BigInt(w)) - 1n;

export function cbin(op: string, w: W, a: bigint, b: bigint): bigint {
	const m = MASK(w);
	const sa = BigInt.asIntN(w, a);
	const sb = BigInt.asIntN(w, b);
	const sh = b % BigInt(w);
	const t = (x: boolean) => (x ? 1n : 0n);
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
			return BigInt.asUintN(w, sa >> sh);
		case 'RotL':
			return ((a << sh) | (a >> (BigInt(w) - sh))) & m;
		case 'RotR':
			return ((a >> sh) | (a << (BigInt(w) - sh))) & m;
		case 'Eq':
			return t(a === b);
		case 'Ne':
			return t(a !== b);
		case 'LtU':
			return t(a < b);
		case 'LeU':
			return t(a <= b);
		case 'GtU':
			return t(a > b);
		case 'GeU':
			return t(a >= b);
		case 'LtS':
			return t(sa < sb);
		case 'LeS':
			return t(sa <= sb);
		case 'GtS':
			return t(sa > sb);
		case 'GeS':
			return t(sa >= sb);
		case 'DivU':
			return b === 0n ? refuse('division by zero traps') : a / b;
		case 'RemU':
			return b === 0n ? refuse('division by zero traps') : a % b;
		case 'DivS':
		case 'RemS':
			if (b === 0n || (sa === -(1n << BigInt(w - 1)) && sb === -1n))
				return refuse('signed division traps');
			return BigInt.asUintN(w, op === 'DivS' ? sa / sb : sa % sb);
	}
	return refuse(`operation ${op}`);
}

export function cun(op: string, w: W, a: bigint): bigint {
	switch (op) {
		case 'EqZ':
			return a === 0n ? 1n : 0n;
		case 'Clz': {
			let n = 0;
			while (n < w && !((a >> BigInt(w - 1 - n)) & 1n)) n++;
			return BigInt(n);
		}
		case 'Ctz': {
			let n = 0;
			while (n < w && !((a >> BigInt(n)) & 1n)) n++;
			return BigInt(n);
		}
		case 'Popcnt': {
			let n = 0n;
			for (let x = a; x; x >>= 1n) n += x & 1n;
			return n;
		}
		case 'Extend8S':
			return BigInt.asUintN(w, BigInt.asIntN(8, a));
		case 'Extend16S':
			return BigInt.asUintN(w, BigInt.asIntN(16, a));
		case 'Extend32S':
			return BigInt.asUintN(w, BigInt.asIntN(32, a));
		case 'Wrap':
			return a & MASK(32);
		case 'ExtendU':
			return a & MASK(32);
		case 'ExtendS':
			return BigInt.asUintN(64, BigInt.asIntN(32, a));
	}
	return refuse(`operation ${op}`);
}

const COMPARES = new Set([
	'EqZ',
	'Eq',
	'Ne',
	'LtU',
	'LeU',
	'GtU',
	'GeU',
	'LtS',
	'LeS',
	'GtS',
	'GeS'
]);
const resultWidth = (op: string, w: W): number =>
	COMPARES.has(op) || op === 'Wrap' ? 32 : op === 'ExtendU' || op === 'ExtendS' ? 64 : w;

// #endregion

// #region atoms

interface AtomInfo {
	ow: number;
	args: Form[];
	extra: string;
	op: string;
	stateful: boolean;
	lo: bigint;
	hi: bigint;
}

let atomIds = new Map<string, number>();
let atomInfo: AtomInfo[] = [];
const keyCache = new WeakMap<object, string>();

// every atom keeps its argument forms alive and a gf2 atom form holds a bigint as long as its id,
// so retained memory grows with the square of the atom count; this bounds the estimate
export const ATOM_BYTES = 256 * 1024 * 1024;
let atomLeft = ATOM_BYTES;

export const resetAtoms = (budget = ATOM_BYTES) => {
	atomIds = new Map();
	atomInfo = [];
	atomLeft = budget;
};

const formBytes = (f: Form): number =>
	f.r === 'gf2'
		? f.v.reduce((s, x) => s + (x > 1n ? x.toString(16).length / 2 : 0) + 8, 0)
		: 64 * (f.b.size + f.a.size + 1);

const big = (m: Map<number, bigint>) =>
	[...m]
		.sort((p, q) => p[0] - q[0])
		.map(([k, v]) => `${k}=${v}`)
		.join(',');

export function formKey(f: Form): string {
	const cached = keyCache.get(f);
	if (cached !== undefined) return cached;
	let s =
		f.r === 'gf2'
			? `g${f.w}:${f.v.map((x) => x.toString(16)).join('.')}`
			: f.r === 'z2w'
				? `z${f.w}:${f.c}:${f.y}:${big(f.b)}:${big(f.a)}`
				: `p${f.w}:${f.c}:${f.d.join('.')}:${big(f.b)}:${big(f.a)}`;
	if (s.length > 200) s = 'h' + createHash('sha1').update(s).digest('hex');
	keyCache.set(f, s);
	return s;
}

const ATOM0 = 65 + 8 * 4096;
const STATE = ((1n << 64n) - 1n) << 1n;
const BLOCK = (1n << 64n) - 1n;

function gAtomIds(union: bigint): number[] {
	const out: number[] = [];
	let rest = union >> BigInt(ATOM0);
	for (let id = 0; rest; id++, rest >>= 64n) if (rest & BLOCK) out.push(id);
	return out;
}

function statefulForm(f: Form): boolean {
	if (f.r === 'gf2') {
		let u = 0n;
		for (const x of f.v) u |= x;
		if (u & STATE) return true;
		return gAtomIds(u).some((id) => atomInfo[id]!.stateful);
	}
	if (f.r === 'z2w') {
		if (f.y !== 0n) return true;
	} else if (f.d[0] !== 0n || f.d[1] !== 0n) return true;
	for (const id of f.a.keys()) if (atomInfo[id]!.stateful) return true;
	return false;
}

function makeAtom(
	op: string,
	ow: number,
	args: Form[],
	extra: string,
	lo = 0n,
	hi = MASK(ow)
): number {
	const key = `${op}|${ow}|${extra}|${args.map(formKey).join('|')}`;
	let id = atomIds.get(key);
	if (id === undefined) {
		if (atomInfo.length >= 20000) refuse('too many atoms');
		id = atomInfo.length;
		const own = op === 'Table' && args[0]?.r === 'gf2' ? ow * (ATOM0 / 8 + 8 * id) : 0;
		atomLeft -= args.reduce((s, f) => s + formBytes(f), 0) + own;
		if (atomLeft < 0) refuse('the symbolic state outgrew its memory bound');
		atomInfo.push({ op, ow, args, extra, stateful: args.some(statefulForm), lo, hi });
		atomIds.set(key, id);
	}
	return id;
}

// #endregion

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

// #region gf2

const bitVar = (pos: number, bit: number) => 1n << BigInt(65 + 8 * pos + bit);

class NonLinear extends Error {}

const and1 = (x: bigint, y: bigint): bigint => {
	if (x === 0n || y === 0n) return 0n;
	if (x === 1n) return y;
	if (y === 1n) return x;
	if (x === y) return x;
	throw new NonLinear();
};

const gOf = (f: Form): G => (f.r === 'gf2' ? f : (refuse('mixed rings') as never));
const gMake = (w: W, v: bigint[]): G => ({ r: 'gf2', w, v });
const gZero = (w: W) => Array.from({ length: w }, () => 0n);

function gAtom(op: string, ow: number, w: W, args: Form[], extra = ''): G {
	const id = makeAtom(op, ow, args, extra);
	const v = gZero(w);
	for (let k = 0; k < ow && k < w; k++) v[k] = 1n << BigInt(ATOM0 + 64 * id + k);
	return gMake(w, v);
}

function gAdd(a: bigint[], b: bigint[], carry: bigint): bigint[] {
	const out: bigint[] = [];
	let c = carry;
	for (let k = 0; k < a.length; k++) {
		const x = a[k]!;
		const y = b[k]!;
		out.push(x ^ y ^ c);
		c = and1(x, y) ^ and1(x, c) ^ and1(y, c);
	}
	return out;
}

const gShl = (v: bigint[], s: number) => v.map((_, k) => (k >= s ? v[k - s]! : 0n));

const gConst = (f: G): bigint | undefined => {
	let out = 0n;
	for (let k = 0; k < f.v.length; k++) {
		const x = f.v[k]!;
		if (x === 1n) out |= 1n << BigInt(k);
		else if (x !== 0n) return undefined;
	}
	return out;
};

const gfApply = (cols: bigint[], x: bigint): bigint => {
	let out = 0n;
	for (let k = 0; x; k++, x >>= 1n) if (x & 1n) out ^= cols[k]!;
	return out;
};

const gfMul = (a: bigint[], b: bigint[]) => b.map((c) => gfApply(a, c));

export const gf2: Ring = {
	name: 'gf2',
	state(w) {
		return gMake(
			w,
			Array.from({ length: w }, (_, k) => 1n << BigInt(1 + k))
		);
	},
	byte(pos) {
		if (pos >= 4096) refuse('input position too large');
		const v = gZero(32);
		for (let k = 0; k < 8; k++) v[k] = bitVar(pos, k);
		return gMake(32, v);
	},
	konst(x, w) {
		return gMake(
			w,
			Array.from({ length: w }, (_, k) => ((x >> BigInt(k)) & 1n ? 1n : 0n))
		);
	},
	asConst(f) {
		return gConst(gOf(f));
	},
	bin(op, w, af, bf) {
		const a = gOf(af).v;
		const b = gOf(bf).v;
		const ow = resultWidth(op, w);
		const atom = () => gAtom(op, ow, ow as W, [af, bf]);
		const cb = gConst(gOf(bf));
		try {
			switch (op) {
				case 'Xor':
					return gMake(
						w,
						a.map((x, k) => x ^ b[k]!)
					);
				case 'And':
				case 'Or': {
					const out = a.map((x, k) => {
						const y = b[k]!;
						if (op === 'And') return and1(x, y);
						if (x === 0n) return y;
						if (y === 0n) return x;
						if (x === 1n || y === 1n) return 1n;
						if (x === y) return x;
						throw new NonLinear();
					});
					return gMake(w, out);
				}
				case 'Add':
					return gMake(w, gAdd(a, b, 0n));
				case 'Sub':
					return gMake(
						w,
						gAdd(
							a,
							b.map((x) => x ^ 1n),
							1n
						)
					);
				case 'Mul': {
					const ca = gConst(gOf(af));
					const m = cb ?? ca;
					const other = cb !== undefined ? a : b;
					if (m === undefined) return atom();
					if (m === 0n) return gMake(w, gZero(w));
					let acc = gZero(w);
					for (let k = 0; k < w; k++)
						if ((m >> BigInt(k)) & 1n) acc = gAdd(acc, gShl(other, k), 0n);
					return gMake(w, acc);
				}
				case 'Shl':
				case 'ShrU':
				case 'ShrS':
				case 'RotL':
				case 'RotR': {
					if (cb === undefined) return atom();
					const s = Number(cb % BigInt(w));
					const at = (i: number) => a[i]!;
					return gMake(
						w,
						a.map((_, k) =>
							op === 'Shl'
								? k >= s
									? at(k - s)
									: 0n
								: op === 'ShrU'
									? k + s < w
										? at(k + s)
										: 0n
									: op === 'ShrS'
										? at(Math.min(k + s, w - 1))
										: op === 'RotL'
											? at((k - s + w) % w)
											: at((k + s) % w)
						)
					);
				}
			}
		} catch (e) {
			if (!(e instanceof NonLinear)) throw e;
		}
		return atom();
	},
	un(op, w, af) {
		const a = gOf(af).v;
		switch (op) {
			case 'Extend8S':
			case 'Extend16S':
			case 'Extend32S': {
				const n = op === 'Extend8S' ? 8 : op === 'Extend16S' ? 16 : 32;
				return gMake(
					w,
					a.map((_, k) => a[Math.min(k, n - 1)]!)
				);
			}
			case 'Wrap':
				return gMake(32, a.slice(0, 32));
			case 'Popcnt': {
				// the low bit of a population count is the xor of every bit; the higher bits stay opaque
				const atom = gAtom('Popcnt', w, w, [af]);
				atom.v[0] = a.reduce((x, y) => x ^ y, 0n);
				return atom;
			}
			case 'ExtendU':
				return gMake(64, [...a, ...gZero(32)]);
			case 'ExtendS':
				return gMake(64, [...a, ...Array.from({ length: 32 }, () => a[31]!)]);
		}
		const ow = resultWidth(op, w);
		return gAtom(op, ow, ow as W, [af]);
	},
	assemble(parts, w) {
		const v = gZero(w);
		parts.forEach((p, j) => {
			for (let k = 0; k < 8 && 8 * j + k < w; k++) v[8 * j + k] = gOf(p).v[k]!;
		});
		return gMake(w, v);
	},
	split(f, k) {
		const a = gOf(f).v;
		return Array.from({ length: k }, (_, j) => {
			const v = gZero(32);
			for (let i = 0; i < 8; i++) v[i] = a[8 * j + i]!;
			return gMake(32, v);
		});
	},
	select(w, a, b, c) {
		return gAtom('Select', w, w, [a, b, c]);
	},
	lookup(addr, offset, width, read, memory) {
		const a = gOf(addr).v;
		const idx: number[] = [];
		let base = 0;
		a.forEach((x, j) => {
			if (x === 1n) base += 2 ** j;
			else if (x !== 0n) idx.push(j);
		});
		if (idx.length > 16) refuse('table index wider than 16 bits');
		const rows: bigint[] = [];
		for (const j of idx) {
			let r = a[j]! & ~1n;
			for (const q of rows) if ((r ^ q) < r) r ^= q;
			if (r === 0n) refuse('table index bits are dependent');
			rows.push(r);
			rows.sort((p, q) => (p > q ? -1 : 1));
		}
		const count = 1 << idx.length;
		const vals: bigint[] = [];
		const reads: number[] = [];
		for (let t = 0; t < count; t++) {
			let at = base + offset;
			idx.forEach((j, i) => {
				if ((t >> i) & 1) at += 2 ** j;
			});
			if (at + width > memory) refuse('table read may trap');
			let val = 0n;
			for (let k = 0; k < width; k++) {
				val |= BigInt(read(at + k)) << BigInt(8 * k);
				reads.push(at + k);
			}
			vals.push(val);
		}
		const c0 = vals[0]!;
		const d = idx.map((_, i) => vals[1 << i]! ^ c0);
		let affine = true;
		for (let t = 0; t < count && affine; t++) {
			let want = c0;
			d.forEach((x, i) => {
				if ((t >> i) & 1) want ^= x;
			});
			if (want !== vals[t]) affine = false;
		}
		const ow = 8 * width;
		if (!affine)
			return {
				value: gAtom(
					'Table',
					ow,
					ow > 32 ? 64 : 32,
					[addr],
					`${offset}:${width}:${sha(vals.join(','))}`
				),
				reads
			};
		const out = gZero(ow > 32 ? 64 : 32);
		for (let i = 0; i < ow; i++) {
			let bit = (c0 >> BigInt(i)) & 1n ? 1n : 0n;
			d.forEach((x, n) => {
				if ((x >> BigInt(i)) & 1n) bit ^= a[idx[n]!]!;
			});
			out[i] = bit;
		}
		return { value: gMake(out.length as W, out), reads };
	},
	key: formKey,
	stateful: statefulForm,
	hasBytes(f) {
		let u = 0n;
		for (const x of gOf(f).v) u |= x;
		return (
			(u & (((1n << BigInt(ATOM0)) - 1n) & ~(STATE | 1n))) !== 0n || gAtomIds(u).length > 0
		);
	},
	linear(f, bits) {
		const g = gOf(f);
		let u = 0n;
		for (const x of g.v) u |= x;
		if (gAtomIds(u).some((id) => atomInfo[id]!.stateful))
			refuse('the state result holds an opaque atom');
		const cols = Array.from({ length: bits }, (_, j) => {
			let c = 0n;
			g.v.forEach((x, i) => {
				if ((x >> BigInt(1 + j)) & 1n) c |= 1n << BigInt(i);
			});
			return c;
		});
		return { k: 'gf2', cols };
	},
	zeroConst(f) {
		const g = gOf(f);
		let out = 0n;
		g.v.forEach((x, i) => {
			if (x & 1n) out |= 1n << BigInt(i);
		});
		return out;
	},
	opApply(op, x) {
		return op.k === 'gf2' ? gfApply(op.cols, x) : refuse('wrong operator');
	},
	opPow(op, n) {
		if (op.k !== 'gf2') return refuse('wrong operator');
		let result = op.cols.map((_, k) => 1n << BigInt(k));
		let base = op.cols;
		for (let e = n; e > 0; e = Math.floor(e / 2)) {
			if (e % 2 === 1) result = gfMul(base, result);
			base = gfMul(base, base);
		}
		return { k: 'gf2', cols: result };
	},
	opEq(a, b) {
		return (
			a.k === 'gf2' &&
			b.k === 'gf2' &&
			a.cols.length === b.cols.length &&
			a.cols.every((c, i) => c === b.cols[i])
		);
	}
};

// #endregion

// #region z2w

const zOf = (f: Form): Z => (f.r === 'z2w' ? f : (refuse('mixed rings') as never));

function zMake(w: W, c: bigint, y: bigint, b: Map<number, bigint>, a: Map<number, bigint>): Z {
	const m = MASK(w);
	const clean = (x: Map<number, bigint>) => {
		const out = new Map<number, bigint>();
		for (const [k, v] of x) {
			const n = v & m;
			if (n) out.set(k, n);
		}
		return out;
	};
	return { r: 'z2w', w, c: c & m, y: y & m, b: clean(b), a: clean(a) };
}

const zLin = (p: Z, q: Z, sign: bigint): Z => {
	const sum = (x: Map<number, bigint>, y: Map<number, bigint>) => {
		const out = new Map(x);
		for (const [k, v] of y) out.set(k, (out.get(k) ?? 0n) + sign * v);
		return out;
	};
	return zMake(p.w, p.c + sign * q.c, p.y + sign * q.y, sum(p.b, q.b), sum(p.a, q.a));
};

const zScale = (p: Z, k: bigint): Z =>
	zMake(
		p.w,
		p.c * k,
		p.y * k,
		new Map([...p.b].map(([i, v]) => [i, v * k])),
		new Map([...p.a].map(([i, v]) => [i, v * k]))
	);

const zConst = (f: Z): bigint | undefined =>
	f.y === 0n && f.b.size === 0 && f.a.size === 0 ? f.c : undefined;

function zAtom(op: string, ow: number, w: W, args: Form[], extra = ''): Z {
	const id = makeAtom(op, ow, args, extra);
	return zMake(w, 0n, 0n, new Map(), new Map([[id, 1n]]));
}

// integer interval of a state-free form using signed representatives, or undefined
function zRange(f: Z): [bigint, bigint] | undefined {
	if (f.y !== 0n) return undefined;
	const s = (x: bigint) => BigInt.asIntN(f.w, x);
	let lo = s(f.c);
	let hi = lo;
	for (const [, v] of f.b) {
		const k = s(v);
		if (k > 0n) hi += 255n * k;
		else lo += 255n * k;
	}
	for (const [id, v] of f.a) {
		const k = s(v);
		const info = atomInfo[id]!;
		if (k > 0n) {
			lo += k * info.lo;
			hi += k * info.hi;
		} else {
			lo += k * info.hi;
			hi += k * info.lo;
		}
	}
	return [lo, hi];
}

export const z2w: Ring = {
	name: 'z2w',
	state(w) {
		return zMake(w, 0n, 1n, new Map(), new Map());
	},
	byte(pos) {
		return zMake(32, 0n, 0n, new Map([[pos, 1n]]), new Map());
	},
	konst(x, w) {
		return zMake(w, x, 0n, new Map(), new Map());
	},
	asConst(f) {
		return zConst(zOf(f));
	},
	bin(op, w, af, bf) {
		const a = zOf(af);
		const b = zOf(bf);
		const ca = zConst(a);
		const cb = zConst(b);
		switch (op) {
			case 'Add':
				return zLin(a, b, 1n);
			case 'Sub':
				return zLin(a, b, -1n);
			case 'Mul':
				if (cb !== undefined) return zScale(a, cb);
				if (ca !== undefined) return zScale(b, ca);
				break;
			case 'Shl':
				if (cb !== undefined) return zScale(a, 1n << (cb % BigInt(w)));
				break;
			case 'Xor':
			case 'Or':
				if (cb === 0n) return a;
				if (ca === 0n) return b;
				break;
			case 'And':
				if (cb === MASK(w)) return a;
				if (ca === MASK(w)) return b;
				break;
			case 'ShrU':
			case 'ShrS':
			case 'RotL':
			case 'RotR':
				if (cb === 0n) return a;
				break;
		}
		return zAtom(op, resultWidth(op, w), resultWidth(op, w) as W, [af, bf]);
	},
	un(op, w, af) {
		const a = zOf(af);
		if (op === 'Wrap') return zMake(32, a.c, a.y, a.b, a.a);
		const range = zRange(a);
		if (range) {
			const [lo, hi] = range;
			if (op === 'ExtendU' && lo >= 0n && hi < 1n << 32n) return zMake(64, a.c, 0n, a.b, a.a);
			if (op === 'ExtendS' && lo >= 0n && hi < 1n << 31n) return zMake(64, a.c, 0n, a.b, a.a);
			const n =
				op === 'Extend8S' ? 7n : op === 'Extend16S' ? 15n : op === 'Extend32S' ? 31n : -1n;
			if (n >= 0n && lo >= 0n && hi < 1n << n) return a;
		}
		const ow = resultWidth(op, w);
		return zAtom(op, ow, ow as W, [af]);
	},
	assemble(parts, w) {
		let acc = zMake(w, 0n, 0n, new Map(), new Map());
		parts.forEach((p, j) => {
			const q = zOf(p);
			acc = zLin(acc, zScale(zMake(w, q.c, q.y, q.b, q.a), 1n << BigInt(8 * j)), 1n);
		});
		return acc;
	},
	split(f, k) {
		const a = zOf(f);
		const range = zRange(a);
		if (k === 1 && range && range[0] >= 0n && range[1] < 256n) return [a];
		return Array.from({ length: k }, (_, j) => zAtom('Byte', 8, 32, [f], String(j)));
	},
	select(w, a, b, c) {
		return zAtom('Select', w, w, [a, b, c]);
	},
	lookup(addr, offset, width, read, memory) {
		const a = zOf(addr);
		if (a.y !== 0n || a.a.size !== 0 || a.b.size !== 1)
			refuse('table index is not one input byte');
		const [pos, coef] = [...a.b][0]!;
		void pos;
		const vals: bigint[] = [];
		const reads: number[] = [];
		for (let v = 0n; v < 256n; v++) {
			const at = Number((a.c + coef * v) & MASK(32)) + offset;
			if (at + width > memory) refuse('table read may trap');
			let val = 0n;
			for (let k = 0; k < width; k++) {
				val |= BigInt(read(at + k)) << BigInt(8 * k);
				reads.push(at + k);
			}
			vals.push(val);
		}
		return {
			value: zAtom(
				'Table',
				8 * width,
				width > 4 ? 64 : 32,
				[addr],
				`${offset}:${width}:${sha(vals.join(','))}`
			),
			reads
		};
	},
	key: formKey,
	stateful: statefulForm,
	hasBytes(f) {
		const a = zOf(f);
		return a.b.size > 0 || a.a.size > 0;
	},
	linear(f, bits) {
		const a = zOf(f);
		for (const id of a.a.keys())
			if (atomInfo[id]!.stateful) refuse('the state result holds an opaque atom');
		return { k: 'z2w', m: a.y, bits };
	},
	zeroConst(f) {
		const a = zOf(f);
		return a.c;
	},
	opApply(op, x) {
		return op.k === 'z2w' ? (op.m * x) & MASK(op.bits) : refuse('wrong operator');
	},
	opPow(op, n) {
		if (op.k !== 'z2w') return refuse('wrong operator');
		const mod = 1n << BigInt(op.bits);
		let result = 1n;
		let base = op.m;
		for (let e = n; e > 0; e = Math.floor(e / 2)) {
			if (e % 2 === 1) result = (result * base) % mod;
			base = (base * base) % mod;
		}
		return { k: 'z2w', m: result, bits: op.bits };
	},
	opEq(a, b) {
		return a.k === 'z2w' && b.k === 'z2w' && a.m === b.m && a.bits === b.bits;
	}
};

// #endregion

// #region zp

const pOf = (f: Form): P => (f.r === 'zp' ? f : (refuse('mixed rings') as never));

const pMake = (
	w: W,
	c: bigint,
	d: [bigint, bigint],
	b: Map<number, bigint>,
	a: Map<number, bigint>
): P => {
	const clean = (x: Map<number, bigint>) => new Map([...x].filter(([, v]) => v !== 0n));
	return { r: 'zp', w, c, d, b: clean(b), a: clean(a) };
};

function pSpan(f: P): [bigint, bigint] {
	let lo = f.c;
	let hi = f.c;
	const add = (k: bigint, l: bigint, h: bigint) => {
		if (k > 0n) {
			lo += k * l;
			hi += k * h;
		} else {
			lo += k * h;
			hi += k * l;
		}
	};
	add(f.d[0], 0n, 65535n);
	add(f.d[1], 0n, 65535n);
	for (const [, v] of f.b) add(v, 0n, 255n);
	for (const [id, v] of f.a) add(v, atomInfo[id]!.lo, atomInfo[id]!.hi);
	return [lo, hi];
}

const pFits = (f: P) => {
	const [lo, hi] = pSpan(f);
	return lo >= 0n && hi <= MASK(f.w);
};

const pLin = (p: P, q: P, sign: bigint): P => {
	const sum = (x: Map<number, bigint>, y: Map<number, bigint>) => {
		const out = new Map(x);
		for (const [k, v] of y) out.set(k, (out.get(k) ?? 0n) + sign * v);
		return out;
	};
	return pMake(
		p.w,
		p.c + sign * q.c,
		[p.d[0] + sign * q.d[0], p.d[1] + sign * q.d[1]],
		sum(p.b, q.b),
		sum(p.a, q.a)
	);
};

const pScale = (p: P, k: bigint): P =>
	pMake(
		p.w,
		p.c * k,
		[p.d[0] * k, p.d[1] * k],
		new Map([...p.b].map(([i, v]) => [i, v * k])),
		new Map([...p.a].map(([i, v]) => [i, v * k]))
	);

const pConst = (f: P): bigint | undefined =>
	f.d[0] === 0n && f.d[1] === 0n && f.b.size === 0 && f.a.size === 0 ? f.c : undefined;

function pAtom(op: string, ow: number, w: W, args: Form[], extra = ''): P {
	const id = makeAtom(op, ow, args, extra);
	return pMake(w, 0n, [0n, 0n], new Map(), new Map([[id, 1n]]));
}

const pChecked = (f: P, fallback: () => P): P => (pFits(f) ? f : fallback());

// x = low + 2^s * high with every term of high a multiple of 2^s
function pSplit(x: P, s: number): { low: P; high: P } | undefined {
	const unit = 1n << BigInt(s);
	const mod = (v: bigint) => ((v % unit) + unit) % unit;
	const lowC = mod(x.c);
	const highC = (x.c - lowC) / unit;
	const lowD: [bigint, bigint] = [0n, 0n];
	const highD: [bigint, bigint] = [0n, 0n];
	[0, 1].forEach((i) => {
		if (mod(x.d[i]!) === 0n) highD[i] = x.d[i]! / unit;
		else lowD[i] = x.d[i]!;
	});
	const split = (m: Map<number, bigint>) => {
		const low = new Map<number, bigint>();
		const high = new Map<number, bigint>();
		for (const [k, v] of m) {
			if (mod(v) === 0n) high.set(k, v / unit);
			else low.set(k, v);
		}
		return [low, high] as const;
	};
	const [lowB, highB] = split(x.b);
	const [lowA, highA] = split(x.a);
	const low = pMake(x.w, lowC, lowD, lowB, lowA);
	const [lo, hi] = pSpan(low);
	if (lo < 0n || hi >= unit) return undefined;
	return { low, high: pMake(x.w, highC, highD, highB, highA) };
}

function pRes(p: bigint, f: P): P {
	let cur = f;
	for (let guard = 0; guard < 64; guard++) {
		let replaced = false;
		for (const [id, coef] of cur.a) {
			const info = atomInfo[id]!;
			if (info.op === 'Res' && info.extra === String(p)) {
				const inner = pOf(info.args[0]!);
				const rest = new Map(cur.a);
				rest.delete(id);
				cur = pLin(pMake(cur.w, cur.c, cur.d, cur.b, rest), pScale(inner, coef), 1n);
				replaced = true;
				break;
			}
		}
		if (!replaced) break;
	}
	const red = (v: bigint) => ((v % p) + p) % p;
	const reduced = pMake(
		cur.w,
		red(cur.c),
		[red(cur.d[0]), red(cur.d[1])],
		new Map([...cur.b].map(([k, v]) => [k, red(v)])),
		new Map([...cur.a].map(([k, v]) => [k, red(v)]))
	);
	const [lo, hi] = pSpan(reduced);
	if (lo >= 0n && hi < p) return reduced;
	const id = makeAtom('Res', 32, [reduced], String(p), 0n, p - 1n);
	return pMake(f.w, 0n, [0n, 0n], new Map(), new Map([[id, 1n]]));
}

export const zp: Ring = {
	name: 'zp',
	state(w) {
		if (w !== 32) refuse('the residue ring needs a 32-bit state');
		return pMake(32, 0n, [1n, 65536n], new Map(), new Map());
	},
	byte(pos) {
		return pMake(32, 0n, [0n, 0n], new Map([[pos, 1n]]), new Map());
	},
	konst(x, w) {
		return pMake(w, x, [0n, 0n], new Map(), new Map());
	},
	asConst(f) {
		return pConst(pOf(f));
	},
	bin(op, w, af, bf) {
		const a = pOf(af);
		const b = pOf(bf);
		const ca = pConst(a);
		const cb = pConst(b);
		const atom = () => pAtom(op, resultWidth(op, w), resultWidth(op, w) as W, [af, bf]);
		switch (op) {
			case 'Add':
				return pChecked(pLin(a, b, 1n), atom);
			case 'Sub':
				return pChecked(pLin(a, b, -1n), atom);
			case 'Mul':
				if (cb !== undefined) return pChecked(pScale(a, cb), atom);
				if (ca !== undefined) return pChecked(pScale(b, ca), atom);
				break;
			case 'Shl':
				if (cb !== undefined) return pChecked(pScale(a, 1n << (cb % BigInt(w))), atom);
				break;
			case 'And': {
				if (cb !== undefined && cb !== 0n && ((cb + 1n) & cb) === 0n) {
					const s = cb.toString(2).length;
					const sp = s >= w ? undefined : pSplit(a, s);
					if (s >= w && pFits(a)) return a;
					if (sp) return sp.low;
				}
				if (cb !== undefined && cb === (MASK(32) ^ MASK(16))) {
					const sp = pSplit(a, 16);
					if (sp) return pScale(sp.high, 65536n);
				}
				break;
			}
			case 'ShrU': {
				if (cb !== undefined) {
					const s = Number(cb % BigInt(w));
					if (s === 0) return a;
					const sp = pSplit(a, s);
					if (sp) return sp.high;
				}
				break;
			}
			case 'Or': {
				if (cb === 0n) return a;
				if (ca === 0n) return b;
				for (const [x, y] of [
					[a, b],
					[b, a]
				] as const) {
					let s = 32;
					const terms = [x.c, x.d[0], x.d[1], ...x.b.values(), ...x.a.values()].filter(
						(v) => v !== 0n
					);
					for (const v of terms) {
						let t = 0;
						let u = v < 0n ? -v : v;
						while (!(u & 1n)) {
							u >>= 1n;
							t++;
						}
						s = Math.min(s, t);
					}
					const [lo, hi] = pSpan(y);
					const [xl] = pSpan(x);
					if (s > 0 && s < 32 && lo >= 0n && hi < 1n << BigInt(s) && xl >= 0n)
						return pChecked(pLin(x, y, 1n), atom);
				}
				break;
			}
			case 'RemU': {
				if (cb !== undefined && cb >= 2n && cb <= 65536n && w === 32) {
					if (!pFits(a)) break;
					return pRes(cb, a);
				}
				break;
			}
		}
		return atom();
	},
	un(op, w, af) {
		const a = pOf(af);
		if (op === 'Wrap' && pFits(pMake(32, a.c, a.d, a.b, a.a)))
			return pMake(32, a.c, a.d, a.b, a.a);
		if (op === 'ExtendU' && pFits(a)) return pMake(64, a.c, a.d, a.b, a.a);
		const ow = resultWidth(op, w);
		return pAtom(op, ow, ow as W, [af]);
	},
	assemble(parts, w) {
		let acc = pMake(w, 0n, [0n, 0n], new Map(), new Map());
		parts.forEach((p, j) => {
			const q = pOf(p);
			acc = pLin(acc, pScale(pMake(w, q.c, q.d, q.b, q.a), 1n << BigInt(8 * j)), 1n);
		});
		return acc;
	},
	split(f, k) {
		const a = pOf(f);
		const [lo, hi] = pSpan(a);
		if (k === 1 && lo >= 0n && hi < 256n) return [a];
		return Array.from({ length: k }, (_, j) => pAtom('Byte', 8, 32, [f], String(j)));
	},
	select(w, a, b, c) {
		return pAtom('Select', w, w, [a, b, c]);
	},
	lookup() {
		return refuse('table lookup in the residue ring');
	},
	key: formKey,
	stateful: statefulForm,
	hasBytes(f) {
		const a = pOf(f);
		return a.b.size > 0 || a.a.size > 0;
	},
	linear(f) {
		const a = pOf(f);
		const ids = [...a.a].sort((p, q) => (p[1] < q[1] ? -1 : 1));
		const res = ids.map(([id, k]) => ({ info: atomInfo[id]!, k }));
		if (
			a.c !== 0n ||
			a.d[0] !== 0n ||
			a.d[1] !== 0n ||
			a.b.size !== 0 ||
			res.length !== 2 ||
			res.some((r) => r.info.op !== 'Res') ||
			res[0]!.k !== 1n ||
			res[1]!.k !== 65536n ||
			res[0]!.info.extra !== res[1]!.info.extra
		)
			return refuse('the state result is not two residues of one modulus');
		const p = BigInt(res[0]!.info.extra);
		const rows = res.flatMap((r) => {
			const arg = pOf(r.info.args[0]!);
			for (const id of arg.a.keys())
				if (atomInfo[id]!.stateful) refuse('a residue argument holds an opaque atom');
			return [arg.d[0], arg.d[1]];
		});
		return { k: 'zp', p, mat: rows };
	},
	zeroConst() {
		return undefined;
	},
	opApply() {
		return refuse('no step in the residue ring');
	},
	opPow(op, n) {
		if (op.k !== 'zp') return refuse('wrong operator');
		const times = (x: bigint[], y: bigint[]) => [
			(x[0]! * y[0]! + x[1]! * y[2]!) % op.p,
			(x[0]! * y[1]! + x[1]! * y[3]!) % op.p,
			(x[2]! * y[0]! + x[3]! * y[2]!) % op.p,
			(x[2]! * y[1]! + x[3]! * y[3]!) % op.p
		];
		let result = [1n, 0n, 0n, 1n];
		let base = op.mat.map((v) => ((v % op.p) + op.p) % op.p);
		for (let e = n; e > 0; e = Math.floor(e / 2)) {
			if (e % 2 === 1) result = times(base, result);
			base = times(base, base);
		}
		return { k: 'zp', p: op.p, mat: result };
	},
	opEq(a, b) {
		return (
			a.k === 'zp' &&
			b.k === 'zp' &&
			a.p === b.p &&
			a.mat.length === 4 &&
			b.mat.length === 4 &&
			a.mat.every((v, i) => ((v % a.p) + a.p) % a.p === ((b.mat[i]! % a.p) + a.p) % a.p)
		);
	}
};

// #endregion

export const RINGS = { gf2, z2w, zp };

export { resultWidth };
