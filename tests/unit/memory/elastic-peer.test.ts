import assert from 'node:assert/strict';
import { test } from 'vitest';
import { peerHolder, peerStore, type PeerStub } from '../../../src/memory/elastic-peer.ts';
import { AsyncElasticRegion, StaleChunkError } from '../../../src/memory/elastic.ts';

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

test('peer holder over four in-process peers reads back exactly after a new isolate', async () => {
	const chunkBytes = 4096;
	const chunks = 32;
	const byteLength = chunks * chunkBytes;
	const peers = [peerStore(), peerStore(), peerStore(), peerStore()];
	const holder = peerHolder(peers);
	const region = new AsyncElasticRegion({ byteLength, chunkBytes, frames: 3, holder });
	const model = new Uint8Array(byteLength);
	const next = rng(5);
	for (let op = 0; op < 3000; op++) {
		const length = 1 + Math.floor(next() * chunkBytes);
		const offset = Math.floor(next() * (byteLength - length + 1));
		if (next() < 0.5) {
			const fill = Math.floor(next() * 256);
			const bytes = Uint8Array.from({ length }, (_, i) => (fill + i) & 255);
			await region.write(offset, bytes);
			model.set(bytes, offset);
		}
	}
	await region.flush();

	const fresh = new AsyncElasticRegion({
		byteLength,
		chunkBytes,
		frames: 3,
		holder: peerHolder(peers)
	});
	await fresh.restoreTable(region.snapshotTable());
	const whole = new Uint8Array(byteLength);
	await fresh.read(0, whole);
	assert.equal(Buffer.compare(whole, model), 0);
});

test('a peer that drops a chunk makes the region refuse it as missing', async () => {
	const chunkBytes = 4096;
	const inner = [peerStore(), peerStore()];
	let dropping = false;
	const stubs: PeerStub[] = [
		inner[0]!,
		{
			get: async (index) => (dropping ? undefined : inner[1]!.get(index)),
			put: (index, version, bytes) => inner[1]!.put(index, version, bytes)
		}
	];
	const region = new AsyncElasticRegion({
		byteLength: 4 * chunkBytes,
		chunkBytes,
		frames: 1,
		holder: peerHolder(stubs)
	});
	await region.write(chunkBytes, new Uint8Array([7]));
	await region.write(0, new Uint8Array([1]));
	await region.flush();
	dropping = true;
	await assert.rejects(
		region.read(chunkBytes, new Uint8Array(1)),
		(error: unknown) => error instanceof StaleChunkError && error.found === undefined
	);
});

test('peer holder refuses an empty peer list and a chunk of the wrong size', async () => {
	assert.throws(() => peerHolder([]), RangeError);
	const store = peerStore();
	await store.put(0, 1, new Uint8Array(8));
	const holder = peerHolder([store]);
	await assert.rejects(holder.read(0, new Uint8Array(16)), RangeError);
});
