import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const cases = fileURLToPath(new URL('./', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const shimDir = join(cases, 'shim');
const driversDir = join(cases, 'drivers');
const buildDir = join(root, 'build/research/final');
const manifestFile = join(cases, 'final-manifest.json');
const llvmDir =
	process.env.LLVM ??
	(existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin' : '');
const wasmClang = llvmDir ? join(llvmDir, 'clang') : 'clang';
const nativeClang = process.env.NATIVE_CC ?? '/usr/bin/clang';
const env = {
	...process.env,
	PATH: (process.env.PATH ?? '')
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join('node_modules', '.bin')))
		.join(delimiter)
};

export interface Driver {
	id: string;
	function: string;
	category: string;
	define: string;
	records: number;
	slot: number;
	recordCapacity: number;
	arena: number;
	genArena: number;
	arenaResetPerRecord: boolean;
	sourceFile: string;
	result?: DriverResult;
}

export interface DriverResult {
	build: 'PASS' | 'failed';
	run?: 'PASS' | 'failed';
	error?: string;
	native?: 'PASS' | 'failed';
	wasmSlotsSha256?: string;
	nativeSlotsSha256?: string;
	equal?: boolean;
	stableAcrossRuns?: boolean;
}

export interface Project {
	id: string;
	repository: string;
	tag: string;
	commit: string;
	license: string;
	licence?: 'pending';
	licenseFile: string;
	treeListingSha256: string;
	vendorDigest: string;
	include: string[];
	config: string[];
	defines?: string[];
	translationUnits: string[];
	nativeFlags?: string[];
	candidates: {
		enumeration: string;
		candidates: string[];
		skipped: { function: string; reason: string }[];
	};
	drivers: Driver[];
}

export interface Manifest {
	schema: number;
	shimDigest: string;
	memory: { initialPages: number; maximumPages: number };
	projects: Project[];
}

export const sha256 = (bytes: Uint8Array | string) =>
	createHash('sha256').update(bytes).digest('hex');

export function readManifest(): Manifest {
	return JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else out.push(path);
		}
	};
	walk(dir);
	return out.sort();
}

// sha256 over "relative-path TAB sha256 LF" lines, in sorted path order.
export function digestOf(dir: string): string {
	const lines = listFiles(dir).map(
		(path) => `${relative(dir, path)}\t${sha256(readFileSync(path))}\n`
	);
	return sha256(lines.join(''));
}

export const shimDigest = () => sha256(digestOf(shimDir) + digestOf(join(cases, 'config')));

export function vendorDir(project: Project): string {
	return join(cases, 'upstream', project.id);
}

export function verifyDigests(manifest: Manifest): void {
	const shim = shimDigest();
	if (shim !== manifest.shimDigest)
		throw new Error(`shim digest is ${shim}, manifest has ${manifest.shimDigest}`);
	for (const project of manifest.projects) {
		const vendor = digestOf(vendorDir(project));
		if (vendor !== project.vendorDigest)
			throw new Error(
				`${project.id} vendored digest is ${vendor}, manifest has ${project.vendorDigest}`
			);
	}
}

const wasmFlags = [
	'--target=wasm32',
	'-O2',
	'-g0',
	'-ffreestanding',
	'-fno-builtin',
	'-nostdlib',
	'-mbulk-memory',
	'-DNDEBUG'
];

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { env, maxBuffer: 1 << 26 }, (error, stdout, stderr) => {
			if (error)
				reject(new Error((stderr || error.message).trim().split(root).join('<repo>/')));
			else resolve(stdout);
		});
	});
}

async function compileAll(
	clang: string,
	jobs: { source: string; object: string; args: string[] }[]
): Promise<void> {
	await Promise.all(
		jobs.map((job) => run(clang, [...job.args, '-c', job.source, '-o', job.object]))
	);
}

// the shim is compiled once per shim digest and reused by every driver.
export async function shimObjects(): Promise<string[]> {
	const dir = join(buildDir, `shim-${shimDigest().slice(0, 16)}`);
	const sentinel = join(dir, 'ready');
	const musl = join(shimDir, 'musl');
	const sources = [
		join(shimDir, 'shim.c'),
		...['multi3.c', 'lshrti3.c', 'ashlti3.c'].map((name) => join(shimDir, 'builtins', name)),
		...listFiles(join(musl, 'src/math')).filter((p) => p.endsWith('.c'))
	];
	const objects = sources.map((_, i) => join(dir, `shim-${i}.o`));
	if (!existsSync(sentinel)) {
		mkdirSync(dir, { recursive: true });
		const args = [
			...wasmFlags,
			'-I',
			join(shimDir, 'include'),
			'-I',
			join(musl, 'src/internal'),
			'-I',
			join(musl, 'arch/generic')
		];
		await compileAll(
			wasmClang,
			sources.map((source, i) => ({ source, object: objects[i]!, args }))
		);
		writeFileSync(sentinel, '');
	}
	return objects;
}

const projectOf = (manifest: Manifest, driver: Driver): Project => {
	const project = manifest.projects.find((item) => item.drivers.includes(driver));
	if (!project) throw new Error(`no project for ${driver.id}`);
	return project;
};

function driverArgs(project: Project, driver: Driver, wasm: boolean): string[] {
	const includes = [
		...(wasm ? ['-I', join(shimDir, 'include')] : []),
		...project.config.flatMap((dir) => ['-I', join(cases, dir)]),
		...project.include.flatMap((dir) => ['-I', join(vendorDir(project), dir)]),
		'-I',
		driversDir
	];
	return [
		`-DSLOT=${driver.slot}`,
		`-DREC_CAP=${driver.recordCapacity}`,
		`-DRECORDS=${driver.records}`,
		`-DARENA=${driver.arena}`,
		`-DGEN_ARENA=${driver.genArena}`,
		`-D${driver.define}`,
		...(project.defines ?? []).map((name) => `-D${name}`),
		...includes
	];
}

const translationUnits = (project: Project, driver: Driver) => [
	...project.translationUnits.map((path) => join(vendorDir(project), path)),
	join(root, driver.sourceFile)
];

// dir receives the object files and the linked module; one directory per driver.
export async function buildWasm(manifest: Manifest, driver: Driver, dir: string): Promise<string> {
	const project = projectOf(manifest, driver);
	mkdirSync(dir, { recursive: true });
	const sources = translationUnits(project, driver);
	const args = [...wasmFlags, ...driverArgs(project, driver, true)];
	const objects = sources.map((_, i) => join(dir, `unit-${i}.o`));
	await compileAll(
		wasmClang,
		sources.map((source, i) => ({ source, object: objects[i]!, args }))
	);
	const wasm = join(dir, 'driver.wasm');
	await run(wasmClang, [
		'--target=wasm32',
		'-nostdlib',
		'-Wl,--no-entry,--export=prepare,--export=bulk,--export=__heap_base',
		'-Wl,--import-memory,--export-memory',
		`-Wl,--initial-memory=${manifest.memory.initialPages * 65536}`,
		`-Wl,--max-memory=${manifest.memory.maximumPages * 65536}`,
		...objects,
		...(await shimObjects()),
		'-o',
		wasm
	]);
	return wasm;
}

// the native binary writes every slot to slots.bin; the slots are compared with the wasm slots.
export function buildNative(manifest: Manifest, driver: Driver, dir: string): string {
	const project = projectOf(manifest, driver);
	mkdirSync(dir, { recursive: true });
	const sources = [...translationUnits(project, driver), join(driversDir, 'native.c')];
	const args = [
		'-O2',
		'-DNDEBUG',
		...(project.nativeFlags ?? []),
		...driverArgs(project, driver, false)
	];
	const bin = join(dir, 'native-driver');
	execFileSync(nativeClang, [...args, ...sources, '-o', bin], { env, stdio: 'pipe' });
	const slots = join(dir, 'slots.bin');
	execFileSync(bin, [slots], { env, stdio: 'pipe' });
	return slots;
}

export function slotDigests(bytes: Uint8Array, records: number, slot: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < records; i++) out.push(sha256(bytes.subarray(i * slot, (i + 1) * slot)));
	return out;
}

export interface WasmRun {
	digests: string[];
	stable: boolean;
	times: number[];
}

const align = (x: number) => (x + 63) & ~63;

export interface Layout {
	table: number;
	heap: number;
	arenas: number;
	out: number;
	total: number;
}

// table, then the heap (inputs, one arena per record, one slice for the input generators), then the slots.
export function layoutOf(driver: Driver, heapBase: number): Layout {
	const { records, slot, recordCapacity, arena, genArena } = driver;
	const table = align(heapBase);
	const heap = table + align(records * 16);
	const arenas = heap + align(records * recordCapacity);
	const out = arenas + records * arena + genArena;
	return { table, heap, arenas, out, total: out + records * slot };
}

export const newMemory = (manifest: Manifest) =>
	new WebAssembly.Memory({
		initial: manifest.memory.initialPages,
		maximum: manifest.memory.maximumPages
	});

export interface Loaded {
	memory: WebAssembly.Memory;
	layout: Layout;
	exports: Record<string, unknown>;
	// runs records [from, to) of the table into their own slots
	bulk(from: number, to: number): void;
	slots(): Uint8Array;
}

// instantiates the module on the given memory (a fresh one by default) and runs prepare.
export async function loadWasm(
	path: string,
	driver: Driver,
	manifest: Manifest,
	memory = newMemory(manifest)
): Promise<Loaded> {
	const module = await WebAssembly.compile(readFileSync(path));
	const instance = await WebAssembly.instantiate(module, { env: { memory } });
	const exports = instance.exports as Record<string, unknown>;
	const prepare = exports.prepare as (t: number, n: number, h: number) => number;
	const bulk = exports.bulk as (t: number, n: number, o: number) => number;
	const heapBase = (exports.__heap_base as WebAssembly.Global).value as number;
	const layout = layoutOf(driver, heapBase);
	if (layout.total > 0xffff0000)
		throw new Error(`layout needs ${layout.total} bytes, over the wasm32 memory limit`);
	const pages = Math.ceil((layout.total - memory.buffer.byteLength) / 65536);
	if (pages > 0) memory.grow(pages);
	const used = prepare(layout.table, driver.records, layout.heap);
	if (used > driver.records * driver.recordCapacity)
		throw new Error('inputs exceed the record capacity');
	return {
		memory,
		layout,
		exports,
		bulk: (from, to) =>
			void bulk(layout.table + 16 * from, to - from, layout.out + from * driver.slot),
		slots: () => new Uint8Array(memory.buffer, layout.out, driver.records * driver.slot)
	};
}

// runs prepare once, then bulk `repeat` times on zeroed output; the first run's slots are returned.
export async function runWasm(
	path: string,
	driver: Driver,
	repeat: number,
	manifest = readManifest()
): Promise<WasmRun> {
	const loaded = await loadWasm(path, driver, manifest);
	const { records, slot } = driver;
	const digests: string[][] = [];
	const times: number[] = [];
	for (let r = 0; r < repeat; r++) {
		loaded.slots().fill(0);
		const t0 = performance.now();
		loaded.bulk(0, records);
		times.push(performance.now() - t0);
		digests.push(slotDigests(loaded.slots(), records, slot));
	}
	const first = digests[0]!;
	const stable = digests.every((run) => run.join() === first.join());
	return { digests: first, stable, times };
}

// a seeded shuffle and two interleaved halves on separate memories must give the serial slots.
export async function orderInvariance(
	path: string,
	driver: Driver,
	manifest: Manifest,
	serial: string[]
): Promise<{ shuffled: boolean; interleaved: boolean }> {
	const { records, slot } = driver;
	const order = Array.from({ length: records }, (_, i) => i);
	let state = 12345;
	for (let i = records - 1; i > 0; i--) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const j = state % (i + 1);
		[order[i], order[j]] = [order[j]!, order[i]!];
	}
	const first = await loadWasm(path, driver, manifest);
	for (const i of order) first.bulk(i, i + 1);
	const shuffled = slotDigests(first.slots(), records, slot).join() === serial.join();
	const even = await loadWasm(path, driver, manifest);
	const odd = await loadWasm(path, driver, manifest);
	for (let i = 0; i < records; i += 2) {
		even.bulk(i, i + 1);
		if (i + 1 < records) odd.bulk(i + 1, i + 2);
	}
	const merged = new Uint8Array(records * slot);
	for (let i = 0; i < records; i++)
		merged.set((i % 2 ? odd : even).slots().subarray(i * slot, (i + 1) * slot), i * slot);
	return { shuffled, interleaved: slotDigests(merged, records, slot).join() === serial.join() };
}

export function runNative(path: string, driver: Driver): string[] {
	const bytes = readFileSync(path);
	return slotDigests(new Uint8Array(bytes), driver.records, driver.slot);
}

export const combined = (digests: string[]) => sha256(digests.join('\n'));
const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

export async function checkDriver(
	manifest: Manifest,
	driver: Driver,
	options: { timed: boolean }
): Promise<{ result: DriverResult; medianMs?: number; spreadMs?: [number, number] }> {
	const dir = join(buildDir, driver.id);
	let wasmPath: string;
	try {
		wasmPath = await buildWasm(manifest, driver, dir);
	} catch (error) {
		return { result: { build: 'failed', error: (error as Error).message.slice(0, 2000) } };
	}
	let wasm: WasmRun;
	try {
		wasm = await runWasm(wasmPath, driver, options.timed ? 3 : 1, manifest);
	} catch (error) {
		return {
			result: { build: 'PASS', run: 'failed', error: (error as Error).message.slice(0, 2000) }
		};
	}
	const wasmSlotsSha256 = combined(wasm.digests);
	const result: DriverResult = {
		build: 'PASS',
		run: 'PASS',
		wasmSlotsSha256,
		stableAcrossRuns: wasm.stable
	};
	if (!options.timed) return { result };
	let slots: string;
	try {
		slots = buildNative(manifest, driver, dir);
	} catch (error) {
		return {
			result: { ...result, native: 'failed', error: (error as Error).message.slice(0, 2000) }
		};
	}
	const nativeDigests = runNative(slots, driver);
	const nativeSlotsSha256 = combined(nativeDigests);
	const sorted = [...wasm.times].sort((a, b) => a - b);
	return {
		result: {
			...result,
			native: 'PASS',
			nativeSlotsSha256,
			equal: nativeSlotsSha256 === wasmSlotsSha256
		},
		medianMs: median(wasm.times),
		spreadMs: [sorted[0]!, sorted[sorted.length - 1]!]
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const manifest = readManifest();
	if (args.includes('--digests')) {
		console.log(`shim ${shimDigest()}`);
		for (const project of manifest.projects)
			console.log(`${project.id} ${digestOf(vendorDir(project))}`);
		process.exit(0);
	}
	verifyDigests(manifest);
	const only = args
		.find((arg) => arg.startsWith('--only='))
		?.slice(7)
		.split(',');
	const record = args.includes('--record');
	const drivers = manifest.projects
		.flatMap((p) => p.drivers)
		.filter((d) => !only || only.includes(d.id));
	console.log('id\tbuild\trun\tnative\tequal\tstable\tmedianMs\tspreadMs');
	for (const driver of drivers) {
		const { result, medianMs, spreadMs } = await checkDriver(manifest, driver, { timed: true });
		driver.result = result;
		console.log(
			[
				driver.id,
				result.build,
				result.run ?? '-',
				result.native ?? '-',
				String(result.equal ?? '-'),
				String(result.stableAcrossRuns ?? '-'),
				medianMs?.toFixed(1) ?? '-',
				spreadMs ? `${spreadMs[0].toFixed(1)}..${spreadMs[1].toFixed(1)}` : '-'
			].join('\t')
		);
		if (result.error) console.error(`${driver.id}: ${result.error.split('\n')[0]}`);
	}
	if (record) writeFileSync(manifestFile, JSON.stringify(manifest, null, '\t') + '\n');
}
