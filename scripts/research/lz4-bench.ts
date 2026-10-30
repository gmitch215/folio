import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { researchEnvironment } from './environment.ts';

const root = new URL('../../', import.meta.url).pathname;
const [output, roundsArg = '9', filesArg = '32', megabytesArg = '4', variant = 'slots'] =
	process.argv.slice(2);
if (!output || !['slots', 'padded', 'all'].includes(variant))
	throw new Error('usage: lz4-bench.ts OUTPUT.jsonl [ROUNDS] [FILES] [MIB] [slots|padded|all]');
const rounds = Number(roundsArg),
	files = Number(filesArg),
	size = Number(megabytesArg) * 1048576,
	width = 8,
	warmups = 2;
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

// a slot holds LZ4_compressBound of one input, rounded up to 4 KiB; lz4-build.ts bakes the same sizes
const slot = Math.ceil((size + Math.floor(size / 255) + 16) / 4096) * 4096;
const label = ({ 4194304: '4m', 262144: '256k', 65536: '64k' } as Record<number, string>)[size];
if (variant !== 'all' && !label) throw new Error('slot builds exist for 4 MiB, 256 KiB and 64 KiB');
const name = variant === 'all' ? 'lz4-compress-all' : `lz4-compress-${variant}-${label}`;
// the padded entry keeps each size in its own 32-byte granule
const sizeStride = variant === 'padded' ? 32 : 4;
const bytes = new Uint8Array(readFileSync(join(root, `build/research/lz4/${name}.wasm`)));
const entry = variant === 'all' ? 'compress_all' : 'compress_slots';

// seeded pseudo-text: a fixed vocabulary drawn with a skew, about 2x to 3x compressible
const rng = (seed: number) => {
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
const textInput = (index: number) => {
	const next = rng(Math.imul(index + 1, 2654435761) ^ 0x9e3779b9);
	const data = new Uint8Array(size);
	let at = 0;
	while (at < size) {
		const word = vocabulary[Math.floor(Math.min(next(), next()) * vocabulary.length)]!;
		for (let i = 0; i < word.length && at < size; i++) data[at++] = word.charCodeAt(i);
		if (at < size) data[at++] = 32;
	}
	return data;
};
const inputs = Array.from({ length: files }, (_, index) => textInput(index));

const BASE = 1 << 20,
	table = BASE,
	out = BASE + 65536,
	sizes = out + files * slot,
	sizesEnd = sizes + sizeStride * files,
	DATA = Math.ceil(sizesEnd / 65536) * 65536 + 65536;
const pagesAll = Math.ceil((DATA + files * (size + 64)) / 65536) + 2;
const place = (memory: WebAssembly.Memory) => {
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer, table, 2 * files);
	let at = DATA;
	inputs.forEach((data, i) => {
		view.set(data, at);
		words[2 * i] = at;
		words[2 * i + 1] = size;
		at += size + 64;
	});
};
const call = (fn: CallableFunction) =>
	variant === 'all' ? fn(table, files, out, slot) : fn(table, files, out);
const sizesOf = (memory: WebAssembly.Memory) => {
	const words = new Uint32Array(memory.buffer.slice(sizes, sizesEnd));
	return Array.from({ length: files }, (_, i) => words[(i * sizeStride) / 4]!);
};
const sha = (memory: WebAssembly.Memory) => {
	const hash = createHash('sha256');
	const sized = sizesOf(memory);
	hash.update(new Uint8Array(memory.buffer.slice(sizes, sizesEnd)));
	for (let i = 0; i < files; i++)
		hash.update(new Uint8Array(memory.buffer, out + i * slot, sized[i]));
	return hash.digest('hex');
};
const sizeTotal = (memory: WebAssembly.Memory) => sizesOf(memory).reduce((a, b) => a + b, 0);

// the LZ4 block format decoder, a Node-side reference for the round trip
function lz4Decode(src: Uint8Array, length: number) {
	const dst = new Uint8Array(length);
	let s = 0,
		d = 0;
	while (s < src.length) {
		const token = src[s++]!;
		let literals = token >> 4;
		if (literals === 15) for (let b = 255; b === 255; literals += b) b = src[s++]!;
		dst.set(src.subarray(s, s + literals), d);
		s += literals;
		d += literals;
		if (s >= src.length) break;
		const offset = src[s]! | (src[s + 1]! << 8);
		s += 2;
		let match = token & 15;
		if (match === 15) for (let b = 255; b === 255; match += b) b = src[s++]!;
		match += 4;
		assert.ok(offset > 0 && offset <= d, 'bad match offset');
		for (let i = 0; i < match; i++, d++) dst[d] = dst[d - offset]!;
	}
	assert.equal(d, length, 'decoded length');
	return dst;
}

const nativeMemory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
const native = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
	env: { memory: nativeMemory }
}).exports[entry] as CallableFunction;
const nativeRun = () => {
	place(nativeMemory);
	return call(native);
};
const nativeTotal = nativeRun();
const expected = sha(nativeMemory);
if (variant === 'all') assert.equal(nativeTotal, sizeTotal(nativeMemory), 'returned total');
else assert.equal(nativeTotal, files, 'returned count');

// round trip: every input comes back from the serial run's slots
{
	const sized = sizesOf(nativeMemory);
	for (let i = 0; i < files; i++) {
		const packed = new Uint8Array(nativeMemory.buffer, out + i * slot, sized[i]);
		assert.ok(sized[i]! > 0 && sized[i]! < size, `input ${i} did not compress`);
		assert.deepEqual(lz4Decode(packed, size), inputs[i], `round trip of input ${i}`);
	}
}

// the deepest stack one call uses: fill the stack zone, run one input, find the lowest byte changed
const stackDepth = () => {
	const parsed = binaryen.readBinary(bytes);
	const text = parsed.emitText();
	parsed.dispose();
	const top = Number(
		/\(global \$__stack_pointer \(mut i32\) \(i32\.const (\d+)\)\)/.exec(text)![1]
	);
	const memory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
	const fn = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports[
		entry
	] as CallableFunction;
	let deepest = 0;
	for (const fill of [0xa5, 0x5a]) {
		const view = new Uint8Array(memory.buffer);
		view.fill(fill, 0, top);
		const words = new Uint32Array(memory.buffer, table, 2);
		view.set(inputs[0]!, DATA);
		words.set([DATA, size]);
		if (variant === 'all') fn(table, 1, out, slot);
		else fn(table, 1, out);
		let low = 0;
		while (low < top && view[low] === fill) low++;
		deepest = Math.max(deepest, top - low);
	}
	return { stackTop: top, deepestBytes: deepest };
};

const route = prepare(bytes).iterationRoute!;
const { module: _module, ...routeFacts } = route as unknown as Record<string, unknown>;
emit({
	...researchEnvironment({ rounds, files, mebibytes: size / 1048576, width, variant }),
	wasmSha256: createHash('sha256').update(bytes).digest('hex'),
	outputSha256: expected,
	slotBytes: slot,
	compressedBytes: sizeTotal(nativeMemory),
	ratio: (files * size) / sizeTotal(nativeMemory),
	roundTrip: true,
	stack: stackDepth(),
	iterationRoute: routeFacts
});

type Arm = {
	name: string;
	open: () => Promise<{
		run: () => Promise<void>;
		info: () => object;
		close: () => Promise<void>;
	}>;
};
const folioArm = (armName: string, memoryOf: () => WebAssembly.Memory, shared: boolean): Arm => ({
	name: armName,
	open: async () => {
		const memory = memoryOf();
		const pool = shared
			? await Folio.open(bytes, { memory, workers: width })
			: await Folio.open(bytes, { imports: { env: { memory } }, workers: width });
		let report: any;
		return {
			run: async () => {
				place(pool.memory);
				report = await pool.run(
					entry,
					variant === 'all' ? [table, files, out, slot] : [table, files, out]
				);
				assert.equal(sha(pool.memory), expected, `${armName} output differs`);
				if (variant === 'all')
					assert.equal(report.result ?? sizeTotal(pool.memory), nativeTotal);
			},
			info: () => ({
				mode: report?.mode,
				extraction: report?.extraction,
				workers: report?.workers,
				regions: report?.regions,
				replayed: report?.replayed,
				fallbacks: report?.fallbacks,
				reason: report?.reason,
				serial: report?.iteration?.serial,
				stopped: report?.iteration?.stopped,
				admission: report?.iteration?.admission,
				dispatchMs: report?.iteration?.dispatchMs,
				validationMs: report?.iteration?.validationMs,
				workerRunMs: report?.iteration?.workerRunMs,
				exhausted: report?.iteration?.exhausted,
				undoEntries: report?.iteration?.undoEntries,
				conflicts: report?.iteration?.conflicts
			}),
			close: () => pool.close()
		};
	}
});
// ponytail: no explicit TaskPool arm; it needs a worker file with a per-input LZ4 context like blake3-worker.ts
const arms = [
	folioArm(
		'default',
		() => new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll }),
		false
	),
	folioArm(
		'automatic',
		() => new WebAssembly.Memory({ initial: pagesAll, maximum: 65536, shared: true }),
		true
	)
];
for (const arm of arms) {
	let open: Awaited<ReturnType<Arm['open']>>;
	try {
		open = await arm.open();
	} catch (error) {
		emit({ kind: 'refused', case: arm.name, error: String(error).split('\n')[0] });
		continue;
	}
	try {
		for (let round = -warmups; round < rounds; round++) {
			const order = round % 2 ? ['arm', 'native'] : ['native', 'arm'];
			for (const which of order) {
				const cpu = process.cpuUsage(),
					start = performance.now();
				if (which === 'native') {
					nativeRun();
					assert.equal(sha(nativeMemory), expected, 'native output differs');
				} else await open.run();
				const wallMs = performance.now() - start,
					used = process.cpuUsage(cpu);
				if (round >= 0)
					emit({
						kind: 'sample',
						case: arm.name,
						arm: which === 'native' ? 'native' : arm.name,
						round,
						wallMs,
						cpuMs: (used.user + used.system) / 1000,
						load: loadavg(),
						outputSha256: expected,
						passed: true,
						...(which === 'native' ? {} : { report: open.info() })
					});
			}
		}
	} finally {
		await open.close();
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
}
emit({ kind: 'closed', complete: true });
console.log('done', output);
