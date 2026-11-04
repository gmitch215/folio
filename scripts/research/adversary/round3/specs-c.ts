import { CPRE, type Spec } from './lib.ts';

const OPTS = ['-O1', '-O2', '-O3', '-Os'];
const upd = (body: string, pre = '') =>
	`${CPRE}${pre}\nuint32_t EXPORT update(uint32_t s, const uint8_t *p, uint32_t n) {\n${body}\n}\n`;
const updw = (body: string, pre = '') =>
	`${CPRE}${pre}\nuint32_t EXPORT update(uint32_t s, uint8_t *p, uint32_t n) {\n${body}\n}\n`;

const out: Spec[] = [];
const add = (
	family: string,
	name: string,
	src: string,
	expect?: { p: number },
	opts: string[] = OPTS
) => {
	for (const opt of opts)
		out.push({
			id: `${family}/${name}${opt}`,
			family,
			kind: 'c',
			src,
			opt,
			expect,
			note: name
		});
};

// #region residue kernels

const PS = [65521, 65535, 255, 251, 65519, 4093, 3, 2, 65536];
for (const P of PS)
	for (const K of [1, 2, 4, 8, 16]) {
		const body = `uint32_t s1 = s & 0xffffu, s2 = s >> 16; uint32_t i = 0;
while (i < n) { uint32_t m = n - i < ${K}u ? n - i : ${K}u;
 for (uint32_t j = 0; j < m; j++) { s1 += p[i + j]; s2 += s1; }
 s1 %= ${P}u; s2 %= ${P}u; i += m; }
return (s2 << 16) | s1;`;
		add('rc-block', `P${P}-k${K}`, upd(body), { p: P });
	}

// per byte reduction with variant shapes
for (const P of [65521, 65535, 251]) {
	add(
		'rc-byte',
		`P${P}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % ${P}u; s2 = (s2 + s1) % ${P}u; }
return (s2 << 16) | s1;`),
		{ p: P }
	);
	add(
		'rc-byte',
		`swap-P${P}`,
		upd(`uint32_t s2 = s & 0xffffu, s1 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % ${P}u; s2 = (s2 + s1) % ${P}u; }
return (s1 << 16) | s2;`)
	);
	add(
		'rc-byte',
		`add-pack-P${P}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % ${P}u; s2 = (s2 + s1) % ${P}u; }
return (s2 << 16) + s1;`),
		{ p: P }
	);
	add(
		'rc-byte',
		`fullmod-P${P}`,
		upd(`uint32_t s1 = s % ${P}u, s2 = (s >> 16) % ${P}u;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % ${P}u; s2 = (s2 + s1) % ${P}u; }
return (s2 << 16) | s1;`),
		{ p: P }
	);
	add(
		'rc-byte',
		`u64-P${P}`,
		upd(`uint64_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % ${P}u; s2 = (s2 + s1) % ${P}u; }
return (uint32_t)((s2 << 16) | s1);`),
		{ p: P }
	);
}

// zlib style blocking
for (const NMAX of [5552, 16, 64, 4096, 8192, 65536])
	add(
		'rc-nmax',
		`N${NMAX}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
while (n) { uint32_t k = n < ${NMAX}u ? n : ${NMAX}u; n -= k; while (k--) { s1 += *p++; s2 += s1; } s1 %= 65521u; s2 %= 65521u; }
return (s2 << 16) | s1;`)
	);

// conditional subtract
for (const P of [65521, 65535, 251]) {
	add(
		'rc-cond',
		`if-P${P}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 += p[i]; if (s1 >= ${P}u) s1 -= ${P}u; s2 += s1; if (s2 >= ${P}u) s2 -= ${P}u; }
return (s2 << 16) | s1;`)
	);
	add(
		'rc-cond',
		`mask-P${P}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 += p[i]; s1 -= ${P}u & -(uint32_t)(s1 >= ${P}u); s2 += s1; s2 -= ${P}u & -(uint32_t)(s2 >= ${P}u); }
return (s2 << 16) | s1;`)
	);
	add(
		'rc-cond',
		`while-P${P}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 += p[i]; while (s1 >= ${P}u) s1 -= ${P}u; s2 += s1; while (s2 >= ${P}u) s2 -= ${P}u; }
return (s2 << 16) | s1;`)
	);
}

// runtime unknown modulus
add(
	'rc-runtime',
	'global-mod',
	upd(
		`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % mod; s2 = (s2 + s1) % mod; }
return (s2 << 16) | s1;`,
		'static uint32_t mod = 65521u;'
	),
	{ p: 65521 }
);
add(
	'rc-runtime',
	'volatile-mod',
	upd(
		`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % mod; s2 = (s2 + s1) % mod; }
return (s2 << 16) | s1;`,
		'static volatile uint32_t mod = 65521u;'
	),
	{ p: 65521 }
);
add(
	'rc-runtime',
	'mod-from-state',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16; uint32_t m = (s2 | 1u) + 65000u;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % m; s2 = (s2 + s1) % 65521u; }
return (s2 << 16) | s1;`)
);
add(
	'rc-runtime',
	'mod-from-length',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16; uint32_t m = 65521u + (n & 1u);
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % m; s2 = (s2 + s1) % m; }
return (s2 << 16) | s1;`)
);
add(
	'rc-runtime',
	'mod-from-byte',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % (65000u + p[i]); s2 = (s2 + s1) % 65521u; }
return (s2 << 16) | s1;`)
);

for (const P of [65537, 100003, 1000003, 4294967291])
	add(
		'rc-bigmod',
		`P${P}`,
		upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % ${P}u; s2 = (s2 + s1) % ${P}u; }
return (s2 << 16) | s1;`)
	);

// fletcher 8-bit
for (const keep of [0, 1])
	add(
		'rc-fl16',
		`keep${keep}`,
		upd(`uint32_t s1 = s & 0xffu, s2 = (s >> 8) & 0xffu;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % 255u; s2 = (s2 + s1) % 255u; }
return ${keep ? '(s & 0xffff0000u) | ' : ''}(s2 << 8) | s1;`)
	);

// third sum
add(
	'rc-three',
	'unused',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16, s3 = 0;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % 65521u; s2 = (s2 + s1) % 65521u; s3 = (s3 + s2) % 65521u; }
return (s2 << 16) | s1;`),
	{ p: 65521 }
);
add(
	'rc-three',
	'mixed',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16, s3 = 0;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % 65521u; s2 = (s2 + s1) % 65521u; s3 = (s3 + s2) % 65521u; }
return (((s2 + s3) % 65521u) << 16) | s1;`)
);

// different coefficients
const coef = [
	[1, 1, 0, 1, 1],
	[2, 1, 0, 1, 1],
	[31, 1, 0, 1, 1],
	[257, 1, 7, 1, 1],
	[40000, 1, 0, 1, 1],
	[65520, 3, 0, 3, 2],
	[70000, 1, 0, 1, 1],
	[1, 3, 0, 65520, 1],
	[1, 255, 7, 3, 40000],
	[31, 255, 0, 31, 31],
	[1, 1, 0, 1, 70000],
	[3, 1, 5, 7, 11]
];
for (const P of [65521, 251])
	for (const [a, b, c, e, f] of coef!)
		add(
			'rc-coef',
			`P${P}-${a}-${b}-${c}-${e}-${f}`,
			upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (${a}u * s1 + ${b}u * p[i] + ${c}u) % ${P}u; s2 = (${e}u * s2 + ${f}u * s1) % ${P}u; }
return (s2 << 16) | s1;`),
			a! < 40001 && b! < 300 && e! < 65521 && f! < 40001 ? { p: P } : undefined,
			['-O2', '-O3']
		);

// a residue and a raw counter
const counters: [string, string][] = [
	['and', 'c = (c + 1u) & 0xffffu;'],
	['rem', 'c = (c + 1u) % 65536u;'],
	['raw', 'c = c + 1u;'],
	['u16', 'c = (uint16_t)(c + 1u);'],
	['and17', 'c = (c + 1u) & 0x1ffffu;'],
	['add3', 'c = (c + 3u) & 0xffffu;'],
	['byte', 'c = (c + p[i]) & 0xffffu;'],
	['mix', 'c = (c + s1) & 0xffffu;']
];
for (const [name, upd1] of counters)
	add(
		'rc-counter',
		name,
		upd(`uint32_t s1 = s & 0xffffu, c = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % 65521u; ${upd1} }
return (c << 16) | s1;`),
		['and', 'rem', 'raw', 'u16', 'and17', 'add3', 'byte'].includes(name)
			? { p: 65521 }
			: undefined
	);
add(
	'rc-counter',
	'overlap15',
	upd(`uint32_t s1 = s & 0xffffu, c = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % 65521u; c = (c + 1u) & 0xffffu; }
return (c << 15) | s1;`)
);

// tail only reduction
add(
	'rc-tail',
	'hi-raw',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + p[i]) % 65521u; s2 += s1; }
s2 %= 65521u; return (s2 << 16) | s1;`)
);
add(
	'rc-tail',
	'both-raw',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 += p[i]; s2 += s1; }
s1 %= 65521u; s2 %= 65521u; return (s2 << 16) | s1;`)
);
add(
	'rc-tail',
	'lo-raw',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 += p[i]; s2 = (s2 + s1) % 65521u; }
s1 %= 65521u; return (s2 << 16) | s1;`)
);
add(
	'rc-tail',
	'only-tail-lo',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s2 = (s2 + s1) % 65521u; s1 = (s1 + p[i]); }
s1 %= 65521u; return (s2 << 16) | s1;`)
);

// polynomial hashes mod a prime
for (const B of [31, 33, 131, 257])
	for (const P of [65521, 4093, 251, 65537]) {
		add(
			'rc-poly',
			`B${B}-P${P}-full`,
			upd(`uint32_t h = s % ${P}u;
for (uint32_t i = 0; i < n; i++) h = (h * ${B}u + p[i]) % ${P}u;
return h;`),
			undefined,
			['-O2']
		);
		add(
			'rc-poly',
			`B${B}-P${P}-u64`,
			upd(`uint64_t h = s % ${P}u;
for (uint32_t i = 0; i < n; i++) h = (h * ${B}u + p[i]) % ${P}u;
return (uint32_t)h;`),
			undefined,
			['-O2']
		);
		add(
			'rc-poly',
			`B${B}-P${P}-low`,
			upd(`uint32_t h = s & 0xffffu;
for (uint32_t i = 0; i < n; i++) h = (h * ${B}u + p[i]) % ${P}u;
return h;`),
			undefined,
			['-O2', '-O3']
		);
	}
add(
	'rc-poly',
	'pass-hi',
	upd(`uint32_t h = s & 0xffffu;
for (uint32_t i = 0; i < n; i++) h = (h * 31u + p[i]) % 65521u;
return (s & 0xffff0000u) | h;`)
);

// position dependent weights
add(
	'rc-weight',
	'index',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + (i + 1u) * p[i]) % 65521u; s2 = (s2 + s1) % 65521u; }
return (s2 << 16) | s1;`)
);
add(
	'rc-weight',
	'running',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16, w = 1;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + w * p[i]) % 65521u; s2 = (s2 + s1) % 65521u; w = (w * 3u) % 65521u; }
return (s2 << 16) | s1;`)
);
add(
	'rc-weight',
	'parity',
	upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { s1 = (s1 + ((i & 1u) ? 3u * p[i] : p[i])) % 65521u; s2 = (s2 + s1) % 65521u; }
return (s2 << 16) | s1;`)
);

// unrolled bodies with one lane wrong
const lane = (k: number, bug: string, lane: number) => {
	const b = `p[i + ${k}]`;
	if (k === lane && bug === 'skip2') return `s1 += ${b};`;
	if (k === lane && bug === 'twice') return `s1 += ${b}; s1 += ${b}; s2 += s1;`;
	if (k === lane && bug === 'order') return `s2 += s1; s1 += ${b};`;
	if (k === lane && bug === 'coef') return `s1 += ${b}; s2 += s1 + 1u;`;
	return `s1 += ${b}; s2 += s1;`;
};
for (const U of [2, 4, 8])
	for (const bug of ['none', 'skip2', 'twice', 'order', 'coef', 'tail'])
		for (const ln of bug === 'none' || bug === 'tail' ? [0] : [0, U - 1]) {
			const unrolled = Array.from({ length: U }, (_, k) => lane(k, bug, ln)).join(' ');
			const tailBug = bug === 'tail' ? 's1 += p[i]; s2 += s1 + s1;' : 's1 += p[i]; s2 += s1;';
			add(
				'rc-unroll',
				`U${U}-${bug}-${ln}`,
				upd(`uint32_t s1 = s & 0xffffu, s2 = s >> 16; uint32_t i = 0;
for (; i + ${U}u <= n; i += ${U}u) { ${unrolled} s1 %= 65521u; s2 %= 65521u; }
for (; i < n; i++) { ${tailBug} s1 %= 65521u; s2 %= 65521u; }
return (s2 << 16) | s1;`),
				bug === 'none' ? { p: 65521 } : undefined,
				['-O1', '-O2', '-Os']
			);
		}

// #endregion

// #region output kernels

const OUTK: [string, string, string?][] = [
	['lcg-xor', 's = s * 1664525u + 1013904223u; p[i] ^= (uint8_t)(s >> 24);'],
	['lcg-xor8', 's = s * 1664525u + 1013904223u; p[i] ^= (uint8_t)(s >> 8);'],
	['lcg-xor0', 's = s * 1664525u + 1013904223u; p[i] ^= (uint8_t)s;'],
	['lcg-add', 's = s * 1664525u + 1013904223u; p[i] += (uint8_t)(s >> 24);'],
	['lcg-sub', 's = s * 1664525u + 1013904223u; p[i] = (uint8_t)(s >> 24) - p[i];'],
	['lcg-mul', 's = s * 1664525u + 1013904223u; p[i] = (uint8_t)((p[i] * 3u) ^ (s >> 24));'],
	['lcg-old', 'p[i] ^= (uint8_t)(s >> 24); s = s * 1664525u + 1013904223u;'],
	['xs-xor', 's ^= s << 13; s ^= s >> 17; s ^= s << 5; p[i] ^= (uint8_t)s;'],
	['xs-add', 's ^= s << 13; s ^= s >> 17; s ^= s << 5; p[i] += (uint8_t)s;'],
	[
		'xs-rot',
		's ^= s << 13; s ^= s >> 17; s ^= s << 5; p[i] = (uint8_t)((p[i] << 3) | (p[i] >> 5)) ^ (uint8_t)s;'
	],
	['xs-plus', 's = s ^ (s << 13); s = s + (s >> 17); s ^= s << 5; p[i] ^= (uint8_t)s;'],
	['ctr-mul', 's += 1u; p[i] ^= (uint8_t)((s * 2654435761u) >> 24);'],
	['ctr-mulplus', 's += 7u; p[i] ^= (uint8_t)((s * 2654435761u + 12345u) >> 16);'],
	['ctr-sbox', 's += 1u; p[i] ^= sbox[s & 255u];', 'sbox'],
	['ctr-sbox16', 's += 1u; p[i] ^= sbox[(s >> 4) & 15u];', 'sbox16'],
	['ctr-sbox-hi', 's += 1u; p[i] ^= sbox[(s >> 8) & 255u];', 'sbox'],
	[
		'rot-var',
		's += 1u; p[i] = (uint8_t)((p[i] << (s & 7u)) | (p[i] >> ((8u - (s & 7u)) & 7u)));'
	],
	['rot-const', 's = s * 31u + 7u; p[i] = (uint8_t)(((p[i] << 3) | (p[i] >> 5)) ^ (s >> 24));'],
	['cbc-ct', 'uint8_t ct = p[i] ^ (uint8_t)(s >> 24); p[i] = ct; s = s * 31u + ct;'],
	['cbc-pt', 'uint8_t pt = p[i]; p[i] = pt ^ (uint8_t)(s >> 24); s = s * 31u + pt;'],
	['cbc-xor', 'uint8_t pt = p[i]; p[i] = pt ^ (uint8_t)s; s = (s << 8) | pt;'],
	['feed-add', 's = s * 31u + p[i]; p[i] ^= (uint8_t)(s >> 24);'],
	['idx-key', 'p[i] ^= (uint8_t)(i * 37u);'],
	['idx-lcg', 's = s * 5u + 1u; p[i] ^= (uint8_t)(s >> 24) ^ (uint8_t)i;'],
	['ptr-key', 'p[i] ^= (uint8_t)((uintptr_t)p >> 3);'],
	['rem-key', 'p[i] ^= (uint8_t)(n - i);'],
	['len-key', 's += 1u; p[i] ^= (uint8_t)(s ^ n);'],
	['readback', 'p[i] ^= (uint8_t)(s >> 24); s = s * 31u + *(volatile uint8_t *)&p[i];'],
	['sum-after', 'p[i] ^= 0x5au; s += p[i];'],
	['neighbor', 'p[i] = p[i] ^ p[i - 1];', 'start1'],
	['neighbor-next', 'p[i] = p[i] ^ p[i + 1];'],
	['write-next', 's = s * 31u + 1u; p[i + 1] = (uint8_t)(s >> 24);'],
	['write-nowrite-zero', 's = s * 31u + 1u; p[i] = 0;'],
	['write-state', 's = s * 31u + 1u; p[i] = (uint8_t)(s >> 24);'],
	['cond-write', 'if (p[i] & 1u) p[i] = (uint8_t)s; s = s * 31u + 1u;'],
	['cond-state', 's = s * 31u + 1u; if ((s >> 24) & 1u) p[i] ^= 0xffu;'],
	['cond-state-all', 's = s * 31u + 1u; p[i] ^= (uint8_t)(((s >> 24) & 1u) ? 0xffu : 0x00u);'],
	['xor-const', 'p[i] ^= 0x5au; s = s * 31u + 1u;'],
	['xor-const-only', 'p[i] ^= 0x5au;'],
	['inc', 'p[i] += 1u; s += 1u;'],
	['neg', 'p[i] = (uint8_t)(0u - p[i]); s = s * 3u;'],
	['gf-xor', 's = (s >> 1) ^ (0xedb88320u & -(s & 1u)); p[i] ^= (uint8_t)s;'],
	[
		'gf-crc-in',
		's ^= p[i]; for (int k = 0; k < 8; k++) s = (s >> 1) ^ (0xedb88320u & -(s & 1u)); p[i] ^= (uint8_t)s;'
	],
	['self-mul', 's = s * s + 1u; p[i] ^= (uint8_t)(s >> 24);'],
	[
		'sbox-feed',
		's = ((uint32_t)sbox[s & 255u] << 8) ^ (s >> 4) ^ 77u; p[i] ^= (uint8_t)s;',
		'sbox'
	],
	['shr-feed', 's = s * 1664525u + 1013904223u; s ^= s >> 15; p[i] ^= (uint8_t)(s >> 24);'],
	[
		'two-keys',
		's = s * 1664525u + 1013904223u; p[i] = (uint8_t)((p[i] ^ (s >> 24)) + (s >> 16));'
	],
	['high-store', 's = s * 1664525u + 1013904223u; p[i] = (uint8_t)(s >> 24); s += p[i];']
];
const SBOX = `static const uint8_t sbox[256] = {${Array.from({ length: 256 }, (_, k) => (k * 167 + 13) & 255).join(',')}};`;
const SBOX16 = `static const uint8_t sbox[16] = {${Array.from({ length: 16 }, (_, k) => (k * 29 + 5) & 255).join(',')}};`;
for (const [name, body, tbl] of OUTK) {
	const pre = tbl === 'sbox' ? SBOX : tbl === 'sbox16' ? SBOX16 : '';
	const start = tbl === 'start1' ? 1 : 0;
	add(
		'oc-loop',
		name,
		updw(`for (uint32_t i = ${start}; i < n; i++) { ${body} }\nreturn s;`, pre)
	);
}

// keystream state kinds with zp state
const ZP: [string, string][] = [
	['ctr', 's1 = (s1 + 1u) % 65521u; s2 = (s2 + s1) % 65521u; p[i] ^= (uint8_t)s2;'],
	['ctr-cast', 's1 = (s1 + 1u) % 65521u; s2 = (s2 + s1) % 65521u; p[i] ^= (uint8_t)(s2 >> 4);'],
	['ctr-mod256', 's1 = (s1 + 7u) % 65521u; s2 = (s2 + s1) % 65521u; p[i] ^= s2 % 256u;'],
	['ctr-xorlo', 's1 = (s1 + 1u) % 251u; s2 = (s2 + s1) % 251u; p[i] ^= (uint8_t)(s1 ^ s2);'],
	['ctr-add', 's1 = (s1 + 1u) % 65535u; s2 = (s2 + s1) % 65535u; p[i] += (uint8_t)s1;'],
	['feed', 's1 = (s1 + p[i]) % 65521u; s2 = (s2 + s1) % 65521u; p[i] ^= (uint8_t)s2;'],
	[
		'feed-old',
		'uint8_t o = p[i]; s1 = (s1 + o) % 65521u; s2 = (s2 + s1) % 65521u; p[i] = (uint8_t)(o + s2);'
	],
	['set', 's1 = (s1 + 3u) % 65521u; s2 = (s2 + s1) % 65521u; p[i] = (uint8_t)(s1 + s2);'],
	['hi-raw', 's1 = (s1 + 1u) % 65521u; s2 = s2 + s1; p[i] ^= (uint8_t)s2;'],
	['wrap', 's1 = (s1 + 1u) % 65521u; s2 = (s2 + s1) % 65521u; p[i] ^= (uint8_t)(s2 + s1);'],
	['c16', 's1 = (s1 + 1u) & 0xffffu; s2 = (s2 + s1) & 0xffffu; p[i] ^= (uint8_t)(s2 >> 8);'],
	['mulc', 's1 = (s1 * 3u + 1u) % 65521u; s2 = (s2 + s1) % 65521u; p[i] ^= (uint8_t)s1;']
];
for (const [name, body] of ZP)
	add(
		'oc-zp',
		name,
		updw(`uint32_t s1 = s & 0xffffu, s2 = s >> 16;
for (uint32_t i = 0; i < n; i++) { ${body} }
return (s2 << 16) | s1;`)
	);

// in place kernels with structure the loop summary must see
add(
	'oc-struct',
	'unroll4-ok',
	updw(`uint32_t i = 0;
for (; i + 4 <= n; i += 4) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); s = s * 31u + 1u; p[i + 1] ^= (uint8_t)(s >> 24); s = s * 31u + 1u; p[i + 2] ^= (uint8_t)(s >> 24); s = s * 31u + 1u; p[i + 3] ^= (uint8_t)(s >> 24); }
for (; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
return s;`)
);
for (const lane of [0, 1, 2, 3])
	add(
		'oc-struct',
		`unroll4-bad${lane}`,
		updw(`uint32_t i = 0;
for (; i + 4 <= n; i += 4) { ${[0, 1, 2, 3].map((k) => `s = s * 31u + 1u; p[i + ${k}] ^= (uint8_t)(s >> ${k === lane ? 23 : 24});`).join(' ')} }
for (; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
return s;`)
	);
add(
	'oc-struct',
	'tail-bad',
	updw(`uint32_t i = 0;
for (; i + 4 <= n; i += 4) { ${[0, 1, 2, 3].map((k) => `s = s * 31u + 1u; p[i + ${k}] ^= (uint8_t)(s >> 24);`).join(' ')} }
for (; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 25); }
return s;`)
);
add(
	'oc-struct',
	'tail-state-bad',
	updw(`uint32_t i = 0;
for (; i + 4 <= n; i += 4) { ${[0, 1, 2, 3].map((k) => `s = s * 31u + 1u; p[i + ${k}] ^= (uint8_t)(s >> 24);`).join(' ')} }
for (; i < n; i++) { s = s * 31u + 2u; p[i] ^= (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'n17',
	updw(`for (uint32_t i = 0; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
if (n >= 17u) p[3] ^= 1u;
return s;`)
);
add(
	'oc-struct',
	'n17-store-after',
	updw(`for (uint32_t i = 0; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
if (n == 17u) p[16] ^= 1u;
return s;`)
);
add(
	'oc-struct',
	'n7-fixed',
	updw(`for (uint32_t i = 0; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
if (n == 7u) *(volatile uint8_t *)1048000 = 9;
return s;`)
);
add(
	'oc-struct',
	'two-ptr',
	updw(`uint8_t *q = p;
for (uint32_t i = 0; i < n; i++) { s = s * 31u + 1u; q[i] = (uint8_t)(q[i] ^ (s >> 24)); }
return s;`)
);
add(
	'oc-struct',
	'mirror',
	updw(`uint8_t *q = p + n - 1;
for (uint32_t i = 0; i < n; i++) { s = s * 31u + 1u; q[-(int32_t)i] ^= (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'reverse',
	updw(`for (uint32_t i = n; i > 0; i--) { s = s * 31u + 1u; p[i - 1] ^= (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'pairs',
	updw(`uint32_t i = 0;
for (; i + 2 <= n; i += 2) { s = s * 31u + 1u; uint8_t a = p[i], b = p[i + 1]; p[i] = b ^ (uint8_t)(s >> 24); p[i + 1] = a ^ (uint8_t)(s >> 16); }
for (; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'swap',
	updw(`uint32_t i = 0;
for (; i + 2 <= n; i += 2) { uint8_t a = p[i]; p[i] = p[i + 1]; p[i + 1] = a; s += 1u; }
return s;`)
);
add(
	'oc-struct',
	'pack16',
	updw(`uint32_t i = 0;
for (; i + 2 <= n; i += 2) { s = s * 31u + 1u; *(uint16_t *)(p + i) ^= (uint16_t)(s >> 16); }
for (; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'pack32',
	updw(`uint32_t i = 0;
for (; i + 4 <= n; i += 4) { s = s * 31u + 1u; *(uint32_t *)(p + i) ^= s; }
for (; i < n; i++) { s = s * 31u + 1u; p[i] ^= (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'word-same',
	updw(`uint32_t i = 0;
for (; i + 4 <= n; i += 4) { uint32_t w = *(uint32_t *)(p + i); w ^= 0x5a5a5a5au; *(uint32_t *)(p + i) = w; s += 4u; }
for (; i < n; i++) { p[i] ^= 0x5au; s += 1u; }
return s;`)
);
add(
	'oc-struct',
	'memset',
	updw(`for (uint32_t i = 0; i < n; i++) { p[i] = 0; }
return s;`)
);
add(
	'oc-struct',
	'memset-state',
	updw(`for (uint32_t i = 0; i < n; i++) { s = s * 31u + 1u; p[i] = (uint8_t)(s >> 24); }
return s;`)
);
add(
	'oc-struct',
	'swap-state-byte',
	updw(`for (uint32_t i = 0; i < n; i++) { uint8_t b = p[i]; p[i] = (uint8_t)s; s = (s << 8) | b; }
return s;`)
);
add(
	'oc-struct',
	'scan',
	updw(`uint8_t prev = (uint8_t)s;
for (uint32_t i = 0; i < n; i++) { uint8_t b = p[i]; p[i] = b ^ prev; prev = b; }
return prev;`)
);
add(
	'oc-struct',
	'scan-state',
	updw(`uint8_t prev = (uint8_t)s;
for (uint32_t i = 0; i < n; i++) { uint8_t b = p[i]; p[i] = b ^ prev; prev = b; }
return (s & 0xffffff00u) | prev;`)
);
add(
	'oc-struct',
	'scan-out',
	updw(`uint8_t prev = (uint8_t)s;
for (uint32_t i = 0; i < n; i++) { uint8_t b = p[i]; prev ^= b; p[i] = prev; }
return (s & 0xffffff00u) | prev;`)
);

// #endregion

// #region opaque

const OPQ: [string, string, string?][] = [
	['shr-feed', 's = s * 1664525u + 1013904223u; s ^= s >> 15; s += p[i];'],
	['xs-plus', 's ^= s << 13; s += s >> 17; s ^= p[i];'],
	['sbox-feed', 's = ((uint32_t)sbox[s & 255u] << 8) ^ (s >> 8) ^ p[i];', 'sbox'],
	['self-mul', 's = s * s + p[i];'],
	['self-mul-const', 's = s * s;'],
	['branch', 'if ((s >> 15) & 1u) s += 3u; s += p[i];'],
	['branch-and', 'if (s & 0xffu) s ^= 0x1234u; s += p[i];'],
	['addr-p', 'p[(s >> 3) & 15u] ^= 1u; s += p[i];'],
	['addr-state-load', 's += p[i + (s & 3u)];'],
	['table-state', 's = s * 31u + tbl[(s >> 8) & 255u] + p[i];', 'sbox'],
	['table-byte', 's = s * 31u + tbl[p[i]];', 'sbox'],
	['table-xor-state', 's = (s ^ tbl[p[i]]) * 31u;', 'sbox'],
	['clz', 's = s * 31u + __builtin_clz(s | 1u) + p[i];'],
	['popcnt', 's = s * 31u + __builtin_popcount(s) + p[i];'],
	['popcnt-byte', 's = s * 31u + __builtin_popcount(p[i]);'],
	['bool', 's = s * 31u + (s > 1000u) + p[i];'],
	['shift-var', 's = (s << (p[i] & 7u)) + 1u;'],
	['shift-state', 's = (s >> (s & 7u)) + p[i];'],
	['rotl-var', 's = ((s << (p[i] & 15u)) | (s >> (32u - (p[i] & 15u)))) + 1u;'],
	['mul-two', 's = s * (s | 1u) + p[i];'],
	['div', 's = s / 3u + p[i];'],
	['rem-state', 's = s % 1000003u + p[i];'],
	['xor-byte-mul', 's = (s ^ p[i]) * 16777619u;'],
	['and-state', 's = (s & 0xf0f0f0f0u) + p[i];'],
	['or-state', 's = (s | 0x0f0f0f0fu) + p[i];'],
	['sub-state-const', 's = 0xffffffffu - s + p[i];'],
	['ltu-state', 's = (s < 0x80000000u ? s + 1u : s - 1u) + p[i];'],
	['byte-sq', 's = s * 31u + p[i] * p[i];'],
	['byte-and-byte', 's = s * 31u + (p[i] & (p[i] >> 1));'],
	['byte-shift-byte', 's = s * 31u + (p[i] << (p[i] & 3u));']
];
for (const [name, body, tbl] of OPQ) {
	const pre = tbl ? SBOX.replace('sbox', 'sbox') + '\n#define tbl sbox' : '';
	add(
		'op-fold',
		name,
		updw(
			`for (uint32_t i = 0; i < n; i++) { ${body} }\nreturn s;`,
			pre.replace('#define tbl sbox', 'static const uint8_t *const tbl = sbox;')
		),
		undefined,
		['-O1', '-O2', '-Os']
	);
}
// nonlinear function of state reaching the output only, with the state still linear
const OPO: [string, string][] = [
	['shr-key', 's = s * 1664525u + 1013904223u; p[i] ^= (uint8_t)((s >> 15) ^ (s >> 3));'],
	['mul-key', 's = s * 1664525u + 1013904223u; p[i] ^= (uint8_t)((s >> 8) * (s >> 16));'],
	['sbox-key', 's += 1u; p[i] ^= sbox[(s >> 3) & 255u] ^ sbox[s & 255u];'],
	['cmp-key', 's += 1u; p[i] ^= (uint8_t)(s > 1000u);'],
	['clz-key', 's += 1u; p[i] ^= (uint8_t)__builtin_clz(s);'],
	['popcnt-key', 's += 3u; p[i] ^= (uint8_t)__builtin_popcount(s);'],
	['and-key', 's = s * 31u + 7u; p[i] ^= (uint8_t)((s & 0xf0f0u) >> 4);'],
	['rot-key', 's = s * 31u + 7u; p[i] ^= (uint8_t)((s << 5) | (s >> 27));'],
	['state-addr-store', 's = s * 31u + 7u; p[i + (s & 1u)] ^= 1u;'],
	['state-branch-store', 's = s * 31u + 7u; if (s & 0x100u) p[i] ^= 1u;'],
	[
		'two-atoms',
		's = s * 31u + 7u; uint8_t a = (uint8_t)(s >> 3), b = (uint8_t)(s >> 5); p[i] = a ^ b ^ p[i];'
	],
	['atom-byte', 's = s * 31u + 7u; p[i] = (uint8_t)((s >> 3) * p[i]);'],
	['atom-byte-shift', 's = s * 31u + 7u; p[i] = (uint8_t)(p[i] >> ((s >> 3) & 7u));']
];
for (const [name, body] of OPO)
	add(
		'op-out',
		name,
		updw(`for (uint32_t i = 0; i < n; i++) { ${body} }\nreturn s;`, SBOX),
		undefined,
		['-O1', '-O2', '-O3']
	);

// #endregion

export const cSpecs = out;
