import { CPRE, writeSpecs, type Spec } from './lib.ts';

// 64 bit state kernels, 32 bit states updated through 64 bit intermediates, and a few shapes the
// other families do not reach; writes specs/extra2.json under the output directory
const out: Spec[] = [];
const k64 = (name: string, body: string, ret = 'uint64_t', write = true) => {
	const src = `${CPRE}\n${ret} EXPORT update(${ret} s, ${write ? '' : 'const '}uint8_t *p, uint32_t n) {\n${body}\n}\n`;
	for (const opt of ['-O1', '-O2', '-O3', '-Os'])
		out.push({ id: `y-64/${name}${opt}`, family: 'y-64', kind: 'c', src, opt, note: name });
};
const read64 = (name: string, body: string) => k64(name, body, 'uint64_t', false);
k64(
	'lcg64-xor',
	'for (uint32_t i = 0; i < n; i++) { s = s * 6364136223846793005ull + 1442695040888963407ull; p[i] ^= (uint8_t)(s >> 56); } return s;'
);
k64(
	'lcg64-add',
	'for (uint32_t i = 0; i < n; i++) { s = s * 6364136223846793005ull + 1442695040888963407ull; p[i] += (uint8_t)(s >> 33); } return s;'
);
k64(
	'xs64',
	'for (uint32_t i = 0; i < n; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; p[i] ^= (uint8_t)s; } return s;'
);
k64(
	'xs64-hi',
	'for (uint32_t i = 0; i < n; i++) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; p[i] ^= (uint8_t)(s >> 56); } return s;'
);
k64(
	'xs64star',
	'for (uint32_t i = 0; i < n; i++) { s ^= s >> 12; s ^= s << 25; s ^= s >> 27; p[i] ^= (uint8_t)((s * 0x2545F4914F6CDD1Dull) >> 56); } return s;'
);
k64(
	'splitmix',
	'for (uint32_t i = 0; i < n; i++) { s += 0x9E3779B97F4A7C15ull; uint64_t z = s; z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull; z = (z ^ (z >> 27)) * 0x94D049BB133111EBull; z ^= z >> 31; p[i] ^= (uint8_t)z; } return s;'
);
k64('ctr64', 'for (uint32_t i = 0; i < n; i++) { s += 1; p[i] ^= (uint8_t)(s >> 3); } return s;');
read64('poly64', 'for (uint32_t i = 0; i < n; i++) s = s * 31 + p[i]; return s;');
read64('fnv64', 'for (uint32_t i = 0; i < n; i++) { s ^= p[i]; s *= 0x100000001b3ull; } return s;');
read64(
	'crc64',
	'for (uint32_t i = 0; i < n; i++) { s ^= p[i]; for (int k = 0; k < 8; k++) s = (s >> 1) ^ (0xc96c5795d7870f42ull & -(s & 1ull)); } return s;'
);
read64('mix64', 'for (uint32_t i = 0; i < n; i++) { s = (s << 5) ^ (s >> 59) ^ p[i]; } return s;');
read64(
	'rot64',
	'for (uint32_t i = 0; i < n; i++) { s = ((s << 7) | (s >> 57)) + p[i]; } return s;'
);
k64(
	'feed64',
	'for (uint32_t i = 0; i < n; i++) { s = s * 31 + p[i]; p[i] ^= (uint8_t)(s >> 56); } return s;'
);
read64(
	'hi-only',
	'for (uint32_t i = 0; i < n; i++) { s = (s >> 8) | ((uint64_t)p[i] << 56); } return s;'
);
read64(
	'wide-mul32',
	'for (uint32_t i = 0; i < n; i++) { s = (s * 0x9E3779B1u + p[i]) & 0xffffffffull; } return s;'
);
k64(
	'trunc-store',
	'for (uint32_t i = 0; i < n; i++) { s = s * 31 + 7; p[i] = (uint8_t)(s >> 59) ^ p[i]; } return s;'
);

const k32 = (name: string, body: string, write = false) => {
	const src = `${CPRE}\nuint32_t EXPORT update(uint32_t s, ${write ? '' : 'const '}uint8_t *p, uint32_t n) {\n${body}\n}\n`;
	for (const opt of ['-O1', '-O2', '-O3'])
		out.push({ id: `y-32w/${name}${opt}`, family: 'y-32w', kind: 'c', src, opt, note: name });
};
k32(
	'wide-shr',
	'for (uint32_t i = 0; i < n; i++) { uint64_t t = (uint64_t)s * 2654435761ull + p[i]; s = (uint32_t)(t >> 3); } return s;'
);
k32(
	'wide-mod',
	'for (uint32_t i = 0; i < n; i++) { uint64_t t = (uint64_t)s * 31ull + p[i]; s = (uint32_t)(t % 4294967291ull); } return s;'
);
k32(
	'wide-lo',
	'for (uint32_t i = 0; i < n; i++) { uint64_t t = (uint64_t)s * 31ull + p[i]; s = (uint32_t)t; } return s;'
);
k32(
	'wide-hi-xor',
	'for (uint32_t i = 0; i < n; i++) { uint64_t t = (uint64_t)s * 2654435761ull + p[i]; s = (uint32_t)(t ^ (t >> 32)); } return s;'
);
k32(
	'mulhi',
	'for (uint32_t i = 0; i < n; i++) { s = (uint32_t)(((uint64_t)s * 3ull) >> 1) + p[i]; } return s;'
);
k32(
	'adler-wide',
	'uint64_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { a = (a + p[i]) % 65521; b = (b + a) % 65521; } return (uint32_t)((b << 16) | a);'
);
k32(
	'adler-lazy64',
	'uint64_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { a += p[i]; b += a; } a %= 65521; b %= 65521; return (uint32_t)((b << 16) | a);'
);
k32(
	'adler-ctr-out',
	'uint64_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { a = (a + 1) % 65521; b = (b + a) % 65521; p[i] ^= (uint8_t)b; } return (uint32_t)((b << 16) | a);',
	true
);
k32(
	'adler-ctr-out-hi',
	'uint32_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { a = (a + 1) % 65521; b = (b + a) % 65521; p[i] = (uint8_t)(b >> 8) + p[i]; } return (b << 16) | a;',
	true
);
k32(
	'adler-ctr-out-sum',
	'uint32_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { a = (a + 1) % 65521; b = (b + a) % 65521; p[i] = (uint8_t)(a + b); } return (b << 16) | a;',
	true
);
k32(
	'adler-ctr-out-feed',
	'uint32_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { uint8_t o = p[i]; a = (a + o) % 65521; b = (b + a) % 65521; p[i] = (uint8_t)b; } return (b << 16) | a;',
	true
);
k32(
	'adler-ctr-out-seq',
	'uint32_t a = s & 0xffff, b = s >> 16; for (uint32_t i = 0; i < n; i++) { p[i] ^= (uint8_t)a; a = (a + 1) % 65521; b = (b + a) % 65521; } return (b << 16) | a;',
	true
);

writeSpecs('extra2.json', out);
console.log(out.length);
