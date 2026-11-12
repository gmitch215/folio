import { Manifest, mulberry, wat } from './gen-lib.ts';

// family wt-addr: address arithmetic. The effective address of a load or store is base + offset in
// 33 bits and traps past memory; a model that wraps it at 2^32 reads the wrong byte. Offsets near
// 2^32 with a base that wraps back into the input, base wraps at pointer zero, memory.size in the
// fold, fixed loads past the initial memory, loads that straddle the end of the first page.
// usage: gen-addr.ts SEED COUNT
const seed = Number(process.argv[2] ?? 1);
const COUNT = Number(process.argv[3] ?? 120);
const R = mulberry(seed * 8191 + 3);
const pick = <T>(a: readonly T[]): T => a[Math.floor(R() * a.length)]!;
const odd = () => (Math.floor(R() * 2 ** 32) | 1) | 0;
const P_I = '(i32.add (local.get $p) (local.get $i))';
const add = (a: string, b: string) => `(i32.add ${a} ${b})`;
const sub = (a: string, b: string) => `(i32.sub ${a} ${b})`;
const K = (v: number) => `(i32.const ${v})`;
const g = (x: string) => `(local.get $${x})`;

function module(memory: string, loadExpr: string, extraStep: string, storeExpr?: string): string {
	const step = pick([
		`(local.set $s (i32.add (i32.mul ${g('s')} ${K(odd())}) ${g('b')}))`,
		`(local.set $s (i32.xor ${g('s')} ${g('b')})) (local.set $s (i32.xor ${g('s')} (i32.shl ${g('s')} ${K(13)}))) (local.set $s (i32.xor ${g('s')} (i32.shr_u ${g('s')} ${K(17)})))`
	]);
	const store = storeExpr ? storeExpr : '';
	return `(module ${memory} (func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32) (local $i i32) (local $b i32)
 (block $d (loop $L (br_if $d (i32.ge_u ${g('i')} ${g('n')}))
  (local.set $b ${loadExpr}) ${step} ${extraStep} ${store}
  (local.set $i (i32.add ${g('i')} ${K(1)})) (br $L))) ${g('s')}))`;
}

const MEM = '(memory (export "memory") 32 512)';
const kinds: [string, () => string][] = [
	['ld-off-max', () => module(MEM, `(i32.load8_u offset=4294967295 ${add(P_I, K(1))})`, '')],
	[
		'ld-off-wrap',
		() => {
			const x = pick([1, 2, 16, 4096, 65536, 1 << 20]);
			return module(MEM, `(i32.load8_u offset=${2 ** 32 - x} ${add(P_I, K(x))})`, '');
		}
	],
	['ld-base-wrap', () => module(MEM, `(i32.load8_u offset=1 ${sub(P_I, K(1))})`, '')],
	[
		'ld-base-wrap-big',
		() => {
			const x = pick([2, 64, 4096, 65536]);
			return module(MEM, `(i32.load8_u offset=${x} ${sub(P_I, K(x))})`, '');
		}
	],
	['ld-plain', () => module(MEM, `(i32.load8_u ${P_I})`, '')],
	['ld-off-plain', () => module(MEM, `(i32.load8_u offset=1 ${sub(P_I, K(1))})`.replace('offset=1', 'offset=0').replace(sub(P_I, K(1)), P_I), '')],
	[
		'st-off-max',
		() =>
			module(MEM, `(i32.load8_u ${P_I})`, '', `(i32.store8 offset=4294967295 ${add(P_I, K(1))} (i32.xor ${g('b')} (i32.shr_u ${g('s')} ${K(24)})))`)
	],
	[
		'st-base-wrap',
		() =>
			module(MEM, `(i32.load8_u ${P_I})`, '', `(i32.store8 offset=1 ${sub(P_I, K(1))} (i32.xor ${g('b')} (i32.shr_u ${g('s')} ${K(24)})))`)
	],
	[
		'st-off-wrap-big',
		() => {
			const x = pick([16, 4096, 65536]);
			return module(MEM, `(i32.load8_u ${P_I})`, '', `(i32.store8 offset=${2 ** 32 - x} ${add(P_I, K(x))} (i32.xor ${g('b')} (i32.shr_u ${g('s')} ${K(24)})))`);
		}
	],
	['memsize', () => module(MEM, `(i32.load8_u ${P_I})`, `(local.set $s (i32.add ${g('s')} (memory.size)))`)],
	[
		'beyond-init',
		() => {
			const at = pick([65535, 65536, 70000, 1000000]);
			return module('(memory (export "memory") 1 512)', `(i32.load8_u ${P_I})`, `(local.set $s (i32.add ${g('s')} (i32.load8_u ${K(at)})))`);
		}
	],
	[
		'beyond-init-word',
		() => {
			const at = pick([65533, 65534, 65535, 65536]);
			return module('(memory (export "memory") 1 512)', `(i32.load8_u ${P_I})`, `(local.set $s (i32.xor ${g('s')} (i32.load ${K(at)})))`);
		}
	],
	[
		'end-of-first-page',
		() => module('(memory (export "memory") 1 512)', `(i32.load8_u ${P_I})`, `(local.set $s (i32.add ${g('s')} (i32.load8_u offset=${pick([0, 65535, 65536])} ${K(0)})))`)
	],
	['wide-load-low', () => module(MEM, `(i32.and (i32.load ${P_I}) ${K(255)})`, '')],
	['wide-load-high', () => module(MEM, `(i32.shr_u (i32.load offset=${pick([0, 0])} ${P_I}) ${K(24)})`, '')],
	['wide-load16', () => module(MEM, `(i32.and (i32.load16_u ${P_I}) ${K(255)})`, '')],
	['wide-load16-hi', () => module(MEM, `(i32.shr_u (i32.load16_u ${P_I}) ${K(8)})`, '')],
	['load8s', () => module(MEM, `(i32.and (i32.load8_s ${P_I}) ${K(255)})`, '')],
	['load8s-raw', () => module(MEM, `(i32.load8_s ${P_I})`, '')],
	['align-hint', () => module(MEM, `(i32.load8_u align=1 ${P_I})`, '')],
	['i64-addr', () => module(MEM, `(i32.load8_u (i32.wrap_i64 (i64.add (i64.extend_i32_u ${P_I}) (i64.const ${pick([0, 4294967296])}))))`, '')],
	['i64-addr-s', () => module(MEM, `(i32.load8_u (i32.wrap_i64 (i64.add (i64.extend_i32_s ${P_I}) (i64.const 0))))`, '')]
];

const m = new Manifest(`wt-addr-${seed}`);
let tries = 0;
while (m.count < COUNT && tries < COUNT * 8) {
	tries++;
	const [name, mk] = pick(kinds);
	let bytes: Uint8Array;
	try {
		bytes = wat(mk());
	} catch {
		continue;
	}
	m.add('wt-addr', `wt-addr-${seed}/${m.count}-${name}`, bytes, { entry: 'update' });
}
console.log('wt-addr', seed, m.count, 'tries', tries, 'dupes', m.dupes);
