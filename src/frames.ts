import { decodeValue, encodeValue } from './remote.ts';
import { checkRuns, runBytes, runsOfSorted, writeRunsOf } from './runs.ts';
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

/** Version of the run encoding of a results frame, named in the request and the response. */
export const runsVersion = 1;

/**
 * Run encoding of a results frame, `runs` of the request: per result the read runs and the write
 * runs as start, length pairs, then the written bytes back to back, then the escapes. Results
 * that carry addresses are converted, so a lane may mix paths.
 */
function encodeRunResults(
	identity: FrameIdentity,
	results: TransactionResult[],
	maximum: number
): Uint8Array {
	const parts = results.map((result) => {
		const readRuns = result.readRuns ?? runsOfSorted(Uint32Array.from(result.reads).sort());
		const packed = result.writeRuns
			? { runs: result.writeRuns, data: result.writeData ?? new Uint8Array() }
			: writeRunsOf(result.writes);
		if (packed.data.length !== runBytes(packed.runs))
			throw new RangeError('write runs and write data differ');
		return { result, readRuns, packed };
	});
	const length = parts.reduce(
		(sum, { result, readRuns, packed }) =>
			sum +
			readRuns.length * 4 +
			packed.runs.length * 4 +
			packed.data.length +
			(result.escapes?.length ?? 0) * 8,
		0
	);
	if (length > 0xffffffff || length + 12 > maximum)
		throw new RangeError('result payload exceeds limit');
	const payload = new Uint8Array(length),
		view = new DataView(payload.buffer);
	let offset = 0;
	const put = (runs: Uint32Array) => {
		for (let i = 0; i < runs.length; i++, offset += 4) view.setUint32(offset, runs[i]!, true);
	};
	const descriptors = parts.map(({ result, readRuns, packed }) => {
		const {
			reads,
			writes,
			readRuns: _r,
			writeRuns: _w,
			writeData: _d,
			escapes,
			...rest
		} = result;
		put(readRuns);
		put(packed.runs);
		payload.set(packed.data, offset);
		offset += packed.data.length;
		for (const [start, size] of escapes ?? []) {
			view.setUint32(offset, start, true);
			view.setUint32(offset + 4, size, true);
			offset += 8;
		}
		return {
			...rest,
			reads: readRuns.length / 2,
			writes: packed.runs.length / 2,
			readBytes: runBytes(readRuns),
			writeBytes: packed.data.length,
			...(escapes?.length ? { escapes: escapes.length } : {})
		};
	});
	return encodeFrame(
		{
			session: identity.session,
			epoch: identity.epoch,
			sequence: identity.sequence,
			runs: runsVersion,
			results: descriptors
		},
		payload,
		maximum
	);
}

export function encodeResults(
	identity: FrameIdentity,
	results: TransactionResult[],
	maximum = 0x100100000,
	runs = false
): Uint8Array {
	if (runs) return encodeRunResults(identity, results, maximum);
	const length = results.reduce(
		(sum, result) =>
			sum +
			result.reads.length * 4 +
			result.writes.length * 8 +
			(result.escapes?.length ?? 0) * 8,
		0
	);
	if (length > 0xffffffff || length + 12 > maximum)
		throw new RangeError('result payload exceeds limit');
	const payload = new Uint8Array(length),
		view = new DataView(payload.buffer);
	let offset = 0;
	const descriptors = results.map(({ reads, writes, escapes, ...result }) => {
		for (const address of reads) {
			view.setUint32(offset, address, true);
			offset += 4;
		}
		for (const [address, value] of writes) {
			view.setUint32(offset, address, true);
			view.setUint32(offset + 4, value, true);
			offset += 8;
		}
		for (const [start, size] of escapes ?? []) {
			view.setUint32(offset, start, true);
			view.setUint32(offset + 4, size, true);
			offset += 8;
		}
		return {
			...result,
			reads: reads.length,
			writes: writes.length,
			...(escapes?.length ? { escapes: escapes.length } : {})
		};
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
		/** The request asked for run encoding. A reply in addresses still decodes; see `runsVersion`. */
		runs?: boolean;
	}
): TransactionResult[] {
	const { header, payload } = decodeFrame<
		FrameIdentity & {
			runs?: number;
			results: (Omit<TransactionResult, 'reads' | 'writes' | 'escapes'> & {
				reads: number;
				writes: number;
				escapes?: number;
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
	if (header.runs !== undefined) {
		if (header.runs !== runsVersion) throw new TypeError('unsupported results encoding');
		if (!options.runs) throw new TypeError('unrequested run encoding');
		return decodeRunResults(header.results as RunDescriptor[], payload, options);
	}
	let offset = 0,
		retained = 0;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const results = header.results.map(({ reads, writes, escapes = 0, ...result }) => {
		if (
			![reads, writes, escapes].every((n) => Number.isSafeInteger(n) && n >= 0) ||
			escapes > reads
		)
			throw new TypeError('invalid lane tracking counts');
		retained += reads + writes;
		if (
			retained > options.maxBytes + 8 ||
			offset + reads * 4 + writes * 8 + escapes * 8 > payload.length
		)
			throw new RangeError('lane tracking exceeds limit');
		if (
			(result.trap !== undefined && typeof result.trap !== 'string') ||
			(result.errorKind !== undefined && typeof result.errorKind !== 'string') ||
			(result.exhausted !== undefined && typeof result.exhausted !== 'boolean') ||
			(result.inconclusive !== undefined && typeof result.inconclusive !== 'boolean')
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
		const escapeSet: [number, number][] = [];
		for (let i = 0; i < escapes; i++) {
			const start = view.getUint32(offset, true),
				size = view.getUint32(offset + 4, true);
			offset += 8;
			if (size < 1 || start + size > options.memoryBytes)
				throw new RangeError('lane escape outside arena');
			escapeSet.push([start, size]);
		}
		return {
			...result,
			reads: readSet,
			writes: writeSet,
			...(escapes ? { escapes: escapeSet } : {})
		};
	});
	if (offset !== payload.length) throw new TypeError('unconsumed lane payload');
	return results;
}

type RunDescriptor = Omit<TransactionResult, 'reads' | 'writes' | 'escapes'> & {
	reads: number;
	writes: number;
	readBytes: number;
	writeBytes: number;
	escapes?: number;
};

function decodeRunResults(
	descriptors: RunDescriptor[],
	payload: Uint8Array,
	options: { memoryBytes: number; maxBytes: number }
): TransactionResult[] {
	let offset = 0,
		retained = 0;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const take = (count: number): Uint32Array => {
		const out = new Uint32Array(count * 2);
		for (let i = 0; i < out.length; i++, offset += 4) out[i] = view.getUint32(offset, true);
		return out;
	};
	const results = descriptors.map(
		({ reads, writes, readBytes, writeBytes, escapes = 0, ...result }) => {
			if (
				![reads, writes, readBytes, writeBytes, escapes].every(
					(n) => Number.isSafeInteger(n) && n >= 0
				)
			)
				throw new TypeError('invalid lane tracking counts');
			retained += readBytes + writeBytes;
			if (
				retained > options.maxBytes + 8 ||
				offset + reads * 8 + writes * 8 + writeBytes + escapes * 8 > payload.length
			)
				throw new RangeError('lane tracking exceeds limit');
			if (
				(result.trap !== undefined && typeof result.trap !== 'string') ||
				(result.errorKind !== undefined && typeof result.errorKind !== 'string') ||
				(result.exhausted !== undefined && typeof result.exhausted !== 'boolean') ||
				(result.inconclusive !== undefined && typeof result.inconclusive !== 'boolean')
			)
				throw new TypeError('invalid lane trap');
			const readRuns = take(reads),
				writeRuns = take(writes);
			checkRuns(readRuns, options.memoryBytes, 'read');
			checkRuns(writeRuns, options.memoryBytes, 'write');
			if (runBytes(readRuns) !== readBytes || runBytes(writeRuns) !== writeBytes)
				throw new TypeError('invalid lane tracking counts');
			const writeData = payload.slice(offset, offset + writeBytes);
			offset += writeBytes;
			const escapeSet: [number, number][] = [];
			for (let i = 0; i < escapes; i++) {
				const start = view.getUint32(offset, true),
					size = view.getUint32(offset + 4, true);
				offset += 8;
				if (size < 1 || start + size > options.memoryBytes)
					throw new RangeError('lane escape outside arena');
				escapeSet.push([start, size]);
			}
			return {
				...result,
				reads: [],
				writes: [],
				readRuns,
				writeRuns,
				writeData,
				...(escapes ? { escapes: escapeSet } : {})
			};
		}
	);
	if (offset !== payload.length) throw new TypeError('unconsumed lane payload');
	return results;
}
