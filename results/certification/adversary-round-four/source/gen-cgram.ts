import { Manifest, buildC, mulberry } from './gen-lib.ts';

// family cg: a grammar of small random byte-folding C programs, built at -O0..-O3, -Os, -Oz with and
// without -funroll-loops and -fno-vectorize through the repo fixture rules (freestanding, no
// node_modules/.bin on PATH, no SIMD). Shapes cover bitwise and table CRCs, xorshift and rotate
// folds, integer multiply-add folds with sign-extension and byte-wrap traps, residue folds, and
// in-place keystream kernels, behind index, pointer, countdown, unrolled and 16-bit-read loops.
// usage: gen-cgram.ts SEED COUNT   (manifest cg-SEED)

const seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 100);
const R = mulberry(seed * 7919 + 13);
const pick = <T>(a: readonly T[]): T => a[Math.floor(R() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const chance = (p: number) => R() < p;

interface Ctx {
	W: 32 | 64;
	T: string;
	c: (v: bigint) => string;
	rnd: (bits?: number) => bigint;
}

const mkCtx = (W: 32 | 64): Ctx => ({
	W,
	T: W === 32 ? 'uint32_t' : 'uint64_t',
	c: (v) => `0x${BigInt.asUintN(W, v).toString(16)}${W === 32 ? 'u' : 'ull'}`,
	rnd: (bits = W) => {
		let v = 0n;
		for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(Math.floor(R() * 65536));
		return BigInt.asUintN(bits, v);
	}
});

const crcTable = (W: number, poly: bigint, reflected: boolean): bigint[] => {
	const m = (1n << BigInt(W)) - 1n;
	const out: bigint[] = [];
	for (let i = 0n; i < 256n; i++) {
		let c = reflected ? i : i << BigInt(W - 8);
		for (let k = 0; k < 8; k++)
			c = reflected
				? (c >> 1n) ^ (c & 1n ? poly : 0n)
				: ((c << 1n) & m) ^ ((c >> BigInt(W - 1)) & 1n ? poly : 0n);
		out.push(c & m);
	}
	return out;
};

type Kind = 'gf2' | 'z2w' | 'zp' | 'mixed';
interface Step {
	kind: Kind;
	/** declarations before the loop */
	pre: string;
	/** statements per byte; reads b, writes s */
	body: string;
	/** statements to run after the loop */
	post: string;
	tag: string;
}

function gf2Step(x: Ctx): Step {
	const { W, T, c } = x;
	const poly = x.rnd() | 1n;
	const t = pick([
		'bitcrc',
		'bitcrc',
		'msbcrc',
		'table',
		'table',
		'tablecorrupt',
		'xsb',
		'rot',
		'mulspread',
		'parity',
		'cond',
		'sub'
	]);
	let pre = '';
	let body = '';
	if (t === 'bitcrc')
		body = `s ^= b; for (int k = 0; k < 8; k++) s = (s >> 1) ^ (${c(poly)} & -(s & 1));`;
	else if (t === 'msbcrc')
		body = `s ^= (${T})b << ${W - 8}; for (int k = 0; k < 8; k++) s = (s << 1) ^ (${c(poly)} & -(s >> ${W - 1}));`;
	else if (t === 'table' || t === 'tablecorrupt') {
		const refl = chance(0.7);
		const tab = crcTable(W, poly, refl);
		if (t === 'tablecorrupt') {
			const i = int(0, 255);
			tab[i] = tab[i]! ^ (1n << BigInt(int(0, W - 1)));
		}
		pre = `static const ${T} TAB[256] = {${tab.map(c).join(',')}};\n`;
		body = refl
			? `s = (s >> 8) ^ TAB[(s ^ b) & 255];`
			: `s = (s << 8) ^ TAB[((s >> ${W - 8}) ^ b) & 255];`;
	} else if (t === 'xsb') {
		const [a, bb, d] = [int(1, W - 1), int(1, W - 1), int(1, W - 1)];
		body = `s ^= b; s ^= s << ${a}; s ^= s >> ${bb}; s ^= s << ${d};`;
	} else if (t === 'rot') {
		const k = int(1, W - 1);
		body = pick([
			`s = ((s << ${k}) | (s >> ${W - k})) ^ b;`,
			`s = ((s << ${k}) | (s >> ${W - k})) + b;`,
			`s = ((s << ${k}) ^ (s >> ${W - k})) ^ ((${T})b << ${int(0, W - 8)});`
		]);
	} else if (t === 'mulspread') {
		const C = pick([
			'0x01010101u',
			'0x00010001u',
			'0x101u',
			'3u',
			'0x81u',
			'0x80808080u',
			'0x10101u',
			'0x0100u'
		]);
		body = `s = ((s << 1) | (s >> ${W - 1})) ^ ((${T})b * ${C});`;
	} else if (t === 'parity')
		body = pick([
			`s = (s << 1) | (${T})__builtin_parity((uint32_t)(s ^ b));`,
			`s = (s << 1) | (${T})(__builtin_popcount((uint32_t)s ^ b) & 1);`,
			`s = (s << 1) ^ (${T})__builtin_parity((uint32_t)s & ${c(poly & 0xffffffffn)}) ^ b;`
		]);
	else if (t === 'cond')
		body = pick([
			`if (b & 1) s ^= ${c(poly)}; s = (s >> 1) ^ (s << ${W - 1});`,
			`s ^= (b & 0x80) ? ${c(poly)} : 0; s = (s << 3) ^ (s >> ${W - 3}) ^ b;`,
			`if (s & 1) s = (s >> 1) ^ ${c(poly)}; else s >>= 1; s ^= b;`,
			`if (s >> ${W - 1}) s = (s << 1) ^ ${c(poly)}; else s <<= 1; s ^= b;`
		]);
	else
		body = pick([
			`s = ((s ^ b) << 1) ^ (s >> 1);`,
			`s ^= b; s ^= (s >> 3) ^ (s << 5) ^ (s >> 11);`,
			`s = ~s ^ b; s = (s >> 1) ^ (s << 7);`
		]);
	return { kind: 'gf2', pre, body, post: '', tag: t };
}

function z2wStep(x: Ctx): Step {
	const { T, c } = x;
	const M = x.rnd() | 1n;
	const A = x.rnd();
	const C = x.rnd(16) | 1n;
	const k = int(1, 12);
	const t = pick([
		'mulb',
		'mulbc',
		'shiftadd',
		'mulsub',
		'addmul',
		'sext',
		'bytewrap',
		'xormul',
		'halfword',
		'bshift',
		'bxor',
		'mulc'
	]);
	const body: Record<string, string> = {
		mulb: `s = s * ${c(M)} + b;`,
		mulbc: `s = s * ${c(M)} + (${T})b * ${c(C)} + ${c(A)};`,
		shiftadd: `s = (s << ${k}) + s + b;`,
		mulsub: `s = s * ${c(M)} - b;`,
		addmul: `s += b; s *= ${c(M)};`,
		sext: `s = s * ${c(M)} + (${T})(int8_t)b;`,
		bytewrap: `s = s * ${c(M)} + (uint8_t)(b + ${int(1, 255)});`,
		xormul: `s = (s ^ b) * ${c(M)};`,
		halfword: `s = s * ${c(M)} + (uint16_t)((uint16_t)b * ${int(2, 300)});`,
		bshift: `s = s * ${c(M)} + (b >> 1);`,
		bxor: `s = s * ${c(M)} + (b ^ ${int(1, 255)});`,
		mulc: `s = s * ${c(M)} + ${c(A)} + b;`
	};
	const affine = ['mulb', 'mulbc', 'shiftadd', 'mulsub', 'addmul', 'mulc'].includes(t);
	return { kind: affine ? 'z2w' : 'mixed', pre: '', body: body[t]!, post: '', tag: t };
}

function zpStep(x: Ctx): Step {
	const P = pick([251, 255, 257, 65521, 65535, 65536, 40000, 3, 65521, 65521]);
	const t = pick(['adler', 'adler', 'condsub', 'fletcher', 'lazy', 'three', 'weighted']);
	const T = 'uint32_t';
	let body = '';
	let pre = '';
	if (t === 'adler')
		body = `s1 = (s1 + b) % ${P}u; s2 = (s2 + s1) % ${P}u;`;
	else if (t === 'condsub')
		body = `s1 += b; if (s1 >= ${P}u) s1 -= ${P}u; s2 += s1; if (s2 >= ${P}u) s2 -= ${P}u;`;
	else if (t === 'fletcher') body = `s1 = (s1 + b) % ${P}u; s2 = (s2 + s1 + b) % ${P}u;`;
	else if (t === 'lazy') {
		const k = pick([2, 4, 8, 16]);
		pre = `uint32_t cnt = 0;`;
		body = `s1 += b; s2 += s1; if (++cnt == ${k}u) { cnt = 0; s1 %= ${P}u; s2 %= ${P}u; }`;
	} else if (t === 'three')
		body = `s1 = (s1 + b) % ${P}u; s2 = (s2 + s1) % ${P}u; s2 = (s2 + (s1 << 1)) % ${P}u;`;
	else body = `s1 = (s1 + b) % ${P}u; s2 = (s2 + s1 * ${int(2, 9)}u) % ${P}u;`;
	void T;
	return {
		kind: 'zp',
		pre: `uint32_t s1 = s & 0xffffu, s2 = s >> 16;\n${pre}`,
		body,
		post: t === 'lazy' ? `s1 %= ${P}u; s2 %= ${P}u;\n` : '',
		tag: `${t}-${P}`
	};
}

function mixedStep(x: Ctx): Step {
	const { W, T, c } = x;
	const a = int(1, W - 1);
	const body = pick([
		`s = (s ^ b) * ${c(x.rnd() | 1n)};`,
		`s += b; s ^= s >> ${a};`,
		`s = (s >> ${a}) ^ (s * ${c(x.rnd() | 1n)}) ^ b;`,
		`s ^= b; s = s * s + ${c(x.rnd())};`,
		`s = (s << 1) ^ (b > (s & 255) ? 1 : 0);`,
		`if (b > 128) s += ${c(x.rnd())}; s = s * 3 + 1;`
	]);
	return { kind: 'mixed', pre: '', body, post: '', tag: 'mixed' };
}

function makeStep(x: Ctx): Step {
	const k = pick(['gf2', 'gf2', 'gf2', 'z2w', 'z2w', 'z2w', 'zp', 'mixed'] as const);
	if (k === 'zp' && x.W === 32) return zpStep(x);
	if (k === 'gf2') return gf2Step(x);
	if (k === 'z2w') return z2wStep(x);
	return mixedStep(x);
}

function program(): { src: string; flags: string[]; tag: string } {
	const W: 32 | 64 = chance(0.2) ? 64 : 32;
	const x = mkCtx(W);
	const step = makeStep(x);
	const zp = step.kind === 'zp';
	const out = !zp && chance(0.3);
	const outForm = pick([
		'p[i] ^= (uint8_t)(s >> 24);',
		'p[i] ^= (uint8_t)s;',
		'p[i] = (uint8_t)(p[i] + (uint8_t)(s >> 8));',
		'p[i] = (uint8_t)(p[i] - (uint8_t)(s >> 16));',
		'p[i] = (uint8_t)((p[i] << 1) | (p[i] >> 7)) ^ (uint8_t)(s >> 3);',
		'p[i] = (uint8_t)s;',
		'p[i] ^= (uint8_t)(s >> 24) ^ (uint8_t)i;',
		'p[i] = (uint8_t)(s >> 24); '
	]);
	const loop = pick(['idx', 'idx', 'ptr', 'ptrlt', 'down', 'down2', 'unroll2', 'unroll4', 'half']);
	const early = chance(0.12) ? pick(['if (n == 0) return s;', 'if (n == 0) return s ^ 1u;', 'n &= 0xffffu;', 'if (n > 100000u) n = 100000u;']) : '';
	const bind = zp ? '' : '';
	const stepOn = (byte: string) => `{ ${W === 64 ? 'uint64_t' : 'uint32_t'} b = ${byte}; ${step.body} }`;
	const stepAt = (off: string) => stepOn(`p[i${off}]`);
	// out kernels read the byte, step, then write; the byte read happens before the write
	const withOut = (byte: string, put: string) =>
		`{ ${W === 64 ? 'uint64_t' : 'uint32_t'} b = ${byte}; ${step.body} ${put} }`;
	const cnt = loop === 'idx' ? 'i' : 'i';
	void cnt;
	let loopSrc = '';
	const put = (off: string) => outForm.replace(/p\[i\]/g, `p[i${off}]`);
	const one = (off: string) => (out ? withOut(`p[i${off}]`, put(off)) : stepAt(off));
	if (loop === 'idx') loopSrc = `for (uint32_t i = 0; i < n; i++) ${one('')}`;
	else if (loop === 'ptr' || loop === 'ptrlt') {
		// the pointer variant walks q and aliases p[i] through i = 0
		loopSrc = `{ const uint8_t *e = p + n; ${out ? '' : ''}${loop === 'ptr' ? 'while (p != e)' : 'for (; p < e; )'} { uint32_t i = 0; ${out ? `uint8_t *w = (uint8_t *)p;` : ''} ${out ? withOut('p[0]', outForm.replace(/p\[i\]/g, 'w[0]')) : stepOn('p[0]')} p++; } }`;
	} else if (loop === 'down')
		loopSrc = `{ uint32_t i = 0; while (n--) { ${one('')} i++; } }`;
	else if (loop === 'down2')
		loopSrc = `{ uint32_t i = 0; if (n) do { ${one('')} i++; } while (--n); }`;
	else if (loop === 'unroll2')
		loopSrc = `{ uint32_t i = 0; for (; i + 2 <= n; i += 2) { ${one('')} ${one('+1')} } for (; i < n; i++) ${one('')} }`;
	else if (loop === 'unroll4')
		loopSrc = `{ uint32_t i = 0; for (; i + 4 <= n; i += 4) { ${one('')} ${one('+1')} ${one('+2')} ${one('+3')} } for (; i < n; i++) ${one('')} }`;
	else
		loopSrc = `{ uint32_t i = 0; for (; i + 2 <= n; i += 2) { uint32_t w = p[i] | ((uint32_t)p[i + 1] << 8); ${W === 64 ? 'uint64_t' : 'uint32_t'} b = w & 255u; ${out ? '' : step.body} ${out ? `${step.body} ${put('')}` : ''} b = w >> 8; ${out ? `${step.body} ${put('+1')}` : step.body} } for (; i < n; i++) ${one('')} }`;
	const head = `#include <stdint.h>\n${step.pre.startsWith('static') ? step.pre : ''}`;
	const decl = step.pre.startsWith('static') ? '' : step.pre;
	const sig = `${x.T} __attribute__((visibility("default"))) update(${x.T} s, ${out ? '' : 'const '}uint8_t *p, uint32_t n) {`;
	const ret = zp ? `${step.post}return (s2 << 16) | s1;` : 'return s;';
	const src = `${head}${sig}\n${early}\n${decl}${bind}\n${loopSrc}\n${ret}\n}\n`;
	const opt = pick(['-O0', '-O1', '-O1', '-O2', '-O2', '-O2', '-O3', '-O3', '-Os', '-Oz']);
	const flags = [opt];
	if (chance(0.3)) flags.push('-funroll-loops');
	if (chance(0.3)) flags.push('-fno-vectorize');
	if (chance(0.15)) flags.push('-fno-slp-vectorize');
	if (chance(0.1)) flags.push('-fno-inline');
	if (chance(0.1)) flags.push('-fwrapv');
	return { src, flags, tag: `${W}-${step.kind}-${step.tag}-${out ? 'out' : 'ro'}-${loop}` };
}

const m = new Manifest(`cg-${seed}`);
let tries = 0;
let build = 0;
const t0 = Date.now();
while (m.count < count && tries < count * 3 && Date.now() - t0 < 100_000) {
	tries++;
	const p = program();
	let bytes: Uint8Array;
	try {
		bytes = buildC(p.src, p.flags);
	} catch (e) {
		build++;
		if (build <= 3) console.log('build error', p.tag, String(e).slice(0, 300));
		continue;
	}
	m.add('cg', `cg-${seed}/${m.count}-${p.tag}-${p.flags.join('')}`, bytes);
}
console.log(`cg-${seed}`, m.count, 'tries', tries, 'build errors', build, 'dupes', m.dupes, 'invalid', m.invalid);
