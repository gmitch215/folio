import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const adapters = join(root, 'scripts/research/cases');
export const corpusManifest = JSON.parse(
	readFileSync(new URL('./corpus-manifest.json', import.meta.url), 'utf8')
) as {
	schema: number;
	scope: string;
	compilerRuntime: { repository: string; commit: string; path: string; sha256: string };
	memory: { initialPages: number; maximumPages: number; [key: string]: unknown };
	projects: Project[];
	cases: Kernel[];
};

interface Project {
	id: string;
	repository: string;
	commit: string;
	sha256: string;
	license: string;
	licensePath: string;
	include: string;
	sources: string[];
	flags?: string[];
}

export interface Kernel {
	id: string;
	project: string;
	variant: number;
	category: string;
	upstream: string[];
	sources?: string[];
	adapter?: string;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const message = (error: unknown) =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const encode = (value: unknown) =>
	JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? `${item}n` : item));

export function validateSourcePath(path: string): string {
	if (
		!path ||
		isAbsolute(path) ||
		path.includes('\0') ||
		path.includes('\\') ||
		path.split('/').some((part) => !part || part === '..')
	)
		throw new Error(`unsafe source path: ${path}`);
	return path;
}

export function verifySource(bytes: Uint8Array, expected: string): void {
	if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected)
		throw new Error('upstream source hash mismatch');
}

function fetchProject(project: Project, cache: string): string {
	if (
		!/^[-\w]+\/[-\w]+$/.test(project.repository) ||
		!/^[a-f0-9]{40}$/.test(project.commit) ||
		!/^[a-z0-9-]+$/.test(project.id)
	)
		throw new Error('invalid upstream identity');
	const archive = join(cache, `${project.id}.tar.gz`);
	const url = `https://codeload.github.com/${project.repository}/tar.gz/${project.commit}`;
	if (!existsSync(archive))
		execFileSync('curl', ['-fsSL', '--max-time', '120', url, '-o', archive]);
	verifySource(readFileSync(archive), project.sha256);
	const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
	const prefix = `${project.repository.split('/')[1]}-${project.commit}/`;
	for (const line of listing.trim().split('\n')) {
		if (line === prefix.slice(0, -1) || line === prefix) continue;
		if (!line.startsWith(prefix)) throw new Error('unexpected archive root');
		validateSourcePath(line.slice(prefix.length).replace(/\/$/, ''));
	}
	const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' });
	if (details.split('\n').some((line) => line.startsWith('l') || line.startsWith('h')))
		throw new Error('source archive contains links');
	const source = join(cache, 'sources', `${project.id}-${project.sha256.slice(0, 16)}`);
	mkdirSync(source, { recursive: true });
	execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
	return source;
}

export interface BuiltKernel {
	kernel: Kernel;
	bytes: Uint8Array;
	artifact: string;
	provenance: Record<string, unknown>;
}

export function buildCorpus(
	options: {
		cache?: string;
		only?: string[];
		runtimeInputs?: boolean;
		sink?: (row: Record<string, unknown>) => void;
	} = {}
): BuiltKernel[] {
	const cache = resolve(options.cache ?? join(root, 'build/research/corpus'));
	mkdirSync(cache, { recursive: true });
	mkdirSync(join(cache, 'artifacts'), { recursive: true });
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
	const compiler = execFileSync(clang, ['--version'], { encoding: 'utf8', env }).trim();
	const selected = corpusManifest.cases.filter(
		(item) => !options.only || options.only.includes(item.id)
	);
	if (!selected.length || options.only?.some((id) => !selected.some((item) => item.id === id)))
		throw new Error('unknown corpus case');
	const built: BuiltKernel[] = [];
	for (const project of corpusManifest.projects) {
		const cases = selected.filter((item) => item.project === project.id);
		if (!cases.length) continue;
		let source: string;
		try {
			source = fetchProject(project, cache);
			options.sink?.({
				kind: 'source',
				project: project.id,
				commit: project.commit,
				sha256: project.sha256,
				license: project.license,
				licenseSha256: sha256(
					readFileSync(join(source, validateSourcePath(project.licensePath)))
				)
			});
		} catch (error) {
			for (const kernel of cases)
				options.sink?.({
					kind: 'failure',
					stage: 'fetch',
					case: kernel.id,
					error: message(error)
				});
			continue;
		}
		for (const kernel of cases) {
			try {
				const artifactDir = join(
					cache,
					'artifacts',
					...(options.runtimeInputs ? ['inputs'] : [])
				);
				mkdirSync(artifactDir, { recursive: true });
				const artifact = join(artifactDir, `${kernel.id}.wasm`);
				const sources = [...project.sources, ...(kernel.sources ?? [])].map((path) =>
					join(source, validateSourcePath(path))
				);
				if (kernel.id === 'xxhash3') {
					const runtime = corpusManifest.compilerRuntime;
					const file = join(cache, 'multi3.c');
					if (!existsSync(file))
						execFileSync('curl', [
							'-fsSL',
							'--max-time',
							'60',
							`https://raw.githubusercontent.com/${runtime.repository}/${runtime.commit}/${runtime.path}`,
							'-o',
							file
						]);
					verifySource(readFileSync(file), runtime.sha256);
					sources.push(file);
				}
				const flags = [
					'--target=wasm32',
					'-O2',
					'-g0',
					'-ffreestanding',
					'-fno-builtin',
					'-nostdlib',
					'-mbulk-memory',
					'-DNDEBUG',
					...(options.runtimeInputs
						? ['-DFOLIO_CORPUS_INPUTS', '-Wl,--export=corpus_set_seed']
						: []),
					`-DCORPUS_${project.id.toUpperCase()}`,
					`-DCASE=${kernel.variant}`,
					...(project.flags ?? []),
					'-I',
					join(adapters, 'include'),
					'-I',
					join(source, project.include),
					join(adapters, 'support.c'),
					join(adapters, 'kernel.c'),
					...sources,
					'-Wl,--no-entry,--import-memory,--export-memory,--allow-undefined',
					'-Wl,--export=entry,--export=initialize,--export=corpus_output',
					`-Wl,--initial-memory=${corpusManifest.memory.initialPages * 65536}`,
					`-Wl,--max-memory=${corpusManifest.memory.maximumPages * 65536}`,
					'-o',
					artifact
				];
				execFileSync(clang, flags, { env, stdio: 'pipe' });
				const bytes = new Uint8Array(readFileSync(artifact));
				if (!WebAssembly.validate(bytes))
					throw new Error('compiled Wasm does not validate');
				const module = new WebAssembly.Module(bytes);
				const provenance = {
					case: kernel.id,
					project: project.id,
					upstream: kernel.upstream,
					memoryAbi: 'imported-unshared',
					compilerRuntime:
						kernel.id === 'xxhash3' ? corpusManifest.compilerRuntime : undefined,
					sourceCommit: project.commit,
					sourceSha256: project.sha256,
					artifactSha256: sha256(bytes),
					artifactBytes: bytes.length,
					compiler,
					flags: flags.map((arg) => (arg.startsWith(root) ? relative(root, arg) : arg)),
					adapterSha256: sha256(
						Buffer.concat(
							[
								'support.c',
								'kernel.c',
								'include/stdlib.h',
								'include/string.h',
								'include/math.h',
								'include/stdio.h',
								'include/assert.h',
								'include/int_lib.h',
								'include/memory.h',
								'include/miniz_export.h'
							].map((name) => readFileSync(join(adapters, name)))
						)
					),
					imports: WebAssembly.Module.imports(module),
					exports: WebAssembly.Module.exports(module),
					call: { export: 'entry', args: [] },
					memory: corpusManifest.memory
				};
				writeFileSync(
					artifact.replace(/\.wasm$/, '.json'),
					JSON.stringify(provenance, null, 2) + '\n'
				);
				options.sink?.({ kind: 'build', ...provenance });
				built.push({ kernel, bytes, artifact, provenance });
			} catch (error) {
				const stderr = (error as { stderr?: Buffer }).stderr?.toString();
				options.sink?.({
					kind: 'failure',
					stage: 'build',
					case: kernel.id,
					error: stderr ?? message(error)
				});
			}
		}
	}
	return built;
}

export function corpusImports() {
	const effects: { name: string; args: number[]; value: number }[] = [];
	const memory = new WebAssembly.Memory({
		initial: corpusManifest.memory.initialPages,
		maximum: corpusManifest.memory.maximumPages
	});
	const env: Record<string, WebAssembly.ImportValue> = { memory };
	for (const name of ['sin', 'cos', 'floor', 'sqrt'] as const)
		env[name] = (...args: number[]) => {
			const value = Math[name](args[0]!);
			effects.push({ name, args, value });
			return value;
		};
	return { imports: { env } as WebAssembly.Imports, memory, effects };
}

export function resetCorpus(
	exports: WebAssembly.Exports,
	memory: WebAssembly.Memory,
	initial: Uint8Array
): void {
	if (memory.buffer.byteLength !== initial.length) throw new Error('corpus memory grew');
	new Uint8Array(memory.buffer).set(initial);
	(exports.initialize as CallableFunction)();
}

export async function smokeCorpus(
	built: BuiltKernel[],
	sink: (row: Record<string, unknown>) => void
): Promise<void> {
	for (const item of built) {
		const { kernel, bytes } = item;
		const nativeHost = corpusImports();
		let native: { values?: unknown[]; trap?: string } = {};
		let nativeMemory: Uint8Array | undefined;
		let nativeInitial: string | undefined;
		let nativeInitializationEffects: unknown[] = [];
		try {
			const module = new WebAssembly.Module(Uint8Array.from(bytes));
			const instance = new WebAssembly.Instance(module, nativeHost.imports);
			const memory = instance.exports.memory as WebAssembly.Memory;
			resetCorpus(instance.exports, memory, new Uint8Array(memory.buffer).slice());
			nativeInitial = sha256(new Uint8Array(memory.buffer));
			nativeInitializationEffects = nativeHost.effects.slice();
			nativeHost.effects.length = 0;
			try {
				native.values = [(instance.exports.entry as CallableFunction)()];
			} catch (error) {
				native.trap = message(error);
			}
			nativeMemory = new Uint8Array(memory.buffer).slice();
			sink({
				kind: 'native',
				case: kernel.id,
				...native,
				memorySha256: sha256(nativeMemory),
				memoryBytes: nativeMemory.length,
				initialMemorySha256: nativeInitial,
				initializationEffects: nativeInitializationEffects,
				effects: nativeHost.effects
			});
		} catch (error) {
			sink({ kind: 'failure', stage: 'native', case: kernel.id, error: message(error) });
		}
		let pool: Folio | undefined;
		try {
			const plan = prepare(bytes);
			sink({
				kind: 'inspect',
				case: kernel.id,
				export: 'entry',
				loops: Object.keys(plan.loops),
				native: Object.keys(plan.native ?? {}),
				controlEntries: plan.control?.entries ?? [],
				reasons: plan.reasons,
				loopReason: plan.loopReasons?.entry,
				controlReasons: plan.controlReasons ?? []
			});
			const host = corpusImports();
			pool = await Folio.open(plan, { imports: host.imports, workers: 2 });
			const coverage = pool.inspect('entry');
			resetCorpus(pool.exports, pool.memory, new Uint8Array(pool.memory.buffer).slice());
			const initialMemoryEqual = nativeInitial === sha256(new Uint8Array(pool.memory.buffer));
			const initializationEffectsEqual =
				encode(nativeInitializationEffects) === encode(host.effects);
			host.effects.length = 0;
			let report;
			let trap;
			try {
				report = await pool.run('entry', []);
			} catch (error) {
				trap = message(error);
			}
			const memory = new Uint8Array(pool.memory.buffer);
			const memoryEqual = Boolean(nativeMemory && Buffer.from(memory).equals(nativeMemory));
			const returnsEqual =
				encode(native.values) === encode(report?.values) && native.trap === trap;
			const effectsEqual = encode(nativeHost.effects) === encode(host.effects);
			sink({
				kind: 'comparison',
				case: kernel.id,
				project: kernel.project,
				passed:
					initialMemoryEqual &&
					initializationEffectsEqual &&
					memoryEqual &&
					returnsEqual &&
					effectsEqual,
				initialMemoryEqual,
				initializationEffectsEqual,
				memoryEqual,
				returnsEqual,
				effectsEqual,
				values: report?.values,
				trap,
				memorySha256: sha256(memory),
				memoryBytes: memory.length,
				effects: host.effects,
				report,
				coverage,
				diagnostics: pool.diagnostics,
				nativeFallback: report?.mode === 'serial',
				prepared: {
					loops: Object.keys(plan.loops),
					native: Object.keys(plan.native ?? {}),
					controlEntries: plan.control?.entries ?? [],
					reasons: plan.reasons,
					controlReasons: plan.controlReasons ?? []
				}
			});
		} catch (error) {
			sink({ kind: 'failure', stage: 'folio', case: kernel.id, error: message(error) });
		} finally {
			await pool?.close();
		}
	}
}

if (import.meta.main) {
	const [command, output = 'build/research/corpus/smoke.jsonl', ...only] = process.argv.slice(2);
	if (command !== 'build' && command !== 'smoke')
		throw new Error('usage: corpus.ts build|smoke [OUTPUT.jsonl] [CASE ...]');
	const rows: Record<string, unknown>[] = [];
	const target = resolve(output);
	if (existsSync(target)) throw new Error('output already exists; choose a new smoke record');
	mkdirSync(resolve(target, '..'), { recursive: true });
	const sink = (row: Record<string, unknown>) => {
		rows.push(row);
		writeFileSync(target, rows.map(encode).join('\n') + '\n');
		console.log(encode(row));
	};
	sink({
		kind: 'environment',
		schema: 1,
		node: process.version,
		v8: process.versions.v8,
		manifestSha256: sha256(readFileSync(new URL('./corpus-manifest.json', import.meta.url))),
		scope: corpusManifest.scope,
		selected: only.length ? only : corpusManifest.cases.map((item) => item.id),
		timing: false
	});
	const built = buildCorpus({ only: only.length ? only : undefined, sink });
	if (command === 'smoke') await smokeCorpus(built, sink);
	const selected = only.length || corpusManifest.cases.length;
	const comparisons = rows.filter((row) => row.kind === 'comparison');
	const failures = rows.filter((row) => row.kind === 'failure');
	sink({
		kind: 'summary',
		selected,
		built: built.length,
		compared: comparisons.length,
		passed: comparisons.filter((row) => row.passed).length,
		failures: failures.length,
		projects: corpusManifest.projects.map((project) => ({
			project: project.id,
			selected: corpusManifest.cases.filter(
				(item) => item.project === project.id && (!only.length || only.includes(item.id))
			).length,
			built: built.filter((item) => item.kernel.project === project.id).length,
			passed: comparisons.filter((row) => row.project === project.id && row.passed).length
		}))
	});
	if (
		failures.length ||
		built.length !== selected ||
		(command === 'smoke' && comparisons.some((row) => !row.passed))
	)
		process.exitCode = 1;
}
