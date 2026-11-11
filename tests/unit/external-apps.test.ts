import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const apps = join(root, 'scripts/research/external-apps');
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

const driver = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int read_input(char *buf, int cap) {
	FILE *f = fopen("in.txt", "rb");
	if (!f) return -1;
	int n = (int)fread(buf, 1, cap, f);
	fclose(f);
	return n;
}
int missing(void) { return fopen("none.txt", "rb") == NULL; }
int write_output(void) {
	FILE *f = fopen("out.bin", "wb");
	if (!f) return -1;
	fwrite("abc", 1, 3, f);
	fprintf(f, "%d", 42);
	fclose(f);
	return 0;
}
int write_stdout(void) { return printf("x=%d\\n", 7); }
int scan_byte(const char *s) {
	unsigned char v = 0;
	return sscanf(s, "<0x%02hhX>", &v) == 1 ? v : -1;
}
int seek_size(void) {
	FILE *f = fopen("in.txt", "rb");
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fclose(f);
	return (int)n;
}
`;

const run = (file: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		execFile(file, args, { env }, (error, _out, stderr) =>
			error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
		);
	});

let x: Record<string, any>;
let heap = 0;
const INPUT = 'hello vfs';

const name = (text: string) => {
	const at = x.w4b_scratch();
	new Uint8Array(x.memory.buffer).set(new TextEncoder().encode(text + '\0'), at);
};
const file = (text: string) => {
	name(text);
	const index = x.w4b_lookup();
	if (index < 0) return undefined;
	return Buffer.from(
		new Uint8Array(x.memory.buffer, x.w4b_data(index), x.w4b_len(index))
	).toString();
};

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'external-apps-'));
	writeFileSync(join(dir, 'driver.c'), driver);
	const math = join(musl, 'src/math');
	const sources = [
		join(apps, 'vfs.c'),
		join(shim, 'shim.c'),
		...['multi3.c', 'lshrti3.c', 'ashlti3.c'].map((n) => join(shim, 'builtins', n)),
		join(dir, 'driver.c'),
		...readdirSync(math)
			.filter((n) => n.endsWith('.c'))
			.map((n) => join(math, n))
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
		'-w',
		'-include',
		join(apps, 'extra.h'),
		'-I',
		join(shim, 'include'),
		'-I',
		join(apps, 'include'),
		'-I',
		join(musl, 'src/internal'),
		'-I',
		join(musl, 'arch/generic')
	];
	const objects = sources.map((_, index) => join(dir, `${index}.o`));
	await Promise.all(
		sources.map((source, index) => run(clang, [...flags, '-c', source, '-o', objects[index]!]))
	);
	const wasm = join(dir, 'apps.wasm');
	await run(clang, [
		'--target=wasm32',
		'-nostdlib',
		'-Wl,--no-entry,--export-all,--allow-multiple-definition',
		...objects,
		'-o',
		wasm
	]);
	x = (await WebAssembly.instantiate(readFileSync(wasm), {})).instance.exports;
	heap = ((x.__heap_base as WebAssembly.Global).value + 15) & ~15;
	(x.memory as WebAssembly.Memory).grow(32);
}, 60000);

beforeEach(() => {
	const heapSize = 1 << 20;
	const out = heap + heapSize;
	x.w4b_init(heap, heapSize, out, 1 << 16, 2);
	x.w4b_reset();
	const data = out + (3 << 16);
	new Uint8Array(x.memory.buffer).set(new TextEncoder().encode(INPUT), data);
	name('in.txt');
	x.w4b_add_input(data, INPUT.length);
});

describe('in-memory libc layer', () => {
	test('reads an input file and refuses a missing one', () => {
		const buf = x.malloc(64);
		expect(x.read_input(buf, 64)).toBe(INPUT.length);
		expect(Buffer.from(new Uint8Array(x.memory.buffer, buf, INPUT.length)).toString()).toBe(
			INPUT
		);
		expect(x.missing()).toBe(1);
	});

	test('fseek and ftell give the size of an input file', () => {
		expect(x.seek_size()).toBe(INPUT.length);
	});

	test('writes an output file and stdout', () => {
		expect(x.write_output()).toBe(0);
		expect(file('out.bin')).toBe('abc42');
		expect(x.write_stdout()).toBe(4);
		expect(file('<stdout>')).toBe('x=7\n');
	});

	test('reset drops outputs and keeps inputs', () => {
		x.write_output();
		x.w4b_reset();
		expect(file('out.bin')).toBeUndefined();
		expect(file('in.txt')).toBe(INPUT);
	});

	test('sscanf reads a hex byte and rejects text', () => {
		const ok = x.malloc(16);
		new Uint8Array(x.memory.buffer).set(new TextEncoder().encode('<0x0A>\0'), ok);
		expect(x.scan_byte(ok)).toBe(10);
		new Uint8Array(x.memory.buffer).set(new TextEncoder().encode('hello\0'), ok);
		expect(x.scan_byte(ok)).toBe(-1);
	});

	test('drand48 follows the 48-bit generator and reset restores its seed', () => {
		let state = 0x1234abcd330en;
		const next = () => {
			state = (state * 0x5deece66dn + 0xbn) & 0xffffffffffffn;
			return Number(state) / 2 ** 48;
		};
		const first = [x.drand48(), x.drand48(), x.drand48()];
		expect(first).toEqual([next(), next(), next()]);
		x.w4b_reset();
		expect(x.drand48()).toBe(first[0]);
	});
});
