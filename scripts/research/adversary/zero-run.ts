import { predictEnd } from '../../../src/affine.ts';
import { certifyStream, type StreamCertificate } from '../../../src/certify.ts';
import { groundTruth } from '../certify-ground.ts';
import { buildWat, MEMORY32, zeroRun } from './lib.ts';

// in-place kernels whose state step ignores the bytes, one per ring and one with a 64 bit state: the
// doubling that reconstructCertified uses (zeroRun) must give the end state of the real kernel from raw
// start states; a kernel that is refused or has no step counts as a failure
// usage: zero-run.ts; exits 1 on a mismatch
const get = (n: string) => `(local.get $${n})`;
const set = (n: string, v: string) => `(local.set $${n} ${v})`;
const c = (v: number) => `(i32.const ${v})`;

const stream = (init: string, update: string, ret: string, key: string) => `
(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
	(local $a i32) (local $b i32) (local $x i32) (local $i i32)
	${init}
	(if (i32.ne ${get('i')} ${get('n')}) (then
		(loop $l
			${set('x', `(i32.load8_u (i32.add ${get('p')} ${get('i')}))`)}
			${update}
			(i32.store8 (i32.add ${get('p')} ${get('i')}) (i32.xor ${get('x')} ${key}))
			${set('i', `(i32.add ${get('i')} ${c(1)})`)}
			(br_if $l (i32.ne ${get('i')} ${get('n')})))))
	${ret})`;

const k64 = (v: bigint) => `(i64.const ${BigInt.asIntN(64, v)})`;
const kernels: Record<string, { text: string; bits: 32 | 64 }> = {
	gf2: {
		bits: 32,
		text: stream(
			'',
			`${set('s', `(i32.xor (i32.xor ${get('s')} (i32.shl ${get('s')} ${c(13)})) ${c(0x12345677)})`)}
		${set('s', `(i32.xor ${get('s')} (i32.shr_u ${get('s')} ${c(17)}))`)}`,
			get('s'),
			`(i32.shr_u ${get('s')} ${c(24)})`
		)
	},
	z2w: {
		bits: 32,
		text: stream(
			'',
			set('s', `(i32.add (i32.mul ${get('s')} ${c(1664525)}) ${c(1013904223)})`),
			get('s'),
			`(i32.shr_u ${get('s')} ${c(24)})`
		)
	},
	zp: {
		bits: 32,
		text: stream(
			`${set('a', `(i32.and ${get('s')} ${c(65535)})`)} ${set('b', `(i32.shr_u ${get('s')} ${c(16)})`)}`,
			`${set('a', `(i32.rem_u (i32.add (i32.mul ${get('a')} ${c(3)}) ${c(1)}) ${c(65521)})`)}
		${set('b', `(i32.rem_u (i32.add (i32.add ${get('b')} (i32.mul ${get('a')} ${c(5)})) ${c(7)}) ${c(65521)})`)}`,
			`(i32.or (i32.shl ${get('b')} ${c(16)}) ${get('a')})`,
			`(i32.and ${get('b')} ${c(255)})`
		)
	},
	xorshift64: {
		bits: 64,
		text: `(func $update (export "update") (param $s i64) (param $p i32) (param $n i32) (result i64)
	(local $x i32) (local $i i32)
	(if (i32.ne ${get('i')} ${get('n')}) (then
	(loop $l
		${set('x', `(i32.load8_u (i32.add ${get('p')} ${get('i')}))`)}
		${set('s', `(i64.xor (i64.xor ${get('s')} (i64.shl ${get('s')} (i64.const 13))) ${k64(0x9e3779b97f4a7c15n)})`)}
		${set('s', `(i64.xor ${get('s')} (i64.shr_u ${get('s')} (i64.const 7)))`)}
		(i32.store8 (i32.add ${get('p')} ${get('i')}) (i32.xor ${get('x')} (i32.wrap_i64 (i64.shr_u ${get('s')} (i64.const 56)))))
		${set('i', `(i32.add ${get('i')} ${c(1)})`)}
		(br_if $l (i32.ne ${get('i')} ${get('n')})))))
	${get('s')})`
	}
};

const INITS = [0n, 1n, 0xffffffffn, 0x80000000n, 0xfff1fff1n, 0xdeadbeefn];
const INITS64 = [0n, 1n, 0xffffffffffffffffn, 0x8000000000000000n, 0xdeadbeefcafef00dn];
const LENS = [...Array.from({ length: 70 }, (_, k) => k + 1), 127, 128, 129, 1000, 4097, 65537];

let failed = 0;
for (const [name, { text, bits }] of Object.entries(kernels)) {
	const bytes = buildWat(text, MEMORY32);
	const cert = certifyStream(bytes, 'update');
	if (cert.kind !== 'certificate' || !cert.output || cert.output.step === undefined) {
		failed++;
		console.log(`${name}: no step`, cert.kind === 'refusal' ? cert.reason.slice(0, 200) : '');
		continue;
	}
	const ground = groundTruth(bytes, cert as StreamCertificate, [1, 2, 3, 5, 17, 100], 1 << 20);
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	let bad = 0;
	for (const init of bits === 64 ? INITS64 : INITS)
		for (const len of LENS) {
			const inst = new WebAssembly.Instance(mod, {});
			const fn = inst.exports.update as (...a: (number | bigint)[]) => number | bigint;
			const arg = bits === 64 ? BigInt.asIntN(64, init) : Number(BigInt.asIntN(32, init));
			const real = BigInt.asUintN(bits, BigInt(fn(arg, 4096, len)));
			const guess = predictEnd(cert.model, init, len, zeroRun(cert, len));
			if (real !== guess) {
				bad++;
				if (bad < 4)
					console.log(
						`${name} MISMATCH init ${init.toString(16)} length ${len}: real ${real.toString(16)} predicted ${guess.toString(16)}`
					);
			}
		}
	if (bad || ground) failed++;
	console.log(
		`${name}: step ${cert.output.step}, ring ${cert.ring}, ground ${ground || 'ok'}, zeroRun mismatches ${bad}`
	);
}
process.exit(failed ? 1 : 0);
