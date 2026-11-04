import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { predictEnd, probeAffine } from '../../src/affine.ts';
import { buildMiniz, buildSubjects } from './affine-build.ts';
import { checkLoop, refusalOf } from './loop-check.ts';

const target = process.argv[2];
if (!target) throw new Error('usage: loop-census.ts OUTPUT_JSON');
assert.ok(!existsSync(target), `refusing to overwrite ${target}`);

const paths = buildSubjects();
const miniz = buildMiniz();
if (miniz) paths['miniz-crc32'] = miniz;
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
const rows: object[] = [];

const memoryOf = (bytes: Uint8Array<ArrayBuffer>, entry: string) => {
	const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as Record<
		string,
		any
	>;
	return { update: exports[entry] as Function, memory: exports.memory as WebAssembly.Memory };
};

for (const [name, path] of Object.entries(paths)) {
	const bytes = new Uint8Array(readFileSync(path));
	const entry =
		name === 'miniz-crc32'
			? Object.keys(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports).find(
					(e) => e !== 'memory'
				)!
			: name;
	const reason = refusalOf(bytes, entry);
	const row: Record<string, unknown> = {
		name,
		entry,
		certified: !reason,
		reason: reason ?? null
	};
	if (!reason) {
		const { model, conditioning } = checkLoop(bytes, entry);
		row.conditioning = conditioning.toString(16);
		const sampled = probeAffine(bytes, entry);
		row.operatorEqualsSampled =
			sampled.kind === 'model' &&
			Array.isArray(sampled.operator) &&
			Array.isArray(model.operator) &&
			sampled.operator.length === model.operator.length &&
			sampled.operator.every((v: bigint, k: number) => v === (model.operator as bigint[])[k]);
		const { update, memory } = memoryOf(bytes, entry);
		memory.grow(5);
		const input = new Uint8Array(memory.buffer, 1024, 262144);
		for (let i = 0; i < input.length; i++)
			input[i] = (Math.imul(i, 2654435761) ^ (i >>> 8)) & 255;
		let comparisons = 0;
		for (const length of [0, 1, 2, 31, 257, 65537, 262144]) {
			for (const initial of [0, 1, 0x80000000, 0xffffffff]) {
				const serial = BigInt(update(initial | 0, 1024, length) >>> 0);
				for (const width of [1, 2, 4, 8]) {
					let combined = BigInt(initial >>> 0);
					for (let k = 0; k < width; k++) {
						const from = Math.floor((k * length) / width);
						const to = Math.floor(((k + 1) * length) / width);
						const offset = BigInt(update(0, 1024 + from, to - from) >>> 0);
						combined = predictEnd(model, combined, to - from, offset);
					}
					assert.equal(combined, serial, `${name} length ${length} width ${width}`);
					comparisons++;
				}
			}
		}
		row.comparisons = comparisons;
	}
	rows.push(row);
}

// negative controls on the real crc32c module
const crc = new Uint8Array(readFileSync(paths.crc32c!));
const negatives: object[] = [];
const mutate = (label: string, edit: (text: string) => string) => {
	const mod = binaryen.readBinary(crc);
	mod.setFeatures(binaryen.Features.All & ~compact);
	const text = edit(mod.emitText());
	mod.dispose();
	const parsed = binaryen.parseText(text);
	parsed.setFeatures(binaryen.Features.All & ~compact);
	const bytes = Uint8Array.from(parsed.emitBinary());
	parsed.dispose();
	new WebAssembly.Module(bytes);
	negatives.push({ label, refusal: refusalOf(bytes, 'crc32c') ?? 'ACCEPTED' });
};
mutate('post conditioning removed', (t) => {
	const marker = `  (local.set $0\n    (i32.xor\n     (local.get $0)\n     (i32.const -1)\n    )\n   )\n  )\n  (local.get $0)`;
	assert.ok(t.includes(marker));
	return t.replace(marker, '  )\n  (local.get $0)');
});
mutate('post conditioning uses another constant', (t) => {
	const marker = `   (local.set $0\n    (i32.xor\n     (local.get $0)\n     (i32.const -1)\n    )\n   )\n  )\n  (local.get $0)`;
	assert.ok(t.includes(marker));
	return t.replace(marker, marker.replace('-1', '-2'));
});
writeFileSync(
	target,
	JSON.stringify(
		{ kind: 'real-loop-certification-spike', node: process.version, rows, negatives },
		null,
		2
	) + '\n',
	{ flag: 'wx' }
);
for (const r of rows as any[])
	console.log(
		r.name,
		r.certified
			? `CERTIFIED op=${r.operatorEqualsSampled} cmp=${r.comparisons}`
			: `refused: ${r.reason}`
	);
for (const n of negatives as any[]) console.log('negative', n.label, '->', n.refusal);
