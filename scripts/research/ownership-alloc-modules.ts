import { assemble } from './ownership-modules.ts';

// hand-written allocator drivers: a bump allocator over each record's arena slice, in the shape of
// support-bulk.c (bump_set resets region, limit and cursor; malloc bumps the cursor)
export const TABLE = 8192;
export const OUT = 12288;
export const DATA = 16384;
export const ARENAS = 65536;
export const SLICE = 1024;
export const ARENA_BYTES = 512;
export const RECORDS = 8;
export const SHIFT = 384;
export const STACK_TOP = 262144;
export const WINDOW = { region: 4096, limit: 4100, cursor: 4104 };

export interface AllocFrame {
	body: string;
	extra?: string;
	locals?: string;
	/** an i32 expression that `$rec` and the entry return */
	ret?: string;
	max?: number;
	stack?: boolean;
}

const LOCALS =
	'(local $a i32) (local $b i32) (local $c i32) (local $n i32) (local $acc i32) (local $d i32)';

export const allocWat = ({ body, extra = '', locals = '', ret, max, stack }: AllocFrame) => `(module
	(import "env" "memory" (memory 8${max ? ` ${max}` : ''}))
	${extra}
	${stack ? `(global $sp (mut i32) (i32.const ${STACK_TOP}))` : ''}
	(func $bump_set (param $base i32) (param $size i32)
		(i32.store (i32.const ${WINDOW.region}) (local.get $base))
		(i32.store (i32.const ${WINDOW.limit}) (local.get $size))
		(i32.store (i32.const ${WINDOW.cursor}) (i32.const 0)))
	(func $malloc (param $size i32) (result i32)
		(local $start i32)
		(local.set $start (i32.and (i32.add (i32.load (i32.const ${WINDOW.cursor})) (i32.const 31)) (i32.const -16)))
		(if (i32.or
				(i32.gt_u (local.get $start) (i32.load (i32.const ${WINDOW.limit})))
				(i32.gt_u (local.get $size) (i32.sub (i32.load (i32.const ${WINDOW.limit})) (local.get $start))))
			(then (return (i32.const 0))))
		(i32.store (i32.sub (i32.add (i32.load (i32.const ${WINDOW.region})) (local.get $start)) (i32.const 4)) (local.get $size))
		(i32.store (i32.const ${WINDOW.cursor}) (i32.add (local.get $start) (local.get $size)))
		(i32.add (i32.load (i32.const ${WINDOW.region})) (local.get $start)))
	(func $rec (param $t i32) (param $o i32) (result i32)
		(local $p i32) (local $len i32) (local $k i32) (local $sum i32) (local $arena i32) (local $slot i32)
		${LOCALS} ${locals}
		(local.set $p (i32.load (local.get $t)))
		(local.set $len (i32.load offset=4 (local.get $t)))
		(local.set $arena (i32.load offset=12 (local.get $t)))
		(local.set $slot (local.get $o))
		(block $sd (loop $sl
			(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
			(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
			(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))
		${body}
		${ret ?? '(i32.const 0)'})
	(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)${ret ? ' (result i32)' : ''}
		(local $r i32)
		(loop $each
			(local.set $r (call $rec (local.get $t) (local.get $o)))
			(local.set $t (i32.add (local.get $t) (i32.const 16)))
			(local.set $o (i32.add (local.get $o) (i32.const 64)))
			(br_if $each (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
		${ret ? '(local.get $r)' : ''})
)`;

const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const NODE = (name: string, size = 8) => `(local.set $${name} (call $malloc (i32.const ${size})))`;

export interface AllocBase {
	statements: string[];
	stack?: boolean;
}

export const ALLOC_BASES: Record<string, AllocBase> = {
	list: {
		statements: [
			SET,
			NODE('a'),
			NODE('b'),
			NODE('c'),
			'(i32.store (local.get $a) (local.get $sum))',
			'(i32.store offset=4 (local.get $a) (local.get $b))',
			'(i32.store (local.get $b) (i32.add (local.get $sum) (i32.const 1)))',
			'(i32.store offset=4 (local.get $b) (local.get $c))',
			'(i32.store (local.get $c) (i32.add (local.get $sum) (i32.const 2)))',
			'(i32.store offset=4 (local.get $c) (i32.const 0))',
			'(local.set $n (local.get $a))',
			'(local.set $acc (i32.load (local.get $n)))',
			'(local.set $n (i32.load offset=4 (local.get $n)))',
			'(local.set $acc (i32.add (local.get $acc) (i32.load (local.get $n))))',
			'(local.set $n (i32.load offset=4 (local.get $n)))',
			'(local.set $acc (i32.add (local.get $acc) (i32.load (local.get $n))))',
			'(i32.store (local.get $slot) (local.get $acc))',
			'(i32.store offset=4 (local.get $slot) (i32.sub (local.get $c) (local.get $a)))',
			'(i32.store offset=8 (local.get $slot) (i32.lt_u (local.get $a) (local.get $c)))'
		]
	},
	bytes: {
		statements: [
			SET,
			NODE('a', 16),
			NODE('b', 16),
			'(i64.store (local.get $a) (i64.extend_i32_u (local.get $sum)))',
			'(i32.store offset=8 (local.get $a) (local.get $len))',
			'(memory.copy (local.get $b) (local.get $a) (i32.const 12))',
			'(memory.fill (i32.add (local.get $b) (i32.const 12)) (i32.const 7) (i32.const 4))',
			'(memory.copy (i32.add (local.get $slot) (i32.const 16)) (local.get $b) (i32.const 16))',
			'(i32.store (local.get $slot) (i32.sub (local.get $b) (local.get $a)))'
		]
	},
	chain: {
		statements: [
			SET,
			'(local.set $k (i32.const 0))',
			`(block $ld (loop $ll
				(br_if $ld (i32.ge_u (local.get $k) (i32.const 4)))
				${NODE('c')}
				(i32.store offset=4 (local.get $c) (local.get $n))
				(i32.store (local.get $c) (i32.add (local.get $sum) (local.get $k)))
				(local.set $n (local.get $c))
				(local.set $k (i32.add (local.get $k) (i32.const 1)))
				(br $ll)))`,
			'(local.set $k (i32.const 0))',
			`(block $wd (loop $wl
				(br_if $wd (i32.ge_u (local.get $k) (i32.const 4)))
				(local.set $acc (i32.add (local.get $acc) (i32.load (local.get $n))))
				(local.set $n (i32.load offset=4 (local.get $n)))
				(local.set $k (i32.add (local.get $k) (i32.const 1)))
				(br $wl)))`,
			'(i32.store (local.get $slot) (local.get $acc))'
		]
	},
	spill: {
		stack: true,
		statements: [
			'(global.set $sp (i32.sub (global.get $sp) (i32.const 32)))',
			SET,
			NODE('a', 16),
			'(i32.store offset=8 (global.get $sp) (local.get $a))',
			'(i32.store (local.get $a) (local.get $sum))',
			'(local.set $n (i32.load offset=8 (global.get $sp)))',
			'(i32.store (local.get $slot) (i32.load (local.get $n)))',
			'(i32.store offset=4 (local.get $slot) (i32.sub (local.get $n) (local.get $a)))',
			'(global.set $sp (i32.add (global.get $sp) (i32.const 32)))'
		]
	}
};

const ODD = '(i32.and (local.get $sum) (i32.const 1))';
const OUT_ONE = '(i32.store offset=16 (local.get $slot) (i32.const 1))';
const IMPORT_F = '(import "env" "f" (func $f (param i32)))';
const TABLE_NOP = '(table 1 funcref) (type $nt (func)) (elem (i32.const 0) $nop) (func $nop)';
const GLOBAL_G = '(global $g (mut i32) (i32.const 0))';

export interface AllocInsert {
	text: string;
	extra?: string;
	ret?: string;
	/** the reasons the checker may give; `none` means a certificate is fine */
	expect: string[];
}

export const ALLOC_INSERTS: Record<string, AllocInsert> = {
	'store-ptr-out': {
		text: '(i32.store offset=16 (local.get $slot) (local.get $a))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-field-out': {
		text: '(i32.store offset=16 (local.get $slot) (i32.add (local.get $b) (i32.const 4)))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-masked-out': {
		text: '(i32.store offset=16 (local.get $slot) (i32.and (local.get $a) (i32.const -16)))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-shifted-out': {
		text: '(i32.store offset=16 (local.get $slot) (i32.shr_u (local.get $a) (i32.const 4)))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-plus-data-out': {
		text: '(i32.store offset=16 (local.get $slot) (i32.add (local.get $a) (local.get $sum)))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-wide-out': {
		text: '(i64.store offset=16 (local.get $slot) (i64.extend_i32_u (local.get $a)))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-input': {
		text: '(i32.store (local.get $p) (local.get $a))',
		expect: ['ptr-store', 'none']
	},
	'store-ptr-global': {
		text: '(global.set $g (local.get $a))',
		extra: GLOBAL_G,
		expect: ['ptr-store', 'none']
	},
	'store-ptr-window': {
		text: '(i32.store (i32.const 4200) (local.get $a))',
		expect: ['none']
	},
	'store-ptr-window-bounded': {
		text: '(i32.store (i32.add (i32.const 4096) (i32.and (local.get $sum) (i32.const 12))) (local.get $a))',
		expect: ['ptr-deref', 'final-state', 'read-before-write', 'none']
	},
	'store-ptr-arena': {
		text: '(i32.store offset=28 (local.get $a) (local.get $c))',
		expect: ['none', 'ptr-deref']
	},
	'store-ptr-arena-masked': {
		text: '(i32.store offset=28 (local.get $a) (i32.and (local.get $c) (i32.const -16)))',
		expect: ['none', 'ptr-deref']
	},
	'return-ptr': { text: '', ret: '(local.get $a)', expect: ['ptr-return', 'none'] },
	'return-ptr-sum': {
		text: '',
		ret: '(i32.add (local.get $a) (i32.const 1))',
		expect: ['ptr-return', 'none']
	},
	'return-ptr-diff': {
		text: '',
		ret: '(i32.sub (local.get $c) (local.get $a))',
		expect: ['none']
	},
	'import-ptr': {
		text: '(call $f (local.get $a))',
		extra: IMPORT_F,
		expect: ['ptr-import', 'none']
	},
	'import-ptr-field': {
		text: '(call $f (i32.add (local.get $a) (i32.const 4)))',
		extra: IMPORT_F,
		expect: ['ptr-import', 'none']
	},
	'import-plain': { text: '(call $f (local.get $sum))', extra: IMPORT_F, expect: ['isolation'] },
	'compare-const': {
		text: `(if (i32.gt_u (local.get $a) (i32.const 40960)) (then ${OUT_ONE}))`,
		expect: ['ptr-compare', 'none']
	},
	'compare-signed-const': {
		text: `(if (i32.lt_s (local.get $a) (i32.const 100000)) (then ${OUT_ONE}))`,
		expect: ['ptr-compare', 'none']
	},
	'compare-data': {
		text: `(if (i32.lt_u (local.get $a) (local.get $sum)) (then ${OUT_ONE}))`,
		expect: ['ptr-compare', 'none']
	},
	'compare-wide': {
		text: `(if (i64.lt_u (i64.extend_i32_u (local.get $a)) (i64.const 100000)) (then ${OUT_ONE}))`,
		expect: ['ptr-compare', 'none']
	},
	'compare-zero': {
		text: `(if (i32.eqz (local.get $a)) (then ${OUT_ONE}))`,
		expect: ['none']
	},
	'compare-ptrs': {
		text: `(if (i32.lt_u (local.get $a) (local.get $b)) (then ${OUT_ONE}))`,
		expect: ['none']
	},
	truthy: { text: `(if (local.get $a) (then ${OUT_ONE}))`, expect: ['none'] },
	'hash-branch': {
		text: `(if (i32.and (local.get $a) (i32.const 8)) (then ${OUT_ONE}))`,
		expect: ['ptr-control', 'none']
	},
	'hash-select': {
		text: '(drop (select (i32.const 1) (i32.const 2) (i32.and (local.get $a) (i32.const 4))))',
		expect: ['ptr-control', 'none']
	},
	'hash-xor-branch': {
		text: `(if (i32.xor (local.get $a) (local.get $b)) (then ${OUT_ONE}))`,
		expect: ['ptr-control', 'none']
	},
	'hash-mul-branch': {
		text: `(if (i32.mul (local.get $a) (i32.const 3)) (then ${OUT_ONE}))`,
		expect: ['ptr-control', 'none']
	},
	'deref-far': {
		text: '(drop (i32.load (i32.add (local.get $a) (i32.const 100000))))',
		expect: ['ptr-deref', 'none']
	},
	'deref-negative': {
		text: '(drop (i32.load (i32.sub (local.get $a) (i32.const 100))))',
		expect: ['ptr-deref', 'none']
	},
	'deref-edge': {
		text: '(drop (i32.load (i32.add (local.get $a) (i32.const 508))))',
		expect: ['ptr-deref', 'none']
	},
	'deref-dynamic': {
		text: '(drop (i32.load8_u (i32.add (local.get $a) (local.get $sum))))',
		expect: ['ptr-deref', 'none']
	},
	'store-dynamic': {
		text: '(i32.store8 (i32.add (local.get $a) (local.get $sum)) (i32.const 1))',
		expect: ['ptr-deref', 'none']
	},
	'store-bounded': {
		text: '(i32.store8 (i32.add (local.get $a) (i32.and (local.get $sum) (i32.const 15))) (i32.const 1))',
		expect: ['none', 'ptr-deref']
	},
	'cursor-read-out': {
		text: `(i32.store offset=20 (local.get $slot) (i32.load (i32.const ${WINDOW.cursor})))`,
		expect: ['read-before-write', 'none']
	},
	'region-read-out': {
		text: `(i32.store offset=20 (local.get $slot) (i32.load (i32.const ${WINDOW.region})))`,
		expect: ['ptr-store', 'read-before-write', 'none']
	},
	'limit-read-out': {
		text: `(i32.store offset=20 (local.get $slot) (i32.load (i32.const ${WINDOW.limit})))`,
		expect: ['read-before-write', 'none']
	},
	'alloc-past-limit': {
		text: '(i32.store offset=24 (local.get $slot) (call $malloc (i32.const 100000)))',
		expect: ['none', 'read-before-write']
	},
	'alloc-past-limit-use': {
		text: '(i32.store (call $malloc (i32.const 100000)) (i32.const 1))',
		expect: ['none', 'read-before-write']
	},
	'alloc-more': {
		text: '(local.set $d (call $malloc (i32.const 100)))\n(i32.store (local.get $d) (i32.const 5))',
		expect: ['none', 'ptr-deref', 'read-before-write']
	},
	'alloc-exact-limit': {
		text: `(local.set $d (call $malloc (i32.const 380)))\n(i32.store offset=376 (local.get $d) (i32.const 5))`,
		expect: ['none', 'ptr-deref', 'read-before-write']
	},
	'alloc-data-size': {
		text: '(local.set $d (call $malloc (i32.and (local.get $sum) (i32.const 31))))',
		expect: ['none', 'ptr-deref', 'read-before-write']
	},
	'alloc-data-size-use': {
		text: '(local.set $d (call $malloc (i32.and (local.get $sum) (i32.const 31))))\n(i32.store (local.get $d) (i32.const 5))',
		expect: ['ptr-deref', 'none']
	},
	'shift-base': {
		text: '(local.set $arena (i32.add (local.get $arena) (i32.const 16)))',
		expect: ['none', 'ptr-deref']
	},
	'shift-base-far': {
		text: '(local.set $arena (i32.add (local.get $arena) (i32.const 4096)))',
		expect: ['none', 'ptr-deref']
	},
	'shift-base-hash': {
		text: '(local.set $arena (i32.and (local.get $arena) (i32.const -64)))',
		expect: ['ptr-deref', 'none']
	},
	'bump-set-twice': {
		text: SET,
		expect: ['none']
	},
	'bump-set-input': {
		text: `(call $bump_set (local.get $p) (i32.const ${ARENA_BYTES}))`,
		expect: ['none', 'ptr-store']
	},
	'bump-set-big': {
		text: '(call $bump_set (local.get $arena) (i32.const 100000))',
		expect: ['none', 'ptr-deref']
	},
	'copy-arena-out': {
		text: '(memory.copy (i32.add (local.get $slot) (i32.const 32)) (local.get $a) (i32.const 8))',
		expect: ['ptr-store', 'none']
	},
	'copy-arena-data-out': {
		text: '(memory.copy (i32.add (local.get $slot) (i32.const 32)) (local.get $a) (i32.const 4))',
		expect: ['none']
	},
	'copy-out-arena': {
		text: '(memory.copy (local.get $a) (i32.add (local.get $slot) (i32.const 32)) (i32.const 4))',
		expect: ['none']
	},
	'copy-arena-dynamic': {
		text: '(memory.copy (i32.add (local.get $slot) (i32.const 32)) (local.get $a) (local.get $len))',
		expect: ['ptr-deref', 'none']
	},
	'fill-arena': {
		text: '(memory.fill (local.get $a) (i32.const 0) (i32.const 4))',
		expect: ['none']
	},
	'fill-arena-over-ptr': {
		text: '(memory.fill (i32.add (local.get $a) (i32.const 4)) (i32.const 0) (i32.const 4))',
		expect: ['none', 'ptr-deref']
	},
	'fill-window': {
		text: `(memory.fill (i32.const ${WINDOW.region}) (i32.const 0) (i32.const 16))`,
		expect: ['none', 'ptr-deref', 'read-before-write']
	},
	'fill-ptr-byte': {
		text: '(memory.fill (i32.add (local.get $slot) (i32.const 32)) (local.get $a) (i32.const 4))',
		expect: ['ptr-store', 'none']
	},
	'reload-out': {
		text: '(i32.store offset=16 (local.get $slot) (local.get $n))',
		expect: ['ptr-store', 'none']
	},
	'reload-hash': {
		text: `(if (i32.and (local.get $n) (i32.const 16)) (then ${OUT_ONE}))`,
		expect: ['ptr-control', 'none']
	},
	'stack-store-ptr': {
		text: '(i32.store offset=12 (global.get $sp) (local.get $b))',
		expect: ['ptr-store', 'none']
	},
	'indirect-call': {
		text: '(call_indirect (type $nt) (i32.const 0))',
		extra: TABLE_NOP,
		expect: ['isolation']
	},
	'trap-after-write': { text: `(if ${ODD} (then (unreachable)))`, expect: ['failure', 'none'] },
	'trap-early': { text: `(if ${ODD} (then (unreachable)))`, expect: ['none', 'failure'] }
};

export const allocModuleOf = (
	base: AllocBase,
	statements: string[] = base.statements,
	insert?: string,
	max?: number
): Uint8Array<ArrayBuffer> => {
	const add = insert ? ALLOC_INSERTS[insert] : undefined;
	const all = add?.text ? [...statements, add.text] : statements;
	const needsSp = base.stack || all.some((s) => s.includes('$sp'));
	return assemble(
		allocWat({
			body: all.join('\n\t\t'),
			extra: add?.extra ?? '',
			ret: add?.ret,
			max,
			stack: needsSp
		})
	);
};

export const allocBytes = (name: string, insert?: string, max?: number) =>
	allocModuleOf(ALLOC_BASES[name]!, undefined, insert, max);

// one minimal refusing module per provenance rule; the unit test and the rule-removal run share this list
export const ALLOC_REFUSALS: {
	name: string;
	rule: string;
	reason: string;
	build: () => Uint8Array;
}[] = [
	{
		name: 'a pointer stored to the output slot',
		rule: 'store',
		reason: 'ptr-store',
		build: () =>
			allocModuleOf(ALLOC_BASES.list!, [
				...ALLOC_BASES.list!.statements,
				ALLOC_INSERTS['store-ptr-out']!.text
			])
	},
	{
		name: 'a pointer returned from the entry',
		rule: 'return',
		reason: 'ptr-return',
		build: () => allocBytes('list', 'return-ptr')
	},
	{
		name: 'a pointer passed to an import',
		rule: 'import',
		reason: 'ptr-import',
		build: () => allocBytes('list', 'import-ptr')
	},
	{
		name: 'a pointer compared with a constant address',
		rule: 'compare',
		reason: 'ptr-compare',
		build: () => allocBytes('list', 'compare-const')
	},
	{
		name: 'a pointer hashed into a branch',
		rule: 'control',
		reason: 'ptr-control',
		build: () => allocBytes('list', 'hash-branch')
	},
	{
		name: 'a dereference outside the arena',
		rule: 'deref',
		reason: 'ptr-deref',
		build: () => allocBytes('list', 'deref-far')
	},
	{
		name: 'the cursor read before bump_set',
		rule: 'cursor',
		reason: 'read-before-write',
		build: () =>
			allocModuleOf(ALLOC_BASES.list!, [
				ALLOC_INSERTS['cursor-read-out']!.text,
				...ALLOC_BASES.list!.statements
			])
	}
];

// #region ground truth

export interface AllocOutcome {
	trapped: number | null;
	memory: Uint8Array;
}

const prng = (seed: number) => {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s & 255;
	};
};

export const arenaOf = (i: number) => ARENAS + i * SLICE;

export function layoutAlloc(view: Uint8Array, words: Uint32Array, seed: number, shift: number) {
	const next = prng(seed);
	for (let i = 0; i < RECORDS; i++) {
		const at = DATA + i * 320;
		const length = 16 + (next() % 48);
		for (let k = 0; k < length; k++) view[at + k] = next() % 254;
		words[(TABLE + 16 * i) / 4] = at;
		words[(TABLE + 16 * i + 4) / 4] = length;
		// the slice outside the arena is poison, the arena itself is data that depends on the offset only
		for (let k = 0; k < SLICE; k++) view[arenaOf(i) + k] = 0xa5;
		for (let k = 0; k < ARENA_BYTES; k++)
			view[arenaOf(i) + shift + k] = (i * 13 + k * 7 + seed) & 255;
		words[(TABLE + 16 * i + 12) / 4] = arenaOf(i) + shift;
	}
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
}

export function runAlloc(
	bytes: Uint8Array,
	seed: number,
	shift: number,
	windows?: { low: number; end: number }[]
): AllocOutcome {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	layoutAlloc(view, new Uint32Array(memory.buffer), seed, shift);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory, f: () => {} }
	});
	const bulk = instance.exports.bulk as (t: number, n: number, o: number) => number;
	const baseline = windows ? windows.map((w) => view.slice(w.low, w.end)) : [];
	let trapped: number | null = null;
	for (let i = 0; i < RECORDS; i++) {
		if (windows) windows.forEach((w, k) => view.set(baseline[k]!, w.low));
		try {
			bulk(TABLE + 16 * i, 1, OUT + 64 * i);
		} catch {
			trapped = i;
			break;
		}
	}
	return { trapped, memory: view.slice() };
}

interface Evidence {
	windows: { low: number; end: number }[];
	allocator?: { pointerCells: [number, number][]; arenaTaint?: [number, number][] };
}

/**
 * The relocation claim: the arena at its slice start and shifted by SHIFT inside the slice give the same
 * memory outside the arenas, the stack and the pointer cells of the windows, and the same arena
 * bytes outside the offsets that held a tainted value; the private-window route agrees with serial.
 */
export function relocationMatches(
	bytes: Uint8Array,
	c: Evidence,
	seeds: number[]
): { ok: boolean; why?: string } {
	const cells = c.allocator?.pointerCells ?? [];
	const tainted = c.allocator?.arenaTaint ?? [];
	const inRange = (rs: [number, number][], at: number) =>
		rs.some(([lo, end]) => at >= lo && at < end);
	for (const seed of seeds) {
		const a = runAlloc(bytes, seed, 0, undefined);
		const b = runAlloc(bytes, seed, SHIFT, undefined);
		const route = runAlloc(bytes, seed, 0, c.windows);
		if (a.trapped !== b.trapped)
			return { ok: false, why: `trap ${a.trapped} against ${b.trapped}` };
		if (a.trapped !== route.trapped)
			return { ok: false, why: 'the private route traps elsewhere' };
		if (a.trapped !== null) continue;
		const x = a.memory;
		const y = b.memory;
		const z = route.memory;
		for (let at = 0; at < x.length; at++) {
			if (x[at] !== z[at]) return { ok: false, why: `route differs at ${at}` };
			const arena = at >= ARENAS && at < ARENAS + RECORDS * SLICE;
			const stack = at >= STACK_TOP - 4096 && at < STACK_TOP;
			if (stack) continue;
			// the table's arena words are the input that differs
			if (at >= TABLE && at < TABLE + 16 * RECORDS && (at - TABLE) % 16 >= 12) continue;
			if (!arena) {
				if (x[at] !== y[at] && !inRange(cells, at))
					return { ok: false, why: `outside the arena at ${at}` };
				continue;
			}
			const rec = Math.floor((at - ARENAS) / SLICE);
			const rel = at - arenaOf(rec);
			// the slice outside the arena is poison; a write there left the arena
			if (rel >= ARENA_BYTES) {
				if (x[at] !== 0xa5) return { ok: false, why: `a write past the arena at ${at}` };
				if (rel >= SHIFT + ARENA_BYTES && y[at] !== 0xa5)
					return { ok: false, why: `a write past the shifted arena at ${at}` };
				continue;
			}
			const off = rel;
			if (off < SHIFT && y[at] !== 0xa5)
				return { ok: false, why: `a write before the shifted arena at ${at}` };
			// run b holds its arena at +SHIFT; compare byte for byte by offset outside tainted offsets
			if (inRange(tainted, rel)) continue;
			if (x[at] !== y[at + SHIFT])
				return { ok: false, why: `arena offset ${rel} of record ${rec}` };
		}
	}
	return { ok: true };
}

// #endregion
