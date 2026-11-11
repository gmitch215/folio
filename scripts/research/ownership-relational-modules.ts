import { ALLOC_BASES, allocModuleOf } from './ownership-alloc-modules.ts';
import { assemble, DATA, OUT, RECORDS, TABLE } from './ownership-modules.ts';

// hand-written token tables in the shape of jsmn: a static array of 16-byte tokens and a parser
// struct {pos, toknext, toksuper} beside it, all written through indexes read back from memory
export const TOKENS = 4096;
export const COUNT = 16;
export const PARSER = TOKENS + COUNT * 16;
export const NEXT = PARSER + 4;
export const SUPER = PARSER + 8;

export const relWat = (
	body: string,
	extra = '',
	max?: number
) => `(module (import "env" "memory" (memory 8${max ? ` ${max}` : ''}))
	${extra}
	(func $bulk (export "bulk") (param $t i32) (param $n i32) (param $o i32)
		(local $i i32) (local $p i32) (local $len i32) (local $k i32) (local $slot i32)
		(local $pos i32) (local $c i32) (local $tn i32) (local $tk i32) (local $q i32) (local $cnt i32) (local $sup i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $p (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))))
			(local.set $len (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 4)))))
			(local.set $slot (i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6))))
			${body}
			(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each))))
)`;

const INIT = `(local.set $k (i32.const 0))
			(block $z (loop $zl
				(br_if $z (i32.ge_u (local.get $k) (i32.const ${COUNT * 16})))
				(i32.store8 (i32.add (i32.const ${TOKENS}) (local.get $k)) (i32.const 0))
				(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $zl)))
			(i64.store (i32.const ${PARSER}) (i64.const 0))
			(i32.store (i32.const ${SUPER}) (i32.const -1))`;

const OPEN = `(local.set $tn (i32.load (i32.const ${NEXT})))
				(br_if $pd (i32.ge_u (local.get $tn) (i32.const ${COUNT})))
				(i32.store (i32.const ${NEXT}) (i32.add (local.get $tn) (i32.const 1)))
				(local.set $tk (i32.add (i32.const ${TOKENS}) (i32.shl (local.get $tn) (i32.const 4))))
				(i32.store (local.get $tk) (i32.const 1))
				(i32.store offset=4 (local.get $tk) (local.get $pos))
				(i32.store offset=8 (local.get $tk) (i32.const -1))
				(i32.store offset=12 (local.get $tk) (i32.const 0))
				(local.set $sup (i32.load (i32.const ${SUPER})))
				(if (i32.ne (local.get $sup) (i32.const -1))
					(then
						(local.set $q (i32.add (i32.const ${TOKENS}) (i32.shl (local.get $sup) (i32.const 4))))
						(i32.store offset=12 (local.get $q) (i32.add (i32.load offset=12 (local.get $q)) (i32.const 1)))))
				(i32.store (i32.const ${SUPER}) (local.get $tn))`;

const CLOSE = `(local.set $tn (i32.load (i32.const ${NEXT})))
				(if (i32.ge_s (i32.add (local.get $tn) (i32.const -1)) (i32.const 0))
					(then
						(local.set $cnt (local.get $tn))
						(local.set $q (i32.add (i32.const ${TOKENS - 16}) (i32.shl (local.get $tn) (i32.const 4))))
						(block $wd (loop $wl
							(if (i32.eq (i32.load offset=8 (local.get $q)) (i32.const -1))
								(then
									(i32.store offset=8 (local.get $q) (i32.add (local.get $pos) (i32.const 1)))
									(i32.store (i32.const ${SUPER}) (i32.add (local.get $cnt) (i32.const -1)))
									(br $wd)))
							(local.set $q (i32.add (local.get $q) (i32.const -16)))
							(br_if $wl (i32.gt_s (local.tee $cnt (i32.add (local.get $cnt) (i32.const -1))) (i32.const 0)))))))`;

const PARSE = `(local.set $pos (i32.const 0))
			(block $pd (loop $pl
				(br_if $pd (i32.ge_u (local.get $pos) (local.get $len)))
				(local.set $c (i32.load8_u (i32.add (local.get $p) (local.get $pos))))
				(if (i32.and (local.get $c) (i32.const 1))
					(then ${OPEN})
					(else (if (i32.and (local.get $c) (i32.const 2)) (then ${CLOSE}))))
				(local.set $pos (i32.add (local.get $pos) (i32.const 1))) (br $pl)))
			(i32.store (local.get $slot) (i32.load (i32.const ${NEXT})))
			(i32.store offset=4 (local.get $slot) (i32.load (i32.const ${SUPER})))`;

export const TOKEN_BASES: Record<string, string> = {
	tokens: `${INIT}\n${PARSE}`
};

export const tokenBytes = (name = 'tokens') => assemble(relWat(TOKEN_BASES[name]!));

// a hand mutant is the base text with one edit; a check the text still has a match keeps the operator honest
export function mutate(text: string, from: string, to: string, nth = 0): string | undefined {
	let at = -1;
	for (let k = 0; k <= nth; k++) {
		at = text.indexOf(from, at + 1);
		if (at < 0) return undefined;
	}
	return text.slice(0, at) + to + text.slice(at + from.length);
}

// named mutants the unit test and the rule-removal run share: the reason the checker must give, or none
export interface TokenMutant {
	name: string;
	from: string;
	to: string;
	nth?: number;
	reason: string;
}

export const TOKEN_MUTANTS: TokenMutant[] = [
	{
		name: 'the bound is one past the array',
		from: `(i32.ge_u (local.get $tn) (i32.const ${COUNT}))`,
		to: `(i32.ge_u (local.get $tn) (i32.const ${COUNT + 1}))`,
		reason: 'read-before-write'
	},
	{
		name: 'the bound is loaded from the window',
		from: `(i32.ge_u (local.get $tn) (i32.const ${COUNT}))`,
		to: `(i32.ge_u (local.get $tn) (i32.load (i32.const ${PARSER + 48})))`,
		reason: 'read-before-write'
	},
	{
		name: 'the bound tests another variable than the store index',
		from: `(i32.ge_u (local.get $tn) (i32.const ${COUNT}))`,
		to: `(i32.ge_u (local.get $pos) (i32.const ${COUNT}))`,
		reason: 'read-before-write'
	},
	{
		name: 'the super index is the next index, one past the last token',
		from: `(i32.store (i32.const ${SUPER}) (local.get $tn))`,
		to: `(i32.store (i32.const ${SUPER}) (i32.add (local.get $tn) (i32.const 1)))`,
		reason: 'read-before-write'
	},
	{
		name: 'the counter is incremented twice',
		from: `(i32.store (i32.const ${NEXT}) (i32.add (local.get $tn) (i32.const 1)))`,
		to: `(i32.store (i32.const ${NEXT}) (i32.add (local.get $tn) (i32.const 3)))`,
		reason: 'read-before-write'
	},
	{
		name: 'a token field holds another constant',
		from: '(i32.store offset=12 (local.get $tk) (i32.const 0))',
		to: '(i32.store offset=12 (local.get $tk) (i32.const 7))',
		reason: 'none'
	},
	{
		name: 'the sentinel test is dropped, so the super index can be minus one',
		from: '(if (i32.ne (local.get $sup) (i32.const -1))',
		to: '(if (i32.ne (local.get $sup) (i32.const -2))',
		reason: 'read-before-write'
	},
	{
		name: 'the token index wraps at zero',
		from: `(local.set $tk (i32.add (i32.const ${TOKENS}) (i32.shl (local.get $tn) (i32.const 4))))`,
		to: `(local.set $tk (i32.add (i32.const ${TOKENS}) (i32.shl (i32.add (local.get $tn) (i32.const -1)) (i32.const 4))))`,
		reason: 'final-state'
	},
	{
		name: 'the stride depends on the data',
		from: `(local.set $tk (i32.add (i32.const ${TOKENS}) (i32.shl (local.get $tn) (i32.const 4))))`,
		to: `(local.set $tk (i32.add (i32.const ${TOKENS}) (i32.mul (local.get $tn) (i32.and (local.get $c) (i32.const 31)))))`,
		reason: 'read-before-write'
	},
	{
		name: 'the walk never stops at zero',
		from: '(br_if $wl (i32.gt_s (local.tee $cnt (i32.add (local.get $cnt) (i32.const -1))) (i32.const 0)))',
		to: '(br_if $wl (i32.ne (local.tee $cnt (i32.add (local.get $cnt) (i32.const -1))) (i32.const 77)))',
		reason: 'read-before-write'
	}
];

export const mutantBytes = (m: TokenMutant) => {
	const text = mutate(relWat(TOKEN_BASES.tokens!), m.from, m.to, m.nth ?? 0);
	if (!text) throw new Error('no match for ' + m.name);
	return assemble(text);
};

// allocation extents: data-sized allocations in a loop leave the cursor unknown, then a fixed-size
// buffer is written and read at data-dependent indexes. The limit check of the allocator bounds the
// start; the indexes are masked below the buffer size, so the access is inside the arena
export interface ExtentShape {
	/** bytes of the fixed allocation */
	size: number;
	/** the index mask applied to the data */
	mask: number;
	/** the limit given to bump_set */
	limit: number;
	/** test the pointer for null before the accesses */
	guard: boolean;
	/** index with the unmasked record length */
	raw: boolean;
}

export const EXTENT_BASE: ExtentShape = { size: 32, mask: 31, limit: 512, guard: true, raw: false };

export const extentStatements = (s: ExtentShape): string[] => {
	const index = (v: string) =>
		s.raw ? `(local.get ${v})` : `(i32.and (local.get ${v}) (i32.const ${s.mask}))`;
	const access = `(i32.store8 (i32.add (local.get $a) ${index('$sum')}) (local.get $len))
		(i32.store (local.get $slot) (i32.load8_u (i32.add (local.get $a) ${index('$len')})))`;
	return [
		`(call $bump_set (local.get $arena) (i32.const ${s.limit}))`,
		'(local.set $k (i32.const 0))',
		`(block $ld (loop $ll
			(br_if $ld (i32.ge_u (local.get $k) (local.get $len)))
			(drop (call $malloc (i32.and (i32.add (local.get $k) (local.get $sum)) (i32.const 15))))
			(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $ll)))`,
		`(local.set $a (call $malloc (i32.const ${s.size})))`,
		s.guard ? `(if (local.get $a) (then ${access}))` : access
	];
};

export const extentBytes = (s: Partial<ExtentShape> = {}) =>
	allocModuleOf(ALLOC_BASES.list!, extentStatements({ ...EXTENT_BASE, ...s }));

export const EXTENT_MUTANTS: { name: string; shape: Partial<ExtentShape>; reason: string }[] = [
	{ name: 'the mask reaches past the buffer', shape: { mask: 63 }, reason: 'ptr-deref' },
	{ name: 'the index is the unmasked length', shape: { raw: true }, reason: 'ptr-deref' },
	{ name: 'the limit is past the arena', shape: { limit: 600 }, reason: 'ptr-deref' },
	{ name: 'the pointer is not tested for null', shape: { guard: false }, reason: 'ptr-deref' },
	{ name: 'the buffer is 24 bytes and the mask 31', shape: { size: 24 }, reason: 'ptr-deref' },
	{ name: 'the buffer is 40 bytes and the mask 31', shape: { size: 40 }, reason: 'none' },
	{
		name: 'the buffer is 64 bytes and the mask 63',
		shape: { size: 64, mask: 63 },
		reason: 'none'
	}
];

export { DATA, OUT, RECORDS, TABLE };
