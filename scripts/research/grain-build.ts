import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// small: a 1 MiB private context with no unused arena; stock: the corpus layout of 8 MiB
const variant = process.argv[2] ?? 'small';
if (variant !== 'small' && variant !== 'stock')
	throw new Error('usage: grain-build.ts small|stock');
const root = new URL('../../', import.meta.url).pathname;
const out = join(root, 'build/research/grain');
const adapters = join(root, 'scripts/research/cases');
const sources = join(root, 'build/research/corpus/sources');
const aes = readdirSync(sources).find((name) => name.startsWith('aes-'));
if (!aes) throw new Error('build the corpus first: node scripts/research/corpus.ts build ...');
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
const small = variant === 'small';
mkdirSync(out, { recursive: true });
for (const [name, extra, exports] of [
	['aes-grain', [], 'entry,initialize,corpus_output,run_range'],
	[
		'aes-grain-diff',
		['-DGRAIN_DIFF'],
		'entry,initialize,corpus_output,run_range,diff_key,diff_iv,diff_cipher,diff_scratch,diff_output,diff_original,diff_variant'
	]
] as const) {
	const file = join(out, `${name}-${variant}.wasm`);
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
			'-DCORPUS_AES',
			'-DCASE=2',
			...extra,
			...(small ? ['-DCORPUS_ARENA_BYTES=65536'] : []),
			'-I',
			join(adapters, 'include'),
			'-I',
			join(sources, aes),
			join(adapters, 'support.c'),
			join(adapters, 'aes-grain.c'),
			'-Wl,--no-entry,--import-memory,--export-memory,--allow-undefined',
			`-Wl,--export=${exports.split(',').join(',--export=')}`,
			`-Wl,--initial-memory=${small ? 1048576 : 8388608}`,
			`-Wl,--max-memory=${small ? 8388608 : 67108864}`,
			'-o',
			file
		],
		{ env, stdio: 'pipe' }
	);
	console.log(name, variant, readFileSync(file).length, WebAssembly.validate(readFileSync(file)));
}
