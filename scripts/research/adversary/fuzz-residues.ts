import { createHash } from 'node:crypto';
import { certifyStream } from '../../../src/certify.ts';
import { groundTruth } from '../certify-ground.ts';
import { build } from '../split-sensitivity.ts';

// random modular checksum kernels: two residues in one state word, with and without one hazard each
// usage: fuzz-residues.ts [SEED] [MODULES]; exits 1 when a certified module disagrees with execution
const seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 200);
let x = seed >>> 0 || 1;
const rnd = (n: number) => {
	x ^= x << 13;
	x >>>= 0;
	x ^= x >>> 17;
	x ^= x << 5;
	x >>>= 0;
	return x % n;
};
const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;

const get = (n: string) => `(local.get $${n})`;
const c = (v: number) => `(i32.const ${v})`;
const add = (a: string, b: string) => `(i32.add ${a} ${b})`;
const mul = (k: number, a: string) => (k === 1 ? a : `(i32.mul ${c(k)} ${a})`);
const set = (n: string, v: string) => `(local.set $${n} ${v})`;

const HAZARDS = [
	'none',
	'none',
	'none',
	'no-rem-b',
	'other-modulus',
	'big-modulus',
	'cond-sub',
	'rem-s',
	'skip-rem-tail',
	'swap-pack',
	'load-ahead',
	'sub-step'
] as const;

function kernel() {
	const hazard = pick([...HAZARDS]);
	const P =
		hazard === 'big-modulus'
			? pick([100003, 70001])
			: pick([65521, 65535, 65536, 251, 4093, 40503, 7]);
	const P2 = hazard === 'other-modulus' ? P + 2 : P;
	const al = pick([1, 1, 1, 2, 3]);
	const ga = pick([1, 1, 2]);
	const de = pick([0, 0, 1, 7]);
	const be = pick([1, 1, 1, 2]);
	const ep = pick([1, 1, 2, 0]);
	const ze = pick([0, 0, 1, 3]);
	const eta = pick([0, 0, 5]);
	const u = pick([1, 2, 4]);
	const head = rnd(2) === 0;
	const op = hazard === 'rem-s' ? 'rem_s' : 'rem_u';
	const rem = (v: string, m: number) => `(i32.${op} ${v} ${c(m)})`;
	const step = (k: number, tail: boolean) => {
		const byte = `(i32.load8_u offset=${k + (hazard === 'load-ahead' ? 1 : 0)} ${add(get('p'), get('i'))})`;
		const sum = add(add(mul(al, get('a')), mul(ga, byte)), c(de));
		const keep = hazard === 'skip-rem-tail' && tail;
		const a = set('a', hazard === 'cond-sub' || keep ? sum : rem(sum, P));
		const sub =
			hazard === 'cond-sub'
				? `(if (i32.ge_u ${get('a')} ${c(P)}) (then ${set('a', `(i32.sub ${get('a')} ${c(P)})`)}))`
				: '';
		let mixed = add(add(mul(be, get('b')), mul(ep, get('a'))), c(eta));
		if (ze) mixed = add(mixed, mul(ze, get('x')));
		const b =
			hazard === 'no-rem-b'
				? mixed
				: hazard === 'sub-step'
					? `(i32.sub ${mixed} ${c(1)})`
					: rem(mixed, P2);
		return [set('x', get('a')), a, sub, set('b', b)].join(' ');
	};
	const body = (n: number, tail: boolean) =>
		Array.from({ length: n }, (_, k) => step(k, tail)).join(' ') +
		` ${set('i', add(get('i'), c(n)))}`;
	const loop = (name: string, end: string, n: number, tail: boolean) =>
		head
			? `(block $${name}x (loop $${name} (br_if $${name}x (i32.eq ${get('i')} ${get(end)})) ${body(n, tail)} (br $${name})))`
			: `(if (i32.ne ${get('i')} ${get(end)}) (then (loop $${name} ${body(n, tail)} (br_if $${name} (i32.ne ${get('i')} ${get(end)})))))`;
	const high = hazard === 'swap-pack' ? 'a' : 'b';
	const low = hazard === 'swap-pack' ? 'b' : 'a';
	const text = `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
		(local $a i32) (local $b i32) (local $x i32) (local $i i32) (local $e i32)
		${set('a', `(i32.and ${get('s')} ${c(65535)})`)}
		${set('b', `(i32.shr_u ${get('s')} ${c(16)})`)}
		${set('e', `(i32.and ${get('n')} ${c(-u)})`)}
		${u > 1 ? loop('m', 'e', u, false) : ''}
		${loop('t', 'n', 1, true)}
		(i32.or (i32.shl ${get(high)} ${c(16)}) ${get(low)}))`;
	return {
		text,
		hazard,
		desc: `${hazard} P=${P} al=${al} ga=${ga} de=${de} be=${be} ep=${ep} ze=${ze} eta=${eta} u=${u} head=${head}`
	};
}

const table: Record<string, Record<string, number>> = {};
const bump = (hazard: string, key: string) => {
	table[hazard] ??= {};
	table[hazard]![key] = (table[hazard]![key] ?? 0) + 1;
};
const wrong: string[] = [];
for (let i = 0; i < count; i++) {
	const m = kernel();
	const bytes = build(m.text);
	const result = certifyStream(bytes, 'update');
	if (result.kind !== 'certificate') {
		bump(m.hazard, 'refused');
		continue;
	}
	const bad = groundTruth(bytes, result, [1, 2, 3, 5, 8, 9, 16, 17, 33, 100, 1025, 4097, 65537]);
	bump(m.hazard, bad ? 'wrong' : `certified-${result.ring}`);
	if (bad)
		wrong.push(
			`${m.desc}: ${bad} sha ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`
		);
}
console.log(JSON.stringify(table, null, 1));
console.log(`wrong ${wrong.length}`);
for (const w of wrong) console.log(w);
if (wrong.length) process.exit(1);
