import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const tag = '1.8.7';
const commit = 'f3149ec5bb5449af877ba20377a11008ff499fa2';
const archiveSha256 = 'c6782a28842b1c0478524ac06a4f2ede784038ee298d6e2162c0b089c4306a3c';
const root = new URL('../../', import.meta.url).pathname;
const work = join(root, 'build/research/blake3');
const archive = join(work, `${tag}.tar.gz`);
const source = join(work, `BLAKE3-${tag}`, 'c');
const adapters = join(root, 'scripts/research/cases');
mkdirSync(work, { recursive: true });

if (!existsSync(archive)) {
	const response = await fetch(
		`https://github.com/BLAKE3-team/BLAKE3/archive/refs/tags/${tag}.tar.gz`
	);
	if (!response.ok) throw new Error(`download failed: ${response.status}`);
	writeFileSync(archive, new Uint8Array(await response.arrayBuffer()), { flag: 'wx' });
}
const bytes = readFileSync(archive);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== archiveSha256) throw new Error(`archive digest ${sha} differs from the pin`);
if (!existsSync(source)) execFileSync('tar', ['xzf', archive, '-C', work]);
const pax = execFileSync('git', ['get-tar-commit-id'], {
	input: gunzipSync(bytes).subarray(0, 1024),
	encoding: 'utf8'
}).trim();
if (pax !== commit) throw new Error(`archive commit ${pax} differs from the pin`);

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
const output = join(work, 'blake3-hash-all.wasm');
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
		'-DBLAKE3_NO_SSE2',
		'-DBLAKE3_NO_SSE41',
		'-DBLAKE3_NO_AVX2',
		'-DBLAKE3_NO_AVX512',
		'-I',
		join(adapters, 'include'),
		'-I',
		source,
		join(adapters, 'support-min.c'),
		join(adapters, 'blake3-hash-all.c'),
		join(source, 'blake3.c'),
		join(source, 'blake3_dispatch.c'),
		join(source, 'blake3_portable.c'),
		'-Wl,--no-entry,--import-memory,--export-memory,--allow-undefined,--export=hash_all',
		'-Wl,--initial-memory=1048576',
		'-Wl,--max-memory=4294967296',
		'-o',
		output
	],
	{ env, stdio: 'pipe' }
);

// the official vectors: input byte i is i % 251, and the hash field starts with the 32-byte digest
const vectors = JSON.parse(
	readFileSync(join(work, `BLAKE3-${tag}`, 'test_vectors/test_vectors.json'), 'utf8')
) as { cases: { input_len: number; hash: string }[] };
const module = new WebAssembly.Module(readFileSync(output));
let checked = 0;
for (const { input_len, hash } of vectors.cases) {
	const pages = Math.ceil((1 << 20) / 65536) + Math.ceil(input_len / 65536) + 2;
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
	const x = new WebAssembly.Instance(module, { env: { memory } }).exports as Record<
		string,
		CallableFunction
	>;
	const view = new Uint8Array(memory.buffer);
	const at = 1 << 20;
	for (let i = 0; i < input_len; i++) view[at + 64 + i] = i % 251;
	new Uint32Array(memory.buffer, at, 2).set([at + 64, input_len]);
	x.hash_all!(at, 1, at + 16);
	const digest = Buffer.from(memory.buffer, at + 16, 32).toString('hex');
	if (digest !== hash.slice(0, 64)) throw new Error(`vector ${input_len} differs`);
	checked++;
}
console.log(
	JSON.stringify({
		tag,
		commit,
		archiveSha256,
		bytes: readFileSync(output).length,
		vectors: checked
	})
);
