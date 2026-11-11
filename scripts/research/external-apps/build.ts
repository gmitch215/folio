import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// usage: build.ts SRC_DIR OUT_DIR [app,app]
// builds each upstream program unchanged: native with the system clang and wasm32 with the repo shim

const root = fileURLToPath(new URL('../../../', import.meta.url));
const here = fileURLToPath(new URL('./', import.meta.url));
const shim = join(root, 'scripts/research/final-cases/shim');
const musl = join(shim, 'musl');

export interface App {
	dir: string;
	sources: string[];
	includes: string[];
	/** wasm shadow stack in bytes; the programs keep large arrays on the stack */
	stack: number;
}

export const apps: Record<string, App> = {
	aobench: { dir: 'w4b-aobench', sources: ['ao.c'], includes: [], stack: 1 << 20 },
	sixpack: {
		dir: 'w4b-FastLZ',
		sources: ['examples/6pack.c', 'fastlz.c'],
		includes: ['.'],
		stack: 4 << 20
	},
	llama2: { dir: 'w4b-llama2.c', sources: ['run.c'], includes: [], stack: 1 << 20 }
};

const llvm =
	process.env.LLVM ??
	(existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
const wasmClang = llvm ? join(llvm, 'clang') : 'clang';
const nativeClang = process.env.NATIVE_CC ?? '/usr/bin/clang';

// binaryen's wasm-opt in node_modules/.bin changes the output, as in scripts/build/fixtures.ts
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};

/**
 * `shared` follows scripts/build/fixtures.ts: atomics and a shared imported memory, which makes
 * lld emit passive data segments and a start function. `plain` follows scripts/research/corpus.ts
 * and the final-cases build: a plain imported memory and active data segments.
 */
export type Variant = 'shared' | 'plain';

const wasmFlags = (variant: Variant) => [
	'--target=wasm32',
	'-O2',
	'-g0',
	'-ffreestanding',
	'-fno-builtin',
	'-nostdlib',
	...(variant === 'shared' ? ['-matomics'] : []),
	'-mbulk-memory',
	'-DNDEBUG',
	'-w',
	'-include',
	join(here, 'extra.h'),
	'-I',
	join(shim, 'include'),
	'-I',
	join(here, 'include'),
	'-I',
	join(musl, 'src/internal'),
	'-I',
	join(musl, 'arch/generic')
];

const objDir = (out: string, variant: Variant) =>
	join(out, variant === 'shared' ? 'obj' : 'obj-plain');
const suffix = (variant: Variant) => (variant === 'shared' ? '' : '.plain');

const run = (file: string, args: string[]) =>
	execFileSync(file, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });

/** Objects of the shim, the builtins, the musl math and the in-memory libc layer, vfs first. */
export function buildRuntime(out: string, variant: Variant = 'shared'): string[] {
	mkdirSync(objDir(out, variant), { recursive: true });
	const math = join(musl, 'src/math');
	const sources = [
		join(here, 'vfs.c'),
		join(shim, 'shim.c'),
		...['multi3.c', 'lshrti3.c', 'ashlti3.c'].map((name) => join(shim, 'builtins', name)),
		...readdirSync(math)
			.filter((name) => name.endsWith('.c'))
			.sort()
			.map((name) => join(math, name))
	];
	return sources.map((source, index) => {
		const object = join(objDir(out, variant), `rt${String(index).padStart(2, '0')}.o`);
		run(wasmClang, [...wasmFlags(variant), '-c', source, '-o', object]);
		return object;
	});
}

export function buildWasm(
	src: string,
	out: string,
	name: string,
	runtime: string[],
	variant: Variant = 'shared'
): string {
	const app = apps[name]!;
	const objects = app.sources.map((file, index) => {
		const object = join(objDir(out, variant), `${name}${index}.o`);
		run(wasmClang, [
			...wasmFlags(variant),
			...app.includes.flatMap((dir) => ['-I', join(src, app.dir, dir)]),
			'-c',
			join(src, app.dir, file),
			'-o',
			object
		]);
		return object;
	});
	const target = join(out, `${name}${suffix(variant)}.wasm`);
	run(wasmClang, [
		'--target=wasm32',
		'-nostdlib',
		`-Wl,--no-entry,--import-memory,${variant === 'shared' ? '--shared-memory' : '--export-memory'},--initial-memory=8388608`,
		'-Wl,--max-memory=1073741824,--allow-multiple-definition',
		`-Wl,-z,stack-size=${app.stack}`,
		'-Wl,--export=main,--export=__heap_base',
		...runtime,
		...objects,
		'-o',
		target
	]);
	return target;
}

export function buildNative(src: string, out: string, name: string): string {
	const app = apps[name]!;
	const target = join(out, `${name}.native`);
	run(nativeClang, [
		'-O2',
		'-w',
		...app.includes.flatMap((dir) => ['-I', join(src, app.dir, dir)]),
		...app.sources.map((file) => join(src, app.dir, file)),
		'-lm',
		'-o',
		target
	]);
	return target;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const nativeOnly = argv.includes('--native-only');
	const variants: Variant[] = argv.includes('--plain') ? ['plain'] : ['shared', 'plain'];
	const [src, out, only] = argv.filter((arg) => !arg.startsWith('--'));
	if (!src || !out)
		throw new Error('usage: build.ts SRC_DIR OUT_DIR [app,app] [--native-only|--plain]');
	mkdirSync(out, { recursive: true });
	const runtimes = new Map(
		nativeOnly ? [] : variants.map((variant) => [variant, buildRuntime(out, variant)])
	);
	for (const name of Object.keys(apps)) {
		if (only && !only.split(',').includes(name)) continue;
		console.log(buildNative(src, out, name));
		if (!nativeOnly)
			for (const variant of variants)
				console.log(buildWasm(src, out, name, runtimes.get(variant)!, variant));
	}
}
