import { certifyStream } from '../../../src/certify.ts';
import { buildModule, chunkCheck } from './lib.ts';

// usage: node fuzz-trips.ts; differential fuzz of the loop trip count: a counter i stepping by D
// toward a bound built from n, a pointer loop folding one byte per iteration, exit tests of every
// kind, head and tail form; exits 1 on a wrong acceptance
const I0S = [0, 1, 5, 0x7fffffff, 0x80000000, 0x80000001, 0xffffffff, 0xfffffff0, 0x40000000];
const DS = [1, -1, 2, 3, -2, 0x40000000, -0x40000000, 0x7fffffff, 0x80000000];
const ES = [0, 1, -1];
const RELS = ['eq', 'ne', 'lt_u', 'le_u', 'gt_u', 'ge_u'];
const rows: string[] = [];
let accepted = 0;
let wrong = 0;
let total = 0;

const wat = (i0: number, d: number, e: number, rel: string, head: boolean, boundForm: number) => {
	const dd = d | 0;
	const bound =
		boundForm === 2
			? `(i32.const ${(i0 + e) | 0})`
			: boundForm === 0
				? `(i32.add (i32.add (i32.const ${i0 | 0}) (i32.mul (local.get $n) (i32.const ${dd}))) (i32.const ${e}))`
				: `(i32.add (i32.add (i32.const ${i0 | 0}) (i32.mul (i32.shr_u (local.get $n) (i32.const 4)) (i32.const ${(dd * 16) | 0}))) (i32.add (i32.and (local.get $n) (i32.const 15)) (i32.const ${e})))`;
	const test = `(i32.${rel} (local.get $i) (local.get $b))`;
	const body = `
    (local.set $s (i32.xor (local.get $s) (i32.load8_u (local.get $p))))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (local.set $i (i32.add (local.get $i) (i32.const ${dd})))`;
	const loop = head
		? `(block $x (loop $l (br_if $x ${test}) ${body} (br $l)))`
		: `(loop $l ${body} (br_if $l ${test}))`;
	return `(module (memory (export "memory") 32 512)
 (func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
  (local $i i32) (local $b i32)
  (if (i32.eqz (local.get $n)) (then (return (local.get $s))))
  (local.set $i ${boundForm === 2 ? `(i32.sub (i32.const ${(i0 + e) | 0}) (i32.mul (local.get $n) (i32.const ${dd})))` : `(i32.const ${i0 | 0})`})
  (local.set $b ${bound})
  ${loop}
  (local.get $s)))`;
};

const t0 = performance.now();
for (const head of [false, true])
	for (const rel of RELS)
		for (const i0 of I0S)
			for (const d of DS)
				for (const e of ES)
					for (const bf of [0, 1, 2]) {
						total++;
						let bytes: Uint8Array;
						try {
							bytes = buildModule(wat(i0, d, e, rel, head, bf));
						} catch {
							continue;
						}
						let r;
						try {
							r = certifyStream(bytes, 'update', { ring: 'gf2' });
						} catch (err) {
							rows.push(
								`THROW ${head} ${rel} i0=${i0} d=${d} e=${e} bf=${bf} ${err}`
							);
							continue;
						}
						if (r.kind !== 'certificate') continue;
						accepted++;
						const bad = chunkCheck(
							bytes,
							'update',
							r,
							[1, 2, 3, 4, 15, 16, 17, 33, 100, 300]
						);
						if (bad.length) {
							wrong++;
							rows.push(
								`WRONG ${head} ${rel} i0=${i0} d=${d} e=${e} bf=${bf}: ${bad[0]}`
							);
						}
					}
console.log({ total, accepted, wrong, seconds: ((performance.now() - t0) / 1000).toFixed(0) });
for (const r of rows.slice(0, 40)) console.log(r);
process.exitCode = wrong ? 1 : 0;
