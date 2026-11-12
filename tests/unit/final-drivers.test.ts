import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
	buildWasm,
	combined,
	layoutOf,
	loadWasm,
	newMemory,
	orderInvariance,
	readManifest,
	runWasm,
	verifyDigests,
	type Driver
} from '../../scripts/research/final-cases/build-drivers.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = readManifest();
const drivers = manifest.projects.flatMap((project) => project.drivers);
const byId = (id: string): Driver => {
	const driver = drivers.find((item) => item.id === id);
	if (!driver) throw new Error(`no driver ${id}`);
	return driver;
};

// stale-by-mtime, as tests/setup.ts does for fixtures: the stb module compiles stb_image.h, so reuse it while no input is newer.
function newestInput(driver: Driver): number {
	const project = manifest.projects.find((item) => item.drivers.includes(driver));
	if (!project) throw new Error(`no project for ${driver.id}`);
	const dirs = [
		join(root, 'scripts/research/final-cases/upstream', project.id),
		join(root, 'scripts/research/final-cases/shim'),
		join(root, 'scripts/research/final-cases/drivers'),
		join(root, 'scripts/research/final-cases/config')
	];
	let newest = statSync(join(root, driver.sourceFile)).mtimeMs;
	for (const dir of dirs)
		for (const entry of readdirSync(dir, { recursive: true }) as string[])
			newest = Math.max(newest, statSync(join(dir, entry)).mtimeMs);
	return newest;
}

async function cachedWasm(driver: Driver, dir: string): Promise<string> {
	const wasm = join(dir, 'driver.wasm');
	if (existsSync(wasm) && statSync(wasm).mtimeMs >= newestInput(driver)) return wasm;
	return buildWasm(manifest, driver, dir);
}

describe('final driver manifest', () => {
	test('parses with unique ids, a source file and a record count per driver', () => {
		const ids = drivers.map((driver) => driver.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const driver of drivers) {
			expect(existsSync(join(root, driver.sourceFile)), driver.id).toBe(true);
			expect(driver.records === 64 || driver.records === 128, driver.id).toBe(true);
			expect(driver.slot % 32, driver.id).toBe(0);
		}
	});

	test('the shim and every vendored upstream tree match their digests', () => {
		verifyDigests(manifest);
	});

	test('git keeps the vendored trees byte for byte and prettier skips them', () => {
		const attributes = readFileSync(join(root, '.gitattributes'), 'utf8');
		const ignored = readFileSync(join(root, '.prettierignore'), 'utf8');
		expect(attributes).toMatch(/^scripts\/research\/final-cases\/upstream\/\*\* -text$/m);
		expect(ignored).toMatch(/^scripts\/research\/final-cases\/upstream\/$/m);
	});
});

// two small drivers: one protobuf stream read and one CBOR encoder init.
describe.each(['nanopb-pb_read', 'tinycbor-cbor_encoder_init'])('serial wasm %s', (id) => {
	test('matches the checksum recorded in the manifest', async () => {
		const driver = byId(id);
		expect(driver.result?.build).toBe('PASS');
		const dir = join(root, 'build/research/final', `${id}-test`);
		const wasm = await cachedWasm(driver, dir);
		const run = await runWasm(wasm, driver, 1);
		expect(combined(run.digests)).toBe(driver.result?.wasmSlotsSha256);
	}, 30000);
});

// cjson allocates a small array per record, so each record dirties its own slice.
describe('imported memory and per-record arena slices', () => {
	const id = 'cjson-cJSON_CreateIntArray';
	const driver = byId(id);
	const wasmOf = () => cachedWasm(driver, join(root, 'build/research/final', `${id}-abi`));

	test('every arena is a power of two of at least 64 KiB and memory has room for the final corpus', () => {
		for (const item of drivers)
			for (const size of [item.arena, item.genArena]) {
				expect(size, item.id).toBeGreaterThanOrEqual(65536);
				expect(Number.isInteger(Math.log2(size)), item.id).toBe(true);
			}
		expect(manifest.memory.maximumPages).toBeGreaterThanOrEqual(manifest.memory.initialPages);
	});

	test('the module imports env.memory and exports it again', async () => {
		const module = await WebAssembly.compile(readFileSync(await wasmOf()));
		expect(WebAssembly.Module.imports(module)).toContainEqual({
			module: 'env',
			name: 'memory',
			kind: 'memory'
		});
		expect(WebAssembly.Module.exports(module)).toContainEqual({
			name: 'memory',
			kind: 'memory'
		});
	});

	test('instantiates with an externally created memory and uses it', async () => {
		const memory = newMemory(manifest);
		const loaded = await loadWasm(await wasmOf(), driver, manifest, memory);
		expect(loaded.exports.memory).toBe(memory);
		loaded.bulk(0, driver.records);
		const out = new Uint32Array(memory.buffer, loaded.layout.out, 1);
		expect(out[0]).toBeGreaterThan(0);
	});

	test('the table gives every record its own slice of the arena region', async () => {
		const loaded = await loadWasm(await wasmOf(), driver, manifest);
		const layout = layoutOf(driver, (loaded.exports.__heap_base as WebAssembly.Global).value);
		const words = new Uint32Array(loaded.memory.buffer, layout.table, driver.records * 4);
		const arenas = Array.from({ length: driver.records }, (_, i) => words[i * 4 + 3]!);
		expect(arenas).toEqual(arenas.map((_, i) => layout.arenas + i * driver.arena));
		expect(new Set(arenas).size).toBe(driver.records);
	});

	test('a record allocates only inside its own slice', async () => {
		const loaded = await loadWasm(await wasmOf(), driver, manifest);
		const { layout } = loaded;
		const slice = (i: number) =>
			new Uint8Array(loaded.memory.buffer, layout.arenas + i * driver.arena, driver.arena);
		for (let i = 0; i < driver.records; i++) expect(slice(i).some(Boolean)).toBe(false);
		loaded.bulk(5, 6);
		for (let i = 0; i < driver.records; i++)
			expect(slice(i).some(Boolean), `slice ${i}`).toBe(i === 5);
	});

	test.each([id, 'nanopb-pb_read'])(
		'%s gives serial slots in a shuffled order and in two interleaved halves',
		async (name) => {
			const item = byId(name);
			const wasm = await cachedWasm(
				item,
				join(root, 'build/research/final', `${name}-order`)
			);
			const serial = await runWasm(wasm, item, 1, manifest);
			expect(await orderInvariance(wasm, item, manifest, serial.digests)).toEqual({
				shuffled: true,
				interleaved: true
			});
		},
		30000
	);
});

const closedReasons = [
	'compiled-out',
	'over-cap',
	'needs-context-init',
	'needs-file-api',
	'needs-threads',
	'output-unbounded',
	'no-input-buffer'
];

describe('candidate windows', () => {
	test('each project adapts at most 12 candidates, all from its candidate list, with closed-list skip reasons', () => {
		for (const project of manifest.projects) {
			expect(project.drivers.length, project.id).toBeLessThanOrEqual(12);
			for (const driver of project.drivers)
				expect(project.candidates.candidates, driver.id).toContain(driver.function);
			for (const skip of project.candidates.skipped)
				expect(
					closedReasons.includes(skip.reason) || skip.reason.startsWith('other:'),
					skip.function
				).toBe(true);
		}
	});
});

// mpack: a plain writer; stb: the lexer, which read uninitialised fields before it was zeroed.
describe.each(['mpack-mpack_writer_track_push', 'stb-stb_c_lexer_init'])(
	'serial wasm stability %s',
	(id) => {
		test('three runs agree and match the recorded checksum', async () => {
			const driver = byId(id);
			expect(driver.result?.build).toBe('PASS');
			const dir = join(root, 'build/research/final', `${id}-stability`);
			const wasm = await cachedWasm(driver, dir);
			const run = await runWasm(wasm, driver, 3);
			expect(run.stable).toBe(true);
			expect(combined(run.digests)).toBe(driver.result?.wasmSlotsSha256);
		}, 30000);
	}
);

// batch C: no licence cleared yet, so these projects stay outside the draw pool.
const pendingLicence = ['picohttpparser', 'zstd', 'dr_libs', 'pffft', 'picojpeg'];

describe('batch C licence pending', () => {
	test.each(pendingLicence)('%s is marked pending in the manifest', (id) => {
		const project = manifest.projects.find((item) => item.id === id);
		expect(project?.licence).toBe('pending');
	});

	test.each(pendingLicence)('%s adapts the first candidates in order', (id) => {
		const project = manifest.projects.find((item) => item.id === id);
		if (!project) throw new Error(`no project ${id}`);
		const adapted = project.drivers.map((driver) => driver.function);
		const { candidates, skipped } = project.candidates;
		expect(adapted).toEqual(candidates.slice(0, adapted.length));
		expect(adapted.length).toBe(Math.min(12, candidates.length));
		expect(skipped.map((skip) => skip.function)).toEqual(candidates.slice(adapted.length));
	});
});
