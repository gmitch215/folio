import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clang, env } from '../../../../scripts/research/affine-build.ts';
import { sha, type Rec } from './lib.ts';

export const here = dirname(fileURLToPath(import.meta.url));
export const modDir = join(here, 'modules');
export const workDir = join(here, 'work');
mkdirSync(modDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

export function mulberry(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// every manifest already written, so a module is never counted twice across families
const seen = new Set<string>();

export class Manifest {
	count = 0;
	dupes = 0;
	invalid = 0;
	name: string;
	constructor(name: string, reset = true) {
		this.name = name;
		if (reset) writeFileSync(join(here, `${name}.jsonl`), '');
		for (const f of readdirSync(here))
			if (f.endsWith('.jsonl') && f !== 'all.jsonl')
				for (const line of readFileSync(join(here, f), 'utf8').split('\n'))
					if (line) seen.add(JSON.parse(line).sha);
	}
	/** Writes the module and one manifest line; false when it is a duplicate or does not validate. */
	add(family: string, id: string, bytes: Uint8Array, extra: Partial<Rec> = {}): boolean {
		try {
			new WebAssembly.Module(Uint8Array.from(bytes));
		} catch {
			this.invalid++;
			return false;
		}
		const h = sha(bytes);
		if (seen.has(h)) {
			this.dupes++;
			return false;
		}
		seen.add(h);
		mkdirSync(join(modDir, family), { recursive: true });
		const file = join(modDir, family, `${h.slice(0, 16)}.wasm`);
		writeFileSync(file, bytes);
		appendFileSync(
			join(here, `${this.name}.jsonl`),
			JSON.stringify({ id, family, file, sha: h, ...extra }) + '\n'
		);
		this.count++;
		return true;
	}
}

export function wat(text: string): Uint8Array {
	const m = binaryen.parseText(text);
	try {
		m.setFeatures(binaryen.Features.All & ~(binaryen.Features as any).CompactImports);
		if (!m.validate()) throw new Error('binaryen validation failed');
		const bytes = Uint8Array.from(m.emitBinary());
		new WebAssembly.Module(bytes);
		return bytes;
	} finally {
		m.dispose();
	}
}

export function toText(bytes: Uint8Array): string {
	const m = binaryen.readBinary(bytes);
	try {
		m.setFeatures(binaryen.Features.All);
		return m.emitText();
	} finally {
		m.dispose();
	}
}

export const FLAGS = [
	'--target=wasm32',
	'-g0',
	'-ffreestanding',
	'-fno-builtin',
	'-nostdlib',
	'-mbulk-memory',
	'-w'
];

/** Builds a freestanding module with the repo's fixture rules: no node_modules/.bin on PATH. */
export function buildC(src: string, flags: string[], entry = 'update'): Uint8Array {
	const h = sha(new TextEncoder().encode(src + flags.join(' ') + entry)).slice(0, 20);
	const cfile = join(workDir, `${h}.c`);
	const out = join(workDir, `${h}.wasm`);
	writeFileSync(cfile, src);
	execFileSync(
		clang,
		[
			...FLAGS,
			...flags,
			cfile,
			'-o',
			out,
			`-Wl,--no-entry,--export-memory,--export=${entry}`,
			'-Wl,--initial-memory=2097152,--max-memory=536870912'
		],
		{ env, stdio: 'pipe' }
	);
	return new Uint8Array(readFileSync(out));
}

export const exists = existsSync;
