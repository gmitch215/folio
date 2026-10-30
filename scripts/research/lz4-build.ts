import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const manifest = JSON.parse(
	readFileSync(new URL('./corpus-manifest.json', import.meta.url), 'utf8')
) as { projects: { id: string; repository: string; commit: string; sha256: string }[] };
const {
	repository,
	commit,
	sha256: archiveSha256
} = manifest.projects.find((project) => project.id === 'lz4')!;
const root = new URL('../../', import.meta.url).pathname;
const work = join(root, 'build/research/lz4');
const archive = join(work, 'lz4.tar.gz');
const source = join(work, `lz4-${commit}`, 'lib');
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
if (!existsSync(source)) execFileSync('tar', ['xzf', archive, '-C', work]);

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
const build = (name: string, slot?: number, stride = 1) => {
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
			...(slot ? [`-DSLOT=${slot}`, `-DSIZE_STRIDE=${stride}`] : []),
			'-I',
			join(adapters, 'include'),
			'-I',
			source,
			join(adapters, 'support-min.c'),
			join(adapters, 'lz4-compress-all.c'),
			join(source, 'lz4.c'),
			`-Wl,--no-entry,--import-memory,--export-memory,--allow-undefined,--export=${slot ? 'compress_slots' : 'compress_all'}`,
			'-Wl,--initial-memory=1048576',
			'-Wl,--max-memory=4294967296',
			'-o',
			output
		],
		{ env, stdio: 'pipe' }
	);
	return { name, slot, bytes: readFileSync(output).length };
};

// slots hold LZ4_compressBound of the input, rounded up to 4 KiB; padded builds give each size its own
// 32-byte granule
const slots = { '64k': 69632, '256k': 266240, '4m': 4214784 };
console.log(
	JSON.stringify({
		commit,
		archiveSha256,
		builds: [
			build('lz4-compress-all'),
			...Object.entries(slots).flatMap(([label, slot]) => [
				build(`lz4-compress-slots-${label}`, slot),
				build(`lz4-compress-padded-${label}`, slot, 8)
			])
		]
	})
);
