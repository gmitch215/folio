import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { corpusManifest, fetchProject } from './corpus.ts';

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

// stereo 16-bit audio of one QOA frame (5120 samples per channel), integer waves plus noise
const qoaFrameBytes = 5120 * 2 * 2;
const qoaFileBytes = 8 + 8 + 2 * 16 + 256 * 8 * 2;
const pcm = (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x1b873593);
	const data = new Int16Array(5120 * 2);
	const triangle = (t: number, period: number) => {
		const phase = t % period;
		return phase < period / 2 ? phase : period - phase;
	};
	for (let t = 0; t < 5120; t++) {
		const left = triangle(t + i * 37, 200 + (i % 7) * 13) * 60 + triangle(t, 61) * 20;
		const right = triangle(t + i * 11, 331) * 40 + triangle(t, 97) * 25;
		data[2 * t] = left - 6000 + Math.floor(next() * 400) - 200;
		data[2 * t + 1] = right - 4000 + Math.floor(next() * 400) - 200;
	}
	return new Uint8Array(data.buffer);
};

const sentence = (next: () => number, words: number) =>
	Array.from({ length: words }, () => vocabulary[Math.floor(next() * vocabulary.length)]!).join(
		' '
	);

/** A JSON array of mixed objects: integers, fractions, exponents, escaped strings, nesting. */
export const jsonDocument = (size: number) => (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x2c1b3c6d);
	const parts: string[] = [];
	let length = 2;
	for (let k = 0; length < size - 400; k++) {
		const fraction = (next() * 2000 - 1000).toFixed(3);
		const exponent = `${1 + Math.floor(next() * 9)}.${Math.floor(next() * 100)}e${Math.floor(next() * 20) - 10}`;
		const item =
			`{"id":${k * 7 + i},"name":"${sentence(next, 2)}","tags":["${sentence(next, 1)}","${sentence(next, 1)}"],` +
			`"score":${fraction},"ratio":${exponent},"ok":${next() < 0.5},"none":null,` +
			`"nested":{"x":${Math.floor(next() * 1e6)},"y":[1,2.5,${k},"\\u00e9\\n\\"q\\""],"z":{}},` +
			`"text":"${sentence(next, 6)}"}`;
		parts.push(item);
		length += item.length + 1;
	}
	return new TextEncoder().encode(`[${parts.join(',')}]`);
};

/** Markdown with headings, emphasis, links, lists, quotes, code fences and tables. */
export const markdown = (size: number) => (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x68e31da4);
	const blocks: string[] = [];
	let length = 0;
	for (let k = 0; length < size - 600; k++) {
		const kind = Math.floor(next() * 7);
		const paragraph = () =>
			Array.from({ length: 3 + Math.floor(next() * 4) }, () => {
				const word = sentence(next, 1);
				const roll = next();
				if (roll < 0.1) return `*${word}*`;
				if (roll < 0.18) return `**${word}**`;
				if (roll < 0.25) return `\`${word}\``;
				if (roll < 0.32) return `[${word}](https://example.com/${word}?a=1&b=2)`;
				if (roll < 0.36) return '&amp; <b>';
				return word;
			}).join(' ');
		let block: string;
		if (kind === 0) block = `${'#'.repeat(1 + (k % 4))} ${sentence(next, 3)}`;
		else if (kind === 1) block = Array.from({ length: 4 }, () => `- ${paragraph()}`).join('\n');
		else if (kind === 2)
			block = Array.from({ length: 3 }, (_, n) => `${n + 1}. ${paragraph()}`).join('\n');
		else if (kind === 3) block = `> ${paragraph()}\n> ${paragraph()}`;
		else if (kind === 4) block = '```c\nint ' + sentence(next, 1) + '(void) { return 0; }\n```';
		else if (kind === 5)
			block = `| a | b |\n|---|---|\n| ${sentence(next, 1)} | ${sentence(next, 1)} |`;
		else block = paragraph() + '\n' + paragraph();
		blocks.push(block);
		length += block.length + 2;
	}
	return new TextEncoder().encode(blocks.join('\n\n') + '\n');
};

// allocator slices of about twice the smallest size at which eight records still ran
const brotliArena = 1 << 21;
const yyjsonArena = 1 << 15;
const md4cArena = 1 << 19;

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
		extra: { DIM: dim, ARENA: 65520 },
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
		extra: { DIM: dim, ARENA: 65520 },
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
		extra: { DIM: 64, ARENA: 65520 },
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
		extra: { DIM: 64, ARENA: 65520 },
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
	},
	{
		id: 'brotli-compress',
		corpus: 'brotli-compress',
		project: 'brotli',
		define: 'K_BROTLIE',
		extra: { ARENA: brotliArena, QUALITY: 5, LGWIN: 16 },
		n: 48,
		slot: slotOf(40000),
		inputBytes: 32768,
		auxBytes: 0,
		arena: brotliArena,
		makeInput: text(32768),
		imports: true
	},
	{
		id: 'brotli-decompress',
		corpus: 'brotli-decompress',
		project: 'brotli',
		define: 'K_BROTLID',
		extra: { ARENA: 1 << 17 },
		n: 64,
		slot: slotOf(32768),
		inputBytes: 0,
		auxBytes: 0,
		arena: 1 << 17,
		from: 'brotli-compress'
	},
	{
		id: 'wyhash',
		corpus: 'wyhash',
		project: 'wyhash',
		define: 'K_WYHASH',
		n: 4096,
		slot: 32,
		inputBytes: 1024,
		auxBytes: 0,
		arena: 0,
		makeInput: random(1024)
	},
	{
		id: 'blake2b',
		corpus: 'blake2b',
		project: 'blake2',
		define: 'K_BLAKE2B',
		n: 256,
		slot: 96,
		inputBytes: 65536,
		auxBytes: 0,
		arena: 0,
		makeInput: random(65536)
	},
	{
		id: 'qoa-encode',
		corpus: 'qoa-encode',
		project: 'qoa',
		define: 'K_QOAE',
		extra: { ARENA: 16384 },
		n: 32,
		slot: slotOf(qoaFileBytes),
		inputBytes: qoaFrameBytes,
		auxBytes: 0,
		arena: 16384,
		makeInput: pcm
	},
	{
		id: 'qoa-decode',
		corpus: 'qoa-decode',
		project: 'qoa',
		define: 'K_QOAD',
		extra: { ARENA: 65536 },
		n: 32,
		slot: slotOf(qoaFrameBytes),
		inputBytes: 0,
		auxBytes: 0,
		arena: 65536,
		from: 'qoa-encode'
	},
	{
		id: 'yyjson-read',
		corpus: 'yyjson-read',
		project: 'yyjson',
		define: 'K_YYJSON',
		extra: { ARENA: yyjsonArena },
		n: 1024,
		slot: 32,
		inputBytes: 4096,
		auxBytes: 0,
		arena: yyjsonArena,
		makeInput: jsonDocument(4096)
	},
	{
		id: 'md4c-html',
		corpus: 'md4c-html',
		project: 'md4c',
		define: 'K_MD4C',
		extra: { ARENA: md4cArena },
		n: 16,
		slot: slotOf(131072),
		inputBytes: 65536,
		auxBytes: 0,
		arena: md4cArena,
		makeInput: markdown(65536)
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
	const dir = join(sourcesDir, `${project.id}-${project.sha256.slice(0, 16)}`);
	if (!existsSync(dir)) fetchProject(project, join(root, 'build/research/corpus'));
	return { ...project, dir };
}

// projects that need libc declarations and helpers beyond the stubs in cases/include
// projects whose 128-bit multiplication needs the pinned compiler runtime builtin
const multi3Projects = new Set(['xxhash', 'wyhash', 'yyjson']);
const libcProjects = new Set(['brotli', 'wyhash', 'blake2', 'qoa', 'yyjson', 'md4c']);

export function buildSpec(spec: Spec): string {
	const { clang, env } = compilerEnv();
	const project = projectOf(spec.project);
	const kernels = [...corpusManifest.cases, ...corpusManifest.bulkCases].filter(
		(item) => item.project === spec.project
	);
	const sourceList = [
		...project.sources,
		...(kernels.find((item) => item.id === spec.corpus)?.sources ?? [])
	].map((path) => join(project.dir, path));
	if (multi3Projects.has(spec.project))
		sourceList.push(join(root, 'build/research/corpus/multi3.c'));
	const libc = libcProjects.has(spec.project);
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
			...(libc ? ['-I', join(adapters, 'c21/include')] : []),
			'-I',
			join(adapters, 'include'),
			'-I',
			join(project.dir, project.include),
			join(adapters, 'c21/support-bulk.c'),
			...(libc ? [join(adapters, 'c21/support-libc.c')] : []),
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
