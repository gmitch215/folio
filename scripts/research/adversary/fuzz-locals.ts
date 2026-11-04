import { certifyStream } from '../../../src/certify.ts';
import { buildModule, chunkCheck } from './lib.ts';

// usage: node fuzz-locals.ts [SEED] [PROGRAMS]; differential fuzz of the loop summary: random
// straight-line bodies over the state and two scratch locals in head and tail loops whose trip
// count is Q - K, then a result chosen from any local; exits 1 on a wrong acceptance
const X = Array.from({ length: 16 }, (_, k) => `(i32.load8_u offset=${k} (local.get $p))`).reduce(
	(a, l) => `(i32.xor ${a} ${l})`,
	'(local.get $s)'
);
const L = ['s', 't1', 't2'];
const get = (v: string) => `(local.get $${v})`;
const STMTS = [
	...L.map((d) => `(local.set $${d} ${X})`),
	...L.flatMap((d) => L.filter((e) => e !== d).map((e) => `(local.set $${d} ${get(e)})`)),
	...L.map((d) => `(local.set $${d} (i32.xor ${get(d)} ${X}))`),
	`(local.set $s (i32.xor ${get('s')} (i32.const 255)))`
];
let seed = Number(process.argv[2] ?? 1);
const rnd = (n: number) => {
	seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
	return (seed >>> 8) % n;
};

const program = (head: boolean, K: number, stmts: string[], result: string) => `(module
 (memory (export "memory") 32 512)
 (func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
  (local $m i32) (local $i i32) (local $r i32) (local $t1 i32) (local $t2 i32) (local $acc i32)
  (if (i32.lt_u (local.get $n) (i32.const 16)) (then
   (if (local.get $n) (then
    (loop $c
     (local.set $s (i32.xor (local.get $s) (i32.load8_u (local.get $p))))
     (local.set $p (i32.add (local.get $p) (i32.const 1)))
     (local.set $n (i32.sub (local.get $n) (i32.const 1)))
     (br_if $c (local.get $n)))))
   (return (local.get $s))))
  (local.set $m (i32.sub (i32.shr_u (local.get $n) (i32.const 4)) (i32.const ${K})))
  ${
		head
			? `(block $x (loop $l
   (br_if $x (i32.eq (local.get $i) (local.get $m)))
   ${stmts.join('\n   ')}
   (local.set $p (i32.add (local.get $p) (i32.const 16)))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $l)))`
			: `(loop $l
   ${stmts.join('\n   ')}
   (local.set $p (i32.add (local.get $p) (i32.const 16)))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $l (i32.ne (local.get $i) (i32.add (local.get $m) (i32.const 1)))))`
  }
  (local.set $acc ${get(result)})
  (local.set $r (i32.sub (local.get $n) (i32.shl (local.get $i) (i32.const 4))))
  (if (local.get $r) (then
   (loop $t
    (local.set $acc (i32.xor (local.get $acc) (i32.load8_u (local.get $p))))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (local.set $r (i32.sub (local.get $r) (i32.const 1)))
    (br_if $t (local.get $r)))))
  (local.get $acc)))`;

let total = 0;
let accepted = 0;
let wrong = 0;
const seenSrc = new Set<string>();
const out: string[] = [];
const t0 = performance.now();
const N = Number(process.argv[3] ?? 3000);
while (total < N) {
	const head = rnd(2) === 0;
	const K = head ? rnd(2) : 0;
	const len = 1 + rnd(4);
	const stmts = Array.from({ length: len }, () => STMTS[rnd(STMTS.length)]!);
	const result = L[rnd(3)]!;
	const wat = program(head, K, stmts, result);
	if (seenSrc.has(wat)) continue;
	seenSrc.add(wat);
	total++;
	let bytes: Uint8Array;
	try {
		bytes = buildModule(wat);
	} catch {
		continue;
	}
	const r = certifyStream(bytes, 'update', { ring: 'gf2' });
	if (r.kind !== 'certificate') continue;
	accepted++;
	const bad = chunkCheck(bytes, 'update', r, [1, 5, 16, 17, 31, 32, 33, 48, 64, 100]);
	if (bad.length) {
		wrong++;
		if (out.length < 8)
			out.push(
				`${head ? 'head' : 'tail'} K=${K} result=${result} stmts=${stmts.map((x) => x.replaceAll(X, 'X')).join(' ; ')}\n    ${bad[0]}`
			);
	}
}
console.log({ total, accepted, wrong, seconds: ((performance.now() - t0) / 1000).toFixed(0) });
for (const o of out) console.log(o);
process.exitCode = wrong ? 1 : 0;
