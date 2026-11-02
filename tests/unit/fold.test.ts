import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import { afterEach, test } from 'vitest';
import {
	adler32Combine,
	chunkRanges,
	crc32Combine,
	ctrAdvance,
	foldChunks,
	type FoldChunk
} from '../../src/fold.ts';
import { TaskPool, type TaskResult } from '../../src/tasks.ts';

const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
const open: { pool: TaskPool; workers: Worker[] }[] = [];

afterEach(async () => {
	for (const { pool, workers } of open.splice(0)) {
		pool.close();
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
});

function start(count: number): TaskPool {
	const pool = new TaskPool(count);
	const workers: Worker[] = [];
	for (let index = 0; index < count; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(new URL('../helpers/fold-worker.ts', import.meta.url), {
				workerData: { link, key },
				transferList: [link.port]
			})
		);
	}
	open.push({ pool, workers });
	return pool;
}

let seed = 0x2545f491;
function random(size: number): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		out[i] = seed & 255;
	}
	return out;
}

const randomInt = (max: number) => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return (seed >>> 0) % (max + 1);
};

function boundaries(length: number, align: number): FoldChunk[] {
	const chunks: FoldChunk[] = [];
	let start = 0;
	while (start < length) {
		const step = Math.min(length - start, (randomInt(6) + 1) * align);
		chunks.push({ start, end: start + step });
		start += step;
	}
	return chunks;
}

const u32At = (part: TaskResult) => {
	const bytes = part.bytes;
	return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
};

function referenceAdler(bytes: Uint8Array): number {
	let s1 = 1;
	let s2 = 0;
	for (const byte of bytes) {
		s1 = (s1 + byte) % 65521;
		s2 = (s2 + s1) % 65521;
	}
	return ((s2 << 16) | s1) >>> 0;
}

test('crc32Combine equals the CRC of the whole buffer over random boundaries', () => {
	for (let round = 0; round < 20; round++) {
		const data = random(randomInt(30000));
		let combined = 0;
		for (const { start, end } of boundaries(data.length, 1)) {
			combined = crc32Combine(combined, crc32(data.subarray(start, end)) >>> 0, end - start);
		}
		assert.equal(combined, crc32(data) >>> 0);
	}
});

test('crc32Combine takes zero-length and one-byte chunks', () => {
	const data = random(9);
	const empty = crc32(Buffer.alloc(0)) >>> 0;
	let combined = crc32Combine(0, empty, 0);
	for (const byte of data) {
		combined = crc32Combine(combined, crc32(Uint8Array.of(byte)) >>> 0, 1);
		combined = crc32Combine(combined, empty, 0);
	}
	assert.equal(combined, crc32(data) >>> 0);
});

test('adler32Combine equals the sum of the whole buffer over random boundaries', () => {
	for (let round = 0; round < 20; round++) {
		const data = random(randomInt(30000));
		let combined = 1;
		for (const { start, end } of boundaries(data.length, 1)) {
			combined = adler32Combine(
				combined,
				referenceAdler(data.subarray(start, end)),
				end - start
			);
		}
		assert.equal(combined, referenceAdler(data));
	}
});

test('adler32Combine takes zero-length and one-byte chunks', () => {
	const data = random(9);
	let combined = 1;
	for (const byte of data) {
		combined = adler32Combine(combined, referenceAdler(Uint8Array.of(byte)), 1);
		combined = adler32Combine(combined, 1, 0);
	}
	assert.equal(combined, referenceAdler(data));
});

test('ctrAdvance matches 128-bit addition, including the wrap', () => {
	const modulus = 1n << 128n;
	for (let round = 0; round < 50; round++) {
		const counter = random(16);
		const blocks = randomInt(1 << 30);
		let value = 0n;
		for (const byte of counter) value = (value << 8n) | BigInt(byte);
		value = (value + BigInt(blocks)) % modulus;
		const expected = Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
		assert.equal(Buffer.from(ctrAdvance(counter, blocks)).equals(expected), true);
	}
	assert.deepEqual(ctrAdvance(new Uint8Array(16).fill(0xff), 1), new Uint8Array(16));
});

test('AES-CTR chunks on 16-byte boundaries equal the single stream', () => {
	const base = new Uint8Array(16).fill(0xff);
	base.set([0xf0, 0, 0], 13);
	for (let round = 0; round < 10; round++) {
		const data = random(16 * randomInt(4000) + randomInt(15));
		const whole = createCipheriv('aes-128-ctr', key, base).update(data);
		const out = new Uint8Array(data.length);
		for (const { start, end } of boundaries(data.length, 16)) {
			const counter = ctrAdvance(base, start / 16);
			out.set(
				createCipheriv('aes-128-ctr', key, counter).update(data.subarray(start, end)),
				start
			);
		}
		assert.deepEqual(out, new Uint8Array(whole));
	}
});

test('chunkRanges covers the input with aligned chunks', () => {
	for (const [length, count, align] of [
		[0, 4, 16],
		[1, 8, 16],
		[100, 3, 16],
		[65536, 8, 1],
		[1000, 7, 64]
	] as const) {
		const chunks = chunkRanges(length, count, align);
		assert.ok(chunks.length <= count);
		let at = 0;
		chunks.forEach((chunk, index) => {
			assert.equal(chunk.start, at);
			if (index < chunks.length - 1) assert.equal(chunk.end % align, 0);
			at = chunk.end;
		});
		assert.equal(at, length);
	}
});

test('chunkRanges and foldChunks refuse invalid arguments', () => {
	assert.throws(() => chunkRanges(-1, 2), RangeError);
	assert.throws(() => chunkRanges(10, 0), RangeError);
	assert.throws(() => chunkRanges(10, 2, 0), RangeError);
	const pool = start(1);
	const data = random(32);
	assert.throws(
		() =>
			foldChunks(pool, data, {
				align: 16,
				chunks: [
					{ start: 0, end: 5 },
					{ start: 5, end: 32 }
				],
				task: () => 'ctr:',
				initial: new Uint8Array(32),
				combine: (state) => state
			}),
		/not a multiple of 16/
	);
	assert.throws(
		() =>
			foldChunks(pool, data, {
				chunks: [{ start: 0, end: 16 }],
				task: () => 'crc32',
				initial: 0,
				combine: (state) => state
			}),
		/cover 16 of 32/
	);
});

test('foldChunks folds CRC-32 and Adler-32 over the pool in order', () => {
	const pool = start(3);
	const data = random(100003);
	const crc = foldChunks(pool, data, {
		task: () => 'crc32',
		initial: 0,
		combine: (state, part, chunk) => crc32Combine(state, u32At(part), chunk.end - chunk.start)
	});
	assert.equal(crc, crc32(data) >>> 0);
	const adler = foldChunks(pool, data, {
		task: () => 'adler32',
		initial: 1,
		combine: (state, part, chunk) => adler32Combine(state, u32At(part), chunk.end - chunk.start)
	});
	assert.equal(adler, referenceAdler(data));
});

test('foldChunks on an empty input runs no task and returns the initial state', () => {
	const pool = start(2);
	const folded = foldChunks(pool, new Uint8Array(0), {
		task: () => 'crc32',
		initial: 0,
		combine: () => {
			throw new Error('no chunk should combine');
		}
	});
	assert.equal(folded, 0);
});

test('foldChunks on AES-CTR with 16-byte chunks equals the single stream', () => {
	const pool = start(3);
	const base = new Uint8Array(16).fill(0xff);
	base.set([0xf0, 0, 0], 13);
	const data = random(16 * 300 + 7);
	const whole = createCipheriv('aes-128-ctr', key, base).update(data);
	const out = foldChunks(pool, data, {
		align: 16,
		task: (chunk) => `ctr:${Buffer.from(ctrAdvance(base, chunk.start / 16)).toString('hex')}`,
		initial: new Uint8Array(data.length),
		combine: (state, part, chunk) => {
			state.set(part.bytes, chunk.start);
			return state;
		}
	});
	assert.deepEqual(out, new Uint8Array(whole));
});
