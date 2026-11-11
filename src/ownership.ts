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
	| 'prefix-store'
	| 'prefix-cover'
	| 'config-store'
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
	'prefix-store',
	'prefix-cover',
	'config-store',
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
	'prefix-store': 'read-before-write',
	'prefix-cover': 'read-before-write',
	'config-store': 'state-isolation',
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
	/**
	 * The prefix-written domain: a buffer filled up to a cursor cell. `true` finds the cell and the buffer
	 * base from the module; an object names them (a hint, the checker proves every claim itself).
	 */
	prefix?: true | { cell: number; base: number };
	/**
	 * A configuration every record shares and none writes: the table word at byte offset `word` of every
	 * record equals `at`, and the bytes `[at, at + bytes.length)` hold `bytes` when the run starts. The
	 * checker reads them as constants. `extent` is the size of the whole configuration region from `at`; a
	 * record-derived pointer is never equal to an address in it. The router checks all of this before it runs.
	 */
	config?: { word: number; at: number; bytes: Uint8Array; extent: number };
	/** The deepest nesting of one function in the call stack the checker follows; without it recursion is refused. */
	recursion?: number;
}

export interface ConfigEvidence {
	word: number;
	at: number;
	/** The frozen bytes as lowercase hex. */
	bytes: string;
	extent: number;
	rules: string[];
}

export interface PrefixEvidence {
	/** Address of the 4-byte cursor cell. */
	cell: number;
	/** Address of buffer byte 0; the bytes `[base, base + cursor)` are written by the record. */
	base: number;
	/** Cursor stores the checker discharged against the written prefix. */
	cursorStores: number;
	/** Calls analysed once per exact cursor value. */
	splits: number;
	rules: string[];
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
	/** Present only for a certificate made with the prefix option when a cursor cell was found. */
	prefix?: PrefixEvidence;
	/** Present only for a certificate made with the config option; the router checks these premises at admission. */
	config?: ConfigEvidence;
	/** Present only when the analysis followed recursion: the cap it was given and the deepest nesting it reached. */
	recursion?: { cap: number; depth: number };
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
	/** allocator mode: an i64 value whose low and high 32-bit words are known */
	pair?: [V, V];
	/** allocator mode: a pointer p that may also be exactly 0 */
	z?: boolean;
	/** the value is in [lo, s] or exactly 0xffffffff; hi is then 0xffffffff, so a reader that ignores s stays sound */
	s?: number;
	/** allocator mode: the value is the immutable unknown symbol `id` plus c, without wraparound */
	sy?: { id: number; c: number };
	/** allocator mode: a plain value that is a multiple of m (m >= 2); with a pointer it is unused */
	m?: number;
	/** allocator mode: exactly the entry stack pointer plus an offset o in [lo, hi] with o = rem mod st; so is undefined then */
	sr?: { lo: number; hi: number; st: number; rem: number };
	/** allocator mode: a plain value whose signed 32-bit reading lies in [sg0, sg1], next to the unsigned [lo, hi] */
	sg?: [number, number];
	/** allocator mode: facts that hold once this maybe-null pointer is known to be non-null */
	nn?: [string, V][];
	/** allocator mode: a pointer p at most E_k + c, where E_k is the address of a zero padding and at most eh */
	sb?: { k: number; c: number; eh: number };
	/** sentinel domain: a tagged pointer is the immutable offset symbol `id` plus c; a byte was read at offset symbol `id` plus d */
	pid?: { id: number; c: number };
	bsrc?: { id: number; d: number; k: number; n?: number };
	/** sentinel domain: the value, or the offset of a pointer, is at least the immutable symbol `id` plus c */
	lb?: { id: number; c: number };
	/** allocator mode: on a non-null fact for a static cell, the epoch of the call return that made it */
	wt?: number;
	/** prefix domain: this value is the content of the cursor cell at this address plus lk, without wraparound */
	ld?: number;
	lk?: number;
	/** prefix domain: the path epoch when an in-flight value got its tag */
	le?: number;
	/** fill pieces, only on the cell `Fk`: sorted disjoint stack ranges [lo, end, byte] written on every path; byte -1 is not known */
	fl?: [number, number, number][];
	/** allocator mode: the low 32-bit word of the immutable i64 symbol `lw`; the fact u<lw> bounds the whole i64 */
	lw?: number;
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
// a first widening stop below the limit, so that a constant added to a widened pointer is not an overflow
const OFF_MID = 2 ** 30;
const ptrV = (lo: number, hi: number, t = false, z = false): V => {
	const v = mk(lo, hi, true, t, -1, undefined, false, true, true);
	if (z) v.z = true;
	return v;
};
const taintV = (t = false): V => mk(0, M32, false, t, -1, undefined, false, true, false);
const isZero = (v: V) => !v.a && !v.r && !v.t && !v.k && isExact(v) && v.lo === 0;

const joinBase = (a: V, b: V): V => {
	if (a.a || b.a) {
		const t = a.t || b.t;
		if (a.p && b.p) return ptrV(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi), t, !!a.z || !!b.z);
		if ((a.p && isZero(b)) || (b.p && isZero(a))) {
			const p = a.p ? a : b;
			return ptrV(p.lo, p.hi, t, true);
		}
		return taintV(t);
	}
	return apartV(
		mk(
			Math.min(a.lo, b.lo),
			Math.max(a.hi, b.hi),
			a.r && b.r,
			a.t || b.t,
			a.tb === b.tb ? a.tb : -1,
			a.so === b.so ? a.so : undefined,
			a.k || b.k
		),
		a,
		b
	);
};

// a cursor tag survives a join only when both sides carry the same one
function keepTag(out: V, a: V, b: V): V {
	if (a.ld !== undefined && a.ld === b.ld && a.lk === b.lk && !out.a) {
		out.ld = a.ld;
		out.lk = a.lk;
	}
	return out;
}

// a symbol survives a join only when both sides name the same value; null facts also survive a join with exact 0
function keepSym(out: V, a: V, b: V): V {
	if (a.sy && b.sy && a.sy.id === b.sy.id && a.sy.c === b.sy.c && !out.a && out.s === undefined)
		out.sy = a.sy;
	if (a.lw !== undefined && a.lw === b.lw && !out.a) out.lw = a.lw;
	const p = a.p ? a : b.p ? b : undefined;
	const other = p === a ? b : a;
	if (p?.nn && out.p && (other === p || isZero(other) || sameNn(other.nn, p.nn))) out.nn = p.nn;
	return out;
}

function sameNn(a: [string, V][] | undefined, b: [string, V][] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every(
		([key, v], i) => key === b[i]![0] && v.lo === b[i]![1].lo && v.hi === b[i]![1].hi
	);
}

const joinV = (a: V, b: V): V =>
	ptrMKeep(
		sgKeep(
			sentKeep(stackIdxKeep(keepSym(keepTag(joinBase(a, b), a, b), a, b), a, b), a, b, false),
			a,
			b,
			false
		),
		a,
		b
	);

// the lone value 0xffffffff (a -1 sentinel) next to an interval stays apart: [lo, s] or 0xffffffff
const mainOf = (v: V): [number, number] | undefined =>
	v.s !== undefined ? [v.lo, v.s] : isExact(v) && v.lo === M32 ? undefined : [v.lo, v.hi];

function apartV(out: V, a: V, b: V): V {
	if (a.r || b.r || a.k || b.k) return out;
	const lone = (v: V) => v.s !== undefined || (isExact(v) && v.lo === M32);
	if (!lone(a) && !lone(b)) return out;
	const x = mainOf(a);
	const y = mainOf(b);
	if (!x && !y) return out;
	const hi = Math.max(x?.[1] ?? -1, y?.[1] ?? -1);
	if (hi >= M32) return out;
	out.lo = Math.min(x?.[0] ?? Infinity, y?.[0] ?? Infinity);
	out.hi = M32;
	out.s = hi;
	return out;
}

function widenApart(old: V, now: V): V {
	const j = joinV(old, now);
	if (j.s === undefined) return j;
	const o = mainOf(old);
	if (!o || j.s > o[1]) {
		const grown = j.s;
		j.s = M32;
		for (const t of thresholds)
			if (t >= grown) {
				j.s = t;
				break;
			}
	}
	if (o && j.lo < o[0]) {
		const shrunk = j.lo;
		j.lo = 0;
		for (const t of thresholds)
			if (t <= shrunk) j.lo = t;
			else break;
	}
	return j.s >= M32 ? mk(0, M32, false, j.t) : j;
}

const samePair = (a: [V, V] | undefined, b: [V, V] | undefined): boolean =>
	a === b || (!!a && !!b && sameV(a[0], b[0]) && sameV(a[1], b[1]));

function sameV(a: V, b: V): boolean {
	return (
		a.lo === b.lo &&
		a.hi === b.hi &&
		a.r === b.r &&
		a.t === b.t &&
		a.tb === b.tb &&
		a.so === b.so &&
		a.k === b.k &&
		a.a === b.a &&
		a.p === b.p &&
		!a.z === !b.z &&
		a.s === b.s &&
		a.sy?.id === b.sy?.id &&
		a.sy?.c === b.sy?.c &&
		a.m === b.m &&
		a.sg?.[0] === b.sg?.[0] &&
		a.sg?.[1] === b.sg?.[1] &&
		a.sr?.lo === b.sr?.lo &&
		a.sr?.hi === b.sr?.hi &&
		a.sr?.st === b.sr?.st &&
		a.sr?.rem === b.sr?.rem &&
		sameNn(a.nn, b.nn) &&
		a.sb?.k === b.sb?.k &&
		a.sb?.c === b.sb?.c &&
		a.pid?.id === b.pid?.id &&
		a.pid?.c === b.pid?.c &&
		a.bsrc?.id === b.bsrc?.id &&
		a.bsrc?.d === b.bsrc?.d &&
		a.bsrc?.k === b.bsrc?.k &&
		a.bsrc?.n === b.bsrc?.n &&
		a.lb?.id === b.lb?.id &&
		a.lb?.c === b.lb?.c &&
		a.ld === b.ld &&
		a.lk === b.lk &&
		a.lw === b.lw &&
		samePair(a.pair, b.pair) &&
		samePieces(a.fl, b.fl)
	);
}

let thresholds: number[] = [];

const widenV = (old: V, now: V): V =>
	sameV(old, now)
		? old
		: ptrMKeep(
				sgKeep(
					sentKeep(
						curKeep(
							keepSym(keepTag(widenBase(old, now), old, now), old, now),
							old,
							now
						),
						old,
						now,
						true
					),
					old,
					now,
					true
				),
				old,
				now
			);

function widenBase(old: V, now: V): V {
	if (sameV(old, now)) return old;
	if (old.a || now.a) {
		const t = old.t || now.t;
		if ((old.p && isZero(now)) || (now.p && isZero(old))) {
			const p = old.p ? old : now;
			return ptrV(p.lo, p.hi, t, true);
		}
		if (!(old.p && now.p)) return taintV(t);
		return ptrV(
			now.lo < old.lo ? OFF_MIN : old.lo,
			now.hi > old.hi ? (now.hi <= OFF_MID ? OFF_MID : OFF_MAX) : old.hi,
			t,
			!!old.z || !!now.z
		);
	}
	if (old.s !== undefined || now.s !== undefined) return widenApart(old, now);
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
		if (!pointer)
			refuse(
				'isolation',
				`the stack pointer is read as data (${op}) in ${activeStack[activeStack.length - 1]} ${JSON.stringify([a.k, a.r, a.so, a.lo, a.hi, b.k, b.r, b.so, b.lo, b.hi])}`
			);
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
			const below =
				isExact(b) && b.lo === M32
					? stepBelow(a)
					: isExact(a) && a.lo === M32
						? stepBelow(b)
						: undefined;
			if (below) return below;
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
			const below = isExact(b) && b.lo === 1 ? stepBelow(a) : undefined;
			if (below) return below;
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
		return sgCompare(op, a, b) ?? BOOL;
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
	if (x.s !== undefined && rel === 'ne' && isExact(y) && y.lo === M32)
		return { ...x, hi: x.s, s: undefined };
	let lo = x.lo;
	let hi = x.hi;
	switch (rel) {
		case 'eq':
			lo = Math.max(lo, curUp(y));
			hi = Math.min(hi, curDown(y));
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
			hi = Math.min(hi, curDown(y) - 1);
			break;
		case 'le':
			hi = Math.min(hi, curDown(y));
			break;
		case 'gt':
			if (y.lo === M32) return undefined;
			lo = Math.max(lo, curUp(y) + 1);
			break;
		default:
			lo = Math.max(lo, curUp(y));
	}
	if (lo > hi) return undefined;
	const n = dropApart({ ...x, lo, hi });
	return n && curRound(n);
}

// the sentinel is out once the interval no longer reaches 0xffffffff, and alone once the rest is empty
function dropApart(v: V): V | undefined {
	if (v.s === undefined) return v;
	if (v.hi < M32) {
		const hi = Math.min(v.hi, v.s);
		return v.lo > hi ? undefined : { ...v, hi, s: undefined };
	}
	return v.lo > v.s ? { ...v, lo: M32, hi: M32, s: undefined } : v;
}

// x - 1 for x in [0, k] with k >= 1 is the sentinel apart from [0, k - 1]
function stepBelow(x: V): V | undefined {
	if (x.r || x.k || x.t || x.a || x.s !== undefined || x.lo !== 0 || x.hi < 1 || x.hi >= M32)
		return undefined;
	const v = mk(0, M32);
	v.s = x.hi - 1;
	return v;
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
let activeStack: string[] = [];
const noStack = (v: V | undefined, use: string) => {
	if (v?.k)
		refuse(
			'isolation',
			`the stack pointer is ${use} in ${activeStack[activeStack.length - 1]}`
		);
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
		if (!w) continue;
		if (key === FILL_KEY) {
			const kept = fillJoin(v.fl!, w.fl!);
			if (kept.length) out.set(key, { ...TOP, fl: kept });
		} else if (widen && (key.charCodeAt(0) === 80 || key.charCodeAt(0) === 114))
			out.set(key, ordWiden(v, w));
		else out.set(key, widen ? widenV(v, w) : joinV(v, w));
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
	for (let i = 0; i < l.length; i++) {
		const v = l[i]!;
		if (v.p && v.z && !v.nn)
			l[i] = nonNullFacts(
				list.map((s) => ({ s, v: s.l[i] })),
				c,
				v
			);
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
	/** an affine relation between two locals was made in this run */
	rels: boolean;
	/** allocator mode: symbols minted so far, and a counter that paces the pruning of old facts */
	syms: number;
	factTick: number;
	prefix: PrefixCtx | undefined;
	config: ConfigCtx | undefined;
	/** the nesting cap of one function, or 1 when recursion is refused, and the deepest nesting reached */
	recursion: number;
	depth: number;
	/** cursor domain: above 0 while a loop is iterated to its head with the arena bound deferred to a final pass */
	soft: number;
	roundCap?: number;
	/** cursor domain: a cursor fact was made in this run */
	curs: boolean;
	/** sentinel domain: a word source cell was made in this run */
	srcs: boolean;
	/** sentinel domain: a pointer order cell was made in this run */
	ords: boolean;
	/** the dispatch locals of each loop body, by body expression */
	dispatch: Map<number, number[]>;
	/** a block expression followed by a loop with dispatch locals, to the loop expression; 0 for none */
	splits: Map<number, number>;
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
	const over = ctx.alloc
		? allocAccess(ctx, S, write, addr, offset, size, value)
		: plainCells(ctx, S, write, addr, offset, size, value);
	const pre = ctx.prefix
		? prefixAccess(ctx, S, write, addr, offset, size, value, over)
		: undefined;
	accessWindow(ctx, S, F, expr, write, addr, offset, size, value);
	return pre ?? over;
}

// #region relational bounds

// contents of exact 4-byte window cells: private per record, so the last store of this record is the value
function plainCells(
	ctx: Ctx,
	S: State,
	write: boolean,
	addr: V,
	offset: number,
	size: number,
	value: V | undefined
): V | undefined {
	if (addr.r || !ctx.windows.length) return undefined;
	const lo = addr.lo + offset;
	const end = addr.hi + offset + size;
	const exact =
		isExact(addr) && size === 4 && ctx.windows.some((w) => lo >= w.low && end <= w.end);
	if (!write) return exact ? S.c.get(cellKey('w', lo)) : undefined;
	killCells(S.c, 'w', lo, end);
	if (exact && value) S.c.set(cellKey('w', lo), value);
	return undefined;
}

// an i64 store of a constant at an exact window address gives two known words
function wideCells(ctx: Ctx, S: State, expr: number, addr: V, offset: number) {
	const c = info(expr);
	if (
		ctx.alloc ||
		addr.r ||
		!isExact(addr) ||
		binaryen.getExpressionId(expr) !== binaryen.ConstId
	)
		return;
	if (typeof c.value !== 'bigint') return;
	const lo = addr.lo + offset;
	if (!ctx.windows.some((w) => lo >= w.low && lo + 8 <= w.end)) return;
	S.c.set(cellKey('w', lo), exactV(Number(BigInt.asUintN(32, c.value))));
	S.c.set(cellKey('w', lo + 4), exactV(Number(BigInt.asUintN(32, c.value >> 32n))));
}

// affine relations between locals live in the cell map under "r<fn>|y|x|k": L[y] = k * L[x] + c with
// c in the stored range, over the unsigned values. Joins keep a key only when both paths have it
const CBIAS = 2 ** 31;
const relPrefix = (fn: string) => `r${fn}|`;

interface Rel {
	y: number;
	x: number;
	k: number;
	clo: number;
	chi: number;
}

interface Form {
	x: number;
	k: number;
	c: number;
}

function relList(S: State, fn: string): Rel[] {
	const pre = relPrefix(fn);
	const out: Rel[] = [];
	for (const [key, v] of S.c) {
		if (key[0] !== 'r' || !key.startsWith(pre)) continue;
		const [y, x, k] = key.slice(pre.length).split('|').map(Number) as [number, number, number];
		out.push({ y, x, k, clo: v.lo - CBIAS, chi: v.hi - CBIAS });
	}
	return out;
}

function relPut(S: State, fn: string, r: Rel) {
	const key = `${relPrefix(fn)}${r.y}|${r.x}|${r.k}`;
	if (r.k < 1 || r.clo < -CBIAS || r.chi >= CBIAS) S.c.delete(key);
	else S.c.set(key, mk(r.clo + CBIAS, r.chi + CBIAS));
}

// a call starts with fresh locals, so the relations an earlier call of the same function left are void
function relClear(c: Map<string, V>, fn: string) {
	const pre = relPrefix(fn);
	for (const key of [...c.keys()]) if (key[0] === 'r' && key.startsWith(pre)) c.delete(key);
	curClear(c, fn);
	srcClear(c, fn);
	ordClear(c, fn);
}

function relDrop(S: State, fn: string, idx: number) {
	const pre = relPrefix(fn);
	for (const key of [...S.c.keys()]) {
		if (key[0] !== 'r' || !key.startsWith(pre)) continue;
		const [y, x] = key.slice(pre.length).split('|').map(Number);
		if (y === idx || x === idx) S.c.delete(key);
	}
}

const plain = (v: V) => !v.r && !v.a && !v.k;

// a local read, its interval cut by the relations to the other locals' current intervals
function tightLocal(ctx: Ctx, S: State, F: Frame, idx: number): V {
	const v = ctx.ords && S.l[idx]!.p ? ordTighten(S, F.fn, idx, S.l[idx]!) : S.l[idx]!;
	if (ctx.curs && v.p && !v.z) return curTightenPtr(S, F.fn, idx, v);
	if ((!ctx.rels && !ctx.curs) || !plain(v)) return v;
	let lo = v.lo;
	let hi = v.hi;
	if (ctx.curs) [lo, hi] = curTighten(S, F.fn, idx, lo, hi);
	for (const r of ctx.rels ? relList(S, F.fn) : []) {
		if (r.y === idx) {
			const X = S.l[r.x]!;
			if (!plain(X)) continue;
			lo = Math.max(lo, r.k * X.lo + r.clo);
			hi = Math.min(hi, r.k * X.hi + r.chi);
		} else if (r.x === idx) {
			const Y = S.l[r.y]!;
			if (!plain(Y)) continue;
			lo = Math.max(lo, Math.ceil((Y.lo - r.chi) / r.k));
			hi = Math.min(hi, Math.floor((Y.hi - r.clo) / r.k));
		}
	}
	if ((lo === v.lo && hi === v.hi) || lo > hi) return v;
	return dropApart({ ...v, lo, hi }) ?? v;
}

// the affine form of a small pure expression: constants, locals, one tee, add, sub, shift and multiply by a constant
function formWalk(
	ctx: Ctx,
	S: State,
	F: Frame,
	expr: number,
	y: number,
	old: V,
	sets: number[],
	gets: number[]
): Form | undefined {
	const id = binaryen.getExpressionId(expr);
	const constant = (c: number): Form => ({ x: -1, k: 0, c });
	const local = (l: number, v: V): Form | undefined =>
		!plain(v) || v.s !== undefined
			? undefined
			: isExact(v)
				? constant(v.lo | 0)
				: { x: l, k: 1, c: 0 };
	if (id === binaryen.ConstId) {
		const c = info(expr);
		return c.type === binaryen.i32 ? constant(c.value | 0) : undefined;
	}
	if (id === binaryen.LocalGetId) {
		const l = info(expr).index;
		gets.push(l);
		return local(l, l === y ? old : tightLocal(ctx, S, F, l));
	}
	if (id === binaryen.LocalSetId) {
		const e = info(expr);
		if (!e.isTee) return undefined;
		sets.push(e.index);
		return local(e.index, S.l[e.index]!);
	}
	if (id !== binaryen.BinaryId) return undefined;
	const e = info(expr);
	const op = I32BIN.get(e.op);
	if (op !== 'Add' && op !== 'Sub' && op !== 'Shl' && op !== 'Mul') return undefined;
	const a = formWalk(ctx, S, F, e.left, y, old, sets, gets);
	const b = a && formWalk(ctx, S, F, e.right, y, old, sets, gets);
	if (!a || !b) return undefined;
	if (op === 'Shl' || op === 'Mul') {
		if (b.x !== -1) return undefined;
		const m = op === 'Shl' ? 2 ** (b.c & 31) : b.c;
		return { x: a.x, k: a.k * m, c: a.c * m };
	}
	const sign = op === 'Add' ? 1 : -1;
	if (b.x === -1) return { x: a.x, k: a.k, c: a.c + sign * b.c };
	if (a.x === -1) return { x: b.x, k: sign * b.k, c: a.c + sign * b.c };
	if (a.x !== b.x) return undefined;
	const k = a.k + sign * b.k;
	return k === 0 ? constant(a.c + sign * b.c) : { x: a.x, k, c: a.c + sign * b.c };
}

// the form, kept only when the arithmetic cannot wrap for any value in the current intervals
function formOf(ctx: Ctx, S: State, F: Frame, expr: number, y: number, old: V): Form | undefined {
	const sets: number[] = [];
	const gets: number[] = [];
	const f = formWalk(ctx, S, F, expr, y, old, sets, gets);
	if (!f) return undefined;
	for (const s of sets)
		if (s === y || gets.includes(s) || sets.indexOf(s) !== sets.lastIndexOf(s))
			return undefined;
	if (f.x === -1) return f;
	const X = f.x === y ? old : tightLocal(ctx, S, F, f.x);
	const a = f.k * X.lo + f.c;
	const b = f.k * X.hi + f.c;
	return Math.min(a, b) >= 0 && Math.max(a, b) <= M32 ? f : undefined;
}

// y was just assigned: keep the relations through a constant self-increment, else drop them and add the new one
function relAssign(ctx: Ctx, S: State, F: Frame, y: number, expr: number, old: V) {
	const fn = F.fn;
	const f = formOf(ctx, S, F, expr, y, old);
	if (f && f.x === y && f.k === 1) {
		for (const r of relList(S, fn)) {
			if (r.y === y)
				relPut(S, fn, { ...r, clo: ordStep(r.clo, f.c), chi: ordStep(r.chi, f.c) });
			else if (r.x === y)
				relPut(S, fn, {
					...r,
					clo: ordStep(r.clo, -r.k * f.c),
					chi: ordStep(r.chi, -r.k * f.c)
				});
		}
		return;
	}
	relDrop(S, fn, y);
	if (!f || f.x === -1 || f.x === y || f.k < 1) return;
	ctx.rels = true;
	for (const r of relList(S, fn)) {
		if (r.y === f.x && r.x !== y)
			relPut(S, fn, {
				y,
				x: r.x,
				k: f.k * r.k,
				clo: f.k * r.clo + f.c,
				chi: f.k * r.chi + f.c
			});
		else if (r.x === f.x && f.k === 1 && r.y !== y)
			relPut(S, fn, { y: r.y, x: y, k: r.k, clo: r.clo - r.k * f.c, chi: r.chi - r.k * f.c });
	}
	relPut(S, fn, { y, x: f.x, k: f.k, clo: f.c, chi: f.c });
	if (f.k === 1) relPut(S, fn, { y: f.x, x: y, k: 1, clo: -f.c, chi: -f.c });
}

// #endregion

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
	if (write) configWrite(ctx, lo, end);
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
				for (const r of rsSub([[h.lo, h.end]], coverOf(ctx, S)))
					ctx.unsafe = rsAdd(ctx.unsafe, r[0], r[1]);
		} else {
			const inside = lo >= h.w.low && end <= h.w.end;
			if (write && !inside) ctx.wild.add(expr);
			site(ctx, expr, F.fn, inside ? 'bounded' : 'dynamic');
			if (write) {
				ctx.written = rsAdd(ctx.written, h.lo, h.end);
				S.d = true;
			} else
				for (const r of rsSub([[h.lo, h.end]], coverOf(ctx, S)))
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
	if (ctx.prefix) prefixBulk(ctx, dest, size);
	if (ctx.alloc) allocBulk(ctx, S, dest, src, size, fill);
	else if (!dest.r) killCells(S.c, 'w', dest.lo, dest.hi + size.hi);
	site(ctx, expr, F.fn, 'bulk');
	const range = (a: V) => [a.lo, a.hi + size.hi] as const;
	if (!dest.r) {
		const [lo, end] = range(dest);
		configWrite(ctx, lo, end);
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
			for (const r of rsSub([[h.lo, h.end]], coverOf(ctx, S)))
				ctx.unsafe = rsAdd(ctx.unsafe, r[0], r[1]);
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
	/** every address a store of the closure may write outside the arena, the stack and record regions */
	stored: Ranges;
	/** stack offsets that may hold a stack address */
	kptr: Ranges;
}

const emptySummary = (): Summary => ({
	win: [],
	stack: [],
	stackAny: false,
	arena: [],
	stored: [],
	kptr: []
});

const overlapsRanges = (r: Ranges, lo: number, end: number) => rsInter(r, [[lo, end]]).length > 0;

function summaryCovers(sum: Summary, next: Summary) {
	return (
		(!next.stackAny || sum.stackAny) &&
		rsSub(next.win, sum.win).length === 0 &&
		rsSub(next.stack, sum.stack).length === 0 &&
		rsSub(next.arena, sum.arena).length === 0 &&
		rsSub(next.stored, sum.stored).length === 0 &&
		rsSub(next.kptr, sum.kptr).length === 0
	);
}

function summaryUnion(a: Summary, b: Summary): Summary {
	const join = (x: Ranges, y: Ranges) => y.reduce((acc, r) => rsAdd(acc, r[0], r[1]), x);
	return {
		win: join(a.win, b.win),
		stack: join(a.stack, b.stack),
		stackAny: a.stackAny || b.stackAny,
		arena: join(a.arena, b.arena),
		stored: join(a.stored, b.stored),
		kptr: join(a.kptr, b.kptr)
	};
}

// the signed offset interval an untainted value adds to a pointer
const deltaOf = (b: V): [number, number] | undefined =>
	b.hi <= 0x7fffffff
		? [b.lo, b.hi]
		: b.lo > 0x7fffffff
			? [b.lo - 2 ** 32, b.hi - 2 ** 32]
			: b.sg
				? [b.sg[0], b.sg[1]]
				: undefined;

function shiftPtr(base: V, lo: number, hi: number, t: boolean): V {
	const a = base.lo + lo;
	const b = base.hi + hi;
	return a < OFF_MIN || b > OFF_MAX ? taintV(t) : ptrV(a, b, t);
}

function allocCompare(op: string, a: V, b: V): V {
	const kind = op.replace(/[SU]$/, '');
	const zero0 = (v: V) => !v.a && isExact(v) && v.lo === 0;
	// null-ness is the same at every base, so a test of a maybe-null pointer against zero is plain data
	if ((a.p && a.z && zero0(b)) || (b.p && b.z && zero0(a))) {
		const p = a.p ? a : b;
		if (p.lo >= 0 && (kind === 'Eq' || kind === 'Ne' || !op.endsWith('S')))
			return mk(0, 1, false, a.t || b.t);
	}
	if (a.p && b.p && !a.z && !b.z) {
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
	if ((a.z || b.z) && !(op && COMPARE_REL[op])) return taintV(t);
	if (op === 'Add') {
		const p = a.p && !b.a ? a : b.p && !a.a ? b : undefined;
		const d = p === a ? deltaOf(b) : p ? deltaOf(a) : undefined;
		return p && d
			? sentPid(
					ptrAlign(sentShift(shiftPtr(p, d[0], d[1], t), p, d[1]), p, p === a ? b : a),
					p,
					p === a ? b : a,
					1
				)
			: taintV(t);
	}
	if (op === 'Sub') {
		if (a.p && !b.a) {
			const d = deltaOf(b);
			return d
				? sentPid(
						ptrAlign(sentShift(shiftPtr(a, -d[1], -d[0], t), a, -d[0]), a, b),
						a,
						b,
						-1
					)
				: taintV(t);
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
	if (op === 'EqZ') {
		if (a.p && a.z && a.lo >= 0) return mk(0, 1, false, a.t);
		return a.p && a.lo >= 0
			? exactV(0)
			: refuse('ptr-compare', 'an arena-derived value is tested against zero');
	}
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
	ctx.alloc && c.k
		? exactV(1)
		: !ctx.alloc || !c.a
			? c
			: c.p && c.lo >= 0
				? c.z
					? mk(0, 1, false, c.t)
					: exactV(1, c.t)
				: refuse('ptr-control', 'an arena-derived value reaches a branch condition');

const cellKey = (tag: string, at: number, width = 4) => `${tag}${at}/${width}`;

function cellSpan(key: string): [number, number] {
	const slash = key.indexOf('/');
	const at = Number(key.slice(1, slash));
	return [at, at + Number(key.slice(slash + 1))];
}

function killCells(c: Map<string, V>, tag: string, lo: number, end: number) {
	// a short range meets only cells that start within 3 bytes before it, so probe those keys
	if (end - lo <= 8 && Number.isFinite(lo) && Number.isFinite(end)) {
		for (let from = lo - 3; from < end; from++)
			for (const width of [1, 2, 4, 8]) {
				if (from + width <= lo) continue;
				c.delete(cellKey(tag, from, width));
			}
		return;
	}
	for (const key of [...c.keys()]) {
		if (key[0] !== tag) continue;
		const [from, to] = cellSpan(key);
		if (from < end && to > lo) c.delete(key);
	}
}

function taintedCell(c: Map<string, V>, tag: string, lo: number, end: number): boolean {
	for (const [key, v] of c) {
		if (key[0] !== tag || !v.a) continue;
		const [from, to] = cellSpan(key);
		if (from < end && to > lo) return true;
	}
	return false;
}

const plainCell = (v: V) => isExact(v) && !v.a && !v.r && !v.k && !v.t && !v.z;

// what a store of `size` bytes leaves in a cell; a narrow store keeps only an untainted plain value
function cellValue(value: V, size: number): V | undefined {
	if (size === 4) return value.pair ? { ...value, pair: undefined } : value;
	if (size !== 1 && size !== 2) return undefined;
	if (value.a || value.r || value.k || value.t || value.z) return undefined;
	const mask = 2 ** (8 * size) - 1;
	if (value.hi <= mask) return value;
	return isExact(value) ? exactV(value.lo & mask) : mk(0, mask);
}

// the value of an exact-address load from the cells, when a cell or an exact wider cell decides it
function readCell(c: Map<string, V>, tag: string, at: number, size: number): V | undefined {
	if (size === 8) {
		const low = readCell(c, tag, at, 4);
		const high = readCell(c, tag, at + 4, 4);
		return low && high && pairWord(low) && pairWord(high) ? pairOf(low, high) : undefined;
	}
	const same = c.get(cellKey(tag, at, size));
	if (same) return same;
	// a value built byte by byte from exact cells of any width that cover it
	let value = 0;
	for (let i = size - 1; i >= 0; i--) {
		const byte = byteOfCell(c, tag, at + i);
		if (byte === undefined) return undefined;
		value = value * 256 + byte;
	}
	return exactV(value);
}

function byteOfCell(c: Map<string, V>, tag: string, pos: number): number | undefined {
	for (const width of [1, 2, 4])
		for (let from = pos - width + 1; from <= pos; from++) {
			const cell = c.get(cellKey(tag, from, width));
			if (cell && plainCell(cell)) return Math.floor(cell.lo / 2 ** (8 * (pos - from))) % 256;
		}
	return tag === 'k' ? fillByte(c, pos) : undefined;
}

const signExtend = (v: V, bytes: number): V => {
	if (v.a) return v;
	if (!isExact(v)) return v.hi < 2 ** (8 * bytes - 1) ? v : sgExtend(v, bytes);
	const bits = 32 - 8 * bytes;
	return exactV((v.lo << bits) >> bits, v.t);
};

// two stack addresses compare by their offsets, and a stack address is never zero; both hold at every stack base
function stackCompare(op: string, a: V, b: V): V | undefined {
	const kind = op.replace(/[SU]$/, '');
	if (a.k && b.k) {
		if (a.so === undefined || b.so === undefined) return BOOL;
		const x = a.so;
		const y = b.so;
		const r = { Eq: x === y, Ne: x !== y, Lt: x < y, Le: x <= y, Gt: x > y, Ge: x >= y }[
			kind as 'Eq'
		];
		return exactV(r ? 1 : 0);
	}
	const zero = (v: V) => !v.a && !v.r && !v.k && isExact(v) && v.lo === 0;
	const constant = (v: V) => !v.a && !v.r && !v.k && isExact(v);
	// a static address is not a stack address of any slot (assumed, and listed in the certificate)
	if ((kind === 'Eq' || kind === 'Ne') && ((a.k && constant(b)) || (b.k && constant(a))))
		return exactV(kind === 'Ne' ? 1 : 0);
	if (op.endsWith('S') || !((a.k && zero(b)) || (b.k && zero(a)))) return undefined;
	const nonzeroFirst = a.k;
	const r = {
		Eq: false,
		Ne: true,
		Lt: !nonzeroFirst,
		Le: !nonzeroFirst,
		Gt: nonzeroFirst,
		Ge: nonzeroFirst
	}[kind as 'Eq'];
	return exactV(r ? 1 : 0);
}

// bytes of the stack this record wrote on every path to here; the marker cells join by intersection
function markStack(S: State, at: number, size: number) {
	if (size > 4096) return;
	for (let i = 0; i < size; i++) S.c.set(cellKey('x', at + i, 1), BOOL);
}

// a stack address may be stored only into an exact 4-byte stack slot below the entry stack pointer
const stackSlotStore = (ctx: Ctx, val: V, addr: V, offset: number, bytes: number) =>
	!!ctx.alloc &&
	val.k &&
	addr.k &&
	addr.so !== undefined &&
	bytes === 4 &&
	addr.so + offset + bytes <= 0;

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
		if (tag === 'w') S.c.delete('Ne');
		killCells(S.c, tag, lo, end);
		if (tag === 'k') cutFills(S.c, lo, end);
		if (at !== undefined && size === 8 && value?.pair) {
			S.c.set(cellKey(tag, at, 4), value.pair[0]);
			S.c.set(cellKey(tag, at + 4, 4), value.pair[1]);
		} else if (at !== undefined && value) {
			const kept = cellValue(value, size);
			if (kept) S.c.set(cellKey(tag, at, size), kept);
		}
		if (value?.a) {
			if (tag === 'k' && at === undefined && lo === -Infinity) ctx.next.stackAny = true;
			else ctx.next[field] = rsAdd(ctx.next[field], lo, end);
		}
		if (value?.k && tag === 'k') ctx.next.kptr = rsAdd(ctx.next.kptr, lo, end);
		if (tag === 'k' && at !== undefined) markStack(S, at, size);
		return undefined;
	}
	if (tag === 'k' && at !== undefined) {
		for (let i = 0; i < size; i++)
			if (!S.c.has(cellKey('x', at + i, 1)) && !fillAt(S.c, at + i))
				refuse('read-before-write', 'a stack byte is read before this record writes it');
	}
	if (at !== undefined) {
		const cell = readCell(S.c, tag, at, size);
		if (cell) return cell;
	}
	if (
		tag === 'k' &&
		(overlapsRanges(ctx.sum.kptr, lo, end) || overlapsRanges(ctx.next.kptr, lo, end))
	)
		refuse('isolation', 'a stack address may be read as data');
	const tainted =
		taintedCell(S.c, tag, lo, end) ||
		overlapsRanges(ctx.sum[field], lo, end) ||
		overlapsRanges(ctx.next[field], lo, end) ||
		(tag === 'k' && (ctx.sum.stackAny || ctx.next.stackAny));
	if (!tainted && size === 8 && at !== undefined) {
		const part = halfPair(S.c, tag, at);
		if (part) return part;
	}
	return tainted ? taintV() : undefined;
}

// an 8-byte read where one word is a plain cell and the other was never written is that word and the unknown word
function halfPair(c: Map<string, V>, tag: string, at: number): V | undefined {
	const low = readCell(c, tag, at, 4);
	const high = readCell(c, tag, at + 4, 4);
	if (!low && !high) return undefined;
	if ((low && !plainCell(low)) || (high && !plainCell(high))) return undefined;
	return pairOf(low ?? TOP, high ?? TOP);
}

// a word of an i64 pair is an exact plain value or a pure arena pointer; the pair is arena-derived when a word is
const pairWord = (v: V) => plainCell(v) || (v.a && v.p && !v.z && !v.k && !v.t);
const pairOf = (low: V, high: V): V => ({ ...TOP, a: low.a || high.a, pair: [low, high] });

function arenaRange(ctx: Ctx, addr: V, offset: number, span: number): [number, number] {
	const cfg = ctx.alloc!;
	const lo = addr.lo + offset;
	const end = addr.hi + offset + span;
	if (lo >= 0 && end <= cfg.arenaBytes) ctx.proved++;
	else if (cfg.assume) ctx.unproved++;
	else if (!ctx.soft)
		refuse(
			'ptr-deref',
			`an access at arena offsets [${lo}, ${end}) is not inside the ${cfg.arenaBytes}-byte arena in ${ctx.stack[ctx.stack.length - 1]}`
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
				`an address derived from the arena base is not a plain offset in ${ctx.stack[ctx.stack.length - 1]}`
			);
		if (addr.z)
			return refuse(
				'ptr-deref',
				`a pointer that may be null is dereferenced in ${ctx.stack[ctx.stack.length - 1]}`
			);
		const [lo, end] = arenaRange(ctx, addr, offset, size);
		if (write) sentWrite(S, addr, offset, size);
		const set = isExact(addr) ? undefined : byteIdxSet(addr, offset, size);
		if (set) {
			if (write) return byteIdxWrite(ctx, S, set, lo, end, size, value);
			const joined = byteIdxRead(S, set, size);
			if (joined) return joined;
		}
		return touchCells(ctx, S, 'p', write, isExact(addr) ? lo : undefined, lo, end, size, value);
	}
	if (addr.k) {
		const sr = addr.so === undefined ? addr.sr : undefined;
		if (sr && sr.hi + offset + size <= 0) {
			const joined = write ? undefined : stackIdxRead(S, sr, offset, size);
			if (joined) return joined;
			if (!write && !stackIdxWritten(S, sr, offset, size))
				refuse('read-before-write', 'a stack byte is read before this record writes it');
			const from = sr.lo + offset;
			return touchCells(
				ctx,
				S,
				'k',
				write,
				undefined,
				from,
				sr.hi + offset + size,
				size,
				value
			);
		}
		const at = addr.so === undefined ? undefined : addr.so + offset;
		const lo = at ?? -Infinity;
		const end = at === undefined ? Infinity : at + size;
		if (!write && at === undefined)
			refuse(
				'read-before-write',
				`a stack read at an unknown offset may name a byte this record never wrote in ${ctx.stack[ctx.stack.length - 1]}`
			);
		if (tainted && end > 0)
			refuse(
				'ptr-store',
				'an arena-derived value is stored at or above the entry stack pointer'
			);
		if (at !== undefined && end > 0)
			refuse(
				'isolation',
				`a stack access reaches or passes the entry stack pointer in ${ctx.stack[ctx.stack.length - 1]}`
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
	if (write) ctx.next.stored = rsAdd(ctx.next.stored, lo, end);
	return touchCells(ctx, S, 'w', write, isExact(addr) ? lo : undefined, lo, end, size, value);
}

function allocBulk(ctx: Ctx, S: State, dest: V, src: V | undefined, size: V, fill: V | undefined) {
	const span = size.hi;
	const range = (v: V): [number, number] => {
		if (v.k && v.so !== undefined && v.so + span > 0)
			refuse('isolation', 'a bulk stack access reaches or passes the entry stack pointer');
		return v.k && v.so === undefined
			? [-Infinity, Infinity]
			: [v.k ? v.so! : v.lo, (v.k ? v.so! : v.hi) + span];
	};
	let tainted = !!fill?.a;
	if (src) {
		if (src.a) {
			if (!src.p)
				refuse(
					'ptr-deref',
					'a bulk source derived from the arena base is not a plain offset'
				);
			if (src.z) refuse('ptr-deref', 'a bulk source that may be null');
			const [lo, end] = arenaRange(ctx, src, 0, span);
			tainted =
				tainted ||
				touchCells(ctx, S, 'p', false, undefined, lo, end, span, undefined) !== undefined;
		} else if (src.k) {
			const [lo, end] = range(src);
			const read = touchCells(ctx, S, 'k', false, undefined, lo, end, span, undefined);
			if (end > lo && !stackWritten(S, lo, end))
				refuse(
					'read-before-write',
					'a bulk read of the stack may name a byte this record never wrote'
				);
			tainted = tainted || read !== undefined;
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
		if (dest.z) refuse('ptr-deref', 'a bulk destination that may be null');
		const [lo, end] = arenaRange(ctx, dest, 0, span);
		sentWrite(S, dest, 0, span);
		touchCells(ctx, S, 'p', true, undefined, lo, end, span, val);
		if (
			!src &&
			fill &&
			isZero(fill) &&
			isExact(size) &&
			size.lo >= 1 &&
			size.lo <= SENT_MAX_WIDTH
		)
			sentMake(ctx, S, dest, size.lo);
	} else if (dest.k) {
		const [lo, end] = range(dest);
		if (tainted && dest.so !== undefined && end > 0)
			refuse(
				'ptr-store',
				'arena-derived bytes are copied at or above the entry stack pointer'
			);
		touchCells(ctx, S, 'k', true, undefined, lo, end, span, val);
		if (dest.so !== undefined && isExact(size)) {
			if (span <= SHIM_CELLS) markStack(S, dest.so, span);
			else
				addFill(
					S.c,
					dest.so,
					dest.so + span,
					!src && fill && plainCell(fill) ? fill.lo & 255 : -1
				);
		}
	} else if (dest.r) {
		if (tainted) refuse('ptr-store', 'arena-derived bytes are copied into a record region');
	} else {
		const [lo, end] = range(dest);
		if (tainted && !whollyInWindow(ctx, lo, end))
			refuse(
				'ptr-store',
				'arena-derived bytes are copied to an address that is not in a window'
			);
		ctx.next.stored = rsAdd(ctx.next.stored, lo, end);
		touchCells(ctx, S, 'w', true, undefined, lo, end, span, val);
	}
}

interface Segment {
	base: number;
	bytes: Uint8Array;
}

const SEGMENTS = new WeakMap<binaryen.Module, Segment[]>();

// the active data segments with a constant offset; the others are never read as constants
function segmentsOf(module: binaryen.Module): Segment[] {
	let list = SEGMENTS.get(module);
	if (list) return list;
	list = [];
	const count: number = (module as any).getNumDataSegments();
	for (let i = 0; i < count; i++) {
		try {
			const seg = (module as any).getDataSegmentInfo(
				(module as any).getDataSegmentByIndex(i)
			);
			if (!seg.passive && typeof seg.offset === 'number')
				list.push({ base: seg.offset >>> 0, bytes: new Uint8Array(seg.data) });
		} catch {
			// a segment with a computed offset is not read as a constant
		}
	}
	SEGMENTS.set(module, list);
	return list;
}

// a load at an exact address inside an initial data segment that no store of the closure can reach
function dataLoad(ctx: Ctx, addr: V, offset: number, v: any): V | undefined {
	if (addr.r || addr.a || addr.k || !isExact(addr)) return undefined;
	const lo = addr.lo + offset;
	const bytes: number = v.bytes;
	const wide = v.type === binaryen.i64 && bytes === 8;
	if (v.type !== binaryen.i32 && !wide) return undefined;
	const end = lo + bytes;
	if (overlapsRanges(ctx.sum.stored, lo, end) || overlapsRanges(ctx.next.stored, lo, end))
		return undefined;
	const seg = segmentsOf(ctx.module).find((s) => lo >= s.base && end <= s.base + s.bytes.length);
	if (!seg) return undefined;
	const word = (at: number, n: number) => {
		let x = 0;
		for (let i = n - 1; i >= 0; i--) x = x * 256 + seg.bytes[at - seg.base + i]!;
		return x;
	};
	if (wide) return { ...TOP, pair: [exactV(word(lo, 4)), exactV(word(lo + 4, 4))] };
	const raw = word(lo, bytes);
	return exactV(
		v.isSigned && bytes < 4 ? ((raw << (32 - 8 * bytes)) >> (32 - 8 * bytes)) >>> 0 : raw
	);
}

interface TableInfo {
	slots: (string | undefined)[];
}

const TABLES = new WeakMap<binaryen.Module, Map<string, TableInfo | null>>();

// the function in each slot of a table that only its element segments fill, or null when the table can be changed from outside
function tableOf(module: binaryen.Module, name: string): TableInfo | null {
	let cache = TABLES.get(module);
	if (!cache) TABLES.set(module, (cache = new Map()));
	const known = cache.get(name);
	if (known !== undefined) return known;
	let found: TableInfo | null = null;
	try {
		const table = binaryen.getTableInfo(module.getTable(name)) as any;
		let outside = !!table.module;
		for (let i = 0; i < module.getNumExports(); i++) {
			const e = binaryen.getExportInfo(module.getExportByIndex(i));
			if (e.kind === binaryen.ExternalTable && e.value === name) outside = true;
		}
		const slots: (string | undefined)[] = new Array(table.initial).fill(undefined);
		let readable = !outside;
		const count: number = (module as any).getNumElementSegments();
		for (let i = 0; readable && i < count; i++) {
			const seg = binaryen.getElementSegmentInfo(
				(module as any).getElementSegmentByIndex(i)
			) as any;
			if (seg.table !== name) continue;
			const off = seg.offset ? binaryen.getExpressionInfo(seg.offset) : undefined;
			if (!off || off.id !== binaryen.ConstId || off.type !== binaryen.i32) {
				readable = false;
				break;
			}
			const data = seg.data as unknown[];
			for (let k = 0; k < data.length; k++) {
				const at = (off as any).value + k;
				if (at >= slots.length) readable = false;
				else slots[at] = typeof data[k] === 'string' ? (data[k] as string) : undefined;
			}
		}
		if (readable) found = { slots };
	} catch {
		found = null;
	}
	cache.set(name, found);
	return found;
}

// a call through a table with a constant index runs exactly the function the element segment names
function callTable(ctx: Ctx, v: any, args: V[], index: V, S: State): V | undefined {
	if (v.isReturn) return refuse('unsupported', 'a tail call through a table');
	if (index.a || index.r || index.t || index.k || !isExact(index))
		return refuse(
			'isolation',
			`the closure calls through a table with an index that is not a constant in ${ctx.stack[ctx.stack.length - 1]}`
		);
	const table = tableOf(ctx.module, v.table);
	if (!table)
		return refuse(
			'isolation',
			'the table is imported, exported or filled by a segment the checker cannot read'
		);
	const name = table.slots[index.lo];
	if (!name) return refuse('isolation', `table index ${index.lo} is out of range or empty`);
	const target = ctx.module.getFunction(name);
	if (!target) return refuse('unsupported', `table slot ${index.lo} names an unknown function`);
	const sig = binaryen.getFunctionInfo(target);
	if (sig.params !== v.params || sig.results !== v.results)
		return refuse(
			'isolation',
			`the function in table slot ${index.lo} has another signature than the call`
		);
	return callOver(ctx, name, args, S);
}

// #region symbolic extents

// facts about symbols live in the cell map and never go stale, because a symbol names one value:
// y<id> is the interval of the symbol, d<a>|<b> is a bias-shifted upper bound of S_a - S_b, D<id> marks that
// the symbol has a bound with another one
const FACT_BIAS = 2 ** 31;
const yKey = (id: number) => `y${id}`;
const dKey = (a: number, b: number) => `d${a}|${b}`;
const symOk = (x: V) => !x.r && !x.a && !x.k && !x.t && !x.z && x.s === undefined && !x.pair;

function putFact(ctx: Ctx, S: State, key: string, v: V) {
	S.c.set(key, v);
	if (++ctx.factTick % 512 === 0 && S.c.size > 256) pruneFacts(S);
}

// dropping a fact is always sound, so keep the newest symbols
function pruneFacts(S: State) {
	const newest = (key: string) => {
		const body = key.slice(1);
		const bar = body.indexOf('|');
		return bar < 0
			? Number(body)
			: Math.max(Number(body.slice(0, bar)), Number(body.slice(bar + 1)));
	};
	const live: [number, string][] = [];
	for (const key of S.c.keys()) {
		const first = key.charCodeAt(0);
		if (first === 121 || first === 100 || first === 68 || first === 117)
			live.push([newest(key), key]);
	}
	if (live.length <= 128) return;
	live.sort((x, y) => x[0] - y[0]);
	for (const [, key] of live.slice(0, live.length - 128)) S.c.delete(key);
}

// a value that carries a symbol, cut by what the state knows about that symbol and its bounds with others
function tighten(S: State, x: V): V {
	if (x.lw !== undefined) {
		const u = S.c.get(`u${x.lw}`);
		if (u && u.hi < x.hi && x.lo <= u.hi) x = { ...x, hi: u.hi };
	}
	if (!x.sy) return x;
	const { id, c } = x.sy;
	let lo = x.lo;
	let hi = x.hi;
	const y = S.c.get(yKey(id));
	if (y) {
		lo = Math.max(lo, y.lo + c);
		hi = Math.min(hi, y.hi + c);
	}
	if (S.c.has(`D${id}`))
		for (const [key, f] of S.c) {
			if (key.charCodeAt(0) !== 100) continue;
			const bar = key.indexOf('|');
			const a = Number(key.slice(1, bar));
			const b = Number(key.slice(bar + 1));
			const bound = f.hi - FACT_BIAS;
			if (a === id) {
				const yb = S.c.get(yKey(b));
				if (yb) hi = Math.min(hi, yb.hi + bound + c);
			} else if (b === id) {
				const ya = S.c.get(yKey(a));
				if (ya) lo = Math.max(lo, ya.lo - bound + c);
			}
		}
	return (lo === x.lo && hi === x.hi) || lo > hi ? x : { ...x, lo, hi };
}

// a local read: an exact value needs no symbol; any other plain value gets one that the local keeps
function symLocal(ctx: Ctx, S: State, idx: number, x: V): V {
	if (x.sy) {
		const t = tighten(S, x);
		if (t !== x) S.l[idx] = t;
		return t;
	}
	if (x.p) return sentMint(ctx, S, idx, x);
	if (!symOk(x) || isExact(x)) return x;
	const y: V = tighten(S, { ...x, sy: { id: ++ctx.syms, c: 0 } });
	S.l[idx] = y;
	return y;
}

// x + k and x - k for an exact k, when the add cannot wrap, name the same symbol
function attachSym(op: string, a: V, b: V, r: V): V {
	if (op === 'Add') {
		const s =
			a.sy && symOk(a) && isExact(b) && symOk(b)
				? a
				: b.sy && symOk(b) && isExact(a) && symOk(a)
					? b
					: undefined;
		const k = s === a ? b : a;
		if (s && s.hi + k.lo <= M32) return { ...r, sy: { id: s.sy!.id, c: s.sy!.c + k.lo } };
	} else if (op === 'Sub' && a.sy && symOk(a) && isExact(b) && symOk(b) && a.lo >= b.lo)
		return { ...r, sy: { id: a.sy.id, c: a.sy.c - b.lo } };
	return r;
}

// a branch narrowed a value that names a symbol: record the interval of the symbol itself
function noteSym(ctx: Ctx, S: State, x: V) {
	if (!ctx.alloc || !x.sy) return;
	const { id, c } = x.sy;
	const old = S.c.get(yKey(id));
	const lo = Math.max(old ? old.lo : 0, x.lo - c, 0);
	const hi = Math.min(old ? old.hi : M32, x.hi - c);
	if (lo > hi || (old && old.lo === lo && old.hi === hi)) return;
	putFact(ctx, S, yKey(id), mk(lo, hi));
}

// a branch compared two symbolic values: keep the difference bound it proves
function pairFact(ctx: Ctx, S: State, rel: string, a: V, b: V) {
	if (!ctx.alloc || !a.sy || !b.sy || a.sy.id === b.sy.id || !symOk(a) || !symOk(b)) return;
	const set = (x: V, y: V, bound: number) => {
		const key = dKey(x.sy!.id, y.sy!.id);
		const old = S.c.get(key);
		if (
			(old && bound >= old.hi - FACT_BIAS) ||
			bound + FACT_BIAS < 0 ||
			bound + FACT_BIAS > M32
		)
			return;
		putFact(ctx, S, key, exactV(bound + FACT_BIAS));
		S.c.set(`D${x.sy!.id}`, BOOL);
		S.c.set(`D${y.sy!.id}`, BOOL);
	};
	const d = b.sy.c - a.sy.c;
	switch (rel) {
		case 'lt':
			set(a, b, d - 1);
			break;
		case 'le':
			set(a, b, d);
			break;
		case 'gt':
			set(b, a, -d - 1);
			break;
		case 'ge':
			set(b, a, -d);
			break;
		case 'eq':
			set(a, b, d);
			set(b, a, -d);
			break;
	}
}

// the facts the non-null returning paths of a call know and the joined state does not
let nnEpoch = 0;

function nonNullFacts(outs: Pend[], joined: Map<string, V>, ret: V): V {
	const live = outs.filter((o) => o.v?.p && !o.v.z);
	const zero = outs.filter((o) => o.v && isZero(o.v));
	if (!live.length || live.length + zero.length !== outs.length) return ret;
	const facts: [string, V][] = [];
	const cells: [string, V][] = [];
	for (const [key, v] of live[0]!.s.c) {
		const first = key.charCodeAt(0);
		if (first === 119) {
			const all = live.map((o) => o.s.c.get(key));
			if (all.every((w) => w !== undefined)) {
				const lj = all.map((w) => w!).reduce(joinV);
				const j = joined.get(key);
				if (!j || !sameV(j, lj)) cells.push([key, lj]);
			}
			continue;
		}
		if (first !== 121 && first !== 100) continue;
		let lo = v.lo;
		let hi = v.hi;
		let all = true;
		for (const o of live) {
			const w = o.s.c.get(key);
			if (!w) {
				all = false;
				break;
			}
			lo = Math.min(lo, w.lo);
			hi = Math.max(hi, w.hi);
		}
		const j = joined.get(key);
		if (all && (!j || j.lo < lo || j.hi > hi)) facts.push([key, mk(lo, hi)]);
	}
	if (cells.length) {
		const epoch = ++nnEpoch;
		joined.set('Ne', exactV(epoch));
		for (const [key, v] of cells) facts.push([key, { ...v, wt: epoch }]);
	}
	facts.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
	return facts.length ? { ...ret, nn: facts } : ret;
}

// the pointer was tested non-null: its facts now hold
function applyNonNull(ctx: Ctx, S: State, x: V) {
	for (const [key, v] of x.nn ?? []) {
		if (key.charCodeAt(0) === 119) {
			// a static cell the success path wrote: valid only while no static write happened since the return
			const ne = S.c.get('Ne');
			if (ne && ne.lo === ne.hi && ne.lo === v.wt) S.c.set(key, { ...v, wt: undefined });
			continue;
		}
		const old = S.c.get(key);
		const tighter = key.charCodeAt(0) === 100;
		const merged = !old
			? v
			: tighter
				? v.hi < old.hi
					? v
					: old
				: Math.max(old.lo, v.lo) > Math.min(old.hi, v.hi)
					? v
					: mk(Math.max(old.lo, v.lo), Math.min(old.hi, v.hi));
		putFact(ctx, S, key, merged);
		if (tighter) {
			const bar = key.indexOf('|');
			S.c.set(`D${key.slice(1, bar)}`, BOOL);
			S.c.set(`D${key.slice(bar + 1)}`, BOOL);
		}
	}
}

// each arm of a select is cut by the facts the state holds once its side of the condition is assumed
function selectRefined(ctx: Ctx, S: State, cond: number, a: V, b: V): V {
	const arm = (x: V, truth: boolean): V | undefined => {
		const side = cloneState(S);
		return refine(ctx, side, cond, truth) ? tighten(side, x) : undefined;
	};
	return joinV(arm(a, true) ?? a, arm(b, false) ?? b);
}

// #endregion

// #region shim summaries

// sha256 of the printed body of the shim byte loops as clang emits them; the unit test runs both against a reference
const SHIM_BODIES = new Map<string, 'memcpy' | 'memset'>([
	['c58ad6a5d4ccab74a128808b15308084ad6b644dbecbd87a4baa627c90c8648b', 'memcpy'],
	['8df368c5afcb8976ec8e103300a6785b38dd6932296f6c73108ce0109e5fc022', 'memset']
]);

const SHIMS = new WeakMap<binaryen.Module, Map<string, 'memcpy' | 'memset' | null>>();
const printBody = (binaryen as unknown as { emitText(expr: number): string }).emitText;

function shimKind(ctx: Ctx, f: FnInfo): 'memcpy' | 'memset' | undefined {
	let cache = SHIMS.get(ctx.module);
	if (!cache) SHIMS.set(ctx.module, (cache = new Map()));
	let kind = cache.get(f.name);
	if (kind === undefined) {
		const sig = binaryen.getFunctionInfo(ctx.module.getFunction(f.name));
		kind =
			f.params === 3 && sig.results === binaryen.i32
				? (SHIM_BODIES.get(hex(Buffer.from(printBody(f.body)))) ?? null)
				: null;
		cache.set(f.name, kind);
	}
	return kind ?? undefined;
}

const SHIM_CELLS = 256;

// one byte of a source range as the exact loop would load it
function shimByte(ctx: Ctx, S: State, src: V, i: number): V {
	if (src.a || src.k || !src.r) {
		const tag = src.a ? 'p' : src.k ? 'k' : 'w';
		const at = src.a ? src.lo + i : src.k ? src.so! + i : src.lo + i;
		const read = touchCells(ctx, S, tag, false, at, at, at + 1, 1, undefined);
		if (read) return read;
		if (!src.a && !src.k) {
			const fixed = dataLoad(ctx, src, i, { type: binaryen.i32, bytes: 1, isSigned: false });
			if (fixed) return fixed;
		}
	}
	return mk(0, 255);
}

// a call of the shim memset or memcpy has the effect of the fill or copy; exact small calls keep their byte cells
function callShim(
	ctx: Ctx,
	kind: 'memcpy' | 'memset',
	f: FnInfo,
	args: V[],
	S: State
): V | undefined {
	const [dest, second, size] = args as [V, V, V];
	const copy = kind === 'memcpy';
	const plainStatic = (v: V) => !v.r && !v.a;
	if (plainStatic(dest) && dest.hi + size.hi > 2 ** 32) return undefined;
	if (copy && plainStatic(second) && second.hi + size.hi > 2 ** 32) return undefined;
	if (!copy) noStack(second, 'stored as data');
	noStack(size, 'a bulk size');
	if (size.a) refuse('ptr-deref', 'a bulk size derived from the arena base');
	const first = memoryAccesses(f.body)[0]!;
	const F: Frame = { pend: new Map(), rets: [], fn: f.name };
	bulk(ctx, S, F, first, dest, copy ? second : undefined, size, copy ? undefined : second);
	const exactDest =
		(dest.a && !dest.z && isExact(dest)) ||
		(dest.k && dest.so !== undefined) ||
		(plainStatic(dest) && !dest.k && isExact(dest));
	const exactSrc =
		!copy ||
		(second.a && !second.z && isExact(second)) ||
		(second.k && second.so !== undefined) ||
		(plainStatic(second) && !second.k && isExact(second)) ||
		(second.r && !second.k && !second.a);
	if (size.lo > 0 && isExact(size) && size.lo <= SHIM_CELLS && exactDest && exactSrc) {
		const tag = dest.a ? 'p' : dest.k ? 'k' : 'w';
		for (let i = 0; i < size.lo; i++) {
			const at = dest.k ? dest.so! + i : dest.lo + i;
			const read = copy ? shimByte(ctx, S, second, i) : second;
			const value = copy && dest.k ? sentTagByte(S, second, i, read) : read;
			touchCells(ctx, S, tag, true, at, at, at + 1, 1, value);
		}
	} else if (copy && size.lo > 0 && isExact(size) && size.lo <= 8 && dest.k && exactDest)
		sentCopy(S, dest.so!, second, size.lo);
	return dest;
}

// #endregion

// #region fill pieces

// a long bulk write to an exact stack range is one piece instead of a cell per byte; the byte is -1 when its value is not known
const FILL_KEY = 'Fk';
type Piece = [number, number, number];

const piecesOf = (c: Map<string, V>): Piece[] => c.get(FILL_KEY)?.fl ?? [];

function putPieces(c: Map<string, V>, list: Piece[]) {
	const out: Piece[] = [];
	for (const p of list) {
		if (p[0] >= p[1]) continue;
		const last = out[out.length - 1];
		if (last && last[1] === p[0] && last[2] === p[2])
			out[out.length - 1] = [last[0], p[1], p[2]];
		else out.push(p);
	}
	if (out.length) c.set(FILL_KEY, { ...TOP, fl: out });
	else c.delete(FILL_KEY);
}

function samePieces(a: Piece[] | undefined, b: Piece[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1] && p[2] === b[i]![2]);
}

// a write that may touch [lo, end) keeps the bytes written but loses their value
function cutFills(c: Map<string, V>, lo: number, end: number) {
	const list = piecesOf(c);
	if (!list.some((p) => p[0] < end && p[1] > lo)) return;
	const out: Piece[] = [];
	for (const [from, to, b] of list) {
		if (to <= lo || from >= end) {
			out.push([from, to, b]);
			continue;
		}
		out.push([from, Math.max(from, lo), b]);
		out.push([Math.max(from, lo), Math.min(to, end), -1]);
		out.push([Math.min(to, end), to, b]);
	}
	putPieces(c, out);
}

// an exact bulk write replaces whatever the range held
function addFill(c: Map<string, V>, lo: number, end: number, b: number) {
	const out: Piece[] = [];
	for (const [from, to, x] of piecesOf(c)) {
		if (to <= lo || from >= end) out.push([from, to, x]);
		else {
			out.push([from, Math.min(to, lo), x]);
			out.push([Math.max(from, end), to, x]);
		}
	}
	out.push([lo, end, b]);
	out.sort((x, y) => x[0] - y[0]);
	putPieces(c, out);
}

const fillAt = (c: Map<string, V>, pos: number): Piece | undefined =>
	piecesOf(c).find((p) => p[0] <= pos && pos < p[1]);

// every byte of a finite stack range was written by this record on every path to here
function stackWritten(S: State, lo: number, end: number): boolean {
	if (!Number.isFinite(lo) || !Number.isFinite(end) || end - lo > 65536) return false;
	for (let at = lo; at < end; at++)
		if (!S.c.has(cellKey('x', at, 1)) && !fillAt(S.c, at)) return false;
	return true;
}

// the byte a piece holds, or undefined
function fillByte(c: Map<string, V>, pos: number): number | undefined {
	const p = fillAt(c, pos);
	return p && p[2] >= 0 ? p[2] : undefined;
}

// the pieces both paths hold; the byte stays only when both agree
function fillJoin(a: Piece[], b: Piece[]): Piece[] {
	const out: Piece[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const x = a[i]!;
		const y = b[j]!;
		const lo = Math.max(x[0], y[0]);
		const end = Math.min(x[1], y[1]);
		if (lo < end) out.push([lo, end, x[2] === y[2] ? x[2] : -1]);
		if (x[1] <= y[1]) i++;
		else j++;
	}
	return out;
}

// #endregion

// #region stack index

const stackIdxGcd = (a: number, b: number): number => (b === 0 ? a : stackIdxGcd(b, a % b));
const stackIdxMod = (x: number, m: number) => ((x % m) + m) % m;
const stackIdxPow2 = (x: number) => x >= 1 && (x & (x - 1)) === 0;
const STACK_IDX_CELLS = 64;
const STACK_IDX_WRITTEN_MAX = 4096;

// what a plain value is a multiple of: an exact value is its own multiple and 0 is every multiple
const stackIdxMult = (v: V): number | undefined =>
	v.r || v.a || v.k || v.t || v.z || v.s !== undefined || v.pair
		? undefined
		: isExact(v)
			? v.lo
			: v.m;

const stackIdxPlain = (v: V) =>
	!v.r && !v.a && !v.k && !v.t && !v.z && v.s === undefined && !v.pair;

// the offset set of an exact stack pointer or a stack pointer with an interval
function stackIdxOf(v: V): { lo: number; hi: number; st: number; rem: number } | undefined {
	if (!v.k || !v.r || v.a || v.t) return undefined;
	if (v.so !== undefined) return { lo: v.so, hi: v.so, st: 0, rem: v.so };
	return v.sr;
}

// a join keeps what both sides know: a common multiple, or the hull of two stack offset sets
function stackIdxKeep(out: V, a: V, b: V): V {
	if (stackIdxPlain(out)) {
		const x = stackIdxMult(a);
		const y = stackIdxMult(b);
		if (x === undefined || y === undefined) return out;
		const g = stackIdxGcd(x, y);
		return g >= 2 && !isExact(out) ? { ...out, m: g } : out;
	}
	if (!out.k || !out.r || out.a || out.so !== undefined) return out;
	const x = stackIdxOf(a);
	const y = stackIdxOf(b);
	if (!x || !y) return out;
	const st = stackIdxGcd(stackIdxGcd(x.st, y.st), Math.abs(x.rem - y.rem));
	if (st < 1) return out;
	return {
		...out,
		sr: { lo: Math.min(x.lo, y.lo), hi: Math.max(x.hi, y.hi), st, rem: stackIdxMod(x.rem, st) }
	};
}

// after an operation: the multiple a result keeps, and the offsets of a stack pointer plus data
function stackIdxAttach(op: string, a: V, b: V, r: V): V {
	if (stackIdxPlain(r) && !isExact(r)) {
		let m: number | undefined;
		const ex = isExact(b) ? b : isExact(a) ? a : undefined;
		const other = ex === b ? a : b;
		if (op === 'Shl' && ex === b && stackIdxPlain(a)) {
			const s = b.lo & 31;
			const base = a.m ?? 1;
			m = s >= 1 ? (a.hi * 2 ** s <= M32 ? base * 2 ** s : 2 ** s) : undefined;
		} else if (op === 'Mul' && ex && ex.lo >= 2 && stackIdxPlain(other)) {
			const base = other.m ?? 1;
			m = other.hi * ex.lo <= M32 ? base * ex.lo : stackIdxPow2(ex.lo) ? ex.lo : undefined;
		} else if (op === 'And' && ex && stackIdxPlain(other)) {
			const inv = ~ex.lo >>> 0;
			const rounded = ex.lo !== 0 && (inv & (inv + 1)) === 0 ? (ex.lo & -ex.lo) >>> 0 : 1;
			const kept = other.m !== undefined && stackIdxPow2(other.m) ? other.m : 1;
			m = Math.max(rounded, kept);
		} else if (op === 'Add' || op === 'Sub') {
			const x = stackIdxMult(a);
			const y = stackIdxMult(b);
			if (x !== undefined && y !== undefined) {
				const g = stackIdxGcd(x, y);
				const fits = op === 'Add' ? a.hi + b.hi <= M32 : a.lo >= b.hi;
				m = g >= 2 && (fits || stackIdxPow2(g)) ? g : undefined;
			}
		}
		return m !== undefined && m >= 2 ? { ...r, m } : r;
	}
	if ((op !== 'Add' && op !== 'Sub') || !r.k || !r.r || r.a || r.so !== undefined) return r;
	const p = op === 'Add' && !a.k ? b : a;
	const d = p === a ? b : a;
	const base = stackIdxOf(p);
	if (!base || !stackIdxPlain(d)) return r;
	const delta = deltaOf(d);
	if (!delta) return r;
	const lo = op === 'Add' ? base.lo + delta[0] : base.lo - delta[1];
	const hi = op === 'Add' ? base.hi + delta[1] : base.hi - delta[0];
	if (lo < OFF_MIN || hi >= OFF_MAX) return r;
	let st: number;
	let rem: number;
	if (isExact(d)) {
		if (base.st === 0) return r;
		const c = op === 'Add' ? delta[0] : -delta[0];
		st = base.st;
		rem = stackIdxMod(base.rem + c, st);
	} else {
		st = stackIdxGcd(base.st, d.m ?? 1);
		if (st < 1) return r;
		rem = stackIdxMod(base.rem, st);
	}
	return { ...r, sr: { lo, hi, st, rem } };
}

// the join of the cells a stack read at an offset set may name; every cell must be known, and a stored cell was written
function stackIdxRead(
	S: State,
	sr: { lo: number; hi: number; st: number; rem: number },
	offset: number,
	size: number
): V | undefined {
	const lo = sr.lo + offset;
	const hi = sr.hi + offset;
	const first = lo + stackIdxMod(sr.rem + offset - lo, sr.st);
	if (first > hi || Math.floor((hi - first) / sr.st) + 1 > STACK_IDX_CELLS) return undefined;
	let acc: V | undefined;
	for (let o = first; o <= hi; o += sr.st) {
		const cell = readCell(S.c, 'k', o, size);
		if (!cell) return undefined;
		acc = acc ? joinV(acc, cell) : cell;
	}
	return acc;
}

// every byte a read at the offset set may touch was written by this record on every path to here
function stackIdxWritten(
	S: State,
	sr: { lo: number; hi: number; st: number; rem: number },
	offset: number,
	size: number
): boolean {
	const lo = sr.lo + offset;
	const hi = sr.hi + offset;
	const first = lo + stackIdxMod(sr.rem + offset - lo, sr.st);
	if (Math.floor((hi - first) / sr.st) + 1 > STACK_IDX_WRITTEN_MAX) return false;
	for (let o = first; o <= hi; o += sr.st)
		for (let i = 0; i < size; i++)
			if (!S.c.has(cellKey('x', o + i, 1)) && !fillAt(S.c, o + i)) return false;
	return true;
}

// #endregion

// #region byte cells

// the state of one br_table target: the condition local is cut to the indices that reach the target, or undefined when none does
function switchArm(ctx: Ctx, S: State, v: any, c: V, target: string): State | undefined {
	const names: string[] = v.names;
	let lo = Infinity;
	let hi = -Infinity;
	names.forEach((n, i) => {
		if (n !== target) return;
		lo = Math.min(lo, i);
		hi = Math.max(hi, i);
	});
	if (v.defaultName === target && c.hi >= names.length) {
		lo = Math.min(lo, names.length);
		hi = c.hi;
	}
	lo = Math.max(lo, c.lo);
	hi = Math.min(hi, c.hi);
	if (lo > hi) return undefined;
	const A = cloneState(S);
	const at = localOf(v.condition);
	const x = at === undefined ? undefined : A.l[at];
	if (at !== undefined && x && symOk(x) && x.lo === c.lo && x.hi === c.hi) {
		A.l[at] = { ...x, lo: Math.max(x.lo, lo), hi: Math.min(x.hi, hi) };
		noteSym(ctx, A, A.l[at]!);
	}
	const shifted = switchShift(v.condition);
	const y = shifted ? A.l[shifted.local] : undefined;
	if (shifted && y && symOk(y) && y.lo >>> shifted.by === c.lo && y.hi >>> shifted.by === c.hi) {
		const from = lo * 2 ** shifted.by;
		const to = (hi + 1) * 2 ** shifted.by - 1;
		A.l[shifted.local] = { ...y, lo: Math.max(y.lo, from), hi: Math.min(y.hi, to) };
		noteSym(ctx, A, A.l[shifted.local]!);
	}
	return A;
}

// a br_table condition `local >> k` with an exact k
function switchShift(cond: number): { local: number; by: number } | undefined {
	if (binaryen.getExpressionId(cond) !== binaryen.BinaryId) return undefined;
	const e = info(cond);
	if (I32BIN.get(e.op) !== 'ShrU') return undefined;
	const local = localOf(e.left);
	const k = binaryen.getExpressionId(e.right) === binaryen.ConstId ? info(e.right) : undefined;
	if (local === undefined || !k || k.type !== binaryen.i32) return undefined;
	return { local, by: k.value & 31 };
}

const SG_MIN = -(2 ** 31);
const SG_MAX = 2 ** 31 - 1;
const sgPlain = (v: V) => !v.r && !v.a && !v.k && !v.z && !v.pair && v.s === undefined;

// the signed reading of a plain value: what the unsigned interval implies, cut by the signed bound
const sgBase = (v: V): [number, number] =>
	v.hi <= SG_MAX
		? [v.lo, v.hi]
		: v.lo > SG_MAX
			? [v.lo - 2 ** 32, v.hi - 2 ** 32]
			: [SG_MIN, SG_MAX];

function sgOf(v: V): [number, number] {
	const b = sgBase(v);
	if (!v.sg) return b;
	const lo = Math.max(b[0], v.sg[0]);
	const hi = Math.min(b[1], v.sg[1]);
	return lo > hi ? b : [lo, hi];
}

// a signed bound that sits wholly on one side of zero is an unsigned interval; a bound the interval implies is dropped
function sgFold(v: V): V {
	if (!v.sg || !sgPlain(v)) return v;
	const [a, b] = v.sg;
	let lo = v.lo;
	let hi = v.hi;
	if (a >= 0) {
		lo = Math.max(lo, a);
		hi = Math.min(hi, b);
	} else if (b < 0) {
		lo = Math.max(lo, a + 2 ** 32);
		hi = Math.min(hi, b + 2 ** 32);
	}
	if (lo > hi) return v;
	const out = lo === v.lo && hi === v.hi ? v : { ...v, lo, hi };
	const base = sgBase(out);
	if (a <= base[0] && b >= base[1]) {
		const { sg, ...rest } = out;
		return rest;
	}
	return out;
}

// a narrow signed load: the byte or half word reads as a signed value in its own range
function sgExtend(v: V, bytes: number): V {
	const half = 2 ** (8 * bytes - 1);
	const full = 2 ** (8 * bytes);
	if (v.hi >= full || v.s !== undefined) return dataV(v.t);
	if (v.lo >= half) return mk(v.lo - full + 2 ** 32, v.hi - full + 2 ** 32, false, v.t);
	return { ...dataV(v.t), sg: [-half, half - 1] };
}

// a join keeps the hull of the signed readings; a widening keeps them only when they did not grow
function sgKeep(out: V, a: V, b: V, widen: boolean): V {
	if ((!a.sg && !b.sg) || !sgPlain(out) || !sgPlain(a) || !sgPlain(b)) return out;
	const x = sgOf(a);
	const y = sgOf(b);
	const lo = Math.min(x[0], y[0]);
	const hi = Math.max(x[1], y[1]);
	if (widen && (!a.sg || lo < a.sg[0] || hi > a.sg[1])) return out;
	return sgFold({ ...out, sg: [lo, hi] });
}

// the signed reading after not, add, subtract, shift left and arithmetic shift right by a constant
function sgAttach(op: string, a: V, b: V, r: V): V {
	if (!sgPlain(r) || isExact(r)) return r;
	const ex = isExact(b) ? b : isExact(a) ? a : undefined;
	if (!ex || !sgPlain(ex)) return r;
	const x = ex === b ? a : b;
	if (!sgPlain(x)) return r;
	const [xl, xh] = sgOf(x);
	const c = ex.lo | 0;
	let lo: number;
	let hi: number;
	switch (op) {
		case 'Xor':
			if (ex.lo !== M32) return r;
			lo = -xh - 1;
			hi = -xl - 1;
			break;
		case 'Add':
			lo = xl + c;
			hi = xh + c;
			break;
		case 'Sub':
			if (ex === b) {
				lo = xl - c;
				hi = xh - c;
			} else {
				lo = c - xh;
				hi = c - xl;
			}
			break;
		case 'Shl':
			if (ex !== b) return r;
			lo = xl * 2 ** (ex.lo & 31);
			hi = xh * 2 ** (ex.lo & 31);
			break;
		case 'ShrS':
			if (ex !== b) return r;
			lo = xl >> (ex.lo & 31);
			hi = xh >> (ex.lo & 31);
			break;
		default:
			return r;
	}
	if (lo < SG_MIN || hi > SG_MAX) return r;
	return sgFold({ ...r, sg: [lo, hi] });
}

// a signed compare decided by the signed readings
function sgCompare(op: string, a: V, b: V): V | undefined {
	if (!sgPlain(a) || !sgPlain(b)) return undefined;
	const [al, ah] = sgOf(a);
	const [bl, bh] = sgOf(b);
	switch (op) {
		case 'LtS':
			return ah < bl ? exactV(1) : al >= bh ? exactV(0) : undefined;
		case 'LeS':
			return ah <= bl ? exactV(1) : al > bh ? exactV(0) : undefined;
		case 'GtS':
			return al > bh ? exactV(1) : ah <= bl ? exactV(0) : undefined;
		case 'GeS':
			return al >= bh ? exactV(1) : ah < bl ? exactV(0) : undefined;
		default:
			return undefined;
	}
}

// a signed branch narrows the signed reading of the local it compares; false when the branch cannot happen
function sgRefine(
	ctx: Ctx,
	S: State,
	la: number | undefined,
	lb: number | undefined,
	a: V,
	b: V,
	rel: string
) {
	if (!sgPlain(a) || !sgPlain(b)) return undefined;
	let [al, ah] = sgOf(a);
	let [bl, bh] = sgOf(b);
	switch (rel) {
		case 'lt':
			ah = Math.min(ah, bh - 1);
			bl = Math.max(bl, al + 1);
			break;
		case 'le':
			ah = Math.min(ah, bh);
			bl = Math.max(bl, al);
			break;
		case 'gt':
			al = Math.max(al, bl + 1);
			bh = Math.min(bh, ah - 1);
			break;
		case 'ge':
			al = Math.max(al, bl);
			bh = Math.min(bh, ah);
			break;
		default:
			return undefined;
	}
	if (al > ah || bl > bh) return false;
	const put = (at: number | undefined, x: V, lo: number, hi: number) => {
		if (at === undefined || !symOk(x) || S.l[at]!.lo !== x.lo || S.l[at]!.hi !== x.hi) return;
		const n = sgFold({ ...S.l[at]!, sg: [lo, hi] });
		S.l[at] = n;
		noteSym(ctx, S, n);
	};
	put(la, a, al, ah);
	put(lb, b, bl, bh);
	return true;
}

// the multiple an arena offset or a plain addend is known to be of: an exact value is its own multiple
const alignOf = (v: V): number | undefined =>
	v.p
		? isExact(v)
			? Math.abs(v.lo)
			: v.m
		: isExact(v)
			? Math.abs(sdelta(v.lo))
			: v.m && (stackIdxPow2(v.m) || v.hi <= 0x7fffffff)
				? v.m
				: undefined;

// a pointer plus or minus an aligned addend is aligned to what both share
function ptrAlign(res: V, base: V, other: V): V {
	if (!res.p || isExact(res)) return res;
	const x = alignOf(base);
	const y = alignOf(other);
	if (x === undefined || y === undefined) return res;
	const g = stackIdxGcd(x, y);
	return g >= 2 ? { ...res, m: g } : res;
}

function ptrMKeep(out: V, a: V, b: V): V {
	if (!out.p || isExact(out) || !a.p || !b.p) return out;
	const x = alignOf(a);
	const y = alignOf(b);
	if (x === undefined || y === undefined) return out;
	const g = stackIdxGcd(x, y);
	return g >= 2 ? { ...out, m: g } : out;
}

const BYTE_IDX_CELLS = 64;

// the cell addresses an access at an aligned arena offset interval may name, when few enough and not overlapping
function byteIdxSet(addr: V, offset: number, size: number): number[] | undefined {
	const m = addr.m;
	if (!addr.p || !m || m < size || (size !== 1 && size !== 2 && size !== 4)) return undefined;
	const first = Math.ceil(addr.lo / m) * m;
	const count = Math.floor((addr.hi - first) / m) + 1;
	if (count < 1 || count > BYTE_IDX_CELLS) return undefined;
	const out: number[] = [];
	for (let k = 0; k < count; k++) out.push(first + k * m + offset);
	return out;
}

// a read joins the cells it may name; one missing cell leaves the value unknown
function byteIdxRead(S: State, set: number[], size: number): V | undefined {
	let acc: V | undefined;
	for (const q of set) {
		const cell = readCell(S.c, 'p', q, size);
		if (!cell) return undefined;
		acc = acc ? joinV(acc, cell) : cell;
	}
	return acc;
}

// a write kills every cell it may touch, then joins the stored value into the cells it may have replaced
function byteIdxWrite(
	ctx: Ctx,
	S: State,
	set: number[],
	lo: number,
	end: number,
	size: number,
	value: V | undefined
): V | undefined {
	const saved: [string, V][] = [];
	for (const q of set) {
		const key = cellKey('p', q, size);
		const old = S.c.get(key);
		if (old) saved.push([key, old]);
	}
	const out = touchCells(ctx, S, 'p', true, undefined, lo, end, size, value);
	const kept = value ? cellValue(value, size) : undefined;
	if (kept) for (const [key, old] of saved) S.c.set(key, joinV(old, kept));
	return out;
}

// x and 2^k - 1 keeps x when x already fits under the mask
function rangeAttach(op: string, a: V, b: V, r: V): V {
	if (op !== 'And' || !sgPlain(r) || r.t) return r;
	const ex = isExact(b) ? b : isExact(a) ? a : undefined;
	const x = ex === b ? a : b;
	if (!ex || !sgPlain(ex) || !sgPlain(x) || isExact(x) || x.t) return r;
	if ((ex.lo & (ex.lo + 1)) !== 0 || x.hi > ex.lo || x.lo <= r.lo) return r;
	return { ...r, lo: x.lo, hi: x.hi };
}

// a branch on a single bit of a local: a set bit puts the local at or above the bit, a clear bit under a two-bit range puts it below
function bitRefine(ctx: Ctx, S: State, v: any, truth: boolean): boolean {
	const a = ctx.vals.get(v.left);
	const b = ctx.vals.get(v.right);
	if (!a || !b) return true;
	const left = localOf(v.left) !== undefined && isExact(b);
	const right = !left && localOf(v.right) !== undefined && isExact(a);
	if (!left && !right) return true;
	const at = localOf(left ? v.left : v.right)!;
	const x = left ? a : b;
	const m = (left ? b : a).lo;
	const cur = S.l[at]!;
	if (m === 0 || (m & (m - 1)) !== 0 || !symOk(x) || cur.lo !== x.lo || cur.hi !== x.hi)
		return true;
	let lo = cur.lo;
	let hi = cur.hi;
	if (truth) lo = Math.max(lo, m);
	else if (hi < 2 * m) hi = Math.min(hi, m - 1);
	if (lo > hi) return false;
	if (lo !== cur.lo || hi !== cur.hi) {
		S.l[at] = { ...cur, lo, hi };
		noteSym(ctx, S, S.l[at]!);
	}
	return true;
}

// a read of a constant table at an index set: the hull of every entry the index may name, when no store reaches the table
function dataHull(ctx: Ctx, addr: V, offset: number, v: any): V | undefined {
	if (addr.r || addr.a || addr.k || addr.z || addr.s !== undefined || isExact(addr))
		return undefined;
	if (v.type !== binaryen.i32) return undefined;
	const step = addr.m && stackIdxPlain(addr) ? addr.m : 1;
	return dataRange(
		ctx,
		Math.ceil(addr.lo / step) * step + offset,
		addr.hi + offset,
		step,
		v.bytes,
		!!v.isSigned
	);
}

// the shared data-range summary: the hull of the little-endian words of `bytes` bytes at the addresses
// first, first + step, ... up to last, read from the active data segment that holds them all, when no store of
// the closure reaches the range. A struct table read at its stride gets one field's hull: pass step = the stride
// and first = the field's first address. The caller proves that every address the real read may name is in the
// list; V.m gives a multiple, not a remainder, so a table base that is not a multiple of the stride needs a
// caller with its own remainder.
function dataRange(
	ctx: Ctx,
	first: number,
	last: number,
	step: number,
	bytes: number,
	signed: boolean
): V | undefined {
	if (step < 1 || (bytes !== 1 && bytes !== 2 && bytes !== 4)) return undefined;
	if (
		overlapsRanges(ctx.sum.stored, first, last + bytes) ||
		overlapsRanges(ctx.next.stored, first, last + bytes)
	)
		return undefined;
	const seg = segmentsOf(ctx.module).find(
		(s) => first >= s.base && last + bytes <= s.base + s.bytes.length
	);
	if (!seg) return undefined;
	const sum = dataSummary(seg, step, (first - seg.base) % step, bytes, signed);
	const k0 = Math.floor((first - seg.base - sum.phase) / step);
	const k1 = Math.floor((last - seg.base - sum.phase) / step);
	let min = Infinity;
	let max = -Infinity;
	const take = (x: number, y: number) => {
		if (x < min) min = x;
		if (y > max) max = y;
	};
	let k = k0;
	for (; k <= k1 && (k % DATA_BLOCK !== 0 || k + DATA_BLOCK - 1 > k1); k++)
		take(sum.word(k), sum.word(k));
	for (; k + DATA_BLOCK - 1 <= k1; k += DATA_BLOCK)
		take(sum.min[k / DATA_BLOCK]!, sum.max[k / DATA_BLOCK]!);
	for (; k <= k1; k++) take(sum.word(k), sum.word(k));
	return min > max ? undefined : mk(min, max);
}

// the min and max of each block of DATA_BLOCK entries of a table shape (stride, phase, width, sign), built in one pass
// over the segment the first time a read of that shape needs it: a long table costs one pass, not a pass per read
const DATA_BLOCK = 64;
interface DataSummary {
	phase: number;
	word: (k: number) => number;
	min: Uint32Array;
	max: Uint32Array;
}
const DATA_SUMS = new WeakMap<Segment, Map<string, DataSummary>>();

function dataSummary(
	seg: Segment,
	step: number,
	phase: number,
	bytes: number,
	signed: boolean
): DataSummary {
	let shapes = DATA_SUMS.get(seg);
	if (!shapes) DATA_SUMS.set(seg, (shapes = new Map()));
	const key = `${step}|${phase}|${bytes}|${signed}`;
	let sum = shapes.get(key);
	if (sum) return sum;
	const word = (k: number) => {
		const at = phase + k * step;
		let x = 0;
		for (let i = bytes - 1; i >= 0; i--) x = x * 256 + seg.bytes[at + i]!;
		if (signed && bytes < 4) x = ((x << (32 - 8 * bytes)) >> (32 - 8 * bytes)) >>> 0;
		return x;
	};
	const count = Math.max(0, Math.floor((seg.bytes.length - bytes - phase) / step) + 1);
	const blocks = Math.floor(count / DATA_BLOCK);
	const min = new Uint32Array(blocks).fill(0xffffffff);
	const max = new Uint32Array(blocks);
	for (let b = 0; b < blocks; b++)
		for (let k = b * DATA_BLOCK; k < (b + 1) * DATA_BLOCK; k++) {
			const x = word(k);
			if (x < min[b]!) min[b] = x;
			if (x > max[b]!) max[b] = x;
		}
	sum = { phase, word, min, max };
	shapes.set(key, sum);
	return sum;
}

// #endregion

// #region cursor domain

// the multiple of m a plain value carries (stack index region) bounds it from both ends
const curMulOf = (v: V): number | undefined => (v.m && stackIdxPlain(v) ? v.m : undefined);
const curDown = (v: V): number => {
	const m = curMulOf(v);
	return m ? v.hi - (v.hi % m) : v.hi;
};
const curUp = (v: V): number => {
	const m = curMulOf(v);
	return m ? v.lo + ((m - (v.lo % m)) % m) : v.lo;
};

// a common multiple survives widening: the concrete values of both sides are multiples of it
function curKeep(out: V, a: V, b: V): V {
	if (out.m || !stackIdxPlain(out) || isExact(out)) return out;
	const x = stackIdxMult(a);
	const y = stackIdxMult(b);
	if (x === undefined || y === undefined) return out;
	const g = stackIdxGcd(x, y);
	return g >= 2 ? { ...out, m: g } : out;
}

function curRound(v: V): V | undefined {
	const lo = curUp(v);
	const hi = curDown(v);
	if (lo > hi) return undefined;
	return lo === v.lo && hi === v.hi ? v : { ...v, lo, hi };
}

interface CurMarks {
	pend: Map<string, number>;
	rets: number;
}

const curMarks = (F: Frame): CurMarks => ({
	pend: new Map([...F.pend].map(([name, list]) => [name, list.length])),
	rets: F.rets.length
});

// cursor facts live in the cell map under "q<fn>|C|N|a|b": a * L[C] - b * L[N] <= K over the unsigned values, K
// stored with the relation bias. A join keeps a key only when both paths have it, with the larger K
interface CurFact {
	c: number;
	n: number;
	a: number;
	b: number;
	k: number;
	key: string;
}

const curPrefix = (fn: string) => `q${fn}|`;
const curKey = (fn: string, c: number, n: number, a: number, b: number) =>
	`${curPrefix(fn)}${c}|${n}|${a}|${b}`;

function curList(S: State, fn: string): CurFact[] {
	const pre = curPrefix(fn);
	const out: CurFact[] = [];
	for (const [key, v] of S.c) {
		if (key.charCodeAt(0) !== 113 || !key.startsWith(pre)) continue;
		const [c, n, a, b] = key.slice(pre.length).split('|').map(Number) as [
			number,
			number,
			number,
			number
		];
		out.push({ c, n, a, b, k: v.hi - CBIAS, key });
	}
	return out;
}

function curPut(S: State, f: CurFact, k: number) {
	if (k < -CBIAS || k >= CBIAS) S.c.delete(f.key);
	else S.c.set(f.key, mk(k + CBIAS, k + CBIAS));
}

function curClear(c: Map<string, V>, fn: string) {
	const pre = curPrefix(fn);
	for (const key of [...c.keys()])
		if (key.charCodeAt(0) === 113 && key.startsWith(pre)) c.delete(key);
}

// a read of a local, its bounds cut by the facts and the current intervals of the other local
function curTighten(
	S: State,
	fn: string,
	idx: number,
	lo: number,
	hi: number,
	ptr = false
): [number, number] {
	for (const f of curList(S, fn)) {
		if (f.c !== idx) continue;
		const N = S.l[f.n]!;
		if (plain(N)) hi = Math.min(hi, Math.floor((f.b * (f.b < 0 ? N.lo : N.hi) + f.k) / f.a));
		else if (!ptr && f.b > 0 && N.p && !N.z)
			hi = Math.min(hi, Math.floor((f.b * N.hi + f.k) / f.a));
	}
	return [lo, hi];
}

// a pointer cursor read: the facts t * off + s * N <= K (stored with b = -s) cut its offset from above
function curTightenPtr(S: State, fn: string, idx: number, v: V): V {
	const [, hi] = curTighten(S, fn, idx, v.lo, v.hi, true);
	return hi < v.hi && hi >= v.lo ? { ...v, hi } : v;
}

// the facts a state holds cut the locals they name, so a counter at the back edge sits under the bound of its cursor and the
// loop head settles there instead of climbing through the widening thresholds
// a counter that grew since `from` goes straight to its bound, not through the thresholds
function curClose(S: State, fn: string, from?: State) {
	const seen = new Set<number>();
	for (const f of curList(S, fn)) {
		if (seen.has(f.c)) continue;
		seen.add(f.c);
		const X = S.l[f.c]!;
		if (X.p) {
			if (!X.z) S.l[f.c] = curTightenPtr(S, fn, f.c, X);
		} else if (plain(X)) {
			const grew = from && plain(from.l[f.c]!) && X.hi > from.l[f.c]!.hi;
			const [, hi] = curTighten(S, fn, f.c, X.lo, grew ? M32 : X.hi);
			if (hi !== X.hi && hi >= X.lo && (grew ? hi < M32 : hi < X.hi))
				S.l[f.c] = curRound(dropApart({ ...X, hi }) ?? X) ?? X;
		}
	}
}

// a local was just assigned: a self-increment moves K, any other assignment drops the facts that name the local
function curAssign(ctx: Ctx, S: State, F: Frame, y: number, expr: number, old: V) {
	const facts = curList(S, F.fn).filter((f) => f.c === y || f.n === y);
	if (!facts.length) return;
	const now = S.l[y]!;
	const form = formOf(ctx, S, F, expr, y, old);
	const step = old.p && now.p && !old.z && !now.z ? selfStep(expr, y) : undefined;
	const moved =
		plain(old) && plain(now) && isExact(old) && isExact(now)
			? now.lo - old.lo
			: form && form.x === y && form.k === 1
				? form.c
				: step !== undefined && now.lo >= old.lo + step && now.hi <= old.hi + step
					? step
					: undefined;
	for (const f of facts) {
		if (moved === undefined) S.c.delete(f.key);
		else curPut(S, f, f.c === y ? f.k + f.a * moved : f.k - f.b * moved);
	}
}

// the locals the loop body only increments: guesses for cursor and counter, proved or dropped by the fixpoint
function curScan(body: number): Set<number> {
	const inc = new Set<number>();
	const other = new Set<number>();
	const walk = (e: number) => {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.NopId || id === binaryen.UnreachableId) return;
		const x = info(e);
		if (id === binaryen.LocalSetId) {
			const val: number = x.value;
			let bump = false;
			if (binaryen.getExpressionId(val) === binaryen.BinaryId) {
				const b = info(val);
				const isSelf = (n: number) =>
					binaryen.getExpressionId(n) === binaryen.LocalGetId &&
					info(n).index === x.index;
				bump = I32BIN.get(b.op) === 'Add' && (isSelf(b.left) || isSelf(b.right));
			}
			(bump ? inc : other).add(x.index);
		}
		for (const child of operands(x)) walk(child);
	};
	walk(body);
	for (const y of other) inc.delete(y);
	return inc;
}

// the constant c of an assignment `y = y + c`, either operand order
function selfStep(val: number, y: number): number | undefined {
	if (binaryen.getExpressionId(val) !== binaryen.BinaryId) return undefined;
	const b = info(val);
	if (I32BIN.get(b.op) !== 'Add') return undefined;
	const isSelf = (n: number) =>
		binaryen.getExpressionId(n) === binaryen.LocalGetId && info(n).index === y;
	const isConst = (n: number) =>
		binaryen.getExpressionId(n) === binaryen.ConstId && info(n).type === binaryen.i32;
	if (isSelf(b.left) && isConst(b.right)) return info(b.right).value | 0;
	if (isSelf(b.right) && isConst(b.left)) return info(b.left).value | 0;
	return undefined;
}

// the constant each assigned local of the body steps by, undefined when an assignment is not that self-add
function curStepsOf(body: number): Map<number, number | undefined> {
	const out = new Map<number, number | undefined>();
	const walk = (e: number) => {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.NopId || id === binaryen.UnreachableId) return;
		const x = info(e);
		if (id === binaryen.LocalSetId) {
			const step = selfStep(x.value, x.index);
			out.set(x.index, out.has(x.index) && out.get(x.index) !== step ? undefined : step);
		}
		for (const child of operands(x)) walk(child);
	};
	walk(body);
	return out;
}

// candidate facts t * off(C) + s * N <= K for an arena pointer C that steps by +s and a plain counter N that steps by -t;
// one iteration moves both sides by t * s, so the fixpoint keeps K or drops the fact
function curSeedsDown(v: any, F: Frame, entry: State): [string, number][] {
	const steps = curStepsOf(v.body);
	const out: [string, number][] = [];
	for (const [n, down] of steps) {
		const N0 = entry.l[n]!;
		if (down === undefined || down >= 0 || !plain(N0)) continue;
		for (const [c, up] of steps) {
			const C0 = entry.l[c]!;
			if (up === undefined || up < 1 || !C0.p || C0.z) continue;
			const k = -down * C0.hi + up * N0.hi;
			if (k >= -CBIAS && k < CBIAS) out.push([curKey(F.fn, c, n, -down, -up), k]);
		}
	}
	return out;
}

// candidate facts s * X - x * off(P) <= K for a plain counter X that steps by +x and an arena pointer P, or a plain
// cursor P, that steps by +s, stored as a * C - b * N <= K with C = X and N = P; one iteration moves both sides by s * x
function curSeedsPtr(v: any, F: Frame, entry: State): [string, number][] {
	const steps = curStepsOf(v.body);
	const out: [string, number][] = [];
	for (const [x, up] of steps) {
		const X0 = entry.l[x]!;
		if (up === undefined || up < 1 || !plain(X0)) continue;
		for (const [p, s] of steps) {
			const P0 = entry.l[p]!;
			const live = P0.p ? !P0.z : plain(P0) && P0.s === undefined && p !== x;
			if (s === undefined || s < 1 || !live) continue;
			const k = s * X0.hi - up * P0.lo;
			if (k >= -CBIAS && k < CBIAS) out.push([curKey(F.fn, x, p, s, up), k]);
		}
	}
	return out;
}

// candidate facts a * C - b * N <= K from one probe iteration: N steps by one exact amount a, C by at most b
function curSeeds(
	ctx: Ctx,
	v: any,
	F: Frame,
	entry: State,
	probe: () => Pend[]
): [string, number][] {
	if (!ctx.alloc) return [];
	const down = [...curSeedsDown(v, F, entry), ...curSeedsPtr(v, F, entry)];
	const plainAt = (i: number) => (plain(entry.l[i]!) ? entry.l[i]! : undefined);
	const locals = [...curScan(v.body)].filter((i) => plainAt(i));
	if (locals.length < 2) return down;
	const backs = probe();
	if (!backs.length) return down;
	const out: [string, number][] = [...down];
	for (const n of locals) {
		const N0 = entry.l[n]!;
		if (!isExact(N0)) continue;
		const steps = backs.map((b) => b.s.l[n]!);
		if (!steps.every((x) => plain(x) && isExact(x) && x.lo > N0.lo)) continue;
		const a = steps[0]!.lo - N0.lo;
		if (!steps.every((x) => x.lo - N0.lo === a)) continue;
		for (const c of locals) {
			if (c === n) continue;
			const C0 = entry.l[c]!;
			const grew = Math.max(
				1,
				...backs.map((b) => (plain(b.s.l[c]!) ? b.s.l[c]!.hi - C0.hi : Infinity))
			);
			if (!Number.isFinite(grew) || grew > 64) continue;
			for (let b = grew; b <= grew + 3; b++) {
				const k = a * C0.hi - b * N0.lo;
				if (k >= -CBIAS && k < CBIAS) out.push([curKey(F.fn, c, n, a, b), k]);
			}
		}
	}
	return out;
}

// a pass that is thrown away must not leave states at the labels outside the loop
function curRestore(F: Frame, marks: CurMarks) {
	for (const [name, list] of F.pend) {
		const keep = marks.pend.get(name);
		if (keep !== undefined && list.length > keep) list.length = keep;
	}
	F.rets.length = marks.rets;
}

// a loop whose arena accesses the plain fixpoint cannot bound is iterated again with the arena bound deferred,
// the head is narrowed by descending steps that are each checked, and one strict pass from the final head decides
function evalLoop(ctx: Ctx, v: any, S: State, F: Frame, entry?: State[]): V | undefined {
	if (!ctx.alloc || ctx.soft) return evalLoopOld(ctx, v, S, F, entry);
	const marks = curMarks(F);
	const outer = ctx.roundCap;
	try {
		ctx.roundCap = CRAWL_ROUNDS;
		return evalLoopOld(ctx, v, S, F, entry);
	} catch (x) {
		if (x === CRAWL) {
			// the plain fixpoint is still crawling up the threshold ladder: the cursor facts get their turn first
			curRestore(F, marks);
			try {
				return curLoop(ctx, v, S, F, CRAWL_FAILURE);
			} catch (y) {
				if (y !== CRAWL_FAILURE) throw y;
				curRestore(F, marks);
				return evalLoopRetry(ctx, v, S, F, entry, marks);
			}
		}
		return evalLoopRetry(ctx, v, S, F, entry, marks, x);
	} finally {
		ctx.roundCap = outer;
	}
}

// a plain pass that has no round cap, then the cursor retry for an arena access it could not bound
function evalLoopRetry(
	ctx: Ctx,
	v: any,
	S: State,
	F: Frame,
	entry: State[] | undefined,
	marks: CurMarks,
	first?: unknown
): V | undefined {
	try {
		if (first !== undefined) throw first;
		ctx.roundCap = undefined;
		return evalLoopOld(ctx, v, S, F, entry);
	} catch (x) {
		if (
			!(x instanceof Refuse) ||
			x.reason !== 'ptr-deref' ||
			!x.detail.startsWith('an access at arena offsets')
		)
			throw x;
		curRestore(F, marks);
		return curLoop(ctx, v, S, F, x);
	}
}

// rounds of the plain fixpoint in a loop before the cursor retry is tried; the plain pass runs on if the retry fails
const CRAWL_ROUNDS = 24;
const CRAWL = { crawl: true };
const CRAWL_FAILURE = new Refuse('ptr-deref', 'a loop head that crawls');

// the soft passes have no refusal to stop them, so a head that does not settle ends the retry
const CUR_ROUNDS = 100;
const CUR_STEPS = 50000;

function curLoop(ctx: Ctx, v: any, S: State, F: Frame, failure: Refuse): V | undefined {
	const name: string = v.name;
	const prev = name ? F.pend.get(name) : undefined;
	const marks = curMarks(F);
	const entry = cloneState(S);
	let head = cloneState(S);
	let backs: Pend[] = [];
	const pass = (from: State) => {
		F.pend.set(name, []);
		const h = cloneState(from);
		let exit: Pend | undefined;
		try {
			exit = { s: h, v: ev(ctx, v.body, h, F) };
		} catch (x) {
			if (x instanceof Refuse && x.reason === 'budget') throw failure;
			if (x !== END) throw x;
		}
		const backs = F.pend.get(name)!;
		for (const b of backs) curClose(b.s, F.fn);
		if (exit) curClose(exit.s, F.fn);
		return { backs, exit };
	};
	const maxSteps = ctx.maxSteps;
	ctx.maxSteps = Math.min(maxSteps, ctx.steps + CUR_STEPS);
	const inside = (from: State, list: Pend[]) =>
		sameState(joinStates([from, ...list.map((b) => b.s)]), from);
	try {
		const seeds = curSeeds(ctx, v, F, entry, () => {
			ctx.soft++;
			try {
				return pass(entry).backs;
			} catch (x) {
				if (x instanceof Refuse) return [];
				throw x;
			} finally {
				ctx.soft--;
			}
		});
		curRestore(F, marks);
		for (const [key, k] of seeds) {
			entry.c.set(key, mk(k + CBIAS, k + CBIAS));
			head.c.set(key, mk(k + CBIAS, k + CBIAS));
		}
		if (seeds.length) ctx.curs = true;
		ctx.soft++;
		try {
			let rounds = 0;
			for (;;) {
				backs = pass(head).backs;
				if (!backs.length) break;
				rounds++;
				if (rounds > CUR_ROUNDS) throw failure;
				const next = joinStates([head, ...backs.map((b) => b.s)]);
				if (rounds > 2 && !thresholds.length) loadThresholds(ctx);
				const grown = rounds > 2 ? widenState(head, next) : next;
				curClose(grown, F.fn, head);
				if (sameState(grown, head)) break;
				head = grown;
			}
			for (let step = 0; step < 2 && backs.length; step++) {
				const cand = joinStates([entry, ...backs.map((b) => b.s)]);
				if (sameState(cand, head)) break;
				const r = pass(cand);
				if (!inside(cand, r.backs)) break;
				head = cand;
				backs = r.backs;
			}
		} catch (x) {
			// a refusal in a pass that only looks for the head is noise next to the one that started the retry
			throw x instanceof Refuse ? failure : x;
		} finally {
			ctx.soft--;
		}
		curRestore(F, marks);
		const last = pass(head);
		if (!inside(head, last.backs)) throw failure;
		const merged = merge(S, last.exit ? [last.exit] : []);
		return v.type === binaryen.none ? undefined : merged;
	} finally {
		ctx.maxSteps = maxSteps;
		if (prev) F.pend.set(name, prev);
		else F.pend.delete(name);
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

// `local + c` against an exact value narrows the local by exact arithmetic when the add cannot wrap
function refineOffset(
	ctx: Ctx,
	S: State,
	side: number,
	other: V,
	op: string,
	rel: string
): boolean | undefined {
	if (
		binaryen.getExpressionId(side) !== binaryen.BinaryId ||
		!isExact(other) ||
		other.a ||
		other.r
	)
		return undefined;
	const e = info(side);
	const kind = I32BIN.get(e.op);
	if (kind !== 'Add' && kind !== 'Sub') return undefined;
	const isLocal = (n: number) => binaryen.getExpressionId(n) === binaryen.LocalGetId;
	const known = (n: number): number | undefined => {
		const v = ctx.vals.get(n);
		return v && isExact(v) && !v.a && !v.r && !v.k ? v.lo : undefined;
	};
	const left = known(e.left);
	const right = known(e.right);
	const signed = op.endsWith('S');
	const k = signed ? other.lo | 0 : other.lo;
	let at: number;
	let c = 0;
	let neg: number | undefined;
	if (isLocal(e.left) && right !== undefined) {
		at = info(e.left).index;
		c = (kind === 'Add' ? 1 : -1) * (right | 0);
	} else if (kind === 'Add' && isLocal(e.right) && left !== undefined) {
		at = info(e.right).index;
		c = left | 0;
	} else if (kind === 'Sub' && isLocal(e.right) && left !== undefined) {
		at = info(e.right).index;
		neg = left;
	} else return undefined;
	const x = S.l[at]!;
	if (x.r || x.a || x.k || x.s !== undefined) return undefined;
	let t: number;
	if (neg !== undefined) {
		// E - x cannot wrap when E is at least x, and then the relation flips onto x
		if (neg < x.hi || neg > (signed ? 0x7fffffff : M32)) return undefined;
		t = neg - k;
		rel = MIRROR[rel]!;
	} else {
		const [floor, ceil] = signed ? [-(2 ** 31), 2 ** 31 - 1] : [0, M32];
		if ((signed && x.hi > 0x7fffffff) || x.lo + c < floor || x.hi + c > ceil) return undefined;
		t = k - c;
	}
	let lo = x.lo;
	let hi = x.hi;
	switch (rel) {
		case 'lt':
			hi = Math.min(hi, t - 1);
			break;
		case 'le':
			hi = Math.min(hi, t);
			break;
		case 'gt':
			lo = Math.max(lo, t + 1);
			break;
		case 'ge':
			lo = Math.max(lo, t);
			break;
		case 'eq':
			lo = Math.max(lo, t);
			hi = Math.min(hi, t);
			break;
		default:
			return undefined;
	}
	if (lo > hi) return false;
	S.l[at] = { ...x, lo, hi };
	noteSym(ctx, S, S.l[at]!);
	return true;
}

// #region affine bounds

// `x + c` or `E - x` (E exact) against a value that is not exact: the local is cut by the other side's bound; false when the branch is infeasible
function refineAffine(ctx: Ctx, S: State, side: number, other: V, rel: string): boolean {
	if (binaryen.getExpressionId(side) !== binaryen.BinaryId) return true;
	if (isExact(other) || other.a || other.r || other.k || other.s !== undefined) return true;
	const e = info(side);
	const kind = I32BIN.get(e.op);
	if (kind !== 'Add' && kind !== 'Sub') return true;
	const isLocal = (n: number) => binaryen.getExpressionId(n) === binaryen.LocalGetId;
	const known = (n: number): number | undefined => {
		const v = ctx.vals.get(n);
		return v && isExact(v) && !v.a && !v.r && !v.k ? v.lo : undefined;
	};
	const left = known(e.left);
	const right = known(e.right);
	let at: number;
	let c = 0;
	let neg: number | undefined;
	if (isLocal(e.left) && right !== undefined) {
		at = info(e.left).index;
		c = (kind === 'Add' ? 1 : -1) * (right | 0);
	} else if (kind === 'Add' && isLocal(e.right) && left !== undefined) {
		at = info(e.right).index;
		c = left | 0;
	} else if (kind === 'Sub' && isLocal(e.right) && left !== undefined) {
		at = info(e.right).index;
		neg = left;
	} else return true;
	const x = S.l[at]!;
	if (x.r || x.a || x.k || x.s !== undefined) return true;
	let lo = x.lo;
	let hi = x.hi;
	if (neg !== undefined) {
		if (neg < x.hi) return true;
		if (rel === 'lt') lo = Math.max(lo, neg - other.hi + 1);
		else if (rel === 'le') lo = Math.max(lo, neg - other.hi);
		else if (rel === 'gt') hi = Math.min(hi, neg - other.lo - 1);
		else if (rel === 'ge') hi = Math.min(hi, neg - other.lo);
		else if (rel === 'eq') {
			lo = Math.max(lo, neg - other.hi);
			hi = Math.min(hi, neg - other.lo);
		} else return true;
	} else {
		if (x.lo + c < 0 || x.hi + c > M32) return true;
		if (rel === 'lt') hi = Math.min(hi, other.hi - 1 - c);
		else if (rel === 'le') hi = Math.min(hi, other.hi - c);
		else if (rel === 'gt') lo = Math.max(lo, other.lo + 1 - c);
		else if (rel === 'ge') lo = Math.max(lo, other.lo - c);
		else if (rel === 'eq') {
			lo = Math.max(lo, other.lo - c);
			hi = Math.min(hi, other.hi - c);
		} else return true;
	}
	if (lo > hi) return false;
	if (lo !== x.lo || hi !== x.hi) {
		S.l[at] = { ...x, lo, hi };
		noteSym(ctx, S, S.l[at]!);
	}
	return true;
}

// a plain value plus a plain local against a plain bound: the local is cut by the bound minus the other addend, when
// no value in the two intervals makes the sum wrap; false when that side of the branch cannot happen
function refineSum(ctx: Ctx, S: State, side: number, other: V, rel: string): boolean {
	let e = side;
	let outer: number | undefined;
	if (localOf(e) !== undefined) {
		if (binaryen.getExpressionId(e) === binaryen.LocalGetId) return true;
		outer = localOf(e);
		e = info(e).value;
	}
	if (binaryen.getExpressionId(e) !== binaryen.BinaryId || I32BIN.get(info(e).op) !== 'Add')
		return true;
	if (!plain(other) || other.s !== undefined || other.z) return true;
	const b = info(e);
	const strict = rel === 'lt' || rel === 'gt' ? 1 : 0;
	for (const [pe, xe] of [
		[b.left, b.right],
		[b.right, b.left]
	] as [number, number][]) {
		const P = ctx.vals.get(pe);
		const xl = localOf(xe);
		// a tee that stores the sum into the counter itself leaves the old counter in the add and the new one in the local
		if (!P || !plain(P) || P.s !== undefined || xl === undefined || localOf(pe) === xl)
			continue;
		if (xl === outer) continue;
		if (!noSets(pe)) continue;
		const X = S.l[xl]!;
		if (!plain(X) || X.s !== undefined || X.hi + P.hi > M32) continue;
		let lo = X.lo;
		let hi = X.hi;
		if (rel === 'lt' || rel === 'le') hi = Math.min(hi, other.hi - strict - P.lo);
		else if (rel === 'gt' || rel === 'ge') lo = Math.max(lo, other.lo + strict - P.hi);
		else continue;
		if (lo > hi) return false;
		if (lo !== X.lo || hi !== X.hi) {
			S.l[xl] = { ...X, lo, hi };
			noteSym(ctx, S, S.l[xl]!);
		}
		return true;
	}
	return true;
}

// an ordered compare of two plain locals, each with an exact addend, leaves the relation L[big] = L[small] + d for d in a
// range: at least the gap the compare proves, at most the gap of the two intervals
function relBranch(ctx: Ctx, S: State, v: any, rel: string): boolean {
	const l = ordForm(v.left);
	const r = ordForm(v.right);
	if (!ctx.alloc || !l || !r || l.x === r.x) return true;
	if (rel !== 'lt' && rel !== 'le' && rel !== 'gt' && rel !== 'ge') return true;
	const [small, big] = rel === 'lt' || rel === 'le' ? [l, r] : [r, l];
	const X = S.l[small.x]!;
	const Y = S.l[big.x]!;
	if (!plain(X) || !plain(Y) || X.s !== undefined || Y.s !== undefined) return true;
	if (X.lo + small.c < 0 || X.hi + small.c > M32 || Y.lo + big.c < 0 || Y.hi + big.c > M32)
		return true;
	const fn = ctx.stack[ctx.stack.length - 1]!;
	const old = relList(S, fn).find((q) => q.y === big.x && q.x === small.x && q.k === 1);
	const clo = Math.max(
		small.c - big.c + (rel === 'lt' || rel === 'gt' ? 1 : 0),
		old?.clo ?? -Infinity
	);
	const chi = Math.min(Y.hi - X.lo, old?.chi ?? Infinity);
	if (clo > chi) return false;
	relPut(S, fn, { y: big.x, x: small.x, k: 1, clo, chi });
	ctx.rels = true;
	return true;
}

// y - x for two locals a relation of k = 1 binds: the difference stays in the relation's range
function relDiff(ctx: Ctx, S: State, F: Frame, v: any, r: V): V {
	if (!ctx.rels || I32BIN.get(v.op) !== 'Sub') return r;
	if (
		binaryen.getExpressionId(v.left) !== binaryen.LocalGetId ||
		binaryen.getExpressionId(v.right) !== binaryen.LocalGetId
	)
		return r;
	const y = info(v.left).index;
	const x = info(v.right).index;
	const q = relList(S, F.fn).find((c) => c.y === y && c.x === x && c.k === 1);
	if (!q || q.clo < 0 || r.t || r.a || r.k || r.r) return r;
	const lo = Math.max(r.lo, q.clo);
	const hi = Math.min(r.hi, q.chi);
	return lo > hi || (lo === r.lo && hi === r.hi) ? r : { ...r, lo, hi };
}

// #endregion

// an unsigned i64 compare of an i64 symbol with a value below 2^32 bounds the whole symbol, and with it every low word tagged lw
const I64_REL = new Map<number, string>([
	[named.LtUInt64!, 'lt'],
	[named.LeUInt64!, 'le'],
	[named.GtUInt64!, 'gt'],
	[named.GeUInt64!, 'ge']
]);

function i64Bound(ctx: Ctx, e: number, x: V): number | undefined {
	const k = exact64(x);
	if (k !== undefined) return k < 2n ** 32n ? Number(k) : undefined;
	if (binaryen.getExpressionId(e) !== binaryen.UnaryId) return undefined;
	const u = info(e);
	if (u.op !== named.ExtendUInt32) return undefined;
	const inner = ctx.vals.get(u.value);
	return inner && plain(inner) && !inner.z && !inner.t ? inner.hi : undefined;
}

function refineI64(ctx: Ctx, S: State, v: any, truth: boolean): boolean {
	const rel0 = I64_REL.get(v.op);
	const a = ctx.vals.get(v.left);
	const b = ctx.vals.get(v.right);
	if (!rel0 || !a || !b) return true;
	const rel = truth ? rel0 : NEGATE[rel0]!;
	const below = rel === 'lt' || rel === 'le';
	const small = below ? a : b;
	if (!small.sy || small.sy.c !== 0 || !symOk(small)) return true;
	const k = i64Bound(ctx, below ? v.right : v.left, below ? b : a);
	if (k === undefined) return true;
	const hi = rel === 'lt' || rel === 'gt' ? k - 1 : k;
	const old = S.c.get(`u${small.sy.id}`);
	if (hi >= 0 && (!old || hi < old.hi)) putFact(ctx, S, `u${small.sy.id}`, mk(0, hi));
	return true;
}

const noSets = (e: number): boolean =>
	binaryen.getExpressionId(e) !== binaryen.LocalSetId &&
	operands(info(e)).every((child) => noSets(child));

// a side of an unsigned compare of two arena pointers is cut at one end: its local, and the plain offset added to a pointer
function cutPtr(ctx: Ctx, S: State, side: number, end: 'lo' | 'hi', bound: number): boolean {
	const cut = (x: V): V | undefined => {
		const lo = end === 'lo' ? Math.max(x.lo, bound) : x.lo;
		const hi = end === 'hi' ? Math.min(x.hi, bound) : x.hi;
		return lo > hi ? undefined : lo === x.lo && hi === x.hi ? x : { ...x, lo, hi };
	};
	let e = side;
	const l = localOf(e);
	if (l !== undefined) {
		const x = S.l[l]!;
		if (x.p && !x.z) {
			const c = cut(x);
			if (!c) return false;
			S.l[l] = c;
		}
		if (binaryen.getExpressionId(e) === binaryen.LocalGetId) return true;
		e = info(e).value;
	}
	if (binaryen.getExpressionId(e) !== binaryen.BinaryId) return true;
	const b = info(e);
	if (I32BIN.get(b.op) !== 'Add') return true;
	for (const [pe, xe] of [
		[b.left, b.right],
		[b.right, b.left]
	] as [number, number][]) {
		const P = ctx.vals.get(pe);
		const xl = localOf(xe);
		if (!P || !P.p || P.z || xl === undefined || localOf(pe) === xl) continue;
		const X = S.l[xl]!;
		if (!plain(X) || X.hi > 0x7fffffff || X.s !== undefined) continue;
		const lo = end === 'lo' ? Math.max(X.lo, bound - P.hi) : X.lo;
		const hi = end === 'hi' ? Math.min(X.hi, bound - P.lo) : X.hi;
		if (lo > hi) return false;
		if (lo !== X.lo || hi !== X.hi) {
			S.l[xl] = { ...X, lo, hi };
			noteSym(ctx, S, S.l[xl]!);
		}
		return true;
	}
	return true;
}

// two arena pointers compared: each side is cut by the other's offset bounds
function refinePtr(ctx: Ctx, S: State, v: any, rel: string, a: V, b: V): boolean {
	if (a.z || b.z || a.t || b.t) return true;
	const strict = rel === 'lt' || rel === 'gt' ? 1 : 0;
	// the right side runs after the left one, so it must not reassign a local the left cut names
	const leftOk = noSets(v.right);
	if (rel === 'lt' || rel === 'le')
		return (
			(!leftOk || cutPtr(ctx, S, v.left, 'hi', b.hi - strict)) &&
			cutPtr(ctx, S, v.right, 'lo', a.lo + strict)
		);
	if (rel === 'gt' || rel === 'ge')
		return (
			(!leftOk || cutPtr(ctx, S, v.left, 'lo', b.lo + strict)) &&
			cutPtr(ctx, S, v.right, 'hi', a.hi - strict)
		);
	return true;
}

/** Narrows the local a condition compares; false when that side of the branch cannot happen. */
function refineBase(ctx: Ctx, S: State, cond: number, truth: boolean): boolean {
	if (ctx.alloc) sentRefine(ctx, S, cond, truth);
	const id = binaryen.getExpressionId(cond);
	const local = localOf(cond);
	if (local !== undefined) {
		const x = S.l[local]!;
		if (x.a) {
			if (ctx.alloc && x.p && x.z) {
				S.l[local] = truth ? sentNonNull(x) : exactV(0, x.t);
				if (truth) applyNonNull(ctx, S, x);
			}
			return true;
		}
		const n = narrow(x, truth ? 'ne' : 'eq', exactV(0));
		if (!n) return false;
		S.l[local] = n;
		noteSym(ctx, S, n);
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
	// an or is zero only when both sides are
	if (op === 'Or' && !truth)
		return refineBase(ctx, S, v.left, false) && refineBase(ctx, S, v.right, false);
	if (ctx.alloc && op === 'And') return bitRefine(ctx, S, v, truth);
	if (ctx.alloc && !op) return refineI64(ctx, S, v, truth);
	const rel0 = op ? COMPARE_REL[op] : undefined;
	if (!op || !rel0) return true;
	const a = ctx.vals.get(v.left);
	const b = ctx.vals.get(v.right);
	if (!a || !b) return true;
	const viaOffset =
		refineOffset(ctx, S, v.left, b, op, truth ? rel0 : NEGATE[rel0]!) ??
		refineOffset(ctx, S, v.right, a, op, MIRROR[truth ? rel0 : NEGATE[rel0]!]!);
	if (viaOffset !== undefined) return viaOffset;
	if (ctx.alloc && !op.endsWith('S')) {
		const at = truth ? rel0 : NEGATE[rel0]!;
		if (!refineAffine(ctx, S, v.left, b, at) || !refineAffine(ctx, S, v.right, a, MIRROR[at]!))
			return false;
		if (!refineSum(ctx, S, v.right, a, MIRROR[at]!)) return false;
		if (noSets(v.right) && !refineSum(ctx, S, v.left, b, at)) return false;
		if (!relBranch(ctx, S, v, at)) return false;
	}
	if (op.endsWith('S') && (a.hi > 0x7fffffff || b.hi > 0x7fffffff)) {
		if (!ctx.alloc) return true;
		const at = truth ? rel0 : NEGATE[rel0]!;
		return sgRefine(ctx, S, localOf(v.left), localOf(v.right), a, b, at) ?? true;
	}
	const rel = truth ? rel0 : NEGATE[rel0]!;
	if (ctx.alloc && a.p && b.p && !op.endsWith('S') && !refinePtr(ctx, S, v, rel, a, b))
		return false;
	const la = localOf(v.left);
	const lb = localOf(v.right);
	const nullSide = (local: number, x: V, r: string) => {
		if (r === 'eq' || r === 'le') S.l[local] = exactV(0, x.t);
		else if (r === 'ne' || r === 'gt') {
			S.l[local] = sentNonNull(x);
			applyNonNull(ctx, S, x);
		}
	};
	if (ctx.alloc && la !== undefined && a.p && a.z && isZero(b)) {
		nullSide(la, a, rel);
		return true;
	}
	if (ctx.alloc && lb !== undefined && b.p && b.z && isZero(a)) {
		nullSide(lb, b, MIRROR[rel]!);
		return true;
	}
	pairFact(ctx, S, rel, a, b);
	if (la !== undefined && !a.r && !a.a) {
		const n = narrow(S.l[la]!, rel, b);
		if (!n) return false;
		S.l[la] = n;
		noteSym(ctx, S, n);
	}
	if (lb !== undefined && !b.r && !b.a) {
		const n = narrow(S.l[lb]!, MIRROR[rel]!, a);
		if (!n) return false;
		S.l[lb] = n;
		noteSym(ctx, S, n);
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
	const val = joinVals(outs.map((o) => o.v));
	return val?.p && val.z && !val.nn ? nonNullFacts(outs, j.c, val) : val;
}

function ev(ctx: Ctx, e: number, S: State, F: Frame): V | undefined {
	if (++ctx.steps > ctx.maxSteps) refuse('budget', `more than ${ctx.maxSteps} steps`);
	const id = binaryen.getExpressionId(e);
	const v = id === binaryen.NopId || id === binaryen.UnreachableId ? undefined : info(e);
	switch (id) {
		case binaryen.NopId:
			return undefined;
		case binaryen.ConstId: {
			if (ctx.alloc && v.type === binaryen.i64) {
				const bits = BigInt.asUintN(64, BigInt(v.value));
				return {
					...TOP,
					pair: [exactV(Number(bits & 0xffffffffn)), exactV(Number(bits >> 32n))]
				};
			}
			if (v.type !== binaryen.i32) return TOP;
			const c = v.value >>> 0;
			const t = ctx.windows.some((w) => c >= w.low && c <= w.end);
			return exactV(c, t);
		}
		case binaryen.LocalGetId: {
			const x = tightLocal(ctx, S, F, v.index);
			return stampLocal(ctx, ctx.alloc ? symLocal(ctx, S, v.index, x) : x);
		}
		case binaryen.LocalSetId: {
			let val = ev(ctx, v.value, S, F)!;
			// a tee names its value, so a bound the consumer learns reaches the local
			if (ctx.alloc && v.isTee && !val.sy && symOk(val) && !isExact(val))
				val = { ...val, sy: { id: ++ctx.syms, c: 0 } };
			if (ctx.alloc) val = sentSource(ctx, S, v.value, val);
			const old = S.l[v.index]!;
			S.l[v.index] = ctx.prefix ? ownTag(ctx, val) : val;
			relAssign(ctx, S, F, v.index, v.value, old);
			if (ctx.curs) curAssign(ctx, S, F, v.index, v.value, old);
			if (ctx.alloc) srcAssign(ctx, S, F.fn, v.index, val);
			if (ctx.alloc) ordAssign(ctx, S, F.fn, v.index, v.value, old, val);
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
		case binaryen.BlockId:
			return evalBlock(ctx, v, S, F);
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
				const probe = ctx.alloc ? sentSwitch(ctx, S, v) : undefined;
				for (const n of new Set([...names, v.defaultName])) {
					const arm = ctx.alloc ? switchArm(ctx, S, v, c, n) : cloneState(S);
					if (arm && probe && probe.value !== undefined)
						if (
							!(probe.value < names.length
								? names[probe.value] === n
								: v.defaultName === n)
						)
							sentNarrow(arm, probe.at);
					if (arm) push(F, n, arm, val);
				}
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
			if (d !== 'maybe') return d === 'yes' ? a : b;
			const capped = ctx.alloc ? satSub(S, v, b) : undefined;
			if (capped) return capped;
			return ctx.alloc && (a.sy || b.sy)
				? selectRefined(ctx, S, v.condition, a, b)
				: joinV(a, b);
		}
		case binaryen.UnaryId: {
			const a = ev(ctx, v.value, S, F)!;
			// a stack address is never zero, so a null check of one is decided
			if (ctx.alloc && a.k && I32UN.get(v.op) === 'EqZ') return exactV(0);
			noStack(a, 'read as data');
			ctx.vals.set(v.value, a);
			const op = I32UN.get(v.op);
			if (ctx.alloc && !op) {
				const exact = i64Un(v.op, a);
				if (exact) return exact;
				if (v.op === named.WrapInt64 && a.sy && a.sy.c === 0 && symOk(a))
					return { ...TOP, lw: a.sy.id };
			}
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
			if (ctx.alloc && !op) {
				const exact = i64Bin(v.op, a, b);
				if (exact) return exact;
			}
			if (ctx.alloc && (a.a || b.a)) return allocBin(op, a, b, v.type === binaryen.i32);
			if (ctx.alloc && op === 'And' && !a.r && !b.r) {
				const m = maskAnd(a, b) ?? maskAnd(b, a);
				if (m) return stackIdxAttach('And', a, b, sentLb('And', a, b, m));
			}
			if (ctx.alloc && (a.k || b.k) && op && COMPARE_REL[op]) {
				const cmp = stackCompare(op, a, b);
				if (cmp) return cmp;
			}
			if (ctx.alloc && op === 'Or') {
				// sp + c written as an or is an add when the low bits of sp + so are clear; the entry sp is taken 16-byte aligned
				const k = a.k && !b.r ? a : b.k && !a.r ? b : undefined;
				const c = k === a ? b : a;
				if (
					k?.so !== undefined &&
					isExact(c) &&
					c.lo < 16 &&
					((((k.so % 16) + 16) % 16) & c.lo) === 0
				)
					return bin32('Add', a, b, ctx.conv.recordBytes);
			}
			if (op) {
				const apart = ctx.config ? configCompare(ctx, op, a, b) : undefined;
				if (apart) return apart;
				const r = relDiff(ctx, S, F, v, bin32(op, a, b, ctx.conv.recordBytes));
				if (ctx.alloc)
					return sgAttach(
						op,
						a,
						b,
						rangeAttach(
							op,
							a,
							b,
							stackIdxAttach(op, a, b, sentLb(op, a, b, attachSym(op, a, b, r)))
						)
					);
				return ctx.prefix ? carryTag(ctx, op, a, b, r) : r;
			}
			if (v.type === binaryen.i32) return BOOL;
			return dataV(a.t || b.t);
		}
		case binaryen.LoadId: {
			if (v.isAtomic) return refuse('unsupported', 'atomic load');
			const addr = ev(ctx, v.ptr, S, F)!;
			const offset = BigInt.asUintN(32, BigInt(v.offset));
			const read = access(ctx, S, F, e, false, addr, Number(offset), v.bytes);
			// byte cells of one source are exact, so they outrank the summary of tainted stores
			const word =
				ctx.alloc && (!read || (read.a && !read.p && !read.pair))
					? sentCells(S, addr, Number(offset), v)
					: undefined;
			if (word) return word;
			const over = ctx.alloc && read?.sy ? tighten(S, read) : read;
			if (over) {
				if (over.pair && v.bytes === 8) return over;
				if (v.type !== binaryen.i32 && !over.a) return TOP;
				return v.isSigned && v.bytes < 4 ? signExtend(over, v.bytes) : over;
			}
			if (ctx.alloc) {
				const fixed =
					dataLoad(ctx, addr, Number(offset), v) ??
					dataHull(ctx, addr, Number(offset), v);
				if (fixed) return fixed;
			}
			if (ctx.config) {
				const fixed = configLoad(ctx, addr, Number(offset), v);
				if (fixed) return fixed;
			}
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
			if (ctx.alloc && v.isSigned && v.bytes < 4)
				return sgExtend(mk(0, 2 ** (8 * v.bytes) - 1), v.bytes);
			return TOP;
		}
		case binaryen.StoreId: {
			if (v.isAtomic) return refuse('unsupported', 'atomic store');
			const addr = ev(ctx, v.ptr, S, F)!;
			const val = ev(ctx, v.value, S, F)!;
			const offset = BigInt.asUintN(32, BigInt(v.offset));
			if (!stackSlotStore(ctx, val, addr, Number(offset), v.bytes))
				noStack(val, 'stored as data');
			access(ctx, S, F, e, true, addr, Number(offset), v.bytes, val);
			if (v.bytes === 8) wideCells(ctx, S, v.value, addr, Number(offset));
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
			return callOver(ctx, v.target, args, S);
		}
		case binaryen.CallIndirectId: {
			if (!ctx.alloc) return refuse('isolation', 'the closure calls through a table');
			const args = (v.operands as number[]).map((o) => ev(ctx, o, S, F)!);
			const index = ev(ctx, v.target, S, F)!;
			return callTable(ctx, v, args, index, S);
		}
		default:
			return refuse('unsupported', `expression kind ${id}`);
	}
}

function callFn(ctx: Ctx, name: string, args: V[], S: State): V | undefined {
	const f = fnInfo(ctx, name);
	const nested = ctx.stack.filter((n) => n === name).length;
	if (nested >= ctx.recursion)
		refuse(
			'unsupported',
			`recursion through ${name}${ctx.recursion > 1 ? ` deeper than ${ctx.recursion}` : ''}`
		);
	ctx.depth = Math.max(ctx.depth, nested + 1);
	ctx.calls++;
	ctx.visited.add(name);
	if (ctx.alloc) {
		const kind = shimKind(ctx, f);
		const done = kind && callShim(ctx, kind, f, args, S);
		if (done) return done;
	}
	const l: V[] = [];
	for (let i = 0; i < f.types.length; i++) l.push(i < f.params ? (args[i] ?? TOP) : exactV(0));
	const cs: State = { l, g: S.g.slice(), m: S.m, d: S.d, sp: S.sp, c: S.c };
	relClear(cs.c, name);
	const F: Frame = { pend: new Map(), rets: [], fn: name };
	const outs: Pend[] = F.rets;
	ctx.stack.push(name);
	activeStack = ctx.stack;
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
	if (nested) {
		relClear(S.c, name);
		ctx.vals.clear();
	}
	const ret = joinVals(outs.map((o) => o.v));
	return ctx.alloc && ret?.p && ret.z ? nonNullFacts(outs, j.c, ret) : ret;
}

function evalLoopOld(ctx: Ctx, v: any, S: State, F: Frame, entry?: State[]): V | undefined {
	ctx.loops++;
	const name: string = v.name;
	const prev = name ? F.pend.get(name) : undefined;
	let heads: State[] = entry ?? [cloneState(S)];
	const exits: Pend[] = [];
	let rounds = 0;
	let undecided = 0;
	let wide = false;
	let unrolled = 0;
	try {
		for (;;) {
			const forks0 = ctx.forks;
			const backs: Pend[] = [];
			for (const head of heads) {
				F.pend.set(name, []);
				const h = cloneState(head);
				try {
					const val = ev(ctx, v.body, h, F);
					exits.push({ s: h, v: val });
				} catch (x) {
					if (x !== END) throw x;
				}
				backs.push(...F.pend.get(name)!);
			}
			if (!backs.length) break;
			if (
				!wide &&
				heads.length === 1 &&
				backs.length === 1 &&
				(ctx.forks === forks0 || ++undecided <= 8)
			) {
				// no arena refusal ends a soft pass, so a loop that keeps iterating exactly ends the retry
				if (ctx.soft && ++unrolled > CUR_ROUNDS) throw CRAWL_FAILURE;
				heads = [backs[0]!.s];
				continue;
			}
			wide = true;
			rounds++;
			if (ctx.roundCap !== undefined && !ctx.soft && rounds > ctx.roundCap) throw CRAWL;
			if (ctx.soft && rounds > CUR_ROUNDS) throw CRAWL_FAILURE;
			if (rounds > 2 && !thresholds.length) loadThresholds(ctx);
			const next = loopHeads(ctx, heads, backs, rounds > 2, v.body);
			if (next.length === heads.length && next.every((n, i) => sameState(n, heads[i]!)))
				break;
			heads = next;
		}
	} finally {
		if (prev) F.pend.set(name, prev);
		else F.pend.delete(name);
	}
	const merged = merge(S, exits);
	return v.type === binaryen.none ? undefined : merged;
}

// #region null worlds

const WORLDS_MAX = 4;

// which pointer cells of the arena are exactly null and which are a pure pointer; a state with another value in a cell leaves it out
function worldKey(s: State): string {
	const parts: string[] = [];
	for (const [key, x] of s.c) {
		if (key.charCodeAt(0) !== 112 || !key.endsWith('/4')) continue;
		if (x.a && x.p && !x.z) parts.push(`${key}p`);
		else if (isZero(x)) parts.push(`${key}0`);
	}
	return parts.sort().join(',');
}

// the locals that a br_table of the loop body reads directly, outside the loops nested in it: the state of a state machine
function dispatchLocals(ctx: Ctx, body: number): number[] {
	let found = ctx.dispatch.get(body);
	if (found) return found;
	const set = new Set<number>();
	const walk = (e: number) => {
		const id = binaryen.getExpressionId(e);
		if (id === binaryen.LoopId || id === binaryen.NopId || id === binaryen.UnreachableId)
			return;
		const v = info(e);
		if (
			id === binaryen.SwitchId &&
			binaryen.getExpressionId(v.condition) === binaryen.LocalGetId
		)
			set.add(info(v.condition).index);
		for (const child of operands(v)) walk(child);
	};
	walk(body);
	found = [...set].sort((a, b) => a - b);
	ctx.dispatch.set(body, found);
	return found;
}

// the exact value of each dispatch local, or that it is not exact: a state that sets it from data lands in the world of its own
function dispatchKey(s: State, locals: number[]): string {
	let out = '';
	for (const x of locals) {
		const v = s.l[x]!;
		const exact = isExact(v) && !v.a && !v.r && !v.t && !v.k && v.s === undefined;
		out += exact ? `|${x}=${v.lo}` : `|${x}?`;
	}
	return out;
}

// the loop heads of the next round: the old heads and the back edges, joined within each null world; the
// worlds stay apart so that a pointer cell that is null in one and allocated in the other is never maybe-null
function loopHeads(ctx: Ctx, heads: State[], backs: Pend[], widen: boolean, body: number): State[] {
	const all = [...heads, ...backs.map((b) => b.s)];
	let keys = ctx.alloc ? all.map(worldKey) : all.map(() => '');
	const locals = ctx.alloc ? dispatchLocals(ctx, body) : [];
	if (locals.length) {
		const split = all.map((s, i) => keys[i]! + dispatchKey(s, locals));
		if (new Set(split).size <= WORLDS_MAX) keys = split;
	}
	const count = new Set(keys).size;
	const apart = ctx.alloc && count > 1 && count <= WORLDS_MAX;
	const groups = new Map<string, State[]>();
	const old = new Map<string, State[]>();
	all.forEach((s, i) => {
		const k = apart ? keys[i]! : '';
		const into = groups.get(k);
		if (into) into.push(s);
		else groups.set(k, [s]);
		if (i < heads.length) old.set(k, [...(old.get(k) ?? []), s]);
	});
	const out: State[] = [];
	for (const [k, list] of groups) {
		const next = joinStates(list);
		const before = old.get(k);
		out.push(widen && before ? widenState(joinStates(before), next) : next);
	}
	return out;
}

// a block that merges states with different values of a dispatch local and is followed by the loop that dispatches
// on it: the loop starts from one head per value, not from the join
function splitLoop(ctx: Ctx, kids: number[], i: number): number {
	const block = kids[i]!;
	let found = ctx.splits.get(block);
	if (found !== undefined) return found;
	const next = kids[i + 1];
	found = 0;
	if (
		next !== undefined &&
		binaryen.getExpressionId(block) === binaryen.BlockId &&
		info(block).type === binaryen.none &&
		binaryen.getExpressionId(next) === binaryen.LoopId &&
		dispatchLocals(ctx, info(next).body).length
	)
		found = next;
	ctx.splits.set(block, found);
	return found;
}

function evalSplit(ctx: Ctx, block: number, loop: number, S: State, F: Frame): V | undefined {
	const outs: Pend[] = [];
	evalBlock(ctx, info(block), S, F, outs);
	const v = info(loop);
	const locals = dispatchLocals(ctx, v.body);
	const byKey = new Map<string, State[]>();
	for (const o of outs) {
		const k = dispatchKey(o.s, locals);
		const into = byKey.get(k);
		if (into) into.push(o.s);
		else byKey.set(k, [o.s]);
	}
	const entry =
		byKey.size > 1 && byKey.size <= WORLDS_MAX
			? [...byKey.values()].map((list) => cloneState(joinStates(list)))
			: undefined;
	merge(S, outs);
	return evalLoop(ctx, v, S, F, entry);
}

function evalBlock(ctx: Ctx, v: any, S: State, F: Frame, keep?: Pend[]): V | undefined {
	const name: string = v.name;
	const prev = name ? F.pend.get(name) : undefined;
	if (name) F.pend.set(name, []);
	let val: V | undefined;
	let fell = true;
	try {
		const kids = v.children as number[];
		for (let i = 0; i < kids.length; i++) {
			const loop = ctx.alloc ? splitLoop(ctx, kids, i) : 0;
			if (loop) val = evalSplit(ctx, kids[i++]!, loop, S, F);
			else val = ev(ctx, kids[i]!, S, F);
		}
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
	if (keep) {
		if (!outs.length) throw END;
		keep.push(...outs);
		return undefined;
	}
	const merged = merge(S, outs);
	return v.type === binaryen.none ? undefined : merged;
}

// #endregion

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

// #region prefix domain

interface PrefixCtx {
	cell: number;
	base: number;
	/** the discovery run: loads are tagged and stores that use a tag name a candidate, nothing is tracked */
	disc: boolean;
	found: Map<number, { base: number; n: number }>;
	epoch: number;
	stores: number;
	splits: number;
}

const SPLIT_MAX = 64;
const CV = '@cv';
const XT = '@ext';

const newPrefix = (cell: number, base: number, disc = false): PrefixCtx => ({
	cell,
	base,
	disc,
	found: new Map(),
	epoch: 0,
	stores: 0,
	splits: 0
});

const cvOf = (S: State) => S.c.get(CV);
const extOf = (S: State) => S.c.get(XT)?.lo ?? 0;

function untag(x: V): V {
	if (x.ld === undefined) return x;
	const y = { ...x };
	delete y.ld;
	delete y.lk;
	delete y.le;
	return y;
}

// the length of the written run that starts at the buffer base
function prefixEnd(m: Ranges, base: number): number {
	for (const [lo, end] of m) if (lo <= base && end > base) return end - base;
	return 0;
}

// the bytes a read may count as written: the must set plus the buffer below the cursor
function coverOf(ctx: Ctx, S: State): Ranges {
	const P = ctx.prefix;
	const cv = P && !P.disc ? cvOf(S) : undefined;
	return cv ? rsAdd(S.m, P!.base, P!.base + cv.lo + extOf(S)) : S.m;
}

const trusted = (P: PrefixCtx, x: V) =>
	x.ld !== undefined && x.le === P.epoch && (P.disc || x.ld === P.cell);

function carryTag(ctx: Ctx, op: string, a: V, b: V, r: V): V {
	const P = ctx.prefix!;
	let src: V | undefined;
	let d = 0;
	if (op === 'Add') {
		if (trusted(P, a) && isExact(b)) {
			src = a;
			d = sdelta(b.lo);
		} else if (trusted(P, b) && isExact(a)) {
			src = b;
			d = sdelta(a.lo);
		}
	} else if (op === 'Sub' && trusted(P, a) && isExact(b)) {
		src = a;
		d = -sdelta(b.lo);
	}
	if (!src || r.lo !== src.lo + d || r.hi !== src.hi + d || r.lo < 0 || r.hi > M32) return r;
	return { ...r, ld: src.ld, lk: src.lk! + d, le: P.epoch };
}

// a local keeps its tag only while it is trusted when assigned, and is stamped again on each read
const ownTag = (ctx: Ctx, x: V): V =>
	x.ld !== undefined && !trusted(ctx.prefix!, x) ? untag(x) : x;
const stampLocal = (ctx: Ctx, x: V): V =>
	ctx.prefix && x.ld !== undefined ? { ...x, le: ctx.prefix.epoch } : x;

// a tagged local equals the cursor cell plus lk, so its interval and the cell's narrow together
function syncCur(ctx: Ctx, S: State): boolean {
	const P = ctx.prefix;
	const cv = P && !P.disc ? cvOf(S) : undefined;
	if (!P || !cv) return true;
	let lo = cv.lo;
	let hi = cv.hi;
	for (const x of S.l)
		if (x.ld === P.cell && x.s === undefined) {
			lo = Math.max(lo, x.lo - x.lk!);
			hi = Math.min(hi, x.hi - x.lk!);
		}
	if (lo > hi) return false;
	if (lo !== cv.lo || hi !== cv.hi) S.c.set(CV, mk(lo, hi));
	for (let i = 0; i < S.l.length; i++) {
		const x = S.l[i]!;
		if (x.ld !== P.cell || x.s !== undefined) continue;
		const nlo = Math.max(x.lo, lo + x.lk!);
		const nhi = Math.min(x.hi, hi + x.lk!);
		if (nlo !== x.lo || nhi !== x.hi) S.l[i] = { ...x, lo: nlo, hi: nhi };
	}
	return true;
}

function refine(ctx: Ctx, S: State, cond: number, truth: boolean): boolean {
	return refineBase(ctx, S, cond, truth) && (!ctx.prefix || syncCur(ctx, S));
}

// a store of w to the cursor cell: the buffer below w must already be written
function cursorStore(ctx: Ctx, S: State, w: V) {
	const P = ctx.prefix!;
	const known = !!cvOf(S);
	const tagged = known && w.ld === P.cell && w.le === P.epoch;
	const covered = prefixEnd(S.m, P.base);
	const plain = !w.r && !w.a && !w.k && !w.t;
	let ext = -1;
	if (plain && w.hi === 0) ext = covered;
	if (tagged && w.lk! <= extOf(S)) ext = Math.max(ext, extOf(S) - w.lk!);
	if (plain && w.hi <= covered) ext = Math.max(ext, covered - w.hi);
	// the first pass has no windows, so the must set is empty there; the second pass decides
	if (ext < 0 && !ctx.windows.length) ext = 0;
	if (ext < 0)
		refuse(
			'prefix-cover',
			`the cursor at ${P.cell} is stored a value the written prefix of the buffer at ${P.base} does not cover`,
			P.cell
		);
	const shift = tagged ? w.lk! : undefined;
	P.epoch++;
	P.stores++;
	for (let i = 0; i < S.l.length; i++) {
		const x = S.l[i]!;
		if (x.ld === P.cell) S.l[i] = shift === undefined ? untag(x) : { ...x, lk: x.lk! - shift };
		else if (
			plain &&
			isExact(w) &&
			isExact(x) &&
			x.lo === w.lo &&
			x.ld === undefined &&
			!x.r &&
			!x.a &&
			!x.k
		)
			S.l[i] = { ...x, ld: P.cell, lk: 0 };
	}
	S.c.set(CV, mk(w.lo, w.hi));
	S.c.set(XT, exactV(ext));
	S.c.set(cellKey('w', P.cell), mk(w.lo, w.hi));
}

// the prefix part of one load or store; returns the value of a load of the cursor cell
function prefixAccess(
	ctx: Ctx,
	S: State,
	write: boolean,
	addr: V,
	offset: number,
	size: number,
	value: V | undefined,
	over: V | undefined
): V | undefined {
	const P = ctx.prefix!;
	if (addr.r) return undefined;
	const lo = addr.lo + offset;
	const end = addr.hi + offset + size;
	if (P.disc) {
		if (!write) {
			if (size !== 4 || !isExact(addr) || addr.a) return undefined;
			return { ...(over ?? mk(0, 0xffff)), ld: lo, lk: 0, le: 0 };
		}
		if (addr.ld !== undefined) {
			const b = addr.lk! + offset;
			const f = P.found.get(addr.ld);
			P.found.set(addr.ld, f ? { base: Math.min(f.base, b), n: f.n + 1 } : { base: b, n: 1 });
		}
		return undefined;
	}
	const onCell = isExact(addr) && lo === P.cell && size === 4;
	if (!write) {
		const cv = onCell ? cvOf(S) : undefined;
		return cv ? { ...cv, ld: P.cell, lk: 0, le: P.epoch } : undefined;
	}
	if (lo < P.cell + 4 && end > P.cell && !onCell)
		return refuse('prefix-store', `a write may change the cursor cell at ${P.cell}`, lo);
	if (onCell) {
		cursorStore(ctx, S, value!);
		return undefined;
	}
	if (addr.ld === P.cell && addr.le === P.epoch && cvOf(S)) {
		const d = addr.lk! + offset - P.base;
		const e = extOf(S);
		if (d <= e) S.c.set(XT, exactV(Math.max(e, d + size)));
	}
	return undefined;
}

function prefixBulk(ctx: Ctx, dest: V, size: V) {
	const P = ctx.prefix!;
	if (P.disc || dest.r) return;
	if (dest.lo < P.cell + 4 && dest.hi + size.hi > P.cell)
		refuse('prefix-store', `a bulk write may change the cursor cell at ${P.cell}`, dest.lo);
}

function pickCursor(P: PrefixCtx): { cell: number; base: number } | undefined {
	let best: { cell: number; base: number; n: number } | undefined;
	for (const [cell, f] of P.found)
		if (f.base >= 0 && (!best || f.n > best.n)) best = { cell, base: f.base, n: f.n };
	return best ? { cell: best.cell, base: best.base } : undefined;
}

const PREFIX_RULES = [
	'the cursor cell changes only by an exact 4-byte store (prefix-store)',
	'a cursor store of w needs the buffer below w written: w is 0, the cursor plus a constant within the proved extension, or covered by the must-written set (prefix-cover)',
	'a store at the cursor plus a constant extends the proved prefix only when it starts at or below the prefix end',
	'a read below the lower bound of the cursor plus the extension counts as written',
	'a call runs once per exact cursor value when the cursor has at most 64 values'
];

// a call runs once per exact cursor value when the cursor is a small interval; the cases join at the return
function callOver(ctx: Ctx, name: string, args: V[], S: State): V | undefined {
	const P = ctx.prefix;
	if (!P || P.disc) return callFn(ctx, name, args, S);
	const clear = (T: State) => {
		for (let i = 0; i < T.l.length; i++) if (T.l[i]!.ld === P.cell) T.l[i] = untag(T.l[i]!);
	};
	const fresh = args.map((a) => (a.ld !== undefined && !trusted(P, a) ? untag(a) : a));
	const cv = cvOf(S);
	if (!cv || cv.hi === cv.lo || cv.hi - cv.lo >= SPLIT_MAX) {
		const e0 = P.epoch;
		const val = callFn(ctx, name, fresh, S);
		if (P.epoch !== e0) clear(S);
		return val;
	}
	P.splits++;
	const ext = extOf(S);
	const outs: Pend[] = [];
	for (let x = cv.lo; x <= cv.hi; x++) {
		const Sc = cloneState(S);
		Sc.c.set(CV, exactV(x));
		Sc.m = rsAdd(Sc.m, P.base, P.base + x + ext);
		const exact = (v: V): V => {
			const n = x + v.lk!;
			return n < 0 || n > M32 ? untag(v) : { ...v, lo: n, hi: n };
		};
		for (let i = 0; i < Sc.l.length; i++)
			if (Sc.l[i]!.ld === P.cell && Sc.l[i]!.s === undefined) Sc.l[i] = exact(Sc.l[i]!);
		const a2 = fresh.map((a) => (a.ld === P.cell && a.s === undefined ? exact(a) : a));
		const e0 = P.epoch;
		try {
			const val = callFn(ctx, name, a2, Sc);
			if (P.epoch !== e0) clear(Sc);
			outs.push({ s: Sc, v: val });
		} catch (error) {
			if (error !== END) throw error;
		}
	}
	return merge(S, outs);
}

// #endregion

// #region sentinel domain

// a pointer tagged sb = {k, c, eh} is at most E_k + c, where E_k is the address of a zero padding made by a fill
// and E_k is at most eh; the cell Z holds the one live padding: the interval of E_k, k as sy.id and the width w as
// sy.c, and it is dead once a join of two paddings drops the symbol
const SENT_MAX_WIDTH = 64;

function sentCap(v: V): V {
	if (!v.sb) return v;
	const hi = Math.min(v.hi, v.sb.eh + v.sb.c);
	return hi === v.hi ? v : hi < v.lo ? { ...v, sb: undefined } : { ...v, hi };
}

// a tag survives a join of two pointers that carry the same one, at the larger offset; widening drops a growing one
function sentKeep(out: V, a: V, b: V, widen: boolean): V {
	// a pointer joined with the exact value 0 keeps its names: they are read only after a non-null test restores it
	const carrier = a.p && isZero(b) ? a : b.p && isZero(a) ? b : undefined;
	if (carrier && out.p && out.z) {
		if (carrier.pid) out.pid = carrier.pid;
		if (carrier.lb) out.lb = carrier.lb;
	}
	if (a.pid && b.pid && a.pid.id === b.pid.id && a.pid.c === b.pid.c && out.p && !out.z)
		out.pid = a.pid;
	if (
		a.bsrc &&
		b.bsrc &&
		a.bsrc.id === b.bsrc.id &&
		a.bsrc.d === b.bsrc.d &&
		a.bsrc.k === b.bsrc.k &&
		a.bsrc.n === b.bsrc.n &&
		!out.a
	)
		out.bsrc = a.bsrc;
	if (
		a.lb &&
		b.lb &&
		a.lb.id === b.lb.id &&
		a.p === b.p &&
		(a.p ? out.p && !out.z : !out.a) &&
		(!widen || a.lb.c === b.lb.c)
	)
		out.lb = { id: a.lb.id, c: Math.min(a.lb.c, b.lb.c) };
	if (!a.sb || !b.sb || a.sb.k !== b.sb.k || !out.p || out.z) return out;
	if (widen && b.sb.c > a.sb.c) return out;
	return sentCap({ ...out, sb: { k: a.sb.k, c: Math.max(a.sb.c, b.sb.c), eh: a.sb.eh } });
}

// base plus a delta of at most `up` is at most E_k + c + up
function sentShift(res: V, base: V, up: number): V {
	return base.sb && res.p && !res.z
		? sentCap({ ...res, sb: { k: base.sb.k, c: base.sb.c + up, eh: base.sb.eh } })
		: res;
}

// the pointer after a non-null test keeps the names it had
function sentNonNull(x: V): V {
	const y = ptrV(x.lo, x.hi, x.t);
	if (x.pid) y.pid = x.pid;
	if (x.lb) y.lb = x.lb;
	return y;
}

// a byte copied from a named tagged pointer remembers where it came from unless its value is exact
function sentTagByte(S: State, src: V, i: number, val: V): V {
	const z = S.c.get('Z');
	if (isExact(val) || val.a || !src.p || src.z || !src.pid || !src.sb) return val;
	if (!z?.sy || z.sy.id !== src.sb.k) return val;
	return { ...val, bsrc: { id: src.pid.id, d: src.pid.c + i, k: z.sy.id } };
}

// a short copy of arena bytes to the stack keeps, per byte, where it came from while the padding is live
function sentCopy(S: State, at: number, src: V, n: number) {
	const z = S.c.get('Z');
	if (!src.p || src.z || !src.pid || !src.sb || !z?.sy || z.sy.id !== src.sb.k) return;
	for (let i = 0; i < n; i++)
		S.c.set(cellKey('k', at + i, 1), {
			...mk(0, 255),
			bsrc: { id: src.pid.id, d: src.pid.c + i, k: z.sy.id }
		});
}

// a 2 or 4 byte stack load of consecutive source bytes is a word with a source
function sentCells(S: State, addr: V, offset: number, v: any): V | undefined {
	const n = v.bytes as number;
	if (!addr.k || addr.so === undefined || (n !== 2 && n !== 4) || v.type !== binaryen.i32)
		return undefined;
	const at = addr.so + offset;
	const first = S.c.get(cellKey('k', at, 1))?.bsrc;
	if (!first || first.n !== undefined) return undefined;
	for (let i = 1; i < n; i++) {
		const b = S.c.get(cellKey('k', at + i, 1))?.bsrc;
		if (!b || b.n !== undefined || b.id !== first.id || b.k !== first.k || b.d !== first.d + i)
			return undefined;
	}
	return { ...mk(0, n === 2 ? 65535 : M32), bsrc: { ...first, n } };
}

// a pointer made from a symbolic one by an exact delta is the same symbol at a shifted offset
function sentPid(res: V, base: V, delta: V, sign: 1 | -1): V {
	if (!res.p || res.z) return res;
	const d = isExact(delta) ? deltaOf(delta) : undefined;
	if (d) {
		const k = sign * d[0];
		let out = res;
		if (base.pid) out = { ...out, pid: { id: base.pid.id, c: base.pid.c + k } };
		if (base.lb) out = { ...out, lb: { id: base.lb.id, c: base.lb.c + k } };
		return out;
	}
	// an exact pointer plus a plain value that is a symbol plus a constant
	if (sign !== 1 || !isExact(base) || !delta.sy || delta.hi > 0x7fffffff) return res;
	const out = { ...res, pid: { id: delta.sy.id, c: delta.sy.c + base.lo } };
	if (delta.lb) out.lb = { id: delta.lb.id, c: delta.lb.c + base.lo };
	return out;
}

// the lower bound of a masked or shifted value: x & -2^k is at least x - (2^k - 1)
function sentLb(op: string | undefined, a: V, b: V, r: V): V {
	if (r.a || r.r || r.k || r.p) return r;
	if (op === 'And') {
		const m = isExact(b) ? b : isExact(a) ? a : undefined;
		if (!m) return r;
		const x = m === b ? a : b;
		const inv = ~m.lo >>> 0;
		if ((inv & (inv + 1)) !== 0 || x.a || x.r || x.k) return r;
		const src = x.sy ?? x.lb;
		return src ? { ...r, lb: { id: src.id, c: src.c - inv } } : r;
	}
	if (op === 'Add' || op === 'Sub') {
		const k = isExact(b) ? b : op === 'Add' && isExact(a) ? a : undefined;
		const x = k === b ? a : b;
		if (!k || !x.lb || x.a || x.r || x.k) return r;
		const up = op === 'Add';
		return (up ? x.hi + k.lo <= M32 : x.lo >= k.lo)
			? { ...r, lb: { id: x.lb.id, c: x.lb.c + (up ? k.lo : -k.lo) } }
			: r;
	}
	return r;
}

// a tagged pointer read from a local names its value, so a test of a byte read through it reaches every copy
function sentMint(ctx: Ctx, S: State, idx: number, x: V): V {
	if (!x.sb || !x.p || x.z || x.pid) return x;
	const y: V = { ...x, pid: { id: -++ctx.syms, c: 0 } };
	S.l[idx] = y;
	return y;
}

// a byte loaded through a named tagged pointer while the padding is live remembers where it came from
function sentSource(ctx: Ctx, S: State, expr: number, val: V): V {
	const at = sentAddress(expr);
	const x = at && sentMint(ctx, S, at.local, S.l[at.local]!);
	const z = S.c.get('Z');
	if (!at || !x?.pid || !x.sb || !z?.sy || x.sb.k !== z.sy.id || val.a || val.r || val.k)
		return val;
	return { ...val, bsrc: { id: x.pid.id, d: x.pid.c + at.d, k: z.sy.id } };
}

// a fill of w zero bytes at E starts a zero padding; the pointers known to be at most E get the tag
function sentMake(ctx: Ctx, S: State, dest: V, w: number) {
	const k = ++ctx.syms;
	const sb = { k, c: 0, eh: dest.hi };
	const zero: V = { ...mk(dest.lo, dest.hi), sy: { id: k, c: w } };
	if (dest.pid) zero.bsrc = { id: dest.pid.id, d: dest.pid.c, k };
	S.c.set('Z', zero);
	for (let i = 0; i < S.l.length; i++) {
		const v = S.l[i]!;
		if (v.p && !v.z && (v === dest || v.hi <= dest.lo)) S.l[i] = sentCap({ ...v, sb });
	}
}

// a write that may reach a zero padding ends it, unless it lies wholly below or above it
function sentWrite(S: State, addr: V, offset: number, size: number) {
	const z = S.c.get('Z');
	if (!z) return;
	if (!z.sy) {
		S.c.delete('Z');
		return;
	}
	const below =
		(addr.sb?.k === z.sy.id && addr.sb.c + offset + size <= 0) ||
		addr.hi + offset + size <= z.lo;
	const above =
		addr.lo + offset >= z.hi + z.sy.c ||
		(!!z.bsrc &&
			addr.lb?.id === z.bsrc.id &&
			z.bsrc.k === z.sy.id &&
			addr.lb.c + offset >= z.bsrc.d + z.sy.c);
	if (!below && !above) S.c.delete('Z');
}

// the local and displacement of a byte load whose address is a local, a tee or a local plus a constant
function sentAddress(e: number, width = 1): { local: number; d: number } | undefined {
	if (binaryen.getExpressionId(e) !== binaryen.LoadId) return undefined;
	const v = info(e);
	if (v.bytes !== width || v.isAtomic) return undefined;
	const ptr = v.ptr as number;
	const id = binaryen.getExpressionId(ptr);
	const off = Number(BigInt.asUintN(32, BigInt(v.offset)));
	if (id === binaryen.LocalGetId) return { local: info(ptr).index, d: off };
	if (id === binaryen.LocalSetId && info(ptr).isTee) return { local: info(ptr).index, d: off };
	if (id !== binaryen.BinaryId || I32BIN.get(info(ptr).op) !== 'Add') return undefined;
	const sum = info(ptr);
	const side = (x: number, y: number) =>
		binaryen.getExpressionId(x) === binaryen.LocalGetId &&
		binaryen.getExpressionId(y) === binaryen.ConstId &&
		info(y).type === binaryen.i32
			? { local: info(x).index, d: off + (info(y).value | 0) }
			: undefined;
	return side(sum.left, sum.right) ?? side(sum.right, sum.left);
}

type SentValue = number | bigint;

interface SentEval {
	S: State;
	env: Map<number, SentValue>;
	found: { id: number; d: number; k: number; local?: number }[];
}

const I64BIN = new Map<number, string>();
for (const op of [
	'Add',
	'Sub',
	'Mul',
	'And',
	'Or',
	'Xor',
	'Shl',
	'ShrU',
	'Eq',
	'Ne',
	'LtU',
	'LeU',
	'GtU',
	'GeU'
])
	I64BIN.set(named[`${op}Int64`]!, op);

const asU64 = (x: bigint) => BigInt.asUintN(64, x);

function sentEval64(op: string | undefined, x: bigint, y: bigint): SentValue | undefined {
	switch (op) {
		case 'Add':
			return asU64(x + y);
		case 'Sub':
			return asU64(x - y);
		case 'Mul':
			return asU64(x * y);
		case 'And':
			return x & y;
		case 'Or':
			return x | y;
		case 'Xor':
			return x ^ y;
		case 'Shl':
			return asU64(x << (y & 63n));
		case 'ShrU':
			return x >> (y & 63n);
		case 'Eq':
			return x === y ? 1 : 0;
		case 'Ne':
			return x !== y ? 1 : 0;
		case 'LtU':
			return x < y ? 1 : 0;
		case 'LeU':
			return x <= y ? 1 : 0;
		case 'GtU':
			return x > y ? 1 : 0;
		case 'GeU':
			return x >= y ? 1 : 0;
		default:
			return undefined;
	}
}

// the value of a condition built from constants, teed locals and one tagged byte load, with that byte set to 0
function sentEval(ctx: Ctx, st: SentEval, e: number): SentValue | undefined {
	const id = binaryen.getExpressionId(e);
	const v = info(e);
	switch (id) {
		case binaryen.ConstId:
			return v.type === binaryen.i32
				? v.value >>> 0
				: v.type === binaryen.i64
					? asU64(BigInt(v.value))
					: undefined;
		case binaryen.LocalGetId: {
			if (st.env.has(v.index)) return st.env.get(v.index);
			const src = st.S.l[v.index]?.bsrc;
			if (!src) return undefined;
			st.found.push(src);
			return 0;
		}
		case binaryen.LocalSetId: {
			if (!v.isTee) return undefined;
			const x = sentEval(ctx, st, v.value);
			if (x !== undefined) st.env.set(v.index, x);
			return x;
		}
		case binaryen.SelectId: {
			const a = sentEval(ctx, st, v.ifTrue);
			const b = sentEval(ctx, st, v.ifFalse);
			const c = sentEval(ctx, st, v.condition);
			return a === undefined || b === undefined || typeof c !== 'number'
				? undefined
				: c
					? a
					: b;
		}
		case binaryen.UnaryId: {
			const x = sentEval(ctx, st, v.value);
			if (x === undefined) return undefined;
			if (typeof x === 'bigint')
				return v.op === named.EqZInt64
					? x === 0n
						? 1
						: 0
					: v.op === named.WrapInt64
						? Number(x & 0xffffffffn)
						: undefined;
			if (v.op === named.ExtendUInt32) return BigInt(x);
			return I32UN.get(v.op) === 'EqZ' ? (x === 0 ? 1 : 0) : undefined;
		}
		case binaryen.BinaryId: {
			const x = sentEval(ctx, st, v.left);
			const y = sentEval(ctx, st, v.right);
			if (x === undefined || y === undefined) return undefined;
			if (typeof x === 'bigint' || typeof y === 'bigint')
				return typeof x === 'bigint' && typeof y === 'bigint'
					? sentEval64(I64BIN.get(v.op), x, y)
					: undefined;
			switch (I32BIN.get(v.op)) {
				case 'Add':
					return (x + y) >>> 0;
				case 'Sub':
					return (x - y) >>> 0;
				case 'Mul':
					return Math.imul(x, y) >>> 0;
				case 'And':
					return (x & y) >>> 0;
				case 'Or':
					return (x | y) >>> 0;
				case 'Xor':
					return (x ^ y) >>> 0;
				case 'Shl':
					return (x << (y & 31)) >>> 0;
				case 'ShrU':
					return x >>> (y & 31);
				case 'ShrS':
					return (x >> (y & 31)) >>> 0;
				case 'Eq':
					return x === y ? 1 : 0;
				case 'Ne':
					return x !== y ? 1 : 0;
				case 'LtU':
					return x < y ? 1 : 0;
				case 'LeU':
					return x <= y ? 1 : 0;
				case 'GtU':
					return x > y ? 1 : 0;
				case 'GeU':
					return x >= y ? 1 : 0;
				case 'LtS':
					return (x | 0) < (y | 0) ? 1 : 0;
				case 'LeS':
					return (x | 0) <= (y | 0) ? 1 : 0;
				case 'GtS':
					return (x | 0) > (y | 0) ? 1 : 0;
				case 'GeS':
					return (x | 0) >= (y | 0) ? 1 : 0;
				default:
					return undefined;
			}
		}
		case binaryen.LoadId: {
			if (v.bytes !== 1 || v.isAtomic) return undefined;
			const at = sentAddress(e);
			const x = at && sentMint(ctx, st.S, at.local, st.S.l[at.local]!);
			const z = st.S.c.get('Z');
			if (at && x?.pid && x.sb && z?.sy?.id === x.sb.k) {
				st.found.push({ id: x.pid.id, d: x.pid.c + at.d, k: x.sb.k, local: at.local });
				return 0;
			}
			// a constant table read at the index the byte gives
			const index = sentEval(ctx, st, v.ptr);
			if (typeof index !== 'number') return undefined;
			const lo = (index + Number(BigInt.asUintN(32, BigInt(v.offset)))) >>> 0;
			if (
				overlapsRanges(ctx.sum.stored, lo, lo + 1) ||
				overlapsRanges(ctx.next.stored, lo, lo + 1)
			)
				return undefined;
			const seg = segmentsOf(ctx.module).find(
				(s) => lo >= s.base && lo < s.base + s.bytes.length
			);
			if (!seg) return undefined;
			const raw = seg.bytes[lo - seg.base]!;
			return v.isSigned ? ((raw << 24) >> 24) >>> 0 : raw;
		}
		default:
			return undefined;
	}
}

// a 2 or 4 byte load equal to a constant: every byte is the constant's byte, so the highest nonzero one is not in the padding
function sentWord(ctx: Ctx, S: State, cond: number, truth: boolean) {
	if (binaryen.getExpressionId(cond) !== binaryen.BinaryId) return undefined;
	const v = info(cond);
	const op = I32BIN.get(v.op);
	if (!((op === 'Eq' && truth) || (op === 'Ne' && !truth))) return undefined;
	const isConst = (e: number) =>
		binaryen.getExpressionId(e) === binaryen.ConstId && info(e).type === binaryen.i32;
	// a word that came from consecutive source bytes against a value the state knows exactly
	const lv = ctx.vals.get(v.left);
	const rv = ctx.vals.get(v.right);
	for (const [w, x] of [
		[lv, rv],
		[rv, lv]
	]) {
		const z = S.c.get('Z');
		if (!w?.bsrc?.n || !x || !isExact(x) || x.a || x.r || x.k || !z?.sy || z.sy.id !== w.bsrc.k)
			continue;
		let top = -1;
		for (let i = 0; i < w.bsrc.n; i++) if ((x.lo >>> (8 * i)) & 255) top = i;
		if (top >= 0) return { id: w.bsrc.id, d: w.bsrc.d + top, k: w.bsrc.k };
	}
	const [load, k] = isConst(v.right)
		? [v.left, v.right]
		: isConst(v.left)
			? [v.right, v.left]
			: [];
	if (load === undefined || k === undefined) return undefined;
	// an and with a constant mask keeps only the masked bits of each byte
	let operand = load;
	let mask = M32;
	if (binaryen.getExpressionId(operand) === binaryen.BinaryId) {
		const m = info(operand);
		if (I32BIN.get(m.op) !== 'And') return undefined;
		const [y, c] = isConst(m.right)
			? [m.left, m.right]
			: isConst(m.left)
				? [m.right, m.left]
				: [];
		if (y === undefined || c === undefined) return undefined;
		operand = y;
		mask = info(c).value >>> 0;
	}
	let base: { id: number; d: number; k: number; local?: number } | undefined;
	let width = 0;
	const z = S.c.get('Z');
	const id = binaryen.getExpressionId(operand);
	if (id === binaryen.LoadId) {
		const l = info(operand);
		width = l.bytes as number;
		const at = width === 2 || width === 4 ? sentAddress(operand, width) : undefined;
		if (!at || l.type !== binaryen.i32) return undefined;
		const x = sentMint(ctx, S, at.local, S.l[at.local]!);
		if (!x.pid || !x.sb || !z?.sy || z.sy.id !== x.sb.k) return undefined;
		base = { id: x.pid.id, d: x.pid.c + at.d, k: x.sb.k, local: at.local };
	} else if (id === binaryen.LocalGetId) {
		const src = sentLocal(ctx, S, info(operand).index);
		if (!src?.n || !z?.sy || z.sy.id !== src.k) return undefined;
		width = src.n;
		base = { id: src.id, d: src.d, k: src.k };
	}
	if (!base) return undefined;
	const word = info(k).value >>> 0;
	let top = -1;
	for (let i = 0; i < width; i++) {
		const want = (word >>> (8 * i)) & 255;
		const kept = (mask >>> (8 * i)) & 255;
		if (want && (want & ~kept) === 0) top = i;
	}
	return top < 0 ? undefined : { ...base, d: base.d + top };
}

// the byte load of a condition that is zero only on the other side of the branch, when the condition depends on nothing else
function sentByte(ctx: Ctx, S: State, cond: number, truth: boolean) {
	const word = sentWord(ctx, S, cond, truth);
	if (word) return word;
	const st: SentEval = { S, env: new Map(), found: [] };
	const value = sentEval(ctx, st, cond);
	if (typeof value !== 'number' || st.found.length !== 1) return undefined;
	const at = st.found[0]!;
	if ((at.local !== undefined && st.env.has(at.local)) || (value !== 0) === truth)
		return undefined;
	return at;
}

// known bits of a 32 bit value: the bits that are one in every case and the bits that are one in some case
interface Bits {
	one: number;
	may: number;
}

const exactBits = (x: number): Bits => ({ one: x >>> 0, may: x >>> 0 });
const BOOL_BITS: Bits = { one: 0, may: 1 };
const isExactBits = (b: Bits) => b.one === b.may;

interface SentBits {
	S: State;
	env: Map<number, Bits>;
	cands: { id: number; d: number; k: number; local?: number }[];
	/** the candidate read as the zero byte; every other candidate is any byte */
	zero: number;
}

// the bits of a condition when candidate `zero` is the byte 0 and the other candidate bytes are anything
function sentBits(ctx: Ctx, st: SentBits, e: number): Bits | undefined {
	const id = binaryen.getExpressionId(e);
	const v = info(e);
	const byteOf = (c: { id: number; d: number; k: number; local?: number }): Bits => {
		const n = st.cands.length;
		st.cands.push(c);
		return n === st.zero ? exactBits(0) : { one: 0, may: 255 };
	};
	switch (id) {
		case binaryen.ConstId:
			return v.type === binaryen.i32 ? exactBits(v.value) : undefined;
		case binaryen.LocalGetId: {
			const known = st.env.get(v.index);
			if (known) return known;
			const src = st.S.l[v.index]?.bsrc;
			return src && !src.n ? byteOf(src) : undefined;
		}
		case binaryen.LocalSetId: {
			if (!v.isTee) return undefined;
			const x = sentBits(ctx, st, v.value);
			if (x) st.env.set(v.index, x);
			return x;
		}
		case binaryen.SelectId: {
			const a = sentBits(ctx, st, v.ifTrue);
			const b = sentBits(ctx, st, v.ifFalse);
			const c = sentBits(ctx, st, v.condition);
			if (!a || !b || !c) return undefined;
			if (isExactBits(c)) return c.one ? a : b;
			return { one: a.one & b.one, may: a.may | b.may };
		}
		case binaryen.UnaryId: {
			const x = sentBits(ctx, st, v.value);
			if (!x || I32UN.get(v.op) !== 'EqZ') return undefined;
			return x.one ? exactBits(0) : x.may === 0 ? exactBits(1) : BOOL_BITS;
		}
		case binaryen.BinaryId: {
			const a = sentBits(ctx, st, v.left);
			const b = sentBits(ctx, st, v.right);
			const op = I32BIN.get(v.op);
			if (!a || !b || !op) return undefined;
			const both = isExactBits(a) && isExactBits(b);
			switch (op) {
				case 'And':
					return { one: (a.one & b.one) >>> 0, may: (a.may & b.may) >>> 0 };
				case 'Or':
					return { one: (a.one | b.one) >>> 0, may: (a.may | b.may) >>> 0 };
				case 'Xor':
					return {
						one: ((a.one & ~b.may) | (b.one & ~a.may)) >>> 0,
						may: ((a.may & ~b.one) | (b.may & ~a.one)) >>> 0
					};
				case 'Shl':
					return isExactBits(b)
						? { one: (a.one << (b.one & 31)) >>> 0, may: (a.may << (b.one & 31)) >>> 0 }
						: undefined;
				case 'ShrU':
					return isExactBits(b)
						? { one: a.one >>> (b.one & 31), may: a.may >>> (b.one & 31) }
						: undefined;
				case 'Add':
					return both ? exactBits(a.one + b.one) : undefined;
				case 'Sub':
					return both ? exactBits(a.one - b.one) : undefined;
				case 'Eq':
				case 'Ne': {
					const differs = ((a.one & ~b.may) | (b.one & ~a.may)) !== 0;
					const same = both && a.one === b.one;
					if (differs || same) return exactBits((op === 'Eq') === same ? 1 : 0);
					return BOOL_BITS;
				}
				default:
					return both ? undefined : BOOL_BITS;
			}
		}
		case binaryen.LoadId: {
			if (v.bytes !== 1 || v.isAtomic) return undefined;
			const at = sentAddress(e);
			const x = at && sentMint(ctx, st.S, at.local, st.S.l[at.local]!);
			const z = st.S.c.get('Z');
			if (at && x?.pid && x.sb && z?.sy?.id === x.sb.k)
				return byteOf({ id: x.pid.id, d: x.pid.c + at.d, k: x.sb.k, local: at.local });
			// a constant table read at every index the byte may have
			const index = sentBits(ctx, st, v.ptr);
			if (!index || index.may + Number(BigInt.asUintN(32, BigInt(v.offset))) > M32)
				return undefined;
			const off = Number(BigInt.asUintN(32, BigInt(v.offset)));
			let one = M32;
			let may = 0;
			let seen = 0;
			for (let i = 0; i <= Math.min(index.may, 255); i++) {
				if ((i & index.one) >>> 0 !== index.one || (i & ~index.may) !== 0) continue;
				const lo = i + off;
				if (
					overlapsRanges(ctx.sum.stored, lo, lo + 1) ||
					overlapsRanges(ctx.next.stored, lo, lo + 1)
				)
					return undefined;
				const seg = segmentsOf(ctx.module).find(
					(s) => lo >= s.base && lo < s.base + s.bytes.length
				);
				if (!seg) return undefined;
				const raw = seg.bytes[lo - seg.base]!;
				const byte = v.isSigned ? ((raw << 24) >> 24) >>> 0 : raw;
				one &= byte;
				may |= byte;
				seen++;
			}
			return index.may <= 255 && seen ? { one: one >>> 0, may: may >>> 0 } : undefined;
		}
		default:
			return undefined;
	}
}

// every byte candidate of a condition that the branch side proves nonzero, each tried with the others unknown
function sentBytes(ctx: Ctx, S: State, cond: number, truth: boolean) {
	const found: { id: number; d: number; k: number; local?: number }[] = [];
	const first = sentByte(ctx, S, cond, truth);
	if (first) found.push(first);
	const probe: SentBits = { S, env: new Map(), cands: [], zero: -1 };
	if (!sentBits(ctx, probe, cond) || probe.cands.length < 2) return found;
	const total = probe.cands.length;
	for (let n = 0; n < total; n++) {
		const st: SentBits = { S, env: new Map(), cands: [], zero: n };
		const bits = sentBits(ctx, st, cond);
		const at = st.cands[n];
		if (!bits || !at || st.cands.length !== total) continue;
		if (at.local !== undefined && st.env.has(at.local)) continue;
		if (truth ? bits.may === 0 : bits.one !== 0) found.push(at);
	}
	return found;
}

// a switch on a function of one tagged byte: an arm that the value for the byte 0 does not select knows the byte is not zero
function sentSwitch(ctx: Ctx, S: State, v: any) {
	const st: SentEval = { S, env: new Map(), found: [] };
	const value = sentEval(ctx, st, v.condition);
	if (typeof value !== 'number' || st.found.length !== 1) return undefined;
	const at = st.found[0]!;
	if (at.local !== undefined && st.env.has(at.local)) return undefined;
	return { value, at };
}

// a branch that proves the byte read at offset symbol + d is not zero: every pointer named by that symbol is below the padding
function sentRefine(ctx: Ctx, S: State, cond: number, truth: boolean) {
	for (const at of sentBytes(ctx, S, cond, truth)) sentNarrow(S, at);
}

function sentNarrow(S: State, at: { id: number; d: number; k: number }) {
	const z = S.c.get('Z');
	if (!z?.sy || z.sy.id !== at.k) return;
	const named = (x: V) => x.pid?.id === at.id && x.sb?.k === at.k && x.p && !x.z;
	let reach = Infinity;
	for (const x of S.l) if (named(x)) reach = Math.min(reach, x.sb!.c - x.pid!.c + at.d);
	if (reach > z.sy.c - 1) return;
	for (let i = 0; i < S.l.length; i++) {
		const x = S.l[i]!;
		if (named(x))
			S.l[i] = sentCap({
				...x,
				sb: { ...x.sb!, c: Math.min(x.sb!.c, -1 + x.pid!.c - at.d) }
			});
	}
}

// #endregion

// #region word sources

// the cell W<fn>|<w>|<L> says the word in local w was read from the address in local L plus d while the padding k
// was live (bsrc holds L as id and d as the offset from L); it names the current value of L, so any assignment of w or
// L and the start of the function again end it
const srcPrefix = (fn: string) => `W${fn}|`;
const srcKey = (fn: string, w: number, l: number) => `${srcPrefix(fn)}${w}|${l}`;

function srcClear(c: Map<string, V>, fn: string) {
	const pre = srcPrefix(fn);
	for (const key of [...c.keys()]) if (key[0] === 'W' && key.startsWith(pre)) c.delete(key);
}

function srcDrop(S: State, fn: string, idx: number) {
	const pre = srcPrefix(fn);
	for (const key of [...S.c.keys()]) {
		if (key[0] !== 'W' || !key.startsWith(pre)) continue;
		const [w, l] = key.slice(pre.length).split('|').map(Number);
		if (w === idx || l === idx) S.c.delete(key);
	}
}

// local idx was just assigned: its old relations end, and a word and a pointer that name the same source are related
function srcAssign(ctx: Ctx, S: State, fn: string, idx: number, val: V) {
	if (ctx.srcs) srcDrop(S, fn, idx);
	const z = S.c.get('Z');
	if (!z?.sy) return;
	const put = (w: number, l: number, d: number, src: NonNullable<V['bsrc']>) => {
		S.c.set(srcKey(fn, w, l), { ...mk(0, 0), bsrc: { id: l, d, k: src.k, n: src.n } });
		ctx.srcs = true;
	};
	const src = val.bsrc;
	if (src?.n && src.k === z.sy.id)
		for (let l = 0; l < S.l.length; l++) {
			const x = S.l[l]!;
			if (l !== idx && x.p && !x.z && x.pid?.id === src.id) put(idx, l, src.d - x.pid.c, src);
		}
	if (val.p && !val.z && val.pid)
		for (let w = 0; w < S.l.length; w++) {
			const s = S.l[w]!.bsrc;
			if (w !== idx && s?.n && s.k === z.sy.id && s.id === val.pid.id)
				put(w, idx, s.d - val.pid.c, s);
		}
}

// the source of the word in local w: its own, or the one its relation to a pointer local gives once that pointer is named
function sentLocal(ctx: Ctx, S: State, w: number): V['bsrc'] {
	const own = S.l[w]?.bsrc;
	if (own || !ctx.srcs) return own;
	const fn = ctx.stack[ctx.stack.length - 1]!;
	const z = S.c.get('Z');
	for (let l = 0; l < S.l.length; l++) {
		const cell = S.c.get(srcKey(fn, w, l))?.bsrc;
		const x = S.l[l]!;
		if (!cell || !z?.sy || z.sy.id !== cell.k || !x.p || x.z || x.sb?.k !== cell.k) continue;
		const y = sentMint(ctx, S, l, x);
		if (y.pid) return { id: y.pid.id, d: y.pid.c + cell.d, k: cell.k, n: cell.n };
	}
	return undefined;
}

// #endregion

// #region pointer order

// the cell P<fn>|y|x holds the interval of offset(y) - offset(x), biased by CBIAS, for two locals that hold non-null
// arena pointers, as the destination trails the source in an in-place copy; an assignment of either local shifts or
// drops it, and the start of the function again clears it
const ordPrefix = (fn: string) => `P${fn}|`;
const ordKey = (fn: string, y: number, x: number) => `${ordPrefix(fn)}${y}|${x}`;
const ordLive = (v: V | undefined) => !!v && v.p && !v.z;

interface Ord {
	y: number;
	x: number;
	lo: number;
	hi: number;
}

function ordClear(c: Map<string, V>, fn: string) {
	const pre = ordPrefix(fn);
	for (const key of [...c.keys()]) if (key[0] === 'P' && key.startsWith(pre)) c.delete(key);
}

function ordList(S: State, fn: string): Ord[] {
	const pre = ordPrefix(fn);
	const out: Ord[] = [];
	for (const [key, v] of S.c) {
		if (key[0] !== 'P' || !key.startsWith(pre)) continue;
		const [y, x] = key.slice(pre.length).split('|').map(Number) as [number, number];
		out.push({ y, x, lo: v.lo - CBIAS, hi: v.hi - CBIAS });
	}
	return out;
}

// a bound at the edge of the biased range means no bound, so a step never moves it
const ORD_NONE = CBIAS - 1;
const ordStep = (bound: number, c: number) =>
	bound <= -ORD_NONE || bound >= ORD_NONE ? bound : bound + c;

function ordPut(S: State, fn: string, y: number, x: number, lo: number, hi: number) {
	S.c.set(ordKey(fn, y, x), mk(Math.max(lo, -ORD_NONE) + CBIAS, Math.min(hi, ORD_NONE) + CBIAS));
}

// a loop that moves a bound at every round gets no bound at once, not one step of the threshold ladder per round
function ordWiden(old: V, now: V): V {
	const j = joinV(old, now);
	return mk(j.lo < old.lo ? 1 : old.lo, j.hi > old.hi ? 2 * CBIAS - 1 : old.hi);
}

// a local, or a local plus or minus an exact constant
function ordForm(expr: number): { x: number; c: number } | undefined {
	const id = binaryen.getExpressionId(expr);
	if (id === binaryen.LocalGetId) return { x: info(expr).index, c: 0 };
	if (id !== binaryen.BinaryId) return undefined;
	const e = info(expr);
	const op = I32BIN.get(e.op);
	if (op !== 'Add' && op !== 'Sub') return undefined;
	const konst = (n: number) =>
		binaryen.getExpressionId(n) === binaryen.ConstId && info(n).type === binaryen.i32;
	const local = (n: number) => binaryen.getExpressionId(n) === binaryen.LocalGetId;
	if (local(e.left) && konst(e.right))
		return { x: info(e.left).index, c: (op === 'Add' ? 1 : -1) * (info(e.right).value | 0) };
	if (op === 'Add' && konst(e.left) && local(e.right))
		return { x: info(e.right).index, c: info(e.left).value | 0 };
	return undefined;
}

// y was just assigned: a constant step of y shifts its relations, a copy of another pointer plus a constant relates the two
function ordAssign(ctx: Ctx, S: State, fn: string, y: number, expr: number, old: V, val: V) {
	if (!ctx.ords && !ordLive(val)) return;
	const f = ordForm(expr);
	const rels = ctx.ords ? ordList(S, fn) : [];
	if (f && f.x === y && ordLive(old) && ordLive(val)) {
		for (const r of rels) {
			if (r.y === y) ordPut(S, fn, y, r.x, ordStep(r.lo, f.c), ordStep(r.hi, f.c));
			else if (r.x === y) ordPut(S, fn, r.y, y, ordStep(r.lo, -f.c), ordStep(r.hi, -f.c));
		}
		return;
	}
	for (const r of rels) if (r.y === y || r.x === y) S.c.delete(ordKey(fn, r.y, r.x));
	if (!f || f.x === y || !ordLive(val) || !ordLive(S.l[f.x])) return;
	ctx.ords = true;
	for (const r of rels) {
		if (r.y === f.x && r.x !== y) ordPut(S, fn, y, r.x, ordStep(r.lo, f.c), ordStep(r.hi, f.c));
		else if (r.x === f.x && r.y !== y)
			ordPut(S, fn, r.y, y, ordStep(r.lo, -f.c), ordStep(r.hi, -f.c));
	}
	ordPut(S, fn, y, f.x, f.c, f.c);
	ordPut(S, fn, f.x, y, -f.c, -f.c);
}

// a pointer read, cut above by a local it trails and tagged with that local's zero padding bound
function ordTighten(S: State, fn: string, idx: number, v: V): V {
	if (!ordLive(v)) return v;
	let hi = v.hi;
	let sb = v.sb;
	for (let x = 0; x < S.l.length; x++) {
		const X = S.l[x]!;
		if (x === idx || !ordLive(X)) continue;
		const f = S.c.get(ordKey(fn, idx, x));
		if (!f) continue;
		const up = f.hi - CBIAS;
		if (up >= ORD_NONE) continue;
		hi = Math.min(hi, X.hi + up);
		if (X.sb && (!sb || (sb.k === X.sb.k && X.sb.c + up < sb.c)))
			sb = { k: X.sb.k, c: X.sb.c + up, eh: X.sb.eh };
	}
	if (hi < v.lo || (hi === v.hi && sb === v.sb)) return v;
	return sentCap({ ...v, hi, sb });
}

// #endregion

// #region i64 exact

// an i64 whose two words are exact plain values is a number; any other i64 stays unknown
function exact64(v: V): bigint | undefined {
	const p = v.pair;
	if (!p || v.a || !plainCell(p[0]) || !plainCell(p[1])) return undefined;
	return (BigInt(p[1].lo) << 32n) | BigInt(p[0].lo);
}

const pair64 = (x: bigint): V => {
	const u = BigInt.asUintN(64, x);
	return { ...TOP, pair: [exactV(Number(u & 0xffffffffn)), exactV(Number(u >> 32n))] };
};

// allocator mode: an i64 operation on exact operands is evaluated, so a counter that starts at zero decides its tests
function i64Bin(op: number, a: V, b: V): V | undefined {
	const x = exact64(a);
	const y = exact64(b);
	if (x === undefined || y === undefined) return undefined;
	const s = BigInt.asIntN;
	const bool = (t: boolean) => exactV(t ? 1 : 0);
	switch (op) {
		case named.AddInt64:
			return pair64(x + y);
		case named.SubInt64:
			return pair64(x - y);
		case named.MulInt64:
			return pair64(x * y);
		case named.AndInt64:
			return pair64(x & y);
		case named.OrInt64:
			return pair64(x | y);
		case named.XorInt64:
			return pair64(x ^ y);
		case named.ShlInt64:
			return pair64(x << (y & 63n));
		case named.ShrUInt64:
			return pair64(x >> (y & 63n));
		case named.EqInt64:
			return bool(x === y);
		case named.NeInt64:
			return bool(x !== y);
		case named.LtUInt64:
			return bool(x < y);
		case named.LeUInt64:
			return bool(x <= y);
		case named.GtUInt64:
			return bool(x > y);
		case named.GeUInt64:
			return bool(x >= y);
		case named.LtSInt64:
			return bool(s(64, x) < s(64, y));
		case named.LeSInt64:
			return bool(s(64, x) <= s(64, y));
		case named.GtSInt64:
			return bool(s(64, x) > s(64, y));
		case named.GeSInt64:
			return bool(s(64, x) >= s(64, y));
	}
	return undefined;
}

function i64Un(op: number, a: V): V | undefined {
	if (op === named.ExtendUInt32 || op === named.ExtendSInt32) {
		if (!plainCell(a)) return undefined;
		return pair64(op === named.ExtendUInt32 ? BigInt(a.lo) : BigInt(a.lo | 0));
	}
	const x = exact64(a);
	if (x === undefined) return undefined;
	if (op === named.WrapInt64) return exactV(Number(x & 0xffffffffn));
	if (op === named.EqZInt64) return exactV(x === 0n ? 1 : 0);
	return undefined;
}

// #endregion

// #region saturating subtraction

const localIndex = (e: number): number | undefined => {
	const id = binaryen.getExpressionId(e);
	if (id === binaryen.LocalGetId) return info(e).index;
	if (id === binaryen.LocalSetId && info(e).isTee) return info(e).index;
	return undefined;
};

const kindOf = (e: number, id: number, op?: number): any => {
	if (binaryen.getExpressionId(e) !== id) return undefined;
	const x = info(e);
	return op === undefined || x.op === op ? x : undefined;
};

// select(K - d, z, d <u K) with K and d the same locals on both sides: the subtraction runs only when d < K,
// so it lies in [1, K]; d is an i32 or an i64 compared with K extended, and z is a constant or a local read
function satSub(S: State, v: any, other: V): V | undefined {
	const sub = kindOf(v.ifTrue, binaryen.BinaryId, named.SubInt32);
	if (!sub) return undefined;
	const falseId = binaryen.getExpressionId(v.ifFalse);
	if (falseId !== binaryen.ConstId && falseId !== binaryen.LocalGetId) return undefined;
	const k = localIndex(sub.left);
	const wrapped = kindOf(sub.right, binaryen.UnaryId, named.WrapInt64);
	const d = localIndex(wrapped ? wrapped.value : sub.right);
	const cond = kindOf(v.condition, binaryen.BinaryId, wrapped ? named.LtUInt64 : named.LtUInt32);
	if (k === undefined || d === undefined || !cond || localIndex(cond.left) !== d)
		return undefined;
	const grown = wrapped ? kindOf(cond.right, binaryen.UnaryId, named.ExtendUInt32) : undefined;
	if (localIndex(grown ? grown.value : cond.right) !== k || (wrapped && !grown)) return undefined;
	const K = S.l[k];
	if (!K || K.a || K.r || K.k || K.t || K.z || K.pair || K.s !== undefined || K.hi < 1)
		return undefined;
	return joinV(mk(1, K.hi), other);
}

// #endregion

// #region config premise

interface ConfigCtx {
	word: number;
	at: number;
	bytes: Uint8Array;
	extent: number;
}

const windowed = (ctx: Ctx, x: number) => ctx.windows.some((w) => x >= w.low && x <= w.end);

// the table word that names the config, and loads wholly inside the frozen words
function configLoad(ctx: Ctx, addr: V, offset: number, v: any): V | undefined {
	const C = ctx.config!;
	if (v.type !== binaryen.i32) return undefined;
	if (v.bytes === 4 && addr.r && addr.tb >= 0 && addr.tb + offset === C.word)
		return exactV(C.at, windowed(ctx, C.at));
	if (addr.r || addr.a || addr.k || !isExact(addr)) return undefined;
	const lo = addr.lo + offset;
	if (lo < C.at || lo + v.bytes > C.at + C.bytes.length) return undefined;
	let raw = 0;
	for (let i = v.bytes - 1; i >= 0; i--) raw = raw * 256 + C.bytes[lo - C.at + i]!;
	const x =
		(v.isSigned && v.bytes < 4 ? (raw << (32 - 8 * v.bytes)) >> (32 - 8 * v.bytes) : raw) >>> 0;
	return exactV(x, windowed(ctx, x));
}

// a write that may reach the frozen words would make their constants stale
function configWrite(ctx: Ctx, lo: number, end: number) {
	const C = ctx.config;
	if (C && lo < C.at + C.bytes.length && end > C.at)
		refuse(
			'config-store',
			'a store may reach the frozen configuration words',
			Math.max(lo, C.at)
		);
}

// a record-derived pointer never equals an address inside the config region
function configCompare(ctx: Ctx, op: string, a: V, b: V): V | undefined {
	const C = ctx.config;
	if (!C || (op !== 'Eq' && op !== 'Ne')) return undefined;
	const apart = (p: V, q: V) =>
		p.r && !p.k && !p.a && isExact(q) && !q.r && q.lo >= C.at && q.lo < C.at + C.extent;
	return apart(a, b) || apart(b, a) ? exactV(op === 'Eq' ? 0 : 1) : undefined;
}

const CONFIG_RULES = [
	'the table word at `word` equals `at` in every record; the router compares every record before it runs',
	'the frozen bytes equal the bytes in memory when the run starts, and no record or host writes them; the router compares them',
	'no store or bulk operation of the closure may reach the frozen bytes, and no window overlaps them',
	'a record-derived pointer never equals an address in [at, at + extent); no record region overlaps that range (guardRecords)',
	'the call tree is analysed exactly, one analysis per call, down to the recursion cap'
];

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
		unproved: 0,
		rels: false,
		syms: 0,
		factTick: 0,
		prefix: undefined,
		config: undefined,
		recursion: 1,
		depth: 0,
		soft: 0,
		curs: false,
		srcs: false,
		ords: false,
		dispatch: new Map(),
		splits: new Map()
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
	'a stack access at an unknown offset stays inside the frames the record allocates',
	'the stack pointer at entry is 16-byte aligned, which resolves an or on a stack address as an add',
	'no exact constant the module compares with a stack address for equality is a stack address of any slot',
	'initial data bytes that the checker reads as constants are written by no store of the closure, the host or an earlier record',
	'every function a table slot names is the one its element segment names: the table is defined in the module, not exported, and no instruction of the closure writes it'
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
		if (options.prefix && alloc)
			return fail(
				'unsupported',
				'the prefix option does not combine with the allocator mode'
			);
		const config: ConfigCtx | undefined = options.config
			? {
					word: options.config.word,
					at: options.config.at,
					bytes: Uint8Array.from(options.config.bytes),
					extent: options.config.extent
				}
			: undefined;
		const recursion = Math.max(1, Math.floor(options.recursion ?? 1));
		if ((config || recursion > 1) && (alloc || options.prefix))
			return fail(
				'unsupported',
				'the config and recursion options do not combine with the allocator mode or the prefix option'
			);
		if (config && (!config.bytes.length || config.extent < config.bytes.length))
			return fail('invalid', 'the config extent is smaller than its frozen words');
		let cursor = typeof options.prefix === 'object' ? options.prefix : undefined;
		if (options.prefix === true) {
			const found = makeCtx(module, conv, sp, maxSteps);
			found.prefix = newPrefix(-1, 0, true);
			try {
				runEntry(found, target.value, params);
			} catch {
				// the main run reports a refusal
			}
			cursor = pickCursor(found.prefix);
		}
		// the taint summary is flow-insensitive: analyse again with what the last pass stored until it stops growing
		const settle = (windows: OwnershipWindow[]) => {
			let sum = emptySummary();
			for (let pass = 0; pass < 6; pass++) {
				const c = makeCtx(module, conv, sp, maxSteps);
				c.alloc = alloc;
				c.prefix = cursor ? newPrefix(cursor.cell, cursor.base) : undefined;
				c.config = config;
				c.recursion = recursion;
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
		if (
			config &&
			windows.some((w) => w.low < config.at + config.bytes.length && w.end > config.at)
		)
			return fail(
				'config-store',
				'a window overlaps the frozen configuration words',
				config.at
			);
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
			...(ctx.prefix?.stores
				? {
						prefix: {
							cell: ctx.prefix.cell,
							base: ctx.prefix.base,
							cursorStores: ctx.prefix.stores,
							splits: ctx.prefix.splits,
							rules: PREFIX_RULES
						}
					}
				: {}),
			...(config
				? {
						config: {
							word: config.word,
							at: config.at,
							bytes: Buffer.from(config.bytes).toString('hex'),
							extent: config.extent,
							rules: CONFIG_RULES
						}
					}
				: {}),
			...(recursion > 1 ? { recursion: { cap: recursion, depth: ctx.depth } } : {}),
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
		...(certificate.prefix
			? { prefix: { cell: certificate.prefix.cell, base: certificate.prefix.base } }
			: {}),
		...(certificate.allocator
			? {
					allocator: {
						arenaBytes: certificate.allocator.arenaBytes,
						arenaWord: certificate.allocator.arenaWord
					}
				}
			: {}),
		...(certificate.config
			? {
					config: {
						word: certificate.config.word,
						at: certificate.config.at,
						bytes: Uint8Array.from(Buffer.from(certificate.config.bytes, 'hex')),
						extent: certificate.config.extent
					}
				}
			: {}),
		...(certificate.recursion ? { recursion: certificate.recursion.cap } : {})
	});
	if (again.kind !== 'certificate') return false;
	const strip = ({ stats: _stats, ...rest }: OwnershipCertificate) => JSON.stringify(rest);
	return strip(again) === strip(certificate);
}

/** Whether no region of the records overlaps a window or, with the config option, the config region. */
export function guardRecords(
	certificate: OwnershipCertificate,
	regions: [number, number][]
): boolean {
	const config = certificate.config;
	return regions.every(
		([start, end]) =>
			certificate.windows.every((w) => end <= w.low || start >= w.end) &&
			(!config || end <= config.at || start >= config.at + config.extent)
	);
}

/** Whether a record table and a memory image satisfy the premises of a config certificate. */
export function checkConfig(
	certificate: OwnershipCertificate,
	memory: Uint8Array,
	table: { at: number; count: number; recordBytes?: number }
): boolean {
	const config = certificate.config;
	if (!config) return true;
	const frozen = Buffer.from(config.bytes, 'hex');
	if (config.at + frozen.length > memory.length) return false;
	for (let i = 0; i < frozen.length; i++) if (memory[config.at + i] !== frozen[i]) return false;
	const stride = table.recordBytes ?? certificate.convention.recordBytes;
	const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
	for (let i = 0; i < table.count; i++)
		if (view.getUint32(table.at + i * stride + config.word, true) !== config.at) return false;
	return true;
}

// #endregion
