import type { AsyncHolder } from './elastic.ts';

export interface PeerRecord {
	version: number;
	bytes: Uint8Array;
}

/** The two RPC methods a peer Durable Object exposes. */
export interface PeerStub {
	get(index: number): Promise<PeerRecord | undefined>;
	put(index: number, version: number, bytes: Uint8Array): Promise<void>;
}

/**
 * An `AsyncHolder` that spreads chunks over peers: chunk `i` lives on `stubs[i % stubs.length]`.
 */
export function peerHolder(stubs: readonly PeerStub[]): AsyncHolder {
	if (stubs.length === 0) throw new RangeError('peerHolder needs at least one stub');
	const stubOf = (index: number): PeerStub => stubs[index % stubs.length]!;
	return {
		async read(index, into) {
			const record = await stubOf(index).get(index);
			if (record === undefined) return undefined;
			if (record.bytes.length !== into.length)
				throw new RangeError(
					`chunk ${index} holds ${record.bytes.length} bytes, expected ${into.length}`
				);
			into.set(record.bytes);
			return record.version;
		},
		async write(index, version, bytes) {
			// copy first: the view aliases the region buffer, and an RPC would clone the whole buffer
			await stubOf(index).put(index, version, bytes.slice());
		}
	};
}

/**
 * The object a peer Durable Object exposes as a `PeerStub`, keeping chunks in memory.
 * A peer may lose its chunks, so a peer holder alone suits data the owner can rebuild. A peer
 * in front of storage needs the owner to keep the storage copy.
 */
export function peerStore(): PeerStub {
	const chunks = new Map<number, PeerRecord>();
	return {
		async get(index) {
			return chunks.get(index);
		},
		async put(index, version, bytes) {
			chunks.set(index, { version, bytes });
		}
	};
}
