import {
	allocModuleOf,
	ARENA_BYTES,
	ARENAS,
	layoutAlloc,
	OUT,
	RECORDS,
	SHIFT,
	SLICE,
	STACK_TOP,
	TABLE,
	type AllocBase
} from './ownership-alloc-modules.ts';

// the shim byte loops as clang emits them for support-bulk.c; src/ownership.ts recognises their printed bodies
export const SHIM_FUNCS = `
 (func $memcpy (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (block $block
   (br_if $block
    (i32.eqz
     (local.get $2)
    )
   )
   (local.set $3
    (i32.and
     (local.get $2)
     (i32.const 3)
    )
   )
   (local.set $4
    (i32.const 0)
   )
   (block $block1
    (br_if $block1
     (i32.lt_u
      (local.get $2)
      (i32.const 4)
     )
    )
    (local.set $5
     (i32.and
      (local.get $2)
      (i32.const -4)
     )
    )
    (local.set $4
     (i32.const 0)
    )
    (loop $label
     (i32.store8
      (local.tee $2
       (i32.add
        (local.get $0)
        (local.get $4)
       )
      )
      (i32.load8_u
       (local.tee $6
        (i32.add
         (local.get $1)
         (local.get $4)
        )
       )
      )
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 1)
      )
      (i32.load8_u
       (i32.add
        (local.get $6)
        (i32.const 1)
       )
      )
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 2)
      )
      (i32.load8_u
       (i32.add
        (local.get $6)
        (i32.const 2)
       )
      )
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 3)
      )
      (i32.load8_u
       (i32.add
        (local.get $6)
        (i32.const 3)
       )
      )
     )
     (br_if $label
      (i32.ne
       (local.get $5)
       (local.tee $4
        (i32.add
         (local.get $4)
         (i32.const 4)
        )
       )
      )
     )
    )
    (br_if $block
     (i32.eqz
      (local.get $3)
     )
    )
   )
   (local.set $2
    (i32.add
     (local.get $1)
     (local.get $4)
    )
   )
   (local.set $4
    (i32.add
     (local.get $0)
     (local.get $4)
    )
   )
   (loop $label1
    (i32.store8
     (local.get $4)
     (i32.load8_u
      (local.get $2)
     )
    )
    (local.set $2
     (i32.add
      (local.get $2)
      (i32.const 1)
     )
    )
    (local.set $4
     (i32.add
      (local.get $4)
      (i32.const 1)
     )
    )
    (br_if $label1
     (local.tee $3
      (i32.add
       (local.get $3)
       (i32.const -1)
      )
     )
    )
   )
  )
  (local.get $0)
 )
 (func $memset (param $0 i32) (param $1 i32) (param $2 i32) (result i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (block $block
   (br_if $block
    (i32.eqz
     (local.get $2)
    )
   )
   (local.set $3
    (i32.and
     (local.get $2)
     (i32.const 7)
    )
   )
   (local.set $4
    (i32.const 0)
   )
   (block $block1
    (br_if $block1
     (i32.lt_u
      (local.get $2)
      (i32.const 8)
     )
    )
    (local.set $5
     (i32.and
      (local.get $2)
      (i32.const -8)
     )
    )
    (local.set $4
     (i32.const 0)
    )
    (loop $label
     (i32.store8
      (local.tee $2
       (i32.add
        (local.get $0)
        (local.get $4)
       )
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 7)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 6)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 5)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 4)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 3)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 2)
      )
      (local.get $1)
     )
     (i32.store8
      (i32.add
       (local.get $2)
       (i32.const 1)
      )
      (local.get $1)
     )
     (br_if $label
      (i32.ne
       (local.get $5)
       (local.tee $4
        (i32.add
         (local.get $4)
         (i32.const 8)
        )
       )
      )
     )
    )
    (br_if $block
     (i32.eqz
      (local.get $3)
     )
    )
   )
   (local.set $2
    (i32.add
     (local.get $0)
     (local.get $4)
    )
   )
   (loop $label1
    (i32.store8
     (local.get $2)
     (local.get $1)
    )
    (local.set $2
     (i32.add
      (local.get $2)
      (i32.const 1)
     )
    )
    (br_if $label1
     (local.tee $3
      (i32.add
       (local.get $3)
       (i32.const -1)
      )
     )
    )
   )
  )
  (local.get $0)
 )`;

const SET = '(call $bump_set (local.get $arena) (i32.const 512))';
const GUARD = (limit: number, body: string) =>
	`(block $out (br_if $out (i32.gt_u (local.get $len) (i32.const ${limit}))) ${body})`;
const LOOP = (cmp: string, body: string) => `(local.set $k (i32.const 0))
	(block $d (loop $l
		(br_if $d (${cmp} (local.get $k) (local.get $len)))
		${body}
		(local.set $k (i32.add (local.get $k) (i32.const 1)))
		(br $l)))`;
const SLOT_FIRST = '(i32.store (local.get $slot) (i32.load8_u (local.get $a)))';

// each base certifies; the mutants in the test edit them
export const EXTENT_BASES: Record<string, AllocBase> = {
	fill: {
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then (memory.fill (local.get $a) (i32.const 7) (local.get $len)) ${SLOT_FIRST}))`
		]
	},
	padded: {
		statements: [
			SET,
			GUARD(
				100000,
				`(local.set $a (call $malloc (i32.add (local.get $len) (i32.const 4))))
		(if (local.get $a) (then
			(memory.fill (local.get $a) (i32.const 7) (local.get $len))
			(memory.fill (i32.add (local.get $a) (local.get $len)) (i32.const 0) (i32.const 4))
			${SLOT_FIRST}))`
			)
		]
	},
	loop: {
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then
			${LOOP('i32.ge_u', '(i32.store8 (i32.add (local.get $a) (local.get $k)) (local.get $k))')}
			${SLOT_FIRST}))`
		]
	},
	copy: {
		extra: SHIM_FUNCS,
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then
			(drop (call $memcpy (local.get $a) (local.get $p) (local.get $len)))
			${SLOT_FIRST}
			(if (local.get $len) (then (i32.store offset=4 (local.get $slot) (i32.load8_u (i32.add (local.get $a) (i32.sub (local.get $len) (i32.const 1)))))))))`
		]
	},
	sumcopy: {
		extra: SHIM_FUNCS,
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then
			(drop (call $memcpy (local.get $a) (local.get $p) (local.get $len)))
			${LOOP('i32.ge_u', '(local.set $acc (i32.add (local.get $acc) (i32.load8_u (i32.add (local.get $a) (local.get $k)))))')}
			(i32.store offset=8 (local.get $slot) (local.get $acc))))`
		]
	},
	related: {
		statements: [
			SET,
			`(if (i32.le_u (local.get $sum) (local.get $len)) (then
			(local.set $a (call $malloc (local.get $len)))
			(if (local.get $a) (then
				(local.set $k (i32.const 0))
				(block $d (loop $l
					(br_if $d (i32.ge_u (local.get $k) (local.get $sum)))
					(i32.store8 (i32.add (local.get $a) (local.get $k)) (local.get $k))
					(local.set $k (i32.add (local.get $k) (i32.const 1)))
					(br $l)))
				${SLOT_FIRST}))))`
		]
	},
	blockfill: {
		extra: `(func $malloc2 (param $size i32) (result i32)
			(local $start i32) (local $r i32)
			(local.set $start (i32.and (i32.add (i32.load (i32.const 4104)) (i32.const 31)) (i32.const -16)))
			(block $b
				(br_if $b (i32.gt_u (local.get $start) (i32.load (i32.const 4100))))
				(br_if $b (i32.gt_u (local.get $size) (i32.sub (i32.load (i32.const 4100)) (local.get $start))))
				(i32.store (i32.sub (i32.add (i32.load (i32.const 4096)) (local.get $start)) (i32.const 4)) (local.get $size))
				(i32.store (i32.const 4104) (i32.add (local.get $start) (local.get $size)))
				(local.set $r (i32.add (i32.load (i32.const 4096)) (local.get $start))))
			(local.get $r))`,
		statements: [
			SET,
			'(local.set $a (call $malloc2 (local.get $len)))',
			`(if (local.get $a) (then (memory.fill (local.get $a) (i32.const 7) (local.get $len)) ${SLOT_FIRST}))`
		]
	},
	tail: {
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then (if (local.get $len) (then
			(i32.store8 (i32.add (local.get $a) (i32.sub (local.get $len) (i32.const 1))) (local.get $sum))
			(i32.store8 (local.get $a) (i32.const 1))
			(i32.store offset=4 (local.get $slot) (i32.load8_u (i32.add (local.get $a) (i32.sub (local.get $len) (i32.const 1)))))))))`
		]
	},
	overlap: {
		extra: SHIM_FUNCS,
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then (if (local.get $len) (then
			(drop (call $memcpy (local.get $a) (local.get $p) (local.get $len)))
			(drop (call $memcpy (i32.add (local.get $a) (i32.const 1)) (local.get $a) (i32.sub (local.get $len) (i32.const 1))))
			(i32.store offset=4 (local.get $slot) (i32.load8_u (local.get $a)))))))`
		]
	},
	headed: {
		extra: SHIM_FUNCS,
		statements: [
			SET,
			GUARD(
				100000,
				`(local.set $a (call $malloc (i32.add (local.get $len) (i32.const 8))))
		(if (local.get $a) (then
			(i32.store (local.get $a) (local.get $len))
			(drop (call $memcpy (i32.add (local.get $a) (i32.const 4)) (local.get $p) (local.get $len)))
			(i32.store offset=12 (local.get $slot) (i32.load (local.get $a)))))`
			)
		]
	},
	shimfill: {
		extra: SHIM_FUNCS,
		statements: [
			SET,
			'(local.set $a (call $malloc (local.get $len)))',
			`(if (local.get $a) (then
			(drop (call $memset (local.get $a) (i32.const 9) (local.get $len)))
			${SLOT_FIRST}))`
		]
	},
	small: {
		extra: SHIM_FUNCS,
		stack: true,
		statements: [
			'(global.set $sp (i32.sub (global.get $sp) (i32.const 64)))',
			SET,
			'(drop (call $memset (global.get $sp) (i32.const 0) (i32.const 56)))',
			'(i32.store8 offset=3 (global.get $sp) (local.get $sum))',
			'(local.set $a (call $malloc (i32.add (i32.shl (i32.load8_u offset=9 (global.get $sp)) (i32.const 2)) (i32.const 24))))',
			'(i32.store (local.get $a) (local.get $sum))',
			'(i32.store offset=4 (local.get $slot) (i32.load8_u offset=3 (global.get $sp)))',
			'(i32.store offset=8 (local.get $slot) (i32.load offset=8 (global.get $sp)))',
			'(global.set $sp (i32.add (global.get $sp) (i32.const 64)))'
		]
	}
};

export const extentModule = (name: string, statements?: string[]) =>
	allocModuleOf(EXTENT_BASES[name]!, statements);

// record lengths around and past the arena size; the harness lengths stop at 63, far from any extent
export const EXTREME_LENGTHS = [0, 1, 15, 495, 496, 497, 511, 512, 513, 1000, 4096, 40000];

/**
 * Run record 0 with each length at the arena's slice start and at slice start plus SHIFT: the poison around the
 * arena stays untouched, and memory outside the arenas, the stack and the pointer cells is the same.
 */
export function extremeMatches(
	bytes: Uint8Array,
	cells: [number, number][] = [],
	lengths: number[] = EXTREME_LENGTHS
): { ok: boolean; why?: string } {
	for (const length of lengths) {
		const runs = [0, SHIFT].map((shift) => {
			const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
			const view = new Uint8Array(memory.buffer);
			const words = new Uint32Array(memory.buffer);
			layoutAlloc(view, words, 3, shift);
			words[(TABLE + 4) / 4] = length;
			const instance = new WebAssembly.Instance(
				new WebAssembly.Module(Uint8Array.from(bytes)),
				{
					env: { memory, f: () => {} }
				}
			);
			let trapped = false;
			try {
				(instance.exports.bulk as (t: number, n: number, o: number) => void)(TABLE, 1, OUT);
			} catch {
				trapped = true;
			}
			return { trapped, view };
		});
		const [a, b] = runs as [(typeof runs)[number], (typeof runs)[number]];
		if (a.trapped !== b.trapped) return { ok: false, why: `trap differs at length ${length}` };
		if (a.trapped) continue;
		const inCells = (at: number) => cells.some(([lo, end]) => at >= lo && at < end);
		for (let at = 0; at < a.view.length; at++) {
			if (at >= STACK_TOP - 4096 && at < STACK_TOP) continue;
			if (at >= TABLE && at < TABLE + 16 * RECORDS && (at - TABLE) % 16 >= 12) continue;
			const slice = at >= ARENAS && at < ARENAS + RECORDS * SLICE;
			if (!slice) {
				if (a.view[at] !== b.view[at] && !inCells(at))
					return {
						ok: false,
						why: `length ${length}: byte ${at} outside the arenas differs`
					};
				continue;
			}
			const rel = (at - ARENAS) % SLICE;
			if (rel >= ARENA_BYTES && a.view[at] !== 0xa5)
				return { ok: false, why: `length ${length}: write past the arena at ${at}` };
			if (rel >= SHIFT + ARENA_BYTES && b.view[at] !== 0xa5)
				return {
					ok: false,
					why: `length ${length}: write past the shifted arena at ${at}`
				};
			if (rel < SHIFT && b.view[at] !== 0xa5)
				return {
					ok: false,
					why: `length ${length}: write before the shifted arena at ${at}`
				};
		}
	}
	return { ok: true };
}
