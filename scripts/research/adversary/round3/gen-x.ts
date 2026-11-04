import { writeSpecs, type Spec } from './lib.ts';

// hand built attacks on the offset immediate: wasm adds it to the address without wrapping, the
// checker wraps it; writes specs/extra.json under the output directory

const L = (n: string) => `(local.get $${n})`;
const c = (v: number) => `(i32.const ${v | 0})`;
const base = `(i32.add ${L('p')} ${L('i')})`;

interface Addr {
	expr: string;
	off: number;
}

// the byte address as pre-offset expression and immediate that both reach p + i in the checker
const addrs: [string, (k: number) => Addr][] = [
	['wrap', (k) => ({ expr: `(i32.add ${base} ${c(k)})`, off: 2 ** 32 - k })],
	['neg', (k) => ({ expr: `(i32.sub ${base} ${c(k)})`, off: k })]
];
const KS = [1, 2, 5, 16, 100, 127];

const ld = (a: Addr) => `(i32.load8_u offset=${a.off} ${a.expr})`;
const st = (a: Addr, v: string) => `(i32.store8 offset=${a.off} ${a.expr} ${v})`;
const loop = (body: string) =>
	`(block $done (loop $l (br_if $done (i32.ge_u ${L('i')} ${L('n')})) ${body} (local.set $i (i32.add ${L('i')} ${c(1)})) (br $l)))`;
const fn = (
	body: string,
	ret = L('s')
) => `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
 (local $i i32) (local $lo i32) (local $hi i32)
 ${body}
 ${ret})`;
const lcg = `(local.set $s (i32.add (i32.mul ${L('s')} ${c(1664525)}) ${c(1013904223)}))`;
const key = `(i32.shr_u ${L('s')} ${c(24)})`;

const kernels: Record<string, (a: Addr) => string> = {
	z2w: (a) => fn(loop(`(local.set $s (i32.add (i32.mul ${L('s')} ${c(31)}) ${ld(a)}))`)),
	gf2: (a) =>
		fn(
			loop(
				`(local.set $s (i32.xor ${L('s')} ${ld(a)})) (local.set $s (i32.xor ${L('s')} (i32.shl ${L('s')} ${c(13)}))) (local.set $s (i32.xor ${L('s')} (i32.shr_u ${L('s')} ${c(17)})))`
			)
		),
	zp: (a) =>
		fn(
			`(local.set $lo (i32.and ${L('s')} ${c(65535)})) (local.set $hi (i32.shr_u ${L('s')} ${c(16)}))
 ${loop(`(local.set $lo (i32.rem_u (i32.add ${L('lo')} ${ld(a)}) ${c(65521)})) (local.set $hi (i32.rem_u (i32.add ${L('hi')} ${L('lo')}) ${c(65521)}))`)}`,
			`(i32.or (i32.shl ${L('hi')} ${c(16)}) ${L('lo')})`
		),
	out: (a) => fn(loop(`${lcg} ${st(a, `(i32.xor (i32.load8_u ${base}) ${key})`)}`)),
	outload: (a) => fn(loop(`${lcg} ${st(a, `(i32.xor ${ld(a)} ${key})`)}`))
};

const out: Spec[] = [];
for (const [kn, make] of Object.entries(kernels))
	for (const [an, mk] of addrs)
		for (const k of KS)
			out.push({
				id: `x-offset/${kn}-${an}-${k}`,
				family: 'x-offset',
				kind: 'wat',
				src: make(mk(k)),
				note: `offset immediate ${an} ${k} in a ${kn} kernel`
			});
// controls: the same kernels with an honest address
for (const [kn, make] of Object.entries(kernels))
	out.push({
		id: `x-offset/${kn}-plain`,
		family: 'x-offset',
		kind: 'wat',
		src: make({ expr: base, off: 0 }),
		note: 'control'
	});
// honest nonzero offsets
for (const [kn, make] of Object.entries(kernels))
	for (const k of [1, 4, 100])
		out.push({
			id: `x-offset/${kn}-honest-${k}`,
			family: 'x-offset',
			kind: 'wat',
			src: make({ expr: `(i32.add ${base} ${c(-k)})`, off: k }),
			note: 'p + i - k with offset k: wraps at pointer below k'
		});
writeSpecs('extra.json', out);
console.log(out.length);
