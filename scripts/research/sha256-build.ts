import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const manifest = JSON.parse(
	readFileSync(new URL('./corpus-manifest.json', import.meta.url), 'utf8')
) as { projects: { id: string; repository: string; commit: string; sha256: string }[] };
const {
	repository,
	commit,
	sha256: archiveSha256
} = manifest.projects.find((project) => project.id === 'crypto')!;
const root = new URL('../../', import.meta.url).pathname;
const work = join(root, 'build/research/sha256');
const archive = join(work, 'crypto.tar.gz');
const adapters = join(root, 'scripts/research/cases');
mkdirSync(work, { recursive: true });

if (!existsSync(archive)) {
	const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${commit}`);
	if (!response.ok) throw new Error(`download failed: ${response.status}`);
	writeFileSync(archive, new Uint8Array(await response.arrayBuffer()), { flag: 'wx' });
}
const bytes = readFileSync(archive);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== archiveSha256) throw new Error(`archive digest ${sha} differs from the pin`);
if (!readdirSync(work).some((entry) => entry.endsWith(commit)))
	execFileSync('tar', ['xzf', archive, '-C', work]);
const source = join(
	work,
	readdirSync(work).find((entry) => entry.endsWith(commit))!
);

const compilerDir =
	process.env.LLVM ??
	(existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
const clang = compilerDir ? join(compilerDir, 'clang') : 'clang';
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};
const build = (name: string, flags: string[]) => {
	const output = join(work, `${name}.wasm`);
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
			...flags,
			'-I',
			join(adapters, 'include'),
			'-I',
			source,
			join(adapters, 'support-min.c'),
			join(adapters, 'sha256-hash-all.c'),
			join(source, 'sha256.c'),
			'-Wl,--no-entry,--import-memory,--export-memory,--allow-undefined,--export=sha256_all',
			'-Wl,--initial-memory=1048576',
			'-Wl,--max-memory=4294967296',
			'-o',
			output
		],
		{ env, stdio: 'pipe' }
	);
	return { name, bytes: readFileSync(output).length };
};

// the helper build moves the per-input work into a function so the route accepts the loop
console.log(
	JSON.stringify({
		commit,
		archiveSha256,
		builds: [build('sha256-hash-all', []), build('sha256-hash-helper', ['-DHELPER'])]
	})
);
