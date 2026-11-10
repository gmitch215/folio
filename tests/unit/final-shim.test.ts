import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shim = join(root, 'scripts/research/final-cases/shim');
const musl = join(shim, 'musl');
const llvm = process.env.LLVM ?? '/opt/homebrew/opt/llvm/bin';
const clang = existsSync(join(llvm, 'clang')) ? join(llvm, 'clang') : 'clang';
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};

const driverSource = `
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int by_value(const void *a, const void *b) {
	int x = *(const int *)a, y = *(const int *)b;
	return (x > y) - (x < y);
}
void sort_ints(int *p, size_t n) { qsort(p, n, sizeof *p, by_value); }
int find_int(const int *p, size_t n, int key) {
	const int *hit = bsearch(&key, p, n, sizeof *p, by_value);
	return hit ? (int)(hit - p) : -1;
}
int take_errno(void) {
	int e = errno;
	errno = 0;
	return e;
}
int fmt_num(char *buf, size_t cap, int d, unsigned u, unsigned x) {
	return snprintf(buf, cap, "%d|%i|%u|%x|%X", d, d, u, x, x);
}
int fmt_text(char *buf, size_t cap, const char *s, int c) {
	return snprintf(buf, cap, "%s|%c|%.2s|%%", s, c, s);
}
int fmt_width(char *buf, size_t cap, int d, const char *s) {
	return snprintf(buf, cap, "%5d|%-4s|%04x|%*d|%.*s", d, s, (unsigned)d, 3, d, 2, s);
}
int fmt_long(char *buf, size_t cap, long l, unsigned long ul, size_t z, long long ll) {
	return snprintf(buf, cap, "%ld|%lu|%zu|%lld|%llu", l, ul, z, ll, (unsigned long long)ll);
}
int fmt_g(char *buf, size_t cap, double v, int prec) {
	return snprintf(buf, cap, "%.*g", prec, v);
}
int fmt_g_default(char *buf, size_t cap, double v) {
	return snprintf(buf, cap, "%g", v);
}
__int128 __multi3(__int128, __int128);
__int128 __lshrti3(__int128, int);
__int128 __ashlti3(__int128, int);
void wrap_multi3(const void *in, void *out) {
	__int128 a, b, r;
	memcpy(&a, in, 16);
	memcpy(&b, (const char *)in + 16, 16);
	r = __multi3(a, b);
	memcpy(out, &r, 16);
}
void wrap_lshrti3(const void *in, void *out) {
	__int128 a, r;
	int s;
	memcpy(&a, in, 16);
	memcpy(&s, (const char *)in + 16, 4);
	r = __lshrti3(a, s);
	memcpy(out, &r, 16);
}
void wrap_ashlti3(const void *in, void *out) {
	__int128 a, r;
	int s;
	memcpy(&a, in, 16);
	memcpy(&s, (const char *)in + 16, 4);
	r = __ashlti3(a, s);
	memcpy(out, &r, 16);
}
`;

function run(file: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { env }, (error, _stdout, stderr) => {
			if (error) reject(new Error(`${error.message}\n${stderr}`));
			else resolve();
		});
	});
}

async function build(): Promise<WebAssembly.Exports> {
	const dir = mkdtempSync(join(tmpdir(), 'final-shim-'));
	const driver = join(dir, 'driver.c');
	writeFileSync(driver, driverSource);
	const mathDir = join(musl, 'src/math');
	const sources = [
		join(shim, 'shim.c'),
		...['multi3.c', 'lshrti3.c', 'ashlti3.c'].map((name) => join(shim, 'builtins', name)),
		driver,
		...readdirSync(mathDir)
			.filter((name) => name.endsWith('.c'))
			.map((name) => join(mathDir, name))
	];
	const flags = [
		'--target=wasm32',
		'-O2',
		'-g0',
		'-ffreestanding',
		'-fno-builtin',
		'-nostdlib',
		'-mbulk-memory',
		'-DNDEBUG',
		'-I',
		join(shim, 'include'),
		'-I',
		join(musl, 'src/internal'),
		'-I',
		join(musl, 'arch/generic')
	];
	const objects = sources.map((_, index) => join(dir, `${index}.o`));
	await Promise.all(
		sources.map((source, index) => run(clang, [...flags, '-c', source, '-o', objects[index]!]))
	);
	const wasm = join(dir, 'shim.wasm');
	await run(clang, [
		'--target=wasm32',
		'-nostdlib',
		'-Wl,--no-entry,--export-all',
		...objects,
		'-o',
		wasm
	]);
	wasmBytes = readFileSync(wasm);
	const { instance } = await WebAssembly.instantiate(wasmBytes, {});
	return instance.exports;
}

let x: Record<string, any>;
let wasmBytes: Uint8Array<ArrayBuffer>;
const SLICE = 1 << 20;
let sliceBase = 0;

beforeAll(async () => {
	x = await build();
	const memory = x.memory as WebAssembly.Memory;
	sliceBase = ((x.__heap_base as WebAssembly.Global).value + 15) & ~15;
	memory.grow(Math.ceil((sliceBase + 2 * SLICE - memory.buffer.byteLength) / 65536));
}, 60000);

beforeEach(() => {
	x.bump_set(sliceBase, SLICE);
});

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

// ulp distance counted on the ordered integer line of each float format
function ulp32(a: number, b: number): number {
	f32[0] = a;
	const left = u32[0]!;
	f32[0] = b;
	const right = u32[0]!;
	const order = (v: number) => (v >>> 31 ? -(v & 0x7fffffff) : v);
	return Math.abs(order(left) - order(right));
}

function ulp64(a: number, b: number): number {
	f64[0] = a;
	const left = u64[0]!;
	f64[0] = b;
	const right = u64[0]!;
	const order = (v: bigint) => (v >> 63n !== 0n ? -(v & 0x7fffffffffffffffn) : v);
	const d = order(left) - order(right);
	return Number(d < 0n ? -d : d);
}

// deterministic inputs so a failure reproduces
function samples(count: number, lo: number, hi: number, seed: number): number[] {
	let state = seed;
	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out.push(lo + (hi - lo) * (state / 2 ** 32));
	}
	return out;
}

function put(bytes: Uint8Array | string): number {
	const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes + '\0') : bytes;
	const p = x.malloc(data.length);
	new Uint8Array(x.memory.buffer, p, data.length).set(data);
	return p;
}

function text(p: number): string {
	const mem = new Uint8Array(x.memory.buffer);
	let end = p;
	while (mem[end]) end++;
	return new TextDecoder().decode(mem.subarray(p, end));
}

function bytes(p: number, n: number): number[] {
	return Array.from(new Uint8Array(x.memory.buffer, p, n));
}

function formatted(
	call: (buf: number, cap: number) => number,
	cap = 256
): { n: number; out: string } {
	const buf = x.malloc(cap);
	const n = call(buf, cap);
	return { n, out: text(buf) };
}

// the exact %g reference: toExponential is exact in the spec, ties resolve up
function gReference(v: number, prec: number): string {
	if (Object.is(v, -0)) return '-0';
	if (v === 0) return '0';
	const p = prec === 0 ? 1 : prec;
	const [mant, expText] = v.toExponential(p - 1).split('e');
	const exp = Number(expText);
	const strip = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
	if (exp < -4 || exp >= p) {
		const sign = exp < 0 ? '-' : '+';
		const digits = String(Math.abs(exp)).padStart(2, '0');
		return `${strip(mant!)}e${sign}${digits}`;
	}
	return strip(v.toFixed(Math.max(0, p - 1 - exp)));
}

describe('memory and string functions', () => {
	test('mem functions copy, compare and find bytes', () => {
		const a = put(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
		const b = x.malloc(9);
		x.memcpy(b, a, 9);
		expect(bytes(b, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		x.memmove(a + 2, a, 5);
		expect(bytes(a, 9)).toEqual([1, 2, 1, 2, 3, 4, 5, 8, 9]);
		x.memset(b, 0x7f, 4);
		expect(bytes(b, 5)).toEqual([0x7f, 0x7f, 0x7f, 0x7f, 5]);
		expect(x.memcmp(a, b, 1)).toBeLessThan(0);
		expect(x.memcmp(a, a, 9)).toBe(0);
		expect(x.memchr(a, 4, 9) - a).toBe(5);
		expect(x.memchr(a, 42, 9)).toBe(0);
	});

	test('str functions match the C definitions on fixed strings', () => {
		const s = put('hello world');
		expect(x.strlen(s)).toBe(11);
		expect(x.strnlen(s, 4)).toBe(4);
		expect(x.strcmp(s, put('hello'))).toBeGreaterThan(0);
		expect(x.strcmp(put('abc'), put('abd'))).toBeLessThan(0);
		expect(x.strncmp(s, put('help'), 3)).toBe(0);
		expect(x.strchr(s, 'w'.charCodeAt(0)) - s).toBe(6);
		expect(x.strchr(s, 'z'.charCodeAt(0))).toBe(0);
		expect(x.strrchr(s, 'o'.charCodeAt(0)) - s).toBe(7);
		expect(x.strstr(s, put('wor')) - s).toBe(6);
		expect(x.strstr(s, put('xyz'))).toBe(0);
		expect(x.strspn(s, put('helo'))).toBe(5);
		expect(x.strcspn(s, put('w'))).toBe(6);
		expect(x.strpbrk(s, put('dr')) - s).toBe(8);
		const dst = x.malloc(32);
		x.strcpy(dst, put('ab'));
		x.strcat(dst, put('cd'));
		expect(text(dst)).toBe('abcd');
		x.strncat(dst, put('efgh'), 2);
		expect(text(dst)).toBe('abcdef');
		const dup = x.strdup(put('copy'));
		expect(text(dup)).toBe('copy');
		const small = x.malloc(4);
		x.strncpy(small, put('xy'), 4);
		expect(bytes(small, 4)).toEqual([0x78, 0x79, 0, 0]);
	});

	test('ctype functions use the C locale', () => {
		expect(x.isdigit('7'.charCodeAt(0))).not.toBe(0);
		expect(x.isdigit('a'.charCodeAt(0))).toBe(0);
		expect(x.isxdigit('F'.charCodeAt(0))).not.toBe(0);
		expect(x.isspace(0x0b)).not.toBe(0);
		expect(x.isalpha('Z'.charCodeAt(0))).not.toBe(0);
		expect(x.isalnum('_'.charCodeAt(0))).toBe(0);
		expect(x.toupper('q'.charCodeAt(0))).toBe('Q'.charCodeAt(0));
		expect(x.tolower('Q'.charCodeAt(0))).toBe('q'.charCodeAt(0));
		expect(x.toupper(0x80)).toBe(0x80);
	});
});

describe('stdlib functions', () => {
	test('strtol, strtoul and atoi parse and report like C', () => {
		const end = x.malloc(4);
		const cases: [string, number, number, number][] = [
			['  -42xyz', 10, -42, 5],
			['0x1F', 0, 31, 4],
			['0x1F', 16, 31, 4],
			['777', 8, 511, 3],
			['zz', 36, 1295, 2]
		];
		for (const [input, base, value, consumed] of cases) {
			const src = put(input);
			expect(x.strtol(src, end, base)).toBe(value);
			expect(new Uint32Array(x.memory.buffer, end, 1)[0]! - src).toBe(consumed);
		}
		const big = put('99999999999999999999');
		expect(x.strtol(big, 0, 10)).toBe(2147483647);
		expect(x.strtoul(put('4294967295'), 0, 10) >>> 0).toBe(4294967295);
		expect(x.atoi(put('  12ab'))).toBe(12);
		expect(x.atoi(put('nope'))).toBe(0);
	});

	test('strtod converts the fast-path decimal inputs exactly and rejects the rest', () => {
		const end = x.malloc(4);
		const accepted = ['1.5', '-0.25e2', '0.1', '123456789012345', '1e22', '3.14159', '0'];
		for (const input of accepted) {
			expect(x.strtod(put(input), 0)).toBe(Number(input));
		}
		const consumed = put('2.5e3tail');
		expect(x.strtod(consumed, end)).toBe(2500);
		expect(new Uint32Array(x.memory.buffer, end, 1)[0]! - consumed).toBe(5);

		// out of the fast path: ERANGE; unsupported forms (inf, nan, hex): EINVAL
		const rejected: [string, number][] = [
			['1e23', 34],
			['0.12345678901234567', 34],
			['1e400', 34],
			['inf', 22],
			['nan', 22],
			['0x10', 22]
		];
		for (const [input, code] of rejected) {
			const src = put(input);
			expect(x.strtod(src, end), input).toBe(0);
			expect(new Uint32Array(x.memory.buffer, end, 1)[0], input).toBe(src);
			expect(x.take_errno(), input).toBe(code);
		}
	});

	test('qsort and bsearch order and find ints', () => {
		const values = [9, -3, 7, 0, 7, 12, -8, 4];
		const p = x.malloc(values.length * 4);
		new Int32Array(x.memory.buffer, p, values.length).set(values);
		x.sort_ints(p, values.length);
		const sorted = Array.from(new Int32Array(x.memory.buffer, p, values.length));
		expect(sorted).toEqual([...values].sort((a, b) => a - b));
		expect(x.find_int(p, values.length, 12)).toBe(7);
		expect(x.find_int(p, values.length, 5)).toBe(-1);
	});

	test('abs, labs and getenv return their C values', () => {
		expect(x.abs(-9)).toBe(9);
		expect(x.labs(-9)).toBe(9);
		expect(x.getenv(put('HOME'))).toBe(0);
	});

	test('exit and abort trap', () => {
		expect(() => x.exit(0)).toThrow(WebAssembly.RuntimeError);
		expect(() => x.abort()).toThrow(WebAssembly.RuntimeError);
	});
});

describe('allocation', () => {
	test('malloc aligns, calloc zeroes, realloc keeps bytes, free is deferred until reset', () => {
		const a = x.malloc(5);
		expect(a % 16).toBe(0);
		const b = x.malloc(1);
		expect(b).toBeGreaterThan(a);
		new Uint8Array(x.memory.buffer, a, 5).set([1, 2, 3, 4, 5]);
		const grown = x.realloc(a, 64);
		expect(bytes(grown, 5)).toEqual([1, 2, 3, 4, 5]);
		x.free(grown);
		const z = x.calloc(4, 8);
		expect(bytes(z, 32).every((byte) => byte === 0)).toBe(true);
		expect(x.calloc(0x40000000, 0x40000000)).toBe(0);
		expect(x.malloc(0x7fffffff)).toBe(0);
	});

	test('bump_set rewinds to the first block of the slice', () => {
		const first = x.malloc(1);
		expect(first).toBe(sliceBase + 16);
		x.malloc(100);
		x.bump_set(sliceBase, SLICE);
		expect(x.malloc(1)).toBe(first);
	});

	test('malloc returns NULL until the first bump_set', async () => {
		const { instance } = await WebAssembly.instantiate(wasmBytes, {});
		const fresh = instance.exports as Record<string, any>;
		expect(fresh.malloc(1)).toBe(0);
		expect(fresh.calloc(1, 1)).toBe(0);
	});

	test('allocations stay inside the slice and a full slice returns NULL', () => {
		const size = 4096;
		x.bump_set(sliceBase + SLICE, size);
		const blocks: number[] = [];
		for (let p = x.malloc(100); p; p = x.malloc(100)) blocks.push(p);
		expect(blocks.length).toBe(Math.floor(size / 128));
		for (const p of blocks) {
			expect(p).toBeGreaterThanOrEqual(sliceBase + SLICE + 16);
			expect(p + 100).toBeLessThanOrEqual(sliceBase + SLICE + size);
		}
		expect(x.malloc(size)).toBe(0);
	});

	test('two slices never share an address', () => {
		const rangesOf = (base: number) => {
			x.bump_set(base, 4096);
			return [x.malloc(1000), x.malloc(1000), x.calloc(10, 10)].map((p) => [p, p + 1000]);
		};
		const a = rangesOf(sliceBase);
		const b = rangesOf(sliceBase + 4096);
		for (const [a0, a1] of a)
			for (const [b0, b1] of b) expect(a1! <= b0! || b1! <= a0!).toBe(true);
	});

	test('bump_set zeroes nothing, calloc zeroes its block and realloc copies', () => {
		new Uint8Array(x.memory.buffer, sliceBase, 256).fill(0xaa);
		x.bump_set(sliceBase, SLICE);
		const p = x.malloc(16);
		expect(bytes(p, 16).every((byte) => byte === 0xaa)).toBe(true);
		x.bump_set(sliceBase, SLICE);
		const z = x.calloc(16, 1);
		expect(bytes(z, 16).every((byte) => byte === 0)).toBe(true);
		new Uint8Array(x.memory.buffer, z, 3).set([7, 8, 9]);
		expect(bytes(x.realloc(z, 64), 3)).toEqual([7, 8, 9]);
	});
});

describe('stdio and system stubs', () => {
	test('file and output functions fail without touching anything', () => {
		const fmt = put('x');
		expect(x.printf(fmt)).toBe(-1);
		expect(x.fputs(fmt, 0)).toBe(-1);
		expect(x.fopen(fmt, fmt)).toBe(0);
		expect(x.fclose(0)).toBe(-1);
		expect(x.fread(fmt, 1, 1, 0)).toBe(0);
		expect(x.fwrite(fmt, 1, 1, 0)).toBe(0);
		expect(x.fgets(fmt, 1, 0)).toBe(0);
		expect(x.fseek(0, 0, 0)).toBe(-1);
		expect(x.ftell(0)).toBe(-1);
		expect(x.ferror(0)).not.toBe(0);
		expect(x.feof(0)).toBe(0);
		expect(x.time(0)).toBe(-1n);
		expect(x.clock()).toBe(-1);
		expect(x.take_errno()).toBe(38);
	});
});

describe('POSIX file, process and clock stubs', () => {
	test('calls that need the host fail with -1 or 0 and set ENOSYS', () => {
		const path = put('/tmp/x');
		expect(x.getpid()).toBe(-1);
		expect(x.open(path, 0)).toBe(-1);
		expect(x.read(0, path, 1)).toBe(-1);
		expect(x.write(1, path, 1)).toBe(-1);
		expect(x.close(3)).toBe(-1);
		expect(x.stat(path, 0)).toBe(-1);
		expect(x.fstat(3, 0)).toBe(-1);
		expect(x.isatty(1)).toBe(0);
		expect(x.realpath(path, 0)).toBe(0);
		expect(x.clock_gettime(1, 0)).toBe(-1);
		expect(x.take_errno()).toBe(38);
	});
});

describe('threads and wide characters', () => {
	test('thread calls return ENOSYS and attribute setup succeeds', () => {
		expect(x.pthread_create(0, 0, 0, 0)).toBe(38);
		expect(x.pthread_join(1, 0)).toBe(38);
		expect(x.pthread_mutex_lock(0)).toBe(38);
		expect(x.pthread_cond_wait(0, 0)).toBe(38);
		expect(x.pthread_attr_init(0)).toBe(0);
		expect(x.pthread_condattr_setclock(0, 1)).toBe(0);
	});

	test('wide-string functions compare and measure; conversions fail', () => {
		const wide = (s: string) => {
			const p = x.malloc((s.length + 1) * 4);
			const view = new Uint32Array(x.memory.buffer, p, s.length + 1);
			for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
			view[s.length] = 0;
			return p;
		};
		expect(x.wcslen(wide('wide'))).toBe(4);
		expect(x.wcsncmp(wide('abc'), wide('abd'), 3)).toBeLessThan(0);
		expect(x.wcsncmp(wide('abc'), wide('abx'), 2)).toBe(0);
		expect(x.wcrtomb(0, 65, 0)).toBe(-1);
		expect(x.mbrtowc(0, 0, 0, 0)).toBe(-1);
		expect(x.take_errno()).toBe(38);
	});
});

describe('snprintf and sprintf', () => {
	test('integer, string and char conversions with flags, width and precision', () => {
		expect(formatted((b, c) => x.fmt_num(b, c, -7, 42, 255))).toEqual({
			n: 14,
			out: '-7|-7|42|ff|FF'
		});
		expect(formatted((b, c) => x.fmt_text(b, c, put('abc'), 'z'.charCodeAt(0)))).toEqual({
			n: 10,
			out: 'abc|z|ab|%'
		});
		expect(formatted((b, c) => x.fmt_width(b, c, 42, put('xy')))).toEqual({
			n: 22,
			out: '   42|xy  |002a| 42|xy'
		});
		expect(formatted((b, c) => x.fmt_long(b, c, -5, 7, 9, -3n))).toEqual({
			n: 30,
			out: '-5|7|9|-3|18446744073709551613'
		});
	});

	test('%g matches the exact reference for fixed and random values', () => {
		const buf = x.malloc(64);
		const cases = [0, -0, 1, -1, 0.1, 100000, 1000000, 1e-4, 1e-5, 123.456, 1 / 3, 2 ** 60];
		for (const v of cases) {
			for (const prec of [1, 6, 15, 17]) {
				const n = x.fmt_g(buf, 64, v, prec);
				expect(text(buf), `%.${prec}g of ${v}`).toBe(gReference(v, prec));
				expect(n).toBe(gReference(v, prec).length);
			}
		}
		for (const v of samples(400, -1e6, 1e6, 7)) {
			x.fmt_g(buf, 64, v, 15);
			expect(text(buf)).toBe(gReference(v, 15));
			x.fmt_g_default(buf, 64, v);
			expect(text(buf)).toBe(gReference(v, 6));
		}
		x.fmt_g(buf, 64, Infinity, 6);
		expect(text(buf)).toBe('inf');
		x.fmt_g(buf, 64, -Infinity, 6);
		expect(text(buf)).toBe('-inf');
		x.fmt_g(buf, 64, NaN, 6);
		expect(text(buf)).toBe('nan');
	});

	test('output is cut at cap and the return value is the full length', () => {
		const buf = x.malloc(8);
		const n = x.fmt_num(buf, 4, 123456, 0, 0);
		expect(text(buf)).toBe('123');
		expect(n).toBe(19);
	});
});

const sinSet = [
	0,
	-0,
	1e-10,
	0.5,
	1,
	Math.PI / 4,
	Math.PI / 2,
	Math.PI,
	3 * Math.PI,
	100,
	-100,
	...samples(1500, -100, 100, 11)
];
const expSet = [0, 1, -1, 10, -10, 80, -80, ...samples(1500, -80, 80, 13)];
const logSet = [1, 2, 0.5, 1e-3, 1e3, 1e30, ...samples(1500, 1e-3, 1e3, 17)];
const powBase = samples(1500, 0.01, 100, 19);
const powExp = samples(1500, -20, 20, 23);

describe('musl math against the Math reference', () => {
	// musl documents 0.82 ulp for powf, 0.818 for logf, 0.502 for expf (float results, one ulp
	// of rounding is the most a correctly rounded reference can disagree by)
	test('float functions stay within one ulp of Math.fround(Math.f(x))', () => {
		let worst = { sinf: 0, cosf: 0, logf: 0, expf: 0, powf: 0 };
		for (const v of sinSet) {
			const input = Math.fround(v);
			worst.sinf = Math.max(worst.sinf, ulp32(x.sinf(input), Math.fround(Math.sin(input))));
			worst.cosf = Math.max(worst.cosf, ulp32(x.cosf(input), Math.fround(Math.cos(input))));
		}
		for (const v of logSet) {
			const input = Math.fround(v);
			worst.logf = Math.max(worst.logf, ulp32(x.logf(input), Math.fround(Math.log(input))));
		}
		for (const v of expSet) {
			const input = Math.fround(v);
			worst.expf = Math.max(worst.expf, ulp32(x.expf(input), Math.fround(Math.exp(input))));
		}
		powBase.forEach((b, i) => {
			const base = Math.fround(b);
			const exp = Math.fround(powExp[i]!);
			worst.powf = Math.max(worst.powf, ulp32(x.powf(base, exp), Math.fround(base ** exp)));
		});
		expect(worst.logf).toBeLessThanOrEqual(1);
		expect(worst.expf).toBeLessThanOrEqual(1);
		expect(worst.powf).toBeLessThanOrEqual(1);
		expect(worst.sinf).toBeLessThanOrEqual(1);
		expect(worst.cosf).toBeLessThanOrEqual(1);
	});

	// musl documents 0.507 ulp for log, 0.509 for exp and 0.54 for pow; the reference is V8's
	// Math, so the tolerance is the musl bound plus one ulp of reference error
	test('double functions stay within two ulp of Math.f(x)', () => {
		let worst = { sin: 0, cos: 0, log: 0, exp: 0, pow: 0 };
		for (const v of sinSet) {
			worst.sin = Math.max(worst.sin, ulp64(x.sin(v), Math.sin(v)));
			worst.cos = Math.max(worst.cos, ulp64(x.cos(v), Math.cos(v)));
		}
		for (const v of logSet) worst.log = Math.max(worst.log, ulp64(x.log(v), Math.log(v)));
		for (const v of expSet) worst.exp = Math.max(worst.exp, ulp64(x.exp(v), Math.exp(v)));
		powBase.forEach((b, i) => {
			worst.pow = Math.max(worst.pow, ulp64(x.pow(b, powExp[i]!), b ** powExp[i]!));
		});
		expect(worst.log).toBeLessThanOrEqual(2);
		expect(worst.exp).toBeLessThanOrEqual(2);
		expect(worst.pow).toBeLessThanOrEqual(2);
		expect(worst.sin).toBeLessThanOrEqual(2);
		expect(worst.cos).toBeLessThanOrEqual(2);
	});

	test('special values follow C99 Annex F', () => {
		expect(x.log(0)).toBe(-Infinity);
		expect(Number.isNaN(x.log(-1))).toBe(true);
		expect(x.exp(-Infinity)).toBe(0);
		expect(x.exp(1000)).toBe(Infinity);
		expect(x.pow(0, 0)).toBe(1);
		expect(x.pow(-2, 3)).toBe(-8);
		expect(Number.isNaN(x.pow(-8, 1 / 3))).toBe(true);
		expect(x.pow(2, 10)).toBe(1024);
		expect(x.sqrt(2)).toBe(Math.sqrt(2));
		expect(x.floor(-1.5)).toBe(-2);
		expect(x.ceil(-1.5)).toBe(-1);
		expect(x.fabs(-0.25)).toBe(0.25);
		expect(x.sqrtf(Math.fround(9))).toBe(3);
		expect(x.floorf(Math.fround(-1.5))).toBe(-2);
		expect(x.ceilf(Math.fround(1.2))).toBe(2);
		expect(x.fabsf(Math.fround(-3))).toBe(3);
		expect(x.copysign(3, -0)).toBe(-3);
		expect(x.copysign(-2, 5)).toBe(2);
	});
});

describe('compiler-rt 128-bit builtins', () => {
	const mask = (1n << 128n) - 1n;
	let state = 0x9e3779b97f4a7c15n;
	const operands: bigint[] = [
		0n,
		1n,
		2n,
		0xffffffffffffffffn,
		1n << 64n,
		(1n << 127n) - 1n,
		1n << 127n,
		mask
	];
	for (let i = 0; i < 40; i++) {
		state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
		operands.push(state);
	}
	const shifts = [0, 1, 31, 32, 63, 64, 65, 96, 127];

	// in: a (16 bytes), then b or the shift count; out: the 16-byte result at +32.
	function call(name: string, a: bigint, b: bigint): bigint {
		const p = x.malloc(48);
		const words = new BigUint64Array(x.memory.buffer, p, 4);
		words[0] = a & 0xffffffffffffffffn;
		words[1] = a >> 64n;
		words[2] = b & 0xffffffffffffffffn;
		words[3] = b >> 64n;
		x[`wrap_${name}`](p, p + 32);
		const out = new BigUint64Array(x.memory.buffer, p + 32, 2);
		return (out[1]! << 64n) | out[0]!;
	}

	test('__multi3 matches BigInt multiplication mod 2^128', () => {
		for (const a of operands)
			for (const b of operands)
				expect(call('multi3', a, b), `${a} * ${b}`).toBe((a * b) & mask);
	});

	test('__lshrti3 matches a logical right shift', () => {
		for (const a of operands)
			for (const s of shifts)
				expect(call('lshrti3', a, BigInt(s)), `${a} >> ${s}`).toBe(a >> BigInt(s));
	});

	test('__ashlti3 matches a left shift mod 2^128', () => {
		for (const a of operands)
			for (const s of shifts)
				expect(call('ashlti3', a, BigInt(s)), `${a} << ${s}`).toBe((a << BigInt(s)) & mask);
	});
});
