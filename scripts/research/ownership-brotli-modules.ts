import { allocModuleOf, ARENA_BYTES, type AllocBase } from './ownership-alloc-modules.ts';

const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
const NODES = [
	SET,
	'(local.set $a (call $malloc (i32.const 32)))',
	'(local.set $b (call $malloc (i32.const 64)))'
];
// the word read back from b is used as a table index, so only an exact word is proved
const USE = (offset: number) =>
	`(local.set $c (i32.load offset=${offset} (local.get $b)))
	(i32.store (i32.add (local.get $a) (i32.shl (local.get $c) (i32.const 2))) (i32.const 1))`;
const COPY = '(i64.store (local.get $b) (i64.load (local.get $a)))';

// hand-built shapes of the hasher parameter copy: one word written, the next never written, both copied as an i64
export const BROTLI_BASES: Record<string, AllocBase> = {
	pairlow: {
		statements: [...NODES, '(i32.store (local.get $a) (i32.const 40))', COPY, USE(0)]
	},
	pairhigh: {
		statements: [...NODES, '(i32.store offset=4 (local.get $a) (i32.const 40))', COPY, USE(4)]
	},
	pairdata: {
		statements: [...NODES, '(i32.store (local.get $a) (local.get $sum))', COPY, USE(0)]
	},
	pairpointer: {
		statements: [...NODES, '(i32.store (local.get $a) (local.get $b))', COPY, USE(0)]
	},
	pairpartial: {
		statements: [
			...NODES,
			'(i32.store (local.get $a) (i32.const 40))',
			COPY,
			'(i32.store8 offset=1 (local.get $b) (local.get $sum))',
			USE(0)
		]
	},
	pairbefore: {
		statements: [
			...NODES,
			'(i32.store (local.get $a) (i32.const 40))',
			'(i32.store (local.get $a) (local.get $sum))',
			COPY,
			USE(0)
		]
	},
	pairunwritten: {
		statements: [...NODES, '(i32.store (local.get $a) (i32.const 40))', COPY, USE(4)]
	},
	pairafter: {
		statements: [
			...NODES,
			'(i32.store (local.get $a) (i32.const 40))',
			COPY,
			'(i32.store (local.get $a) (local.get $sum))',
			USE(0)
		]
	},
	pairother: {
		statements: [
			...NODES,
			'(i32.store (local.get $a) (i32.const 40))',
			COPY,
			'(i32.store offset=4 (local.get $b) (local.get $sum))',
			USE(0)
		]
	}
};

// two i64 counter fields, as `input_pos_` and `last_flush_pos_`: a test of exact counters decides, and the arm that is never taken holds an unbounded store
const COUNTERS = [SET, '(local.set $a (call $malloc (i32.const 32)))'];
const STORE64 = (offset: number, value: string) =>
	`(i64.store offset=${offset} (local.get $a) ${value})`;
const LOAD64 = (offset: number) => `(i64.load offset=${offset} (local.get $a))`;
const BAD = '(i32.store (i32.add (local.get $a) (local.get $sum)) (i32.const 1))';
const GUARD64 = (cond: string) => `(if ${cond} (then (nop)) (else ${BAD}))`;

Object.assign(BROTLI_BASES, {
	i64eq: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 0)'),
			STORE64(8, '(i64.const 0)'),
			GUARD64(`(i64.eq ${LOAD64(0)} ${LOAD64(8)})`)
		]
	},
	i64ne: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 0)'),
			STORE64(8, '(i64.const 1)'),
			GUARD64(`(i64.eq ${LOAD64(0)} ${LOAD64(8)})`)
		]
	},
	i64add: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 0)'),
			STORE64(8, '(i64.const 70000)'),
			STORE64(0, `(i64.add ${LOAD64(0)} (i64.const 70000))`),
			GUARD64(`(i64.eq ${LOAD64(0)} ${LOAD64(8)})`)
		]
	},
	i64add1: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 0)'),
			STORE64(8, '(i64.const 70000)'),
			STORE64(0, `(i64.add ${LOAD64(0)} (i64.const 70001))`),
			GUARD64(`(i64.eq ${LOAD64(0)} ${LOAD64(8)})`)
		]
	},
	i64less: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 0)'),
			GUARD64(`(i64.lt_u ${LOAD64(0)} (i64.const 65536))`)
		]
	},
	i64lessnot: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 65536)'),
			GUARD64(`(i64.lt_u ${LOAD64(0)} (i64.const 65536))`)
		]
	},
	i64signed: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.sub (i64.const 0) (i64.const 1))'),
			GUARD64(`(i64.lt_s ${LOAD64(0)} (i64.const 0))`)
		]
	},
	i64unsigned: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.sub (i64.const 0) (i64.const 1))'),
			GUARD64(`(i64.lt_u ${LOAD64(0)} (i64.const 0))`)
		]
	},
	i64wrap: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 4)'),
			`(i32.store (i32.add (local.get $a) (i32.wrap_i64 (i64.shl ${LOAD64(0)} (i64.const 2)))) (i32.const 1))`
		]
	},
	i64extend: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.extend_i32_u (i32.const 4))'),
			`(i32.store (i32.add (local.get $a) (i32.wrap_i64 ${LOAD64(0)})) (i32.const 1))`
		]
	},
	i64data: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.extend_i32_u (local.get $sum))'),
			`(i32.store (i32.add (local.get $a) (i32.wrap_i64 ${LOAD64(0)})) (i32.const 1))`
		]
	},
	i64half: {
		statements: [
			...COUNTERS,
			STORE64(0, '(i64.const 0)'),
			'(i32.store8 offset=1 (local.get $a) (local.get $sum))',
			GUARD64(`(i64.eq ${LOAD64(0)} (i64.const 0))`)
		]
	}
});

// the remaining block size of the ring buffer: block - delta when delta < block, else 0, with the same locals on both sides
const remaining = ({
	sub = '(i32.sub (local.tee $k (i32.shl (i32.const 1) (local.get $lg))) (i32.wrap_i64 (local.tee $d (i64.sub (local.get $pos) (local.get $flush)))))',
	cond = '(i64.lt_u (local.get $d) (i64.extend_i32_u (local.get $k)))',
	other = '(i32.const 0)'
}) => `
 (func $remaining (param $pos i64) (param $flush i64) (param $lg i32) (param $z i32) (result i32)
  (local $k i32) (local $d i64)
  (select ${sub} ${other} ${cond}))`;

const CALL =
	'(call $remaining (i64.extend_i32_u (local.get $sum)) (i64.const 0) (i32.const 4) (i32.const 0))';
const USE_REMAINING = (call: string) => [
	...COUNTERS,
	`(i32.store (i32.add (local.get $a) (i32.shl ${call} (i32.const 2))) (i32.const 1))`
];

// the i32 form of the same idiom
const remaining32 = (cond: string) => `
 (func $remaining (param $pos i32) (param $flush i32) (param $lg i32) (param $z i32) (result i32)
  (local $k i32) (local $d i32)
  (select
   (i32.sub (local.tee $k (i32.shl (i32.const 1) (local.get $lg))) (local.tee $d (i32.sub (local.get $pos) (local.get $flush))))
   (i32.const 0)
   ${cond}))`;
const CALL32 = '(call $remaining (local.get $sum) (i32.const 0) (i32.const 4) (i32.const 0))';

Object.assign(BROTLI_BASES, {
	satsub: { extra: remaining({}), statements: USE_REMAINING(CALL) },
	satsub32: {
		extra: remaining32('(i32.lt_u (local.get $d) (local.get $k))'),
		statements: USE_REMAINING(CALL32)
	},
	satsubge: {
		extra: remaining({ cond: '(i64.ge_u (local.get $d) (i64.extend_i32_u (local.get $k)))' }),
		statements: USE_REMAINING(CALL)
	},
	satsubsigned: {
		extra: remaining({ cond: '(i64.lt_s (local.get $d) (i64.extend_i32_u (local.get $k)))' }),
		statements: USE_REMAINING(CALL)
	},
	satsubother: {
		extra: remaining({ cond: '(i64.lt_u (local.get $d) (i64.extend_i32_u (local.get $lg)))' }),
		statements: USE_REMAINING(CALL)
	},
	satsubswap: {
		extra: remaining({
			sub: '(i32.sub (i32.wrap_i64 (local.tee $d (i64.sub (local.get $pos) (local.get $flush)))) (local.tee $k (i32.shl (i32.const 1) (local.get $lg))))'
		}),
		statements: USE_REMAINING(CALL)
	},
	satsubdata: {
		extra: remaining({ other: '(local.get $z)' }),
		statements: USE_REMAINING(
			'(call $remaining (i64.extend_i32_u (local.get $sum)) (i64.const 0) (i32.const 4) (local.get $sum))'
		)
	},
	satsubbig: {
		extra: remaining({}),
		statements: USE_REMAINING(
			'(call $remaining (i64.extend_i32_u (local.get $sum)) (i64.const 0) (i32.and (local.get $sum) (i32.const 31)) (i32.const 0))'
		)
	},
	satsubtaint: {
		extra: remaining({}),
		statements: [
			...COUNTERS,
			'(i32.store (local.get $slot) (call $remaining (i64.extend_i32_u (local.get $sum)) (i64.const 0) (i32.and (local.get $a) (i32.const 3)) (i32.const 0)))'
		]
	},
	satsubwide: {
		extra: remaining({ cond: '(i64.lt_u (local.get $d) (i64.const 4294967296))' }),
		statements: USE_REMAINING(CALL)
	},
	satsub32ge: {
		extra: remaining32('(i32.ge_u (local.get $d) (local.get $k))'),
		statements: USE_REMAINING(CALL32)
	},
	satsub32signed: {
		extra: remaining32('(i32.lt_s (local.get $d) (local.get $k))'),
		statements: USE_REMAINING(CALL32)
	}
});

// two adjacent pointers copied as one i64, as the hasher initialiser copies extra[0] and extra[1]
const POINTERS = [
	...NODES,
	'(i32.store (local.get $a) (local.get $b))',
	'(i32.store offset=4 (local.get $a) (local.get $a))',
	'(i64.store offset=8 (local.get $a) (i64.load (local.get $a)))'
];

Object.assign(BROTLI_BASES, {
	pairptr: {
		statements: [
			...POINTERS,
			'(local.set $c (i32.load offset=8 (local.get $a)))',
			'(i32.store (i32.add (local.get $c) (i32.const 8)) (i32.const 1))'
		]
	},
	pairptrdata: {
		statements: [
			...NODES,
			'(i32.store (local.get $a) (local.get $sum))',
			'(i32.store offset=4 (local.get $a) (local.get $sum))',
			'(i64.store offset=8 (local.get $a) (i64.load (local.get $a)))',
			'(local.set $c (i32.load offset=8 (local.get $a)))',
			'(i32.store (i32.add (local.get $a) (local.get $c)) (i32.const 1))'
		]
	},
	pairptrsecond: {
		statements: [
			...POINTERS,
			'(local.set $c (i32.load offset=12 (local.get $a)))',
			'(i32.store (i32.add (local.get $c) (i32.const 8)) (i32.const 1))'
		]
	},
	pairptrcmp: {
		statements: [
			...POINTERS,
			'(if (i32.eq (i32.load offset=8 (local.get $a)) (local.get $b)) (then (nop)) (else (i32.store (i32.add (local.get $a) (local.get $sum)) (i32.const 1))))'
		]
	},
	pairptrdiff: {
		statements: [
			...POINTERS,
			'(i32.store (local.get $slot) (i32.sub (i32.load offset=12 (local.get $a)) (i32.load offset=8 (local.get $a))))'
		]
	},
	pairptragain: {
		statements: [
			...POINTERS,
			'(i64.store offset=16 (local.get $a) (i64.load offset=8 (local.get $a)))',
			'(local.set $c (i32.load offset=16 (local.get $a)))',
			'(i32.store (i32.add (local.get $c) (i32.const 8)) (i32.const 1))'
		]
	},
	pairptrhalf: {
		statements: [
			...NODES,
			'(i32.store (local.get $a) (local.get $b))',
			'(i64.store offset=8 (local.get $a) (i64.load (local.get $a)))',
			'(local.set $c (i32.load offset=8 (local.get $a)))',
			'(i32.store (i32.add (local.get $c) (i32.const 8)) (i32.const 1))'
		]
	},
	satsubleft: {
		extra: remaining({ cond: '(i64.lt_u (local.get $pos) (i64.extend_i32_u (local.get $k)))' }),
		statements: USE_REMAINING(CALL)
	},
	satsubeffect: {
		extra: remaining({ other: '(local.tee $k (i32.const 1))' }),
		statements: USE_REMAINING(
			'(call $remaining (i64.extend_i32_u (local.get $sum)) (i64.const 0) (i32.const 20) (i32.const 0))'
		)
	}
});

// a pointer cell that is null while its count cell is zero, as `buffer_` and `cur_size_` of the ring buffer:
// the loop head joins the world before the first allocation with the worlds after it
const WORLDS = (before: string, between: string, after: string) => [
	SET,
	'(local.set $a (call $malloc (i32.const 32)))',
	'(local.set $b (call $malloc (i32.const 16)))',
	'(i32.store (local.get $a) (i32.const 0))',
	'(i32.store offset=4 (local.get $a) (i32.const 0))',
	`(block $out (loop $l
		(local.set $n (i32.add (local.get $n) (i32.const 1)))
		(br_if $out (i32.gt_u (local.get $n) (local.get $len)))
		(if (i32.eqz (i32.load offset=4 (local.get $a))) (then
			${before}
			(i32.store (local.get $a) (local.get $b))
			(i32.store offset=4 (local.get $a) (i32.const 1))))
		${between}
		(if (i32.load offset=4 (local.get $a)) (then
			(i32.store (i32.load (local.get $a)) (i32.const 7))))
		${after}
		(br $l)))`
];

Object.assign(BROTLI_BASES, {
	world: { statements: WORLDS('', '', '') },
	worldback: {
		statements: WORLDS('', '', '(if (i32.and (local.get $sum) (i32.const 1)) (then (br $l)))')
	},
	worldcount: {
		statements: WORLDS(
			'',
			'',
			'(if (i32.and (local.get $sum) (i32.const 1)) (then (i32.store offset=8 (local.get $a) (local.get $n))))'
		)
	},
	worldstore: { statements: WORLDS('', '(i32.store (local.get $a) (local.get $sum))', '') },
	worldcounter: {
		statements: [
			...WORLDS('', '', '').slice(0, 5),
			`(block $out (loop $l
				(local.set $n (i32.add (local.get $n) (i32.const 1)))
				(br_if $out (i32.gt_u (local.get $n) (local.get $len)))
				(if (i32.eqz (i32.load offset=4 (local.get $a))) (then
					(i32.store offset=4 (local.get $a) (i32.const 1))))
				(if (i32.load offset=4 (local.get $a)) (then
					(i32.store (i32.load (local.get $a)) (i32.const 7))))
				(br $l)))`
		]
	},
	worldmix: {
		statements: WORLDS(
			'',
			'',
			'(if (i32.and (local.get $sum) (i32.const 1)) (then (i32.store (local.get $a) (i32.const 0))))'
		)
	},
	worldsecond: {
		statements: WORLDS(
			'(i32.store offset=8 (local.get $a) (local.get $b))',
			'',
			'(i32.store (i32.load offset=8 (local.get $a)) (i32.const 3))'
		)
	}
});

// a pointer that steps up while a guarded counter steps down, as `PrepareH40` hashes data[0..input_size)
const CURSOR = ({
	guard = 300,
	set = '(local.set $n (local.get $len))',
	store = '(i32.store8 (local.get $c) (i32.const 1))',
	move = '(local.set $c (i32.add (local.get $c) (i32.const 1)))',
	dec = '(local.tee $n (i32.add (local.get $n) (i32.const -1)))',
	gap = ''
}) => [
	SET,
	'(local.set $a (call $malloc (i32.const 400)))',
	`(block $done
		(br_if $done (i32.gt_u (local.get $len) (i32.const ${guard})))
		(br_if $done (i32.eqz (local.get $len)))
		${set}
		(local.set $c (local.get $a))
		(loop $l
			${store}
			${move}
			${gap}
			(br_if $l ${dec})))`
];

Object.assign(BROTLI_BASES, {
	curdec: { statements: CURSOR({}) },
	curword: {
		statements: CURSOR({
			guard: 100,
			store: '(i32.store (local.get $c) (i32.const 1))',
			move: '(local.set $c (i32.add (local.get $c) (i32.const 4)))'
		})
	},
	curdecskip: {
		statements: CURSOR({
			dec: '(local.get $n)',
			gap: '(if (i32.and (local.get $sum) (i32.const 1)) (then (local.set $n (i32.add (local.get $n) (i32.const -1)))))'
		})
	},
	curtwice: {
		statements: CURSOR({
			move: '(local.set $c (i32.add (local.get $c) (i32.const 1))) (local.set $c (i32.add (local.get $c) (i32.const 1)))'
		})
	},
	curbig: { statements: CURSOR({ guard: 500 }) },
	curreset: { statements: CURSOR({ set: '(local.set $n (local.get $sum))' }) },
	curstep2: {
		statements: CURSOR({ dec: '(local.tee $n (i32.add (local.get $n) (i32.const -2)))' })
	},
	curwordbig: {
		statements: CURSOR({
			store: '(i32.store (local.get $c) (i32.const 1))',
			move: '(local.set $c (i32.add (local.get $c) (i32.const 4)))'
		})
	},
	curbump: {
		statements: CURSOR({ gap: '(local.set $n (i32.add (local.get $n) (local.get $sum)))' })
	},
	curpdown: {
		statements: CURSOR({
			move: '(local.set $c (i32.sub (local.get $c) (i32.const 1)))'
		})
	},
	curarms: {
		statements: CURSOR({
			move: '(if (i32.and (local.get $sum) (i32.const 1)) (then (local.set $c (i32.add (local.get $c) (i32.const 1)))) (else (local.set $c (i32.add (i32.const 1) (local.get $c)))))'
		})
	},
	curarmsdiff: {
		statements: CURSOR({
			move: '(if (i32.and (local.get $sum) (i32.const 1)) (then (local.set $c (i32.add (local.get $c) (i32.const 1)))) (else (local.set $c (i32.add (local.get $c) (i32.const 2)))))'
		})
	}
});

// the low word of an i64 difference, as `EncodeData` takes `bytes = (uint32_t)delta` before `if (delta > block) return`
const lowWord = ({
	cond = '(i64.gt_u (local.get $delta) (i64.extend_i32_u (i32.shl (i32.const 1) (local.get $lg))))',
	other = '(local.tee $delta (i64.sub (local.get $pos) (local.get $flush)))',
	arms = '(then (return (i32.const 0)))',
	mid = ''
}) => `
 (func $lowword (param $pos i64) (param $flush i64) (param $lg i32) (param $z i32) (result i32)
  (local $delta i64) (local $bytes i32) (local $o i64)
  (local.set $bytes (i32.wrap_i64 ${other}))
  (if ${cond} ${arms})
  ${mid}
  (local.get $bytes))`;
const LOWCALL = (lg: number | string) =>
	`(call $lowword (i64.extend_i32_u (local.get $sum)) (i64.const 0) ${typeof lg === 'number' ? `(i32.const ${lg})` : lg} (local.get $sum))`;
const USE_LOW = (lg: number | string) => [
	...COUNTERS,
	`(i32.store (i32.add (local.get $a) ${LOWCALL(lg)}) (i32.const 1))`
];

Object.assign(BROTLI_BASES, {
	lwcert: { extra: lowWord({}), statements: USE_LOW(4) },
	lwjoin: {
		extra: lowWord({
			mid: '(if (local.get $z) (then (local.set $o (i64.const 1))) (else (local.set $o (i64.const 2))))'
		}),
		statements: USE_LOW(4)
	},
	lwrange: {
		extra: lowWord({
			cond: '(i64.gt_u (local.get $delta) (i64.extend_i32_u (i32.and (local.get $z) (i32.const 31))))'
		}),
		statements: USE_LOW(4)
	},
	lwle: {
		extra: lowWord({
			cond: '(i64.le_u (local.get $delta) (i64.extend_i32_u (i32.shl (i32.const 1) (local.get $lg))))',
			arms: '(then (return (local.get $bytes))) (else (return (i32.const 0)))'
		}),
		statements: USE_LOW(4)
	},
	lwconst: {
		extra: lowWord({ cond: '(i64.gt_u (local.get $delta) (i64.const 16))' }),
		statements: USE_LOW(4)
	},
	lwnone: { extra: lowWord({ arms: '(then (nop))' }), statements: USE_LOW(4) },
	lwbig: { extra: lowWord({}), statements: USE_LOW(9) },
	lwreverse: {
		extra: lowWord({
			cond: '(i64.lt_u (local.get $delta) (i64.extend_i32_u (i32.shl (i32.const 1) (local.get $lg))))'
		}),
		statements: USE_LOW(4)
	},
	lwsigned: {
		extra: lowWord({
			cond: '(i64.gt_s (local.get $delta) (i64.extend_i32_u (i32.shl (i32.const 1) (local.get $lg))))'
		}),
		statements: USE_LOW(4)
	},
	lwother: {
		extra: lowWord({
			other: '(i64.sub (local.get $pos) (local.get $flush))',
			cond: '(i64.gt_u (local.tee $o (i64.sub (local.get $flush) (local.get $pos))) (i64.extend_i32_u (i32.shl (i32.const 1) (local.get $lg))))'
		}),
		statements: USE_LOW(4)
	},
	lwge: {
		extra: lowWord({
			cond: '(i64.ge_u (local.get $delta) (i64.extend_i32_u (i32.shl (i32.const 1) (local.get $lg))))'
		}),
		statements: USE_LOW(4)
	}
});

// a plain offset added to a pointer, tested against a limit pointer at the bottom of the loop, as the match length loop of `CreateBackwardReferencesNH40`
const POINTERS_LOOP = ({
	limit = '(i32.add (local.get $a) (i32.and (local.get $sum) (i32.const 255)))',
	store = '(i32.store (i32.add (local.get $a) (local.get $n)) (i32.const 1))',
	test = '(i32.le_u (i32.add (local.get $a) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (local.get $d))',
	pre = ''
}) => [
	SET,
	'(local.set $a (call $malloc (i32.const 400)))',
	`(local.set $d ${limit})`,
	'(local.set $n (i32.const 0))',
	pre,
	`(loop $l
		${store}
		(br_if $l ${test}))`
];

Object.assign(BROTLI_BASES, {
	ptrle: { statements: POINTERS_LOOP({}) },
	ptrlt: {
		statements: POINTERS_LOOP({
			test: '(i32.lt_u (i32.add (local.get $a) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (local.get $d))'
		})
	},
	ptrswap: {
		statements: POINTERS_LOOP({
			test: '(i32.ge_u (local.get $d) (i32.add (local.get $a) (local.tee $n (i32.add (local.get $n) (i32.const 4)))))'
		})
	},
	ptrcursor: {
		statements: POINTERS_LOOP({
			store: '(i32.store (local.get $c) (i32.const 1))',
			pre: '(local.set $c (local.get $a))',
			test: '(i32.le_u (local.tee $c (i32.add (local.get $c) (i32.const 4))) (local.get $d))'
		})
	},
	ptrbig: {
		statements: POINTERS_LOOP({
			limit: '(i32.add (local.get $a) (i32.and (local.get $sum) (i32.const 1023)))'
		})
	},
	ptrreverse: {
		statements: POINTERS_LOOP({
			test: '(i32.ge_u (i32.add (local.get $a) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (local.get $d))'
		})
	},
	ptrsigned: {
		statements: POINTERS_LOOP({
			test: '(i32.le_s (i32.add (local.get $a) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (local.get $d))'
		})
	},
	ptrsplit: {
		statements: POINTERS_LOOP({
			pre: '(local.set $acc (i32.const 0))',
			store: '(i32.store (i32.add (local.get $a) (local.get $n)) (i32.const 1)) (local.set $n (i32.add (local.get $n) (i32.const 8)))',
			test: '(i32.le_u (i32.add (local.get $a) (local.tee $acc (i32.add (local.get $acc) (i32.const 4)))) (local.get $d))'
		})
	},
	ptrsame: {
		statements: POINTERS_LOOP({
			pre: '(local.set $acc (i32.const 0))',
			store: '(i32.store (i32.add (local.get $a) (local.get $n)) (i32.const 1)) (local.set $n (i32.add (local.get $n) (i32.const 4)))',
			test: '(i32.le_u (i32.add (local.get $a) (local.tee $acc (i32.add (local.get $acc) (i32.const 4)))) (local.get $d))'
		})
	},
	ptrrightset: {
		statements: POINTERS_LOOP({
			test: '(i32.le_u (i32.add (local.get $a) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (block (result i32) (local.set $n (i32.and (local.get $sum) (i32.const 1048575))) (local.get $d)))'
		})
	}
});

// a plain counter steps with a pointer cursor that a limit pointer bounds, as the byte tail of the match length loop:
// the access a + n needs n <= off(c) + K
const TAIL = ({
	limit = '(i32.add (local.get $b) (i32.and (local.get $sum) (i32.const 127)))',
	count = '(local.set $n (i32.const 0))',
	start = '(local.set $c (local.get $b))',
	store = '(i32.store8 (i32.add (local.get $a) (local.get $n)) (i32.const 1))',
	bump = '(local.set $n (i32.add (local.get $n) (i32.const 1)))',
	move = '(local.tee $c (i32.add (local.get $c) (i32.const 1)))',
	after = '',
	cmp = 'i32.lt_u'
}) => [
	SET,
	'(local.set $a (call $malloc (i32.const 200)))',
	'(local.set $b (call $malloc (i32.const 200)))',
	`(local.set $d ${limit})`,
	count,
	start,
	`(loop $l
		${store}
		${bump}
		${after}
		(br_if $l (${cmp} ${move} (local.get $d))))`
];

const ONE = '(i32.const 1)';
const COUNT_PATH = (amount: string) =>
	`(if (i32.and (local.get $sum) ${ONE}) (then (local.set $n (i32.add (local.get $n) (i32.const ${amount})))) (else (local.set $n (i32.add (local.get $n) ${ONE}))))`;

Object.assign(BROTLI_BASES, {
	tail: { statements: TAIL({}) },
	tailmid: {
		statements: TAIL({
			store: '',
			after: '(i32.store8 (i32.add (local.get $a) (local.get $n)) (i32.const 1))'
		})
	},
	tailspread: {
		statements: TAIL({
			count: '(local.set $n (i32.and (local.get $sum) (i32.const 7)))',
			start: '(local.set $c (i32.add (local.get $b) (i32.and (local.get $sum) (i32.const 7))))'
		})
	},
	tailcount2: {
		statements: TAIL({ bump: '(local.set $n (i32.add (local.get $n) (i32.const 2)))' })
	},
	tailptr2: {
		statements: TAIL({ move: '(local.tee $c (i32.add (local.get $c) (i32.const 2)))' })
	},
	tailtwice: { statements: TAIL({ bump: COUNT_PATH('2') }) },
	tailstill: { statements: TAIL({ move: '(local.get $c)' }) },
	tailbig: {
		statements: TAIL({
			limit: '(i32.add (local.get $b) (i32.and (local.get $sum) (i32.const 1023)))'
		})
	},
	tailfar: {
		statements: TAIL({
			limit: '(i32.add (local.get $a) (i32.and (local.get $sum) (i32.const 1023)))'
		})
	},
	tailreset: {
		statements: TAIL({ after: '(local.set $n (i32.and (local.get $sum) (i32.const 1023)))' })
	},
	tailbump: {
		statements: TAIL({ after: '(local.set $n (i32.add (local.get $n) (local.get $sum)))' })
	},
	tailstart: { statements: TAIL({ count: '(local.set $n (local.get $sum))' }) },
	tailpdown: {
		statements: TAIL({ move: '(local.tee $c (i32.sub (local.get $c) (i32.const 1)))' })
	},
	tailsum: {
		statements: TAIL({
			limit: '(local.get $b)',
			start: '(local.set $c (i32.add (local.get $b) (i32.const 600)))',
			move: '(local.tee $c (i32.sub (local.get $c) (i32.const 1)))',
			cmp: 'i32.gt_u'
		})
	},
	tailzero: {
		statements: TAIL({ move: '(local.tee $c (i32.add (local.get $c) (i32.const 0)))' })
	},
	tailsigned: {
		statements: [
			...TAIL({}).slice(0, 6),
			`(loop $l
				(i32.store8 (i32.add (local.get $a) (local.get $n)) (i32.const 1))
				(local.set $n (i32.add (local.get $n) (i32.const 1)))
				(br_if $l (i32.lt_s (local.tee $c (i32.add (local.get $c) (i32.const 1))) (local.get $d))))`
		]
	}
});

// a constant table of bytes or half words read at an interval index, as the hash tables of the static dictionary: the
// read is bounded by the hull of the entries the index may name, and the hull decides an access in the arena
const DICT_AT = 100000;
const hexOf = (bytes: number[]) =>
	bytes.map((b) => '\\' + b.toString(16).padStart(2, '0')).join('');
const DICT = ({
	size = 32768,
	wide = false,
	mask = 32767,
	off = 0,
	bigAt = -1,
	bigValue = 200,
	store = '',
	read = ''
}): AllocBase => {
	const entry = (i: number) => (i === bigAt ? bigValue : wide ? (i * 13) % 100 : (i * 7) % 25);
	const table = Array.from({ length: size }, (_, i) => entry(i));
	const data = wide ? table.flatMap((x) => [x & 255, x >> 8]) : table;
	const idx = `(i32.add (i32.and (local.get $sum) (i32.const ${mask})) (i32.const ${off}))`;
	const at = wide
		? `(i32.add (i32.const ${DICT_AT}) (i32.shl ${idx} (i32.const 1)))`
		: `(i32.add (i32.const ${DICT_AT}) ${idx})`;
	return {
		extra: `(data (i32.const ${DICT_AT}) "${hexOf(data)}")`,
		statements: [
			SET,
			'(local.set $a (call $malloc (i32.const 32)))',
			store,
			`(local.set $d (${wide ? 'i32.load16_u' : 'i32.load8_u'} ${read || at}))`,
			`(i32.store8 (i32.add (local.get $a) (i32.shl (local.get $d) (i32.const ${wide ? 0 : 4}))) (i32.const 1))`
		]
	};
};

Object.assign(BROTLI_BASES, {
	dictbyte: DICT({}),
	dictword: DICT({ wide: true }),
	dictpast: DICT({ mask: 65535 }),
	dictpastone: DICT({ off: 1 }),
	dictbigval: DICT({ bigAt: 30001 }),
	dictwordbig: DICT({ wide: true, bigAt: 20000, bigValue: 1000 }),
	dictstore: DICT({
		store: `(i32.store8 (i32.add (i32.const ${DICT_AT}) (i32.and (local.get $sum) (i32.const 255))) (local.get $sum))`
	}),
	dictstoreword: DICT({
		wide: true,
		store: `(i32.store8 (i32.add (i32.const ${DICT_AT + 64000}) (i32.and (local.get $sum) (i32.const 255))) (local.get $sum))`
	})
});

// a plain value plus a plain counter against a plain bound, as the 4-byte match loop over a dictionary word: the
// counter is cut by the bound minus the addend, and the cut decides the arena access a + n
const SUM = ({
	base = '(i32.and (local.get $sum) (i32.const 31))',
	len = `(i32.load8_u (i32.add (i32.const ${DICT_AT}) (i32.and (local.get $sum) (i32.const 32767))))`,
	bound = '(i32.add (local.get $c) (local.get $acc))',
	bump = '(local.set $n (i32.add (local.get $n) (i32.const 4)))',
	test = '(i32.le_u (i32.add (local.get $c) (local.get $n)) (local.get $d))',
	store = '(i32.store8 (i32.add (local.get $a) (local.get $n)) (i32.const 1))',
	after = ''
}): AllocBase => ({
	extra: DICT({}).extra,
	statements: [
		SET,
		'(local.set $a (call $malloc (i32.const 200)))',
		`(local.set $c ${base})`,
		`(local.set $acc ${len})`,
		`(local.set $d ${bound})`,
		'(local.set $n (i32.const 0))',
		`(loop $l
			${store}
			${bump}
			${after}
			(br_if $l ${test}))`
	]
});

const SUMTEE = (test: string) =>
	`(${test} (i32.add (local.get $c) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (local.get $d))`;

Object.assign(BROTLI_BASES, {
	sumle: SUM({ bump: '', test: SUMTEE('i32.le_u') }),
	sumlt: SUM({ bump: '', test: SUMTEE('i32.lt_u') }),
	sumswap: SUM({
		bump: '',
		test: '(i32.ge_u (local.get $d) (i32.add (local.get $c) (local.tee $n (i32.add (local.get $n) (i32.const 4)))))'
	}),
	sumgt: SUM({
		bump: '',
		test: '(i32.eqz (i32.gt_u (i32.add (local.get $c) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (local.get $d)))'
	}),
	sumflip: SUM({
		bump: '',
		test: '(i32.eqz (i32.lt_u (local.get $d) (i32.add (local.get $c) (local.tee $n (i32.add (local.get $n) (i32.const 4))))))'
	}),
	sumstep3: SUM({
		bump: '',
		test: '(i32.le_u (i32.add (local.get $c) (local.tee $n (i32.add (local.get $n) (i32.const 3)))) (local.get $d))'
	}),
	sumbefore: SUM({ test: '(i32.le_u (i32.add (local.get $c) (local.get $n)) (local.get $d))' }),
	sumbig: SUM({
		bound: '(i32.add (local.get $c) (i32.and (local.get $sum) (i32.const 1023)))',
		bump: '',
		test: SUMTEE('i32.le_u')
	}),
	sumopen: SUM({
		len: '(i32.and (local.get $sum) (i32.const 1023))',
		bump: '',
		test: SUMTEE('i32.le_u')
	}),
	sumwrap: SUM({
		base: '(i32.add (i32.and (local.get $sum) (i32.const 255)) (i32.const -256))',
		bump: '',
		test: SUMTEE('i32.le_u')
	}),
	sumsigned: SUM({ bump: '', test: SUMTEE('i32.le_s') }),
	sumother: SUM({
		bump: '',
		store: '(i32.store8 (i32.add (local.get $a) (i32.add (local.get $n) (local.get $sum))) (i32.const 1))',
		test: SUMTEE('i32.le_u')
	}),
	sumrightset: SUM({
		bump: '',
		test: '(i32.le_u (i32.add (local.get $c) (local.tee $n (i32.add (local.get $n) (i32.const 4)))) (block (result i32) (local.set $n (i32.and (local.get $sum) (i32.const 1048575))) (local.get $d)))'
	}),
	sumgrow: SUM({
		bump: '',
		after: '(local.set $d (i32.add (local.get $d) (i32.const 1)))',
		test: SUMTEE('i32.le_u')
	}),
	sumbasebump: SUM({
		bump: '',
		after: '(local.set $c (i32.add (local.get $c) (local.get $sum)))',
		test: SUMTEE('i32.le_u')
	}),
	sumself: SUM({
		base: '(i32.const 0)',
		len: '(i32.shl (i32.and (local.get $sum) (i32.const 127)) (i32.const 2))',
		bound: '(local.get $acc)',
		bump: '',
		store: '(i32.store8 offset=3 (i32.add (local.get $a) (local.get $n)) (i32.const 1))',
		test: '(i32.lt_u (local.tee $n (i32.add (local.get $n) (i32.const 3))) (local.get $d))'
	}),
	sumptrbound: SUM({ bound: '(local.get $a)', bump: '', test: SUMTEE('i32.le_u') })
});

// the bytes left to scan, end - pos, after a loop test pos + 4 < end, as `num_bytes = end - position` in the match loop:
// the test relates the two locals, so the difference stays in the gap and decides the arena access a + n
const REM = ({
	end = '(i32.and (local.get $sum) (i32.const 255))',
	pos = '(i32.const 0)',
	left = '(local.set $n (i32.sub (local.get $d) (local.get $c)))',
	step = '(i32.add (i32.and (local.get $sum) (i32.const 1)) (i32.const 1))',
	before = '',
	test = '(i32.lt_u (i32.add (local.get $c) (i32.const 4)) (local.get $d))',
	after = '',
	size = 300
}): AllocBase => ({
	statements: [
		SET,
		`(local.set $a (call $malloc (i32.const ${size})))`,
		`(local.set $d ${end})`,
		`(local.set $c ${pos})`,
		`(loop $l
			${before}
			${left}
			(i32.store8 (i32.add (local.get $a) (local.get $n)) (i32.const 1))
			(local.set $c (i32.add (local.get $c) ${step}))
			${after}
			(br_if $l ${test}))`
	]
});

Object.assign(BROTLI_BASES, {
	rem: REM({}),
	remle: REM({ test: '(i32.le_u (i32.add (local.get $c) (i32.const 4)) (local.get $d))' }),
	remplain: REM({ test: '(i32.lt_u (local.get $c) (local.get $d))' }),
	remmirror: REM({ test: '(i32.gt_u (local.get $d) (i32.add (local.get $c) (i32.const 4)))' }),
	remexit: REM({
		test: '(i32.eqz (i32.ge_u (i32.add (local.get $c) (i32.const 4)) (local.get $d)))'
	}),
	remstart: REM({ pos: '(i32.and (local.get $sum) (i32.const 7))' }),
	remtwice: REM({ step: '(i32.add (i32.and (local.get $sum) (i32.const 1)) (i32.const 2))' }),
	remnone: REM({ test: '(i32.ne (local.get $c) (local.get $d))' }),
	remsigned: REM({ test: '(i32.lt_s (i32.add (local.get $c) (i32.const 4)) (local.get $d))' }),
	remunder: REM({
		left: '(local.set $c (i32.add (local.get $c) (i32.const 1))) (local.set $n (i32.sub (local.get $d) (local.get $c)))',
		step: '(i32.const 0)'
	}),
	remswap: REM({ left: '(local.set $n (i32.sub (local.get $c) (local.get $d)))' }),
	remreset: REM({ after: '(local.set $d (i32.and (local.get $sum) (i32.const 4095)))' }),
	remendbump: REM({ before: '(local.set $d (i32.add (local.get $d) (local.get $sum)))' }),
	remother: REM({
		before: '(local.set $acc (i32.and (local.get $sum) (i32.const 255)))',
		left: '(local.set $n (i32.sub (local.get $d) (local.get $acc)))'
	}),
	rembig: REM({ end: '(i32.and (local.get $sum) (i32.const 4095))' }),
	remwrap: REM({
		end: '(i32.add (i32.and (local.get $sum) (i32.const 255)) (i32.const -256))',
		test: '(i32.lt_u (i32.add (local.get $c) (i32.const 4)) (local.get $d))'
	}),
	remslack: REM({
		test: '(i32.lt_u (i32.add (local.get $c) (i32.const 4)) (i32.add (local.get $d) (i32.const 10)))'
	})
});

// the byte tail loop of the dictionary search: a plain counter steps with a plain cursor into a constant table, as
// `data[matched] == word[matched]` against the end of the word, so the counter stays within the cursor's range
const PLAIN_START = `(local.set $c (i32.add (i32.const ${DICT_AT}) (i32.and (local.get $sum) (i32.const 255))))`;
const PLAIN_LIMIT = `(i32.add (i32.const ${DICT_AT + 128}) (i32.and (local.get $sum) (i32.const 255)))`;
const TAILP = (more: Parameters<typeof TAIL>[0] = {}): AllocBase => ({
	statements: TAIL({ start: PLAIN_START, limit: PLAIN_LIMIT, ...more })
});

Object.assign(BROTLI_BASES, {
	tailp: TAILP(),
	tailpmid: TAILP({
		store: '',
		after: '(i32.store8 (i32.add (local.get $a) (local.get $n)) (i32.const 1))'
	}),
	tailpcursor2: TAILP({ move: '(local.tee $c (i32.add (local.get $c) (i32.const 2)))' }),
	tailpcount2: TAILP({ bump: '(local.set $n (i32.add (local.get $n) (i32.const 2)))' }),
	tailpstill: TAILP({ move: '(local.get $c)' }),
	tailpdown: TAILP({ move: '(local.tee $c (i32.sub (local.get $c) (i32.const 1)))' }),
	tailpbig: TAILP({
		limit: `(i32.add (i32.const ${DICT_AT + 128}) (i32.and (local.get $sum) (i32.const 1023)))`
	}),
	tailpwrap: TAILP({
		start: '(local.set $c (i32.add (i32.and (local.get $sum) (i32.const 255)) (i32.const -256)))',
		limit: '(i32.add (i32.and (local.get $sum) (i32.const 255)) (i32.const -128))'
	}),
	tailpreset: TAILP({
		after: '(local.set $n (i32.and (local.get $sum) (i32.const 1023)))'
	}),
	tailpbump: TAILP({ after: '(local.set $n (i32.add (local.get $n) (local.get $sum)))' }),
	tailpstart: TAILP({ count: '(local.set $n (local.get $sum))' }),
	tailpgrow: TAILP({ after: '(local.set $d (i32.add (local.get $d) (i32.const 1)))' }),
	tailpptr: TAILP({ limit: '(local.get $b)' }),
	tailpsigned: TAILP({ cmp: 'i32.lt_s' })
});

// ranges of a 4096 entry table that start and end at, before and after the edges of a summary block, with the one
// large entry inside the range or one entry outside it
const DICT_EDGES: [string, number, number][] = [
	['a', 127, 1],
	['b', 127, 63],
	['c', 63, 64],
	['d', 511, 100]
];
export const DICT_EDGE_BASES: string[] = [];
for (const [tag, mask, off] of DICT_EDGES) {
	const lo = off;
	const hi = off + mask;
	for (const [spot, at] of [
		['lo', lo],
		['hi', hi],
		['before', lo - 1],
		['after', hi + 1]
	] as [string, number][]) {
		const name = `dictedge${tag}${spot}`;
		BROTLI_BASES[name] = DICT({ size: 4096, mask, off, bigAt: at });
		DICT_EDGE_BASES.push(name);
	}
}

// the bases the checker certifies; every other base is a mutant that must stay refused
export const BROTLI_CERTIFY = [
	'dictbyte',
	'dictword',
	...DICT_EDGE_BASES.filter((n) => /(before|after)$/.test(n)),
	'sumle',
	'sumlt',
	'sumswap',
	'sumgt',
	'sumflip',
	'sumstep3',
	'sumbefore',
	'sumgrow',
	'tailp',
	'tailpmid',
	'tailpcursor2',
	'tailpsigned',
	'rem',
	'remle',
	'remplain',
	'remmirror',
	'remexit',
	'remtwice',
	'pairlow',
	'pairhigh',
	'pairafter',
	'pairother',
	'pairptr',
	'pairptrsecond',
	'pairptrcmp',
	'pairptrdiff',
	'pairptragain',
	'i64eq',
	'i64add',
	'i64less',
	'i64signed',
	'i64wrap',
	'i64extend',
	'satsub',
	'satsub32',
	'world',
	'worldback',
	'worldcount',
	'worldsecond',
	'curdec',
	'curword',
	'curarms',
	'lwcert',
	'lwle',
	'lwconst',
	'lwge',
	'lwjoin',
	'lwrange',
	'ptrle',
	'ptrlt',
	'ptrswap',
	'ptrcursor',
	'ptrsame',
	'tail',
	'tailmid',
	'tailspread',
	'tailcount2',
	'tailptr2'
];

export const brotliModule = (name: string, statements?: string[]) =>
	allocModuleOf(BROTLI_BASES[name]!, statements);
