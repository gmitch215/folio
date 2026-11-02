import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const source = join(root, 'scripts/research/cases/sweeps/subjects.c');
const defaultOut = join(root, 'build/research/sweeps');

/** One wasm per entry. `kind` says what the subject is: a DFA candidate or a control. */
export const subjects = [
	{ name: 'utf8flag', kind: 'dfa' },
	{ name: 'utf8dfa', kind: 'dfa' },
	{ name: 'csvquote', kind: 'dfa' },
	{ name: 'csvrows', kind: 'dfa' },
	{ name: 'base64ok', kind: 'dfa' },
	{ name: 'rle', kind: 'dfa' },
	{ name: 'lines', kind: 'dfa' },
	{ name: 'crc32', kind: 'control' },
	{ name: 'sha256c', kind: 'control' }
] as const;

export type SubjectName = (typeof subjects)[number]['name'];

const compilerDir =
	process.env.LLVM ??
	(existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
const clang = compilerDir ? join(compilerDir, 'clang') : 'clang';
// binaryen's wasm-opt in node_modules/.bin would rewrite the output
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};
const flags = [
	'--target=wasm32',
	'-O2',
	'-g0',
	'-ffreestanding',
	'-fno-builtin',
	'-nostdlib',
	'-mbulk-memory',
	'-Wall',
	'-Wextra',
	'-Werror'
];

/** Builds every subject and returns the wasm path by name. Rebuilds when the source changes. */
export function buildSubjects(outDir = defaultOut): Record<SubjectName, string> {
	mkdirSync(outDir, { recursive: true });
	const out = {} as Record<SubjectName, string>;
	const self = new URL(import.meta.url).pathname;
	for (const { name } of subjects) {
		const output = join(outDir, `${name}.wasm`);
		const stale =
			!existsSync(output) ||
			[source, self].some((input) => statSync(input).mtimeMs > statSync(output).mtimeMs);
		if (stale)
			execFileSync(
				clang,
				[
					...flags,
					source,
					'-o',
					output,
					`-Wl,--no-entry,--export-memory,--export=${name}`,
					'-Wl,--initial-memory=2097152,--max-memory=536870912'
				],
				{ env, stdio: 'pipe' }
			);
		out[name] = output;
	}
	return out;
}

if (import.meta.main) for (const path of Object.values(buildSubjects())) console.log(path);
