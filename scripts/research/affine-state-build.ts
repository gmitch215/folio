import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initialContext } from '../../src/affine-state.ts';
import { cases, clang, defaultOut, env, link, root, stale } from './affine-build.ts';

const source = join(cases, 'affine/context-subjects.c');

/** The context structs written for this study; the entry of each is `<name>_update`. */
export const ownContextSubjects = [
	'crcctx',
	'crclen',
	'fletcher',
	'polyctx',
	'last8',
	'mix8',
	'hidden',
	'crccouple'
];

/** Context image the own subjects start from: zeros, with the parameters their structs hold. */
export function ownContext(name: string): Uint8Array {
	const image = new Uint8Array(256);
	const view = new DataView(image.buffer);
	if (name === 'crcctx') view.setUint32(0, 0xc0ffee, true);
	if (name === 'polyctx') view.setUint32(0, 31, true);
	return image;
}

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

/** Builds each own subject as its own module and returns the path by name. */
export function buildContextSubjects(outDir = defaultOut): Record<string, string> {
	const out: Record<string, string> = {};
	mkdirSync(outDir, { recursive: true });
	for (const name of ownContextSubjects) {
		const output = join(outDir, `ctx-${name}.wasm`);
		if (stale(output, [source, new URL(import.meta.url).pathname])) {
			execFileSync(clang, [...flags, source, '-o', output, ...link(`${name}_update`)], {
				env,
				stdio: 'pipe'
			});
		}
		out[name] = output;
	}
	return out;
}

/** Builds the context CRC that changes its register once, when the register equals `trigger`. */
export function buildAdversarialContext(trigger: number, outDir = defaultOut): string {
	const hex = (trigger >>> 0).toString(16).padStart(8, '0');
	const output = join(outDir, `ctx-adv-${hex}.wasm`);
	mkdirSync(outDir, { recursive: true });
	if (stale(output, [source, new URL(import.meta.url).pathname]))
		execFileSync(
			clang,
			[...flags, `-DTRIGGER=0x${hex}u`, source, '-o', output, ...link('advctx_update')],
			{ env, stdio: 'pipe' }
		);
	return output;
}

const manifest = JSON.parse(readFileSync(join(cases, '../corpus-manifest.json'), 'utf8')) as {
	projects: { id: string; repository: string; commit: string; sha256: string }[];
};

interface CorpusSpec {
	project: string;
	sources: string[];
	exports: string[];
	flags?: string[];
}

/** Corpus entries with their state in a context struct, compiled with no wrapper. */
export const corpusContextSubjects: Record<string, CorpusSpec> = {
	sha256: {
		project: 'crypto',
		sources: ['sha256.c'],
		exports: ['sha256_update', 'sha256_init', 'sha256_final']
	},
	sha1: {
		project: 'crypto',
		sources: ['sha1.c'],
		exports: ['sha1_update', 'sha1_init', 'sha1_final']
	},
	md5: {
		project: 'crypto',
		sources: ['md5.c'],
		exports: ['md5_update', 'md5_init', 'md5_final']
	},
	'aes-ctr': {
		project: 'aes',
		sources: ['aes.c'],
		exports: ['AES_CTR_xcrypt_buffer', 'AES_init_ctx_iv']
	},
	xxh32: {
		project: 'xxhash',
		sources: ['xxhash.c'],
		exports: ['XXH32_update', 'XXH32_reset', 'XXH32_digest'],
		flags: ['-Wl,--allow-undefined']
	}
};

/** The entry of each corpus subject: the update function the corpus entry names. */
export const corpusEntry: Record<string, string> = {
	sha256: 'sha256_update',
	sha1: 'sha1_update',
	md5: 'md5_update',
	'aes-ctr': 'AES_CTR_xcrypt_buffer',
	xxh32: 'XXH32_update'
};

function corpusSource(id: string, outDir: string): string | undefined {
	const pin = manifest.projects.find((project) => project.id === id)!;
	const archive = join(root, `build/research/corpus/${id}.tar.gz`);
	if (!existsSync(archive)) return undefined;
	if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== pin.sha256)
		throw new Error(`${id} archive digest differs from the pin`);
	const work = join(outDir, `${id}-src`);
	mkdirSync(work, { recursive: true });
	if (!readdirSync(work).some((entry) => entry.endsWith(pin.commit)))
		execFileSync('tar', ['xzf', archive, '-C', work]);
	return join(
		work,
		readdirSync(work).find((entry) => entry.endsWith(pin.commit))!
	);
}

/**
 * Builds the corpus subjects whose pinned archive is in the corpus cache, with the compiler flags
 * of the corpus build and the one-line freestanding support file. Returns the path by name.
 */
export function buildCorpusContextSubjects(outDir = defaultOut): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, spec] of Object.entries(corpusContextSubjects)) {
		const dir = corpusSource(spec.project, outDir);
		if (!dir) continue;
		const output = join(outDir, `corpus-${name}.wasm`);
		const inputs = [
			join(cases, 'support-min.c'),
			...spec.sources.map((file) => join(dir, file))
		];
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
					'-I',
					join(cases, 'include'),
					'-I',
					dir,
					...inputs,
					'-o',
					output,
					'-Wl,--no-entry,--export-memory',
					'-Wl,--initial-memory=2097152,--max-memory=536870912',
					...spec.exports.map((entry) => `-Wl,--export=${entry}`),
					...(spec.flags ?? [])
				],
				{ env, stdio: 'pipe' }
			);
		}
		out[name] = output;
	}
	return out;
}

/** The context image after the corpus init function, 256 bytes (the window). */
export function corpusContext(name: string, path: string): Uint8Array {
	const module = new WebAssembly.Module(readFileSync(path));
	if (name === 'sha256' || name === 'sha1' || name === 'md5')
		return initialContext(module, `${name}_init`, (ctx) => [ctx]);
	if (name === 'xxh32') return initialContext(module, 'XXH32_reset', (ctx) => [ctx, 0]);
	if (name === 'aes-ctr') {
		const keyAndIv = Uint8Array.from({ length: 32 }, (_, i) => (i < 16 ? i * 17 + 3 : 0));
		return initialContext(
			module,
			'AES_init_ctx_iv',
			(ctx, data) => [ctx, data, data + 16],
			keyAndIv
		);
	}
	throw new Error(`unknown corpus subject ${name}`);
}

if (import.meta.main) {
	for (const path of Object.values(buildContextSubjects())) console.log(path);
	for (const path of Object.values(buildCorpusContextSubjects())) console.log(path);
}
