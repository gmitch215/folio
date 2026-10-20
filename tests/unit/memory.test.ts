import assert from 'node:assert/strict';
import { test } from 'vitest';
import { memoryImports } from '../../src/memory.ts';
import { numberBits, restoreNumbers } from '../../src/values.ts';

const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const name = (value: string) => [value.length, ...Buffer.from(value)];
const entry = (module: string, field: string, ...kind: number[]) => [
	...name(module),
	...name(field),
	...kind
];
const section = (id: number, ...content: number[]) => [id, content.length, ...content];
const module = (...imports: number[][]) =>
	Uint8Array.from([...header, ...section(2, imports.length, ...imports.flat())]);

test('reads memory limits past function, table, global and tag imports', () => {
	const bytes = module(
		entry('env', 'fn', 0, 3),
		entry('env', 'table', 1, 0x70, 0, 1),
		entry('env', 'bounded', 1, 0x70, 1, 1, 4),
		entry('env', 'ref', 3, 0x63, 0x05, 0),
		entry('env', 'global', 3, 0x7f, 0),
		entry('env', 'tag', 4, 0, 2),
		entry('env', 'memory', 2, 3, 2, 8),
		entry('env', 'wide', 2, 4, 1)
	);
	assert.deepEqual(memoryImports(bytes), [
		{ module: 'env', name: 'memory', initial: 2, maximum: 8, shared: true, memory64: false },
		{
			module: 'env',
			name: 'wide',
			initial: 1,
			maximum: undefined,
			shared: false,
			memory64: true
		}
	]);
});

test('reports no memories for a module without an import section', () => {
	assert.deepEqual(memoryImports(Uint8Array.from([...header, ...section(1, 0)])), []);
	assert.deepEqual(memoryImports(Uint8Array.from(header)), []);
});

test('refuses truncated, oversized and unsupported metadata', () => {
	assert.throws(
		() => memoryImports(Uint8Array.from([...header, 2, 0x10, 1])),
		/truncated wasm section/
	);
	assert.throws(() => memoryImports(Uint8Array.from([...header, 2])), /truncated wasm metadata/);
	assert.throws(
		() => memoryImports(Uint8Array.from([...header, 2, 5, 1, 9, 0x61, 0x62, 0x63])),
		/truncated wasm name/
	);
	assert.throws(
		() => memoryImports(module(entry('a', 'b', 5))),
		/unsupported wasm import metadata/
	);
	assert.throws(
		() => memoryImports(module(entry('a', 'b', 2, 8, 0))),
		/unsupported memory-limit/
	);
	assert.throws(
		() =>
			memoryImports(
				module(entry('a', 'b', 2, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f))
			),
		/precision/
	);
	assert.throws(
		() =>
			memoryImports(
				Uint8Array.from([...header, 2, 12, 1, 1, 0x61, 1, 0x62, 0, ...Array(11).fill(0x80)])
			),
		/invalid wasm integer/
	);
});

test('number bits keep NaN payloads beside the Number value', () => {
	assert.equal(numberBits(1), undefined);
	assert.equal(numberBits('text'), undefined);
	assert.equal(typeof numberBits(Number.NaN), 'bigint');
	assert.deepEqual(numberBits([1, 2]), undefined);
	const mixed = numberBits([1, Number.NaN]);
	assert.ok(Array.isArray(mixed));
	assert.equal(mixed[0], undefined);
	assert.equal(typeof mixed[1], 'bigint');
});

test('restoring number bits rebuilds scalars and replaces only the encoded array slots', () => {
	const payload = 0x7ff8000000000123n;
	assert.ok(Number.isNaN(restoreNumbers(0, payload) as number));
	const restored = restoreNumbers([7, 0], [undefined, payload]) as number[];
	assert.equal(restored[0], 7);
	assert.ok(Number.isNaN(restored[1]));
});
