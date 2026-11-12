import { ARENAS, DATA, OUT, RECORDS, SLICE, STACK_TOP, TABLE } from './ownership-alloc-modules.ts';
import { assemble } from './ownership-modules.ts';

// structure-aware generator of record functions for the ownership certificate; written without reading the
// checker. Each plan is a skeleton plus a list of statement texts, so a statement can be dropped to minimize.
// usage: ownership-redteam-run.ts (the runner); this file only generates

export const CONST_TABLE = 20480;
export const HELPER_CELL = 4300;
export const WINDOW_LOW = 4096;

export type Skeleton = 'indexed' | 'bottom' | 'callee' | 'pointer' | 'indexed-callee';

export interface Flags {
	stack: boolean;
	global: boolean;
	indirect: 'pure' | 'stale' | 'none';
	host: boolean;
	table: boolean;
}

export interface Plan {
	seed: number;
	mode: 'safe' | 'single' | 'free';
	skeleton: Skeleton;
	limit: string;
	statements: string[];
	attacks: string[];
	flags: Flags;
	/** a value read in a window cell the module never writes is in the constant table */
	constTable: number[];
}

export interface Weights {
	attack: number;
	safe: number;
}

export const DEFAULT_WEIGHTS: Weights = { attack: 0.4, safe: 0.7 };

const mulberry = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const KONSTS = [
	0,
	1,
	2,
	3,
	4,
	5,
	7,
	8,
	15,
	16,
	31,
	32,
	63,
	64,
	100,
	255,
	256,
	1000,
	4095,
	65535,
	65536,
	0x7fffffff,
	-1,
	-2,
	-16,
	-2147483648,
	12345,
	0x55aa55aa | 0
];
const LOCALS = ['sum', 'len', 'a', 'b', 'c', 'd', 'k'];
const TEMPS = ['a', 'b', 'c', 'd'];
const BIN = [
	'add',
	'sub',
	'mul',
	'and',
	'or',
	'xor',
	'shl',
	'shr_s',
	'shr_u',
	'rotl',
	'rotr',
	'eq',
	'ne',
	'lt_u',
	'lt_s',
	'gt_u',
	'gt_s',
	'le_u',
	'ge_s'
];
const UN = ['clz', 'ctz', 'popcnt', 'eqz', 'extend8_s', 'extend16_s'];

// #region exotic addresses: a chain of ops whose value the generator computes itself

export interface Ex {
	wat: string;
	v: number;
}
const u = (v: number) => BigInt(v >>> 0);
const i32 = (x: bigint) => Number(BigInt.asIntN(32, x));

export function exotic(next: () => number, target: number, steps: number): Ex {
	const k0 = (next() * 2 ** 32) | 0;
	let x: Ex = { wat: `(i32.const ${k0})`, v: k0 };
	const pick = <T>(l: T[]) => l[Math.floor(next() * l.length)]!;
	for (let n = 0; n < steps; n++) {
		const s = Math.floor(next() * 72);
		const c = s & 31;
		const k = (next() * 2 ** 32) | 0;
		const odd = k | 1;
		const w = x.wat;
		const v = x.v;
		const kind = pick([
			'add',
			'xor',
			'mul',
			'shl',
			'shr_u',
			'shr_s',
			'rotl',
			'rotr',
			'w-shl',
			'w-shr_u',
			'w-shr_s',
			'w-rotl',
			'w-rotr',
			'clz',
			'ctz',
			'popcnt',
			'ext8',
			'ext16',
			'div',
			'rem',
			'eqz',
			'sel'
		]);
		const wrap = (inner: string) => `(i32.wrap_i64 ${inner} )`;
		const ext = `(i64.extend_i32_u ${w})`;
		const exts = `(i64.extend_i32_s ${w})`;
		switch (kind) {
			case 'add':
				x = { wat: `(i32.add ${w} (i32.const ${k}))`, v: (v + k) | 0 };
				break;
			case 'xor':
				x = { wat: `(i32.xor ${w} (i32.const ${k}))`, v: v ^ k };
				break;
			case 'mul':
				x = { wat: `(i32.mul ${w} (i32.const ${odd}))`, v: Math.imul(v, odd) };
				break;
			case 'shl':
				x = { wat: `(i32.shl ${w} (i32.const ${s}))`, v: v << c };
				break;
			case 'shr_u':
				x = { wat: `(i32.shr_u ${w} (i32.const ${s}))`, v: (v >>> c) | 0 };
				break;
			case 'shr_s':
				x = { wat: `(i32.shr_s ${w} (i32.const ${s}))`, v: v >> c };
				break;
			case 'rotl':
				x = {
					wat: `(i32.rotl ${w} (i32.const ${s}))`,
					v: (v << c) | (v >>> ((32 - c) & 31)) | 0
				};
				break;
			case 'rotr':
				x = {
					wat: `(i32.rotr ${w} (i32.const ${s}))`,
					v: (v >>> c) | (v << ((32 - c) & 31)) | 0
				};
				break;
			case 'w-shl':
				x = {
					wat: wrap(`(i64.shl ${ext} (i64.const ${s}))`),
					v: i32(u(v) << BigInt(s & 63))
				};
				break;
			case 'w-shr_u':
				x = {
					wat: wrap(`(i64.shr_u ${ext} (i64.const ${s}))`),
					v: i32(u(v) >> BigInt(s & 63))
				};
				break;
			case 'w-shr_s':
				x = {
					wat: wrap(`(i64.shr_s ${exts} (i64.const ${s}))`),
					v: i32(BigInt(v) >> BigInt(s & 63))
				};
				break;
			case 'w-rotl': {
				const a = BigInt.asUintN(64, u(v) * 0x100000001n);
				const r = BigInt(s & 63);
				const out = BigInt.asUintN(64, (a << r) | (a >> ((64n - r) & 63n)));
				x = {
					wat: wrap(
						`(i64.rotl (i64.mul ${ext} (i64.const 4294967297)) (i64.const ${s}))`
					),
					v: i32(out)
				};
				break;
			}
			case 'w-rotr': {
				const a = BigInt.asUintN(64, u(v) * 0x100000001n);
				const r = BigInt(s & 63);
				const out = BigInt.asUintN(64, (a >> r) | (a << ((64n - r) & 63n)));
				x = {
					wat: wrap(
						`(i64.rotr (i64.mul ${ext} (i64.const 4294967297)) (i64.const ${s}))`
					),
					v: i32(out)
				};
				break;
			}
			case 'clz':
				x = { wat: `(i32.clz ${w})`, v: Math.clz32(v) };
				break;
			case 'ctz':
				x = { wat: `(i32.ctz ${w})`, v: v === 0 ? 32 : 31 - Math.clz32(v & -v) };
				break;
			case 'popcnt': {
				let p = 0;
				for (let t = v >>> 0; t; t &= t - 1) p++;
				x = { wat: `(i32.popcnt ${w})`, v: p };
				break;
			}
			case 'ext8':
				x = { wat: `(i32.extend8_s ${w})`, v: (v << 24) >> 24 };
				break;
			case 'ext16':
				x = { wat: `(i32.extend16_s ${w})`, v: (v << 16) >> 16 };
				break;
			case 'div': {
				const d = (k >>> 0) % 1000 || 1;
				x = { wat: `(i32.div_u ${w} (i32.const ${d}))`, v: Math.floor((v >>> 0) / d) | 0 };
				break;
			}
			case 'rem': {
				const d = ((k >>> 0) % 1000) + 2;
				x = { wat: `(i32.rem_u ${w} (i32.const ${d}))`, v: ((v >>> 0) % d) | 0 };
				break;
			}
			case 'eqz':
				x = { wat: `(i32.eqz ${w})`, v: v === 0 ? 1 : 0 };
				break;
			default:
				x = {
					wat: `(select ${w} (i32.const ${k}) (i32.const ${s & 1}))`,
					v: s & 1 ? v : k
				};
		}
	}
	return { wat: `(i32.add ${x.wat} (i32.const ${(target - x.v) | 0}))`, v: target };
}

// #endregion

class Gen {
	next: () => number;
	win = new Set<number>();
	slotW = new Set<number>();
	stk = new Set<number>();
	attacks: string[] = [];
	flags: Flags = { stack: false, global: false, indirect: 'none', host: false, table: false };
	constTable: number[] = [];
	inFrame = false;
	loops = 0;
	canBreak = false;
	weights: Weights;
	skeleton: Skeleton;
	constructor(seed: number, skeleton: Skeleton, weights: Weights) {
		this.next = mulberry(seed);
		this.weights = weights;
		this.skeleton = skeleton;
		this.canBreak = skeleton === 'indexed' || skeleton === 'pointer' || skeleton === 'bottom';
	}
	rnd = (n: number) => Math.floor(this.next() * n);
	chance = (p: number) => this.next() < p;
	pick = <T>(l: readonly T[]): T => l[this.rnd(l.length)]!;
	konst = () => this.pick(KONSTS);
	local = () => `(local.get $${this.pick(LOCALS)})`;
	idx = () =>
		this.pick(['(local.get $idx)', '(local.get $cnt)', '(local.get $bt)', '(local.get $bo)']);

	covered(set: Set<number>, at: number, width: number) {
		for (let i = 0; i < width; i++) if (!set.has(at + i)) return false;
		return true;
	}
	mark(set: Set<number>, at: number, width: number) {
		for (let i = 0; i < width; i++) set.add(at + i);
	}

	// a data byte of the record, as an i32 expression
	byte(): string {
		return `(i32.load8_u (i32.add (local.get $p) (i32.and ${this.e(0)} (i32.const 63))))`;
	}

	dataLoad(d: number): string {
		const base = this.pick(['p', 'p', 'p', 'aux', 'arena']);
		const op = this.pick(['load8_u', 'load8_s', 'load16_u', 'load16_s', 'load', 'load8_u']);
		return `(i32.${op} (i32.add (local.get $${base}) (i32.and ${this.e(d)} (i32.const 60))))`;
	}

	winRead(): string | undefined {
		const widths: [string, number][] = [
			['i32.load', 4],
			['i32.load8_u', 1],
			['i32.load16_u', 2],
			['i32.load8_s', 1]
		];
		for (let t = 0; t < 6; t++) {
			const [op, w] = this.pick(widths);
			const at =
				WINDOW_LOW +
				this.rnd(32) * 4 +
				(w === 1 ? this.rnd(4) : w === 2 ? 2 * this.rnd(2) : 0);
			if (this.covered(this.win, at, w)) return `(${op} (i32.const ${at}))`;
		}
		return undefined;
	}

	slotRead(): string | undefined {
		for (let t = 0; t < 4; t++) {
			const at = this.rnd(15) * 4;
			if (this.covered(this.slotW, at, 4)) return `(i32.load offset=${at} (local.get $slot))`;
		}
		return undefined;
	}

	e(d: number): string {
		const k = d <= 0 ? this.rnd(5) : this.rnd(20);
		switch (k) {
			case 0:
				return `(i32.const ${this.konst()})`;
			case 1:
			case 2:
				return this.local();
			case 3:
				return this.dataLoad(0);
			case 4:
				return this.winRead() ?? this.slotRead() ?? this.local();
			case 5:
			case 6:
			case 7:
			case 8:
				return `(i32.${this.pick(BIN)} ${this.e(d - 1)} ${this.e(d - 1)})`;
			case 9:
				return `(i32.${this.pick(UN)} ${this.e(d - 1)})`;
			case 10:
				return `(select ${this.e(d - 1)} ${this.e(d - 1)} ${this.e(d - 1)})`;
			case 11:
				return this.dataLoad(d - 1);
			case 12:
				return `(i32.wrap_i64 (i64.shr_u (i64.mul (i64.extend_i32_u ${this.e(d - 1)}) (i64.const ${this.pick([3, 7, 255, 4294967297, 1000003])})) (i64.const ${this.pick([0, 1, 8, 16, 31, 32, 40])})))`;
			case 13:
				return `(i32.trunc_sat_f64_u (f64.mul (f64.convert_i32_u ${this.e(d - 1)}) (f64.const ${this.pick([0.5, 1.5, 3.25, 1e3])})))`;
			case 14:
				return `(i32.div_u ${this.e(d - 1)} (i32.or ${this.e(d - 1)} (i32.const 1)))`;
			case 15:
				return `(i32.rem_s ${this.e(d - 1)} (i32.or ${this.e(d - 1)} (i32.const 3)))`;
			case 16:
				return this.byte();
			case 17:
				return `(call $hp ${this.e(d - 1)})`;
			case 18:
				return this.winRead() ?? `(i32.const ${this.konst()})`;
			default:
				return `(i32.wrap_i64 (i64.load offset=${this.pick([0, 8, 16, 24])} (i32.add (local.get $p) (i32.const ${this.pick([0, 8, 16, 32])}))))`;
		}
	}

	slotStore(): string {
		const w = this.pick(['i32', 'i32', 'i32', 'i64', 'i16', 'i8']);
		const e = this.e(2);
		if (w === 'i32') {
			const at = this.rnd(15) * 4;
			this.mark(this.slotW, at, 4);
			return `(i32.store offset=${at} (local.get $slot) ${e})`;
		}
		if (w === 'i64') {
			const at = this.rnd(7) * 8;
			this.mark(this.slotW, at, 8);
			return `(i64.store offset=${at} (local.get $slot) (i64.extend_i32_u ${e}))`;
		}
		if (w === 'i16') {
			const at = this.rnd(31) * 2;
			this.mark(this.slotW, at, 2);
			return `(i32.store16 offset=${at} (local.get $slot) ${e})`;
		}
		const at = this.rnd(64);
		this.mark(this.slotW, at, 1);
		return `(i32.store8 offset=${at} (local.get $slot) ${e})`;
	}

	winStore(): string {
		const w = this.pick(['i32', 'i32', 'i32', 'i64', 'i8', 'i16']);
		const e = this.e(2);
		const cell = WINDOW_LOW + this.rnd(32) * 4;
		if (w === 'i32') {
			this.mark(this.win, cell, 4);
			return `(i32.store (i32.const ${cell}) ${e})`;
		}
		if (w === 'i64') {
			this.mark(this.win, cell, 8);
			return `(i64.store (i32.const ${cell}) (i64.extend_i32_u ${e}))`;
		}
		if (w === 'i16') {
			this.mark(this.win, cell, 2);
			return `(i32.store16 (i32.const ${cell}) ${e})`;
		}
		const at = cell + this.rnd(4);
		this.mark(this.win, at, 1);
		return `(i32.store8 (i32.const ${at}) ${e})`;
	}

	block(count: number, depth: number): string {
		const out: string[] = [];
		for (let i = 0; i < count; i++) out.push(this.stmt(depth));
		return out.join('\n');
	}

	ifElse(depth: number): string {
		const before = new Set(this.win);
		const beforeSlot = new Set(this.slotW);
		const cond = this.e(2);
		const a = this.block(1 + this.rnd(2), depth - 1);
		const winA = this.win;
		this.win = new Set(before);
		const slotA = this.slotW;
		this.slotW = new Set(beforeSlot);
		const withElse = this.chance(0.6);
		const b = withElse ? this.block(1 + this.rnd(2), depth - 1) : '';
		const inter = (x: Set<number>, y: Set<number>) => new Set([...x].filter((v) => y.has(v)));
		this.win = inter(winA, withElse ? this.win : before);
		this.slotW = inter(slotA, withElse ? this.slotW : beforeSlot);
		return `(if ${cond} (then ${a}) ${withElse ? `(else ${b})` : ''})`;
	}

	loop(depth: number): string {
		const slot = this.loops++;
		const q = slot === 0 ? 'q' : 'q2';
		const m = this.pick([
			`(i32.const ${this.pick([1, 2, 3, 4, 8, 9])})`,
			'(i32.and (local.get $len) (i32.const 7))',
			'(local.get $len)',
			'(i32.and (local.get $sum) (i32.const 3))'
		]);
		const constM = /^\(i32\.const (\d+)\)$/.exec(m);
		const before = new Set(this.win);
		const label = `lb${slot}`;
		const body = this.block(1 + this.rnd(2), depth - 1);
		const inside = this.win;
		// cells written inside a loop whose trip count may be zero are not written after it
		this.win = new Set(before);
		if (constM && Number(constM[1]) > 0) this.win = inside;
		this.loops--;
		return `(local.set $${q} (i32.const 0))
(block $${label} (loop $lp${slot}
(br_if $${label} (i32.ge_u (local.get $${q}) ${m}))
${body}
(local.set $${q} (i32.add (local.get $${q}) (i32.const 1))) (br $lp${slot})))`;
	}

	bulkOp(): string {
		const k = this.rnd(5);
		if (k === 0) {
			const at = WINDOW_LOW + this.rnd(30) * 4;
			this.mark(this.win, at, 8);
			return `(memory.fill (i32.const ${at}) ${this.e(1)} (i32.const 8))`;
		}
		if (k === 1) {
			const src = WINDOW_LOW + this.rnd(30) * 4;
			const at = this.rnd(14) * 4;
			if (this.covered(this.win, src, 8)) this.mark(this.slotW, at, 8);
			return `(memory.copy (i32.add (local.get $slot) (i32.const ${at})) (i32.const ${src}) (i32.const 8))`;
		}
		if (k === 2)
			return `(memory.copy (local.get $slot) (local.get $p) (i32.and ${this.e(1)} (i32.const 63)))`;
		if (k === 3) {
			const at = WINDOW_LOW + this.rnd(16) * 4;
			this.mark(this.win, at, 16);
			return `(memory.copy (i32.const ${at}) (i32.add (local.get $p) (i32.and ${this.e(1)} (i32.const 31))) (i32.const 16))`;
		}
		return `(memory.fill (i32.add (local.get $slot) (i32.and ${this.e(1)} (i32.const 31))) ${this.e(1)} (i32.and ${this.e(1)} (i32.const 31)))`;
	}

	frame(depth: number): string {
		this.inFrame = true;
		this.flags.stack = true;
		const size = this.pick([16, 32, 64]);
		const before = new Set(this.stk);
		const parts: string[] = [`(global.set $sp (i32.sub (global.get $sp) (i32.const ${size})))`];
		const n = 1 + this.rnd(3);
		for (let i = 0; i < n; i++) {
			const at = this.rnd(size / 4) * 4;
			if (this.chance(0.6) || !this.covered(this.stk, at, 4)) {
				this.mark(this.stk, at, 4);
				parts.push(`(i32.store offset=${at} (global.get $sp) ${this.e(2)})`);
			} else {
				parts.push(
					`(local.set $${this.pick(TEMPS)} (i32.load offset=${at} (global.get $sp)))`
				);
			}
		}
		parts.push(this.block(1, depth - 1));
		parts.push(`(global.set $sp (i32.add (global.get $sp) (i32.const ${size})))`);
		this.stk = before;
		this.inFrame = false;
		return parts.join('\n');
	}

	stmt(depth: number): string {
		if (this.chance(this.weights.attack / 4)) return this.attack(depth);
		const k = this.rnd(100);
		if (k < 20) return `(local.set $${this.pick(TEMPS)} ${this.e(3)})`;
		if (k < 42) return this.slotStore();
		if (k < 56) return this.winStore();
		if (k < 64) {
			const r = this.winRead();
			return `(local.set $${this.pick(TEMPS)} ${r ?? this.e(1)})`;
		}
		if (k < 72 && depth > 0) return this.ifElse(depth);
		if (k < 78 && depth > 0 && this.loops < 2) return this.loop(depth);
		if (k < 83) return this.bulkOp();
		if (k < 87) {
			this.mark(this.win, HELPER_CELL, 4);
			return `(call $hw ${this.e(2)})`;
		}
		if (k < 90 && depth > 0 && !this.inFrame) return this.frame(depth);
		if (k < 93) {
			if (this.chance(0.5))
				return `(if (i32.gt_u ${this.byte()} (i32.const ${this.pick([250, 254, 255])})) (then (unreachable)))`;
			return `(br_if $rb ${this.e(2)})`;
		}
		if (k < 95) {
			this.flags.host = true;
			return `(call $f ${this.e(2)})`;
		}
		if (k < 97) {
			const w = this.winRead();
			return w
				? `(i32.store offset=${this.rnd(15) * 4} (local.get $slot) ${w})`
				: this.slotStore();
		}
		return this.slotStore();
	}

	// #region attacks

	attack(depth: number): string {
		const names = [
			'first-flag',
			'first-flag',
			'index-data',
			'index-table',
			'addr-byte',
			'addr-byte',
			'indirect',
			'loop-stale',
			'loop-stale',
			'bulk-partial',
			'exotic',
			'exotic',
			'exotic',
			'global',
			'sp-leak',
			'trap-late',
			'base-param',
			'memsize',
			'cond-write',
			'cond-write',
			'partial-width',
			'partial-width',
			'host-pointer',
			'arena-store',
			'out-of-slot',
			'read-prev-slot',
			'break-data',
			'return-early',
			'br-table',
			'tee-carry',
			'sp-store',
			'window-index',
			'const-store',
			'f64-carry',
			'loop-aux',
			'copy-overlap'
		];
		const name = this.pick(names);
		this.attacks.push(name);
		switch (name) {
			case 'first-flag':
				return `(if (i32.eqz (i32.load (i32.const 4200)))
(then (i32.store (local.get $slot) (i32.const 1)) (i32.store (i32.const 4200) (i32.const 1)))
(else (i32.store (local.get $slot) (i32.add (local.get $sum) (i32.const 2)))))`;
			case 'index-data':
				return this.pick([
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) ${this.idx()})`,
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.add ${this.idx()} ${this.e(1)}))`,
					`(local.set $${this.pick(TEMPS)} ${this.idx()})`,
					`(if (i32.eqz (i32.and ${this.idx()} (i32.const 1))) (then (i32.store (local.get $slot) (i32.const 7))))`,
					`(i32.store8 offset=${this.rnd(64)} (local.get $slot) (i32.shl ${this.idx()} (i32.const 1)))`
				]);
			case 'index-table':
				this.constTable = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255);
				return `(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load8_u (i32.add (i32.const ${CONST_TABLE}) (i32.and ${this.idx()} (i32.const 15)))))`;
			case 'addr-byte': {
				const c = this.rnd(8) * 4;
				return `(i32.store (i32.add (i32.const ${WINDOW_LOW + c}) (i32.and ${this.byte()} (i32.const 28))) ${this.e(2)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.add (i32.const ${WINDOW_LOW + c}) (i32.and ${this.byte()} (i32.const 28)))))`;
			}
			case 'indirect': {
				this.flags.table = true;
				this.flags.indirect = this.chance(0.5) ? 'stale' : 'pure';
				return `(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (call_indirect (type $ft) ${this.e(2)} (i32.and ${this.byte()} (i32.const 1))))`;
			}
			case 'loop-stale': {
				const cell = 4224 + this.rnd(4) * 4;
				const m = this.pick([
					'(local.get $len)',
					'(i32.and (local.get $len) (i32.const 7))',
					'(i32.shr_u (local.get $len) (i32.const 3))'
				]);
				return `(local.set $k (i32.const 0))
(block $ls (loop $lq
(br_if $ls (i32.ge_u (local.get $k) ${m}))
(i32.store (i32.const ${cell}) (i32.add (local.get $k) (local.get $sum)))
(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $lq)))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const ${cell})))`;
			}
			case 'bulk-partial': {
				const at = 4160 + this.rnd(4) * 4;
				return `(if ${this.byte()} (then (i32.store (i32.const ${at + 4}) ${this.e(1)})))
(i32.store (i32.const ${at}) ${this.e(1)})
(memory.copy (local.get $slot) (i32.const ${at}) (i32.const 8))`;
			}
			case 'exotic': {
				const cell = WINDOW_LOW + this.rnd(30) * 4;
				const x = exotic(this.next, cell, 1 + this.rnd(5));
				const y = exotic(this.next, cell + this.pick([0, 0, 4, 1, -4]), 1 + this.rnd(4));
				return this.pick([
					`(i32.store ${x.wat} ${this.e(2)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load ${y.wat}))`,
					`(i32.store (i32.const ${cell}) ${this.e(2)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load ${y.wat}))`,
					`(i32.store ${x.wat} ${this.e(2)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const ${y.v})))`,
					`(i64.store ${x.wat} (i64.extend_i32_u ${this.e(2)}))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const ${cell + 4})))`
				]);
			}
			case 'global':
				this.flags.global = true;
				return this.pick([
					`(global.set $g (i32.add (global.get $g) (i32.const 1)))
(i32.store (local.get $slot) (global.get $g))`,
					`(i32.store (local.get $slot) (i32.add (global.get $g) ${this.e(1)}))
(global.set $g ${this.e(1)})`,
					`(if ${this.byte()} (then (global.set $g (i32.const 1))))
(i32.store offset=4 (local.get $slot) (global.get $g))`
				]);
			case 'sp-leak':
				this.flags.stack = true;
				return `(global.set $sp (i32.sub (global.get $sp) (i32.const ${this.pick([16, 32])})))
(i32.store (global.get $sp) ${this.e(2)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (global.get $sp)))`;
			case 'sp-store':
				this.flags.stack = true;
				return `(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (global.get $sp))`;
			case 'trap-late':
				return `(i32.store (i32.const 4208) ${this.e(2)})
(if (i32.gt_u ${this.byte()} (i32.const 250)) (then (unreachable)))`;
			case 'base-param':
				return this.pick([
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (local.get $bt))`,
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.sub (local.get $bo) (local.get $slot)))`,
					`(if (i32.eq (local.get $bt) (i32.const ${TABLE})) (then (i32.store (local.get $slot) (i32.const 5))) (else (i32.store (local.get $slot) (i32.const 6))))`,
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (local.get $cnt))`
				]);
			case 'memsize':
				return this.pick([
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (memory.size))`,
					`(local.set $a (memory.grow (i32.const 0)))`
				]);
			case 'cond-write': {
				const cell = 4212 + this.rnd(3) * 4;
				return `(if ${this.byte()} (then (i32.store (i32.const ${cell}) ${this.e(2)})))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const ${cell})))`;
			}
			case 'partial-width':
				return this.pick([
					`(i32.store8 (i32.const 4097) ${this.e(1)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const 4096)))`,
					`(i64.store (i32.const 4228) (i64.extend_i32_u ${this.e(1)}))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const 4224)))`,
					`(i32.store16 (i32.const 4234) ${this.e(1)})
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const 4232)))`
				]);
			case 'host-pointer':
				this.flags.host = true;
				this.flags.stack = true;
				return `(call $f ${this.pick(['(local.get $slot)', '(local.get $p)', '(local.get $arena)', '(global.get $sp)'])})`;
			case 'arena-store':
				return `(i32.store (i32.add (local.get $arena) (i32.and ${this.e(1)} (i32.const 508))) ${this.e(2)})`;
			case 'out-of-slot':
				return `(i32.store (i32.add (local.get $slot) (i32.const ${this.pick([64, 68, -4])})) ${this.e(2)})`;
			case 'read-prev-slot':
				return `(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.add (local.get $slot) (i32.const ${this.pick([-64, -60, 64])}))))`;
			case 'break-data':
				return this.canBreak
					? `(br_if $done (i32.eq (i32.load8_u (local.get $p)) (i32.const ${this.pick([255, 255, 7, 100])})))`
					: `(br_if $rb (i32.eq (i32.load8_u (local.get $p)) (i32.const 255)))`;
			case 'return-early':
				return `(if (i32.eq (i32.load8_u (local.get $p)) (i32.const 255)) (then (return)))`;
			case 'br-table':
				return `(block $bt0 (block $bt1 (block $bt2 (br_table $bt0 $bt1 $bt2 (i32.and ${this.byte()} (i32.const 3))))
(i32.store (i32.const 4216) ${this.e(1)}) (br $bt0))
(i32.store (i32.const 4220) ${this.e(1)}))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.add (i32.load (i32.const 4216)) (i32.load (i32.const 4220))))`;
			case 'tee-carry':
				return this.pick([
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.add (local.get $e) ${this.e(1)}))
(local.set $e ${this.e(1)})`,
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (local.tee $e (i32.add (local.get $e) (i32.const 1))))`,
					`(i64.store offset=${this.rnd(7) * 8} (local.get $slot) (local.tee $w (i64.add (local.get $w) (i64.const 1))))`
				]);
			case 'const-store': {
				this.constTable = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255);
				const at = CONST_TABLE + this.rnd(4) * 4;
				return `(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const ${at})))
(i32.store (i32.const ${at}) ${this.e(2)})`;
			}
			case 'f64-carry':
				return this.pick([
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.trunc_sat_f64_u (local.tee $fl (f64.add (local.get $fl) (f64.const 1)))))`,
					`(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.trunc_sat_f64_u (local.get $fl)))
(local.set $fl (f64.convert_i32_u ${this.e(1)}))`
				]);
			case 'loop-aux':
				return `(local.set $k (i32.const 0))
(block $la (loop $lx
(br_if $la (i32.ge_u (local.get $k) (i32.and (i32.load8_u (local.get $aux)) (i32.const 7))))
(i32.store (i32.const ${4224 + this.rnd(4) * 4}) (i32.add (local.get $k) (local.get $sum)))
(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $lx)))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const 4224)))`;
			case 'copy-overlap': {
				const at = WINDOW_LOW + this.rnd(8) * 4;
				this.mark(this.win, at, 16);
				return `(memory.fill (i32.const ${at}) ${this.e(1)} (i32.const 16))
(memory.copy (i32.const ${at + this.pick([1, 2, 3, 4, 8])}) (i32.const ${at}) (i32.and ${this.byte()} (i32.const 15)))
(i32.store offset=${this.rnd(15) * 4} (local.get $slot) (i32.load (i32.const ${at + this.pick([0, 4, 8, 12])})))`;
			}
			default:
				return `(i32.store (i32.add (i32.const ${WINDOW_LOW}) (i32.and ${this.idx()} (i32.const 28))) ${this.e(1)})
(i32.store (local.get $slot) (i32.load (i32.const ${WINDOW_LOW})))`;
		}
	}

	// #endregion
}

const LOCAL_DECLS =
	'(local $p i32) (local $len i32) (local $aux i32) (local $arena i32) (local $slot i32) (local $sum i32) (local $k i32) (local $a i32) (local $b i32) (local $c i32) (local $d i32) (local $e i32) (local $q i32) (local $q2 i32) (local $w i64) (local $fl f64)';

const prologue = (rp: string, slot: string) => `(local.set $p (i32.load ${rp}))
(local.set $len (i32.load offset=4 ${rp}))
(local.set $aux (i32.load offset=8 ${rp}))
(local.set $arena (i32.load offset=12 ${rp}))
(local.set $slot ${slot})
(local.set $k (i32.const 0)) (local.set $sum (i32.const 0))
(local.set $a (i32.const 0)) (local.set $b (i32.const 0)) (local.set $c (i32.const 0)) (local.set $d (i32.const 0))
(local.set $q (i32.const 0)) (local.set $q2 (i32.const 0))
(block $sd (loop $sl
(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))`;

const PURE_LIMIT = '(local.get $n)';
const ODD_LIMITS = [
	'(i32.sub (local.get $n) (i32.const 1))',
	'(select (local.get $n) (i32.const 5) (i32.lt_u (local.get $n) (i32.const 5)))',
	'(i32.shr_u (i32.add (local.get $n) (i32.const 1)) (i32.const 1))'
];

const SKELETONS: Skeleton[] = [
	'indexed',
	'indexed',
	'bottom',
	'callee',
	'callee',
	'pointer',
	'indexed-callee'
];

export function plan(seed: number, weights: Weights = DEFAULT_WEIGHTS): Plan {
	const probe = mulberry(seed ^ 0x9e3779b9);
	const skeleton = SKELETONS[Math.floor(probe() * SKELETONS.length)]!;
	const limit =
		probe() < 0.04 ? ODD_LIMITS[Math.floor(probe() * ODD_LIMITS.length)]! : PURE_LIMIT;
	const roll = probe();
	const mode: Plan['mode'] = roll < 0.2 ? 'safe' : roll < 0.7 ? 'single' : 'free';
	const gen = new Gen(seed, skeleton, mode === 'free' ? weights : { ...weights, attack: 0 });
	const total = 3 + gen.rnd(10);
	const at = gen.rnd(total);
	const statements: string[] = [];
	for (let i = 0; i < total; i++)
		statements.push(mode === 'single' && i === at ? gen.attack(2) : gen.stmt(2));
	if (!statements.some((s) => s.includes('$slot'))) statements.push(gen.slotStore());
	if (!statements.some((s) => /\(i32\.const 4[0-3]\d\d\)/.test(s)))
		statements.unshift(gen.winStore());
	return {
		seed,
		mode,
		skeleton,
		limit: skeleton === 'indexed' || skeleton === 'indexed-callee' ? limit : '(local.get $n)',
		statements,
		attacks: gen.attacks,
		flags: gen.flags,
		constTable: gen.constTable
	};
}

export function wat(p: Plan, shared = false): string {
	const body = `(block $rb\n${p.statements.join('\n')})`;
	const decls: string[] = [];
	decls.push(`(import "env" "memory" (memory 8 40${shared ? ' shared' : ''}))`);
	if (p.flags.host) decls.push('(import "env" "f" (func $f (param i32)))');
	decls.push('(type $ft (func (param i32) (result i32)))');
	if (p.flags.stack) decls.push(`(global $sp (mut i32) (i32.const ${STACK_TOP}))`);
	if (p.flags.global) decls.push('(global $g (mut i32) (i32.const 0))');
	decls.push(
		'(func $hp (param $x i32) (result i32) (i32.add (i32.mul (local.get $x) (i32.const 5)) (i32.const 3)))'
	);
	decls.push(`(func $hw (param $x i32) (i32.store (i32.const ${HELPER_CELL}) (local.get $x)))`);
	decls.push(
		p.flags.indirect === 'stale'
			? `(func $hq (param $x i32) (result i32) (i32.add (local.get $x) (i32.load (i32.const 4304))))`
			: `(func $hq (param $x i32) (result i32) (i32.xor (local.get $x) (i32.const 90)))`
	);
	if (p.flags.table) decls.push('(table 2 funcref) (elem (i32.const 0) $hp $hq)');
	if (p.constTable.length)
		decls.push(
			`(data (i32.const ${CONST_TABLE}) "${p.constTable.map((b) => '\\' + b.toString(16).padStart(2, '0')).join('')}")`
		);
	const callee = p.skeleton === 'callee' || p.skeleton === 'indexed-callee';
	const setup = `(local.set $bt (local.get $t)) (local.set $bo (local.get $o)) (local.set $cnt (local.get $n))`;
	let bulk: string;
	if (callee) {
		decls.push(`(func $rec (param $rp i32) (param $o i32) (param $idx i32) (param $bt i32) (param $bo i32) (param $cnt i32)
${LOCAL_DECLS}
${prologue('(local.get $rp)', '(local.get $o)')}
${body})`);
		const call = (rp: string, o: string, idx: string) =>
			`(call $rec ${rp} ${o} ${idx} (local.get $bt) (local.get $bo) (local.get $cnt))`;
		if (p.skeleton === 'callee')
			bulk = `${setup}
(block $done (br_if $done (i32.eqz (local.get $n))) (loop $each
${call('(local.get $t)', '(local.get $o)', '(local.get $n)')}
(local.set $t (i32.add (local.get $t) (i32.const 16)))
(local.set $o (i32.add (local.get $o) (i32.const 64)))
(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))`;
		else
			bulk = `${setup}
(block $done (loop $each
(br_if $done (i32.ge_u (local.get $i) ${p.limit}))
${call('(i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))', '(i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6)))', '(local.get $i)')}
(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)))`;
	} else {
		const inline = (rp: string, slot: string) => `${prologue(rp, slot)}\n${body}`;
		if (p.skeleton === 'indexed')
			bulk = `${setup}
(block $done (loop $each
(br_if $done (i32.ge_u (local.get $i) ${p.limit}))
(local.set $idx (local.get $i))
(local.set $rp (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4))))
${inline('(local.get $rp)', '(i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6)))')}
(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each)))`;
		else if (p.skeleton === 'bottom')
			bulk = `${setup}
(block $done (br_if $done (i32.eqz (local.get $n))) (loop $each
(local.set $idx (local.get $i))
(local.set $rp (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4))))
${inline('(local.get $rp)', '(i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6)))')}
(local.set $i (i32.add (local.get $i) (i32.const 1)))
(br_if $each (i32.lt_u (local.get $i) (local.get $n)))))`;
		else
			bulk = `${setup}
(local.set $end (i32.add (local.get $t) (i32.shl (local.get $n) (i32.const 4))))
(block $done (loop $each
(br_if $done (i32.ge_u (local.get $t) (local.get $end)))
(local.set $idx (i32.shr_u (i32.sub (local.get $end) (local.get $t)) (i32.const 4)))
${inline('(local.get $t)', '(local.get $o)')}
(local.set $t (i32.add (local.get $t) (i32.const 16)))
(local.set $o (i32.add (local.get $o) (i32.const 64)))
(br $each)))`;
	}
	const locals = callee
		? '(local $i i32) (local $bt i32) (local $bo i32) (local $cnt i32)'
		: `${LOCAL_DECLS} (local $i i32) (local $idx i32) (local $rp i32) (local $bt i32) (local $bo i32) (local $cnt i32) (local $end i32)`;
	decls.push(`(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)
${locals}
${bulk})`);
	return `(module\n${decls.join('\n')}\n)`;
}

export const build = (p: Plan, shared = false) => assemble(wat(p, shared));

export { ARENAS, DATA, OUT, RECORDS, SLICE, STACK_TOP, TABLE };
