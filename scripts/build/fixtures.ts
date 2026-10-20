import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

const common = [
	'--target=wasm32',
	'-O2',
	'-g0',
	'-ffreestanding',
	'-fno-builtin',
	'-nostdlib',
	'-matomics',
	'-mbulk-memory',
	'-Wall',
	'-Wextra',
	'-Werror'
];

const link = [
	'-Wl,--no-entry,--import-memory,--shared-memory,--initial-memory=131072',
	'-Wl,--max-memory=536870912'
];

export const fixtures = [
	{ source: 'fixture.c', output: 'fixture.wasm', flags: ['-fno-inline', '-fno-unroll-loops', '-fno-vectorize'] },
	{ source: 'sharing.c', output: 'sharing.wasm', flags: [] },
	{ source: 'generalized.c', output: 'generalized.wasm', flags: ['-fno-unroll-loops', '-fno-vectorize'] }
];

function clang(): string {
	const dir = process.env.LLVM ?? (existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
	return dir ? join(dir, 'clang') : 'clang';
}

// clang runs wasm-opt after linking when it finds one, and binaryen puts one in node_modules/.bin;
// under `bun run` that changed a 511-byte fixture into a 458-byte one, so the build never sees it
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};

export function buildFixtures(outDir = join(root, 'build')): string[] {
	mkdirSync(outDir, { recursive: true });
	return fixtures.map(({ source, output, flags }) => {
		const target = join(outDir, output);
		execFileSync(
			clang(),
			[...common, ...flags, join(root, 'tests/c', source), '-o', target, ...link],
			{ stdio: 'inherit', env }
		);
		return target;
	});
}

if (import.meta.main) {
	for (const target of buildFixtures()) console.log(target);
}
