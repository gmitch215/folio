import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { stackRoute } from './extract.ts';

export type Obligation =
	| 'state-isolation'
	| 'read-before-write'
	| 'aliasing'
	| 'final-state'
	| 'escaping-addresses'
	| 'failure'
	| 'provenance'
	| 'scope';

export type OwnershipReason =
	| 'isolation'
	| 'read-before-write'
	| 'aliasing'
	| 'final-state'
	| 'escape'
	| 'failure'
	| 'allocator'
	| 'ptr-store'
	| 'ptr-return'
	| 'ptr-import'
	| 'ptr-compare'
	| 'ptr-control'
	| 'ptr-deref'
	| 'no-window'
	| 'unsupported'
	| 'budget'
	| 'invalid';

export const OWNERSHIP_REASONS: readonly OwnershipReason[] = [
	'isolation',
	'read-before-write',
	'aliasing',
	'final-state',
	'escape',
	'failure',
	'allocator',
	'ptr-store',
	'ptr-return',
	'ptr-import',
	'ptr-compare',
	'ptr-control',
	'ptr-deref',
	'no-window',
	'unsupported',
	'budget',
	'invalid'
];

const OBLIGATION_OF: Record<OwnershipReason, Obligation> = {
	isolation: 'state-isolation',
	'read-before-write': 'read-before-write',
	aliasing: 'aliasing',
	'final-state': 'final-state',
	escape: 'escaping-addresses',
	failure: 'failure',
	allocator: 'state-isolation',
	'ptr-store': 'provenance',
	'ptr-return': 'provenance',
	'ptr-import': 'provenance',
	'ptr-compare': 'provenance',
	'ptr-control': 'provenance',
	'ptr-deref': 'provenance',
	'no-window': 'scope',
	unsupported: 'scope',
	budget: 'scope',
	invalid: 'scope'
};

export interface OwnershipConvention {
	/** Parameter positions of the record table, the record count and the output pointer. Default 0, 1, 2. */
	table: number;
	count: number;
	out: number;
	/** Byte offsets in a table record that hold pointers. Default 0, 8, 12. */
	pointers: number[];
	/** Bytes of one table record. Default 16. */
	recordBytes: number;
}

export interface OwnershipOptions {
	/** Exported function that runs the records loop. Default `bulk`. */
	entry?: string;
	convention?: Partial<OwnershipConvention>;
	/** Windows proposed by a probe; they only add bytes to the windows the checker derives. */
	proposed?: { low: number; end: number }[];
	/** Step limit of one analysis pass. Default 4,000,000. */
	maxSteps?: number;
	/**
	 * The allocator mode: the record's arena pointer may be stored in a window and used to allocate.
	 * `arenaBytes` is the size of the arena slice. `assumeInArena` counts the dereferences it cannot
	 * bound instead of refusing; the result is then never a certificate, only the next refusal.
	 */
	allocator?: { arenaBytes: number; arenaWord?: number; assumeInArena?: boolean };
}

export type ProvenanceRule = 'store' | 'return' | 'import' | 'compare' | 'control' | 'deref';

export interface AllocatorEvidence {
	arenaBytes: number;
	arenaWord: number;
	/** Window ranges that may hold an arena-derived pointer; the last record supplies their serial values. */
	pointerCells: [number, number][];
	/** Arena offsets where an arena-derived value may have been stored; the bytes there may differ between bases. */
	arenaTaint: [number, number][];
	/** Heap dereferences the interval domain put inside the arena. */
	derefsProved: number;
	rules: Record<ProvenanceRule, string>;
	/** What a router that moves the arena must do. */
	shiftRule: string;
	assumptions: string[];
}

export interface OwnershipWindow {
	low: number;
	end: number;
}

export interface SiteCounts {
	exact: number;
	bounded: number;
	dynamic: number;
	outside: number;
	bulk: number;
}

export interface OwnershipCertificate {
	kind: 'certificate';
	schema: 'folio.ownership.v1';
	checker: string;
	moduleSha256: string;
	entry: string;
	convention: OwnershipConvention;
	proposed: OwnershipWindow[];
	windows: OwnershipWindow[];
	/** Byte ranges the last record's copy supplies; the last record wrote every one of them. */
	copyOut: [number, number][];
	written: [number, number][];
	covered: [number, number][];
	sites: Record<string, SiteCounts>;
	/** Stores whose address is neither record-derived nor inside a window; the in-place slice route refuses them. */
	wildStores: number;
	// per function, one char per access in memoryAccesses order: o outside, x exact, b bounded, d dynamic, k bulk, u unreached
	accesses: Record<string, string>;
	functions: string[];
	evidence: Record<Exclude<Obligation, 'scope' | 'provenance'>, string>;
	/** Present only for a certificate made in allocator mode. */
	allocator?: AllocatorEvidence;
	assumptions: string[];
	stats: { steps: number; calls: number; loops: number; passes: number };
}

export interface OwnershipRefusal {
	kind: 'refusal';
	reason: OwnershipReason;
	obligation: Obligation;
	detail: string;
	address?: number;
}

export const OWNERSHIP_CHECKER = 'folio-ownership-1';

const M32 = 0xffffffff;
const PAGE_LINE = 64;
const STORE_CAP = 1 << 16;

// #region ranges

type Ranges = [number, number][];

function rsAdd(a: Ranges, lo: number, end: number): Ranges {
	if (end <= lo) return a;
	const out: Ranges = [];
	let placed = false;
	let nlo = lo;
	let nend = end;
	for (const r of a) {
		if (r[1] < nlo) out.push(r);
		else if (r[0] > nend) {
			if (!placed) {
				out.push([nlo, nend]);
				placed = true;
			}
			out.push(r);
		} else {
			nlo = Math.min(nlo, r[0]);
			nend = Math.max(nend, r[1]);
		}
	}
	if (!placed) out.push([nlo, nend]);
	return out;
}

function rsInter(a: Ranges, b: Ranges): Ranges {
	const out: Ranges = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const lo = Math.max(a[i]![0], b[j]![0]);
		const end = Math.min(a[i]![1], b[j]![1]);
		if (lo < end) out.push([lo, end]);
		if (a[i]![1] < b[j]![1]) i++;
		else j++;
	}
	return out;
}

function rsSub(a: Ranges, b: Ranges): Ranges {
	const out: Ranges = [];
	for (const [alo, aend] of a) {
		let at = alo;
		for (const [blo, bend] of b) {
			if (bend <= at || blo >= aend) continue;
			if (blo > at) out.push([at, blo]);
			at = Math.max(at, bend);
			if (at >= aend) break;
		}
		if (at < aend) out.push([at, aend]);
	}
	return out;
}

const rsEqual = (a: Ranges, b: Ranges) =>
	a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1]);

// #endregion

// #region values

interface V {
	lo: number;
	hi: number;
	/** a pointer made from record parameters, the stack pointer or a table pointer word */
	r: boolean;
	/** derived from a constant that lies in a window */
	t: boolean;
	/** byte offset inside a table record when this is the table pointer, else -1 */
	tb: number;
	/** net offset from the stack pointer at entry when this is exactly that pointer plus an offset */
	so: number | undefined;
	/** derived from the stack pointer global by address arithmetic only */
	k: boolean;
	/** allocator mode: may depend on the arena base address */
	a: boolean;
	/** allocator mode: exactly the arena base plus an offset in [lo, hi], signed; implies a and r */
	p: boolean;
}

const mk = (
	lo: number,
	hi: number,
	r = false,
	t = false,
	tb = -1,
	so?: number,
	k = false,
	a = false,
	p = false
): V => ({
	lo,
	hi,
	r,
	t,
	tb,
	so,
	k,
	a,
	p
});
const exactV = (c: number, t = false): V => mk(c >>> 0, c >>> 0, false, t);
const TOP = mk(0, M32);
const BOOL = mk(0, 1);
const isExact = (a: V) => a.lo === a.hi;
const dataV = (t: boolean): V => (t ? mk(0, M32, false, true) : TOP);

const OFF_MIN = -(2 ** 31);
const OFF_MAX = 2 ** 31;
const ptrV = (lo: number, hi: number, t = false): V =>
	mk(lo, hi, true, t, -1, undefined, false, true, true);
const taintV = (t = false): V => mk(0, M32, false, t, -1, undefined, false, true, false);

const joinV = (a: V, b: V): V => {
	if (a.a || b.a) {
		const t = a.t || b.t;
		return a.p && b.p ? ptrV(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi), t) : taintV(t);
	}
	return mk(
		Math.min(a.lo, b.lo),
		Math.max(a.hi, b.hi),
		a.r && b.r,
		a.t || b.t,
		a.tb === b.tb ? a.tb : -1,
		a.so === b.so ? a.so : undefined,
		a.k || b.k
	);
};

const sameV = (a: V, b: V) =>
	a.lo === b.lo &&
	a.hi === b.hi &&
	a.r === b.r &&
	a.t === b.t &&
	a.tb === b.tb &&
	a.so === b.so &&
	a.k === b.k &&
	a.a === b.a &&
	a.p === b.p;

let thresholds: number[] = [];

function widenV(old: V, now: V): V {
	if (sameV(old, now)) return old;
	if (old.a || now.a) {
		const t = old.t || now.t;
		if (!(old.p && now.p)) return taintV(t);
		return ptrV(now.lo < old.lo ? OFF_MIN : old.lo, now.hi > old.hi ? OFF_MAX : old.hi, t);
	}
	let lo = old.lo;
	let hi = old.hi;
	if (now.lo < old.lo) {
		lo = 0;
		for (const t of thresholds)
			if (t <= now.lo) lo = t;
			else break;
	}
	if (now.hi > old.hi) {
		hi = M32;
		for (const t of thresholds)
			if (t >= now.hi) {
				hi = t;
				break;
			}
	}
	return mk(
		lo,
		hi,
		old.r && now.r,
		old.t || now.t,
		old.tb === now.tb ? old.tb : -1,
		old.so === now.so ? old.so : undefined,
		old.k || now.k
	);
}

const bitCap = (hi: number) =>
	hi === 0 ? 0 : hi >= 2 ** 31 ? M32 : 2 ** Math.ceil(Math.log2(hi + 1)) - 1;

const sdelta = (v: number) => (v > 0x7fffffff ? v - 2 ** 32 : v);

function wrapAdd(lo: number, hi: number, r: boolean, t: boolean, tb: number): V {
	if (hi <= M32) return mk(lo, hi, r, t, tb);
	if (lo > M32) return mk(lo - 2 ** 32, hi - 2 ** 32, r, t, tb);
	return mk(0, M32, r, t, tb);
}

function bin32(op: string, a: V, b: V, recordBytes: number): V {
	const t = a.t || b.t;
	const ex = isExact(a) && isExact(b);
	const x = a.lo;
	const y = b.lo;
	if (a.k || b.k) {
		const pointer =
			(op === 'Add' && !(a.r && b.r)) ||
			(op === 'Sub' && a.k && !b.r) ||
			(op === 'And' && ((a.k && isExact(b)) || (b.k && isExact(a))));
		if (!pointer) refuse('isolation', 'the stack pointer is read as data');
		if (op === 'And') return mk(0, M32, true, false, -1, undefined, true);
	}
	switch (op) {
		case 'Add': {
			if (t) return wrapAdd(a.lo + b.lo, a.hi + b.hi, false, true, -1);
			const pa = a.r && !b.r;
			const pb = b.r && !a.r;
			if (pa || pb) {
				const base = pa ? a : b;
				const off = pa ? b : a;
				let tb = -1;
				if (base.tb >= 0 && isExact(off)) {
					const n = base.tb + sdelta(off.lo);
					if (n >= 0 && n < recordBytes) tb = n;
				}
				const so =
					base.so !== undefined && isExact(off) ? base.so + sdelta(off.lo) : undefined;
				return mk(0, M32, true, false, tb, so, base.k);
			}
			return wrapAdd(a.lo + b.lo, a.hi + b.hi, false, false, -1);
		}
		case 'Sub': {
			if (t) {
				const lo = a.lo - b.hi;
				const hi = a.hi - b.lo;
				return lo >= 0
					? mk(lo, hi, false, true)
					: hi < 0
						? mk(lo + 2 ** 32, hi + 2 ** 32, false, true)
						: dataV(true);
			}
			if (a.r && !b.r) {
				let tb = -1;
				if (a.tb >= 0 && isExact(b)) {
					const n = a.tb - sdelta(b.lo);
					if (n >= 0 && n < recordBytes) tb = n;
				}
				const so = a.so !== undefined && isExact(b) ? a.so - sdelta(b.lo) : undefined;
				return mk(0, M32, true, false, tb, so, a.k);
			}
			if (a.r || b.r) return TOP;
			const lo = a.lo - b.hi;
			const hi = a.hi - b.lo;
			if (lo >= 0) return mk(lo, hi);
			if (hi < 0) return mk(lo + 2 ** 32, hi + 2 ** 32);
			return TOP;
		}
		case 'Mul': {
			if (ex) return mk(Math.imul(x, y) >>> 0, Math.imul(x, y) >>> 0, false, t);
			const hi = a.hi * b.hi;
			return hi <= M32 && !a.r && !b.r ? mk(a.lo * b.lo, hi, false, t) : dataV(t);
		}
		case 'Shl': {
			if (!isExact(b)) return dataV(t);
			const s = b.lo & 31;
			if (ex) return mk((x << s) >>> 0, (x << s) >>> 0, false, t);
			const hi = a.hi * 2 ** s;
			return hi <= M32 && !a.r ? mk(a.lo * 2 ** s, hi, false, t) : dataV(t);
		}
		case 'ShrU': {
			if (!isExact(b)) return mk(0, a.r ? M32 : a.hi, false, t);
			const s = b.lo & 31;
			return mk(a.lo >>> s, a.hi >>> s, false, t);
		}
		case 'ShrS': {
			if (!isExact(b)) return dataV(t);
			const s = b.lo & 31;
			if (a.hi <= 0x7fffffff) return mk(a.lo >>> s, a.hi >>> s, false, t);
			return ex ? mk((x >> s) >>> 0, (x >> s) >>> 0, false, t) : dataV(t);
		}
		case 'And': {
			if (ex) return mk((x & y) >>> 0, (x & y) >>> 0, false, t);
			if (isExact(b) && !a.r) return mk(0, Math.min(a.hi, y), false, t);
			if (isExact(a) && !b.r) return mk(0, Math.min(b.hi, x), false, t);
			if (a.r || b.r) return dataV(t);
			return mk(0, Math.min(a.hi, b.hi), false, t);
		}
		case 'Or':
		case 'Xor': {
			if (ex)
				return mk(
					(op === 'Or' ? x | y : x ^ y) >>> 0,
					(op === 'Or' ? x | y : x ^ y) >>> 0,
					false,
					t
				);
			if (a.r || b.r) return dataV(t);
			const cap = bitCap(Math.max(a.hi, b.hi));
			return mk(op === 'Or' ? Math.max(a.lo, b.lo) : 0, cap, false, t);
		}
		case 'RotL':
		case 'RotR': {
			if (!ex) return dataV(t);
			const s = y & 31;
			const v =
				op === 'RotL'
					? ((x << s) | (x >>> (32 - s))) >>> 0
					: ((x >>> s) | (x << (32 - s))) >>> 0;
			return mk(v, v, false, t);
		}
		case 'DivU': {
			if (b.lo > 0 && !a.r)
				return mk(Math.floor(a.lo / b.hi), Math.floor(a.hi / b.lo), false, t);
			return dataV(t);
		}
		case 'RemU': {
			if (ex && y > 0) return mk(x % y, x % y, false, t);
			if (b.lo > 0 && !a.r) return mk(0, Math.min(a.hi, b.hi - 1), false, t);
			return dataV(t);
		}
		case 'DivS':
		case 'RemS':
			return dataV(t);
		case 'Eq':
		case 'Ne':
		case 'LtU':
		case 'LeU':
		case 'GtU':
		case 'GeU':
		case 'LtS':
		case 'LeS':
		case 'GtS':
		case 'GeS':
			return compare(op, a, b);
		default:
			return dataV(t);
	}
}

function compare(op: string, a: V, b: V): V {
	const signed = op.endsWith('S');
	if (signed && (a.hi > 0x7fffffff || b.hi > 0x7fffffff)) {
		if (isExact(a) && isExact(b)) {
			const x = a.lo | 0;
			const y = b.lo | 0;
			const r = { LtS: x < y, LeS: x <= y, GtS: x > y, GeS: x >= y }[op as 'LtS'];
			return exactV(r ? 1 : 0);
		}
		return BOOL;
	}
	const kind = op.replace(/[SU]$/, '');
	let yes: boolean | undefined;
	let no: boolean | undefined;
	switch (kind) {
		case 'Eq':
			yes = isExact(a) && isExact(b) && a.lo === b.lo;
			no = a.hi < b.lo || b.hi < a.lo;
			break;
		case 'Ne':
			no = isExact(a) && isExact(b) && a.lo === b.lo;
			yes = a.hi < b.lo || b.hi < a.lo;
			break;
		case 'Lt':
			yes = a.hi < b.lo;
			no = a.lo >= b.hi;
			break;
		case 'Le':
			yes = a.hi <= b.lo;
			no = a.lo > b.hi;
			break;
		case 'Gt':
			yes = a.lo > b.hi;
			no = a.hi <= b.lo;
			break;
		default:
			yes = a.lo >= b.hi;
			no = a.hi < b.lo;
	}
	return yes ? exactV(1) : no ? exactV(0) : BOOL;
}

// #endregion

// #region operator tables

const named = binaryen as unknown as Record<string, number>;
const I32BIN = new Map<number, string>();
const I32UN = new Map<number, string>();
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
	I32BIN.set(named[`${op}Int32`]!, op);
for (const op of ['Clz', 'Ctz', 'Popcnt', 'EqZ']) I32UN.set(named[`${op}Int32`]!, op);
I32UN.set(named.ExtendS8Int32!, 'Extend8S');
I32UN.set(named.ExtendS16Int32!, 'Extend16S');

const COMPARE_REL: Record<string, string> = {
	Eq: 'eq',
	Ne: 'ne',
	LtU: 'lt',
	LeU: 'le',
	GtU: 'gt',
	GeU: 'ge',
	LtS: 'lt',
	LeS: 'le',
	GtS: 'gt',
	GeS: 'ge'
};
const MIRROR: Record<string, string> = {
	eq: 'eq',
	ne: 'ne',
	lt: 'gt',
	le: 'ge',
	gt: 'lt',
	ge: 'le'
};
const NEGATE: Record<string, string> = {
	eq: 'ne',
	ne: 'eq',
	lt: 'ge',
	le: 'gt',
	gt: 'le',
	ge: 'lt'
};

function narrow(x: V, rel: string, y: V): V | undefined {
	let lo = x.lo;
	let hi = x.hi;
	switch (rel) {
		case 'eq':
			lo = Math.max(lo, y.lo);
			hi = Math.min(hi, y.hi);
			break;
		case 'ne':
			if (isExact(y)) {
				if (x.lo === y.lo && x.hi === y.lo) return undefined;
				if (x.lo === y.lo) lo++;
				else if (x.hi === y.lo) hi--;
			}
			break;
		case 'lt':
			if (y.hi === 0) return undefined;
			hi = Math.min(hi, y.hi - 1);
			break;
		case 'le':
			hi = Math.min(hi, y.hi);
			break;
		case 'gt':
			if (y.lo === M32) return undefined;
			lo = Math.max(lo, y.lo + 1);
			break;
		default:
			lo = Math.max(lo, y.lo);
	}
	return lo > hi ? undefined : { ...x, lo, hi };
}

// #endregion

// #region analysis

class Refuse extends Error {
	reason: OwnershipReason;
	detail: string;
	address?: number;
	constructor(reason: OwnershipReason, detail: string, address?: number) {
		super(detail);
		this.reason = reason;
		this.detail = detail;
		this.address = address;
	}
}

const refuse = (reason: OwnershipReason, detail: string, address?: number): never => {
	throw new Refuse(reason, detail, address);
};

// the stack pointer global stays an address: it is private per slot, so its value must never be data
const noStack = (v: V | undefined, use: string) => {
	if (v?.k) refuse('isolation', `the stack pointer is ${use}`);
};

class PathEnd {}
const END = new PathEnd();

interface State {
	l: V[];
	g: V[];
	m: Ranges;
	d: boolean;
	/** net stack pointer offset from entry; NaN when paths disagree or the offset is unknown */
	sp: number;
	/** allocator mode: contents of known 4-byte cells, keyed by region letter and address or offset */
	c: Map<string, V>;
}

interface Pend {
	s: State;
	v: V | undefined;
}

interface Frame {
	pend: Map<string, Pend[]>;
	rets: Pend[];
	fn: string;
}

interface FnInfo {
	name: string;
	body: number;
	params: number;
	types: number[];
}

type Mode = 'exact' | 'bounded' | 'dynamic' | 'outside' | 'bulk';
const RANK: Record<Mode, number> = { outside: 0, exact: 1, bounded: 2, dynamic: 3, bulk: 4 };

const info = (expr: number): any => binaryen.getExpressionInfo(expr);

const cloneState = (s: State): State => ({
	l: s.l.slice(),
	g: s.g.slice(),
	m: s.m,
	d: s.d,
	sp: s.sp,
	c: new Map(s.c)
});

// a cell survives a join only when both paths know it; the others fall back to the taint summary
function joinCells(a: Map<string, V>, b: Map<string, V>, widen?: boolean): Map<string, V> {
	const out = new Map<string, V>();
	for (const [key, v] of a) {
		const w = b.get(key);
		if (w) out.set(key, widen ? widenV(v, w) : joinV(v, w));
	}
	return out;
}

function joinStates(list: State[]): State {
	let out = list[0]!;
	if (list.length === 1) return out;
	let m = out.m;
	const l = out.l.slice();
	const g = out.g.slice();
	let c = out.c;
	let d = out.d;
	let sp = out.sp;
	for (let k = 1; k < list.length; k++) {
		const s = list[k]!;
		m = rsInter(m, s.m);
		d = d || s.d;
		if (!Object.is(sp, s.sp)) sp = NaN;
		for (let i = 0; i < l.length; i++) l[i] = joinV(l[i]!, s.l[i]!);
		for (let i = 0; i < g.length; i++) g[i] = joinV(g[i]!, s.g[i]!);
		c = joinCells(c, s.c);
	}
	out = { l, g, m, d, sp, c };
	return out;
}

const joinVals = (list: (V | undefined)[]): V | undefined =>
	list.some((v) => v === undefined) ? undefined : list.map((v) => v!).reduce(joinV);

function sameState(a: State, b: State) {
	if (a.d !== b.d || !Object.is(a.sp, b.sp) || !rsEqual(a.m, b.m)) return false;
	for (let i = 0; i < a.l.length; i++) if (!sameV(a.l[i]!, b.l[i]!)) return false;
	for (let i = 0; i < a.g.length; i++) if (!sameV(a.g[i]!, b.g[i]!)) return false;
	if (a.c.size !== b.c.size) return false;
	for (const [key, v] of a.c) {
		const w = b.c.get(key);
		if (!w || !sameV(v, w)) return false;
	}
	return true;
}

function widenState(old: State, now: State): State {
	return {
		l: old.l.map((v, i) => widenV(v, now.l[i]!)),
		g: old.g.map((v, i) => widenV(v, now.g[i]!)),
		m: rsInter(old.m, now.m),
		d: old.d || now.d,
		sp: Object.is(old.sp, now.sp) ? old.sp : NaN,
		c: joinCells(old.c, now.c, true)
	};
}

interface Ctx {
	module: binaryen.Module;
	windows: OwnershipWindow[];
	conv: OwnershipConvention;
	sp: string | undefined;
	globalIndex: Map<string, number>;
	globalInit: V[];
	globalConst: Map<string, V>;
	maxSteps: number;
	steps: number;
	forks: number;
	calls: number;
	loops: number;
	written: Ranges;
	unsafe: Ranges;
	stores: Ranges;
	sites: Map<number, { fn: string; mode: Mode }>;
	wild: Set<number>;
	visited: Set<string>;
	stack: string[];
	fns: Map<string, FnInfo>;
	vals: Map<number, V>;
	alloc: AllocCfg | undefined;
	/** tainted stores seen by the previous passes; loads read it together with `next` */
	sum: Summary;
	next: Summary;
	proved: number;
	unproved: number;
}

function fnInfo(ctx: Ctx, name: string): FnInfo {
	let f = ctx.fns.get(name);
	if (f) return f;
	const ref = ctx.module.getFunction(name);
	if (!ref) return refuse('unsupported', `call to unknown function ${name}`);
	const i = binaryen.getFunctionInfo(ref);
	if (i.module || !i.body) return refuse('isolation', `call to import ${i.module}.${i.base}`);
	const params = binaryen.expandType(i.params);
	f = { name, body: i.body, params: params.length, types: [...params, ...(i.vars as number[])] };
	ctx.fns.set(name, f);
	return f;
}

function touching(
	ctx: Ctx,
	lo: number,
	end: number
): { lo: number; end: number; w: OwnershipWindow }[] {
	const out: { lo: number; end: number; w: OwnershipWindow }[] = [];
	for (const w of ctx.windows) {
		const a = Math.max(lo, w.low);
		const b = Math.min(end, w.end);
		if (a < b) out.push({ lo: a, end: b, w });
	}
	return out;
}

function site(ctx: Ctx, expr: number, fn: string, mode: Mode) {
	if (!ctx.windows.length) return;
	const old = ctx.sites.get(expr);
	if (!old || RANK[mode] > RANK[old.mode]) ctx.sites.set(expr, { fn, mode });
}

// returns the value an allocator-mode load gets (a cell or a tainted value), else undefined
function access(
	ctx: Ctx,
	S: State,
	F: Frame,
	expr: number,
	write: boolean,
	addr: V,
	offset: number,
	size: number,
	value?: V
): V | undefined {
	const over = ctx.alloc ? allocAccess(ctx, S, write, addr, offset, size, value) : undefined;
	accessWindow(ctx, S, F, expr, write, addr, offset, size, value);
	return over;
}

function accessWindow(
	ctx: Ctx,
	S: State,
	F: Frame,
	expr: number,
	write: boolean,
	addr: V,
	offset: number,
	size: number,
	value?: V
) {
	if (write && value) {
		if (value.t) refuse('escape', 'a window address is stored to memory');
	}
	if (addr.r) {
		site(ctx, expr, F.fn, 'outside');
		return;
	}
	const lo = addr.lo + offset;
	const end = addr.hi + offset + size;
	const exact = isExact(addr);
	if (write && !ctx.windows.length) {
		if (value?.r && !ctx.alloc)
			refuse('allocator', 'a record-derived pointer is stored at a fixed address', lo);
		if (end - lo <= STORE_CAP) ctx.stores = rsAdd(ctx.stores, lo, end);
	}
	const hits = touching(ctx, lo, end);
	if (!hits.length) {
		if (write) ctx.wild.add(expr);
		site(ctx, expr, F.fn, 'outside');
		return;
	}
	if (write && value?.r && !ctx.alloc)
		refuse('allocator', 'a record-derived pointer is stored into a window', hits[0]!.lo);
	for (const h of hits) {
		if (exact) {
			if (lo < h.w.low || end > h.w.end)
				refuse('aliasing', 'an access straddles a window edge', lo);
			site(ctx, expr, F.fn, 'exact');
			if (write) {
				S.m = rsAdd(S.m, h.lo, h.end);
				ctx.written = rsAdd(ctx.written, h.lo, h.end);
				S.d = true;
			} else
				for (const r of rsSub([[h.lo, h.end]], S.m))
					ctx.unsafe = rsAdd(ctx.unsafe, r[0], r[1]);
		} else {
			const inside = lo >= h.w.low && end <= h.w.end;
			if (write && !inside) ctx.wild.add(expr);
			site(ctx, expr, F.fn, inside ? 'bounded' : 'dynamic');
			if (write) {
				ctx.written = rsAdd(ctx.written, h.lo, h.end);
				S.d = true;
			} else
				for (const r of rsSub([[h.lo, h.end]], S.m))
					ctx.unsafe = rsAdd(ctx.unsafe, r[0], r[1]);
		}
	}
}

function bulk(
	ctx: Ctx,
	S: State,
	F: Frame,
	expr: number,
	dest: V,
	src: V | undefined,
	size: V,
	fill?: V
) {
	if (size.hi === 0) return;
	if (ctx.alloc) allocBulk(ctx, S, dest, src, size, fill);
	site(ctx, expr, F.fn, 'bulk');
	const range = (a: V) => [a.lo, a.hi + size.hi] as const;
	if (!dest.r) {
		const [lo, end] = range(dest);
		if (!ctx.windows.length && end - lo <= STORE_CAP) ctx.stores = rsAdd(ctx.stores, lo, end);
		if (!touching(ctx, lo, end).length) ctx.wild.add(expr);
		for (const h of touching(ctx, lo, end)) {
			if (lo < h.w.low || end > h.w.end)
				refuse('aliasing', 'a bulk operation overlaps part of a window', h.lo);
			if (isExact(dest) && isExact(size)) S.m = rsAdd(S.m, h.lo, h.end);
			ctx.written = rsAdd(ctx.written, h.lo, h.end);
			S.d = true;
		}
	}
	if (src && !src.r) {
		const [lo, end] = range(src);
		for (const h of touching(ctx, lo, end)) {
			if (lo < h.w.low || end > h.w.end)
				refuse('aliasing', 'a bulk operation reads part of a window', h.lo);
			for (const r of rsSub([[h.lo, h.end]], S.m)) ctx.unsafe = rsAdd(ctx.unsafe, r[0], r[1]);
		}
	}
}

// #region allocator mode

interface AllocCfg {
	arenaBytes: number;
	arenaWord: number;
	assume: boolean;
}

interface Summary {
	win: Ranges;
	stack: Ranges;
	stackAny: boolean;
	arena: Ranges;
}

const emptySummary = (): Summary => ({ win: [], stack: [], stackAny: false, arena: [] });

const overlapsRanges = (r: Ranges, lo: number, end: number) => rsInter(r, [[lo, end]]).length > 0;

function summaryCovers(sum: Summary, next: Summary) {
	return (
		(!next.stackAny || sum.stackAny) &&
		rsSub(next.win, sum.win).length === 0 &&
		rsSub(next.stack, sum.stack).length === 0 &&
		rsSub(next.arena, sum.arena).length === 0
	);
}

function summaryUnion(a: Summary, b: Summary): Summary {
	const join = (x: Ranges, y: Ranges) => y.reduce((acc, r) => rsAdd(acc, r[0], r[1]), x);
	return {
		win: join(a.win, b.win),
		stack: join(a.stack, b.stack),
		stackAny: a.stackAny || b.stackAny,
		arena: join(a.arena, b.arena)
	};
}

// the signed offset interval an untainted value adds to a pointer
const deltaOf = (b: V): [number, number] | undefined =>
	b.hi <= 0x7fffffff
		? [b.lo, b.hi]
		: b.lo > 0x7fffffff
			? [b.lo - 2 ** 32, b.hi - 2 ** 32]
			: undefined;

function shiftPtr(base: V, lo: number, hi: number, t: boolean): V {
	const a = base.lo + lo;
	const b = base.hi + hi;
	return a < OFF_MIN || b > OFF_MAX ? taintV(t) : ptrV(a, b, t);
}

function allocCompare(op: string, a: V, b: V): V {
	const kind = op.replace(/[SU]$/, '');
	if (a.p && b.p) {
		let yes = false;
		let no = false;
		switch (kind) {
			case 'Eq':
				yes = isExact(a) && isExact(b) && a.lo === b.lo;
				no = a.hi < b.lo || b.hi < a.lo;
				break;
			case 'Ne':
				no = isExact(a) && isExact(b) && a.lo === b.lo;
				yes = a.hi < b.lo || b.hi < a.lo;
				break;
			case 'Lt':
				yes = a.hi < b.lo;
				no = a.lo >= b.hi;
				break;
			case 'Le':
				yes = a.hi <= b.lo;
				no = a.lo > b.hi;
				break;
			case 'Gt':
				yes = a.lo > b.hi;
				no = a.hi <= b.lo;
				break;
			default:
				yes = a.lo >= b.hi;
				no = a.hi < b.lo;
		}
		return yes ? exactV(1) : no ? exactV(0) : BOOL;
	}
	const zero = (v: V) => !v.a && isExact(v) && v.lo === 0;
	const unsigned = !op.endsWith('S');
	if (unsigned && a.p && a.lo >= 0 && zero(b))
		return exactV(kind === 'Ne' || kind === 'Gt' || kind === 'Ge' ? 1 : 0);
	if (unsigned && b.p && b.lo >= 0 && zero(a))
		return exactV(kind === 'Ne' || kind === 'Lt' || kind === 'Le' ? 1 : 0);
	return refuse(
		'ptr-compare',
		'an arena-derived value is compared with something that is not an offset of the same arena'
	);
}

function allocBin(op: string | undefined, a: V, b: V, i32Result: boolean): V {
	if (a.k || b.k) return refuse('isolation', 'the stack pointer is combined with an arena value');
	const t = a.t || b.t;
	if (op === 'Add') {
		const p = a.p && !b.a ? a : b.p && !a.a ? b : undefined;
		const d = p === a ? deltaOf(b) : p ? deltaOf(a) : undefined;
		return p && d ? shiftPtr(p, d[0], d[1], t) : taintV(t);
	}
	if (op === 'Sub') {
		if (a.p && !b.a) {
			const d = deltaOf(b);
			return d ? shiftPtr(a, -d[1], -d[0], t) : taintV(t);
		}
		if (a.p && b.p) {
			const lo = a.lo - b.hi;
			const hi = a.hi - b.lo;
			return lo >= 0 ? mk(lo, hi) : hi < 0 ? mk(lo + 2 ** 32, hi + 2 ** 32) : TOP;
		}
		return taintV(t);
	}
	if (op && COMPARE_REL[op]) return allocCompare(op, a, b);
	if (!op && i32Result) return refuse('ptr-compare', 'a wide arena-derived value is compared');
	return taintV(t);
}

function allocUn(op: string | undefined, a: V, binaryenOp: number): V {
	if (op === 'EqZ')
		return a.p && a.lo >= 0
			? exactV(0)
			: refuse('ptr-compare', 'an arena-derived value is tested against zero');
	if (binaryenOp === named.EqZInt64)
		return refuse('ptr-compare', 'a wide arena-derived value is tested against zero');
	return taintV(a.t);
}

// x & ~(2^k - 1) rounds down, so it is monotone and maps the interval ends
function maskAnd(x: V, m: V): V | undefined {
	if (!isExact(m) || isExact(x)) return undefined;
	const inv = ~m.lo >>> 0;
	if ((inv & (inv + 1)) !== 0) return undefined;
	return mk((x.lo & m.lo) >>> 0, (x.hi & m.lo) >>> 0, false, x.t);
}

const condV = (ctx: Ctx, c: V): V =>
	!ctx.alloc || !c.a
		? c
		: c.p && c.lo >= 0
			? exactV(1, c.t)
			: refuse('ptr-control', 'an arena-derived value reaches a branch condition');

const cellKey = (tag: string, at: number) => `${tag}${at}`;

function killCells(c: Map<string, V>, tag: string, lo: number, end: number) {
	for (const key of [...c.keys()]) {
		if (key[0] !== tag) continue;
		const at = Number(key.slice(1));
		if (at < end && at + 4 > lo) c.delete(key);
	}
}

function taintedCell(c: Map<string, V>, tag: string, lo: number, end: number): boolean {
	for (const [key, v] of c) {
		if (key[0] !== tag || !v.a) continue;
		const at = Number(key.slice(1));
		if (at < end && at + 4 > lo) return true;
	}
	return false;
}

const SUMMARY_FIELD = { w: 'win', k: 'stack', p: 'arena' } as const;

// one region's memory: tracked cells, then the flow-insensitive summary of tainted stores
function touchCells(
	ctx: Ctx,
	S: State,
	tag: 'w' | 'k' | 'p',
	write: boolean,
	at: number | undefined,
	lo: number,
	end: number,
	size: number,
	value: V | undefined
): V | undefined {
	const field = SUMMARY_FIELD[tag];
	if (write) {
		killCells(S.c, tag, lo, end);
		if (at !== undefined && size === 4) S.c.set(cellKey(tag, at), value!);
		if (value?.a) {
			if (tag === 'k' && at === undefined && lo === -Infinity) ctx.next.stackAny = true;
			else ctx.next[field] = rsAdd(ctx.next[field], lo, end);
		}
		return undefined;
	}
	if (at !== undefined && size === 4) {
		const cell = S.c.get(cellKey(tag, at));
		if (cell) return cell;
	}
	const tainted =
		taintedCell(S.c, tag, lo, end) ||
		overlapsRanges(ctx.sum[field], lo, end) ||
		overlapsRanges(ctx.next[field], lo, end) ||
		(tag === 'k' && (ctx.sum.stackAny || ctx.next.stackAny));
	return tainted ? taintV() : undefined;
}

function arenaRange(ctx: Ctx, addr: V, offset: number, span: number): [number, number] {
	const cfg = ctx.alloc!;
	const lo = addr.lo + offset;
	const end = addr.hi + offset + span;
	if (lo >= 0 && end <= cfg.arenaBytes) ctx.proved++;
	else if (cfg.assume) ctx.unproved++;
	else
		refuse(
			'ptr-deref',
			`an access at arena offsets [${lo}, ${end}) is not inside the ${cfg.arenaBytes}-byte arena`
		);
	return [lo, end];
}

function whollyInWindow(ctx: Ctx, lo: number, end: number): boolean {
	return ctx.windows.length
		? touching(ctx, lo, end).some((h) => lo >= h.w.low && end <= h.w.end)
		: end - lo <= STORE_CAP;
}

function allocAccess(
	ctx: Ctx,
	S: State,
	write: boolean,
	addr: V,
	offset: number,
	size: number,
	value: V | undefined
): V | undefined {
	const tainted = write && !!value?.a;
	if (addr.a) {
		if (!addr.p)
			return refuse(
				'ptr-deref',
				'an address derived from the arena base is not a plain offset'
			);
		const [lo, end] = arenaRange(ctx, addr, offset, size);
		return touchCells(ctx, S, 'p', write, isExact(addr) ? lo : undefined, lo, end, size, value);
	}
	if (addr.k) {
		const at = addr.so === undefined ? undefined : addr.so + offset;
		const lo = at ?? -Infinity;
		const end = at === undefined ? Infinity : at + size;
		if (tainted && end > 0)
			refuse(
				'ptr-store',
				'an arena-derived value is stored at or above the entry stack pointer'
			);
		return touchCells(ctx, S, 'k', write, at, lo, end, size, value);
	}
	if (addr.r) {
		if (tainted) refuse('ptr-store', 'an arena-derived value is stored into a record region');
		return undefined;
	}
	const lo = addr.lo + offset;
	const end = addr.hi + offset + size;
	if (tainted && !whollyInWindow(ctx, lo, end))
		refuse(
			'ptr-store',
			'an arena-derived value is stored at an address that is not in a window'
		);
	return touchCells(ctx, S, 'w', write, isExact(addr) ? lo : undefined, lo, end, size, value);
}

function allocBulk(ctx: Ctx, S: State, dest: V, src: V | undefined, size: V, fill: V | undefined) {
	const span = size.hi;
	const range = (v: V): [number, number] =>
		v.k && v.so === undefined
			? [-Infinity, Infinity]
			: [v.k ? v.so! : v.lo, (v.k ? v.so! : v.hi) + span];
	let tainted = !!fill?.a;
	if (src) {
		if (src.a) {
			if (!src.p)
				refuse(
					'ptr-deref',
					'a bulk source derived from the arena base is not a plain offset'
				);
			const [lo, end] = arenaRange(ctx, src, 0, span);
			tainted =
				tainted ||
				touchCells(ctx, S, 'p', false, undefined, lo, end, span, undefined) !== undefined;
		} else if (src.k) {
			const [lo, end] = range(src);
			tainted =
				tainted ||
				touchCells(ctx, S, 'k', false, undefined, lo, end, span, undefined) !== undefined;
		} else if (!src.r) {
			const [lo, end] = range(src);
			tainted =
				tainted ||
				touchCells(ctx, S, 'w', false, undefined, lo, end, span, undefined) !== undefined;
		}
	}
	const val = tainted ? taintV() : TOP;
	if (dest.a) {
		if (!dest.p)
			refuse(
				'ptr-deref',
				'a bulk destination derived from the arena base is not a plain offset'
			);
		const [lo, end] = arenaRange(ctx, dest, 0, span);
		touchCells(ctx, S, 'p', true, undefined, lo, end, span, val);
	} else if (dest.k) {
		const [lo, end] = range(dest);
		if (tainted && dest.so !== undefined && end > 0)
			refuse(
				'ptr-store',
				'arena-derived bytes are copied at or above the entry stack pointer'
			);
		touchCells(ctx, S, 'k', true, undefined, lo, end, span, val);
	} else if (dest.r) {
		if (tainted) refuse('ptr-store', 'arena-derived bytes are copied into a record region');
	} else {
		const [lo, end] = range(dest);
		if (tainted && !whollyInWindow(ctx, lo, end))
			refuse(
				'ptr-store',
				'arena-derived bytes are copied to an address that is not in a window'
			);
		touchCells(ctx, S, 'w', true, undefined, lo, end, span, val);
	}
}

// #endregion

const MEMORY_OPS = new Set([
	binaryen.LoadId,
	binaryen.StoreId,
	binaryen.MemoryFillId,
	binaryen.MemoryCopyId,
	binaryen.MemoryInitId
]);

function operands(v: any): number[] {
	switch (v.id) {
		case binaryen.BlockId:
			return v.children;
		case binaryen.IfId:
			return [v.condition, v.ifTrue, v.ifFalse].filter(Boolean);
		case binaryen.LoopId:
			return [v.body];
		case binaryen.BreakId:
		case binaryen.SwitchId:
			return [v.value, v.condition].filter(Boolean);
		case binaryen.ReturnId:
			return v.value ? [v.value] : [];
		case binaryen.SelectId:
			return [v.ifTrue, v.ifFalse, v.condition];
		case binaryen.UnaryId:
		case binaryen.DropId:
		case binaryen.LocalSetId:
		case binaryen.GlobalSetId:
			return [v.value];
		case binaryen.BinaryId:
			return [v.left, v.right];
		case binaryen.LoadId:
			return [v.ptr];
		case binaryen.StoreId:
			return [v.ptr, v.value];
		case binaryen.MemoryFillId:
			return [v.dest, v.value, v.size];
		case binaryen.MemoryCopyId:
			return [v.dest, v.source, v.size];
		case binaryen.MemoryInitId:
			return [v.dest, v.offset, v.size];
		case binaryen.CallId:
			return v.operands;
		case binaryen.CallIndirectId:
			return [...v.operands, v.target];
		default:
			return [];
	}
}

/** The loads, stores and bulk operations of a function body, in a fixed pre-order walk. */
export function memoryAccesses(body: number): number[] {
	const found: number[] = [];
	const walk = (e: number) => {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.NopId || id === binaryen.UnreachableId) return;
		const v = info(e);
		if (MEMORY_OPS.has(id)) found.push(e);
		for (const child of operands(v)) walk(child);
	};
	walk(body);
	return found;
}

const localOf = (expr: number): number | undefined => {
	const id = binaryen.getExpressionId(expr);
	if (id === binaryen.LocalGetId) return info(expr).index;
	if (id === binaryen.LocalSetId) return info(expr).index;
	return undefined;
};

/** Narrows the local a condition compares; false when that side of the branch cannot happen. */
function refine(ctx: Ctx, S: State, cond: number, truth: boolean): boolean {
	const id = binaryen.getExpressionId(cond);
	const local = localOf(cond);
	if (local !== undefined) {
		const x = S.l[local]!;
		if (x.a) return true;
		const n = narrow(x, truth ? 'ne' : 'eq', exactV(0));
		if (!n) return false;
		S.l[local] = n;
		return true;
	}
	if (id === binaryen.UnaryId) {
		const v = info(cond);
		if (I32UN.get(v.op) === 'EqZ') return refine(ctx, S, v.value, !truth);
		return true;
	}
	if (id !== binaryen.BinaryId) return true;
	const v = info(cond);
	const op = I32BIN.get(v.op);
	const rel0 = op ? COMPARE_REL[op] : undefined;
	if (!op || !rel0) return true;
	const a = ctx.vals.get(v.left);
	const b = ctx.vals.get(v.right);
	if (!a || !b) return true;
	if (op.endsWith('S') && (a.hi > 0x7fffffff || b.hi > 0x7fffffff)) return true;
	const rel = truth ? rel0 : NEGATE[rel0]!;
	const la = localOf(v.left);
	const lb = localOf(v.right);
	if (la !== undefined && !a.r && !a.a) {
		const n = narrow(S.l[la]!, rel, b);
		if (!n) return false;
		S.l[la] = n;
	}
	if (lb !== undefined && !b.r && !b.a) {
		const n = narrow(S.l[lb]!, MIRROR[rel]!, a);
		if (!n) return false;
		S.l[lb] = n;
	}
	return true;
}

const decide = (c: V): 'yes' | 'no' | 'maybe' => (c.lo > 0 ? 'yes' : c.hi === 0 ? 'no' : 'maybe');

function push(F: Frame, name: string, s: State, v: V | undefined) {
	const list = F.pend.get(name);
	if (!list) return refuse('unsupported', `branch to unknown label ${name}`);
	list.push({ s, v });
}

function merge(S: State, outs: Pend[]): V | undefined {
	if (!outs.length) throw END;
	const j = joinStates(outs.map((o) => o.s));
	if (outs.length > 1 || outs[0]!.s !== S) {
		S.l = j.l;
		S.g = j.g;
		S.m = j.m;
		S.d = j.d;
		S.sp = j.sp;
		S.c = j.c;
	}
	return joinVals(outs.map((o) => o.v));
}

function ev(ctx: Ctx, e: number, S: State, F: Frame): V | undefined {
	if (++ctx.steps > ctx.maxSteps) refuse('budget', `more than ${ctx.maxSteps} steps`);
	const id = binaryen.getExpressionId(e);
	const v = id === binaryen.NopId || id === binaryen.UnreachableId ? undefined : info(e);
	switch (id) {
		case binaryen.NopId:
			return undefined;
		case binaryen.ConstId: {
			if (v.type !== binaryen.i32) return TOP;
			const c = v.value >>> 0;
			const t = ctx.windows.some((w) => c >= w.low && c <= w.end);
			return exactV(c, t);
		}
		case binaryen.LocalGetId:
			return S.l[v.index]!;
		case binaryen.LocalSetId: {
			const val = ev(ctx, v.value, S, F)!;
			S.l[v.index] = val;
			return v.isTee ? val : undefined;
		}
		case binaryen.GlobalGetId: {
			if (v.name === ctx.sp)
				return mk(0, M32, true, false, -1, Number.isNaN(S.sp) ? undefined : S.sp, true);
			const i = ctx.globalIndex.get(v.name);
			if (i !== undefined) return S.g[i]!;
			return ctx.globalConst.get(v.name) ?? TOP;
		}
		case binaryen.GlobalSetId: {
			const val = ev(ctx, v.value, S, F)!;
			if (v.name === ctx.sp) {
				if (!val.r || val.t || !val.k)
					refuse(
						'isolation',
						'the stack pointer is set to a value that is not a stack address'
					);
				S.sp = val.so ?? NaN;
				return undefined;
			}
			if (val.t) refuse('escape', `a window address is written to global ${v.name}`);
			if (ctx.alloc && val.a)
				refuse('ptr-store', `an arena-derived value is written to global ${v.name}`);
			if (val.r)
				refuse('allocator', `a record-derived pointer is written to global ${v.name}`);
			return refuse('isolation', `the closure writes global ${v.name}`);
		}
		case binaryen.DropId:
			ev(ctx, v.value, S, F);
			return undefined;
		case binaryen.BlockId: {
			const name: string = v.name;
			const prev = name ? F.pend.get(name) : undefined;
			if (name) F.pend.set(name, []);
			let val: V | undefined;
			let fell = true;
			try {
				for (const k of v.children as number[]) val = ev(ctx, k, S, F);
			} catch (x) {
				if (x !== END) throw x;
				fell = false;
			}
			const outs = name ? F.pend.get(name)! : [];
			if (name) {
				if (prev) F.pend.set(name, prev);
				else F.pend.delete(name);
			}
			if (fell) outs.push({ s: S, v: val });
			const merged = merge(S, outs);
			return v.type === binaryen.none ? undefined : merged;
		}
		case binaryen.IfId: {
			const c = condV(ctx, ev(ctx, v.condition, S, F)!);
			noStack(c, 'a branch condition');
			const arm = (expr: number, s: State) => {
				if (!expr) return { ok: true, v: undefined as V | undefined, s };
				try {
					return { ok: true, v: ev(ctx, expr, s, F), s };
				} catch (x) {
					if (x !== END) throw x;
					return { ok: false, v: undefined as V | undefined, s };
				}
			};
			const d = decide(c);
			if (d !== 'maybe') {
				if (!refine(ctx, S, v.condition, d === 'yes')) throw END;
				const r = arm(d === 'yes' ? v.ifTrue : v.ifFalse, S);
				if (!r.ok) throw END;
				return v.type === binaryen.none ? undefined : r.v;
			}
			ctx.forks++;
			const A = cloneState(S);
			const outs: Pend[] = [];
			if (refine(ctx, A, v.condition, true)) {
				const r = arm(v.ifTrue, A);
				if (r.ok) outs.push({ s: A, v: r.v });
			}
			if (refine(ctx, S, v.condition, false)) {
				const r = arm(v.ifFalse, S);
				if (r.ok) outs.push({ s: S, v: r.v });
			}
			const merged = merge(S, outs);
			return v.type === binaryen.none ? undefined : merged;
		}
		case binaryen.LoopId:
			return evalLoop(ctx, v, S, F);
		case binaryen.BreakId: {
			const val = v.value ? ev(ctx, v.value, S, F) : undefined;
			if (!v.condition) {
				push(F, v.name, cloneState(S), val);
				throw END;
			}
			const c = condV(ctx, ev(ctx, v.condition, S, F)!);
			noStack(c, 'a branch condition');
			const d = decide(c);
			if (d === 'yes') {
				push(F, v.name, cloneState(S), val);
				throw END;
			}
			if (d === 'maybe') {
				ctx.forks++;
				const A = cloneState(S);
				if (refine(ctx, A, v.condition, true)) push(F, v.name, A, val);
				if (!refine(ctx, S, v.condition, false)) throw END;
			}
			return val;
		}
		case binaryen.SwitchId: {
			const val = v.value ? ev(ctx, v.value, S, F) : undefined;
			const c = ev(ctx, v.condition, S, F)!;
			noStack(c, 'a branch condition');
			if (ctx.alloc && c.a)
				refuse('ptr-control', 'an arena-derived value selects a branch target');
			const names: string[] = v.names;
			if (isExact(c))
				push(F, c.lo < names.length ? names[c.lo]! : v.defaultName, cloneState(S), val);
			else {
				ctx.forks++;
				for (const n of new Set([...names, v.defaultName])) push(F, n, cloneState(S), val);
			}
			throw END;
		}
		case binaryen.ReturnId: {
			const val = v.value ? ev(ctx, v.value, S, F) : undefined;
			F.rets.push({ s: cloneState(S), v: val });
			throw END;
		}
		case binaryen.UnreachableId:
			if (S.d) refuse('failure', 'a trap is reachable after a window write');
			throw END;
		case binaryen.SelectId: {
			const a = ev(ctx, v.ifTrue, S, F)!;
			const b = ev(ctx, v.ifFalse, S, F)!;
			const c = condV(ctx, ev(ctx, v.condition, S, F)!);
			noStack(c, 'a select condition');
			const d = decide(c);
			return d === 'yes' ? a : d === 'no' ? b : joinV(a, b);
		}
		case binaryen.UnaryId: {
			const a = ev(ctx, v.value, S, F)!;
			// a stack address is never zero, so a null check of one is decided
			if (ctx.alloc && a.k && I32UN.get(v.op) === 'EqZ') return exactV(0);
			noStack(a, 'read as data');
			ctx.vals.set(v.value, a);
			const op = I32UN.get(v.op);
			if (ctx.alloc && a.a) return allocUn(op, a, v.op);
			if (op === 'EqZ') return a.lo > 0 ? exactV(0) : a.hi === 0 ? exactV(1) : BOOL;
			if (op === 'Clz' || op === 'Ctz' || op === 'Popcnt') {
				if (isExact(a)) {
					const x = a.lo;
					const r =
						op === 'Clz'
							? Math.clz32(x)
							: op === 'Popcnt'
								? x.toString(2).replace(/0/g, '').length
								: x === 0
									? 32
									: 31 - Math.clz32(x & -x);
					return exactV(r);
				}
				return mk(0, 32);
			}
			if (op) {
				if (!isExact(a)) return dataV(a.t);
				const x = op === 'Extend8S' ? (a.lo << 24) >> 24 : (a.lo << 16) >> 16;
				return exactV(x, a.t);
			}
			if (v.type === binaryen.i32) return v.op === named.EqZInt64 ? BOOL : dataV(a.t);
			return dataV(a.t);
		}
		case binaryen.BinaryId: {
			const a = ev(ctx, v.left, S, F)!;
			const b = ev(ctx, v.right, S, F)!;
			ctx.vals.set(v.left, a);
			ctx.vals.set(v.right, b);
			const op = I32BIN.get(v.op);
			if (ctx.alloc && (a.a || b.a)) return allocBin(op, a, b, v.type === binaryen.i32);
			if (ctx.alloc && op === 'And' && !a.r && !b.r) {
				const m = maskAnd(a, b) ?? maskAnd(b, a);
				if (m) return m;
			}
			if (op) return bin32(op, a, b, ctx.conv.recordBytes);
			if (v.type === binaryen.i32) return BOOL;
			return dataV(a.t || b.t);
		}
		case binaryen.LoadId: {
			if (v.isAtomic) return refuse('unsupported', 'atomic load');
			const addr = ev(ctx, v.ptr, S, F)!;
			const offset = BigInt.asUintN(32, BigInt(v.offset));
			const over = access(ctx, S, F, e, false, addr, Number(offset), v.bytes);
			if (over) return v.type === binaryen.i32 || over.a ? over : TOP;
			if (v.type !== binaryen.i32) return TOP;
			if (
				ctx.alloc &&
				v.bytes === 4 &&
				addr.r &&
				addr.tb >= 0 &&
				addr.tb + Number(offset) === ctx.alloc.arenaWord
			)
				return ptrV(0, 0);
			if (
				v.bytes === 4 &&
				addr.r &&
				addr.tb >= 0 &&
				ctx.conv.pointers.includes(addr.tb + Number(offset))
			)
				return mk(0, M32, true);
			if (v.bytes === 1 && !v.isSigned) return mk(0, 255);
			if (v.bytes === 2 && !v.isSigned) return mk(0, 65535);
			return TOP;
		}
		case binaryen.StoreId: {
			if (v.isAtomic) return refuse('unsupported', 'atomic store');
			const addr = ev(ctx, v.ptr, S, F)!;
			const val = ev(ctx, v.value, S, F)!;
			noStack(val, 'stored as data');
			const offset = BigInt.asUintN(32, BigInt(v.offset));
			access(ctx, S, F, e, true, addr, Number(offset), v.bytes, val);
			return undefined;
		}
		case binaryen.MemoryFillId: {
			const dest = ev(ctx, v.dest, S, F)!;
			const fill = ev(ctx, v.value, S, F);
			noStack(fill, 'stored as data');
			const size = ev(ctx, v.size, S, F)!;
			noStack(size, 'a bulk size');
			if (ctx.alloc && size.a) refuse('ptr-deref', 'a bulk size derived from the arena base');
			bulk(ctx, S, F, e, dest, undefined, size, fill);
			return undefined;
		}
		case binaryen.MemoryCopyId: {
			const dest = ev(ctx, v.dest, S, F)!;
			const src = ev(ctx, v.source, S, F)!;
			const size = ev(ctx, v.size, S, F)!;
			noStack(size, 'a bulk size');
			if (ctx.alloc && size.a) refuse('ptr-deref', 'a bulk size derived from the arena base');
			bulk(ctx, S, F, e, dest, src, size);
			return undefined;
		}
		case binaryen.MemoryInitId: {
			const dest = ev(ctx, v.dest, S, F)!;
			noStack(ev(ctx, v.offset, S, F), 'a bulk offset');
			const size = ev(ctx, v.size, S, F)!;
			noStack(size, 'a bulk size');
			if (ctx.alloc && size.a) refuse('ptr-deref', 'a bulk size derived from the arena base');
			bulk(ctx, S, F, e, dest, undefined, size);
			return undefined;
		}
		case binaryen.DataDropId:
			return undefined;
		case binaryen.MemorySizeId:
			return TOP;
		case binaryen.CallId: {
			const args = (v.operands as number[]).map((o) => ev(ctx, o, S, F)!);
			const target = binaryen.getFunctionInfo(ctx.module.getFunction(v.target));
			if (target.module) {
				for (const a of args) noStack(a, 'given to the host');
				if (ctx.alloc && args.some((a) => a.a))
					refuse(
						'ptr-import',
						`an arena-derived value is passed to import ${target.module}.${target.base}`
					);
				if (!ctx.windows.length) return v.type === binaryen.none ? undefined : TOP;
				if (args.some((a) => a.t))
					refuse(
						'escape',
						`a window address is passed to import ${target.module}.${target.base}`
					);
			}
			return callFn(ctx, v.target, args, S);
		}
		case binaryen.CallIndirectId:
			return refuse('isolation', 'the closure calls through a table');
		default:
			return refuse('unsupported', `expression kind ${id}`);
	}
}

function callFn(ctx: Ctx, name: string, args: V[], S: State): V | undefined {
	const f = fnInfo(ctx, name);
	if (ctx.stack.includes(name)) refuse('unsupported', `recursion through ${name}`);
	ctx.calls++;
	ctx.visited.add(name);
	const l: V[] = [];
	for (let i = 0; i < f.types.length; i++) l.push(i < f.params ? (args[i] ?? TOP) : exactV(0));
	const cs: State = { l, g: S.g.slice(), m: S.m, d: S.d, sp: S.sp, c: S.c };
	const F: Frame = { pend: new Map(), rets: [], fn: name };
	const outs: Pend[] = F.rets;
	ctx.stack.push(name);
	try {
		const val = ev(ctx, f.body, cs, F);
		outs.push({ s: cs, v: val });
	} catch (x) {
		if (x !== END) throw x;
	} finally {
		ctx.stack.pop();
	}
	if (!outs.length) throw END;
	const j = joinStates(outs.map((o) => ({ ...o.s, l: [] })));
	S.g = j.g;
	S.m = j.m;
	S.d = j.d;
	S.sp = j.sp;
	S.c = j.c;
	return joinVals(outs.map((o) => o.v));
}

function evalLoop(ctx: Ctx, v: any, S: State, F: Frame): V | undefined {
	ctx.loops++;
	const name: string = v.name;
	const prev = name ? F.pend.get(name) : undefined;
	let head = cloneState(S);
	const exits: Pend[] = [];
	let rounds = 0;
	let undecided = 0;
	let wide = false;
	try {
		for (;;) {
			F.pend.set(name, []);
			const forks0 = ctx.forks;
			const h = cloneState(head);
			try {
				const val = ev(ctx, v.body, h, F);
				exits.push({ s: h, v: val });
			} catch (x) {
				if (x !== END) throw x;
			}
			const backs = F.pend.get(name)!;
			if (!backs.length) break;
			if (!wide && backs.length === 1 && (ctx.forks === forks0 || ++undecided <= 8)) {
				head = backs[0]!.s;
				continue;
			}
			wide = true;
			rounds++;
			const next = joinStates([head, ...backs.map((b) => b.s)]);
			if (rounds > 2 && !thresholds.length) loadThresholds(ctx);
			const grown = rounds > 2 ? widenState(head, next) : next;
			if (sameState(grown, head)) break;
			head = grown;
		}
	} finally {
		if (prev) F.pend.set(name, prev);
		else F.pend.delete(name);
	}
	const merged = merge(S, exits);
	return v.type === binaryen.none ? undefined : merged;
}

function loadThresholds(ctx: Ctx) {
	const set = new Set<number>([0, 1, M32]);
	const text = ctx.module.emitText();
	for (const m of text.matchAll(/i32\.const (-?\d+)/g)) {
		const c = Number(m[1]) >>> 0;
		for (const x of [c - 1, c, c + 1]) if (x >= 0 && x <= M32) set.add(x);
	}
	thresholds = [...set].sort((a, b) => a - b);
}

// #endregion

// #region certificates

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

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
	let count = 0;
	while (cursor < bytes.length) {
		const id = bytes[cursor++]!;
		const length = leb();
		const end = cursor + length;
		if (id === 5) count += leb();
		if (id === 2) {
			const n = leb();
			for (let i = 0; i < n; i++) {
				for (let part = 0; part < 2; part++) {
					const size = leb();
					cursor += size;
				}
				const kind = bytes[cursor++]!;
				if (kind === 2) count++;
				if (kind === 0) leb();
				else if (kind === 2) {
					const flags = leb();
					leb();
					if (flags & 1) leb();
				} else return -1;
			}
		}
		cursor = end;
	}
	return count;
}

const alignOut = (lo: number, end: number): OwnershipWindow => ({
	low: Math.floor(lo / PAGE_LINE) * PAGE_LINE,
	end: Math.ceil(end / PAGE_LINE) * PAGE_LINE
});

function mergeWindows(list: OwnershipWindow[]): OwnershipWindow[] {
	const sorted = list.map((w) => ({ ...w })).sort((a, b) => a.low - b.low);
	const out: OwnershipWindow[] = [];
	for (const w of sorted) {
		const top = out[out.length - 1];
		if (top && w.low <= top.end) top.end = Math.max(top.end, w.end);
		else out.push(w);
	}
	return out;
}

const compactImports = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

function makeCtx(
	module: binaryen.Module,
	conv: OwnershipConvention,
	sp: string | undefined,
	maxSteps: number
): Ctx {
	const globalIndex = new Map<string, number>();
	const globalInit: V[] = [];
	const globalConst = new Map<string, V>();
	for (let i = 0; i < module.getNumGlobals(); i++) {
		const g = binaryen.getGlobalInfo(module.getGlobalByIndex(i));
		if (g.module) refuse('unsupported', `imported global ${g.name}`);
		const init = info(g.init);
		const value =
			binaryen.getExpressionId(g.init) === binaryen.ConstId && g.type === binaryen.i32
				? exactV(init.value)
				: TOP;
		if (g.mutable && g.name !== sp) {
			globalIndex.set(g.name, globalInit.length);
			globalInit.push(value);
		} else if (!g.mutable) globalConst.set(g.name, value);
	}
	return {
		module,
		windows: [],
		conv,
		sp,
		globalIndex,
		globalInit,
		globalConst,
		maxSteps,
		steps: 0,
		forks: 0,
		calls: 0,
		loops: 0,
		written: [],
		unsafe: [],
		stores: [],
		sites: new Map(),
		wild: new Set(),
		visited: new Set(),
		stack: [],
		fns: new Map(),
		vals: new Map(),
		alloc: undefined,
		sum: emptySummary(),
		next: emptySummary(),
		proved: 0,
		unproved: 0
	};
}

function runEntry(ctx: Ctx, entry: string, types: number[]): { value: V | undefined; m: Ranges } {
	const c = ctx.conv;
	const args: V[] = types.map((_, i) =>
		i === c.table
			? mk(0, M32, true, false, 0)
			: i === c.count
				? exactV(1)
				: i === c.out
					? mk(0, M32, true)
					: TOP
	);
	const S: State = { l: [], g: ctx.globalInit.slice(), m: [], d: false, sp: 0, c: new Map() };
	const value = callFn(ctx, entry, args, S);
	if (S.sp !== 0) refuse('isolation', 'the stack pointer is not restored on every path');
	return { value, m: S.m };
}

function scanImage(module: binaryen.Module, windows: OwnershipWindow[]) {
	const count: number = (module as any).getNumDataSegments();
	for (let i = 0; i < count; i++) {
		let seg: any;
		try {
			seg = (module as any).getDataSegmentInfo((module as any).getDataSegmentByIndex(i));
		} catch {
			return refuse('unsupported', 'a data segment offset is not a plain constant');
		}
		const data = new Uint8Array(seg.data);
		const base = seg.passive ? 0 : seg.offset;
		const first = (4 - (base % 4)) % 4;
		for (let k = first; k + 4 <= data.length; k += 4) {
			const word =
				(data[k]! | (data[k + 1]! << 8) | (data[k + 2]! << 16) | (data[k + 3]! << 24)) >>>
				0;
			if (windows.some((w) => word >= w.low && word <= w.end))
				refuse(
					'isolation',
					`a window address sits in the initial data at ${base + k}`,
					base + k
				);
		}
	}
}

const ASSUMPTIONS = [
	'record regions (table, out slots, inputs, aux, arena slices, stack slots) do not overlap a window',
	'record-derived pointers stay inside their regions',
	'an implicit trap discards the private copies and the serial path decides',
	'the start function and the host leave the baseline window bytes the private copies start from',
	'the stack pointer discipline and stack residue are not proved'
];

const ALLOCATOR_RULES: Record<ProvenanceRule, string> = {
	store: 'an arena-derived value is stored only into the arena, a window or the tracked stack',
	return: 'no arena-derived value is returned from the entry',
	import: 'no arena-derived value is passed to an import',
	compare:
		'an arena-derived value is compared only with another offset of the arena, or tested against zero',
	control: 'no arena-derived value other than a plain pointer reaches a branch condition',
	deref: 'every dereference of an arena-derived address lies inside the arena by the interval proof'
};

const ALLOCATOR_SHIFT =
	'a router may start a record with the arena word set to any base whose arena-sized range lies in memory the record owns and overlaps no other region; it compares the output slot and all memory except that arena, the pointerCells window bytes and stack residue';

const ALLOCATOR_ASSUMPTIONS = [
	'the arena base is nonzero and the arena slice holds at least arenaBytes',
	'the arena content before the record is data, and the same at every base',
	'no other record or window overlaps the arena range of this record',
	'a stack access at an unknown offset stays inside the frames the record allocates'
];

export function certifyOwnership(
	bytes: Uint8Array,
	options: OwnershipOptions = {}
): OwnershipCertificate | OwnershipRefusal {
	const entry = options.entry ?? 'bulk';
	const conv: OwnershipConvention = {
		table: 0,
		count: 1,
		out: 2,
		pointers: [0, 8, 12],
		recordBytes: 16,
		...options.convention
	};
	const proposed = (options.proposed ?? []).map((w) => ({ low: w.low, end: w.end }));
	const fail = (reason: OwnershipReason, detail: string, address?: number): OwnershipRefusal => ({
		kind: 'refusal',
		reason,
		obligation: OBLIGATION_OF[reason],
		detail,
		...(address === undefined ? {} : { address })
	});
	try {
		new WebAssembly.Module(Uint8Array.from(bytes));
	} catch {
		return fail('invalid', 'the bytes are not a valid module');
	}
	if (memoryCount(bytes) !== 1) return fail('unsupported', 'the module needs exactly one memory');
	let module: binaryen.Module;
	try {
		module = binaryen.readBinary(bytes);
	} catch {
		return fail('invalid', 'the module cannot be read');
	}
	thresholds = [];
	try {
		module.setFeatures(binaryen.Features.All & ~compactImports);
		const mem = module.getMemoryInfo();
		if (mem.shared || mem.is64) return fail('unsupported', 'the memory is shared or 64-bit');
		const exported = module.getExport(entry);
		if (!exported) return fail('unsupported', `no export named ${entry}`);
		const target = binaryen.getExportInfo(exported);
		if (target.kind !== binaryen.ExternalFunction)
			return fail('unsupported', `${entry} is not a function`);
		const entryInfo = binaryen.getFunctionInfo(module.getFunction(target.value));
		const params = binaryen.expandType(entryInfo.params);
		for (const p of [conv.table, conv.count, conv.out])
			if (params[p] !== binaryen.i32)
				return fail('unsupported', 'the convention names a parameter that is not i32');
		const sp = stackRoute(bytes).stack?.name;
		const maxSteps = options.maxSteps ?? 4_000_000;
		const alloc: AllocCfg | undefined = options.allocator
			? {
					arenaBytes: options.allocator.arenaBytes,
					arenaWord: options.allocator.arenaWord ?? 12,
					assume: !!options.allocator.assumeInArena
				}
			: undefined;
		// the taint summary is flow-insensitive: analyse again with what the last pass stored until it stops growing
		const settle = (windows: OwnershipWindow[]) => {
			let sum = emptySummary();
			for (let pass = 0; pass < 6; pass++) {
				const c = makeCtx(module, conv, sp, maxSteps);
				c.alloc = alloc;
				c.windows = windows;
				c.sum = sum;
				const r = runEntry(c, target.value, params);
				if (!alloc || summaryCovers(sum, c.next)) return { ctx: c, ...r, passes: pass + 1 };
				sum = summaryUnion(sum, c.next);
			}
			return refuse('budget', 'the taint summary did not settle in 6 passes');
		};
		const one = settle([]).ctx;
		const derived: OwnershipWindow[] = [];
		for (const [lo, end] of one.stores) derived.push(alignOut(lo, end));
		const windows = mergeWindows([...derived, ...proposed.map((w) => alignOut(w.low, w.end))]);
		if (!windows.length)
			return fail('no-window', 'no store outside the record regions has a bounded address');
		scanImage(module, windows);
		const { ctx, value, m, passes } = settle(windows);
		noStack(value, 'returned from the entry');
		if (value?.t) return fail('escape', 'the entry returns a window address');
		if (alloc && value?.a)
			return fail('ptr-return', 'the entry returns an arena-derived value');
		const bad = rsInter(ctx.unsafe, ctx.written);
		if (bad.length)
			return fail(
				'read-before-write',
				'a window byte is read before this record writes it',
				bad[0]![0]
			);
		const gap = rsSub(ctx.written, m);
		if (gap.length)
			return fail(
				'final-state',
				'a window byte is written on some paths and not on all',
				gap[0]![0]
			);
		if (alloc && ctx.unproved)
			return fail(
				'ptr-deref',
				`${ctx.unproved} heap dereferences are not provably inside the arena (every other rule held)`
			);
		const sites: Record<string, SiteCounts> = {};
		for (const { fn, mode } of ctx.sites.values()) {
			const row = (sites[fn] ??= { exact: 0, bounded: 0, dynamic: 0, outside: 0, bulk: 0 });
			row[mode]++;
		}
		const count = (key: keyof SiteCounts) =>
			Object.values(sites).reduce((n, r) => n + r[key], 0);
		const MODE_CHAR: Record<Mode, string> = {
			outside: 'o',
			exact: 'x',
			bounded: 'b',
			dynamic: 'd',
			bulk: 'k'
		};
		const accesses: Record<string, string> = {};
		for (const name of ctx.visited)
			accesses[name] = memoryAccesses(fnInfo(ctx, name).body)
				.map((e) => {
					const s = ctx.sites.get(e);
					return s ? MODE_CHAR[s.mode] : 'u';
				})
				.join('');
		return {
			kind: 'certificate',
			schema: 'folio.ownership.v1',
			checker: OWNERSHIP_CHECKER,
			moduleSha256: hex(bytes),
			entry,
			convention: conv,
			proposed,
			windows,
			copyOut: ctx.written.map((r) => [r[0], r[1]] as [number, number]),
			written: ctx.written,
			covered: m,
			sites,
			wildStores: ctx.wild.size,
			accesses,
			functions: [...ctx.visited],
			evidence: {
				'state-isolation':
					'no import, indirect call or global write in the closure; no window address in the initial data; no record pointer stored in a window',
				'read-before-write': `no byte that a path writes is read before this record writes it (${ctx.written.length} written ranges)`,
				aliasing: `${count('exact')} exact, ${count('bounded')} bounded, ${count('dynamic')} dynamic and ${count('bulk')} bulk sites; no straddle or partial bulk overlap`,
				'final-state':
					'every written byte is written on every returning path, so the last record supplies the final window',
				'escaping-addresses':
					'no window address stored, returned, written to a global or passed to a call that is not a closure function',
				failure: 'no trap is reachable after a window write'
			} as OwnershipCertificate['evidence'],
			...(alloc
				? {
						allocator: {
							arenaBytes: alloc.arenaBytes,
							arenaWord: alloc.arenaWord,
							pointerCells: summaryUnion(ctx.sum, ctx.next).win,
							arenaTaint: summaryUnion(ctx.sum, ctx.next).arena,
							derefsProved: ctx.proved,
							rules: ALLOCATOR_RULES,
							shiftRule: ALLOCATOR_SHIFT,
							assumptions: ALLOCATOR_ASSUMPTIONS
						}
					}
				: {}),
			assumptions: ASSUMPTIONS,
			stats: {
				steps: ctx.steps + one.steps,
				calls: ctx.calls,
				loops: ctx.loops,
				passes: 1 + passes
			}
		};
	} catch (error) {
		if (error instanceof Refuse) return fail(error.reason, error.detail, error.address);
		if (error === END) return fail('unsupported', 'the entry never returns');
		if (process.env.OWNERSHIP_DEBUG) console.error((error as Error).stack);
		return fail('unsupported', `internal: ${(error as Error).message}`);
	} finally {
		module.dispose();
	}
}

/** Re-derives the certificate from the module and compares everything except the work counters. */
export function verifyOwnership(bytes: Uint8Array, certificate: OwnershipCertificate): boolean {
	if (certificate.checker !== OWNERSHIP_CHECKER || certificate.schema !== 'folio.ownership.v1')
		return false;
	const again = certifyOwnership(bytes, {
		entry: certificate.entry,
		convention: certificate.convention,
		proposed: certificate.proposed,
		...(certificate.allocator
			? {
					allocator: {
						arenaBytes: certificate.allocator.arenaBytes,
						arenaWord: certificate.allocator.arenaWord
					}
				}
			: {})
	});
	if (again.kind !== 'certificate') return false;
	const strip = ({ stats: _stats, ...rest }: OwnershipCertificate) => JSON.stringify(rest);
	return strip(again) === strip(certificate);
}

/** Whether no region of the records overlaps a window. */
export function guardRecords(
	certificate: OwnershipCertificate,
	regions: [number, number][]
): boolean {
	return regions.every(([start, end]) =>
		certificate.windows.every((w) => end <= w.low || start >= w.end)
	);
}

// #endregion
