import { allocModuleOf, ARENA_BYTES, type AllocBase } from './ownership-alloc-modules.ts';
import { SHIM_FUNCS } from './ownership-extent-modules.ts';

// hand modules for the md4c-html blockers: a stack struct zeroed by a long memset (a fill piece, not cells)
// and a select whose arm is cut by its own condition
const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const NODE = (name: string, size = 8) => `(local.set $${name} (call $malloc (i32.const ${size})))`;
const FRAME = '(global.set $sp (i32.sub (global.get $sp) (i32.const 512)))';
const UNFRAME = '(global.set $sp (i32.add (global.get $sp) (i32.const 512)))';
const SLOT = (value: string) => `(i32.store (local.get $slot) ${value})`;
const ZERO = (at: number, n: number, byte = 0) =>
	`(drop (call $memset (i32.add (global.get $sp) (i32.const ${at})) (i32.const ${byte}) (i32.const ${n})))`;
const FIELD = (at: number) => `(i32.load offset=${at} (global.get $sp))`;
// a store into the arena at the allocation plus a stack field: the field must be a known small number
const USE = (field: string) => `(i32.store8 (i32.add (local.get $a) ${field}) (local.get $sum))`;
const K = '(local.set $k (i32.and (local.get $sum) (i32.const 255)))';
const USE_D =
	'(i32.store8 (i32.add (local.get $a) (i32.shl (local.get $d) (i32.const 3))) (local.get $sum))';

export const CAP_BASES: Record<string, AllocBase> = {
	fillzero: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			`(i32.store offset=40 (global.get $sp) (local.get $a))`,
			USE(FIELD(120)),
			`(local.set $n (i32.load offset=40 (global.get $sp)))`,
			'(i32.store (local.get $n) (local.get $sum))',
			SLOT(FIELD(300)),
			UNFRAME
		]
	},
	fillinstr: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			'(memory.fill (i32.add (global.get $sp) (i32.const 16)) (i32.const 0) (i32.const 400))',
			USE(FIELD(120)),
			SLOT(FIELD(300)),
			UNFRAME
		]
	},
	fillbyte: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400, 2),
			USE('(i32.load8_u offset=120 (global.get $sp))'),
			SLOT('(i32.load16_u offset=300 (global.get $sp))'),
			UNFRAME
		]
	},
	fillcut: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			'(i32.store offset=120 (global.get $sp) (i32.const 8))',
			USE(FIELD(120)),
			USE(FIELD(124)),
			SLOT(FIELD(116)),
			UNFRAME
		]
	},
	fillbranch: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			'(if (i32.and (local.get $sum) (i32.const 1)) (then (i32.store offset=120 (global.get $sp) (i32.const 8))))',
			USE(FIELD(124)),
			SLOT(FIELD(300)),
			UNFRAME
		]
	},
	fillcopy: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			`(drop (call $memcpy (i32.add (global.get $sp) (i32.const 16)) (local.get $p) (i32.const 400)))`,
			SLOT(FIELD(120)),
			UNFRAME
		]
	},
	fillnest: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			'(i64.store offset=120 (global.get $sp) (i64.const 8))',
			USE(FIELD(120)),
			USE(FIELD(124)),
			SLOT(FIELD(204)),
			UNFRAME
		]
	},
	selclamp: {
		statements: [
			SET,
			NODE('a'),
			K,
			'(local.set $d (select (local.get $k) (i32.const 7) (i32.lt_u (local.get $k) (i32.const 8))))',
			USE_D,
			SLOT('(local.get $d)')
		]
	},
	selfalse: {
		statements: [
			SET,
			NODE('a'),
			K,
			'(local.set $d (select (i32.const 0) (local.get $k) (i32.ge_u (local.get $k) (i32.const 8))))',
			USE_D,
			SLOT('(local.get $d)')
		]
	},
	selmin: {
		statements: [
			SET,
			NODE('a'),
			K,
			'(local.set $c (i32.and (i32.shr_u (local.get $sum) (i32.const 8)) (i32.const 7)))',
			'(local.set $d (select (local.get $k) (local.get $c) (i32.lt_u (local.get $k) (local.get $c))))',
			USE_D,
			SLOT('(local.get $d)')
		]
	},
	selsum: {
		statements: [
			SET,
			NODE('a'),
			K,
			'(local.set $d (select (i32.add (local.get $k) (i32.const 1)) (i32.const 8) (i32.lt_u (local.get $k) (i32.const 7))))',
			USE_D,
			SLOT('(local.get $d)')
		]
	},
	fillover: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			ZERO(100, 300, 1),
			USE('(i32.shl (i32.load8_u offset=120 (global.get $sp)) (i32.const 2))'),
			USE(FIELD(412)),
			UNFRAME
		]
	},
	bulkwritten: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			'(i32.store offset=16 (global.get $sp) (local.get $sum))',
			'(i32.store offset=20 (global.get $sp) (i32.const 7))',
			'(i32.store offset=24 (global.get $sp) (i32.const 9))',
			'(i32.store offset=28 (global.get $sp) (i32.const 11))',
			'(memory.copy (local.get $slot) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16))',
			`(drop (call $memcpy (i32.add (local.get $slot) (i32.const 16)) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16)))`,
			UNFRAME
		]
	},
	bulkpad: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			ZERO(16, 32),
			'(i32.store offset=16 (global.get $sp) (local.get $sum))',
			'(i32.store offset=24 (global.get $sp) (i32.const 9))',
			'(memory.copy (local.get $slot) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16))',
			`(drop (call $memcpy (i32.add (local.get $slot) (i32.const 16)) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16)))`,
			UNFRAME
		]
	},
	bulkbig: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a', 400),
			ZERO(16, 400),
			'(i32.store offset=100 (global.get $sp) (local.get $sum))',
			'(memory.copy (local.get $a) (i32.add (global.get $sp) (i32.const 16)) (i32.const 400))',
			UNFRAME
		]
	},
	switchshift: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 64),
			K,
			`(block $out
				(block $rd (br_table $rd $out $out $out $out (i32.shr_u (local.get $k) (i32.const 6))))
				(local.set $d (i32.load8_u (i32.add (i32.add (global.get $sp) (i32.const 16)) (local.get $k))))
				(i32.store8 (i32.add (local.get $a) (i32.shl (local.get $d) (i32.const 3))) (local.get $sum)))`,
			UNFRAME
		]
	},
	fillindex: {
		stack: true,
		extra: SHIM_FUNCS,
		statements: [
			FRAME,
			SET,
			NODE('a'),
			`(drop (call $memcpy (i32.add (global.get $sp) (i32.const 16)) (local.get $p) (i32.const 400)))`,
			K.replace('255', '3'),
			SLOT(
				'(i32.load (i32.add (i32.add (global.get $sp) (i32.const 100)) (i32.shl (local.get $k) (i32.const 2))))'
			),
			UNFRAME
		]
	}
};

// modules that must stay refused, with the refusal the rules give
export const CAP_REFUSALS: Record<string, { reason: string; statements: string[] }> = {
	bulkunwritten: {
		reason: 'read-before-write',
		statements: [
			FRAME,
			SET,
			'(memory.copy (local.get $slot) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16))',
			UNFRAME
		]
	},
	bulkshim: {
		reason: 'read-before-write',
		statements: [
			FRAME,
			SET,
			`(drop (call $memcpy (local.get $slot) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16)))`,
			UNFRAME
		]
	},
	bulkhalf: {
		reason: 'read-before-write',
		statements: [
			FRAME,
			SET,
			'(i32.store offset=16 (global.get $sp) (local.get $sum))',
			'(i32.store offset=20 (global.get $sp) (i32.const 7))',
			'(memory.copy (local.get $slot) (i32.add (global.get $sp) (i32.const 16)) (i32.const 16))',
			UNFRAME
		]
	},
	bulkbigpast: {
		reason: 'read-before-write',
		statements: [
			FRAME,
			SET,
			NODE('a', 400),
			ZERO(16, 400),
			'(memory.copy (local.get $a) (i32.add (global.get $sp) (i32.const 24)) (i32.const 400))',
			UNFRAME
		]
	},
	ptrcut: {
		reason: 'ptr-deref',
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			'(i32.store offset=120 (global.get $sp) (local.get $a))',
			USE('(i32.load8_u offset=121 (global.get $sp))'),
			UNFRAME
		]
	},
	mixjoin: {
		reason: 'ptr-deref',
		statements: [
			FRAME,
			SET,
			NODE('a'),
			`(if (i32.and (local.get $sum) (i32.const 1)) (then ${ZERO(16, 400, 0)}) (else ${ZERO(16, 400, 200)}))`,
			USE('(i32.shl (i32.load8_u offset=120 (global.get $sp)) (i32.const 2))'),
			UNFRAME
		]
	},
	overbyte: {
		reason: 'ptr-deref',
		statements: [
			FRAME,
			SET,
			NODE('a'),
			ZERO(16, 400),
			ZERO(100, 300, 200),
			USE('(i32.shl (i32.load8_u offset=120 (global.get $sp)) (i32.const 2))'),
			UNFRAME
		]
	},
	indexpast: {
		reason: 'read-before-write',
		statements: [
			FRAME,
			SET,
			NODE('a'),
			`(drop (call $memcpy (i32.add (global.get $sp) (i32.const 16)) (local.get $p) (i32.const 400)))`,
			K.replace('255', '3'),
			SLOT(
				'(i32.load (i32.add (i32.add (global.get $sp) (i32.const 408)) (i32.shl (local.get $k) (i32.const 2))))'
			),
			UNFRAME
		]
	}
};

export const capModule = (name: string, statements?: string[]) =>
	allocModuleOf(CAP_BASES[name]!, statements);

export const capRefusal = (name: string) =>
	allocModuleOf(
		{ stack: true, extra: SHIM_FUNCS, statements: [] },
		CAP_REFUSALS[name]!.statements
	);
