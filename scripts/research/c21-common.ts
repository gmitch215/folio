import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layoutOf, outDir, specs, type Layout, type Spec } from './c21-kernels.ts';

export interface Record_ {
	input: Uint8Array;
	aux: Uint8Array;
}

export const hostMath = () => ({
	sin: Math.sin,
	cos: Math.cos,
	floor: Math.floor,
	sqrt: Math.sqrt,
	log2: Math.log2
});

export const moduleBytes = (spec: Spec) =>
	new Uint8Array(readFileSync(join(outDir, `${spec.id}.wasm`)));

export const specOf = (id: string) => {
	const spec = specs.find((item) => item.id === id);
	if (!spec) throw new Error(`unknown spec ${id}`);
	return spec;
};

/** Writes a record set into a memory at a layout. `sequential` makes every record share the arena and config. */
export function writeRecords(
	memory: WebAssembly.Memory,
	spec: Spec,
	layout: Layout,
	records: Record_[],
	sequential = false
) {
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer, layout.table, 4 * records.length);
	let at = layout.data;
	records.forEach((record, i) => {
		view.set(record.input, at);
		view.set(record.aux, layout.aux + i * spec.auxBytes);
		words[4 * i] = at;
		words[4 * i + 1] = record.input.length;
		const configAt =
			layout.config + (spec.config?.perRecord && !sequential ? i * spec.config.stride : 0);
		words[4 * i + 2] = spec.config
			? configAt
			: spec.auxBytes
				? layout.aux + i * spec.auxBytes
				: 0;
		words[4 * i + 3] = spec.arena ? layout.arena + (sequential ? 0 : i * spec.arena) : 0;
		at += Math.ceil((record.input.length + 32) / 32) * 32;
	});
}

export const clearOutput = (memory: WebAssembly.Memory, spec: Spec, layout: Layout, n: number) =>
	new Uint8Array(memory.buffer).fill(0, layout.out, layout.out + n * spec.slot);

export const outputOf = (memory: WebAssembly.Memory, spec: Spec, layout: Layout, n: number) =>
	new Uint8Array(memory.buffer, layout.out, n * spec.slot);

/** Runs a spec serially on its own memory and returns the record inputs a decoder needs. */
export function instantiate(spec: Spec, layout: Layout, shared = false) {
	const memory = new WebAssembly.Memory({
		initial: layout.pages,
		maximum: shared ? 65536 : layout.pages,
		shared
	});
	const instance = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes(spec)), {
		env: { memory, ...hostMath() }
	});
	return { memory, exports: instance.exports as Record<string, CallableFunction> };
}

// C21_MIXED=1 cuts these programs' records to 1, 1/2, 1/4, 1/8 or 1/16 of their size in a fixed pattern
const mixable = new Set([
	'xxhash32',
	'xxhash64',
	'xxhash3',
	'miniz-adler32',
	'miniz-crc32',
	'sha256',
	'sha1',
	'md5'
]);
const mixedLength = (id: string, index: number, length: number) =>
	process.env.C21_MIXED === '1' && mixable.has(id)
		? Math.max(64, (Math.floor(length / [1, 2, 4, 8, 16][(index * 7 + 3) % 5]!) >> 4) << 4)
		: length;

export function recordsOf(spec: Spec, n = spec.n): Record_[] {
	const makeAux = spec.makeAux ?? (() => new Uint8Array(0));
	if (!spec.from) {
		const make = spec.makeInput ?? (() => new Uint8Array(0));
		return Array.from({ length: n }, (_, i) => {
			const input = make(i);
			return {
				input: input.slice(0, mixedLength(spec.id, i, input.length)),
				aux: makeAux(i)
			};
		});
	}
	const sibling = specOf(spec.from);
	const source = recordsOf(sibling, n);
	const layout = layoutOf(
		sibling,
		n,
		source.map((r) => r.input.length)
	);
	const { memory, exports } = instantiate(sibling, layout);
	if (sibling.config)
		exports.setup!(layout.config, sibling.config.perRecord ? n : 1, sibling.config.nfft);
	writeRecords(memory, sibling, layout, source);
	exports.bulk!(layout.table, n, layout.out);
	const out = outputOf(memory, sibling, layout, n);
	const wordAt = spec.from === 'miniz-compress' ? 1 : 0;
	return source.map((record, i) => {
		const at = i * sibling.slot;
		const length = new Uint32Array(out.buffer, out.byteOffset + at, 8)[wordAt]!;
		if (!length || length > sibling.slot - 32)
			throw new Error(`${sibling.id} record ${i} length ${length}`);
		return { input: out.slice(at + 32, at + 32 + length), aux: makeAux(i) };
	});
}
