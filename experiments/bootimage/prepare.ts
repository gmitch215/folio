import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { bundleFit } from '../consumer/plan.ts';
import { pagesChecksum } from './checksum.ts';
import { emptyMiB, maximumPages, moduleOf, pagesOf } from './plan.ts';

const root = new URL('../../', import.meta.url);
const out = new URL('build/', import.meta.url);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const recorded: Record<string, { bytes: number; sha256: string }> = JSON.parse(
	readFileSync(new URL('hashes.json', import.meta.url), 'utf8')
);

const leb = (value: number) => {
	const bytes: number[] = [];
	do {
		const low = value & 127;
		value = Math.floor(value / 128);
		bytes.push(value ? low | 128 : low);
	} while (value);
	return bytes;
};
const text = (value: string) => [value.length, ...new TextEncoder().encode(value)];
const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];
const header = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];

/** A module that imports env.memory with a minimum of one page and does nothing else. */
export const importModule = () =>
	new Uint8Array([...header, ...section(2, [1, ...text('env'), ...text('memory'), 2, 0, 1])]);

/** A module that declares its own memory of the given size and exports it. */
export const ownModule = (pages: number) =>
	new Uint8Array([
		...header,
		...section(5, [1, 1, ...leb(pages), ...leb(maximumPages)]),
		...section(7, [1, ...text('memory'), 2, 0])
	]);

/** Instantiates a module over fresh stubs and returns the checksum of the check pages. */
export function localChecksum(bytes: Uint8Array, pages: number) {
	const module = new WebAssembly.Module(bytes as BufferSource);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: maximumPages });
	const imports: Record<string, Record<string, unknown>> = {};
	for (const item of WebAssembly.Module.imports(module))
		(imports[item.module] ??= {})[item.name] = item.kind === 'memory' ? memory : () => 0;
	new WebAssembly.Instance(module, imports as WebAssembly.Imports);
	return { checksum: pagesChecksum(memory.buffer), memoryBytes: memory.buffer.byteLength };
}

/** Stages the three modules after checking each against its recorded hash, and the empty-memory modules. */
export function stage() {
	mkdirSync(out, { recursive: true });
	const sources = {
		original: new URL('experiments/consumer/build/php/php.wasm', root).pathname,
		boot: new URL('build/bootimage/baked-boot.wasm', root).pathname,
		render: new URL('build/bootimage/baked-render.wasm', root).pathname
	};
	const expected: Record<string, { bytes: number; checksum: number; memoryBytes: number }> = {};
	for (const [name, path] of Object.entries(sources)) {
		const bytes = readFileSync(path);
		assert.equal(bytes.length, recorded[name]!.bytes, `${name}: size differs from the record`);
		assert.equal(
			sha256(bytes),
			recorded[name]!.sha256,
			`${name}: hash differs from the record`
		);
		writeFileSync(new URL(`${name}.wasm`, out), bytes);
		expected[name] = {
			bytes: bytes.length,
			...localChecksum(bytes, pagesOf[name as keyof typeof pagesOf])
		};
	}
	const sums = Object.values(expected).map((row) => row.checksum);
	assert.equal(new Set(sums).size, 3, 'the check pages do not tell the variants apart');
	writeFileSync(new URL('imp.wasm', out), importModule());
	for (const mib of emptyMiB) writeFileSync(new URL(`own${mib}.wasm`, out), ownModule(mib * 16));
	for (const file of ['imp', ...emptyMiB.map((mib) => `own${mib}`)])
		assert.ok(
			WebAssembly.validate(readFileSync(new URL(`${file}.wasm`, out))),
			`${file} invalid`
		);
	writeFileSync(new URL('expected.json', out), `${JSON.stringify(expected, null, '\t')}\n`);
	return expected;
}

if (import.meta.main) {
	const expected = stage();
	console.log(
		JSON.stringify({
			expected,
			bundles: Object.fromEntries(
				Object.entries(moduleOf).map(([variant, name]) => [
					variant,
					bundleFit({ [name]: expected[name]!.bytes })
				])
			)
		})
	);
}
