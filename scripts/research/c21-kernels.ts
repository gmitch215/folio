import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { corpusManifest } from './corpus.ts';

// bulk drivers for the 21 corpus kernels: n independent records through the unmodified entry
const root = new URL('../../', import.meta.url).pathname;
export const adapters = join(root, 'scripts/research/cases');
export const outDir = join(root, process.env.C21_OUT ?? 'build/research/c21');
export const BASE = 1 << 20;
const align = (value: number, to = 65536) => Math.ceil(value / to) * to;
const slotOf = (cap: number) => Math.ceil((32 + cap) / 64) * 64;

export interface Spec {
	id: string;
	/** the corpus case this driver stands for */
	corpus: string;
	project: string;
	define: string;
	extra?: Record<string, number | string>;
	n: number;
	slot: number;
	/** bytes of one record input; decoders take theirs from the sibling's output */
	inputBytes: number;
	auxBytes: number;
	/** private allocator slice per record */
	arena: number;
	from?: string;
	/** kissfft: nfft and whether every record has its own configuration */
	config?: { nfft: number; stride: number; perRecord: boolean };
	makeInput?: (i: number) => Uint8Array;
	makeAux?: (i: number) => Uint8Array;
	imports?: boolean;
	/** the fraction of this kernel that is the carried state of one call, for the report */
	note?: string;
}

export const rng = (seed: number) => {
	let state = seed | 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
};
const vocabulary = (() => {
	const next = rng(0x2545f491);
	return Array.from({ length: 1024 }, () =>
		Array.from({ length: 3 + Math.floor(next() * 7) }, () =>
			String.fromCharCode(97 + Math.floor(next() * 26))
		).join('')
	);
})();
export const text = (size: number) => (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x9e3779b9);
	const data = new Uint8Array(size);
	let at = 0;
	while (at < size) {
		const word = vocabulary[Math.floor(Math.min(next(), next()) * vocabulary.length)]!;
		for (let k = 0; k < word.length && at < size; k++) data[at++] = word.charCodeAt(k);
		if (at < size) data[at++] = 32;
	}
	return data;
};
export const random = (size: number) => (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x7f4a7c15);
	const data = new Uint8Array(size);
	for (let k = 0; k < size; k++) data[k] = Math.floor(next() * 256);
	return data;
};
const image = (dim: number) => (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x51ed270b);
	const data = new Uint8Array(dim * dim * 4);
	for (let y = 0; y < dim; y++)
		for (let x = 0; x < dim; x++) {
			const at = (y * dim + x) * 4;
			const noise = next() < 0.15 ? Math.floor(next() * 32) : 0;
			data[at] = (x * 2 + i + noise) & 255;
			data[at + 1] = (y * 2 + noise) & 255;
			data[at + 2] = (x + y + noise) & 255;
			data[at + 3] = 255;
		}
	return data;
};
const json = (objects: number) => (i: number) =>
	new TextEncoder().encode(
		'[' +
			Array.from(
				{ length: objects },
				(_, k) => `{"items":[${k},${i},3],"valid":true,"text":"hello${(k + i) % 10}"}`
			).join(',') +
			']'
	);
const floats = (count: number) => (i: number) => {
	const data = new Float32Array(count);
	for (let k = 0; k < count; k++) data[k] = (((k + i * 7) % 31) - 15) / 16;
	return new Uint8Array(data.buffer);
};
const keyIv = (i: number) => random(32)(i + 1000);
const ram6502 = (i: number) => {
	const ram = new Uint8Array(65536).fill(0xea);
	ram[0xfffc] = 0;
	ram[0xfffd] = 2;
	ram.set([0xa2, i & 255, 0xe8, 0x4c, 0x02, 0x02], 0x200);
	return ram;
};

const N = 128;
const lz = 32768;
const mz = 16384;
const dim = 96;
export const specs: Spec[] = [
	{
		id: 'lz4-compress',
		corpus: 'lz4-compress',
		project: 'lz4',
		define: 'K_LZ4C',
		n: N,
		slot: slotOf(lz + Math.floor(lz / 255) + 16),
		inputBytes: lz,
		auxBytes: 0,
		arena: 0,
		makeInput: text(lz)
	},
	{
		id: 'lz4-decompress',
		corpus: 'lz4-decompress',
		project: 'lz4',
		define: 'K_LZ4D',
		n: N,
		slot: slotOf(lz),
		inputBytes: 0,
		auxBytes: 0,
		arena: 0,
		from: 'lz4-compress'
	},
	{
		id: 'miniz-compress',
		corpus: 'miniz-compress',
		project: 'miniz',
		define: 'K_MZC',
		extra: { ARENA: 1 << 19 },
		n: 64,
		slot: slotOf(128 + Math.floor((mz * 110) / 100)),
		inputBytes: mz,
		auxBytes: 0,
		arena: 1 << 19,
		makeInput: text(mz)
	},
	{
		id: 'miniz-decompress',
		corpus: 'miniz-decompress',
		project: 'miniz',
		define: 'K_MZD',
		extra: { ARENA: 1 << 18 },
		n: 64,
		slot: slotOf(mz),
		inputBytes: 0,
		auxBytes: 0,
		arena: 1 << 18,
		from: 'miniz-compress'
	},
	{
		id: 'miniz-crc32',
		corpus: 'miniz-crc32',
		project: 'miniz',
		define: 'K_CRC32',
		n: N,
		slot: 32,
		inputBytes: 32768,
		auxBytes: 0,
		arena: 0,
		makeInput: random(32768)
	},
	{
		id: 'miniz-adler32',
		corpus: 'miniz-adler32',
		project: 'miniz',
		define: 'K_ADLER32',
		n: N,
		slot: 32,
		inputBytes: 131072,
		auxBytes: 0,
		arena: 0,
		makeInput: random(131072)
	},
	{
		id: 'jsmn-parse',
		corpus: 'jsmn-parse',
		project: 'jsmn',
		define: 'K_JSMN',
		n: N,
		slot: slotOf(704 * 16),
		inputBytes: 0,
		auxBytes: 0,
		arena: 0,
		makeInput: json(64)
	},
	{
		id: 'jsmn-parse-slot',
		corpus: 'jsmn-parse',
		project: 'jsmn',
		define: 'K_JSMN',
		extra: { CTXARENA: 1 },
		n: N,
		slot: slotOf(704 * 16),
		inputBytes: 0,
		auxBytes: 0,
		arena: 64,
		makeInput: json(64)
	},
	{
		id: 'aes-cbc-encrypt-slot',
		corpus: 'aes-cbc-encrypt',
		project: 'aes',
		define: 'K_AESE',
		extra: { CTXARENA: 1 },
		n: N,
		slot: slotOf(8192),
		inputBytes: 8192,
		auxBytes: 32,
		arena: 512,
		makeInput: random(8192),
		makeAux: keyIv
	},
	{
		id: 'md5-slot',
		corpus: 'md5',
		project: 'crypto',
		define: 'K_MD5',
		extra: { CTXARENA: 1 },
		n: N,
		slot: 64,
		inputBytes: 32768,
		auxBytes: 0,
		arena: 128,
		makeInput: random(32768)
	},
	{
		id: 'jsmn-parse-shared',
		corpus: 'jsmn-parse',
		project: 'jsmn',
		define: 'K_JSMN',
		extra: { SHARED: 1 },
		n: N,
		slot: slotOf(704 * 16),
		inputBytes: 0,
		auxBytes: 0,
		arena: 0,
		makeInput: json(64)
	},
	{
		id: 'kissfft-complex',
		corpus: 'kissfft-complex',
		project: 'kissfft',
		define: 'K_KFFT',
		extra: { CFG: 65536 },
		n: N,
		slot: slotOf(4096 * 8),
		inputBytes: 4096 * 8,
		auxBytes: 0,
		arena: 0,
		config: { nfft: 4096, stride: 65536, perRecord: false },
		makeInput: floats(8192),
		imports: true
	},
	{
		id: 'kissfft-real',
		corpus: 'kissfft-real',
		project: 'kissfft',
		define: 'K_KFFTR',
		extra: { CFG: 65536 },
		n: N,
		slot: slotOf(2049 * 8),
		inputBytes: 4096 * 4,
		auxBytes: 0,
		arena: 0,
		config: { nfft: 4096, stride: 65536, perRecord: true },
		makeInput: floats(4096),
		imports: true
	},
	{
		id: 'kissfft-real-shared',
		corpus: 'kissfft-real',
		project: 'kissfft',
		define: 'K_KFFTR',
		extra: { CFG: 65536 },
		n: N,
		slot: slotOf(2049 * 8),
		inputBytes: 4096 * 4,
		auxBytes: 0,
		arena: 0,
		config: { nfft: 4096, stride: 65536, perRecord: false },
		makeInput: floats(4096),
		imports: true
	},
	{
		id: 'aes-cbc-encrypt',
		corpus: 'aes-cbc-encrypt',
		project: 'aes',
		define: 'K_AESE',
		n: N,
		slot: slotOf(8192),
		inputBytes: 8192,
		auxBytes: 32,
		arena: 0,
		makeInput: random(8192),
		makeAux: keyIv
	},
	{
		id: 'aes-cbc-decrypt',
		corpus: 'aes-cbc-decrypt',
		project: 'aes',
		define: 'K_AESD',
		n: N,
		slot: slotOf(8192),
		inputBytes: 0,
		auxBytes: 32,
		arena: 0,
		from: 'aes-cbc-encrypt',
		makeAux: keyIv
	},
	{
		id: 'aes-cbc-decrypt-shared',
		corpus: 'aes-cbc-decrypt',
		project: 'aes',
		define: 'K_AESD',
		extra: { SHARED: 1 },
		n: N,
		slot: slotOf(8192),
		inputBytes: 0,
		auxBytes: 32,
		arena: 0,
		from: 'aes-cbc-encrypt',
		makeAux: keyIv
	},
	{
		id: 'aes-ctr',
		corpus: 'aes-ctr',
		project: 'aes',
		define: 'K_AESCTR',
		n: N,
		slot: slotOf(8192),
		inputBytes: 8192,
		auxBytes: 32,
		arena: 0,
		makeInput: random(8192),
		makeAux: keyIv
	},
	{
		id: 'xxhash32',
		corpus: 'xxhash32',
		project: 'xxhash',
		define: 'K_XXH32',
		n: N,
		slot: 32,
		inputBytes: 131072,
		auxBytes: 0,
		arena: 0,
		makeInput: random(131072)
	},
	{
		id: 'xxhash64',
		corpus: 'xxhash64',
		project: 'xxhash',
		define: 'K_XXH64',
		n: N,
		slot: 32,
		inputBytes: 131072,
		auxBytes: 0,
		arena: 0,
		makeInput: random(131072)
	},
	{
		id: 'xxhash3',
		corpus: 'xxhash3',
		project: 'xxhash',
		define: 'K_XXH3',
		n: N,
		slot: 32,
		inputBytes: 131072,
		auxBytes: 0,
		arena: 0,
		makeInput: random(131072)
	},
	{
		id: 'qoi-encode',
		corpus: 'qoi-encode',
		project: 'qoi',
		define: 'K_QOIE',
		extra: { DIM: dim, ARENA: 65536 },
		n: N,
		slot: slotOf(dim * dim * 5 + 30),
		inputBytes: dim * dim * 4,
		auxBytes: 0,
		arena: 65536,
		makeInput: image(dim)
	},
	{
		id: 'qoi-decode',
		corpus: 'qoi-decode',
		project: 'qoi',
		define: 'K_QOID',
		extra: { DIM: dim, ARENA: 65536 },
		n: N,
		slot: slotOf(dim * dim * 4),
		inputBytes: 0,
		auxBytes: 0,
		arena: 65536,
		from: 'qoi-encode'
	},
	{
		id: 'qoi-encode-64',
		corpus: 'qoi-encode',
		project: 'qoi',
		define: 'K_QOIE',
		extra: { DIM: 64, ARENA: 65536 },
		n: N,
		slot: slotOf(64 * 64 * 5 + 30),
		inputBytes: 64 * 64 * 4,
		auxBytes: 0,
		arena: 65536,
		makeInput: image(64)
	},
	{
		id: 'qoi-decode-64',
		corpus: 'qoi-decode',
		project: 'qoi',
		define: 'K_QOID',
		extra: { DIM: 64, ARENA: 65536 },
		n: N,
		slot: slotOf(64 * 64 * 4),
		inputBytes: 0,
		auxBytes: 0,
		arena: 65536,
		from: 'qoi-encode-64'
	},
	{
		id: 'sha256',
		corpus: 'sha256',
		project: 'crypto',
		define: 'K_SHA256',
		n: N,
		slot: 64,
		inputBytes: 32768,
		auxBytes: 0,
		arena: 0,
		makeInput: random(32768)
	},
	{
		id: 'sha256-shared',
		corpus: 'sha256',
		project: 'crypto',
		define: 'K_SHA256',
		extra: { SHARED: 1 },
		n: N,
		slot: 64,
		inputBytes: 32768,
		auxBytes: 0,
		arena: 0,
		makeInput: random(32768)
	},
	{
		id: 'sha1',
		corpus: 'sha1',
		project: 'crypto',
		define: 'K_SHA1',
		n: N,
		slot: 64,
		inputBytes: 32768,
		auxBytes: 0,
		arena: 0,
		makeInput: random(32768)
	},
	{
		id: 'md5',
		corpus: 'md5',
		project: 'crypto',
		define: 'K_MD5',
		n: N,
		slot: 64,
		inputBytes: 32768,
		auxBytes: 0,
		arena: 0,
		makeInput: random(32768)
	},
	{
		id: 'm6502',
		corpus: 'm6502',
		project: 'chips',
		define: 'K_M6502',
		extra: { CYCLES: 16384 },
		n: 64,
		slot: 32,
		inputBytes: 0,
		auxBytes: 65536,
		arena: 0,
		makeAux: ram6502
	}
];

export interface Layout {
	table: number;
	config: number;
	aux: number;
	out: number;
	arena: number;
	data: number;
	end: number;
	pages: number;
}

/** Memory map for `n` records of a spec; `inputs` are the record input lengths. */
export function layoutOf(
	spec: Spec,
	n: number,
	inputs: number[],
	opts: { arenaSlices?: number; configCopies?: number } = {}
): Layout {
	const table = BASE;
	const config = table + align(n * 16, 4096);
	const copies = opts.configCopies ?? (spec.config?.perRecord ? n : 1);
	const configBytes = spec.config ? copies * spec.config.stride : 0;
	const aux = align(config + configBytes, 4096);
	const out = align(aux + n * spec.auxBytes, 4096);
	const arena = align(out + n * spec.slot, 4096);
	const data = align(arena + (opts.arenaSlices ?? n) * spec.arena, 4096);
	const total = inputs.reduce((sum, length) => sum + align(length + 32, 32), 0);
	const end = data + total;
	return { table, config, aux, out, arena, data, end, pages: Math.ceil(end / 65536) + 2 };
}

export function compilerEnv() {
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
	return { clang, env };
}

const sourcesDir = join(root, 'build/research/corpus/sources');
export function projectOf(id: string) {
	const project = corpusManifest.projects.find((item) => item.id === id);
	if (!project) throw new Error(`unknown project ${id}`);
	return {
		...project,
		dir: join(sourcesDir, `${project.id}-${project.sha256.slice(0, 16)}`)
	};
}

export function buildSpec(spec: Spec): string {
	const { clang, env } = compilerEnv();
	const project = projectOf(spec.project);
	const kernels = corpusManifest.cases.filter((item) => item.project === spec.project);
	const sourceList = [
		...project.sources,
		...(kernels.find((item) => item.id === spec.corpus)?.sources ?? [])
	].map((path) => join(project.dir, path));
	if (spec.project === 'xxhash') sourceList.push(join(root, 'build/research/corpus/multi3.c'));
	const defines = Object.entries({ SLOT: spec.slot, ...(spec.extra ?? {}) }).map(
		([key, value]) => `-D${key}=${value}`
	);
	mkdirSync(outDir, { recursive: true });
	const output = join(outDir, `${spec.id}.wasm`);
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
			`-D${spec.define}`,
			...defines,
			...(project.flags ?? []),
			'-I',
			join(adapters, 'include'),
			'-I',
			join(project.dir, project.include),
			join(adapters, 'c21/support-bulk.c'),
			join(adapters, 'c21/bulk.c'),
			...sourceList,
			'-Wl,--no-entry,--import-memory,--export-memory,--allow-undefined',
			`-Wl,--export=bulk,--export=bulk_chunks${spec.config ? ',--export=setup' : ''}`,
			'-Wl,--initial-memory=1048576',
			'-Wl,--max-memory=4294967296',
			'-o',
			output
		],
		{ env, stdio: 'pipe' }
	);
	if (!WebAssembly.validate(readFileSync(output)))
		throw new Error(`${spec.id} does not validate`);
	return output;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
	const only = process.argv.slice(2);
	for (const spec of specs) {
		if (only.length && !only.includes(spec.id)) continue;
		try {
			const file = buildSpec(spec);
			console.log('built', spec.id, readFileSync(file).length);
		} catch (error) {
			const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
			console.log('FAILED', spec.id, stderr.slice(0, 600));
		}
	}
}
