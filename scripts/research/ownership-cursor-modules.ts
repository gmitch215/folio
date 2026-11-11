import {
	allocModuleOf,
	ARENA_BYTES,
	ARENAS,
	layoutAlloc,
	OUT,
	RECORDS,
	SLICE,
	STACK_TOP,
	TABLE,
	type AllocBase
} from './ownership-alloc-modules.ts';

/**
 * The premise "record-derived pointers stay inside their regions": each record, run alone, writes only its own
 * output slot, its own arena slice, the windows and the stack. The checker does not see this; a mutant that
 * indexes a record pointer past its slot is accepted and is not a fault of the certificate.
 */
export function regionsMatch(
	bytes: Uint8Array,
	windows: { low: number; end: number }[]
): { ok: boolean; why?: string } {
	for (let k = 0; k < RECORDS * 4; k++) {
		const i = k % RECORDS;
		const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
		const view = new Uint8Array(memory.buffer);
		layoutAlloc(view, new Uint32Array(memory.buffer), 1 + Math.floor(k / RECORDS), 0);
		const before = view.slice();
		const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
			env: { memory, f: () => {} }
		});
		try {
			(instance.exports.bulk as (t: number, n: number, o: number) => void)(
				TABLE + 16 * i,
				1,
				OUT + 64 * i
			);
		} catch {
			continue;
		}
		const allowed = (at: number) =>
			(at >= OUT + 64 * i && at < OUT + 64 * (i + 1)) ||
			(at >= ARENAS + SLICE * i && at < ARENAS + SLICE * (i + 1)) ||
			(at >= STACK_TOP - 4096 && at < STACK_TOP) ||
			windows.some((w) => at >= w.low && at < w.end);
		for (let at = 0; at < view.length; at++)
			if (view[at] !== before[at] && !allowed(at))
				return { ok: false, why: `record ${i} wrote byte ${at} outside its own regions` };
	}
	return { ok: true };
}

const SET = `(call $bump_set (local.get $arena) (i32.const ${ARENA_BYTES}))`;
// a constant no loop bound can reach: the plain widening goes to it and leaves the arena
const FAR = '(i32.store offset=8 (local.get $slot) (i32.const 100000))';

// each base certifies; the test and the adversary edit them. Arena 512, malloc room 496 from offset 16
export const CURSOR_BASES: Record<string, AllocBase> = {
	// the cursor moves by 5 or 2 per step of the counter (4 bytes of input); 14 + 5 * 92 + 1 is inside the arena
	cursor: {
		statements: [
			SET,
			FAR,
			`(block $out (br_if $out (i32.ge_u (local.get $len) (i32.const 372)))
			(local.set $a (call $malloc (i32.const 480)))
			(if (local.get $a) (then
				(local.set $b (i32.const 14))
				(local.set $c (i32.const 0))
				(block $d (loop $l
					(br_if $d (i32.ge_u (local.get $c) (local.get $len)))
					(i32.store8 (i32.add (local.get $a) (local.get $b)) (local.get $sum))
					(if (i32.and (i32.load8_u (i32.add (local.get $p) (local.get $c))) (i32.const 1))
						(then (local.set $b (i32.add (local.get $b) (i32.const 5))))
						(else (local.set $b (i32.add (local.get $b) (i32.const 2)))))
					(local.set $c (i32.add (local.get $c) (i32.const 4)))
					(br $l)))
				(i32.store offset=4 (local.get $slot) (local.get $b)))))`
		]
	},
	// the same with a flush byte before the chunk (6 per step in one path) and the test at the bottom, as clang rotates it
	rotated: {
		statements: [
			SET,
			FAR,
			`(block $out (br_if $out (i32.ge_u (local.get $len) (i32.const 300)))
			(local.set $a (call $malloc (i32.const 480)))
			(if (local.get $a) (then (if (local.get $len) (then
				(local.set $b (i32.const 14))
				(local.set $c (i32.const 0))
				(local.set $d (i32.const 0))
				(loop $l
					(if (local.get $d) (then
						(i32.store8 (i32.add (local.get $a) (local.get $b)) (i32.const 192))
						(local.set $b (i32.add (local.get $b) (i32.const 1)))
						(local.set $d (i32.const 0))))
					(if (i32.and (i32.load8_u (i32.add (local.get $p) (local.get $c))) (i32.const 1))
						(then
							(i32.store8 (i32.add (local.get $a) (local.get $b)) (local.get $sum))
							(local.set $b (i32.add (local.get $b) (i32.const 5))))
						(else (local.set $d (i32.const 1))))
					(br_if $l (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 4))) (local.get $len))))
				(i32.store offset=4 (local.get $slot) (local.get $b)))))))`
		]
	},
	// n is a multiple of 4 up to 496 (malloc fails above); the write at c + 3 ends at 512 for c = 492
	stride: {
		statements: [
			SET,
			FAR,
			`(local.set $n (i32.shl (i32.and (local.get $len) (i32.const 127)) (i32.const 2)))
			(local.set $a (call $malloc (local.get $n)))
			(if (local.get $a) (then
				(local.set $c (i32.const 0))
				(block $d (loop $l
					(br_if $d (i32.ge_u (local.get $c) (local.get $n)))
					(i32.store8 offset=3 (i32.add (local.get $a) (local.get $c)) (local.get $sum))
					(local.set $c (i32.add (local.get $c) (i32.const 4)))
					(br $l)))
				(i32.store offset=4 (local.get $slot) (local.get $c))))`
		]
	}
};

// the size is the value of a tee, as clang emits it for the decoder
CURSOR_BASES.teesize = {
	statements: [
		SET,
		FAR,
		`(local.set $a (call $malloc (local.tee $n (i32.shl (i32.and (local.get $len) (i32.const 127)) (i32.const 2)))))
		(if (local.get $a) (then
			(local.set $c (i32.const 0))
			(block $d (loop $l
				(br_if $d (i32.ge_u (local.get $c) (local.get $n)))
				(i32.store8 offset=3 (i32.add (local.get $a) (local.get $c)) (local.get $sum))
				(local.set $c (i32.add (local.get $c) (i32.const 4)))
				(br $l)))
			(i32.store offset=4 (local.get $slot) (local.get $c))))`
	]
};

// a step that is larger only after the first iteration: a probe of the first iteration alone would pick a bound that is too small
export const DELAYED: AllocBase = {
	statements: CURSOR_BASES.cursor!.statements.map((s) =>
		s.replace(
			'(then (local.set $b (i32.add (local.get $b) (i32.const 5))))',
			`(then (if (i32.eqz (local.get $c))
				(then (local.set $b (i32.add (local.get $b) (i32.const 5))))
				(else (local.set $b (i32.add (local.get $b) (i32.const 7))))))`
		)
	)
};

// the decoder's shape: the size is a multiple of 4, the test is at the bottom, so the head is only narrowed by the test
const bottom = (far: number): AllocBase => ({
	statements: [
		SET,
		`(i32.store offset=8 (local.get $slot) (i32.const ${far}))`,
		`(local.set $a (call $malloc (local.tee $n (i32.shl (i32.and (local.get $len) (i32.const 127)) (i32.const 2)))))
		(if (local.get $a) (then (if (local.get $n) (then
			(local.set $c (i32.const 0))
			(loop $l
				(i32.store8 offset=3 (i32.add (local.get $a) (local.get $c)) (local.get $sum))
				(br_if $l (i32.lt_u (local.tee $c (i32.add (local.get $c) (i32.const 4))) (local.get $n))))
			(i32.store offset=4 (local.get $slot) (local.get $c))))))`
	]
});
CURSOR_BASES.bottom = bottom(100000);
CURSOR_BASES.bottomwide = bottom(-1294967296);

export const cursorModule = (name: string, statements?: string[]) =>
	allocModuleOf(CURSOR_BASES[name]!, statements);
