import { allocModuleOf, type AllocBase } from './ownership-alloc-modules.ts';
import { buffer, SHIM_FUNCS, STACKED } from './ownership-yyjson-modules.ts';

const COPY = (from: string) =>
	`(drop (call $memcpy (global.get $sp) ${from} (i32.const 4)))
	(local.set $c (i32.load (global.get $sp)))`;
const AT = (local: string) => `(local.get $${local})`;
const PLUS = (n: number) => `(local.tee $acc (i32.add (local.get $acc) (i32.const ${n})))`;

// the word local joins the word of the first copy with the words of a loop that moves the address, as the
// utf-8 check of yyjson does; `moved` is the source of the copy in the loop and `after` runs after the join
const WORDJOIN = (first = AT('b'), moved = PLUS(3), after = '', step = '') => `
	${COPY(first)}
	(local.set $acc (local.get $b))
	(block $j
		(br_if $j (i32.ne (i32.and (local.get $c) (i32.const 12632304)) (i32.const 8421600)))
		(loop $l
			${step}
			${COPY(moved)}
			(br_if $l (i32.eq (i32.and (local.get $c) (i32.const 12632304)) (i32.const 8421600)))))
	${after}
	(block $x
		(br_if $x (i32.ne (i32.and (local.get $c) (i32.const 49376)) (i32.const 32960)))
		(loop $m
			${COPY(PLUS(2))}
			(br_if $m (i32.eq (i32.and (local.get $c) (i32.const 49376)) (i32.const 32960)))))
	(local.set $b (local.get $acc))`;

const word = (text: string): AllocBase => ({
	extra: SHIM_FUNCS,
	stack: true,
	statements: STACKED(text)
});

// the same, after a pointer was stored in a second allocation, so the flow-insensitive summary of the arena has a
// tainted range that the source bytes of the loop copies may overlap
const POINTER_CELL = `(local.set $c (call $malloc (i32.const 16)))
	(if (local.get $c) (then (i32.store (local.get $c) (local.get $a))))`;
const wordSummary = (text: string): AllocBase => ({
	extra: SHIM_FUNCS,
	stack: true,
	statements: [
		'(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))',
		...buffer(POINTER_CELL, text),
		'(global.set $sp (i32.add (global.get $sp) (i32.const 16)))'
	]
});

// the destination trails the source in an in-place copy: four source bytes are tested nonzero, then four are copied;
// the two arms step the source by 4 and 3 and the destination by `one` and `two`
const TEST4 = [0, 1, 2, 3]
	.map((i) => `(br_if $x (i32.eqz (i32.load8_u offset=${i} (local.get $b))))`)
	.join(' ');
const STEPS = (local: string, n: number) =>
	`(local.set $${local} (i32.add (local.get $${local}) (i32.const ${n})))`;
const TRAIL = (init = '(local.get $b)', one = 4, two = 1, extra = '', pre = '', dst = 'acc') => `
	(local.set $acc ${init})
	(block $x (loop $s
		${pre}
		${TEST4}
		${extra}
		(i32.store (local.get $${dst}) (i32.load (local.get $b)))
		(if (local.get $sum)
			(then ${STEPS('b', 4)} ${STEPS('acc', one)})
			(else ${STEPS('b', 3)} ${STEPS('acc', two)}))
		(br $s)))`;
const plain = (text: string): AllocBase => ({ extra: SHIM_FUNCS, statements: buffer('', text) });

// each base certifies unless the name says otherwise in the test; the mutants edit them
export const YYJSON2_BASES: Record<string, AllocBase> = {
	wordjoin: word(WORDJOIN()),
	wordsummary: wordSummary(WORDJOIN()),
	wordsummaryother: wordSummary(
		WORDJOIN(AT('b'), AT('a'), '', '(local.set $acc (i32.add (local.get $acc) (i32.const 3)))')
	),
	wordjoinother: word(
		WORDJOIN(AT('b'), AT('a'), '', '(local.set $acc (i32.add (local.get $acc) (i32.const 3)))')
	),
	wordjoinback: word(WORDJOIN(AT('b'), `(i32.sub ${PLUS(3)} (i32.const 1))`)),
	wordjoinmove: word(
		WORDJOIN(AT('b'), PLUS(3), '(local.set $acc (i32.add (local.get $acc) (i32.const 1)))')
	),
	wordjoinc: word(
		WORDJOIN(AT('b'), PLUS(3), '(local.set $c (i32.add (local.get $c) (i32.const 1)))')
	),
	wordjoinstore: word(WORDJOIN(AT('b'), PLUS(3), '(i32.store8 (local.get $acc) (i32.const 0))')),
	wordjoinpast: word(WORDJOIN('(i32.add (local.get $b) (i32.const 1))')),
	trail: plain(TRAIL()),
	trailup: plain(TRAIL('(local.get $b)', 5)),
	trailpast: plain(TRAIL('(i32.add (local.get $b) (i32.const 9))')),
	trailreset: plain(
		TRAIL(
			'(local.get $b)',
			4,
			1,
			'(if (local.get $sum) (then (local.set $acc (local.get $d))))'
		)
	),
	trailcopy: plain(TRAIL('(local.get $b)', 4, 1, '', '(local.set $n (local.get $acc))', 'n')),
	trailcopyup: plain(
		TRAIL(
			'(local.get $b)',
			4,
			1,
			'',
			'(local.set $n (i32.add (local.get $acc) (i32.const 9)))',
			'n'
		)
	)
};

export const yyjson2Module = (name: string, statements?: string[]) =>
	allocModuleOf(YYJSON2_BASES[name]!, statements);
