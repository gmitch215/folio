import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { sameError } from './iteration-diff.ts';
import { ARENAS, DATA, OUT, RECORDS, SLICE, STACK_TOP, TABLE } from './ownership-alloc-modules.ts';
import { assemble } from './ownership-modules.ts';
import {
	firstDiff,
	image,
	recordsOwnOf,
	runPrivate,
	runSerial,
	type Row
} from './ownership-redteam-run.ts';
import { plan as plan2, wat as wat2, type Plan } from './ownership-redteam.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// round 3 generator: varies the loop frame, uses t, o and n as addresses, sizes and bounds, and steps
// pointers by other strides. Body statements come from round 2's safe plans.
// usage: ownership-redteam-3.ts run START COUNT OUT.jsonl | one SEED | wat SEED | minimize SEED DIR
//        | summary OUT.jsonl | freeze

export type Frame =
	| 'top'
	| 'tail'
	| 'count-call'
	| 'bottom'
	| 'countdown'
	| 'ptr'
	| 'stride'
	| 'continue'
	| 'outer-repeat'
	| 'two-loops'
	| 'reverse'
	| 'down-ptr'
	| 'i64'
	| 'i64-ptr'
	| 'i64-mix'
	| 'peeled'
	| 'peeled-last'
	| 'rec'
	| 'rec-post'
	| 'rec-mutual';

// weights follow what the checker certifies: the frames it always refuses stay in at a low weight
export const FRAMES: [Frame, number][] = [
	['top', 15],
	['tail', 11],
	['count-call', 8],
	['bottom', 6],
	['countdown', 8],
	['stride', 6],
	['continue', 13],
	['two-loops', 8],
	['reverse', 3],
	['i64-mix', 3],
	['ptr', 1],
	['outer-repeat', 1],
	['down-ptr', 1],
	['i64', 1],
	['i64-ptr', 1],
	['peeled', 1],
	['peeled-last', 1],
	['rec', 1],
	['rec-post', 1],
	['rec-mutual', 1]
];

export const STRIDE_T = '(i32.add (local.get $t) (i32.const 16))';
export const STRIDE_O = '(i32.add (local.get $o) (i32.const 64))';

export interface Plan3 {
	seed: number;
	mode: 'safe' | 'single' | 'free';
	frame: Frame;
	wrap: boolean;
	viaCallee: boolean;
	hostile: boolean;
	tail: string;
	limit: string;
	limitB: string;
	repeat: string;
	carry: boolean;
	strideT: string;
	strideO: string;
	strideOdd: boolean;
	statements: string[];
	tags: string[];
	pre: string[];
	post: string[];
	inserts: string[];
	flags: Plan['flags'];
	constTable: number[];
}

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

const POOLS: Record<string, string[]> = {
	t: ['t'],
	o: ['o'],
	n: ['n'],
	copy: ['bt', 'bo', 'cnt'],
	mix: ['t', 'o', 'n', 'bt', 'bo', 'cnt', 'idx', 'i', 'rp', 'slot']
};

const DATAS = [
	(r: string) => `(i32.eq (i32.load8_u ${r}) (i32.const 255))`,
	(r: string) => `(i32.gt_u (i32.load8_u ${r}) (i32.const 128))`,
	(r: string) => `(i32.and (i32.load8_u (i32.add ${r} (i32.const 1))) (i32.const 1))`,
	(r: string) => `(i32.lt_u (i32.load8_u ${r}) (i32.const 40))`
];

interface Ins {
	text: string;
	pre?: string;
	post?: string;
	front?: boolean;
}

class G {
	next: () => number;
	uid = 0;
	constructor(seed: number) {
		this.next = mulberry(seed);
	}
	rnd = (n: number) => Math.floor(this.next() * n);
	chance = (p: number) => this.next() < p;
	pick = <T>(l: readonly T[]): T => l[this.rnd(l.length)]!;
	op = (pool: readonly string[]) => `(local.get $${this.pick(pool)})`;
	k = () => this.rnd(15) * 4;
	cell = () => 4232 + this.rnd(8) * 4;
	// a value of the record's own data, as a branch condition
	data = () => this.pick(DATAS)('(local.get $p)');
	// a small value built from the operands
	sm(pool: readonly string[]): string {
		const o = () => this.op(pool);
		switch (this.rnd(6)) {
			case 0:
				return `(i32.and ${o()} (i32.const ${this.pick([1, 3, 7])}))`;
			case 1:
			case 2:
				return `(i32.and (i32.shr_u ${o()} (i32.const ${this.pick([4, 5, 6, 7])})) (i32.const ${this.pick([1, 3, 7])}))`;
			case 3:
				return `(i32.rem_u ${o()} (i32.const ${this.pick([3, 5, 7])}))`;
			case 4:
				return `(i32.and (i32.sub ${o()} ${o()}) (i32.const 7))`;
			default:
				return `(i32.and (i32.add ${o()} (i32.const ${this.pick([1, 2, 3])})) (i32.const 7))`;
		}
	}
	addr(pool: readonly string[], c0 = this.cell()): string {
		return `(i32.add (i32.const ${c0}) (i32.shl (i32.and ${this.sm(pool)} (i32.const 7)) (i32.const 2)))`;
	}
	// a value laundered through unary operators, a conversion or a call return
	un(pool: readonly string[], depth = 1 + this.rnd(2)): string {
		let x = this.op(pool);
		for (let n = 0; n < depth; n++)
			x = this.pick([
				`(i32.popcnt ${x})`,
				`(i32.clz ${x})`,
				`(i32.ctz ${x})`,
				`(i32.eqz ${x})`,
				`(i32.extend8_s ${x})`,
				`(i32.extend16_s ${x})`,
				`(i32.wrap_i64 (i64.extend_i32_u ${x}))`,
				`(i32.wrap_i64 (i64.shr_u (i64.extend_i32_s ${x}) (i64.const ${this.pick([1, 4, 6])})))`,
				`(i32.trunc_sat_f64_u (f64.convert_i32_u ${x}))`,
				`(i32.trunc_sat_f64_s (f64.mul (f64.convert_i32_s ${x}) (f64.const 0.5)))`,
				`(call $hp ${x})`,
				`(call $cntf ${x})`,
				`(call $adv ${x})`
			]);
		return x;
	}
	slot = (e: string) => `(i32.store offset=${this.k()} (local.get $slot) ${e})`;
	sum = '(local.get $sum)';

	insert(name: string): Ins {
		const u = this.uid++;
		const pool = (n: string) => POOLS[n]!;
		switch (name) {
			case 'addr-t':
			case 'addr-o':
			case 'addr-n':
			case 'addr-copy':
			case 'addr-mix': {
				const ps = pool(name.slice(5));
				const op = () => this.op(ps);
				const c0 = this.cell();
				const a = this.addr(ps, c0);
				const off = `(i32.shl ${this.sm(ps)} (i32.const 2))`;
				switch (this.rnd(10)) {
					case 6:
						return {
							text: `(i32.store (i32.add (local.get $slot) ${off}) ${this.sum})`
						};
					case 7:
						return {
							text: `(memory.fill (i32.add (local.get $slot) ${off}) (i32.const 9) (i32.const 4))`
						};
					case 8:
						return {
							text: this.slot(
								`(i32.load8_u (i32.add (local.get $${this.pick(['rp', 'p', 'arena', 'aux'])}) ${this.sm(ps)}))`
							)
						};
					case 9:
						return {
							text: `(memory.copy (i32.add (local.get $slot) ${off}) (local.get $p) (i32.const 4))`
						};
					case 0:
						return {
							text: `(i32.store ${a} ${this.sum})\n${this.slot(`(i32.load ${a})`)}`
						};
					case 1:
						return {
							text: `(i32.store ${a} ${this.sum})\n${this.slot(`(i32.load (i32.const ${c0}))`)}`
						};
					case 2:
						return {
							text: this.slot(
								this.pick([
									op(),
									`(i32.add ${op()} ${op()})`,
									`(i32.sub ${op()} (local.get $slot))`
								])
							)
						};
					case 3:
						return {
							text: `(if (i32.eqz (i32.and ${op()} (i32.const ${this.pick([1, 2, 16, 32])}))) (then ${this.slot('(i32.const 7)')}) (else ${this.slot('(i32.const 9)')}))`
						};
					case 4:
						return {
							text: this.slot(
								this.pick([
									`(i32.load8_u ${op()})`,
									`(i32.load (i32.add ${op()} (i32.const 4)))`,
									`(i32.load8_u (i32.load ${op()}))`
								])
							)
						};
					default:
						return {
							text: `(i32.store (i32.add ${op()} (i32.const ${this.pick([4096, 4, 8, 0])})) ${this.sum})`
						};
				}
			}
			case 'fill-size': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix']));
				return {
					text: this.pick([
						`(memory.fill (i32.add (local.get $slot) (i32.const 8)) (i32.const 7) (i32.and ${this.op(ps)} (i32.const 7)))`,
						`(memory.fill (i32.add (local.get $slot) (i32.shl ${this.sm(ps)} (i32.const 2))) (i32.const 9) (i32.const 4))`,
						`(memory.fill ${this.addr(ps)} (i32.const 3) (i32.const 4))`,
						`(memory.fill (i32.add (local.get $slot) (i32.const 8)) ${this.op(ps)} (i32.const 8))`
					])
				};
			}
			case 'copy-size': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix']));
				return {
					text: this.pick([
						`(memory.copy (i32.add (local.get $slot) (i32.const 8)) (local.get $slot) (i32.and ${this.op(ps)} (i32.const 3)))`,
						`(memory.copy (i32.add (local.get $slot) (i32.const 16)) ${this.addr(ps)} (i32.const 4))`,
						`(memory.copy ${this.addr(ps)} (local.get $slot) (i32.const 4))`,
						`(memory.copy (i32.add (local.get $slot) (i32.const 8)) ${this.op(ps)} (i32.const 4))`
					])
				};
			}
			case 'mem-init': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix']));
				return {
					text: this.pick([
						`(memory.init $pd (i32.add (local.get $slot) (i32.const 8)) (i32.and ${this.sm(ps)} (i32.const 3)) (i32.and ${this.sm(ps)} (i32.const 3)))`,
						`(memory.init $pd (i32.add (local.get $slot) (i32.const 8)) (i32.const 0) (i32.const 4))`,
						`(memory.init $pd (i32.add (local.get $slot) (i32.const 8)) (i32.const 0) (i32.and ${this.op(ps)} (i32.const 7)))`
					])
				};
			}
			case 'drop-init':
				return {
					text: `(memory.init $pd (i32.add (local.get $slot) (i32.const 8)) (i32.const 0) (i32.const 4))\n(data.drop $pd)`
				};
			case 'bound-loop': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix']));
				const c = this.cell();
				const cover = this.chance(0.6)
					? `(i32.store (i32.const ${c}) (i32.const 0))\n`
					: '';
				return {
					text: `${cover}(local.set $k (i32.const 0))
(block $lb${u} (loop $ll${u}
(br_if $lb${u} (i32.ge_u (local.get $k) (i32.and ${this.sm(ps)} (i32.const 3))))
(i32.store (i32.const ${c}) (i32.add (local.get $k) ${this.sum}))
(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $ll${u})))
${this.slot(`(i32.load (i32.const ${c}))`)}`
				};
			}
			case 'select': {
				const ps = pool('mix');
				const sel = `(select ${this.op(ps)} ${this.op(ps)} (i32.and ${this.op(ps)} (i32.const 1)))`;
				return {
					text: this.pick([
						this.slot(sel),
						`(local.set $a ${sel})\n${this.slot('(local.get $a)')}`,
						`(i32.store (i32.add (i32.const ${this.cell()}) (i32.shl (i32.and ${sel} (i32.const 7)) (i32.const 2))) ${this.sum})`,
						`(memory.fill (i32.add (local.get $slot) (i32.const 8)) (i32.const 5) (i32.and ${sel} (i32.const 7)))`
					])
				};
			}
			case 'loaded-addr': {
				const ps = pool('mix');
				const c = this.cell();
				return {
					text: `(i32.store (i32.const ${c}) (i32.add ${this.sum} ${this.sm(ps)}))
${this.slot(`(i32.load (i32.add (i32.const 4232) (i32.shl (i32.and (i32.load (i32.const ${c})) (i32.const 7)) (i32.const 2))))`)}`
				};
			}
			case 'indirect': {
				const ps = pool('mix');
				const idx = this.pick([
					`(i32.const ${this.rnd(4)})`,
					`(i32.and ${this.op(ps)} (i32.const 3))`,
					`(i32.and ${this.op(pool('t'))} (i32.const 3))`,
					`(i32.and (i32.shr_u ${this.op(ps)} (i32.const 4)) (i32.const 3))`,
					`(i32.and (i32.load8_u (local.get $p)) (i32.const 3))`
				]);
				return {
					text: this.slot(
						`(call_indirect $tb (type $ft) (i32.add ${this.sum} (i32.const 1)) ${idx})`
					)
				};
			}
			case 'table-state': {
				const call = this.slot(`(call_indirect $tb (type $ft) ${this.sum} (i32.const 2))`);
				return {
					text: this.pick([
						`${call}\n(table.set $tb (i32.const 2) (ref.func $hp))`,
						`(drop (table.grow $tb (ref.func $hp) (i32.const 1)))\n${this.slot('(table.size $tb)')}`,
						`${call}\n(table.fill $tb (i32.const 2) (ref.func $hp) (i32.const 1))`,
						`${call}\n(table.copy $tb $tb (i32.const 2) (i32.const 0) (i32.const 1))`,
						this.slot('(i32.eqz (ref.is_null (table.get $tb (i32.const 2))))'),
						this.slot('(table.size $tb)')
					])
				};
			}
			case 'pingpong': {
				const depth = this.pick([
					'(i32.and (local.get $len) (i32.const 3))',
					`(i32.and ${this.op(pool('mix'))} (i32.const 3))`,
					'(i32.const 3)',
					'(i32.and (i32.load8_u (local.get $p)) (i32.const 3))'
				]);
				return { text: this.slot(`(call $ping ${depth})`) };
			}
			case 'grow':
				return {
					text: this.pick([
						'(drop (memory.grow (i32.const 1)))',
						this.slot('(memory.grow (i32.const 1))'),
						`(drop (memory.grow (i32.const 1)))\n${this.slot('(memory.size)')}`,
						`(drop (memory.grow (i32.const 0)))\n${this.slot('(memory.size)')}`,
						'(drop (call $gr))'
					])
				};
			case 'trap-first':
				return {
					front: true,
					text: `(if (i32.gt_u (i32.load8_u (local.get $p)) (i32.const ${this.pick([128, 200, 250])})) (then (unreachable)))`
				};
			case 'div-zero':
				return {
					text: this.slot(
						`(i32.div_u (i32.const 100) (i32.and (i32.load8_u (i32.add (local.get $p) (i32.const ${this.rnd(3)}))) (i32.const ${this.pick([1, 3, 7, 255])})))`
					)
				};
			case 'oob-load':
				return {
					text: this.slot(
						`(i32.load (i32.shl ${this.op(
							this.pick([
								['idx', 'i', 'cnt'],
								['t', 'o', 'n'],
								['bt', 'bo']
							])
						)} (i32.const ${this.pick([8, 10, 12, 13])})))`
					)
				};
			case 'alias':
				return {
					text: this.pick([
						`(i32.store offset=4 (local.get $rp) ${this.sum})`,
						`(i32.store (i32.add (local.get $rp) (i32.const 4096)) ${this.sum})`,
						`(i32.store (i32.sub (local.get $slot) (i32.const 64)) ${this.sum})`,
						this.slot('(i32.load offset=16 (local.get $rp))'),
						this.slot('(i32.load (i32.sub (local.get $rp) (i32.const 16)))')
					])
				};
			case 'atomic': {
				const c = 4264 + this.rnd(8) * 4;
				return {
					text: this.pick([
						`(i32.atomic.store (i32.const ${c}) ${this.sum})\n${this.slot(`(i32.load (i32.const ${c}))`)}`,
						this.slot(`(i32.atomic.rmw.add (i32.const ${c}) (i32.const 1))`),
						this.slot(
							`(i32.atomic.rmw.cmpxchg (i32.const ${c}) (i32.const 0) ${this.sum})`
						),
						this.slot(`(memory.atomic.notify (i32.const ${c}) (i32.const 1))`),
						`(i32.atomic.store (i32.const ${c}) ${this.sum})\n${this.slot(`(i32.atomic.load (i32.const ${c}))`)}`,
						`(i32.store (i32.const ${c}) ${this.sum})\n${this.slot(`(i32.atomic.rmw.xchg (i32.const ${c}) (i32.const 5))`)}`
					])
				};
			}
			case 'sp-saved': {
				const open =
					'(local.set $sv (global.get $sp))\n(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))';
				const use = `(i32.store (global.get $sp) ${this.sum})\n${this.slot('(i32.load (global.get $sp))')}`;
				return {
					text: this.pick([
						`${open}\n${use}\n(global.set $sp (local.get $sv))`,
						`${open}\n${use}\n(global.set $sp (i32.add (local.get $sv) (i32.const 16)))`,
						`${open}\n${use}\n(global.set $sp (i32.sub (local.get $sv) (i32.const 16)))`,
						`(local.set $sv (global.get $sp))\n${this.slot('(local.get $sv)')}`,
						`${open}\n${use}\n(local.set $sv (i32.load8_u (local.get $p)))\n(global.set $sp (i32.add (global.get $sp) (i32.const 16)))`,
						`(local.set $sv (global.get $sp))\n(i32.store (i32.sub (local.get $sv) (i32.const 8)) ${this.sum})\n${this.slot('(i32.load (i32.sub (local.get $sv) (i32.const 8)))')}`
					])
				};
			}
			case 'global':
				return this.pick<Ins>([
					{
						pre: '(global.set $gt (local.get $t))',
						text: this.slot('(i32.load8_u (i32.load (global.get $gt)))')
					},
					{
						text: `(global.set $gc (i32.add (global.get $gc) (i32.const 1)))\n${this.slot('(global.get $gc)')}`
					},
					{ text: `(i32.store (global.get $gk) ${this.sum})` },
					{ pre: '(global.set $gt (local.get $n))', text: this.slot('(global.get $gt)') },
					{ text: `${this.slot('(global.get $gt)')}\n(global.set $gt ${this.sum})` },
					{
						pre: '(global.set $gt (i32.const 4232))',
						text: `(i32.store (global.get $gt) ${this.sum})\n${this.slot('(i32.load (global.get $gt))')}`
					}
				]);
			case 'pre-carry':
				return {
					pre: this.pick([
						'(i32.store (i32.const 4328) (i32.const 5))',
						'(i32.store (i32.const 4328) (i32.const 5))',
						'(i64.store (i32.const 4328) (i64.const 5))',
						'(memory.fill (i32.const 4328) (i32.const 5) (i32.const 8))'
					]),
					text: this.pick([
						this.slot('(i32.load (i32.const 4328))'),
						this.slot('(i32.load8_u (i32.const 4328))'),
						`${this.slot('(i32.load (i32.const 4328))')}\n(i32.store (i32.const 4328) (i32.add (i32.load (i32.const 4328)) (i32.const 1)))`,
						`${this.slot('(i32.load (i32.const 4328))')}\n(i32.store (i32.const 4328) (i32.const 7))`,
						`${this.slot('(i32.load (i32.const 4328))')}\n(i32.store8 (i32.const 4328) ${this.sum})`,
						`${this.slot('(i32.load (i32.const 4328))')}\n(if ${this.data()} (then (i32.store (i32.const 4328) (i32.const 9))))`,
						`${this.slot('(i32.load8_u (i32.const 4329))')}\n(i32.store (i32.const 4328) ${this.sum})`
					])
				};
			case 'un-offset': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix', 'mix']));
				const off = `(i32.shl (i32.and ${this.un(ps)} (i32.const 7)) (i32.const 2))`;
				const at = `(i32.add (local.get $${this.pick(['slot', 'slot', 'rp'])}) ${off})`;
				return {
					text: this.pick([
						`(i32.store ${at} ${this.sum})`,
						`(memory.fill ${at} (i32.const 9) (i32.const 4))`,
						this.slot(`(i32.load8_u ${at})`),
						`(memory.copy ${at} (local.get $p) (i32.const 4))`,
						`(i32.store (i32.add (i32.const ${this.cell()}) ${off}) ${this.sum})`
					])
				};
			}
			case 'un-size': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix', 'mix']));
				const sz = `(i32.and ${this.un(ps)} (i32.const ${this.pick([3, 7])}))`;
				return {
					text: this.pick([
						`(memory.fill (i32.add (local.get $slot) (i32.const 8)) (i32.const 7) ${sz})`,
						`(memory.copy (i32.add (local.get $slot) (i32.const 16)) (local.get $slot) ${sz})`,
						`(memory.init $pd (i32.add (local.get $slot) (i32.const 8)) (i32.const 0) ${sz})`
					])
				};
			}
			case 'un-value': {
				const ps = pool(this.pick(['t', 'o', 'n', 'copy', 'mix', 'mix']));
				return {
					text: this.pick([
						this.slot(this.un(ps)),
						`(memory.fill (i32.add (local.get $slot) (i32.const 8)) ${this.un(ps)} (i32.const 4))`,
						`(local.set $a ${this.un(ps)})\n${this.slot('(local.get $a)')}`,
						`(if ${this.un(ps)} (then ${this.slot('(i32.const 7)')}) (else ${this.slot('(i32.const 9)')}))`
					])
				};
			}
			case 'un-bound': {
				const ps = pool(this.pick(['t', 'o', 'n', 'mix', 'mix']));
				const c = this.cell();
				return {
					text: `(i32.store (i32.const ${c}) (i32.const 0))
(local.set $k (i32.const 0))
(block $lb${u} (loop $ll${u}
(br_if $lb${u} (i32.ge_u (local.get $k) (i32.and ${this.un(ps)} (i32.const 3))))
(i32.store (i32.const ${c}) (i32.add (local.get $k) ${this.sum}))
(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $ll${u})))
${this.slot(`(i32.load (i32.const ${c}))`)}`
				};
			}
			case 'un-exit':
				return {
					text: this.pick([
						`(br_if $done ${this.un(pool('mix'))})`,
						`(if ${this.un(pool(this.pick(['t', 'o', 'n', 'mix'])))} (then (br $done)))`
					])
				};
			case 'exit-const':
				return {
					text: this.pick([
						`(br_if $done (i32.ge_u (local.get $i) (i32.const ${3 + this.rnd(5)})))`,
						`(br_if $done (i32.ge_u (local.get $slot) (i32.const ${12288 + 64 * (2 + this.rnd(5))})))`,
						`(if (i32.eq (local.get $idx) (i32.const ${2 + this.rnd(5)})) (then (br $done)))`
					])
				};
			case 'post-carry':
				return {
					text: `(i32.store (i32.const 4344) ${this.sum})`,
					post: '(i32.store (i32.const 4348) (i32.load (i32.const 4344)))'
				};
			case 'post-store':
				return {
					text: '(nop)',
					post: this.pick([
						`(i32.store (i32.const 4340) ${this.sum})`,
						'(i32.store (local.get $o) (i32.const 9))',
						'(i32.store (i32.add (local.get $t) (i32.const 8)) (i32.const 3))',
						'(i32.store (i32.const 4340) (local.get $n))',
						'(i32.store (i32.const 4340) (local.get $i))'
					])
				};
			case 'i64-addr': {
				const ps = pool('mix');
				return {
					text: `(i32.store (i32.wrap_i64 (i64.add (i64.const ${this.cell()}) (i64.shl (i64.extend_i32_u (i32.and ${this.sm(ps)} (i32.const 7))) (i64.const 2)))) ${this.sum})\n${this.slot(`(i32.load (i32.const ${4232}))`)}`
				};
			}
			case 'exit-done':
				return {
					text: this.pick([
						`(br_if $done ${this.data()})`,
						`(if ${this.data()} (then (br $done)))`,
						`(if ${this.data()} (then (br $done)) (else (nop)))`
					])
				};
			case 'exit-inner':
				return {
					text: `(local.set $k (i32.const 0))
(block $xb${u} (loop $xl${u}
(br_if $xb${u} (i32.ge_u (local.get $k) (i32.const 3)))
(br_if $done ${this.data()})
(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $xl${u})))`
				};
			case 'exit-block':
				return {
					text: `(block $xs${u} (br_if $xs${u} ${this.data()}) (br $done))`
				};
			case 'exit-table':
				return {
					text: `(block $xt${u} (br_table $xt${u} $done (i32.and ${this.pick([this.data(), this.op(pool('t'))])} (i32.const 1))))`
				};
			case 'continue-data':
				return {
					text: `(br_if $each ${this.data()})\n(i32.store (i32.const ${this.cell()}) ${this.sum})`
				};
			case 'exit-return':
				return {
					text: this.pick([
						`(if ${this.data()} (then (return)))`,
						`(br_if $rb ${this.data()})\n(return)`
					])
				};
			default:
				throw new Error('unknown insert ' + name);
		}
	}
}

// which inserts need loop labels in scope, and which need the continue-style frame
const NEEDS_LABELS = new Set([
	'exit-done',
	'exit-inner',
	'exit-block',
	'exit-table',
	'exit-const',
	'un-exit'
]);
const NEEDS_CONTINUE = new Set(['continue-data']);
const INLINE_ONLY = new Set(['post-carry', 'post-store']);
export const INSERTS = [
	'addr-t',
	'addr-o',
	'addr-n',
	'addr-copy',
	'addr-mix',
	'fill-size',
	'copy-size',
	'mem-init',
	'drop-init',
	'bound-loop',
	'select',
	'loaded-addr',
	'indirect',
	'table-state',
	'pingpong',
	'grow',
	'trap-first',
	'div-zero',
	'oob-load',
	'alias',
	'atomic',
	'sp-saved',
	'global',
	'pre-carry',
	'post-carry',
	'post-store',
	'i64-addr',
	'exit-done',
	'exit-inner',
	'exit-block',
	'exit-table',
	'exit-const',
	'un-offset',
	'un-size',
	'un-value',
	'un-bound',
	'un-exit',
	'continue-data',
	'exit-return'
];

const LIMITS = [
	'(local.get $n)',
	'(local.get $n)',
	'(local.get $n)',
	'(local.get $n)',
	'(i32.sub (local.get $n) (i32.const 1))',
	'(select (local.get $n) (i32.const 5) (i32.lt_u (local.get $n) (i32.const 5)))',
	'(i32.shr_u (i32.add (local.get $n) (i32.const 1)) (i32.const 1))',
	'(i32.add (local.get $n) (i32.and (local.get $t) (i32.const 0)))',
	'(i32.and (i32.add (local.get $n) (i32.const 7)) (i32.const 15))',
	'(i32.const 6)',
	'(i32.const 4)',
	'(i32.add (local.get $n) (i32.const 1))',
	'(i32.wrap_i64 (i64.extend_i32_u (local.get $n)))',
	'(i32.trunc_sat_f64_u (f64.convert_i32_u (local.get $n)))',
	'(i32.add (i32.popcnt (local.get $n)) (i32.const 7))',
	'(i32.sub (i32.clz (local.get $n)) (i32.const 28))',
	'(call $hp (i32.const 0))'
];
const COUNT_CALLS = [
	'(call $cntf (local.get $n))',
	'(call $cntf (local.get $n))',
	'(call $cnth (local.get $n))',
	'(call $cnts (local.get $n))',
	'(call $cntw (local.get $n))'
];

const R = '(local.get $rp)';
const N_I = '(i32.lt_u (local.get $i) (local.get $n))';
const TAILS_TOP = (d: string): [string, boolean][] => [
	['(br $each)', false],
	[`(if ${N_I} (then (br $each)) (else (br $done)))`, false],
	[`(if ${N_I} (then (br $each)))`, false],
	[`(br_if $each ${N_I})`, false],
	['(br_table $each $done (i32.ge_u (local.get $i) (local.get $n)))', false],
	[`(block $s (br_if $s (i32.ge_u (local.get $i) (local.get $n))) (br $each))`, false],
	[`(if ${d} (then (br $each)))`, true],
	[`(if ${d} (then (br $each)) (else (br $done)))`, true],
	[`(if ${d} (then (nop)) (else (br $each)))`, true],
	[`(br_if $each ${d})`, true],
	[`(block $s (br_if $s ${d}) (br $each))`, true],
	[`(br_table $each $done (i32.and ${d} (i32.const 1)))`, true],
	['(br_table $done $each (i32.and (local.get $t) (i32.const 16)))', true],
	[`(if ${N_I} (then (if ${d} (then (br $done)) (else (br $each)))) (else (br $done)))`, true],
	[`(if ${d} (then (if ${N_I} (then (br $each)))) (else (br $each)))`, true]
];
const TAILS_BOTTOM = (d: string): [string, boolean][] => [
	[`(br_if $each ${N_I})`, false],
	[`(if ${N_I} (then (br $each)))`, false],
	[`(if ${N_I} (then (br $each)) (else (br $done)))`, false],
	['(br_table $each $done (i32.ge_u (local.get $i) (local.get $n)))', false],
	[`(br_if $each (i32.and ${N_I} (i32.ne (i32.load8_u (i32.load ${R})) (i32.const 255))))`, true],
	[`(br_if $each ${d})`, true],
	[`(if ${d} (then (br $each)))`, true],
	[`(block $s (br_if $s ${d}) (br_if $each ${N_I}))`, true]
];
const TAILS_DOWN = (d: string): [string, boolean][] => [
	['(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1))))', false],
	['(if (local.tee $n (i32.sub (local.get $n) (i32.const 1))) (then (br $each)))', false],
	['(local.set $n (i32.sub (local.get $n) (i32.const 1))) (br_if $each (local.get $n))', false],
	[
		`(br_if $each (i32.and (local.tee $n (i32.sub (local.get $n) (i32.const 1))) (i32.ne (i32.load8_u (i32.load ${R})) (i32.const 255))))`,
		true
	],
	[
		`(if (local.tee $n (i32.sub (local.get $n) (i32.const 1))) (then (if ${d} (then (br $each)))))`,
		true
	]
];
const STRIDES_T: [string, boolean][] = [
	[STRIDE_T, false],
	[STRIDE_T, false],
	['(i32.add (local.get $t) (i32.load8_u (i32.const 20544)))', false],
	['(call $adv (local.get $t))', false],
	[
		'(i32.add (local.get $t) (i32.shl (i32.const 1) (i32.add (i32.const 4) (i32.eqz (local.get $n)))))',
		false
	],
	[
		'(i32.add (local.get $t) (i32.add (i32.const 16) (i32.shl (i32.shr_u (local.get $n) (i32.const 8)) (i32.const 4))))',
		false
	],
	['(i32.add (local.get $t) (i32.const 8))', true],
	['(i32.add (local.get $t) (i32.const 32))', true],
	['(i32.add (local.get $t) (i32.load8_u (i32.const 20545)))', true],
	['(call $adv8 (local.get $t))', true],
	['(call $advw (local.get $t))', true],
	[
		'(i32.add (local.get $t) (i32.add (i32.const 8) (i32.shl (i32.and (local.get $n) (i32.const 1)) (i32.const 3))))',
		true
	]
];
const STRIDES_O: [string, boolean][] = [
	[STRIDE_O, false],
	[STRIDE_O, false],
	['(i32.add (local.get $o) (i32.load8_u (i32.const 20546)))', false],
	[
		'(i32.add (local.get $o) (i32.shl (i32.const 1) (i32.add (i32.const 6) (i32.eqz (local.get $n)))))',
		false
	],
	['(i32.add (local.get $o) (i32.const 32))', true],
	['(i32.add (local.get $o) (i32.const 128))', true],
	['(i32.add (local.get $o) (i32.load8_u (i32.const 20547)))', true]
];
const REPEATS = [
	'(i32.const 2)',
	'(i32.const 3)',
	'(i32.add (i32.and (local.get $n) (i32.const 1)) (i32.const 1))',
	'(i32.add (i32.and (i32.shr_u (local.get $t) (i32.const 4)) (i32.const 1)) (i32.const 1))'
];

const wpick = <T>(g: G, list: [T, number][]): T => {
	const total = list.reduce((s, [, w]) => s + w, 0);
	let r = g.next() * total;
	for (const [v, w] of list) {
		r -= w;
		if (r < 0) return v;
	}
	return list[0]![0];
};

export function plan3(seed: number): Plan3 {
	const head = mulberry(seed * 2654435761 + 0x51ed270b);
	const roll = head();
	const mode: Plan3['mode'] = roll < 0.35 ? 'safe' : roll < 0.75 ? 'single' : 'free';
	const g0 = new G(seed ^ 0x1234abcd);
	const frame = wpick(g0, FRAMES);
	const recursive = frame.startsWith('rec');
	const viaCallee =
		frame === 'rec-mutual' || (!recursive && g0.chance(frame === 'countdown' ? 0.5 : 0.25));
	const wrap = !recursive && g0.chance(0.06);
	const labels = !recursive && !viaCallee && frame !== 'peeled-last';
	const g = new G(seed);
	let hostile = false;
	const hostileOk = mode === 'single' ? g.chance(0.3) : mode === 'free' ? g.chance(0.5) : false;
	const pickHostile = <T>(list: [T, boolean][]): T => {
		const pool = list.filter(([, h]) => h === hostileOk);
		const [v, h] = g.pick(pool.length ? pool : list);
		hostile ||= h;
		return v;
	};
	// the tail conditions read the current record pointer so a callee loop can use them too
	const d = g.pick(DATAS)('(i32.load (local.get $rp))');
	let tail = '';
	if (frame === 'tail') tail = pickHostile(TAILS_TOP(d));
	else if (frame === 'bottom' && g.chance(0.6)) tail = pickHostile(TAILS_BOTTOM(d));
	else if (frame === 'ptr' && g.chance(0.4))
		tail = pickHostile(TAILS_TOP(d).slice(0, 6) as [string, boolean][]);
	else if ((frame === 'countdown' || frame === 'stride') && g.chance(0.5))
		tail = pickHostile(TAILS_DOWN(g.pick(DATAS)('(i32.load (local.get $t))')));
	let limit = '(local.get $n)';
	if (frame === 'count-call')
		limit = hostileOk ? g.pick(COUNT_CALLS) : '(call $cntf (local.get $n))';
	else if ((frame === 'top' || frame === 'tail') && hostileOk && g.chance(0.4))
		limit = g.pick(LIMITS);
	hostile ||= limit !== '(local.get $n)' && limit !== '(call $cntf (local.get $n))';
	let limitB = '(local.get $n)';
	if (frame === 'two-loops' && hostileOk && g.chance(0.5)) {
		limitB = g.pick([...COUNT_CALLS, '(i32.sub (local.get $n) (i32.const 1))']);
		hostile = true;
	}
	let strideT = STRIDE_T;
	let strideO = STRIDE_O;
	let strideOdd = false;
	if (['stride', 'countdown', 'ptr', 'peeled'].includes(frame)) {
		const allowed = (l: [string, boolean][]) =>
			frame === 'stride' && mode !== 'safe' ? l : l.filter(([, odd]) => !odd);
		const st = g.chance(0.5) ? STRIDES_T[0]! : g.pick(allowed(STRIDES_T));
		const so = g.chance(0.5) ? STRIDES_O[0]! : g.pick(allowed(STRIDES_O));
		strideT = st[0];
		strideO = so[0];
		strideOdd = st[1] || so[1];
	}
	const repeat = g.pick(REPEATS);
	const carry = frame === 'two-loops' && g.chance(0.6);

	// body statements: a round 2 plan with no attack, minus host calls and traps unless kept
	let base: Plan | undefined;
	for (let k = 0; k < 24 && !base; k++) {
		const c = plan2(seed * 31 + k * 977 + 1);
		if (c.attacks.length === 0) base = c;
	}
	const keepHost = g.chance(0.08);
	const keepTrap = g.chance(0.25);
	let statements = (base?.statements ?? []).filter(
		(s) => (keepHost || !s.includes('(call $f')) && (keepTrap || !s.includes('(unreachable)'))
	);
	if (!statements.some((s) => s.includes('$slot')))
		statements.push('(i32.store (local.get $slot) (i32.add (local.get $sum) (i32.const 1)))');
	if (!statements.some((s) => /\(i32\.const 4[0-3]\d\d\)/.test(s)))
		statements.unshift('(i32.store (i32.const 4096) (local.get $sum))');
	const tags: string[] = statements.map(() => 'base');
	const pre: string[] = [];
	const post: string[] = [];
	const inserts: string[] = [];
	const count = mode === 'safe' ? 0 : mode === 'single' ? (hostile ? 0 : 1) : 1 + g.rnd(3);
	for (let n = 0; n < count; n++) {
		let name = g.pick(INSERTS);
		for (let tries = 0; tries < 12; tries++) {
			const bad =
				(NEEDS_LABELS.has(name) && !labels) ||
				(NEEDS_CONTINUE.has(name) &&
					!(labels && (frame === 'continue' || frame === 'reverse'))) ||
				(INLINE_ONLY.has(name) && recursive);
			if (!bad) break;
			name = g.pick(INSERTS);
		}
		if (
			(NEEDS_LABELS.has(name) && !labels) ||
			(NEEDS_CONTINUE.has(name) &&
				!(labels && (frame === 'continue' || frame === 'reverse'))) ||
			(INLINE_ONLY.has(name) && recursive)
		)
			name = 'addr-mix';
		const ins = g.insert(name);
		inserts.push(name);
		if (ins.pre) pre.push(ins.pre);
		if (ins.post) post.push(ins.post);
		if (ins.front) {
			statements.unshift(ins.text);
			tags.unshift(name);
		} else {
			const at = g.rnd(statements.length + 1);
			statements.splice(at, 0, ins.text);
			tags.splice(at, 0, name);
		}
	}
	const flags: Plan['flags'] = {
		stack: statements.some((s) => s.includes('$sp')),
		global: false,
		indirect: 'none',
		host: keepHost && statements.some((s) => s.includes('(call $f')),
		table: false
	};
	return {
		seed,
		mode,
		frame,
		wrap,
		viaCallee,
		hostile,
		tail,
		limit,
		limitB,
		repeat,
		carry,
		strideT,
		strideO,
		strideOdd,
		statements,
		tags,
		pre,
		post,
		inserts,
		flags,
		constTable: base?.constTable ?? []
	};
}

// the same plan with the record-size strides restored
export const stripStride = (p: Plan3): Plan3 => ({
	...p,
	strideT: STRIDE_T,
	strideO: STRIDE_O,
	strideOdd: false
});

// #region wat

const LOCAL_DECLS =
	'(local $p i32) (local $len i32) (local $aux i32) (local $arena i32) (local $slot i32) (local $sum i32) (local $k i32) (local $a i32) (local $b i32) (local $c i32) (local $d i32) (local $e i32) (local $q i32) (local $q2 i32) (local $w i64) (local $fl f64)';
const EXTRA_LOCALS =
	'(local $end i32) (local $j i32) (local $ii i64) (local $pp i64) (local $rep i32) (local $sv i32)';
const FRAME_LOCALS = '(local $i i32) (local $idx i32) (local $rp i32)';
const BASE_LOCALS = '(local $bt i32) (local $bo i32) (local $cnt i32)';
const SETUP =
	'(local.set $bt (local.get $t)) (local.set $bo (local.get $o)) (local.set $cnt (local.get $n))';

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

const INC = '(local.set $i (i32.add (local.get $i) (i32.const 1)))';
const IDXRP = `(local.set $idx (local.get $i))
(local.set $rp (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4))))`;
const SLOT_I = '(i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6)))';
const test = (limit: string) => `(br_if $done (i32.ge_u (local.get $i) ${limit}))`;

const CARRY_W = '(i32.store (i32.const 4356) (local.get $sum))';
const CARRY_R = '(i32.store offset=60 (local.get $slot) (i32.load (i32.const 4356)))';

const record = (p: Plan3, rp: string, slot: string, idx: string, i: string, fn = '$rec') => {
	if (p.viaCallee)
		return `(call ${fn} ${rp} ${slot} ${idx} (local.get $bt) (local.get $bo) (local.get $cnt) (local.get $t) (local.get $o) (local.get $n) ${i})`;
	return `${prologue(rp, slot)}\n(block $rb\n${p.statements.join('\n')})`;
};

// the loop of the entry, written for a function that has $t, $n, $o and the frame locals
function loopOf(p: Plan3): string {
	const rec = (rp: string, slot: string, idx = '(local.get $idx)', i = '(local.get $i)') =>
		record(p, rp, slot, idx, i);
	switch (p.frame) {
		case 'top':
		case 'tail':
		case 'count-call':
			return `(block $done (loop $each
${test(p.limit)}
${IDXRP}
${rec(R, SLOT_I)}
${INC}
${p.tail || '(br $each)'}))`;
		case 'bottom':
			return `(block $done (br_if $done (i32.eqz (local.get $n))) (loop $each
${IDXRP}
${rec(R, SLOT_I)}
${INC}
${p.tail || `(br_if $each ${N_I})`}))`;
		case 'ptr':
			return `(local.set $end (i32.add (local.get $t) (i32.shl (local.get $n) (i32.const 4))))
(block $done (loop $each
(br_if $done (i32.ge_u (local.get $t) (local.get $end)))
(local.set $idx (i32.shr_u (i32.sub (local.get $end) (local.get $t)) (i32.const 4)))
(local.set $rp (local.get $t))
${rec(R, '(local.get $o)')}
(local.set $t ${p.strideT}) (local.set $o ${p.strideO})
${p.tail || '(br $each)'}))`;
		case 'countdown':
		case 'stride':
			return `(block $done (br_if $done (i32.eqz (local.get $n))) (loop $each
${rec('(local.get $t)', '(local.get $o)', '(local.get $n)', '(local.get $i)')}
(local.set $t ${p.strideT}) (local.set $o ${p.strideO})
${p.tail || '(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1))))'}))`;
		case 'i64-mix':
			return `(block $done (loop $each
(br_if $done (i64.ge_u (i64.extend_i32_u (local.get $i)) (i64.extend_i32_u (local.get $n))))
(local.set $idx (local.get $i))
(local.set $rp (i32.wrap_i64 (i64.add (i64.extend_i32_u (local.get $t)) (i64.shl (i64.extend_i32_u (local.get $i)) (i64.const 4)))))
${rec(R, SLOT_I)}
${INC}
(br $each)))`;
		case 'continue':
			return `(block $done (loop $each
${test(p.limit)}
${IDXRP}
${INC}
${rec(R, '(i32.add (local.get $o) (i32.shl (i32.sub (local.get $i) (i32.const 1)) (i32.const 6)))', '(local.get $idx)', '(i32.sub (local.get $i) (i32.const 1))')}
(br $each)))`;
		case 'outer-repeat':
			return `(local.set $rep (i32.const 0))
(loop $outer
(local.set $i (i32.const 0))
(block $done (loop $each
${test('(local.get $n)')}
${IDXRP}
${rec(R, SLOT_I)}
${INC}
(br $each)))
(local.set $rep (i32.add (local.get $rep) (i32.const 1)))
(br_if $outer (i32.lt_u (local.get $rep) ${p.repeat})))`;
		case 'two-loops': {
			const second = p.carry
				? record(
						{ ...p, statements: [CARRY_R] },
						R,
						SLOT_I,
						'(local.get $idx)',
						'(local.get $i)',
						'$rec2'
					)
				: rec(R, SLOT_I);
			const first = p.carry
				? record(
						{ ...p, statements: [...p.statements, CARRY_W] },
						R,
						SLOT_I,
						'(local.get $idx)',
						'(local.get $i)'
					)
				: rec(R, SLOT_I);
			return `(block $done (loop $each
${test('(local.get $n)')}
${IDXRP}
${first}
${INC}
(br $each)))
(local.set $i (i32.const 0))
(block $done (loop $each
${test(p.limitB)}
${IDXRP}
${second}
${INC}
(br $each)))`;
		}
		case 'reverse':
			return `(local.set $i (local.get $n))
(block $done (loop $each
(br_if $done (i32.eqz (local.get $i)))
(local.set $i (i32.sub (local.get $i) (i32.const 1)))
${IDXRP}
${rec(R, SLOT_I)}
(br $each)))`;
		case 'down-ptr':
			return `(local.set $end (local.get $t))
(local.set $t (i32.add (local.get $t) (i32.shl (i32.sub (local.get $n) (i32.const 1)) (i32.const 4))))
(local.set $o (i32.add (local.get $o) (i32.shl (i32.sub (local.get $n) (i32.const 1)) (i32.const 6))))
(block $done (loop $each
(local.set $idx (i32.shr_u (i32.sub (local.get $t) (local.get $end)) (i32.const 4)))
(local.set $rp (local.get $t))
${rec(R, '(local.get $o)')}
(br_if $done (i32.eq (local.get $t) (local.get $end)))
(local.set $t (i32.sub (local.get $t) (i32.const 16))) (local.set $o (i32.sub (local.get $o) (i32.const 64)))
(br $each)))`;
		case 'i64':
			return `(local.set $ii (i64.const 0))
(block $done (loop $each
(br_if $done (i64.ge_u (local.get $ii) (i64.extend_i32_u (local.get $n))))
(local.set $i (i32.wrap_i64 (local.get $ii)))
${IDXRP}
${rec(R, SLOT_I)}
(local.set $ii (i64.add (local.get $ii) (i64.const 1))) (br $each)))`;
		case 'i64-ptr':
			return `(local.set $pp (i64.extend_i32_u (local.get $t)))
(local.set $ii (i64.add (local.get $pp) (i64.shl (i64.extend_i32_u (local.get $n)) (i64.const 4))))
(block $done (loop $each
(br_if $done (i64.ge_u (local.get $pp) (local.get $ii)))
(local.set $rp (i32.wrap_i64 (local.get $pp)))
(local.set $idx (i32.shr_u (i32.sub (local.get $rp) (local.get $t)) (i32.const 4)))
${rec(R, SLOT_I.replace('(local.get $i)', '(local.get $idx)'), '(local.get $idx)', '(local.get $idx)')}
(local.set $pp (i64.add (local.get $pp) (i64.const 16))) (br $each)))`;
		case 'peeled':
			return `(block $done
(local.set $idx (i32.const 0)) (local.set $i (i32.const 0))
(local.set $rp (local.get $t))
${rec(R, '(local.get $o)', '(local.get $idx)', '(local.get $i)')}
(local.set $t ${p.strideT}) (local.set $o ${p.strideO}) (local.set $i (i32.const 1))
(loop $each
(br_if $done (i32.ge_u (local.get $i) (local.get $cnt)))
(local.set $idx (local.get $i))
(local.set $rp (local.get $t))
${rec(R, '(local.get $o)')}
${INC}
(local.set $t ${p.strideT}) (local.set $o ${p.strideO})
(br $each)))`;
		case 'peeled-last':
			return `(block $done0 (loop $each0
(br_if $done0 (i32.ge_u (local.get $i) (i32.sub (local.get $n) (i32.const 1))))
${IDXRP}
${rec(R, SLOT_I)}
${INC}
(br $each0)))
(local.set $i (i32.sub (local.get $n) (i32.const 1)))
${IDXRP}
${rec(R, SLOT_I)}`;
		default:
			throw new Error('no loop for ' + p.frame);
	}
}

export function wat3(p: Plan3): string {
	const base: Plan = {
		seed: p.seed,
		mode: 'safe',
		skeleton: 'indexed',
		limit: '(local.get $n)',
		statements: [],
		attacks: [],
		flags: { ...p.flags, table: false, indirect: 'none' },
		constTable: p.constTable
	};
	const full = wat2(base);
	const head = full.slice(0, full.indexOf('(func $bulk'));
	const funcs: string[] = [];
	const stmts = p.statements.join('\n');
	const pre = p.pre.join('\n');
	const post = p.post.join('\n');
	const recursive = p.frame.startsWith('rec');
	const slotOfRec = '(local.get $so)';
	const recFunc = (name: string, body: string) =>
		`(func ${name} (param $rp i32) (param $so i32) (param $idx i32) (param $bt i32) (param $bo i32) (param $cnt i32) (param $t i32) (param $o i32) (param $n i32) (param $i i32)
${LOCAL_DECLS} ${EXTRA_LOCALS}
${prologue('(local.get $rp)', slotOfRec)}
(block $rb\n${body}))`;
	if (p.viaCallee) {
		const carried = p.carry && p.frame === 'two-loops';
		funcs.push(recFunc('$rec', carried ? `${stmts}\n${CARRY_W}` : stmts));
		if (carried) funcs.push(recFunc('$rec2', CARRY_R));
	}
	let bulkBody: string;
	if (recursive) {
		const callNext = `(call ${p.frame === 'rec-mutual' ? '$go2' : '$go'} (i32.add (local.get $t) (i32.const 16)) (i32.sub (local.get $n) (i32.const 1)) (i32.add (local.get $o) (i32.const 64)) (local.get $bt) (local.get $bo) (local.get $cnt))`;
		const callNext2 = callNext.replace('$go2', '$go');
		const recText = record(p, R, '(local.get $o)', '(local.get $idx)', '(local.get $i)');
		const goBody = (next: string) => {
			const work = `(local.set $idx (i32.shr_u (i32.sub (local.get $t) (local.get $bt)) (i32.const 4)))
(local.set $i (local.get $idx))
(local.set $rp (local.get $t))
${recText}`;
			return `(if (i32.eqz (local.get $n)) (then (return)))\n${p.frame === 'rec-post' ? `${next}\n${work}` : `${work}\n${next}`}`;
		};
		const header = (name: string) =>
			`(func ${name} (param $t i32) (param $n i32) (param $o i32) (param $bt i32) (param $bo i32) (param $cnt i32)
${LOCAL_DECLS} ${FRAME_LOCALS} ${EXTRA_LOCALS}`;
		funcs.push(`${header('$go')}\n${goBody(callNext)})`);
		if (p.frame === 'rec-mutual') funcs.push(`${header('$go2')}\n${goBody(callNext2)})`);
		bulkBody = `${SETUP}\n${pre}\n(call $go (local.get $t) (local.get $n) (local.get $o) (local.get $t) (local.get $o) (local.get $n))`;
	} else if (p.wrap) {
		funcs.push(`(func $drive (param $t i32) (param $n i32) (param $o i32)
${LOCAL_DECLS} ${FRAME_LOCALS} ${BASE_LOCALS} ${EXTRA_LOCALS}
${SETUP}\n${pre}\n${loopOf(p)}\n${post})`);
		bulkBody = '(call $drive (local.get $t) (local.get $n) (local.get $o))';
	} else {
		bulkBody = `${SETUP}\n${pre}\n${loopOf(p)}\n${post}`;
	}
	const locals = `${LOCAL_DECLS} ${FRAME_LOCALS} ${BASE_LOCALS} ${EXTRA_LOCALS}`;
	funcs.push(`(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)
${p.wrap ? '' : locals}
${bulkBody})`);
	const all = funcs.join('\n') + stmts + pre + post;
	const helpers: string[] = [];
	const has = (s: string) => all.includes(s);
	if (has('$adv '))
		helpers.push(
			'(func $adv (param $x i32) (result i32) (i32.add (local.get $x) (i32.const 16)))'
		);
	if (has('$adv8'))
		helpers.push(
			'(func $adv8 (param $x i32) (result i32) (i32.add (local.get $x) (i32.const 8)))'
		);
	if (has('$advw'))
		helpers.push(
			'(func $advw (param $x i32) (result i32) (i32.add (local.get $x) (i32.load8_u (i32.const 4300))))'
		);
	if (has('$cntf')) helpers.push('(func $cntf (param $x i32) (result i32) (local.get $x))');
	if (has('$cnth'))
		helpers.push(
			'(func $cnth (param $x i32) (result i32) (i32.and (i32.add (local.get $x) (i32.const 7)) (i32.const 15)))'
		);
	if (has('$cnts'))
		helpers.push(
			'(func $cnts (param $x i32) (result i32) (i32.sub (local.get $x) (i32.shr_u (local.get $x) (i32.const 3))))'
		);
	if (has('$cntw'))
		helpers.push(
			'(func $cntw (param $x i32) (result i32) (i32.add (local.get $x) (i32.shr_u (i32.load8_u (i32.const 4312)) (i32.const 8))))'
		);
	if (has('$tb')) {
		helpers.push(
			'(func $rd (param $x i32) (result i32) (i32.add (local.get $x) (i32.load (i32.const 4312))))'
		);
		helpers.push(
			'(func $wr (param $x i32) (result i32) (i32.store (i32.const 4308) (local.get $x)) (local.get $x))'
		);
		helpers.push('(table $tb 4 funcref) (elem (i32.const 0) $hp $hq $rd $wr)');
	}
	if (has('$ping')) {
		helpers.push(
			'(func $ping (param $k i32) (result i32) (if (i32.eqz (local.get $k)) (then (i32.store (i32.const 4316) (i32.const 1)) (return (i32.load (i32.const 4316))))) (i32.add (call $pong (i32.sub (local.get $k) (i32.const 1))) (i32.const 1)))'
		);
		helpers.push(
			'(func $pong (param $k i32) (result i32) (if (i32.eqz (local.get $k)) (then (return (i32.const 0)))) (i32.add (call $ping (i32.sub (local.get $k) (i32.const 1))) (i32.const 2)))'
		);
	}
	if (has('$gr')) helpers.push('(func $gr (result i32) (memory.grow (i32.const 1)))');
	if (has('$gt')) helpers.push('(global $gt (mut i32) (i32.const 0))');
	if (has('$gc')) helpers.push('(global $gc (mut i32) (i32.const 0))');
	if (has('$gk')) helpers.push('(global $gk i32 (i32.const 4096))');
	if (has('$pd')) helpers.push('(data $pd "\\01\\02\\03\\04\\05\\06\\07\\08")');
	if (has('20544')) helpers.push('(data (i32.const 20544) "\\10\\08\\40\\20")');
	return `${head}\n${helpers.join('\n')}\n${funcs.join('\n')}\n)`;
}

export const build3 = (p: Plan3) => assemble(wat3(p));

// #endregion

// #region truth

const SEEDS = [1, 2, 3, 4, 5, 6];
const MAXPAGES = 40;
const EXTREME = [0, 1, 15, 512, 40000];
const worker = new URL('./ownership-ground-worker.ts', import.meta.url).pathname;
const inStack = (at: number) => at >= STACK_TOP - 4096 && at < STACK_TOP;

const call: SliceCall = {
	table: TABLE,
	n: RECORDS,
	out: OUT,
	slot: 64,
	regions: [
		[TABLE, TABLE + 16 * RECORDS],
		[DATA, DATA + 320 * RECORDS],
		[OUT, OUT + 64 * RECORDS],
		[ARENAS, ARENAS + SLICE * RECORDS]
	]
};
const WRITES: [number, number][] = [
	[OUT, OUT + 64 * RECORDS],
	[ARENAS, ARENAS + SLICE * RECORDS]
];

export type Verdict = 'ok' | 'false' | 'premise' | 'premise-stride' | 'stack' | 'timeout' | 'wild';

export interface Row3 extends Omit<Row, 'verdict' | 'attacks' | 'skeleton'> {
	frame: string;
	wrap: boolean;
	viaCallee: boolean;
	hostile: boolean;
	strideOdd: boolean;
	inserts: string[];
	verdict?: Verdict;
	skeleton: string;
	attacks: string[];
}

async function sliceTruth(bytes: Uint8Array, cert: OwnershipCertificate) {
	let rig;
	try {
		rig = await openSliceRig(bytes, cert, 8, 4, MAXPAGES);
	} catch (error) {
		return { route: 'notRunnable' as const, why: String(error).slice(0, 160) };
	}
	try {
		for (const seed of SEEDS) {
			const img = image(seed);
			const imports = { f: () => {} };
			const want = serialRun(rig, img, call, imports);
			const got = await slicesRun(rig, bootedImage(rig, img, imports), call, {
				writes: WRITES
			});
			// after a trap on both sides the serial run decides the memory, as the repo's routeMatches does
			const bothTrapped = want.error !== undefined && got.error !== undefined;
			const at = bothTrapped ? -1 : firstDiff(want.bytes, got.bytes);
			if (at !== -1 || !sameError(want.error, got.error))
				return {
					route: 'differs' as const,
					why: `slice seed ${seed} byte ${at}`,
					at,
					seed
				};
		}
		return { route: 'equal' as const };
	} finally {
		await closeSliceRig(rig);
	}
}

function groundWorker(bytes: Uint8Array, cert: OwnershipCertificate) {
	const input = JSON.stringify({
		bytes: Buffer.from(bytes).toString('base64'),
		cert: { windows: cert.windows, allocator: undefined },
		seeds: [1, 2, 3],
		lengths: EXTREME
	});
	const run = spawnSync(process.execPath, [worker], {
		input,
		timeout: 90000,
		maxBuffer: 1 << 24
	});
	if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
		return { ok: false, timeout: true, why: 'ground worker timeout' };
	try {
		const out = JSON.parse(run.stdout.toString()) as { ok: boolean; why?: string };
		return { ...out, timeout: false };
	} catch {
		return { ok: false, timeout: false, why: 'worker: ' + run.stderr.toString().slice(0, 200) };
	}
}

export async function evaluate3(p: Plan3, strip = true): Promise<Row3> {
	const row: Row3 = {
		seed: p.seed,
		mode: p.mode,
		skeleton: p.frame + (p.wrap ? '+drive' : '') + (p.viaCallee ? '+callee' : ''),
		attacks: p.inserts,
		frame: p.frame,
		wrap: p.wrap,
		viaCallee: p.viaCallee,
		hostile: p.hostile,
		strideOdd: p.strideOdd,
		inserts: p.inserts,
		outcome: ''
	};
	let bytes: Uint8Array;
	try {
		bytes = build3(p);
	} catch (error) {
		row.outcome = 'invalid';
		row.detail = String((error as Error).message ?? error)
			.replace(/\s+/g, ' ')
			.slice(0, 120);
		return row;
	}
	const cert = certifyOwnership(bytes);
	if (cert.kind === 'refusal') {
		row.outcome = cert.reason;
		row.detail = cert.detail.replace(/\d+/g, 'N').slice(0, 100);
		return row;
	}
	row.outcome = 'certificate';
	row.windows = cert.windows.map((w) => `${w.low}-${w.end}`).join(',');
	const module = new WebAssembly.Module(Uint8Array.from(bytes));
	let priv = true;
	let traps = false;
	let privAt = -1;
	try {
		for (const seed of SEEDS) {
			const img = image(seed);
			const serial = runSerial(module, img);
			const route = runPrivate(module, img, cert.windows);
			traps ||= serial.trapped;
			// a trap discards the private copies and the serial run decides, so only the trap is compared
			const at =
				serial.trapped && route.trapped ? -1 : firstDiff(serial.memory, route.memory);
			if (at !== -1 || serial.trapped !== route.trapped) {
				priv = false;
				privAt = at;
				break;
			}
		}
	} catch (error) {
		row.why = 'private: ' + String(error).slice(0, 100);
		row.verdict = 'timeout';
		return row;
	}
	row.traps = traps;
	row.private = priv ? 'equal' : 'differs';
	let routeDiffers = !priv;
	let why = priv ? '' : `private byte ${privAt}`;
	let at = priv ? -1 : privAt;
	let failSeed = SEEDS[0]!;
	if (cert.wildStores > 0) {
		row.route = 'refused';
	} else {
		const slice = await sliceTruth(bytes, cert);
		row.route = slice.route;
		if (slice.route === 'differs') {
			routeDiffers = true;
			why = why || slice.why!;
			at = at === -1 ? ((slice as { at?: number }).at ?? -1) : at;
			failSeed = (slice as { seed?: number }).seed ?? failSeed;
		}
		if (slice.route === 'notRunnable') row.why = slice.why;
	}
	const ground = groundWorker(bytes, cert);
	row.ground = ground.timeout ? 'timeout' : ground.ok ? 'equal' : 'differs';
	if (!ground.ok) {
		routeDiffers = true;
		why = why || ground.why || 'ground';
	}
	if (ground.timeout) {
		row.verdict = 'timeout';
		row.why = why;
		return row;
	}
	if (!routeDiffers) {
		row.verdict = cert.wildStores > 0 ? 'wild' : 'ok';
		return row;
	}
	row.why = why;
	const own = recordsOwnOf(bytes, failSeed, cert.windows);
	const own2 = own.ok ? recordsOwnOf(bytes, SEEDS[1]!, cert.windows) : own;
	if (!own2.ok) {
		row.verdict = 'premise';
		row.why = `${why}; ${own2.why}`;
	} else if (at >= 0 && inStack(at)) {
		row.verdict = 'stack';
	} else row.verdict = 'false';
	if (strip && p.strideOdd && row.verdict !== 'stack') {
		// the stride is the listed premise only when restoring it removes the difference
		const residual = await evaluate3(stripStride(p), false);
		if (residual.verdict === 'false' || residual.verdict === 'premise') {
			row.verdict = residual.verdict;
			row.why = `${row.why}; residual after stride restored: ${residual.verdict} ${residual.why ?? ''}`;
		} else {
			row.verdict = 'premise-stride';
		}
	}
	return row;
}

// #endregion

// #region runner

const here = new URL(import.meta.url).pathname;
const FREEZE = new URL('../../scratchpad/v11/w2/FREEZE.txt', import.meta.url).pathname;
const SOURCES = [
	'src/ownership.ts',
	'src/ownership-redirect.ts',
	'src/ownership-slices.ts',
	'src/router.ts'
];

export function hashes() {
	const root = new URL('../../', import.meta.url).pathname;
	return SOURCES.map((f) => ({
		file: f,
		sha256: createHash('sha256')
			.update(readFileSync(root + f))
			.digest('hex')
	}));
}

// the batch needs FREEZE.txt and every hash it lists for a file we run on must equal the file's
export function freezeCheck(): { ok: boolean; text: string } {
	if (!existsSync(FREEZE)) return { ok: false, text: 'FREEZE.txt does not exist' };
	const text = readFileSync(FREEZE, 'utf8');
	const now = hashes();
	const bad: string[] = [];
	let seen = 0;
	for (const { file, sha256 } of now) {
		const line = text.split('\n').find((l) => l.includes(file));
		const m = line && /[0-9a-f]{64}/.exec(line);
		if (!m) continue;
		seen++;
		if (m[0] !== sha256) bad.push(`${file} frozen ${m[0]} now ${sha256}`);
	}
	if (seen === 0) return { ok: false, text: 'FREEZE.txt lists none of the four sources' };
	return bad.length
		? { ok: false, text: bad.join('\n') }
		: { ok: true, text: `${seen} hashes equal` };
}

async function chunk(start: number, end: number, out: string) {
	for (let s = start; s < end; s++) {
		const row = await evaluate3(plan3(s));
		appendFileSync(out, JSON.stringify(row) + '\n');
	}
}

function watch(start: number, end: number, out: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [here, 'chunk', String(start), String(end), out], {
			stdio: ['ignore', 'ignore', 'inherit']
		});
		let size = statSync(out).size;
		let idle = 0;
		const timer = setInterval(() => {
			const now = statSync(out).size;
			idle = now === size ? idle + 5 : 0;
			size = now;
			if (idle >= 120) child.kill('SIGKILL');
		}, 5000);
		child.on('exit', (code) => {
			clearInterval(timer);
			resolve(code ?? 1);
		});
	});
}

async function run(start: number, count: number, out: string) {
	if (count > 300) {
		const check = freezeCheck();
		if (!check.ok) {
			console.error('refusing a batch over 300 modules: ' + check.text);
			process.exit(2);
		}
		console.error('freeze: ' + check.text);
	}
	if (!existsSync(out)) writeFileSync(out, '');
	const end = start + count;
	let at = start;
	while (at < end) {
		const to = Math.min(end, at + 200);
		const code = await watch(at, to, out);
		if (code === 0) {
			at = to;
			continue;
		}
		const rows = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
		const last = rows.length ? (JSON.parse(rows[rows.length - 1]!) as Row3).seed : at - 1;
		const hung = Math.max(at, last + 1);
		const hungPlan = plan3(hung);
		appendFileSync(
			out,
			JSON.stringify({
				seed: hung,
				skeleton: hungPlan.frame,
				frame: hungPlan.frame,
				attacks: hungPlan.inserts,
				inserts: hungPlan.inserts,
				outcome: 'timeout',
				verdict: 'timeout'
			}) + '\n'
		);
		at = hung + 1;
	}
}

async function lies(p: Plan3): Promise<boolean> {
	try {
		assemble(wat3(p));
	} catch {
		return false;
	}
	const row = await evaluate3(p);
	return row.outcome === 'certificate' && row.verdict === 'false';
}

async function minimize(seed: number, dir: string) {
	let p = plan3(seed);
	if (!(await lies(p))) {
		console.log('seed does not lie (verdict differs)');
		return;
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const key of ['statements', 'pre', 'post'] as const) {
			for (let i = p[key].length - 1; i >= 0; i--) {
				const next = {
					...p,
					[key]: p[key].filter((_, k) => k !== i),
					tags: key === 'statements' ? p.tags.filter((_, k) => k !== i) : p.tags
				} as Plan3;
				if (await lies(next)) {
					p = next;
					changed = true;
				}
			}
		}
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/seed-${seed}.wat`, wat3(p));
	writeFileSync(`${dir}/seed-${seed}.wasm`, build3(p));
	console.log(wat3(p));
	console.log('statements left', p.statements.length);
}

export function summarize(rows: Row3[]) {
	const count = (f: (r: Row3) => string | undefined) => {
		const m = new Map<string, number>();
		for (const r of rows) {
			const k = f(r);
			if (k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
		}
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const accepted = rows.filter((r) => r.outcome === 'certificate');
	return {
		rows: rows.length,
		accepted: accepted.length,
		verdicts: count((r) => (r.outcome === 'certificate' ? r.verdict : undefined)),
		refusals: count((r) => (r.outcome !== 'certificate' ? r.outcome : undefined)),
		acceptedByFrame: count((r) => (r.outcome === 'certificate' ? r.frame : undefined)),
		rowsByFrame: count((r) => r.frame)
	};
}

function summary(file: string) {
	const rows = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row3);
	console.log(JSON.stringify(summarize(rows)));
	const detail = new Map<string, number>();
	for (const r of rows)
		if (r.outcome !== 'certificate') {
			const k = `${r.outcome}: ${r.detail ?? ''}`;
			detail.set(k, (detail.get(k) ?? 0) + 1);
		}
	for (const [k, v] of [...detail].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v, k);
	for (const r of rows.filter((r) => r.verdict === 'false' || r.verdict === 'wild'))
		console.log(r.verdict?.toUpperCase(), r.seed, r.skeleton, r.inserts.join('+'), r.why);
}

// #endregion

const [command, a, b, c] = process.argv.slice(2);
if (!import.meta.main) void 0;
else if (command === 'run') await run(Number(a), Number(b), c!);
else if (command === 'chunk') await chunk(Number(a), Number(b), c!);
else if (command === 'one') console.log(JSON.stringify(await evaluate3(plan3(Number(a))), null, 1));
else if (command === 'wat') console.log(wat3(plan3(Number(a))));
else if (command === 'minimize') await minimize(Number(a), b!);
else if (command === 'summary') summary(a!);
else if (command === 'freeze') console.log(JSON.stringify(hashes(), null, 1), freezeCheck());
