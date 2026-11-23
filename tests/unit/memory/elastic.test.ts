import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
	AsyncElasticRegion,
	ElasticRegion,
	StaleChunkError,
	type AsyncHolder,
	type SyncHolder
} from '../../../src/memory/elastic.ts';

interface Entry {
	version: number;
	bytes: Uint8Array;
}

// an in-memory holder; `store` is exposed so a test can roll a chunk back
function memoryHolder(): SyncHolder & { store: Map<number, Entry> } {
	const store = new Map<number, Entry>();
	return {
		store,
		read(index, into) {
			const entry = store.get(index);
			if (!entry) return undefined;
			into.set(entry.bytes);
			return entry.version;
		},
		write(index, version, bytes) {
			store.set(index, { version, bytes: bytes.slice() });
		}
	};
}

function asyncOf(holder: SyncHolder): AsyncHolder {
	return {
		async read(index, into) {
			return holder.read(index, into);
		},
		async write(index, version, bytes) {
			holder.write(index, version, bytes);
		}
	};
}

// mulberry32; a fixed seed keeps every run identical
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.compare(a, b) === 0;
}

function randomBytes(length: number, next: () => number): Uint8Array {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = Math.floor(next() * 256);
	return out;
}

const CHUNKS = 64;
const FRAMES = 4;
const OPS = 20000;

test('sync region matches a plain Uint8Array over 20,000 random reads and writes (4 KiB and 64 KiB chunks)', () => {
	for (const chunkBytes of [4096, 65536]) {
		const byteLength = CHUNKS * chunkBytes;
		const holder = memoryHolder();
		const region = new ElasticRegion({ byteLength, chunkBytes, frames: FRAMES, holder });
		const model = new Uint8Array(byteLength);
		const next = rng(chunkBytes);
		const pattern = randomBytes(2 * chunkBytes, next);
		for (let op = 0; op < OPS; op++) {
			const length = 1 + Math.floor(next() * chunkBytes);
			const offset = Math.floor(next() * (byteLength - length + 1));
			if (next() < 0.5) {
				const start = Math.floor(next() * chunkBytes);
				const bytes = pattern.subarray(start, start + length);
				region.write(offset, bytes);
				model.set(bytes, offset);
			}
			const got = new Uint8Array(length);
			region.read(offset, got);
			assert.ok(sameBytes(got, model.subarray(offset, offset + length)), `op ${op}`);
			if (op % 2000 === 0) {
				const whole = new Uint8Array(byteLength);
				region.read(0, whole);
				assert.ok(sameBytes(whole, model), `full compare at op ${op}`);
			}
		}
		region.flush();
		const fresh = new ElasticRegion({ byteLength, chunkBytes, frames: FRAMES, holder });
		fresh.restoreTable(region.snapshotTable());
		const whole = new Uint8Array(byteLength);
		fresh.read(0, whole);
		assert.ok(sameBytes(whole, model), `final compare after flush, chunk ${chunkBytes}`);
	}
});

test('async region matches a plain Uint8Array over 20,000 random reads and writes', async () => {
	const chunkBytes = 4096;
	const byteLength = CHUNKS * chunkBytes;
	const holder = memoryHolder();
	const region = ElasticRegion.async({
		byteLength,
		chunkBytes,
		frames: FRAMES,
		holder: asyncOf(holder)
	});
	assert.ok(region instanceof AsyncElasticRegion);
	const model = new Uint8Array(byteLength);
	const next = rng(7);
	const pattern = randomBytes(2 * chunkBytes, next);
	for (let op = 0; op < OPS; op++) {
		const length = 1 + Math.floor(next() * chunkBytes);
		const offset = Math.floor(next() * (byteLength - length + 1));
		if (next() < 0.5) {
			const start = Math.floor(next() * chunkBytes);
			const bytes = pattern.subarray(start, start + length);
			await region.write(offset, bytes);
			model.set(bytes, offset);
		}
		const got = new Uint8Array(length);
		await region.read(offset, got);
		assert.ok(sameBytes(got, model.subarray(offset, offset + length)), `op ${op}`);
	}
	await region.flush();
	const fresh = ElasticRegion.async({
		byteLength,
		chunkBytes,
		frames: FRAMES,
		holder: asyncOf(holder)
	});
	await fresh.restoreTable(region.snapshotTable());
	const whole = new Uint8Array(byteLength);
	await fresh.read(0, whole);
	assert.ok(sameBytes(whole, model));
});

test('a chunk whose holder copy is older than the table is refused, and the region keeps working', () => {
	const chunkBytes = 4096;
	const holder = memoryHolder();
	const region = new ElasticRegion({ byteLength: 4 * chunkBytes, chunkBytes, frames: 1, holder });
	region.write(0, new Uint8Array(chunkBytes).fill(1));
	region.flush();
	const versionOne = { ...holder.store.get(0)! };
	region.write(0, new Uint8Array(chunkBytes).fill(2));
	region.flush();
	holder.store.set(0, versionOne);
	// one frame: reading chunk 1 evicts clean chunk 0
	region.view(chunkBytes, 1);
	assert.throws(
		() => region.view(0, 1),
		(error: unknown) =>
			error instanceof StaleChunkError &&
			error.chunk === 0 &&
			error.found === 1 &&
			error.expected === 2
	);
	assert.equal(region.stats().staleRefusals, 1);
	region.view(2 * chunkBytes, 1);
	region.write(chunkBytes, new Uint8Array([9]));
	const check = new Uint8Array(1);
	region.read(chunkBytes, check);
	assert.equal(check[0], 9);
});

test('two views of a resident chunk share one buffer, so a write through one is seen by the other', () => {
	const holder = memoryHolder();
	const region = new ElasticRegion({ byteLength: 8192, chunkBytes: 4096, frames: 2, holder });
	const a = region.view(0, 8);
	const b = region.view(4, 4);
	assert.equal(a.buffer, b.buffer);
	a[4] = 99;
	assert.equal(b[0], 99);
	assert.equal(region.stats().faults, 1);
	assert.equal(region.stats().hits, 1);
});

test('reads stay clean; a write through a view is lost unless touched', () => {
	const holder = memoryHolder();
	const region = new ElasticRegion({ byteLength: 8192, chunkBytes: 4096, frames: 1, holder });
	region.view(0, 4)[0] = 5;
	region.flush();
	assert.equal(region.stats().writeBacks, 0);
	region.view(0, 4)[0] = 6;
	region.touch(0, 4);
	region.flush();
	assert.equal(region.stats().writeBacks, 1);
});

test('pinning: a miss with every frame pinned throws RangeError until one is unpinned', () => {
	const holder = memoryHolder();
	const region = new ElasticRegion({ byteLength: 16384, chunkBytes: 4096, frames: 2, holder });
	const a = region.pin(0, 4);
	const b = region.pin(4096, 4);
	assert.throws(() => region.view(8192, 4), RangeError);
	region.unpin(a, true);
	const c = region.view(8192, 4);
	assert.equal(c.length, 4);
	assert.throws(() => region.unpin(a, false), /not pinned/);
	region.unpin(b, false);
});

test('the fault path passes the holder a subarray of the region buffer, never a fresh one', () => {
	const base = memoryHolder();
	const buffers = new Set<ArrayBufferLike>();
	const sizes: number[] = [];
	const holder: SyncHolder = {
		read(index, into) {
			buffers.add(into.buffer);
			sizes.push(into.length);
			return base.read(index, into);
		},
		write(index, version, bytes) {
			base.write(index, version, bytes);
		}
	};
	const chunkBytes = 4096;
	const region = new ElasticRegion({
		byteLength: 16 * chunkBytes,
		chunkBytes,
		frames: 3,
		holder
	});
	const next = rng(3);
	for (let op = 0; op < 500; op++) {
		const offset = Math.floor(next() * (16 * chunkBytes - 1));
		region.write(offset, new Uint8Array([op & 255]));
		region.read(Math.floor(next() * (16 * chunkBytes - 1)), new Uint8Array(1));
	}
	assert.ok(sizes.length > 0);
	assert.equal(buffers.size, 1);
	assert.ok(sizes.every((size) => size === chunkBytes));
	const [only] = buffers;
	assert.equal(only!.byteLength, 3 * chunkBytes);
});

test('copyIntoMemory and copyFromMemory move bytes between a wasm memory and the region', () => {
	const memory = new WebAssembly.Memory({ initial: 1 });
	const bytes = new Uint8Array(memory.buffer);
	const holder = memoryHolder();
	const region = new ElasticRegion({ byteLength: 3 * 4096, chunkBytes: 4096, frames: 1, holder });
	for (let i = 0; i < 1000; i++) bytes[100 + i] = (i * 7) & 255;
	region.copyFromMemory(memory, 100, 4000, 1000);
	bytes.fill(0, 100, 1100);
	region.copyIntoMemory(memory, 5000, 4000, 1000);
	for (let i = 0; i < 1000; i++) assert.equal(bytes[5000 + i], (i * 7) & 255);
});

test('prefetch loads chunks into free frames only, and settled joins the loads', async () => {
	const chunkBytes = 4096;
	const holder = memoryHolder();
	const writer = new ElasticRegion({ byteLength: 8 * chunkBytes, chunkBytes, frames: 8, holder });
	for (let i = 0; i < 8; i++)
		writer.write(i * chunkBytes, new Uint8Array(chunkBytes).fill(i + 1));
	writer.flush();
	const reader = new AsyncElasticRegion({
		byteLength: 8 * chunkBytes,
		chunkBytes,
		frames: 4,
		holder: asyncOf(holder)
	});
	await reader.restoreTable(writer.snapshotTable());
	reader.prefetch(0, 4 * chunkBytes);
	await reader.settled();
	assert.equal(reader.stats().faults, 4);
	const got = new Uint8Array(4 * chunkBytes);
	await reader.read(0, got);
	assert.equal(got[3 * chunkBytes]!, 4);
	assert.equal(reader.stats().hits, 4);
	assert.equal(reader.stats().faults, 4);
	// every frame is full and clean; a prefetch must not evict
	reader.prefetch(4 * chunkBytes, chunkBytes);
	await reader.settled();
	assert.equal(reader.stats().evictions, 0);
});

test('a prefetch issued while a fault waits on its write-back cannot take the faulting frame', async () => {
	const chunkBytes = 4096;
	const store = memoryHolder();
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const region = ElasticRegion.async({
		byteLength: 4 * chunkBytes,
		chunkBytes,
		frames: 2,
		holder: {
			async read(index, into) {
				return store.read(index, into);
			},
			async write(index, version, bytes) {
				await gate;
				store.write(index, version, bytes);
			}
		}
	});
	await region.write(0, new Uint8Array(chunkBytes).fill(1));
	await region.write(chunkBytes, new Uint8Array(chunkBytes).fill(2));
	// chunks 0 and 1 are resident and dirty, so the next fault waits on a write-back
	const faulting = region.read(2 * chunkBytes, new Uint8Array(chunkBytes));
	release();
	// try the prefetch at every microtask step through the eviction, so one lands in the gap
	for (let step = 0; step < 64; step++) {
		await Promise.resolve();
		region.prefetch(3 * chunkBytes, chunkBytes);
	}
	await faulting;
	await region.settled();
	const got = new Uint8Array(4 * chunkBytes);
	await region.read(0, got);
	assert.ok(got.subarray(0, chunkBytes).every((b) => b === 1));
	assert.ok(got.subarray(chunkBytes, 2 * chunkBytes).every((b) => b === 2));
	assert.ok(got.subarray(2 * chunkBytes).every((b) => b === 0));
});

test('restoreTable refuses a wrong size and a region with a dirty frame', () => {
	const holder = memoryHolder();
	const region = new ElasticRegion({ byteLength: 8192, chunkBytes: 4096, frames: 2, holder });
	assert.throws(() => region.restoreTable(new Uint32Array(3)), RangeError);
	region.write(0, new Uint8Array([1]));
	assert.throws(() => region.restoreTable(new Uint32Array(2)), /dirty or pinned/);
	region.flush();
	region.restoreTable(new Uint32Array(2));
});
