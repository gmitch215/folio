import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const root = new URL('../../', import.meta.url).pathname;
export const cases = join(root, 'scripts/research/cases');
const source = join(cases, 'affine/subjects.c');
export const defaultOut = join(root, 'build/research/affine');

export interface AffineSubjectSpec {
	name: string;
	entry: string;
	ring: 'gf2' | 'z2w' | 'none';
	align?: number;
}

/** The C subjects. `ring` is what the discovery must report: `none` is a refusal. */
export const subjects: AffineSubjectSpec[] = [
	{ name: 'crc32c', entry: 'crc32c', ring: 'gf2' },
	{ name: 'crc16', entry: 'crc16', ring: 'gf2' },
	{ name: 'crc64', entry: 'crc64', ring: 'gf2' },
	{ name: 'poly31', entry: 'poly31', ring: 'z2w' },
	{ name: 'lcg', entry: 'lcg', ring: 'z2w' },
	{ name: 'fnv1a', entry: 'fnv1a', ring: 'none' },
	{ name: 'adler32', entry: 'adler32', ring: 'none' },
	{ name: 'sha256c', entry: 'sha256c', ring: 'none', align: 64 }
];

const compilerDir =
	process.env.LLVM ??
	(existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
export const clang = compilerDir ? join(compilerDir, 'clang') : 'clang';
// binaryen's wasm-opt in node_modules/.bin would rewrite the output
export const env = {
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
export const link = (entry: string) => [
	`-Wl,--no-entry,--export-memory,--export=${entry}`,
	'-Wl,--initial-memory=2097152,--max-memory=536870912'
];

export const stale = (output: string, inputs: string[]) =>
	!existsSync(output) ||
	inputs.some((input) => statSync(input).mtimeMs > statSync(output).mtimeMs);

function compile(output: string, entry: string, extra: string[], inputs: string[]): string {
	if (stale(output, [source, new URL(import.meta.url).pathname, ...inputs])) {
		mkdirSync(join(output, '..'), { recursive: true });
		execFileSync(
			clang,
			[
				...flags,
				...extra,
				source,
				...inputs.filter((f) => f.endsWith('.c') && f !== source),
				'-o',
				output,
				...link(entry)
			],
			{ env, stdio: 'pipe' }
		);
	}
	return output;
}

/** The C subjects that rewrite their input in place, and the ring of their state. */
export const outputSubjects = [
	{ name: 'xlcg', ring: 'z2w' },
	{ name: 'xshift', ring: 'gf2' },
	{ name: 'xsbox', ring: 'gf2' },
	{ name: 'xfeed', ring: 'z2w' }
] as const;

/** Builds the in-place subjects and returns the wasm path of each by name. */
export function buildOutputSubjects(outDir = defaultOut): Record<string, string> {
	const out: Record<string, string> = {};
	for (const { name } of outputSubjects)
		out[name] = compile(join(outDir, `${name}.wasm`), name, [], []);
	return out;
}

/** Builds every static subject and returns the wasm path of each by name. */
export function buildSubjects(outDir = defaultOut): Record<string, string> {
	const out: Record<string, string> = {};
	for (const { name, entry } of subjects)
		out[name] = compile(join(outDir, `${name}.wasm`), entry, [], []);
	return out;
}

/** Builds the CRC-32 that changes its register once, when the register equals `trigger`. */
export function buildAdversarial(trigger: number, outDir = defaultOut): string {
	const hex = (trigger >>> 0).toString(16).padStart(8, '0');
	return compile(join(outDir, `adv-${hex}.wasm`), 'adv', [`-DTRIGGER=0x${hex}u`], []);
}

const manifest = JSON.parse(readFileSync(join(cases, '../corpus-manifest.json'), 'utf8')) as {
	projects: { id: string; repository: string; commit: string; sha256: string }[];
};
const pin = manifest.projects.find((project) => project.id === 'miniz')!;

/**
 * Builds one of miniz's own functions, `mz_crc32` or `mz_adler32`, as the entry with no wrapper:
 * unsigned long is 32 bits on wasm32, so the export already has the (state, pointer, length) shape.
 * Returns undefined when the pinned archive is not in the corpus cache; `fetchMiniz` downloads it.
 */
export function buildMiniz(outDir = defaultOut, entry = 'mz_crc32'): string | undefined {
	const archive = join(root, 'build/research/corpus/miniz.tar.gz');
	if (!existsSync(archive)) return undefined;
	if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== pin.sha256)
		throw new Error('miniz archive digest differs from the pin');
	const work = join(outDir, 'miniz-src');
	mkdirSync(work, { recursive: true });
	if (!readdirSync(work).some((entry) => entry.endsWith(pin.commit)))
		execFileSync('tar', ['xzf', archive, '-C', work]);
	const dir = join(
		work,
		readdirSync(work).find((entry) => entry.endsWith(pin.commit))!
	);
	const output = join(outDir, `miniz-${entry === 'mz_crc32' ? 'crc32' : entry.slice(3)}.wasm`);
	const inputs = [join(dir, 'miniz.c'), join(cases, 'support-min.c')];
	if (stale(output, [...inputs, new URL(import.meta.url).pathname])) {
		execFileSync(
			clang,
			[
				'--target=wasm32',
				'-O2',
				'-g0',
				'-ffreestanding',
				'-fno-builtin',
				'-nostdlib',
				'-mbulk-memory',
				'-DNDEBUG',
				'-DMINIZ_NO_STDIO',
				'-DMINIZ_NO_TIME',
				'-DMINIZ_NO_ARCHIVE_APIS',
				'-I',
				join(cases, 'include'),
				'-I',
				dir,
				...inputs,
				'-o',
				output,
				...link(entry),
				'-Wl,--allow-undefined'
			],
			{ env, stdio: 'pipe' }
		);
	}
	return output;
}

export async function fetchMiniz(): Promise<void> {
	const archive = join(root, 'build/research/corpus/miniz.tar.gz');
	if (existsSync(archive)) return;
	const response = await fetch(
		`https://codeload.github.com/${pin.repository}/tar.gz/${pin.commit}`
	);
	if (!response.ok) throw new Error(`download failed: ${response.status}`);
	mkdirSync(join(archive, '..'), { recursive: true });
	writeFileSync(archive, new Uint8Array(await response.arrayBuffer()), { flag: 'wx' });
}

if (import.meta.main) {
	await fetchMiniz();
	for (const path of Object.values(buildSubjects())) console.log(path);
	console.log(buildMiniz());
}
