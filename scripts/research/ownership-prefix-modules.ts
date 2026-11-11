import { assemble, driverWat } from './ownership-modules.ts';

// hand modules for the prefix-written domain: a 16-byte buffer at 4096 with its cursor at 4160 and a sink at 4164
export const PB = 4096;
export const PC = 4160;
export const PA = 4164;

const FOLD = `(func $fold
		(local $j i32) (local $s i32)
		(block $b (loop $l
			(br_if $b (i32.ge_u (local.get $j) (i32.const 16)))
			(local.set $s (i32.add (local.get $s) (i32.load8_u (i32.add (i32.const 4096) (local.get $j)))))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br $l)))
		(i32.store (i32.const 4164) (i32.add (i32.load (i32.const 4164)) (local.get $s))))`;

export const U_STORE =
	'(i32.store8 (i32.add (i32.const 4096) (local.get $c)) (i32.load8_u (local.get $p)))';
export const U_CUR =
	'(i32.store (i32.const 4160) (local.tee $c (i32.add (i32.load (i32.const 4160)) (i32.const 1))))';
export const U_IF =
	'(if (i32.eq (local.get $c) (i32.const 16)) (then (call $fold) (local.set $c (i32.const 0)) (i32.store (i32.const 4160) (i32.const 0))))';

export const updateFn = (
	store = U_STORE,
	cur = U_CUR,
	check = U_IF
) => `(func $update (param $p i32) (param $len i32)
		(local $c i32)
		(if (i32.eqz (local.get $len)) (then (return)))
		(local.set $c (i32.load (i32.const 4160)))
		(loop $l
			${store}
			${cur}
			${check}
			(local.set $p (i32.add (local.get $p) (i32.const 1)))
			(br_if $l (local.tee $len (i32.sub (local.get $len) (i32.const 1))))))`;

export const FINAL_FN = `(func $final
		(local $c i32)
		(local.set $c (i32.load (i32.const 4160)))
		(block $b (loop $l
			(br_if $b (i32.ge_u (local.get $c) (i32.const 16)))
			(i32.store8 (i32.add (i32.const 4096) (local.get $c)) (i32.const 128))
			(local.set $c (i32.add (local.get $c) (i32.const 1)))
			(br $l)))
		(call $fold))`;

// reads the written prefix back: needs the exact split, the loop bound is the cursor
export const TAIL_FN = `(func $tail
		(local $j i32) (local $s i32) (local $e i32)
		(local.set $e (i32.load (i32.const 4160)))
		(block $b (loop $l
			(br_if $b (i32.ge_u (local.get $j) (local.get $e)))
			(local.set $s (i32.add (local.get $s) (i32.load8_u (i32.add (i32.const 4096) (local.get $j)))))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br $l)))
		(i32.store (i32.const 4164) (local.get $s)))`;

// reads the first buffer byte in a callee, so the exact split decides what is written
export const PEEK_FN = `(func $peek
		(i32.store (i32.const 4168) (i32.load8_u (i32.const 4096))))`;

export interface PrefixBase {
	extra: string;
	statements: string[];
}

const INIT = [
	'(i32.store (i32.const 4160) (i32.const 0))',
	'(i32.store (i32.const 4164) (i32.const 0))'
];
const OUTPUT = '(i32.store (local.get $slot) (i32.load (i32.const 4164)))';

export const PREFIX_BASES: Record<string, PrefixBase> = {
	sha: {
		extra: [FOLD, updateFn(), FINAL_FN, PEEK_FN].join('\n\t'),
		statements: [
			...INIT,
			'(call $update (local.get $p) (local.get $len))',
			'(call $final)',
			OUTPUT
		]
	},
	tail: {
		extra: [FOLD, updateFn(), TAIL_FN].join('\n\t'),
		statements: [
			...INIT,
			'(call $update (local.get $p) (local.get $len))',
			'(call $tail)',
			'(memory.fill (i32.const 4096) (i32.const 0) (i32.const 16))',
			OUTPUT
		]
	}
};

export const prefixModuleOf = (
	base: PrefixBase,
	statements: string[] = base.statements,
	max?: number
): Uint8Array<ArrayBuffer> => {
	const wat = driverWat({ body: statements.join('\n\t\t'), extra: base.extra });
	return assemble(max ? wat.replace('(memory 8)', `(memory 8 ${max})`) : wat);
};

const WAIT = '(i32.and (local.get $len) (i32.const 1))';

// statements an insertion operator can add to the body; `expect` lists the reasons the checker may give
export const PREFIX_INSERTS: Record<string, { text: string; expect: string[] }> = {
	'read-at-cursor': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.load8_u (i32.add (i32.const 4096) (i32.load (i32.const 4160)))))',
		expect: ['none', 'read-before-write', 'prefix-cover']
	},
	'fold-early': { text: '(call $fold)', expect: ['none', 'read-before-write', 'prefix-cover'] },
	'wide-store': {
		text: '(i32.store8 (i32.add (i32.const 4096) (i32.load8_u (local.get $p))) (i32.const 1))',
		expect: ['none', 'prefix-store', 'read-before-write', 'final-state']
	},
	'copy-over-cursor': {
		text: '(memory.copy (i32.const 4160) (i32.const 4096) (i32.const 4))',
		expect: ['none', 'prefix-store', 'read-before-write']
	},
	'fill-over-cursor': {
		text: '(memory.fill (i32.const 4158) (i32.const 0) (i32.const 8))',
		expect: ['none', 'prefix-store', 'read-before-write']
	},
	'fill-buffer': {
		text: '(memory.fill (i32.const 4096) (i32.const 9) (i32.const 16))',
		expect: ['none', 'read-before-write', 'prefix-cover']
	},
	'cursor-const': {
		text: '(i32.store (i32.const 4160) (i32.const 5))',
		expect: ['none', 'prefix-cover']
	},
	'cursor-data': {
		text: '(i32.store (i32.const 4160) (i32.and (local.get $len) (i32.const 31)))',
		expect: ['none', 'prefix-cover', 'prefix-store']
	},
	'cursor-wide': {
		text: '(i64.store32 (i32.const 4160) (i64.const 0))',
		expect: ['none', 'prefix-cover', 'prefix-store']
	},
	'stale-local-store': {
		text: '(local.set $k (i32.load (i32.const 4160))) (memory.fill (i32.const 4096) (i32.const 0) (i32.const 8)) (i32.store (i32.const 4160) (i32.const 8)) (i32.store8 (i32.add (i32.const 4096) (local.get $k)) (i32.const 1)) (i32.store (i32.const 4160) (i32.add (i32.load (i32.const 4160)) (i32.const 1)))',
		expect: ['prefix-cover', 'read-before-write', 'final-state']
	},
	'cursor-byte': {
		text: '(i32.store8 (i32.const 4160) (i32.const 7))',
		expect: ['none', 'prefix-store']
	},
	'cursor-load-byte': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.load8_u (i32.const 4161)))',
		expect: ['none', 'read-before-write']
	},
	'cursor-address': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.const 4160))',
		expect: ['escape']
	},
	'trap-after-write': {
		text: `(if ${WAIT} (then (unreachable)))`,
		expect: ['failure', 'none']
	},
	'sink-read': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 12)) (i32.load (i32.const 4168)))',
		expect: ['none', 'read-before-write', 'final-state']
	},
	'read-first-byte': {
		text: '(i32.store (i32.add (local.get $slot) (i32.const 8)) (i32.load8_u (i32.const 4096)))',
		expect: ['read-before-write']
	},
	'peek-call': { text: '(call $peek)', expect: ['read-before-write'] },
	'stale-sum': {
		text: '(i32.store8 (i32.const 4096) (i32.const 1)) (i32.store (i32.const 4160) (i32.add (i32.load (i32.const 4160)) (block (result i32) (i32.store (i32.const 4160) (i32.const 0)) (i32.const 1))))',
		expect: ['prefix-cover', 'read-before-write', 'final-state']
	},
	'stale-address': {
		text: '(i32.store8 (i32.add (i32.const 4096) (i32.load (i32.const 4160))) (block (result i32) (i32.store (i32.const 4160) (i32.const 0)) (i32.const 7))) (i32.store (i32.const 4160) (i32.add (i32.load (i32.const 4160)) (i32.const 1)))',
		expect: ['prefix-cover', 'read-before-write', 'final-state']
	},
	'cursor-zero': {
		text: '(i32.store (i32.const 4160) (i32.const 0))',
		expect: ['none']
	}
};

// text edits of a whole base: each replaces one fragment and says which reasons it may give
export interface PrefixMutant {
	name: string;
	base: 'sha' | 'tail';
	edits: [string, string][];
	expect: string[];
}

const mutantExtra = (base: PrefixBase, edits: [string, string][]) => {
	let extra = base.extra;
	for (const [from, to] of edits) {
		if (!extra.includes(from)) throw new Error(`fragment missing: ${from}`);
		extra = extra.replace(from, to);
	}
	return extra;
};

export const mutantModule = (m: PrefixMutant, max?: number) => {
	const base = PREFIX_BASES[m.base]!;
	return prefixModuleOf({ ...base, extra: mutantExtra(base, m.edits) }, undefined, max);
};

const CUR_PLUS = (n: number) => U_CUR.replace('(i32.const 1))))', `(i32.const ${n}))))`);

export const PREFIX_MUTANTS: PrefixMutant[] = [
	{
		name: 'cursor-plus-two',
		base: 'sha',
		edits: [[U_CUR, CUR_PLUS(2)]],
		expect: ['prefix-cover', 'prefix-store']
	},
	{
		name: 'skip-a-byte',
		base: 'sha',
		edits: [[U_STORE, U_STORE.replace('(i32.const 4096)', '(i32.const 4097)')]],
		expect: ['prefix-cover']
	},
	{
		name: 'conditional-byte',
		base: 'sha',
		edits: [[U_STORE, `(if ${WAIT} (then ${U_STORE}))`]],
		expect: ['prefix-cover']
	},
	{
		name: 'byte-below-frontier',
		base: 'sha',
		edits: [[U_STORE, U_STORE.replace('(i32.const 4096)', '(i32.const 4095)')]],
		expect: ['prefix-cover', 'read-before-write']
	},
	{
		name: 'reset-to-five',
		base: 'sha',
		edits: [
			[
				'(local.set $c (i32.const 0)) (i32.store (i32.const 4160) (i32.const 0))',
				'(local.set $c (i32.const 5)) (i32.store (i32.const 4160) (i32.const 5))'
			]
		],
		expect: ['none', 'prefix-cover']
	},
	{
		name: 'reset-above-prefix',
		base: 'sha',
		edits: [
			[
				U_IF,
				'(if (i32.eq (local.get $c) (i32.const 8)) (then (local.set $c (i32.const 12)) (i32.store (i32.const 4160) (i32.const 12))))'
			]
		],
		expect: ['prefix-cover', 'prefix-store']
	},
	{
		name: 'check-at-63',
		base: 'sha',
		edits: [[U_IF, U_IF.replace('(i32.const 16))', '(i32.const 15))')]],
		expect: ['read-before-write', 'prefix-cover']
	},
	{
		name: 'fold-without-write',
		base: 'sha',
		edits: [[U_STORE, '(nop)']],
		expect: ['prefix-cover']
	},
	{
		name: 'cursor-twice',
		base: 'sha',
		edits: [[U_CUR, `${U_CUR}\n\t\t\t${U_CUR}`]],
		expect: ['prefix-cover']
	},
	{
		name: 'reset-skips-fold',
		base: 'sha',
		edits: [
			[
				U_IF,
				'(if (i32.eq (local.get $c) (i32.const 16)) (then (local.set $c (i32.const 0)) (i32.store (i32.const 4160) (i32.const 0))))'
			]
		],
		expect: ['none']
	},
	{
		name: 'stale-local',
		base: 'sha',
		edits: [[U_STORE, `(i32.store (i32.const 4160) (i32.const 0))\n\t\t\t${U_STORE}`]],
		expect: ['prefix-cover', 'read-before-write', 'final-state']
	},
	{
		name: 'tail-reads-past-cursor',
		base: 'tail',
		edits: [
			[
				'(br_if $b (i32.ge_u (local.get $j) (local.get $e)))',
				'(br_if $b (i32.gt_u (local.get $j) (local.get $e)))'
			]
		],
		expect: ['read-before-write']
	}
];
