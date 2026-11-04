import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream, type StreamCertificate } from '../../../src/certify.ts';
import { groundTruth } from '../certify-ground.ts';
import { buildWat, MEMORY32, mulberry, workDir } from './lib.ts';

// random byte steps over two 16 bit digits (digits), over the whole state (whole), or with nonlinear
// atoms mixed in (atoms); every certified module is checked by execution
// usage: fuzz-residue-atoms.ts [SEED] [MODULES] [digits|whole|atoms] [DIR]; failing kernels go to DIR
// (adversary-out by default); exits 1 on a wrong acceptance
const seed0 = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 200);
const mode = process.argv[4] ?? 'digits';
const out = workDir(process.argv[5]);

const MODS = [251, 255, 256, 257, 65521, 65535, 65536, 7, 1000, 40000];
const MASKS = [255, 65535, 4095, 0xffff0000 | 0, 0xff00, 1, 0xff0000, 0x7fffffff];

function gen(r: () => number, leaves: string[], depth: number): string {
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	if (depth <= 0 || r() < 0.2)
		return r() < 0.25 ? `(i32.const ${Math.floor(r() * 300)})` : pick(leaves);
	const e = () => gen(r, leaves, depth - 1);
	if (mode === 'atoms' && r() < 0.4) {
		switch (Math.floor(r() * 9)) {
			case 0:
				return `(i32.mul ${e()} ${e()})`;
			case 1:
				return `(i32.${pick(['lt_u', 'gt_u', 'eq', 'ne', 'le_s', 'ge_u'])} ${e()} ${e()})`;
			case 2:
				return `(i32.rotl ${e()} (i32.const ${pick([1, 5, 13, 24])}))`;
			case 3:
				return `(i32.eqz ${e()})`;
			case 4:
				return `(i32.popcnt ${e()})`;
			case 5:
				return `(i32.clz ${e()})`;
			case 6:
				return `(i32.shr_u ${e()} ${e()})`;
			case 7:
				return `(i32.and ${e()} ${e()})`;
			default:
				return `(i32.shl ${e()} ${e()})`;
		}
	}
	const WEIGHTED = [0, 0, 0, 0, 1, 2, 2, 2, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10];
	switch (WEIGHTED[Math.floor(r() * WEIGHTED.length)]!) {
		case 0:
			return `(i32.add ${e()} ${e()})`;
		case 1:
			return `(i32.sub ${e()} ${e()})`;
		case 2:
			return `(i32.mul ${e()} (i32.const ${pick([2, 3, 5, 31, 255, 256, 257, 65536, 65537])}))`;
		case 3:
		case 4:
			return `(i32.rem_u ${e()} (i32.const ${pick(MODS)}))`;
		case 5:
			return `(i32.and ${e()} (i32.const ${pick(MASKS)}))`;
		case 6:
			return `(i32.shr_u ${e()} (i32.const ${pick([1, 4, 8, 15, 16, 17, 24])}))`;
		case 7:
			return `(i32.shl ${e()} (i32.const ${pick([1, 4, 8, 16])}))`;
		case 8:
			return `(i32.or ${e()} ${e()})`;
		case 9:
			return `(i32.xor ${e()} ${e()})`;
		default:
			return `(i32.rem_u (i32.add ${e()} ${e()}) (i32.const ${pick(MODS)}))`;
	}
}

function kernel(seed: number): string {
	const r = mulberry(seed);
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	const whole = mode === 'whole' || mode === 'atoms';
	const u = pick([1, 1, 2, 4]);
	const leaves = ['(local.get $a)', '(local.get $b)', '(local.get $x)'];
	const step = () => {
		const x = `(local.set $x (i32.load8_u offset=__K__ (i32.add (local.get $p) (local.get $i))))`;
		if (whole) return `${x} (local.set $s ${gen(r, ['(local.get $s)', '(local.get $x)'], 3)})`;
		const ea = gen(r, leaves, 3);
		const na = `(local.set $a ${r() < 0.7 ? `(i32.rem_u ${ea} (i32.const ${pick(MODS)}))` : ea})`;
		const eb = gen(r, leaves, 3);
		const nb = `(local.set $b ${r() < 0.7 ? `(i32.rem_u ${eb} (i32.const ${pick(MODS)}))` : eb})`;
		return `${x} ${na} ${nb}`;
	};
	const template = step();
	const bodies = Array.from({ length: u }, (_, k) => template.replaceAll('__K__', String(k)));
	const tailStep = template.replaceAll('__K__', '0');
	const body = (n: number, tail: boolean) =>
		(tail ? tailStep : bodies.join(' ')) +
		`(local.set $i (i32.add (local.get $i) (i32.const ${n})))`;
	const loop = (name: string, end: string, n: number, tail: boolean) =>
		`(if (i32.ne (local.get $i) (local.get $${end})) (then (loop $${name} ${body(n, tail)} (br_if $${name} (i32.ne (local.get $i) (local.get $${end}))))))`;
	const packs = [
		'(i32.or (i32.shl (local.get $b) (i32.const 16)) (local.get $a))',
		'(i32.add (i32.shl (local.get $b) (i32.const 16)) (local.get $a))',
		'(i32.or (i32.shl (local.get $b) (i32.const 16)) (i32.and (local.get $a) (i32.const 65535)))',
		'(i32.xor (i32.shl (local.get $b) (i32.const 16)) (local.get $a))',
		'(i32.or (local.get $a) (i32.shl (local.get $b) (i32.const 16)))'
	];
	const init = whole
		? ''
		: `(local.set $a (i32.and (local.get $s) (i32.const 65535))) (local.set $b (i32.shr_u (local.get $s) (i32.const 16)))`;
	const ret = whole ? '(local.get $s)' : pick(packs);
	return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
		(local $a i32) (local $b i32) (local $x i32) (local $i i32) (local $m i32)
		${init}
		(local.set $m (i32.and (local.get $n) (i32.const ${-u})))
		${u > 1 ? loop('main', 'm', u, false) : ''}
		${loop('tail', 'n', 1, true)}
		${ret})`;
}

let certified = 0;
let refused = 0;
let bad = 0;
const reasons = new Map<string, number>();
for (let seed = seed0; seed < seed0 + count; seed++) {
	let bytes: Uint8Array;
	try {
		bytes = buildWat(kernel(seed), MEMORY32);
	} catch {
		reasons.set('build', (reasons.get('build') ?? 0) + 1);
		continue;
	}
	const res = certifyStream(bytes, 'update', { maxMs: 8000 });
	if (res.kind === 'refusal') {
		refused++;
		const why = res.reason.replace(/\d+/g, 'N').slice(0, 90);
		reasons.set(why, (reasons.get(why) ?? 0) + 1);
		continue;
	}
	certified++;
	const g = groundTruth(
		bytes,
		res as StreamCertificate,
		[1, 2, 3, 4, 5, 9, 17, 100, 1025],
		1 << 20
	);
	if (g) {
		bad++;
		console.log(`MISMATCH seed ${seed} ring ${res.ring}: ${g}`);
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, `fuzz-residue-atoms-${mode}-${seed}.wat`), kernel(seed));
	}
}
console.log(
	`mode ${mode} seeds ${seed0}..${seed0 + count - 1}: certified ${certified}, refused ${refused}, mismatches ${bad}`
);
for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(v, k);
process.exit(bad ? 1 : 0);
