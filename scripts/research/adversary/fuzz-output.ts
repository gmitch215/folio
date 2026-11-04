import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream, type StreamCertificate } from '../../../src/certify.ts';
import { groundTruth } from '../certify-ground.ts';
import { buildWat, MEMORY32, mulberry, workDir } from './lib.ts';

// random in-place streams: orders of load, state update and store per byte, with odd offsets mixed
// in; every certified module is checked by execution
// usage: fuzz-output.ts [SEED] [MODULES] [DIR]; failing and slow kernels go to DIR (adversary-out by
// default); exits 1 on a wrong acceptance
const seed0 = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 200);
const out = workDir(process.argv[4]);

const addr = (k: string) => `offset=${k} (i32.add (local.get $p) (local.get $i))`;

function kernel(seed: number): string {
	const r = mulberry(seed);
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	const u = pick([1, 2, 2, 4]);
	const odd = r() < 0.25;
	const off = () => (odd && r() < 0.3 ? pick(['__K__+1', '__K__-1', '__K__']) : '__K__');
	// value expressions over s and the loaded byte x
	const val = (): string => {
		const base = pick([
			'(i32.shr_u (local.get $s) (i32.const 24))',
			'(i32.shr_u (local.get $s) (i32.const 16))',
			'(local.get $s)',
			'(i32.mul (local.get $s) (i32.const 3))',
			'(i32.and (local.get $s) (i32.const 255))',
			'(i32.const 17)'
		]);
		const mix = pick(['i32.xor', 'i32.add', 'i32.xor', 'i32.sub']);
		return r() < 0.9 ? `(${mix} (local.get $x) ${base})` : base;
	};
	const upd = (): string =>
		pick([
			'(local.set $s (i32.add (i32.mul (local.get $s) (i32.const 1664525)) (i32.const 13)))',
			'(local.set $s (i32.add (i32.mul (local.get $s) (i32.const 5)) (local.get $x)))',
			'(local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))',
			'(local.set $s (i32.add (local.get $s) (local.get $x)))',
			'(local.set $s (i32.xor (local.get $s) (local.get $x)))',
			'(local.set $s (i32.add (i32.mul (local.get $s) (i32.const 1664525)) (i32.add (local.get $x) (i32.const 13))))'
		]);
	const load = `(local.set $x (i32.load8_u ${addr(off())}))`;
	const store = `(i32.store8 ${addr(off())} ${val()})`;
	const seq: string[] = [];
	if (r() < 0.95) seq.push(load);
	seq.push(upd());
	seq.push(store);
	if (r() < 0.3) seq.push(upd());
	if (r() < 0.2) seq.push(load);
	if (r() < 0.2) seq.push(store);
	if (r() < 0.2) seq.push(`(local.set $x (i32.load8_u ${addr(off())}))`);
	// shuffle lightly
	for (let k = seq.length - 1; k > 0; k--)
		if (r() < 0.25) {
			const j = Math.floor(r() * (k + 1));
			[seq[k], seq[j]] = [seq[j]!, seq[k]!];
		}
	const template = seq.join(' ');
	const text = (k: number) =>
		template.replace(/__K__([+-]1)?/g, (_m, d) => String(k + (d ? Number(d) : 0)));
	const body = (n: number, tail: boolean) =>
		(tail ? text(0) : Array.from({ length: u }, (_, k) => text(k)).join(' ')) +
		`(local.set $i (i32.add (local.get $i) (i32.const ${n})))`;
	const loop = (name: string, end: string, n: number, tail: boolean) =>
		`(if (i32.ne (local.get $i) (local.get $${end})) (then (loop $${name} ${body(n, tail)} (br_if $${name} (i32.ne (local.get $i) (local.get $${end}))))))`;
	return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
		(local $x i32) (local $i i32) (local $m i32)
		(local.set $m (i32.and (local.get $n) (i32.const ${-u})))
		${u > 1 ? loop('main', 'm', u, false) : ''}
		${loop('tail', 'n', 1, true)}
		(local.get $s))`;
}

const save = (name: string, seed: number) => {
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, name), kernel(seed));
};
let certified = 0;
let withOutput = 0;
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
	const t0 = Date.now();
	const res = certifyStream(bytes, 'update', { maxMs: 8000 });
	const took = Date.now() - t0;
	if (took > 3000) {
		console.log(`slow seed ${seed}: ${took} ms`);
		save(`fuzz-output-slow-${seed}.wat`, seed);
	}
	if (res.kind === 'refusal') {
		refused++;
		const why = res.reason.replace(/\d+/g, 'N').slice(0, 100);
		reasons.set(why, (reasons.get(why) ?? 0) + 1);
		continue;
	}
	certified++;
	if (res.output) withOutput++;
	const g = groundTruth(
		bytes,
		res as StreamCertificate,
		[1, 2, 3, 4, 5, 9, 17, 100, 1025],
		1 << 20
	);
	if (g) {
		bad++;
		console.log(`MISMATCH seed ${seed} ring ${res.ring}: ${g}`);
		save(`fuzz-output-${seed}.wat`, seed);
	}
}
console.log(
	`seeds ${seed0}..${seed0 + count - 1}: certified ${certified} (with output ${withOutput}), refused ${refused}, mismatches ${bad}`
);
for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(v, k);
process.exit(bad ? 1 : 0);
