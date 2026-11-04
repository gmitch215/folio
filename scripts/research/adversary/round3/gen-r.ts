import { mulberry } from '../lib.ts';
import { writeSpecs, type Spec } from './lib.ts';

// usage: gen-r.ts [COUNT]; random residue and output kernels in WAT (expression trees over the
// digits, the byte and constants) as specs/rnd.json under the output directory

const r = mulberry(31337);
const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
const L = (n: string) => `(local.get $${n})`;
const c = (v: number) => `(i32.const ${v | 0})`;
const PS = [65521, 65535, 65536, 251, 255, 65519, 4093, 65537, 3, 2, 257, 40000];
const MASKS = [
	255, 65535, 0xffff0000, 15, 0xff00, 4095, 0xfffe, 0x7fffffff, 1, 0x1ffff, 0xffffff00
];
const KS = [1, 3, 8, 15, 16, 17, 24, 31, 5, 7];
const SMALL = [
	0, 1, 2, 3, 5, 7, 31, 33, 255, 256, 257, 1000, 4093, 65521, 65535, 65536, 40000, 70000
];

function gen(depth: number, vars: string[]): string {
	if (depth <= 0 || r() < 0.2) return r() < 0.7 ? L(pick(vars)) : c(pick(SMALL));
	const k = r();
	const a = () => gen(depth - 1, vars);
	if (k < 0.2) return `(i32.add ${a()} ${a()})`;
	if (k < 0.3) return `(i32.sub ${a()} ${a()})`;
	if (k < 0.42) return `(i32.mul ${a()} ${c(pick(SMALL))})`;
	if (k < 0.58) return `(i32.rem_u ${a()} ${c(pick(PS))})`;
	if (k < 0.66) return `(i32.and ${a()} ${c(pick(MASKS))})`;
	if (k < 0.72) return `(i32.or ${a()} ${a()})`;
	if (k < 0.76) return `(i32.xor ${a()} ${a()})`;
	if (k < 0.86) return `(i32.shl ${a()} ${c(pick(KS))})`;
	return `(i32.shr_u ${a()} ${c(pick(KS))})`;
}

// a structured residue: rem_u of a sum of scaled terms
function lin(vars: string[], P: number): string {
	const terms = vars
		.filter(() => r() < 0.8)
		.map((v) =>
			r() < 0.5 ? L(v) : `(i32.mul ${L(v)} ${c(pick([1, 2, 3, 31, 255, 257, 65520]))})`
		);
	if (!terms.length) terms.push(L(vars[0]!));
	let e = terms.reduce((x, y) => `(i32.add ${x} ${y})`);
	if (r() < 0.3) e = `(i32.add ${e} ${c(pick([1, 7, 255, 65521]))})`;
	return `(i32.rem_u ${e} ${c(P)})`;
}

const byteLoad = `(i32.load8_u (i32.add ${L('p')} ${L('i')}))`;

function residueKernel(): string {
	const P = pick(PS);
	const loInit = pick([
		`(i32.and ${L('s')} ${c(65535)})`,
		`(i32.rem_u ${L('s')} ${c(65536)})`,
		`(i32.sub ${L('s')} (i32.shl (i32.shr_u ${L('s')} ${c(16)}) ${c(16)}))`
	]);
	const hiInit = pick([
		`(i32.shr_u ${L('s')} ${c(16)})`,
		`(i32.shr_u (i32.and ${L('s')} ${c(0xffff0000)}) ${c(16)})`,
		`(i32.div_u ${L('s')} ${c(65536)})`
	]);
	const vars = ['lo', 'hi', 'b'];
	const e1 = r() < 0.7 ? lin(vars, P) : gen(3, vars);
	const e2 =
		r() < 0.7
			? lin(['lo', 'hi', 'b', 't'], pick([P, P, pick(PS)]))
			: gen(3, ['lo', 'hi', 'b', 't']);
	const pack = pick([
		`(i32.or (i32.shl ${L('hi')} ${c(16)}) ${L('lo')})`,
		`(i32.add (i32.shl ${L('hi')} ${c(16)}) ${L('lo')})`,
		`(i32.xor (i32.shl ${L('hi')} ${c(16)}) ${L('lo')})`,
		`(i32.add (i32.mul ${L('hi')} ${c(65536)}) ${L('lo')})`,
		`(i32.or (i32.shl ${L('hi')} ${c(pick([15, 16, 16, 16, 17]))}) (i32.and ${L('lo')} ${c(pick([65535, 65535, 0xfffe, 255]))}))`
	]);
	const body = `(local.set $b ${byteLoad}) (local.set $t ${e1}) (local.set $hi ${e2}) (local.set $lo ${L('t')})`;
	const shape = r();
	const inc = `(local.set $i (i32.add ${L('i')} ${c(1)}))`;
	const loop =
		shape < 0.6
			? `(block $done (loop $l (br_if $done (i32.ge_u ${L('i')} ${L('n')})) ${body} ${inc} (br $l)))`
			: shape < 0.8
				? `(if (i32.ne ${L('n')} ${c(0)}) (then (loop $l ${body} ${inc} (br_if $l (i32.lt_u ${L('i')} ${L('n')})))))`
				: `(block $d1 (loop $l1 (br_if $d1 (i32.gt_u (i32.add ${L('i')} ${c(2)}) ${L('n')})) ${body} ${inc} ${body} ${inc} (br $l1)))
 (block $done (loop $l (br_if $done (i32.ge_u ${L('i')} ${L('n')})) ${body} ${inc} (br $l)))`;
	return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
 (local $lo i32) (local $hi i32) (local $b i32) (local $t i32) (local $i i32)
 (local.set $lo ${loInit}) (local.set $hi ${hiInit})
 ${loop}
 ${pack})`;
}

function stateStep(kind: string): string {
	switch (kind) {
		case 'lcg':
			return `(local.set $s (i32.add (i32.mul ${L('s')} ${c(pick([1664525, 31, 5, 69069, 2, 4, 1103515245, 65537]))}) ${c(pick([1, 1013904223, 7, 12345, 0]))}))`;
		case 'xs':
			return `(local.set $s (i32.xor ${L('s')} (i32.shl ${L('s')} ${c(pick([13, 7, 5, 1, 17]))})))
 (local.set $s (i32.xor ${L('s')} (i32.shr_u ${L('s')} ${c(pick([17, 9, 3, 15, 1]))})))
 (local.set $s (i32.xor ${L('s')} (i32.shl ${L('s')} ${c(pick([5, 11, 25, 8]))})))`;
		case 'ctr':
			return `(local.set $s (i32.add ${L('s')} ${c(pick([1, 3, 7, 0x9e3779b9]))}))`;
		case 'zp': {
			const P = pick([65521, 65535, 251, 65536]);
			return `(local.set $lo (i32.rem_u (i32.add ${L('lo')} ${c(pick([1, 3, 7]))}) ${c(P)}))
 (local.set $hi (i32.rem_u (i32.add ${L('hi')} ${L('lo')}) ${c(P)}))`;
		}
		default:
			return `(local.set $s (i32.xor ${L('s')} ${byteLoad}))`;
	}
}

function outputKernel(): string {
	const kind = pick(['lcg', 'xs', 'ctr', 'zp', 'feed']);
	const zp = kind === 'zp';
	const step = stateStep(kind);
	const st = zp ? `(i32.or (i32.shl ${L('hi')} ${c(16)}) ${L('lo')})` : L('s');
	const keyBase = zp
		? pick([
				L('lo'),
				L('hi'),
				`(i32.xor ${L('lo')} ${L('hi')})`,
				`(i32.add ${L('lo')} ${L('hi')})`
			])
		: L('s');
	const key = pick([
		`(i32.shr_u ${keyBase} ${c(pick([0, 3, 8, 15, 16, 24]))})`,
		`(i32.and ${keyBase} ${c(pick([255, 15, 0xf0, 0x7f]))})`,
		`(i32.xor (i32.shr_u ${keyBase} ${c(3)}) (i32.shr_u ${keyBase} ${c(11)}))`,
		`(i32.mul (i32.shr_u ${keyBase} ${c(8)}) (i32.shr_u ${keyBase} ${c(16)}))`,
		`(i32.rotl ${keyBase} ${c(pick([3, 8, 13]))})`,
		`(i32.shr_u ${keyBase} (i32.and ${keyBase} ${c(7)}))`,
		`(i32.lt_u ${keyBase} ${c(pick([1000, 65536]))})`,
		`(i32.clz ${keyBase})`
	]);
	const old = byteLoad;
	const val = pick([
		`(i32.xor ${old} ${key})`,
		`(i32.add ${old} ${key})`,
		`(i32.sub ${key} ${old})`,
		`(i32.and ${old} ${key})`,
		`(i32.or ${old} ${key})`,
		`(i32.mul ${old} ${key})`,
		`(i32.rotl ${old} (i32.and ${key} ${c(7)}))`,
		`(i32.shl ${old} (i32.and ${key} ${c(7)}))`,
		key,
		`(i32.xor (i32.mul ${old} ${c(pick([3, 5, 33]))}) ${key})`
	]);
	const where = pick(['before', 'after']);
	const store = `(i32.store8 (i32.add ${L('p')} ${L('i')}) ${val})`;
	const inc = `(local.set $i (i32.add ${L('i')} ${c(1)}))`;
	const body = where === 'before' ? `${store} ${step}` : `${step} ${store}`;
	const loopBody = kind === 'feed' ? `${step} ${store}` : body;
	const loInit = zp
		? `(local.set $lo (i32.and ${L('s')} ${c(65535)})) (local.set $hi (i32.shr_u ${L('s')} ${c(16)}))`
		: '';
	const shape = r();
	const loop =
		shape < 0.7
			? `(block $done (loop $l (br_if $done (i32.ge_u ${L('i')} ${L('n')})) ${loopBody} ${inc} (br $l)))`
			: `(if (i32.ne ${L('n')} ${c(0)}) (then (loop $l ${loopBody} ${inc} (br_if $l (i32.lt_u ${L('i')} ${L('n')})))))`;
	return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
 (local $lo i32) (local $hi i32) (local $i i32)
 ${loInit}
 ${loop}
 ${st})`;
}

const out: Spec[] = [];
const seen = new Set<string>();
const target = Number(process.argv[2] ?? 700);
let guard = 0;
while (out.length < target && guard++ < target * 20) {
	const isOut = out.length % 2 === 1;
	const src = isOut ? outputKernel() : residueKernel();
	if (seen.has(src)) continue;
	seen.add(src);
	out.push({
		id: `rnd-${isOut ? 'out' : 'res'}/${out.length}`,
		family: isOut ? 'rnd-out' : 'rnd-res',
		kind: 'wat',
		src,
		note: 'random'
	});
}
writeSpecs('rnd.json', out);
console.log(out.length);
