import { Manifest, mulberry, wat } from './gen-lib.ts';

// families built from hand-written WAT through binaryen:
//   wt-struct: loop and block structure around a fold step: br_table, nested blocks with results,
//     multi-value helper, select with side effects, early-exit loops, unrolled bodies with a tail,
//     helper calls that load or store, mutable and immutable globals, active and overlapping data
//     segments, memory.copy and memory.fill over the input range, two exports, a start function,
//     passive data, a second memory
//   wt-trip: trip counts and pointers: signed, 16-bit, masked and multiplied bounds, pointer
//     counting loops that wrap, memory declared up to 4 GiB
//   wt-diff: the smallest edit that should make an accepted fold unsafe (store ahead of the read
//     pointer, load past the end, trap on data, import call, scratch write)
// usage: gen-wat.ts SEED COUNT_PER_FAMILY

const seed = Number(process.argv[2] ?? 1);
const COUNT = Number(process.argv[3] ?? 150);
const R = mulberry(seed * 104729 + 7);
const pick = <T>(a: readonly T[]): T => a[Math.floor(R() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const chance = (p: number) => R() < p;
const odd32 = () => (Math.floor(R() * 2 ** 32) | 1) | 0;
const any32 = () => Math.floor(R() * 2 ** 32) | 0;

const g = (x: string) => `(local.get $${x})`;
const set = (x: string, e: string) => `(local.set $${x} ${e})`;
const c = (v: number | bigint) => `(i32.const ${v})`;
const add = (a: string, b: string) => `(i32.add ${a} ${b})`;
const sub = (a: string, b: string) => `(i32.sub ${a} ${b})`;
const mul = (a: string, b: string) => `(i32.mul ${a} ${b})`;
const xor = (a: string, b: string) => `(i32.xor ${a} ${b})`;
const and = (a: string, b: string) => `(i32.and ${a} ${b})`;
const shl = (a: string, k: number) => `(i32.shl ${a} ${c(k)})`;
const shr = (a: string, k: number) => `(i32.shr_u ${a} ${c(k)})`;

const TAB = 0x10000;

interface Parts {
	pre: string;
	step: string;
	post: string;
	/** data segments and other module items */
	items: string;
	/** extra locals */
	locals: string;
	/** step writes the input range */
	out: boolean;
	tag: string;
}

const crcTable = (poly: number): number[] => {
	const out: number[] = [];
	for (let i = 0; i < 256; i++) {
		let x = i;
		for (let k = 0; k < 8; k++) x = x & 1 ? (x >>> 1) ^ poly : x >>> 1;
		out.push(x >>> 0);
	}
	return out;
};
const bytesLE = (words: number[]) =>
	words
		.flatMap((w) => [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255])
		.map((b) => `\\${b.toString(16).padStart(2, '0')}`)
		.join('');
const dataSeg = (addr: number, words: number[]) => `(data (i32.const ${addr}) "${bytesLE(words)}")`;

function stepParts(kind: string): Parts {
	const base: Parts = { pre: '', step: '', post: '', items: '', locals: '', out: false, tag: kind };
	switch (kind) {
		case 'poly':
			return { ...base, step: set('s', add(mul(g('s'), c(odd32())), g('b'))) };
		case 'lcg':
			return { ...base, step: set('s', add(add(mul(g('s'), c(odd32())), c(any32())), g('b'))) };
		case 'xs':
			return {
				...base,
				step: [
					set('s', xor(g('s'), g('b'))),
					set('s', xor(g('s'), shl(g('s'), int(1, 31)))),
					set('s', xor(g('s'), shr(g('s'), int(1, 31)))),
					set('s', xor(g('s'), shl(g('s'), int(1, 31))))
				].join(' ')
			};
		case 'crcbit': {
			const poly = odd32();
			const one = set(
				's',
				xor(shr(g('s'), 1), and(c(poly), sub(c(0), and(g('s'), c(1)))))
			);
			return { ...base, step: `${set('s', xor(g('s'), g('b')))} ${Array(8).fill(one).join(' ')}` };
		}
		case 'crctab': {
			const poly = odd32();
			const tab = crcTable(poly >>> 0);
			if (chance(0.25)) tab[int(0, 255)] = (tab[int(0, 255)]! ^ (1 << int(0, 31))) >>> 0;
			return {
				...base,
				items: dataSeg(TAB, tab),
				step: set(
					's',
					xor(
						shr(g('s'), 8),
						`(i32.load offset=${TAB} (i32.shl ${and(xor(g('s'), g('b')), c(255))} ${c(2)}))`
					)
				)
			};
		}
		case 'adler': {
			const P = pick([65521, 251, 255, 65535, 40000]);
			return {
				...base,
				pre: `${set('k', and(g('s'), c(65535)))} ${set('t', shr(g('s'), 16))}`,
				step: `${set('k', `(i32.rem_u ${add(g('k'), g('b'))} ${c(P)})`)} ${set('t', `(i32.rem_u ${add(g('t'), g('k'))} ${c(P)})`)}`,
				post: set('s', `(i32.or ${shl(g('t'), 16)} ${g('k')})`)
			};
		}
		case 'xlcg':
			return {
				...base,
				out: true,
				step: `${set('s', add(mul(g('s'), c(1664525)), c(1013904223)))} (i32.store8 ${g('a')} ${xor(g('b'), shr(g('s'), 24))})`
			};
		case 'xfeed':
			return {
				...base,
				out: true,
				step: `${set('s', add(mul(g('s'), c(31)), g('b')))} (i32.store8 ${g('a')} ${xor(g('b'), shr(g('s'), 24))})`
			};
		case 'xshift':
			return {
				...base,
				out: true,
				step: [
					set('s', xor(g('s'), shl(g('s'), 13))),
					set('s', xor(g('s'), shr(g('s'), 17))),
					set('s', xor(g('s'), shl(g('s'), 5))),
					`(i32.store8 ${g('a')} ${xor(g('b'), and(g('s'), c(255)))})`
				].join(' ')
			};
		case 'sbox': {
			const sb = Array.from({ length: 64 }, (_, i) => ((i * 4 * 167 + 13) & 255) | ((((i * 4 + 1) * 167 + 13) & 255) << 8) | ((((i * 4 + 2) * 167 + 13) & 255) << 16) | ((((i * 4 + 3) * 167 + 13) & 255) << 24));
			return {
				...base,
				out: true,
				items: dataSeg(TAB, sb),
				step: [
					set('s', xor(g('s'), shl(g('s'), 13))),
					set('s', xor(g('s'), shr(g('s'), 17))),
					set('s', xor(g('s'), shl(g('s'), 5))),
					`(i32.store8 ${g('a')} ${xor(g('b'), `(i32.load8_u offset=${TAB} ${and(g('s'), c(255))})`)})`
				].join(' ')
			};
		}
		case 'mixed':
			return { ...base, step: set('s', mul(xor(g('s'), g('b')), c(odd32()))) };
		default:
			throw new Error(kind);
	}
}

const STEPS = ['poly', 'lcg', 'xs', 'crcbit', 'crctab', 'adler', 'xlcg', 'xfeed', 'xshift', 'sbox', 'mixed'];
const loadA = (addr: string) => `${set('a', addr)} ${set('b', `(i32.load8_u ${g('a')})`)}`;
const inc = (x: string, by = 1) => set(x, add(g(x), c(by)));

interface Hooks {
	hp?: string;
	hq?: string;
}

// a loop that exits through `exit` and reads the byte at p + i
const idxLoop = (pt: Parts, exit: string, h: Hooks = {}) =>
	`(block $d (loop $L (br_if $d ${exit}) ${h.hp ?? ''} ${loadA(add(g('p'), g('i')))} ${pt.step} ${h.hq ?? ''} ${inc('i')} (br $L)))`;

const SHAPES: Record<string, (pt: Parts, h: Hooks) => string> = {
	idx: (pt, h) => idxLoop(pt, `(i32.ge_u ${g('i')} ${g('n')})`, h),
	signed: (pt, h) => idxLoop(pt, `(i32.ge_s ${g('i')} ${g('n')})`, h),
	m16: (pt, h) => idxLoop(pt, `(i32.ge_u ${g('i')} ${and(g('n'), c(65535))})`, h),
	c16: (pt, h) => idxLoop(pt, `(i32.ge_u ${and(g('i'), c(65535))} ${g('n')})`, h),
	mul4: (pt, h) => idxLoop(pt, `(i32.ge_u ${mul(g('i'), c(4))} ${mul(g('n'), c(4))})`, h),
	plus1: (pt, h) => idxLoop(pt, `(i32.gt_u ${g('i')} ${g('n')})`, h),
	minus1: (pt, h) => idxLoop(pt, `(i32.ge_u ${g('i')} ${sub(g('n'), c(1))})`, h),
	cap: (pt, h) =>
		idxLoop(pt, `(i32.or (i32.ge_u ${g('i')} ${g('n')}) (i32.ge_u ${g('i')} ${c(int(70000, 140000))}))`, h),
	capmid: (pt, h) =>
		idxLoop(pt, `(i32.or (i32.ge_u ${g('i')} ${g('n')}) (i32.ge_u ${g('i')} ${c(int(300, 5000))}))`, h),
	eq: (pt, h) => idxLoop(pt, `(i32.eq ${g('i')} ${g('n')})`, h),
	dowhile: (pt) =>
		`(loop $L ${loadA(add(g('p'), g('i')))} ${pt.step} ${inc('i')} (br_if $L (i32.ne ${g('i')} ${g('n')})))`,
	ptrne: (pt, h) =>
		`${set('e', add(g('p'), g('n')))} (block $d (loop $L (br_if $d (i32.eq ${g('p')} ${g('e')})) ${h.hp ?? ''} ${loadA(g('p'))} ${pt.step} ${h.hq ?? ''} ${inc('p')} (br $L)))`,
	ptrlt: (pt, h) =>
		`${set('e', add(g('p'), g('n')))} (block $d (loop $L (br_if $d (i32.ge_u ${g('p')} ${g('e')})) ${h.hp ?? ''} ${loadA(g('p'))} ${pt.step} ${h.hq ?? ''} ${inc('p')} (br $L)))`,
	ptrsub: (pt) =>
		`${set('e', add(g('p'), g('n')))} (block $d (loop $L (br_if $d (i32.eqz ${sub(g('e'), g('p'))})) ${loadA(g('p'))} ${pt.step} ${inc('p')} (br $L)))`,
	down: (pt) =>
		`(block $d (loop $L (br_if $d (i32.eqz ${g('n')})) ${loadA(g('p'))} ${pt.step} ${inc('p')} ${set('n', sub(g('n'), c(1)))} (br $L)))`,
	downs: (pt) =>
		`(block $d (loop $L (br_if $d (i32.le_s ${g('n')} ${c(0)})) ${loadA(g('p'))} ${pt.step} ${inc('p')} ${set('n', sub(g('n'), c(1)))} (br $L)))`,
	unroll2: (pt) =>
		`(block $d (loop $L (br_if $d (i32.gt_u ${add(g('i'), c(2))} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} ${loadA(add(g('p'), add(g('i'), c(1))))} ${pt.step} ${inc('i', 2)} (br $L))) ${idxLoop(pt, `(i32.ge_u ${g('i')} ${g('n')})`).replace('$d', '$d2').replace('$L', '$L2').replace('(br $L)', '(br $L2)')}`,
	unroll2bug: (pt) => {
		const alt = pt.step.replace(/\(i32\.const (-?\d+)\)/, (_m, v) => `(i32.const ${Number(v) + 2})`);
		return `(block $d (loop $L (br_if $d (i32.gt_u ${add(g('i'), c(2))} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} ${loadA(add(g('p'), add(g('i'), c(1))))} ${pt.step} ${inc('i', 2)} (br $L))) (block $d2 (loop $L2 (br_if $d2 (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${alt} ${inc('i')} (br $L2)))`;
	},
	unroll4: (pt) => {
		const one = (k: number) => `${loadA(add(g('p'), add(g('i'), c(k))))} ${pt.step}`;
		return `(block $d (loop $L (br_if $d (i32.gt_u ${add(g('i'), c(4))} ${g('n')})) ${one(0)} ${one(1)} ${one(2)} ${one(3)} ${inc('i', 4)} (br $L))) (block $d2 (loop $L2 (br_if $d2 (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} ${inc('i')} (br $L2)))`;
	},
	nested: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} (drop (block $o (result i32) (drop (block $in (result i32) ${pt.step} (br_if $o ${c(0)} ${c(1)}) ${c(7)})) ${c(9)})) ${inc('i')} (br $L)))`,
	brtable: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} (block $j (block $b2 (block $b1 (br_table $b1 $b2 $b1 ${and(g('i'), c(3))})) ${pt.step} (br $j)) ${pt.step}) ${inc('i')} (br $L)))`,
	brtabledata: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} (block $j (block $b2 (block $b1 (br_table $b1 $b2 $b1 ${and(g('b'), c(3))})) ${pt.step} (br $j)) ${pt.step}) ${inc('i')} (br $L)))`,
	earlyzero: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} (br_if $d (i32.eqz ${g('b')})) ${pt.step} ${inc('i')} (br $L)))`,
	earlystate: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} (br_if $d (i32.eqz ${g('s')})) ${inc('i')} (br $L)))`,
	firstbyte: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} (if (i32.eqz ${g('i')}) (then ${set('s', xor(g('s'), c(int(1, 255))))})) ${pt.step} ${inc('i')} (br $L)))`,
	selectfx: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} ${set('t', `(select (block (result i32) (i32.store8 ${c(int(64, 4000))} ${g('b')}) ${g('s')}) ${g('s')} ${c(1)})`)} ${inc('i')} (br $L)))`,
	selectctl: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} ${set('s', `(select ${g('s')} ${xor(g('s'), c(int(1, 255)))} (i32.ne ${g('i')} ${c(0)}))`)} ${inc('i')} (br $L)))`,
	selectdata: (pt) =>
		`(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} ${set('s', `(select ${g('s')} ${xor(g('s'), c(int(1, 255)))} ${and(g('b'), c(1))})`)} ${inc('i')} (br $L)))`
};

const ALL_SHAPES = Object.keys(SHAPES);

interface Mod {
	memory: string;
	globals: string;
	items: string;
	funcs: string;
	start: string;
	extra: string;
	exports: string;
}

function fnText(entry: string, body: string, locals: string, extraExport = ''): string {
	return `(func $update (export "${entry}") ${extraExport} (param $s i32) (param $p i32) (param $n i32) (result i32) (local $i i32) (local $b i32) (local $t i32) (local $k i32) (local $a i32) (local $e i32) ${locals} ${body})`;
}

function assemble(m: Mod): string {
	return `(module ${m.extra} ${m.memory} ${m.globals} ${m.items} ${m.funcs} ${m.start})`;
}

const MEM = '(memory (export "memory") 32 512)';
const MEM4G = '(memory (export "memory") 32 65536)';

function baseModule(stepKind: string, shape: string, h: Hooks = {}, memory = MEM): Mod & { pt: Parts } {
	const pt = stepParts(stepKind);
	const body = `${pt.pre} ${SHAPES[shape]!(pt, h)} ${pt.post} ${g('s')}`;
	return {
		pt,
		memory,
		globals: '',
		items: pt.items,
		funcs: fnText('update', body, pt.locals),
		start: '',
		extra: '',
		exports: ''
	};
}

type Gen = () => { text: string; tag: string; note?: string };

// #region wt-struct

const structGens: Gen[] = [
	// every shape against every step
	() => {
		const step = pick(STEPS);
		const shape = pick(['idx', 'dowhile', 'ptrne', 'down', 'unroll2', 'unroll4', 'unroll2bug', 'nested', 'brtable', 'brtabledata', 'earlyzero', 'earlystate', 'firstbyte', 'selectfx', 'selectctl', 'selectdata', 'capmid', 'eq', 'ptrsub']);
		const m = baseModule(step, shape);
		return { text: assemble(m), tag: `${shape}-${step}` };
	},
	// multi-value helper
	() => {
		const step = pick(['poly', 'lcg']);
		const M = odd32();
		const A = any32();
		const helper = `(func $st (param i32 i32) (result i32 i32) (i32.add (i32.mul (local.get 0) (i32.const ${M})) ${step === 'lcg' ? `(i32.add (local.get 1) (i32.const ${A}))` : '(local.get 1)'}) (local.get 1))`;
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${g('s')} ${g('b')} (call $st) (local.set $b) (local.set $s) ${inc('i')} (br $L))) ${g('s')}`;
		return {
			text: `(module ${MEM} ${helper} ${fnText('update', body, '')})`,
			tag: `multivalue-${step}`
		};
	},
	// multi-value block type
	() => {
		const M = odd32();
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${g('s')} ${g('b')} (block (param i32 i32) (result i32 i32) (local.set $t) (local.set $k) (i32.add (i32.mul (local.get $k) (i32.const ${M})) (local.get $t)) (local.get $t)) (local.set $b) (local.set $s) ${inc('i')} (br $L))) ${g('s')}`;
		return { text: `(module ${MEM} ${fnText('update', body, '')})`, tag: 'multivalue-block' };
	},
	// helper that loads the byte
	() => {
		const pt = stepParts(pick(['poly', 'xs', 'crcbit', 'lcg']));
		const helper = `(func $ld (param i32) (result i32) (i32.load8_u offset=${pick([0, 0, 1])} (local.get 0)))`;
		const off = chance(0.3) ? 0 : 0;
		void off;
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${set('b', `(call $ld ${add(g('p'), g('i'))})`)} ${pt.step} ${inc('i')} (br $L))) ${g('s')}`;
		return { text: `(module ${MEM} ${pt.items} ${helper} ${fnText('update', body, '')})`, tag: `helper-load-${pt.tag}` };
	},
	// helper that stores
	() => {
		const pt = stepParts(pick(['poly', 'xs', 'lcg']));
		const where = pick(['(local.get 0)', '(i32.add (local.get 0) (i32.const 1))', '(i32.sub (local.get 0) (i32.const 1))', '(i32.const 512)']);
		const helper = `(func $stw (param i32 i32) (i32.store8 ${where} (local.get 1)))`;
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${pt.step} (call $stw ${g('a')} ${xor(g('b'), c(int(1, 255)))}) ${inc('i')} (br $L))) ${g('s')}`;
		return { text: `(module ${MEM} ${helper} ${fnText('update', body, '')})`, tag: `helper-store-${pt.tag}` };
	},
	// globals: immutable, mutable read-only, mutable and advanced by the call
	() => {
		const mode = pick(['imm', 'mutro', 'mutinc', 'mutincfirst', 'mutcnt']);
		const K = odd32();
		const decl = mode === 'imm' ? `(global $K i32 (i32.const ${K}))` : `(global $K (mut i32) (i32.const ${K}))`;
		const bump = mode === 'mutinc' ? `(global.set $K ${add('(global.get $K)', c(2))})` : mode === 'mutcnt' ? `(global.set $K ${add('(global.get $K)', c(0))})` : '';
		const bumpFirst = mode === 'mutincfirst' ? `(global.set $K ${add('(global.get $K)', c(2))})` : '';
		const body = `${bumpFirst} (block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', add(mul(g('s'), '(global.get $K)'), g('b')))} ${inc('i')} (br $L))) ${bump} ${g('s')}`;
		return { text: `(module ${MEM} ${decl} ${fnText('update', body, '')})`, tag: `global-${mode}` };
	},
	// global as table of two state words persisted between calls
	() => {
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', add(mul(g('s'), c(31)), g('b')))} (global.set $G (i32.add (global.get $G) ${c(1)})) ${inc('i')} (br $L))) ${pick([g('s'), `(i32.add ${g('s')} ${c(0)})`, `(i32.xor ${g('s')} (i32.and (global.get $G) ${c(0)}))`])}`;
		return { text: `(module ${MEM} (global $G (mut i32) (i32.const 0)) ${fnText('update', body, '')})`, tag: 'global-count-write' };
	},
	// data segments: overlapping and out of the way, with a table read
	() => {
		const poly = odd32();
		const tab = crcTable(poly >>> 0);
		const second = tab.slice(0, int(1, 8)).map((w) => (w ^ (1 << int(0, 31))) >>> 0);
		const at = TAB + 4 * int(0, 8);
		const items = `${dataSeg(TAB, tab)} ${chance(0.7) ? dataSeg(at, second) : ''}`;
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', xor(shr(g('s'), 8), `(i32.load offset=${TAB} (i32.shl ${and(xor(g('s'), g('b')), c(255))} ${c(2)}))`))} ${inc('i')} (br $L))) ${g('s')}`;
		return { text: `(module ${MEM} ${items} ${fnText('update', body, '')})`, tag: 'data-overlap' };
	},
	// data segment at an address inside a region the caller may use as input
	() => {
		const base = 1 << 20;
		const poly = odd32();
		const items = dataSeg(pick([base + 4096, base - 1024, 0x30000, 0]), crcTable(poly >>> 0));
		const at = (items.match(/i32\.const (\d+)/)![1]!);
		const body = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', xor(shr(g('s'), 8), `(i32.load offset=${at} (i32.shl ${and(xor(g('s'), g('b')), c(255))} ${c(2)}))`))} ${inc('i')} (br $L))) ${g('s')}`;
		return { text: `(module ${MEM} ${items} ${fnText('update', body, '')})`, tag: 'data-in-input-region' };
	},
	// passive data and memory.init, a start function, a second memory, imports: the shallow refusals
	() => {
		const kind = pick(['passive', 'start', 'start-table', 'twomem', 'twomem-table', 'import', 'twoexp']);
		const body = (extra = '') => `${extra} (block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', add(mul(g('s'), c(31)), g('b')))} ${inc('i')} (br $L))) ${g('s')}`;
		if (kind === 'passive')
			return { text: `(module ${MEM} (data $d "\\01\\02\\03\\04") ${fnText('update', body(`(memory.init $d ${c(512)} ${c(0)} ${c(4)})`), '')})`, tag: kind };
		if (kind === 'start')
			return { text: `(module ${MEM} (global $K (mut i32) (i32.const 31)) (func $init (global.set $K ${c(33)})) (start $init) ${fnText('update', body().replace(c(31), '(global.get $K)'), '')})`, tag: kind };
		if (kind === 'start-table') {
			const tab = crcTable(0xedb88320);
			const b = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', xor(shr(g('s'), 8), `(i32.load offset=${TAB} (i32.shl ${and(xor(g('s'), g('b')), c(255))} ${c(2)}))`))} ${inc('i')} (br $L))) ${g('s')}`;
			return { text: `(module ${MEM} ${dataSeg(TAB, tab)} (func $init (i32.store offset=${TAB} ${c(0)} ${c(int(1, 99999))})) (start $init) ${fnText('update', b, '')})`, tag: kind };
		}
		if (kind === 'twomem')
			return { text: `(module ${MEM} (memory $m2 1) ${fnText('update', body(), '')})`, tag: kind };
		if (kind === 'twomem-table') {
			const tab = crcTable(0xedb88320);
			const b = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', xor(shr(g('s'), 8), `(i32.load $m2 offset=0 (i32.shl ${and(xor(g('s'), g('b')), c(255))} ${c(2)}))`))} ${inc('i')} (br $L))) ${g('s')}`;
			return { text: `(module ${MEM} (memory $m2 1) (data (memory $m2) (i32.const 0) "${bytesLE(tab)}") ${fnText('update', b, '')})`, tag: kind };
		}
		if (kind === 'import')
			return { text: `(module (import "env" "f" (func $f (param i32) (result i32))) ${MEM} ${fnText('update', body().replace(`(local.get $s)\n`, '').replace(/\)$/, ')'), '')})`, tag: kind };
		return { text: `(module ${MEM} ${fnText('update', body(), '', '(export "again")')})`, tag: kind };
	},
	// memory.fill and memory.copy over the input
	() => {
		const kind = pick([
			'fill-const',
			'fill-state',
			'fill-first',
			'fill-one-past',
			'fill-half',
			'copy-left',
			'copy-self',
			'copy-scratch',
			'fill-zero-before',
			'copy-in-loop',
			'fill-in-loop'
		]);
		const M = pick([31, 33, 1664525]);
		const fold = `(block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', add(mul(g('s'), c(M)), g('b')))} ${kind === 'copy-in-loop' ? `(memory.copy ${g('a')} ${add(g('a'), c(1))} ${c(1)})` : ''} ${kind === 'fill-in-loop' ? `(memory.fill ${g('a')} ${c(int(0, 255))} ${c(1)})` : ''} ${inc('i')} (br $L)))`;
		const tail: Record<string, string> = {
			'fill-const': `(memory.fill ${g('p')} ${c(int(0, 255))} ${g('n')})`,
			'fill-state': `(memory.fill ${g('p')} ${g('s')} ${g('n')})`,
			'fill-first': `(memory.fill ${add(g('p'), c(1))} (i32.load8_u ${g('p')}) ${sub(g('n'), c(1))})`,
			'fill-one-past': `(memory.fill ${add(g('p'), g('n'))} ${c(int(0, 255))} ${c(1)})`,
			'fill-half': `(memory.fill ${g('p')} ${c(int(0, 255))} ${shr(g('n'), 1)})`,
			'copy-left': `(memory.copy ${g('p')} ${add(g('p'), c(1))} ${sub(g('n'), c(1))})`,
			'copy-self': `(memory.copy ${g('p')} ${g('p')} ${g('n')})`,
			'copy-scratch': `(memory.copy ${c(4096)} ${g('p')} ${g('n')})`,
			'fill-zero-before': '',
			'copy-in-loop': '',
			'fill-in-loop': ''
		};
		const pre = kind === 'fill-zero-before' ? `(memory.fill ${g('p')} ${c(0)} ${c(1)})` : '';
		return { text: `(module ${MEM} ${fnText('update', `${pre} ${fold} ${tail[kind]} ${g('s')}`, '')})`, tag: kind };
	},
	// a body shared by two exports through a helper with a mode argument
	() => {
		const M = odd32();
		const helper = `(func $body (param i32 i32 i32 i32) (result i32) (local $i i32) (local $b i32) (block $d (loop $L (br_if $d (i32.ge_u (local.get $i) (local.get 2))) (local.set $b (i32.load8_u (i32.add (local.get 1) (local.get $i)))) (local.set 0 (i32.add (i32.mul (local.get 0) (i32.const ${M})) (i32.add (local.get $b) (select (i32.const ${int(1, 9)}) (i32.const 0) (local.get 3))))) (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $L))) (local.get 0))`;
		const mode = pick([0, 1]);
		return {
			text: `(module ${MEM} ${helper} (func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32) (call $body (local.get $s) (local.get $p) (local.get $n) (i32.const ${mode}))) (func $other (export "other") (param $s i32) (param $p i32) (param $n i32) (result i32) (call $body (local.get $s) (local.get $p) (local.get $n) (i32.const ${1 - mode}))))`,
			tag: `shared-body-${mode}`
		};
	},
	// helper call split between a main loop and a tail with a different mode
	() => {
		const M = odd32();
		const step = (mode: number) => `(call $stp ${g('s')} ${g('b')} ${c(mode)})`;
		const helper = `(func $stp (param i32 i32 i32) (result i32) (i32.add (i32.mul (local.get 0) (i32.const ${M})) (i32.add (local.get 1) (select (i32.const ${int(1, 9)}) (i32.const 0) (local.get 2)))))`;
		const m1 = 0;
		const m2 = pick([0, 0, 1]);
		const body = `(block $d (loop $L (br_if $d (i32.gt_u ${add(g('i'), c(2))} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', step(m1))} ${loadA(add(g('p'), add(g('i'), c(1))))} ${set('s', step(m1))} ${inc('i', 2)} (br $L))) (block $d2 (loop $L2 (br_if $d2 (i32.ge_u ${g('i')} ${g('n')})) ${loadA(add(g('p'), g('i')))} ${set('s', step(m2))} ${inc('i')} (br $L2))) ${g('s')}`;
		return { text: `(module ${MEM} ${helper} ${fnText('update', body, '')})`, tag: `helper-tail-mode-${m2}` };
	}
];

// #endregion

// #region wt-trip

const HOOKS: Record<string, Hooks> = {};
void HOOKS;

const tripGens: Gen[] = [
	() => {
		const shape = pick(['signed', 'm16', 'c16', 'mul4', 'plus1', 'minus1', 'cap', 'capmid', 'ptrlt', 'ptrne', 'ptrsub', 'down', 'downs', 'dowhile', 'eq', 'idx']);
		const step = pick(['poly', 'lcg', 'xs', 'crcbit', 'adler', 'xlcg', 'xfeed']);
		const mem = pick([MEM, MEM4G, MEM4G]);
		const m = baseModule(step, shape, {}, mem);
		return { text: assemble(m), tag: `${shape}-${step}-${mem === MEM ? '512' : '4g'}` };
	}
];

// #endregion

// #region wt-diff

const diffHooks: [string, (a: string) => Hooks, string?][] = [
	['store-before-load', (a) => ({ hp: `(i32.store8 ${add(g('p'), g('i'))} ${c(int(0, 255))})` })],
	['store-before-load-xor', () => ({ hp: `(i32.store8 ${add(g('p'), g('i'))} ${xor(`(i32.load8_u ${add(g('p'), g('i'))})`, c(int(1, 255)))})` })],
	['store-ahead', () => ({ hq: `(i32.store8 ${add(g('p'), add(g('i'), c(1)))} ${c(int(0, 255))})` })],
	['store-ahead2', () => ({ hq: `(i32.store8 ${add(g('p'), add(g('i'), c(int(2, 17))))} ${xor(g('b'), c(int(1, 255)))})` })],
	['store-behind', () => ({ hq: `(i32.store8 ${add(g('p'), sub(g('i'), c(1)))} ${c(int(0, 255))})` })],
	['store-same-after', () => ({ hq: `(i32.store8 ${add(g('p'), g('i'))} ${xor(g('b'), c(int(1, 255)))})` })],
	['store-same-state', () => ({ hq: `(i32.store8 ${add(g('p'), g('i'))} ${and(shr(g('s'), int(0, 24)), c(255))})` })],
	['store-same-future', () => ({ hq: `(i32.store8 ${add(g('p'), g('i'))} ${and(add(g('s'), g('i')), c(255))})` })],
	['store-two-width', () => ({ hq: `(i32.store16 ${add(g('p'), g('i'))} ${and(g('s'), c(65535))})` })],
	['store-word', () => ({ hq: `(i32.store ${add(g('p'), g('i'))} ${g('s')})` })],
	['store-end', () => ({ hq: `(i32.store8 ${add(g('p'), g('n'))} ${c(int(0, 255))})` })],
	['store-first', () => ({ hq: `(i32.store8 ${g('p')} ${g('s')})` })],
	['store-scratch', () => ({ hq: `(i32.store8 ${c(int(64, 4000))} ${g('b')})` })],
	['store-scratch-read', () => ({ hq: `(i32.store8 ${c(300)} ${g('b')}) ${set('s', add(g('s'), `(i32.load8_u ${c(300)})`))}` })],
	['store-fixed-state', () => ({ hq: `(i32.store ${c(int(64, 4000))} ${g('s')})` })],
	['load-ahead', () => ({ hp: set('s', add(g('s'), `(i32.load8_u ${add(g('p'), add(g('i'), c(1)))})`)) })],
	['load-ahead-end', () => ({ hp: set('s', add(g('s'), `(i32.load8_u ${add(g('p'), g('n'))})`)) })],
	['load-behind', () => ({ hp: set('s', add(g('s'), `(i32.load8_u ${add(g('p'), sub(g('i'), c(1)))})`)) })],
	['load-fixed', () => ({ hp: set('s', add(g('s'), `(i32.load8_u ${c(int(64, 4000))})`)) })],
	['load-word', () => ({ hp: set('s', add(g('s'), `(i32.load ${add(g('p'), g('i'))})`)) })],
	['load-first', () => ({ hp: set('s', add(g('s'), `(i32.load8_u ${g('p')})`)) })],
	['load-last', () => ({ hp: set('s', add(g('s'), `(i32.load8_u ${add(g('p'), sub(g('n'), c(1)))})`)) })],
	['trap-on-data', () => ({ hq: `(if (i32.eq ${g('b')} ${c(255)}) (then (unreachable)))` })],
	['trap-on-data0', () => ({ hq: `(if (i32.eqz ${g('b')}) (then (unreachable)))` })],
	['trap-on-n', () => ({ hq: `(if (i32.eq ${g('n')} ${c(int(3, 300))}) (then (unreachable)))` })],
	['div-by-byte', () => ({ hq: set('s', add(g('s'), `(i32.div_u ${c(1000)} ${g('b')})`)) })],
	['oob-by-byte', () => ({ hq: set('s', add(g('s'), `(i32.load8_u ${shl(g('b'), 24)})`)) })],
	['oob-by-state', () => ({ hq: set('s', add(g('s'), `(i32.load8_u ${shl(g('s'), 24)})`)) })],
	['grow', () => ({ hq: `(drop (memory.grow ${c(0)}))` })],
	['grow1', () => ({ hq: `(drop (memory.grow ${c(1)}))` })],
	['global-write', () => ({ hq: '(global.set $G (i32.add (global.get $G) (i32.const 1)))' })],
	['global-read-write', () => ({ hq: `(global.set $G (i32.add (global.get $G) (i32.const 1))) ${set('s', add(g('s'), '(global.get $G)'))}` })],
	['opaque-state', () => ({ hq: set('s', xor(g('s'), shr(g('s'), int(1, 31)))) })],
	['opaque-addr', () => ({ hq: `(i32.store8 ${add(g('p'), and(g('s'), c(255)))} ${c(0)})` })],
	['fill-after', () => ({ hq: `(memory.fill ${g('a')} ${c(int(0, 255))} ${c(1)})` })],
	['copy-next', () => ({ hq: `(memory.copy ${g('a')} ${add(g('a'), c(1))} ${c(1)})` })],
	['copy-prev', () => ({ hq: `(memory.copy ${add(g('a'), c(1))} ${g('a')} ${c(1)})` })],
	['nop', () => ({ hq: '(nop)' })],
	['store-after-nop', () => ({ hq: `(i32.store8 ${g('a')} ${g('b')})` })],
	['store-back-original', () => ({ hq: `(i32.store8 ${g('a')} ${g('b')})` })],
	['loop-store-index', () => ({ hq: `(i32.store8 ${add(g('p'), g('i'))} ${and(g('i'), c(255))})` })],
	['store-stride', () => ({ hq: `(i32.store8 ${add(g('p'), shl(g('i'), 1))} ${c(int(0, 255))})` })]
];

const diffGens: Gen[] = [
	() => {
		const [name, mk] = pick(diffHooks);
		const step = pick(['poly', 'lcg', 'xs', 'crcbit', 'crctab', 'adler', 'xlcg', 'xfeed', 'xshift']);
		const shape = pick(['idx', 'idx', 'ptrne']);
		const m = baseModule(step, shape, mk(''), MEM);
		const needsGlobal = /global/.test(name);
		const text = assemble({ ...m, globals: needsGlobal ? '(global $G (mut i32) (i32.const 0))' : '' });
		return { text, tag: `${name}-${step}-${shape}` };
	}
];

// #endregion

const families: [string, Gen[]][] = [
	['wt-struct', structGens],
	['wt-trip', tripGens],
	['wt-diff', diffGens]
];
for (const [family, gens] of families) {
	const m = new Manifest(`${family}-${seed}`);
	let tries = 0;
	let errs = 0;
	const reasons = new Map<string, number>();
	while (m.count < COUNT && tries < COUNT * 6) {
		tries++;
		const gen = pick(gens);
		let out: ReturnType<Gen>;
		let bytes: Uint8Array;
		try {
			out = gen();
			bytes = wat(out.text);
		} catch (e) {
			errs++;
			const k = String(e).slice(0, 90);
			reasons.set(k, (reasons.get(k) ?? 0) + 1);
			continue;
		}
		m.add(family, `${family}-${seed}/${m.count}-${out.tag}`, bytes, {
			entry: 'update'
		});
	}
	console.log(family, seed, m.count, 'tries', tries, 'build errors', errs, 'dupes', m.dupes);
	for (const [k, v] of [...reasons].slice(0, 4)) console.log('  ', v, k);
}
