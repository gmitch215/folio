import { allocModuleOf, ARENA_BYTES, WINDOW, type AllocBase } from './ownership-alloc-modules.ts';
import { SHIM_FUNCS } from './ownership-extent-modules.ts';

const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const GUARD = (limit: number, body: string) =>
	`(block $out (br_if $out (i32.gt_u (local.get $len) (i32.const ${limit}))) ${body})`;

// a first data-sized allocation makes the second pointer non-exact; the second size has a lower bound
// and a store at a fixed offset lies inside that bound, as the value array of yyjson_read_opts does
const second = (size: string, at: string, offset = 20) =>
	GUARD(
		480,
		`(local.set $a (call $malloc (i32.add (local.get $len) (i32.const 4))))
		(if (local.get $a) (then
			(local.set $n ${size})
			(local.set $b (call $malloc (local.get $n)))
			(if (local.get $b) (then
				(i32.store offset=${offset} ${at} (local.get $sum))
				(i32.store (local.get $slot) (i32.load offset=${offset} ${at}))))))`
	);

// the input is copied into len + 4 bytes with four zero bytes after it, `between` runs, then `scan` walks from the start
export const buffer = (between: string, scan: string, limit = 500, afterMalloc = '') => [
	SET,
	GUARD(
		limit,
		`(local.set $a (call $malloc (i32.add (local.get $len) (i32.const 4))))
		${afterMalloc}
		(if (local.get $a) (then
			(drop (call $memcpy (local.get $a) (local.get $p) (local.get $len)))
			(local.set $d (i32.add (local.get $a) (local.get $len)))
			(drop (call $memset (local.get $d) (i32.const 0) (i32.const 4)))
			${between}
			(local.set $b (local.get $a))
			${scan}
			(i32.store (local.get $slot) (i32.sub (local.get $b) (local.get $a)))))`
	)
];

const READ = '(i32.load8_u (local.get $b))';
const STEP = '(local.set $b (i32.add (local.get $b) (i32.const 1)))';
const WALK = (exit: string, body = '') =>
	`(block $x (loop $s (br_if $x ${exit}) ${body} ${STEP} (br $s)))`;
// a digit is (byte - 48) & 255 below 10; the zero byte gives 208, so a bound up to 208 stops at the padding
const DIGIT = (bound: number) =>
	WALK(
		`(i32.ge_u (i32.and (i32.sub ${READ} (i32.const 48)) (i32.const 255)) (i32.const ${bound}))`
	);
// the same test on the byte widened to 64 bits, as the number reader of yyjson does
const DIGIT64 = (bound: number) =>
	WALK(
		`(i64.gt_u (i64.add (i64.extend_i32_u (local.tee $c ${READ})) (i64.const -48)) (i64.const ${bound}))`
	);
// the byte is read into a local and tested there
const HELD = WALK('(i32.eqz (local.get $c))').replace(
	'(block $x (loop $s',
	`(block $x (loop $s (local.set $c ${READ})`
);
// a branch joins two states between the read and the test
const HELDJOIN = `(block $x (loop $s (local.set $c ${READ})
	(if (local.get $sum) (then (local.set $n (i32.const 1))))
	(br_if $x (i32.eqz (local.get $c))) ${STEP} (br $s)))`;
// a word equal to a constant with the given bytes, then a byte read ahead of the cursor
// four bytes copied to the stack and tested as a word under a mask, as the utf-8 check of yyjson does
const COPYWORD = (mask: number, k: number, at: number) =>
	WALK(
		`(i32.ne (i32.and (local.get $c) (i32.const ${mask})) (i32.const ${k}))`,
		`(i32.store offset=8 (local.get $slot) (i32.load8_u offset=${at} (local.get $b)))`
	).replace(
		'(block $x (loop $s',
		'(block $x (loop $s (drop (call $memcpy (global.get $sp) (local.get $b) (i32.const 4))) (local.set $c (i32.load (global.get $sp)))'
	);
// a switch on the byte: every arm but the default has read a nonzero byte
const SWITCHBYTE = (at: number) => `(block $x (loop $s (block $arm
	(br_table $arm $x (i32.sub ${READ} (i32.const 34))))
	(i32.store offset=8 (local.get $slot) (i32.load8_u offset=${at} (local.get $b))) ${STEP} (br $s)))`;
// two bytes tested in one condition: the loop goes on only when both are nonzero
const TWOBYTES = (at: number) =>
	WALK(
		`(i32.and (i32.or (i32.eqz ${READ}) (i32.eqz (i32.load8_u offset=1 (local.get $b)))) (i32.const 1))`,
		`(i32.store offset=8 (local.get $slot) (i32.load8_u offset=${at} (local.get $b)))`
	);
// the copied word is compared with a word the state knows from a stack cell, not with a constant in the code
const COPYCELL = (at: number) =>
	`(i32.store offset=8 (global.get $sp) (i32.const 16909060))
	${WALK(
		'(i32.ne (local.get $c) (i32.load offset=8 (global.get $sp)))',
		`(i32.store offset=8 (local.get $slot) (i32.load8_u offset=${at} (local.get $b)))`
	).replace(
		'(block $x (loop $s',
		'(block $x (loop $s (drop (call $memcpy (global.get $sp) (local.get $b) (i32.const 4))) (local.set $c (i32.load (global.get $sp)))'
	)}`;
export const STACKED = (scan: string) => [
	'(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))',
	...buffer('', scan),
	'(global.set $sp (i32.add (global.get $sp) (i32.const 16)))'
];
const WORD = (k: number, at: number) =>
	WALK(
		`(i32.ne (i32.load (local.get $b)) (i32.const ${k}))`,
		`(i32.store offset=8 (local.get $slot) (i32.load8_u offset=${at} (local.get $b)))`
	);
// a second allocation between the padding and the scan
const ALLOC_BETWEEN = `(local.set $c (call $malloc (i32.const 16)))
	(if (local.get $c) (then
		(i32.store (local.get $c) (local.get $sum))
		(i32.store offset=4 (local.get $slot) (i32.load (local.get $c)))))`;

// each base certifies unless the name says otherwise in the test; the mutants edit them
export const YYJSON_BASES: Record<string, AllocBase> = {
	digits: { extra: SHIM_FUNCS, statements: buffer('', DIGIT(10)) },
	digits208: { extra: SHIM_FUNCS, statements: buffer('', DIGIT(208)) },
	digits209: { extra: SHIM_FUNCS, statements: buffer('', DIGIT(209)) },
	held: { extra: SHIM_FUNCS, statements: buffer('', HELD) },
	heldjoin: { extra: SHIM_FUNCS, statements: buffer('', HELDJOIN) },
	copyword: {
		extra: SHIM_FUNCS,
		stack: true,
		statements: STACKED(COPYWORD(0xc0c0f0, 0x8080e0, 6))
	},
	copyword7: {
		extra: SHIM_FUNCS,
		stack: true,
		statements: STACKED(COPYWORD(0xc0c0f0, 0x8080e0, 7))
	},
	copymask: {
		extra: SHIM_FUNCS,
		stack: true,
		statements: STACKED(COPYWORD(0xc0c0f0, 0x000080e0, 6))
	},
	switchbyte: { extra: SHIM_FUNCS, statements: buffer('', SWITCHBYTE(4)) },
	switchbyte5: { extra: SHIM_FUNCS, statements: buffer('', SWITCHBYTE(5)) },
	copycell: { extra: SHIM_FUNCS, stack: true, statements: STACKED(COPYCELL(7)) },
	copycell8: { extra: SHIM_FUNCS, stack: true, statements: STACKED(COPYCELL(8)) },
	twobytes: { extra: SHIM_FUNCS, statements: buffer('', TWOBYTES(5)) },
	twobytes6: { extra: SHIM_FUNCS, statements: buffer('', TWOBYTES(6)) },
	digits64: { extra: SHIM_FUNCS, statements: buffer('', DIGIT64(9)) },
	digits64wide: { extra: SHIM_FUNCS, statements: buffer('', DIGIT64(-48)) },
	orderstale: {
		extra: SHIM_FUNCS,
		statements: buffer(
			ALLOC_BETWEEN,
			DIGIT(10),
			500,
			`(i32.store (i32.const ${WINDOW.cursor}) (i32.const 0))`
		)
	},
	word: { extra: SHIM_FUNCS, statements: buffer('', WORD(0x01020304, 7)) },
	wordtop0: { extra: SHIM_FUNCS, statements: buffer('', WORD(0x00020304, 7)) },
	order: { extra: SHIM_FUNCS, statements: buffer(ALLOC_BETWEEN, DIGIT(10)) },
	orderkill: {
		extra: SHIM_FUNCS,
		statements: buffer(`${ALLOC_BETWEEN} (i32.store8 (local.get $d) (i32.const 1))`, DIGIT(10))
	},
	second: {
		statements: [
			SET,
			second(
				'(i32.shl (i32.add (local.get $len) (i32.const 6)) (i32.const 2))',
				'(local.get $b)'
			)
		]
	},
	secondmul: {
		statements: [
			SET,
			second(
				'(i32.mul (i32.add (local.get $len) (i32.const 6)) (i32.const 4))',
				'(local.get $b)'
			)
		]
	},
	secondpast: {
		statements: [
			SET,
			second(
				'(i32.shl (i32.add (local.get $len) (i32.const 6)) (i32.const 2))',
				'(local.get $b)',
				24
			)
		]
	},
	secondshort: {
		statements: [
			SET,
			second(
				'(i32.shl (i32.add (local.get $len) (i32.const 5)) (i32.const 2))',
				'(local.get $b)',
				20
			)
		]
	}
};

export const yyjsonModule = (name: string, statements?: string[]) =>
	allocModuleOf(YYJSON_BASES[name]!, statements);

export { SHIM_FUNCS };
