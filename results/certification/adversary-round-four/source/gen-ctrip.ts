import { Manifest, buildC, mulberry } from './gen-lib.ts';

// family ct: trip counts in C. Signed, 16-bit and masked counters, bounds that wrap at 2^16, 2^30
// and 2^32, pointer-counting loops, and a pointer-minus-pointer length, over a few folds, at
// -O1 to -O3 and -Os. usage: gen-ctrip.ts SEED COUNT   (manifest ct-SEED)
const seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 100);
const R = mulberry(seed * 31337 + 5);
const pick = <T>(a: readonly T[]): T => a[Math.floor(R() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const odd = () => `0x${((Math.floor(R() * 2 ** 32) | 1) >>> 0).toString(16)}u`;

const steps = [
	() => `s = s * ${odd()} + b;`,
	() => `s ^= b; for (int k = 0; k < 8; k++) s = (s >> 1) ^ (${odd()} & -(s & 1));`,
	() => `s ^= b; s ^= s << ${int(1, 31)}; s ^= s >> ${int(1, 31)};`,
	() => `s = ((s << ${int(1, 31)}) | (s >> ${int(1, 31)})) ^ b;`,
	() => `s = (s + b) * ${odd()};`
];

const loops: Record<string, (body: string) => string> = {
	idx: (b) => `for (uint32_t i = 0; i < n; i++) { uint32_t b = p[i]; ${b} }`,
	signed: (b) => `for (int i = 0; i < (int)n; i++) { uint32_t b = p[i]; ${b} }`,
	i16: (b) => `for (uint16_t i = 0; i != (uint16_t)n; i++) { uint32_t b = p[i]; ${b} }`,
	i16lt: (b) => `for (uint16_t i = 0; i < n; i++) { uint32_t b = p[i]; ${b} }`,
	mask: (b) => `n &= 0x${pick(['ffff', 'fffff', '7fffffff', 'ffffff'])}; for (uint32_t i = 0; i < n; i++) { uint32_t b = p[i]; ${b} }`,
	mul4: (b) => `for (uint32_t i = 0; i * 4 < n * 4; i++) { uint32_t b = p[i]; ${b} }`,
	ptrlt: (b) => `const uint8_t *e = p + n; for (; p < e; p++) { uint32_t b = *p; ${b} }`,
	ptrne: (b) => `const uint8_t *e = p + n; for (; p != e; p++) { uint32_t b = *p; ${b} }`,
	ptrdiff: (b) => `const uint8_t *q = p; const uint8_t *e = p + n; while ((uint32_t)(e - q) != 0) { uint32_t b = *q++; ${b} }`,
	down: (b) => `while (n != 0) { uint32_t b = *p++; n--; ${b} }`,
	downs: (b) => `while ((int)n > 0) { uint32_t b = *p++; n--; ${b} }`,
	cap: (b) => `if (n > ${int(70000, 300000)}u) n = ${int(70000, 300000)}u; for (uint32_t i = 0; i < n; i++) { uint32_t b = p[i]; ${b} }`,
	lowhigh: (b) => `uint32_t hi = n >> 16, lo = n & 0xffff; for (uint32_t j = 0; j <= hi; j++) { uint32_t m = j < hi ? 0x10000u : lo; for (uint32_t i = 0; i < m; i++) { uint32_t b = *p++; ${b} } }`,
	dowhile: (b) => `uint32_t i = 0; do { uint32_t b = p[i]; ${b} i++; } while (i != n);`,
	big: (b) => `for (uint64_t i = 0; i < (uint64_t)n; i++) { uint32_t b = p[i]; ${b} }`
};

const m = new Manifest(`ct-${seed}`);
let tries = 0;
while (m.count < count && tries < count * 3) {
	tries++;
	const loop = pick(Object.keys(loops));
	const body = pick(steps)();
	const src = `#include <stdint.h>\nuint32_t __attribute__((visibility("default"))) update(uint32_t s, const uint8_t *p, uint32_t n) {\n${loops[loop]!(body)}\nreturn s;\n}\n`;
	const flags = [pick(['-O1', '-O2', '-O2', '-O3', '-Os'])];
	if (R() < 0.3) flags.push('-fno-vectorize');
	if (R() < 0.3) flags.push('-funroll-loops');
	let bytes: Uint8Array;
	try {
		bytes = buildC(src, flags);
	} catch {
		continue;
	}
	m.add('ct', `ct-${seed}/${m.count}-${loop}-${flags.join('')}`, bytes);
}
console.log(`ct-${seed}`, m.count, 'tries', tries, 'dupes', m.dupes);
