import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream } from '../../../src/certify.ts';
import { clang, env } from '../affine-build.ts';
import { mulberry, sha256, workDir } from './lib.ts';

// usage: node gen-clang.ts [DIR]; 60 C kernels at four levels and their mutants under DIR/modules
const root = workDir(process.argv[2]);
const HEAD = 'typedef unsigned int u32;\n';
const KS = [
	0x01000193, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35, 31, 33, 0x27d4eb2d, 0x165667b1, 1000003,
	16777619, 0x5bd1e995, 0x9e3779b9
];
const RS = [1, 3, 5, 7, 13, 16];
const BYTE_TABLE = (f: (b: number) => number) =>
	Array.from({ length: 256 }, (_, b) => `${f(b) & 255}`).join(',');

// each template takes a parameter set p (0 to 2) and a kernel salt s and returns the C file body
const templates: ((p: number, s: number) => string)[] = [
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) h = h * ${KS[(p + s) % 12]}u + x[i] * ${KS[(p + 2 * s + 1) % 12]}u; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) { h ^= x[i]; h ^= h << ${RS[(p + s) % 6]}; } return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) { h = (h ^ x[i]) * ${KS[(p + s) % 12]}u; h = (h << ${RS[(p + s) % 6]}) | (h >> (32 - ${RS[(p + s) % 6]})); } return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { const unsigned char *e = x + n; for (; x != e; x++) h = h * ${KS[(p + s) % 12]}u + *x; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { while (n--) h = h * ${KS[(p + s) % 12]}u + *x++; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) h = h * ${KS[(p + s) % 12]}u + x[i] + x[i + 1]; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) { h = h * ${KS[(p + s) % 12]}u + x[i]; h = h * ${KS[(p + s) % 12]}u + x[i]; } return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { while (n >= 4) { u32 w = x[0] | x[1] << 8 | x[2] << 16 | (u32)x[3] << 24; h = h * ${KS[(p + s) % 12]}u + w; x += 4; n -= 4; } while (n--) h = h * ${KS[(p + s) % 12]}u + *x++; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { while (n >= 4) { h = h * ${KS[(p + s) % 12]}u + x[0]; h = h * ${KS[(p + s) % 12]}u + x[1]; h = h * ${KS[(p + s) % 12]}u + x[2]; h = h * ${KS[(p + s) % 12]}u + x[3]; x += 4; n -= 4; } while (n--) h = h * ${KS[(p + s) % 12]}u + *x++; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) { h = h * ${KS[(p + s) % 12]}u + x[i]; if (h > ${[0x7fffffff, 0x10000000, 0xfffff, 0x3fffffff][(p + s) % 4]}u) h = ${[0x7fffffff, 0x10000000, 0xfffff, 0x3fffffff][(p + s) % 4]}u; } return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { u32 a = h & 0xffff, c = h >> 16; for (u32 i = 0; i < n; i++) { a = (a * ${KS[(p + s) % 12]! & 0xffff}u + x[i]) & 0xffff; c = (c + a) & 0xffff; } return a | c << 16; }`,
	(p, s) =>
		`static const unsigned char T[256] = {${BYTE_TABLE((b) => b * 7 + 3)}}; u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) h = h * ${KS[(p + s) % 12]}u + T[x[i]]; return h; }`,
	(p, s) =>
		`static const unsigned char T[256] = {${BYTE_TABLE((b) => b ^ (0x5a + p + s))}}; u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) h = (h << 1) ^ T[x[i]]; return h; }`,
	(p, s) =>
		`static volatile u32 seen; u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) h = h * ${KS[(p + s) % 12]}u + x[i]; seen = seen + 1; return h ^ (seen & 1); }`,
	(p, s) =>
		`static unsigned char buf[16]; u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) { buf[i & 15] = x[i]; h = h * ${KS[(p + s) % 12]}u + buf[i & 15]; } return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (u32 i = 0; i < n; i++) h = h * ${KS[(p + s) % 12]}u + x[i]; if (n > ${[16, 64, 1000, 65536][(p + s) % 4]}u) h ^= 0x55; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { u32 m = n / 2; for (u32 i = 0; i < m; i++) h = h * ${KS[(p + s) % 12]}u + x[i]; for (u32 i = m; i < n; i++) h = h * ${KS[(p + s) % 12]}u + x[i]; return h; }`,
	(p, s) =>
		`u32 update(u32 h, const unsigned char *x, u32 n) { for (; n >= 3; n -= 3, x += 3) { h = h * ${KS[(p + s) % 12]}u + x[0]; h = h * ${KS[(p + s) % 12]}u + x[1]; h = h * ${KS[(p + s) % 12]}u + x[2]; } while (n--) h = h * ${KS[(p + s) % 12]}u + *x++; return h; }`
];

const kernels: { id: string; src: string }[] = [];
for (let j = 0; j < 60; j++) {
	const t = j % templates.length;
	const p = Math.floor(j / templates.length);
	const s = (j * 7 + 3) % 5;
	kernels.push({
		id: `k${String(j).padStart(2, '0')}-t${t}`,
		src: HEAD + templates[t]!(p, s) + '\n'
	});
}

const flagsFor = (level: string) => [
	'--target=wasm32',
	`-O${level}`,
	'-g0',
	'-ffreestanding',
	'-fno-builtin',
	'-nostdlib',
	'-mbulk-memory',
	'-Wl,--no-entry,--export-memory,--export=update',
	'-Wl,--initial-memory=2097152,--max-memory=536870912'
];

function compile(src: string, out: string, level: string) {
	const cfile = out.replace(/\.wasm$/, '.c');
	writeFileSync(cfile, src);
	execFileSync(clang, [...flagsFor(level), cfile, '-o', out], { env, stdio: 'pipe' });
	return readFileSync(out);
}

const dir = join(root, 'modules/clang');
const mutantDir = join(root, 'modules/clang-mutant');
mkdirSync(dir, { recursive: true });
mkdirSync(mutantDir, { recursive: true });
const index: object[] = [];
const seen = new Set<string>();
for (const k of kernels) {
	for (const level of ['1', '2', '3', 's']) {
		const id = `${k.id}-O${level}`;
		const bytes = compile(k.src, join(dir, `${id}.wasm`), level);
		const digest = sha256(bytes);
		if (seen.has(digest)) console.log('duplicate module', id);
		seen.add(digest);
		index.push({ id, family: 'clang', sha256: digest, note: `${k.id} at -O${level}` });
	}
}

// mutants: one literal changed in the O2 source of each kernel the certifier accepts
const rnd = mulberry(20260503);
let mutants = 0;
for (const k of kernels) {
	const base = join(dir, `${k.id}-O2.wasm`);
	const verdict = certifyStream(new Uint8Array(readFileSync(base)), 'update');
	if (verdict.kind !== 'certificate') continue;
	const literals = [...k.src.matchAll(/\b0x[0-9a-fA-F]+u?\b|\b\d+u?\b/g)].filter(
		(m) => !/^\d+u?$/.test(m[0]) || Number(m[0].replace(/u$/, '')) > 1
	);
	for (let m = 0; m < 3 && literals.length; m++) {
		const hit = literals[Math.floor(rnd() * literals.length)]!;
		const raw = hit[0].replace(/u$/, '');
		const value = Number(raw);
		const bit = 1 << Math.floor(rnd() * 16);
		const replacement = m === 0 ? `${(value + 1) >>> 0}u` : `${(value ^ bit) >>> 0}u`;
		const at = hit.index!;
		const src = k.src.slice(0, at) + replacement + k.src.slice(at + hit[0].length);
		if (src === k.src) continue;
		const id = `${k.id}-mut${m}-at${at}`;
		try {
			const bytes = compile(src, join(mutantDir, `${id}.wasm`), '2');
			const digest = sha256(bytes);
			if (seen.has(digest)) continue;
			seen.add(digest);
			index.push({
				id,
				family: 'clang-mutant',
				sha256: digest,
				note: `${k.id} literal ${hit[0]} -> ${replacement}`
			});
			mutants++;
		} catch (e) {
			console.log('mutant compile failed', id, String(e).slice(0, 100));
		}
	}
}
writeFileSync(join(root, 'modules/index-clang.json'), JSON.stringify(index, null, 1));
console.log(
	'clang modules',
	index.filter((x: any) => x.family === 'clang').length,
	'mutants',
	mutants
);
