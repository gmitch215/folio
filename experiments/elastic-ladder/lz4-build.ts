import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, 'build');
const inputs = ['wasm/lz4_wasm.c', 'wasm/lz4/lz4.c', 'wasm/lz4/lz4.h'].map((p) => join(here, p));

const clang = () => {
	const dir =
		process.env.LLVM ??
		(existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
	return dir ? join(dir, 'clang') : 'clang';
};

// binaryen's wasm-opt in node_modules/.bin changes the output, so that directory stays off PATH
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};

export const compilerVersion = () =>
	execFileSync(clang(), ['--version'], { env, encoding: 'utf8' }).split('\n')[0]!;

// build/lz4.wasm is rebuilt when any vendored input is newer; the module name in the output is the file name, so the name stays lz4.wasm
export function ensureLz4(): string {
	const target = join(out, 'lz4.wasm');
	const stale =
		!existsSync(target) ||
		inputs.some((input) => statSync(input).mtimeMs > statSync(target).mtimeMs);
	if (!stale) return target;
	mkdirSync(out, { recursive: true });
	execFileSync(
		clang(),
		[
			'--target=wasm32',
			'-O2',
			'-mbulk-memory',
			'-nostdlib',
			`-I${join(here, 'wasm/lz4')}`,
			'-Wl,--no-entry',
			'-Wl,--export-dynamic',
			'-o',
			target,
			join(here, 'wasm/lz4_wasm.c')
		],
		{ env, stdio: 'inherit' }
	);
	return target;
}
