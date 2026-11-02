import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeFrame } from '../../src/frames.ts';
import {
	clearRanges,
	decodeRanges,
	encodeRangesFrame,
	escapes,
	FootprintCache,
	maximumRanges,
	RangeSet,
	restoreRanges
} from '../../src/ranges.ts';

test('range sets merge overlapping and touching ranges and reject invalid ones', () => {
	const set = RangeSet.of([
		[20, 5],
		[0, 4],
		[4, 2],
		[3, 1],
		[22, 10],
		[100, 0]
	]);
	assert.deepEqual(set.spans(), [
		[0, 6],
		[20, 12]
	]);
	assert.equal(set.count, 2);
	assert.equal(set.length, 18);
	assert.equal(RangeSet.empty.count, 0);
	for (const bad of [
		[-1, 2],
		[1, -2],
		[1.5, 2],
		[Number.NaN, 2]
	] as [number, number][])
		assert.throws(() => RangeSet.of([bad]), RangeError);
});

test('range sets answer contains, union, subtract, clip and coalesce exactly', () => {
	const set = RangeSet.of([
		[10, 10],
		[40, 10]
	]);
	assert.ok(set.contains(10) && set.contains(19) && !set.contains(20) && !set.contains(9));
	assert.ok(set.contains(10, 10) && !set.contains(10, 11) && !set.contains(15, 30));
	assert.ok(set.contains(0, 0));
	assert.deepEqual(set.union(RangeSet.of([[18, 24]])).spans(), [[10, 40]]);
	assert.deepEqual(set.subtract(RangeSet.of([[15, 30]])).spans(), [
		[10, 5],
		[45, 5]
	]);
	assert.deepEqual(set.subtract(RangeSet.of([[0, 100]])).spans(), []);
	assert.deepEqual(set.subtract(RangeSet.empty).spans(), set.spans());
	assert.deepEqual(RangeSet.empty.subtract(set).spans(), []);
	assert.deepEqual(set.clip(45).spans(), [
		[10, 10],
		[40, 5]
	]);
	assert.deepEqual(set.coalesce(19).spans(), [
		[10, 10],
		[40, 10]
	]);
	assert.deepEqual(set.coalesce(20).spans(), [[10, 40]]);
	assert.deepEqual(
		RangeSet.of([[5, 4]])
			.round(4, 100)
			.spans(),
		[[4, 8]]
	);
	assert.deepEqual(
		RangeSet.of([[5, 3]])
			.round(4, 6)
			.spans(),
		[[4, 2]]
	);
	assert.deepEqual(
		RangeSet.of([[8, 1]])
			.round(4, 7)
			.spans(),
		[]
	);
});

test('range subtraction matches a byte-array model on random sets', () => {
	let state = 7;
	const next = (limit: number) => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return (state >>> 8) % limit;
	};
	const random = () =>
		RangeSet.of(
			Array.from({ length: next(8) }, () => [next(200), next(30)] as [number, number])
		);
	const bytes = (set: RangeSet) => {
		const out = new Uint8Array(260);
		for (const [start, length] of set.spans()) out.fill(1, start, start + length);
		return out;
	};
	for (let i = 0; i < 300; i++) {
		const [a, b] = [random(), random()];
		const [x, y] = [bytes(a), bytes(b)];
		assert.deepEqual(
			bytes(a.subtract(b)),
			x.map((v, k) => (v && !y[k] ? 1 : 0))
		);
		assert.deepEqual(
			bytes(a.union(b)),
			x.map((v, k) => (v || y[k] ? 1 : 0))
		);
		for (let k = 0; k < 260; k += 13) assert.equal(a.contains(k), x[k] === 1);
	}
});

test('escapes are the read bytes outside the shipped ranges', () => {
	const shipped = RangeSet.of([
		[10, 4],
		[100, 4]
	]);
	assert.deepEqual(escapes([12, 11, 12, 13, 14, 99, 100, 7, 8], shipped).spans(), [
		[7, 2],
		[14, 1],
		[99, 1]
	]);
	assert.equal(escapes([], shipped).count, 0);
	assert.equal(escapes([10, 11, 12, 13], shipped).count, 0);
	assert.deepEqual(RangeSet.fromAddresses([3, 1, 2, 2, 9]).spans(), [
		[1, 3],
		[9, 1]
	]);
});

test('the footprint cache keys by export and arguments and evicts the least recently used', () => {
	assert.notEqual(FootprintCache.key('run', [1, 2]), FootprintCache.key('run', [1, 3]));
	assert.notEqual(FootprintCache.key('run', [1]), FootprintCache.key('walk', [1]));
	assert.notEqual(FootprintCache.key('run', [1]), FootprintCache.key('run', [1n]));
	assert.notEqual(FootprintCache.key('run', [1, 2]), FootprintCache.key('run', [12]));
	const cache = new FootprintCache(2);
	const [a, b, c] = ['a', 'b', 'c'];
	cache.learn(a!, RangeSet.of([[0, 4]]));
	cache.learn(b!, RangeSet.of([[8, 4]]));
	assert.deepEqual(cache.get(a!)!.spans(), [[0, 4]]);
	cache.learn(c!, RangeSet.of([[16, 4]]));
	assert.equal(cache.size, 2);
	assert.equal(cache.get(b!), undefined);
	cache.learn(a!, RangeSet.of([[4, 4]]));
	assert.deepEqual(cache.get(a!)!.spans(), [[0, 8]]);
	cache.clear();
	assert.equal(cache.size, 0);
	assert.throws(() => new FootprintCache(0), RangeError);
});

test('a ranges frame carries the clipped, coalesced bytes and round trips through decode and restore', () => {
	const memory = new Uint8Array(131072);
	memory.forEach((_, index) => (memory[index] = (index * 7) & 255));
	const wanted = RangeSet.of([
		[100, 50],
		[4000, 200],
		[131000, 500]
	]);
	const { frame, shipped } = encodeRangesFrame(
		{ session: 's', epoch: 1, sequence: 1 },
		memory,
		wanted
	);
	assert.deepEqual(shipped.spans(), [
		[100, 50],
		[4000, 200],
		[131000, 72]
	]);
	const { header, payload } = decodeFrame<{ ranges: any }>(frame, 1 << 20);
	assert.equal(payload.length, shipped.length + 1);
	const decoded = decodeRanges(header.ranges, payload);
	assert.equal(decoded.memoryBytes, 131072);
	assert.deepEqual(decoded.shipped.spans(), shipped.spans());
	const target = new Uint8Array(131072).fill(9);
	clearRanges(target, RangeSet.of([[0, 131072]]));
	restoreRanges(target, payload, decoded.shipped);
	for (const [start, length] of shipped.spans())
		assert.deepEqual(
			target.subarray(start, start + length),
			memory.subarray(start, start + length)
		);
	assert.equal(target.reduce((sum, byte) => sum + (byte ? 1 : 0), 0) > 0, true);
	assert.equal(target[0], 0);
	assert.equal(target[4200], 0);
	assert.throws(() => encodeRangesFrame({}, new Uint8Array(100), wanted), RangeError);
});

test('a ranges frame with more than the range limit coalesces gaps until it fits', () => {
	const memory = new Uint8Array(65536 * 8);
	const wanted = RangeSet.of(
		Array.from(
			{ length: maximumRanges * 2 },
			(_, index) => [index * 200, 100] as [number, number]
		)
	);
	assert.equal(wanted.count, maximumRanges * 2);
	const { frame, shipped } = encodeRangesFrame({}, memory, wanted);
	assert.ok(shipped.count <= maximumRanges);
	assert.ok(wanted.subtract(shipped).count === 0);
	const { header, payload } = decodeFrame<{ ranges: any }>(frame, 1 << 24);
	assert.equal(decodeRanges(header.ranges, payload).shipped.length, shipped.length);
});

test('decoding rejects ranges that are unsorted, overlapping, outside memory or out of step with the payload', () => {
	const payload = (length: number) => new Uint8Array(length + 1);
	const ok = { memoryBytes: 65536, spans: [0, 4, 8, 4] };
	assert.deepEqual(decodeRanges(ok, payload(8)).shipped.spans(), [
		[0, 4],
		[8, 4]
	]);
	assert.deepEqual(
		decodeRanges({ memoryBytes: 65536, spans: [] }, payload(0)).shipped.spans(),
		[]
	);
	for (const [header, length] of [
		[undefined, 0],
		[{ ...ok, spans: [8, 4, 0, 4] }, 8],
		[{ ...ok, spans: [0, 4, 2, 4] }, 8],
		[{ ...ok, spans: [65534, 4] }, 4],
		[{ ...ok, spans: [0, 0] }, 0],
		[{ ...ok, spans: [0, 1.5] }, 1],
		[{ ...ok, spans: [0, 4, 8] }, 4],
		[{ ...ok, memoryBytes: 100 }, 8],
		[{ ...ok, spans: 'x' }, 8],
		[ok, 7],
		[ok, 9]
	] as const)
		assert.throws(() => decodeRanges(header as any, payload(length)), TypeError);
});
