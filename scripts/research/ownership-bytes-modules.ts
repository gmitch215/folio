import { allocModuleOf, ARENA_BYTES, type AllocBase } from './ownership-alloc-modules.ts';

// hand modules for the byte-field rules: a switch that narrows a stored type, signed narrow loads, constant tables,
// bit tests, aligned index cells and pointer cells next to integer bytes, all in the shape of tinfl_decompress
const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const NODE = (name: string, size = 16) => `(local.set $${name} (call $malloc (i32.const ${size})))`;
const FRAME = '(global.set $sp (i32.sub (global.get $sp) (i32.const 64)))';
const UNFRAME = '(global.set $sp (i32.add (global.get $sp) (i32.const 64)))';
const SLOT = (value: string) => `(i32.store (local.get $slot) ${value})`;
const AT = (index: string, base = 16, shift = 2) =>
	`(i32.add (i32.add (global.get $sp) (i32.const ${base})) (i32.shl ${index} (i32.const ${shift})))`;

// entries 20 50 90 140 200 260 330 400 as little-endian half words
const TABLE16 =
	'(data (i32.const 100000) "\\14\\00\\32\\00\\5a\\00\\8c\\00\\c8\\00\\04\\01\\4a\\01\\90\\01")';

export const BYTES_BASES: Record<string, AllocBase> = {
	switchtype: {
		stack: true,
		statements: [
			FRAME,
			SET,
			NODE('a', 32),
			NODE('b'),
			NODE('c'),
			'(i32.store offset=20 (global.get $sp) (local.get $b))',
			'(i32.store offset=24 (global.get $sp) (local.get $c))',
			'(i32.store (local.get $a) (local.tee $k (i32.and (local.get $sum) (i32.const 3))))',
			`(block $done
				(block $t
					(block $z (br_table $z $t $t $done (local.get $k)))
					(i32.store offset=8 (local.get $slot) (i32.const 7))
					(br $done))
				(local.set $n (i32.load ${AT('(i32.load (local.get $a))')}))
				(i32.store (local.get $n) (local.get $sum)))`,
			SLOT('(i32.load (local.get $a))'),
			UNFRAME
		]
	},
	signed: {
		statements: [
			SET,
			NODE('a', 256),
			'(i32.store8 (i32.add (local.get $a) (i32.and (local.get $sum) (i32.const 31))) (local.get $sum))',
			'(local.set $d (i32.load8_s (i32.add (local.get $a) (i32.and (local.get $len) (i32.const 31)))))',
			`(if (i32.lt_s (local.get $d) (i32.const 0))
				(then (i32.store8 (i32.add (local.get $a) (i32.xor (local.get $d) (i32.const -1))) (local.get $sum)))
				(else (i32.store8 (i32.add (local.get $a) (i32.shl (local.get $d) (i32.const 1))) (local.get $sum))))`,
			SLOT('(local.get $d)')
		]
	},
	signedcmp: {
		statements: [
			SET,
			NODE('a', 16),
			'(local.set $d (i32.load8_s (i32.add (local.get $a) (i32.and (local.get $sum) (i32.const 7)))))',
			'(i32.store8 (i32.add (local.get $a) (i32.mul (i32.lt_s (local.get $d) (i32.const -200)) (i32.const 100000))) (local.get $sum))',
			SLOT('(local.get $d)')
		]
	},
	signedshl: {
		statements: [
			SET,
			NODE('c', 224),
			NODE('a', 128),
			'(local.set $d (i32.load8_s (i32.add (local.get $a) (i32.and (local.get $len) (i32.const 7)))))',
			'(i32.store8 (i32.add (local.get $a) (i32.shl (local.get $d) (i32.const 1))) (local.get $sum))',
			SLOT('(local.get $d)')
		]
	},
	switchdead: {
		statements: [
			SET,
			NODE('a', 32),
			'(local.set $k (i32.and (local.get $sum) (i32.const 1)))',
			`(block $done
				(block $bad
					(block $t (br_table $t $t $t $bad (local.get $k)))
					(i32.store8 (local.get $a) (local.get $sum))
					(br $done))
				(i32.store8 (i32.add (local.get $a) (i32.const 100000)) (local.get $sum)))`,
			SLOT('(local.get $k)')
		]
	},
	signedspan: {
		statements: [
			SET,
			NODE('a', 256),
			'(local.set $d (i32.load8_s (i32.add (local.get $a) (i32.and (local.get $len) (i32.const 7)))))',
			'(if (i32.le_s (local.get $d) (i32.const 0)) (then (i32.store8 (i32.add (local.get $a) (i32.xor (local.get $d) (i32.const -1))) (local.get $sum))))',
			SLOT('(local.get $d)')
		]
	},
	signedjoin: {
		statements: [
			SET,
			NODE('a', 256),
			'(local.set $d (i32.load8_s (i32.add (local.get $a) (i32.and (local.get $len) (i32.const 7)))))',
			'(local.set $n (select (local.get $d) (i32.const 3) (i32.and (local.get $sum) (i32.const 1))))',
			'(i32.store8 (i32.add (local.get $a) (i32.add (local.get $n) (i32.const 128))) (local.get $sum))',
			SLOT('(local.get $n)')
		]
	},
	structs: {
		extra: '(data (i32.const 100000) "\\28\\00\\00\\00\\b8\\0b\\00\\00\\50\\00\\00\\00\\b8\\0b\\00\\00\\78\\00\\00\\00\\b8\\0b\\00\\00\\a0\\00\\00\\00\\b8\\0b\\00\\00")',
		statements: [
			SET,
			NODE('a', 8),
			'(local.set $d (i32.load offset=100000 (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 3))))',
			'(i32.store8 (i32.add (local.get $a) (local.get $d)) (local.get $sum))',
			SLOT('(local.get $d)')
		]
	},
	table: {
		extra: TABLE16,
		statements: [
			SET,
			NODE('a', 8),
			'(local.set $d (i32.load16_u offset=100000 (i32.shl (i32.and (local.get $sum) (i32.const 7)) (i32.const 1))))',
			'(i32.store8 (i32.add (local.get $a) (local.get $d)) (local.get $sum))',
			SLOT('(local.get $d)')
		]
	},
	bitbranch: {
		statements: [
			SET,
			NODE('a', 128),
			'(local.set $d (i32.and (local.get $sum) (i32.const 511)))',
			`(if (i32.and (local.get $d) (i32.const 256))
				(then
					(local.set $d (i32.and (local.get $d) (i32.const 511)))
					(i32.store8 (i32.add (local.get $a) (i32.sub (local.get $d) (i32.const 256))) (local.get $sum)))
				(else (i32.store8 (i32.add (local.get $a) (local.get $d)) (local.get $sum))))`,
			SLOT('(local.get $d)')
		]
	},
	cells: {
		statements: [
			SET,
			NODE('a', 32),
			NODE('b'),
			'(i32.store (local.get $a) (i32.const 1))',
			'(i32.store offset=4 (local.get $a) (i32.const 5))',
			'(i32.store offset=8 (local.get $a) (i32.const 9))',
			'(i32.store offset=12 (local.get $a) (i32.const 3))',
			'(local.set $k (i32.and (local.get $sum) (i32.const 3)))',
			'(i32.store (i32.add (local.get $a) (i32.shl (local.get $k) (i32.const 2))) (i32.and (local.get $sum) (i32.const 7)))',
			'(local.set $d (i32.load (i32.add (local.get $a) (i32.shl (i32.and (local.get $len) (i32.const 3)) (i32.const 2)))))',
			'(i32.store8 (i32.add (local.get $b) (local.get $d)) (local.get $sum))',
			SLOT('(local.get $d)')
		]
	},
	pointers: {
		statements: [
			SET,
			NODE('a', 48),
			NODE('b', 256),
			'(i32.store offset=8 (local.get $a) (local.get $b))',
			'(i32.store8 offset=16 (local.get $a) (local.get $sum))',
			'(i32.store8 offset=17 (local.get $a) (local.get $len))',
			'(local.set $d (i32.load8_u (i32.add (i32.add (local.get $a) (i32.const 16)) (i32.and (local.get $sum) (i32.const 7)))))',
			'(i32.store8 (i32.add (local.get $b) (local.get $d)) (local.get $sum))',
			SLOT('(local.get $d)')
		]
	}
};

export const bytesModule = (name: string, statements?: string[]) =>
	allocModuleOf(BYTES_BASES[name]!, statements);
