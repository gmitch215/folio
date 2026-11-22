import assert from 'node:assert/strict';
import { test } from 'vitest';
import { governGrowth } from '../../src/growth-governor.ts';

const PAGE = 65536;
const memoryOf = (initial = 1, maximum = 16) => new WebAssembly.Memory({ initial, maximum });

test('grow under the cap succeeds and returns the old page count', () => {
	const memory = memoryOf();
	const governor = governGrowth(memory, { capBytes: 4 * PAGE });
	assert.equal(memory.grow(2), 1);
	assert.equal(memory.buffer.byteLength, 3 * PAGE);
	assert.equal(governor.refused, 0);
	governor.restore();
});

test('grow past the cap throws RangeError, counts the refusal and leaves the size alone', () => {
	const memory = memoryOf();
	const seen: { fromBytes: number; toBytes: number }[] = [];
	const governor = governGrowth(memory, {
		capBytes: 4 * PAGE,
		onRefuse: (info) => seen.push(info)
	});
	assert.throws(() => memory.grow(4), RangeError);
	assert.equal(governor.refused, 1);
	assert.deepEqual(seen, [{ fromBytes: PAGE, toBytes: 5 * PAGE }]);
	assert.equal(memory.buffer.byteLength, PAGE);
	governor.restore();
});

test('grow that lands exactly on the cap succeeds', () => {
	const memory = memoryOf();
	const governor = governGrowth(memory, { capBytes: 3 * PAGE });
	assert.equal(memory.grow(2), 1);
	assert.equal(memory.buffer.byteLength, 3 * PAGE);
	assert.equal(governor.refused, 0);
	assert.throws(() => memory.grow(1), RangeError);
	assert.equal(governor.refused, 1);
	governor.restore();
});

test('a cap below the current size refuses every grow', () => {
	const memory = memoryOf(2);
	const governor = governGrowth(memory, { capBytes: PAGE });
	assert.throws(() => memory.grow(0), RangeError);
	assert.throws(() => memory.grow(1), RangeError);
	assert.equal(governor.refused, 2);
	governor.restore();
});

test('a fractional page count is truncated the way native grow truncates it', () => {
	const memory = memoryOf();
	const governor = governGrowth(memory, { capBytes: 2 * PAGE });
	assert.equal(memory.grow(1.5), 1);
	assert.equal(memory.buffer.byteLength, 2 * PAGE);
	assert.equal(governor.refused, 0);
	governor.restore();
});

test('restore returns native grow behaviour', () => {
	const memory = memoryOf();
	const governor = governGrowth(memory, { capBytes: PAGE });
	governor.restore();
	assert.equal(Object.hasOwn(memory, 'grow'), false);
	assert.equal(memory.grow(3), 1);
	assert.equal(memory.buffer.byteLength, 4 * PAGE);
	assert.equal(governor.refused, 0);
});

test('restore is idempotent', () => {
	const memory = memoryOf();
	const governor = governGrowth(memory, { capBytes: PAGE });
	governor.restore();
	governor.restore();
	assert.equal(Object.hasOwn(memory, 'grow'), false);
});

test('invalid caps throw RangeError and install nothing', () => {
	for (const capBytes of [0, -PAGE, 1.5, NaN, Infinity, -Infinity]) {
		const memory = memoryOf();
		assert.throws(() => governGrowth(memory, { capBytes }), RangeError, `cap ${capBytes}`);
		assert.equal(Object.hasOwn(memory, 'grow'), false);
	}
});

test('stacked governors both apply, and restore runs in reverse install order', () => {
	const memory = memoryOf();
	const outer = governGrowth(memory, { capBytes: 4 * PAGE });
	const inner = governGrowth(memory, { capBytes: 2 * PAGE });

	assert.throws(() => memory.grow(2), RangeError);
	assert.equal(inner.refused, 1);
	assert.equal(outer.refused, 0);

	assert.equal(memory.grow(1), 1);
	assert.throws(() => memory.grow(2), RangeError);
	assert.equal(inner.refused, 2);

	assert.throws(() => outer.restore(), /reverse install order/);
	assert.throws(() => memory.grow(2), RangeError);
	assert.equal(outer.refused, 0);

	inner.restore();
	assert.equal(memory.grow(2), 2);
	assert.throws(() => memory.grow(1), RangeError);
	assert.equal(outer.refused, 1);

	outer.restore();
	assert.equal(Object.hasOwn(memory, 'grow'), false);
	assert.equal(memory.grow(2), 4);
});
