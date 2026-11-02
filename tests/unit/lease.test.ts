import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
	buildManifest,
	Lease,
	LeaseMismatch,
	type LeaseOptions,
	PageAbsent
} from '../../src/lease.ts';

const pageSize = 64;

function sourceBytes(size: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < size; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[i] = state & 0xff;
	}
	return bytes;
}

function serve(
	source: Uint8Array,
	tamper: (offset: number, bytes: Uint8Array, call: number) => Uint8Array = (_offset, bytes) =>
		bytes
) {
	const calls: [number, number][] = [];
	const fetchRange = async (offset: number, length: number) => {
		calls.push([offset, length]);
		return tamper(offset, source.slice(offset, offset + length), calls.length);
	};
	return { calls, fetchRange };
}

function flip(bytes: Uint8Array): Uint8Array {
	const copy = bytes.slice();
	copy[0] = copy[0]! ^ 0xff;
	return copy;
}

async function leaseOver(
	source: Uint8Array,
	options: Partial<LeaseOptions> = {},
	tamper?: Parameters<typeof serve>[1]
) {
	const remote = serve(source, tamper);
	const manifest = await buildManifest(source, pageSize);
	const lease = new Lease({ manifest, fetchRange: remote.fetchRange, ...options });
	return { lease, calls: remote.calls };
}

test('random reads return exact bytes across page boundaries and a short last page', async () => {
	const source = sourceBytes(1000, 7);
	const { lease } = await leaseOver(source);
	let state = 42;
	const next = (limit: number) => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state % limit;
	};
	for (let i = 0; i < 300; i++) {
		const offset = next(source.length);
		const length = next(source.length - offset + 1);
		assert.deepEqual(await lease.read(offset, length), source.slice(offset, offset + length));
	}
});

test('peek reports the absent pages and succeeds once they are read', async () => {
	const source = sourceBytes(1024, 3);
	const { lease } = await leaseOver(source);
	assert.throws(
		() => lease.peek(0, 200),
		(error: unknown) => error instanceof PageAbsent && error.pages.join() === '0,1,2,3'
	);
	await lease.read(0, 200);
	assert.deepEqual(lease.peek(0, 200), source.slice(0, 200));
	assert.throws(
		() => lease.peek(200, 200),
		(error: unknown) => error instanceof PageAbsent && error.pages.join() === '4,5,6'
	);
});

test('concurrent reads of one page share one fetch', async () => {
	const source = sourceBytes(256, 5);
	const { lease, calls } = await leaseOver(source);
	const [a, b] = await Promise.all([lease.read(0, 10), lease.read(5, 10)]);
	assert.deepEqual(a, source.slice(0, 10));
	assert.deepEqual(b, source.slice(5, 15));
	assert.deepEqual(calls, [[0, 64]]);
});

test('adjacent missing pages coalesce into one fetch and gaps split it', async () => {
	const source = sourceBytes(256, 9);
	const whole = await leaseOver(source);
	await whole.lease.read(0, 192);
	assert.deepEqual(whole.calls, [[0, 192]]);

	const gapped = await leaseOver(source);
	await gapped.lease.read(64, 1);
	gapped.calls.length = 0;
	await gapped.lease.read(0, 192);
	assert.deepEqual(gapped.calls, [
		[0, 64],
		[128, 64]
	]);
});

test('a corrupted page is refused, counted and never resident', async () => {
	const source = sourceBytes(256, 11);
	const { lease, calls } = await leaseOver(source, {}, (offset, bytes) =>
		offset === 64 ? flip(bytes) : bytes
	);
	await assert.rejects(lease.read(64, 10), LeaseMismatch);
	assert.equal(calls.length, 2);
	assert.equal(lease.stats.mismatches, 2);
	assert.equal(lease.stats.residentBytes, 0);
	assert.throws(
		() => lease.peek(64, 10),
		(error: unknown) => error instanceof PageAbsent && error.pages.join() === '1'
	);
});

test('a one-time corruption and a one-time short response are recovered by the retry', async () => {
	const source = sourceBytes(256, 13);
	const flipped = await leaseOver(source, {}, (_offset, bytes, call) =>
		call === 1 ? flip(bytes) : bytes
	);
	assert.deepEqual(await flipped.lease.read(64, 10), source.slice(64, 74));
	assert.equal(flipped.lease.stats.mismatches, 1);
	assert.equal(flipped.calls.length, 2);

	const short = await leaseOver(source, {}, (_offset, bytes, call) =>
		call === 1 ? bytes.slice(0, bytes.length - 1) : bytes
	);
	assert.deepEqual(await short.lease.read(64, 10), source.slice(64, 74));
	assert.equal(short.lease.stats.mismatches, 1);
});

test('a transport error rejects the read and leaves nothing in flight', async () => {
	const source = sourceBytes(256, 15);
	let fail = true;
	const manifest = await buildManifest(source, pageSize);
	const lease = new Lease({
		manifest,
		fetchRange: async (offset, length) => {
			if (fail) throw new Error('down');
			return source.slice(offset, offset + length);
		}
	});
	await assert.rejects(lease.read(0, 10), /down/);
	fail = false;
	assert.deepEqual(await lease.read(0, 10), source.slice(0, 10));
	assert.equal(lease.stats.fetches, 2);
});

test('LRU evicts the least recently used page once the budget is full', async () => {
	const source = sourceBytes(1024, 17);
	const { lease } = await leaseOver(source, { residentBytes: 3 * pageSize });
	await lease.read(0, 64);
	await lease.read(64, 64);
	await lease.read(128, 64);
	await lease.read(0, 1);
	await lease.read(192, 1);
	assert.equal(lease.stats.evictions, 1);
	assert.equal(lease.stats.residentBytes, 3 * pageSize);
	assert.throws(
		() => lease.peek(64, 1),
		(error: unknown) => error instanceof PageAbsent && error.pages.join() === '1'
	);
	for (const offset of [0, 128, 192]) assert.equal(lease.peek(offset, 1).length, 1);

	for (let offset = 0; offset < source.length; offset += pageSize) {
		await lease.read(offset, 1);
		assert.ok(lease.stats.residentBytes <= 3 * pageSize);
	}
});

test('a read larger than the budget returns exact bytes and settles within the budget', async () => {
	const source = sourceBytes(512, 19);
	const { lease } = await leaseOver(source, { residentBytes: pageSize });
	assert.deepEqual(await lease.read(0, 320), source.slice(0, 320));
	assert.equal(lease.stats.residentBytes, pageSize);
	assert.equal(lease.stats.evictions, 4);
	assert.deepEqual(lease.peek(256, 64), source.slice(256, 320));
});

test('a page in flight for one read is not evicted by another read', async () => {
	const source = sourceBytes(512, 21);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const manifest = await buildManifest(source, pageSize);
	const lease = new Lease({
		manifest,
		residentBytes: 2 * pageSize,
		fetchRange: async (offset, length) => {
			if (offset === 64) await gate;
			return source.slice(offset, offset + length);
		}
	});
	await lease.read(0, 64);
	const held = lease.read(0, 128);
	let finished = false;
	const other = lease.read(128, 128).then((bytes) => {
		finished = true;
		return bytes;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(finished, false);
	assert.deepEqual(lease.peek(0, 64), source.slice(0, 64));
	release();
	assert.deepEqual(await held, source.slice(0, 128));
	assert.deepEqual(await other, source.slice(128, 256));
	assert.ok(lease.stats.residentBytes <= 2 * pageSize);
});

test('stats count lookups, fetches and bytes', async () => {
	const source = sourceBytes(256, 23);
	const { lease } = await leaseOver(source);
	await lease.read(0, 64);
	await lease.read(0, 128);
	assert.deepEqual(lease.peek(0, 128), source.slice(0, 128));
	assert.throws(() => lease.peek(128, 1), PageAbsent);
	assert.deepEqual(lease.stats, {
		hits: 3,
		misses: 3,
		fetches: 2,
		fetchedBytes: 128,
		mismatches: 0,
		evictions: 0,
		residentBytes: 128
	});
	await lease.prefetch(128, 64);
	assert.deepEqual(lease.peek(128, 64), source.slice(128, 192));
	assert.deepEqual(lease.stats, {
		hits: 4,
		misses: 4,
		fetches: 3,
		fetchedBytes: 192,
		mismatches: 0,
		evictions: 0,
		residentBytes: 192
	});
});

test('buildManifest hashes each page, the last one short', async () => {
	const source = sourceBytes(150, 25);
	const manifest = await buildManifest(source, pageSize);
	const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
	assert.equal(manifest.size, 150);
	assert.equal(manifest.pageSize, pageSize);
	assert.deepEqual(manifest.hashes, [
		sha(source.subarray(0, 64)),
		sha(source.subarray(64, 128)),
		sha(source.subarray(128, 150))
	]);
});

test('range errors, zero-length reads and manifest checks', async () => {
	const source = sourceBytes(150, 27);
	const { lease, calls } = await leaseOver(source);
	await assert.rejects(lease.read(-1, 1), RangeError);
	await assert.rejects(lease.read(0, 151), RangeError);
	assert.throws(() => lease.peek(150, 1), RangeError);
	assert.deepEqual(await lease.read(150, 0), new Uint8Array(0));
	assert.deepEqual(await lease.read(0, 0), new Uint8Array(0));
	assert.deepEqual(calls, []);
	assert.throws(
		() =>
			new Lease({
				manifest: { size: 150, pageSize, hashes: ['00'] },
				fetchRange: async () => source
			}),
		RangeError
	);
});

test('two concurrent reads that each fit the budget never hold more than the budget', async () => {
	const source = sourceBytes(pageSize * 8, 31);
	const { lease } = await leaseOver(source, { residentBytes: pageSize * 2 });
	const [a, b] = await Promise.all([
		lease.read(0, pageSize * 2),
		lease.read(pageSize * 4, pageSize * 2)
	]);
	assert.deepEqual(a, source.subarray(0, pageSize * 2));
	assert.deepEqual(b, source.subarray(pageSize * 4, pageSize * 6));
	assert.ok(lease.stats.residentBytes <= pageSize * 2);
});

test('a read larger than the budget still completes when it runs alone', async () => {
	const source = sourceBytes(pageSize * 6, 33);
	const { lease } = await leaseOver(source, { residentBytes: pageSize * 2 });
	assert.deepEqual(await lease.read(0, pageSize * 5), source.subarray(0, pageSize * 5));
});
