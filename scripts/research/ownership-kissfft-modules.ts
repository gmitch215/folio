import type { OwnershipOptions } from '../../src/ownership.ts';
import {
	assemble,
	iterWat,
	layoutRecords,
	OUT,
	RECORDS,
	TABLE,
	type Outcome
} from './ownership-modules.ts';

// hand modules for the config premise: a recursive in-place butterfly over a scratch buffer whose address and
// factor list are words of a shared config. The config is 96 frozen words at KCFG, a read-only weight table at
// KWTAB, and the scratch buffer KN words at KTMP (not 64-aligned, so the window has padding on both sides)
export const KCFG = 49152;
export const KTMP = KCFG + 200;
export const KN = 8;
export const KFROZEN = 96;
export const KEXTENT = 512;
export const KWTAB = KCFG + 96;
export const KPAD = KCFG + 236;
export const KFACTORS = [2, 4, 2, 2, 2, 1];

export const configImage = (factors: number[] = KFACTORS, tmp = KTMP, n = KN) => {
	const bytes = new Uint8Array(KFROZEN);
	const words = new Uint32Array(bytes.buffer);
	words[0] = tmp;
	words[1] = n;
	factors.forEach((f, i) => (words[2 + i] = f));
	return bytes;
};

export const kissOptions = (
	factors: number[] = KFACTORS,
	recursion = 12,
	tmp = KTMP,
	n = KN,
	extent = KEXTENT
): OwnershipOptions => ({
	config: { word: 8, at: KCFG, bytes: configImage(factors, tmp, n), extent },
	recursion
});

export const KISS_WORK = `(func $work (param $F i32) (param $f i32) (param $stride i32) (param $fac i32)
		(local $beg i32) (local $p i32) (local $m i32) (local $end i32) (local $i i32) (local $a i32) (local $b i32)
		(local.set $beg (local.get $F))
		(local.set $p (i32.load (local.get $fac)))
		(local.set $m (i32.load offset=4 (local.get $fac)))
		(local.set $end (i32.add (local.get $F) (i32.shl (i32.mul (local.get $p) (local.get $m)) (i32.const 2))))
		(if (i32.eq (local.get $m) (i32.const 1))
			(then (loop $c
				(i32.store (local.get $F) (i32.load (local.get $f)))
				(local.set $f (i32.add (local.get $f) (i32.shl (local.get $stride) (i32.const 2))))
				(br_if $c (i32.ne (local.tee $F (i32.add (local.get $F) (i32.const 4))) (local.get $end)))))
			(else (loop $r
				(call $work (local.get $F) (local.get $f) (i32.mul (local.get $stride) (local.get $p)) (i32.add (local.get $fac) (i32.const 8)))
				(local.set $f (i32.add (local.get $f) (i32.shl (local.get $stride) (i32.const 2))))
				(br_if $r (i32.ne (local.tee $F (i32.add (local.get $F) (i32.shl (local.get $m) (i32.const 2)))) (local.get $end))))))
		(loop $b
			(local.set $a (i32.load (i32.add (local.get $beg) (i32.shl (local.get $i) (i32.const 2)))))
			(local.set $b (i32.load (i32.add (local.get $beg) (i32.shl (i32.add (local.get $i) (local.get $m)) (i32.const 2)))))
			(i32.store (i32.add (local.get $beg) (i32.shl (local.get $i) (i32.const 2))) (i32.add (local.get $a) (local.get $b)))
			(i32.store (i32.add (local.get $beg) (i32.shl (i32.add (local.get $i) (local.get $m)) (i32.const 2)))
				(i32.sub (local.get $a) (i32.mul (local.get $b) (i32.load (i32.add (i32.const ${KWTAB}) (i32.and (i32.shl (i32.mul (local.get $i) (local.get $stride)) (i32.const 2)) (i32.const 60)))))))
			(br_if $b (i32.ne (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $m)))))`;

export const KISS_RUN = `(func $run (param $t i32) (param $slot i32)
		(local $cfg i32) (local $tmp i32) (local $n i32) (local $i i32)
		(local.set $cfg (i32.load offset=8 (local.get $t)))
		(local.set $tmp (i32.load (local.get $cfg)))
		(local.set $n (i32.load offset=4 (local.get $cfg)))
		(call $work (local.get $tmp) (i32.load (local.get $t)) (i32.const 1) (i32.add (local.get $cfg) (i32.const 8)))
		(loop $o
			(i32.store (i32.add (local.get $slot) (i32.shl (local.get $i) (i32.const 2))) (i32.load (i32.add (local.get $tmp) (i32.shl (local.get $i) (i32.const 2)))))
			(br_if $o (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
		(i32.store offset=40 (local.get $slot) (i32.load offset=236 (local.get $cfg))))`;

export const KISS_BODY = '(call $run (local.get $t) (local.get $slot))';

export const kissModule = (work = KISS_WORK, run = KISS_RUN, max = 40): Uint8Array<ArrayBuffer> =>
	assemble(iterWat({ body: KISS_BODY, extra: `${work}\n\t${run}`, max }));

export interface KissMutant {
	name: string;
	/** text edits of the work function and of the run function */
	work?: [string, string][];
	run?: [string, string][];
	/** module fields added after the functions */
	extra?: string;
	factors?: number[];
	/** reasons the checker may give; `certificate` when the mutant is sound and has to match the route */
	expect: string[];
}

const edit = (text: string, edits: [string, string][] = []) => {
	let out = text;
	for (const [from, to] of edits) {
		if (!out.includes(from)) throw new Error(`mutant edit not found: ${from}`);
		out = out.replace(from, to);
	}
	return out;
};

export const kissMutantModule = (m: KissMutant) =>
	kissModule(edit(KISS_WORK, m.work), edit(KISS_RUN, m.run) + (m.extra ? `\n\t${m.extra}` : ''));

const DATA_WORD = '(i32.load (local.get $f))';
const ODD = '(i32.and (i32.load8_u (i32.load (local.get $t))) (i32.const 1))';

// every mutant is a sound refusal or a sound certificate; a certificate has to equal the serial run
export const KISS_MUTANTS: KissMutant[] = [
	{ name: 'base', expect: ['certificate'] },
	{ name: 'two-pairs-short', factors: [2, 4, 2, 1], expect: ['read-before-write'] },
	{ name: 'leaf-of-one', factors: [2, 4, 2, 2, 1, 1], expect: ['read-before-write'] },
	{ name: 'leaf-of-four', factors: [2, 4, 4, 1], expect: ['certificate', 'read-before-write'] },
	{
		name: 'no-leaf',
		factors: [2, 4, 2, 2, 2, 2],
		expect: ['unsupported', 'budget', 'config-store']
	},
	{
		name: 'scratch-read-before-write',
		run: [
			[
				'(call $work',
				'(i32.store offset=48 (local.get $slot) (i32.load (local.get $tmp)))\n\t\t(call $work'
			]
		],
		expect: ['read-before-write']
	},
	{
		name: 'pointer-escapes',
		run: [
			[
				'(i32.store offset=40',
				'(i32.store offset=56 (local.get $slot) (local.get $tmp))\n\t\t(i32.store offset=40'
			]
		],
		expect: ['escape']
	},
	{
		name: 'store-into-config',
		run: [
			[
				'(call $work',
				'(i32.store (i32.add (local.get $cfg) (i32.const 8)) (i32.const 3))\n\t\t(call $work'
			]
		],
		expect: ['config-store']
	},
	{
		name: 'store-reaches-config',
		run: [
			[
				'(call $work',
				'(i32.store (i32.add (local.get $cfg) (i32.shl (i32.and (i32.load (local.get $tmp)) (i32.const 15)) (i32.const 2))) (i32.const 3))\n\t\t(call $work'
			]
		],
		expect: ['config-store']
	},
	{
		name: 'fill-over-config',
		run: [
			[
				'(call $work',
				'(memory.fill (i32.add (local.get $cfg) (i32.const 8)) (i32.const 3) (i32.const 4))\n\t\t(call $work'
			]
		],
		expect: ['config-store']
	},
	{
		name: 'fill-through-data',
		run: [
			[
				'(call $work',
				'(memory.fill (i32.load (i32.load (local.get $t))) (i32.const 3) (i32.const 4))\n\t\t(call $work'
			]
		],
		expect: ['config-store']
	},
	{
		name: 'input-aliases-scratch-branch',
		extra: '(global $g (mut i32) (i32.const 0))',
		run: [
			[
				'(call $work',
				'(if (i32.eq (i32.load (local.get $t)) (local.get $tmp)) (then (global.set $g (i32.const 1))))\n\t\t(call $work'
			]
		],
		expect: ['certificate']
	},
	{
		name: 'trap-after-write',
		run: [
			['(i32.store offset=40', `(if ${ODD} (then (unreachable)))\n\t\t(i32.store offset=40`]
		],
		expect: ['failure']
	},
	{
		name: 'recursion-without-exit',
		work: [['(i32.eq (local.get $m) (i32.const 1))', '(i32.const 0)']],
		expect: ['unsupported', 'budget']
	},
	{
		name: 'base-from-record-data',
		run: [
			[
				'(local.set $tmp (i32.load (local.get $cfg)))',
				`(local.set $tmp (i32.load (i32.load (local.get $t))))`
			]
		],
		expect: ['config-store']
	},
	{
		name: 'table-word-offset',
		run: [['(i32.load offset=8 (local.get $t))', '(i32.load offset=4 (local.get $t))']],
		expect: ['config-store']
	},
	{
		name: 'store-past-window',
		work: [
			[
				'(br_if $b',
				'(i32.store (i32.add (local.get $beg) (i32.const 4096)) (i32.const 1))\n\t\t\t(br_if $b'
			]
		],
		expect: ['certificate']
	},
	{
		name: 'store-in-padding-before-read',
		run: [
			[
				'(i32.store offset=40',
				'(i32.store offset=236 (local.get $cfg) (i32.const 7))\n\t\t(i32.store offset=40'
			]
		],
		expect: ['certificate', 'read-before-write', 'final-state']
	},
	{
		name: 'extra-output-word',
		run: [['(local.get $n))))', '(i32.add (local.get $n) (i32.const 1)))))']],
		expect: ['certificate']
	},
	{
		name: 'wider-stride',
		work: [
			[
				'(i32.mul (local.get $stride) (local.get $p))',
				'(i32.mul (local.get $stride) (i32.add (local.get $p) (i32.const 1)))'
			]
		],
		expect: ['certificate', 'read-before-write', 'unsupported']
	},
	{
		name: 'input-from-slot',
		run: [[DATA_WORD.replace('$f', '$t'), '(local.get $slot)']],
		expect: ['certificate', 'read-before-write', 'final-state']
	}
];

// a recursive function whose two frames make different affine relations between the same locals
const STALE_FN = `(func $rr (param $x i32) (param $d i32)
		(local $y i32)
		(if (local.get $d)
			(then
				(local.set $y (i32.add (local.get $x) (i32.const 1)))
				(call $rr (local.get $x) (i32.const 0))
				(if (i32.lt_u (local.get $x) (i32.const 4))
					(then (i32.store8 (i32.add (i32.const 4200) (local.get $y)) (i32.const 1)))))
			(else (local.set $y (i32.add (local.get $x) (i32.const 5))))))`;

const STALE_BODY = `(call $rr (i32.and (i32.load8_u (local.get $p)) (i32.const 7)) (i32.const 1))
		(i32.store (local.get $slot) (i32.load8_u (i32.const 4202)))`;

export const staleModule = (): Uint8Array<ArrayBuffer> =>
	assemble(iterWat({ body: STALE_BODY, extra: STALE_FN, max: 40 }));

// a recursive call inside a branch condition: the callee evaluates the same expressions with other values
const VALS_FN = `(func $rv (param $x i32) (param $z i32) (param $d i32) (result i32)
		(if (local.get $d)
			(then
				(if (i32.lt_u (i32.add (local.get $x) (local.get $z))
						(call $rv (local.get $x) (i32.const 9) (i32.sub (local.get $d) (i32.const 1))))
					(then (i32.store8 (i32.add (i32.const 4200) (local.get $x)) (i32.const 1))))))
		(i32.const 10))`;

const VALS_BODY = `(drop (call $rv (i32.and (i32.load8_u (local.get $p)) (i32.const 7)) (i32.const 2) (i32.const 2)))
		(i32.store (local.get $slot) (i32.load8_u (i32.const 4203)))`;

export const valsModule = (): Uint8Array<ArrayBuffer> =>
	assemble(iterWat({ body: VALS_BODY, extra: VALS_FN, max: 40 }));

// #region ground truth

export interface KissCase {
	image: Uint8Array;
	call: { table: number; n: number; out: number; slot: number };
}

export function kissCase(
	seed: number,
	factors: number[] = KFACTORS,
	trap = -1,
	tmp = KTMP,
	n = KN
): KissCase {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer);
	layoutRecords(view, words, seed);
	for (let i = 0; i < RECORDS; i++) words[(TABLE + 16 * i + 8) / 4] = KCFG;
	view.set(configImage(factors, tmp, n), KCFG);
	for (let k = 0; k < 16; k++)
		new DataView(memory.buffer).setUint32(
			KWTAB + 4 * k,
			Math.imul(k + seed, 2654435761) >>> 0,
			true
		);
	for (let a = KCFG + 192; a < KCFG + 256; a++) view[a] = (a * 7 + 3) & 255;
	if (trap >= 0) words[(TABLE + 16 * trap) / 4] = 0xfffffff0;
	return { image: view.slice(), call: { table: TABLE, n: RECORDS, out: OUT, slot: 64 } };
}

/** The serial run, or with `windows` each record on the baseline bytes of the windows. `pages` above 8 poisons the rest. */
export function runKiss(
	bytes: Uint8Array,
	image: Uint8Array,
	windows: { low: number; end: number }[] | undefined,
	pages = 8
): Outcome {
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
	const view = new Uint8Array(memory.buffer);
	for (let a = image.length; a < view.length; a++) view[a] = (a * 13 + 5) & 255;
	view.set(image);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory, f: () => {} }
	});
	const bulk = instance.exports.bulk as (t: number, n: number, o: number) => number;
	const baseline = windows ? windows.map((w) => view.slice(w.low, w.end)) : [];
	let trapped: number | null = null;
	for (let i = 0; i < RECORDS; i++) {
		if (windows) windows.forEach((w, k) => view.set(baseline[k]!, w.low));
		try {
			bulk(TABLE + 16 * i, 1, OUT + 64 * i);
		} catch {
			trapped = i;
			break;
		}
	}
	return { trapped, memory: view.slice(0, 8 * 65536) };
}

export type KissRoute = 'equal' | 'differs' | 'premise';

/** The private-window route against the serial run; a result that depends on the memory size is a premise violation. */
export function kissRoute(
	bytes: Uint8Array,
	windows: { low: number; end: number }[],
	seeds: number[],
	factors: number[] = KFACTORS,
	tmp = KTMP,
	n = KN
): KissRoute {
	for (const seed of seeds)
		for (const trap of [-1, seed % RECORDS]) {
			const c = kissCase(seed, factors, trap, tmp, n);
			const serial = runKiss(bytes, c.image, undefined);
			const wider = runKiss(bytes, c.image, undefined, 12);
			if (
				serial.trapped !== wider.trapped ||
				serial.memory.some((b, at) => b !== wider.memory[at])
			)
				return 'premise';
			const route = runKiss(bytes, c.image, windows);
			if (serial.trapped !== route.trapped) return 'differs';
			if (serial.trapped !== null) continue;
			for (let at = 0; at < serial.memory.length; at++)
				if (serial.memory[at] !== route.memory[at]) return 'differs';
		}
	return 'equal';
}

// #endregion
