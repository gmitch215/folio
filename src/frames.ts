import { decodeValue, encodeValue } from './remote.ts';
import type { TransactionResult } from './transaction.ts';

const magic = 0x314f4c46;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Lossless page encoding; omitted pages contain only zero bytes. */
export interface SnapshotPages {
	memoryBytes: number;
	pages: number[];
}

/** Encodes sparse arenas. A dense payload borrows the input until encodeFrame copies it. */
export function encodeSnapshot(bytes: Uint8Array): {
	snapshot?: SnapshotPages;
	payload: Uint8Array;
} {
	if (bytes.length % 65536) throw new RangeError('invalid snapshot page size');
	const pages: number[] = [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = 0; offset < bytes.length; offset += 65536) {
		for (let word = offset; word < offset + 65536; word += 4)
			if (view.getUint32(word, true) !== 0) {
				pages.push(offset / 65536);
				break;
			}
	}
	if (pages.length > 4096 || pages.length * 65536 + pages.length * 8 + 64 >= bytes.length)
		return { payload: bytes };
	const payload = new Uint8Array(pages.length * 65536);
	pages.forEach((page, index) =>
		payload.set(bytes.subarray(page * 65536, (page + 1) * 65536), index * 65536)
	);
	return { snapshot: { memoryBytes: bytes.length, pages }, payload };
}

/** Checks sparse metadata before allocation or writes; returns the complete logical byte length. */
export function snapshotLength(snapshot: SnapshotPages | undefined, payload: Uint8Array): number {
	if (snapshot === undefined) return payload.length;
	if (
		!Number.isSafeInteger(snapshot?.memoryBytes) ||
		snapshot.memoryBytes < 0 ||
		snapshot.memoryBytes % 65536 ||
		!Array.isArray(snapshot.pages) ||
		snapshot.pages.length * 65536 !== payload.length
	)
		throw new TypeError('invalid sparse snapshot');
	let previous = -1;
	for (const page of snapshot.pages) {
		if (!Number.isSafeInteger(page) || page <= previous || page * 65536 >= snapshot.memoryBytes)
			throw new TypeError('invalid sparse snapshot page');
		previous = page;
	}
	return snapshot.memoryBytes;
}

/** Restores a complete snapshot, clearing pages omitted by the sparse representation. */
export function restoreSnapshot(
	target: Uint8Array,
	payload: Uint8Array,
	snapshot?: SnapshotPages
): void {
	if (snapshotLength(snapshot, payload) !== target.length)
		throw new RangeError('snapshot size differs');
	if (!snapshot) {
		target.set(payload);
		return;
	}
	target.fill(0);
	snapshot.pages.forEach((page, index) =>
		target.set(payload.subarray(index * 65536, (index + 1) * 65536), page * 65536)
	);
}

export function encodeFrame(
	header: unknown,
	payload: Uint8Array = new Uint8Array(),
	maximum = 0x100100000
): Uint8Array {
	const metadata = encoder.encode(JSON.stringify(encodeValue(header)));
	if (metadata.length > 65536) throw new RangeError('frame header exceeds limit');
	const length = 12 + metadata.length + payload.length;
	if (payload.length > 0xffffffff || length > maximum)
		throw new RangeError(`frame of ${length} bytes exceeds the limit of ${maximum} bytes`);
	const bytes = new Uint8Array(length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, magic, true);
	view.setUint32(4, metadata.length, true);
	view.setUint32(8, payload.length, true);
	bytes.set(metadata, 12);
	bytes.set(payload, 12 + metadata.length);
	return bytes;
}

export function decodeFrame<T>(
	bytes: Uint8Array,
	maximum: number
): {
	header: T;
	payload: Uint8Array;
} {
	if (bytes.length < 12 || bytes.length > maximum) throw new RangeError('invalid frame size');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = view.getUint32(4, true),
		payload = view.getUint32(8, true);
	if (
		view.getUint32(0, true) !== magic ||
		header > 65536 ||
		12 + header + payload !== bytes.length
	)
		throw new TypeError('invalid frame layout');
	return {
		header: decodeValue(JSON.parse(decoder.decode(bytes.subarray(12, 12 + header)))) as T,
		payload: bytes.subarray(12 + header)
	};
}

export interface FrameIdentity {
	session: string;
	epoch: number;
	sequence: number;
}

export function validateIdentity(value: FrameIdentity): void {
	if (
		typeof value?.session !== 'string' ||
		value.session.length < 1 ||
		value.session.length > 128 ||
		!Number.isSafeInteger(value.epoch) ||
		value.epoch < 0 ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 0
	)
		throw new TypeError('invalid frame identity');
}

export function encodeResults(
	identity: FrameIdentity,
	results: TransactionResult[],
	maximum = 0x100100000
): Uint8Array {
	const length = results.reduce(
		(sum, result) => sum + result.reads.length * 4 + result.writes.length * 8,
		0
	);
	if (length > 0xffffffff || length + 12 > maximum)
		throw new RangeError('result payload exceeds limit');
	const payload = new Uint8Array(length),
		view = new DataView(payload.buffer);
	let offset = 0;
	const descriptors = results.map(({ reads, writes, ...result }) => {
		for (const address of reads) {
			view.setUint32(offset, address, true);
			offset += 4;
		}
		for (const [address, value] of writes) {
			view.setUint32(offset, address, true);
			view.setUint32(offset + 4, value, true);
			offset += 8;
		}
		return { ...result, reads: reads.length, writes: writes.length };
	});
	return encodeFrame(
		{
			session: identity.session,
			epoch: identity.epoch,
			sequence: identity.sequence,
			results: descriptors
		},
		payload,
		maximum
	);
}

export function decodeResults(
	bytes: Uint8Array,
	identity: FrameIdentity,
	options: {
		maximumFrameBytes: number;
		memoryBytes: number;
		maxBytes: number;
		calls: number;
	}
): TransactionResult[] {
	const { header, payload } = decodeFrame<
		FrameIdentity & {
			results: (Omit<TransactionResult, 'reads' | 'writes'> & {
				reads: number;
				writes: number;
			})[];
		}
	>(bytes, options.maximumFrameBytes);
	validateIdentity(header);
	if (
		header.session !== identity.session ||
		header.epoch !== identity.epoch ||
		header.sequence !== identity.sequence
	)
		throw new TypeError('stale lane response');
	if (!Array.isArray(header.results) || header.results.length !== options.calls)
		throw new TypeError('invalid lane result count');
	let offset = 0,
		retained = 0;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const results = header.results.map(({ reads, writes, ...result }) => {
		if (![reads, writes].every((n) => Number.isSafeInteger(n) && n >= 0))
			throw new TypeError('invalid lane tracking counts');
		retained += reads + writes;
		if (retained > options.maxBytes + 8 || offset + reads * 4 + writes * 8 > payload.length)
			throw new RangeError('lane tracking exceeds limit');
		if (
			(result.trap !== undefined && typeof result.trap !== 'string') ||
			(result.errorKind !== undefined && typeof result.errorKind !== 'string') ||
			(result.exhausted !== undefined && typeof result.exhausted !== 'boolean')
		)
			throw new TypeError('invalid lane trap');
		const readSet: number[] = [],
			writeSet: [number, number][] = [];
		for (let i = 0; i < reads; i++) {
			const address = view.getUint32(offset, true);
			offset += 4;
			if (address >= options.memoryBytes) throw new RangeError('lane read outside arena');
			readSet.push(address);
		}
		for (let i = 0; i < writes; i++) {
			const address = view.getUint32(offset, true),
				value = view.getUint32(offset + 4, true);
			offset += 8;
			if (address >= options.memoryBytes || value > 255)
				throw new RangeError('lane write outside arena');
			writeSet.push([address, value]);
		}
		return { ...result, reads: readSet, writes: writeSet };
	});
	if (offset !== payload.length) throw new TypeError('unconsumed lane payload');
	return results;
}
