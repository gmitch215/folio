import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { predictEnd } from '../../src/affine.ts';
import { clang, env } from './affine-build.ts';
import { checkStream, toSharedImport } from './stream-check.ts';

// usage: summary-certify.ts OUTPUT_DIRECTORY ; writes stream.wasm and certificate.json there
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('usage: summary-certify.ts OUTPUT_DIRECTORY');
for (const name of ['stream.wasm', 'certificate.json'])
	if (existsSync(join(outputDirectory, name)))
		throw new Error(`refusing to overwrite ${join(outputDirectory, name)}`);

const directory = await mkdtemp(join(tmpdir(), 'folio-check-stream-'));
const output = join(directory, 'stream.wasm');
execFileSync(
	clang,
	[
		'--target=wasm32',
		'-O2',
		'-g0',
		'-ffreestanding',
		'-fno-builtin',
		'-nostdlib',
		new URL('./cases/affine/stream.c', import.meta.url).pathname,
		'-o',
		output,
		'-Wl,--no-entry,--export-memory,--export=update,--export=transition,--initial-memory=131072,--max-memory=536870912'
	],
	{ env }
);
const bytes = await readFile(output);
const { model, evidence, guardInput } = checkStream(bytes);
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'stream.wasm'), bytes, { flag: 'wx' });
const sharedBytes = toSharedImport(bytes);
const sharedCheck = checkStream(sharedBytes, 'update', 'transition', { sharedImport: true });
assert.deepEqual(sharedCheck.model.operator, model.operator);
assert.throws(() => checkStream(sharedBytes));
assert.throws(() => checkStream(bytes, 'update', 'transition', { sharedImport: true }));
assert.equal(guardInput(131072, 0, 131072), true);
assert.equal(guardInput(131072, 131072, 0), true);
assert.equal(guardInput(131072, -1, 2), false);
assert.equal(guardInput(131072, 131071, 2), false);
assert.equal(guardInput(131072, 0, -1), false);
assert.throws(() => {
	model.layout.ptr = 0;
}, TypeError);
assert.throws(() => {
	(model.operator as bigint[])[0] = 0n;
}, TypeError);
const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as Record<
	string,
	any
>;
const memory = exports.memory as WebAssembly.Memory;
memory.grow(5);
const input = new Uint8Array(memory.buffer, 1024, 262144);
for (let i = 0; i < input.length; i++) input[i] = (Math.imul(i, 2654435761) ^ (i >>> 8)) & 255;
let comparisons = 0;
for (const length of [0, 1, 2, 31, 257, 65537, 262144]) {
	for (const initial of [0n, 1n, 0x80000000n, 0xffffffffn]) {
		const serial = BigInt(exports.update(Number(initial), 1024, length) >>> 0);
		for (const width of [1, 2, 4, 8]) {
			let combined = initial;
			for (let k = 0; k < width; k++) {
				const from = Math.floor((k * length) / width),
					to = Math.floor(((k + 1) * length) / width);
				const offset = BigInt(exports.update(0, 1024 + from, to - from) >>> 0);
				combined = predictEnd(model, combined, to - from, offset);
			}
			assert.equal(combined, serial);
			comparisons++;
		}
	}
}
const negatives: object[] = [];
for (const name of [
	'call-finalization',
	'hidden-global',
	'extra-output',
	'nonlinear-step',
	'active-data'
]) {
	const bad = binaryen.readBinary(bytes);
	const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
	bad.setFeatures(binaryen.Features.All & ~compact);
	if (name === 'active-data') {
		const text = bad.emitText();
		bad.dispose();
		const initialized = binaryen.parseText(
			text.replace('(memory $0 2 8192)', '(memory $0 2 8192) (data (i32.const 0) "clobber")')
		);
		const binary = Uint8Array.from(initialized.emitBinary());
		initialized.dispose();
		new WebAssembly.Module(binary);
		assert.throws(() => checkStream(binary));
		negatives.push({ name, status: 'valid-module-refused' });
		continue;
	}
	const target = bad.getFunction(name === 'call-finalization' ? 'update' : 'transition');
	const body = binaryen.getFunctionInfo(target).body;
	let changed: number;
	if (name === 'call-finalization') changed = bad.i32.xor(body, bad.i32.const(1));
	else if (name === 'hidden-global') {
		bad.addGlobal('hidden', binaryen.i32, true, bad.i32.const(0));
		changed = bad.i32.xor(body, bad.global.get('hidden', binaryen.i32));
	} else if (name === 'extra-output')
		changed = bad.block(
			null,
			[bad.i32.store(0, 4, bad.i32.const(65536), bad.i32.const(123)), body],
			binaryen.i32
		);
	else changed = bad.i32.mul(body, bad.local.get(0, binaryen.i32));
	(binaryen as any)._BinaryenFunctionSetBody(target, changed);
	assert.ok(bad.validate());
	const binary = Uint8Array.from(bad.emitBinary());
	bad.dispose();
	new WebAssembly.Module(binary);
	assert.throws(() => checkStream(binary));
	negatives.push({ name, status: 'valid-module-refused' });
}
await writeFile(
	join(outputDirectory, 'certificate.json'),
	JSON.stringify(
		{
			kind: 'experimental-compiled-wrapper-check',
			node: process.version,
			binary: 'stream.wasm',
			evidence,
			sharedImportEvidence: sharedCheck.evidence,
			comparisons,
			negatives,
			limitations: [
				'single narrow LLVM loop skeleton; not a general loop verifier',
				'checker requires independent review; no proof-assistant/SMT certificate',
				'execution comparisons are untimed'
			]
		},
		null,
		2
	) + '\n'
);
console.log(JSON.stringify({ evidence, comparisons, negatives }));
