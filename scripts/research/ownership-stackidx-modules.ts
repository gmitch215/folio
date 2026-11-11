import { allocModuleOf, ARENA_BYTES, type AllocBase } from './ownership-alloc-modules.ts';

// hand modules for the stack-offset interval: an array on the stack read and written at a bounded data index
const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const NODE = (name: string, size = 16) => `(local.set $${name} (call $malloc (i32.const ${size})))`;
const FRAME = '(global.set $sp (i32.sub (global.get $sp) (i32.const 64)))';
const UNFRAME = '(global.set $sp (i32.add (global.get $sp) (i32.const 64)))';
const SLOT = (value: string) => `(i32.store (local.get $slot) ${value})`;
const CELL = (offset: number, value: string) =>
	`(i32.store offset=${offset} (global.get $sp) ${value})`;
const AT = (index: string, base = 16, shift = 2) =>
	`(i32.add (i32.add (global.get $sp) (i32.const ${base})) (i32.shl ${index} (i32.const ${shift})))`;
const POINTERS = [
	NODE('a'),
	NODE('b'),
	NODE('c'),
	NODE('d'),
	CELL(16, '(local.get $a)'),
	CELL(20, '(local.get $b)'),
	CELL(24, '(local.get $c)'),
	CELL(28, '(local.get $d)')
];

export const STACKIDX_BASES: Record<string, AllocBase> = {
	mask: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(local.set $n (i32.load ${AT('(local.get $k)')}))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	compare: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 255)))',
			`(block $o
				(br_if $o (i32.ge_u (local.get $k) (i32.const 4)))
				(local.set $n (i32.load ${AT('(local.get $k)')}))
				(i32.store (local.get $n) (local.get $sum)))`,
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	constants: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a', 128),
			CELL(16, '(i32.const 16)'),
			CELL(20, '(i32.const 32)'),
			CELL(24, '(i32.const 48)'),
			CELL(28, '(i32.const 64)'),
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(local.set $d (i32.load ${AT('(local.get $k)')}))`,
			'(i32.store8 (i32.add (local.get $a) (local.get $d)) (local.get $sum))',
			SLOT('(local.get $d)'),
			UNFRAME
		]
	},
	loop: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.const 0))',
			`(block $e (loop $l
				(br_if $e (i32.ge_u (local.get $k) (i32.const 4)))
				(local.set $n (i32.load ${AT('(local.get $k)')}))
				(i32.store (local.get $n) (i32.add (local.get $sum) (local.get $k)))
				(local.set $k (i32.add (local.get $k) (i32.const 1)))
				(br $l)))`,
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	down: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(local.set $n (i32.load (i32.sub (i32.add (global.get $sp) (i32.const 28)) (i32.shl (local.get $k) (i32.const 2)))))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	offset: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(local.set $n (i32.load offset=16 (i32.add (global.get $sp) (i32.shl (local.get $k) (i32.const 2)))))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	wide: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			NODE('b'),
			CELL(16, '(local.get $a)'),
			CELL(24, '(local.get $b)'),
			'(local.set $k (i32.and (local.get $sum) (i32.const 1)))',
			`(local.set $n (i32.load ${AT('(local.get $k)', 16, 3)}))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	shifted: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.shl (local.get $sum) (i32.const 2)))',
			`(local.set $n (i32.load (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.and (local.get $k) (i32.const 12)))))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	branch: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			NODE('b'),
			CELL(16, '(local.get $a)'),
			CELL(24, '(local.get $b)'),
			`(local.set $d (select (i32.add (global.get $sp) (i32.const 16)) (i32.add (global.get $sp) (i32.const 24)) (i32.and (local.get $sum) (i32.const 1))))`,
			'(local.set $n (i32.load (local.get $d)))',
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	addmult: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(local.set $n (i32.load (i32.add (global.get $sp) (i32.add (i32.shl (local.get $k) (i32.const 2)) (i32.const 16)))))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	constadd: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(local.set $d (i32.add (global.get $sp) (i32.shl (local.get $k) (i32.const 2))))`,
			'(local.set $n (i32.load (i32.add (local.get $d) (i32.const 16))))',
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	odd: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			NODE('b'),
			CELL(17, '(local.get $a)'),
			CELL(21, '(local.get $b)'),
			'(local.set $k (i32.and (local.get $sum) (i32.const 1)))',
			`(local.set $d (i32.add (global.get $sp) (i32.shl (local.get $k) (i32.const 2))))`,
			'(local.set $n (i32.load (i32.add (local.get $d) (i32.const 17))))',
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	big: {
		stack: true,
		statements: [
			'(global.set $sp (i32.sub (global.get $sp) (i32.const 512)))',
			SET,
			NODE('a'),
			...Array.from({ length: 80 }, (_, i) => CELL(16 + 4 * i, '(local.get $a)')),
			'(local.set $k (i32.and (local.get $sum) (i32.const 127)))',
			`(block $o
				(br_if $o (i32.ge_u (local.get $k) (i32.const 80)))
				(local.set $n (i32.load ${AT('(local.get $k)')}))
				(i32.store (local.get $n) (local.get $sum)))`,
			SLOT('(i32.load (local.get $a))'),
			'(global.set $sp (i32.add (global.get $sp) (i32.const 512)))'
		]
	},
	mul: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			NODE('b'),
			CELL(16, '(local.get $a)'),
			CELL(24, '(local.get $b)'),
			'(local.set $k (i32.and (local.get $sum) (i32.const 1)))',
			`(local.set $n (i32.load (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.mul (local.get $k) (i32.const 8)))))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	joinm: {
		stack: true,
		statements: [
			FRAME,
			SET,
			...POINTERS,
			'(local.set $k (i32.and (local.get $sum) (i32.const 1)))',
			`(local.set $c (select (i32.shl (local.get $k) (i32.const 2)) (i32.const 8) (i32.and (local.get $sum) (i32.const 2))))`,
			`(local.set $n (i32.load (i32.add (i32.add (global.get $sp) (i32.const 16)) (local.get $c))))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	write: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			CELL(16, '(i32.const 1)'),
			CELL(20, '(i32.const 2)'),
			CELL(24, '(i32.const 3)'),
			CELL(28, '(i32.const 4)'),
			CELL(32, '(local.get $a)'),
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(i32.store ${AT('(local.get $k)')} (local.get $sum))`,
			'(local.set $n (i32.load offset=32 (global.get $sp)))',
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT('(i32.load offset=16 (global.get $sp))'),
			UNFRAME
		]
	},
	pointerwrite: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			NODE('b'),
			CELL(16, '(i32.const 1)'),
			CELL(20, '(i32.const 2)'),
			CELL(24, '(i32.const 3)'),
			CELL(28, '(i32.const 4)'),
			CELL(32, '(local.get $b)'),
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			`(i32.store ${AT('(local.get $k)')} (local.get $a))`,
			'(local.set $d (i32.load offset=20 (global.get $sp)))',
			'(i32.store8 (i32.add (local.get $b) (i32.and (local.get $d) (i32.const 7))) (local.get $sum))',
			SLOT('(local.get $sum)'),
			UNFRAME
		]
	}
};

export const stackIdxModule = (name: string, statements?: string[]) =>
	allocModuleOf(STACKIDX_BASES[name]!, statements);
