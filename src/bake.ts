import { memoryImports } from './memory.ts';
import { pageBytes } from './pages.ts';

type Binaryen = typeof import('binaryen').default;

/** A memory taken from a live instance or already read into bytes. */
export type MemorySource = WebAssembly.Memory | ArrayBufferLike | Uint8Array;

/** A global's value as read from `WebAssembly.Global.value`. */
export type GlobalValue = number | bigint;

/**
 * The pages of a booted memory that differ from a fresh instance of the same module, plus the
 * mutable globals and table slots boot changed. Pages that are zero in both are not stored.
 */
export interface MemoryImage {
	/** Size of the booted memory, a multiple of 65,536. */
	byteLength: number;
	/** Page indexes that differ, strictly ascending. */
	pages: number[];
	/** The bytes of those pages, in the same order (`pages.length * 65,536` bytes). */
	data: Uint8Array;
	/** Lowercase sha256 hex of the module bytes the image was taken from. */
	module?: string;
	/**
	 * Caller-supplied digest of whatever else shapes the heap (settings, shims, assets); this module
	 * keeps it as an opaque string of at most 4,096 UTF-8 bytes and compares it at replay.
	 */
	context?: string;
	/** Mutable globals whose value differs from the fresh instance, by wasm global index. */
	globals?: Record<number, GlobalValue>;
	/** Function table slots whose function differs from the fresh instance. */
	tableSlots?: number[];
}

/** The same thing read from the booted instance and from a fresh instance of the module. */
export interface BootedAndFresh<T> {
	/** The value on the instance whose boot sequence has run. */
	booted: T;
	/** The value on a fresh instance of the same module. */
	fresh: T;
}

/** Values `captureImage` reads from two instances; the caller supplies them. */
export interface CaptureOptions {
	/** sha256 hex of the module bytes; `moduleDigest(bytes)` computes it. */
	module?: string;
	/** The context digest to record in the image. */
	context?: string;
	/** Global values read from the booted and the fresh instance, by wasm global index. */
	globals?: BootedAndFresh<Record<number, GlobalValue>>;
	/** The `__indirect_function_table` of the booted and the fresh instance. */
	table?: BootedAndFresh<WebAssembly.Table>;
}

/** The result of `imagePages`. */
export interface ImagePages {
	/** Pages the memory must have to take the image. */
	memoryPages: number;
	/** Pages the image carries, each 64 KiB. */
	deltaPages: number;
}

/** What `bakeModule` may do beyond its defaults. */
export interface BakeOptions {
	/** Largest data segment in bytes, a multiple of 65,536 (default 64 MiB). */
	maxSegmentBytes?: number;
	/** Bake an image that reports changed table slots; the caller then restores them itself. */
	allowTableChanges?: boolean;
}

/** What `applyImage` requires of an image; a value the image does not carry or differs in is refused. */
export interface ApplyExpectation {
	/** sha256 hex of the module bytes the memory belongs to. */
	module?: string;
	/** The context digest the replaying site computes. */
	context?: string;
}

/** `ApplyExpectation` plus the one switch `applyImage` has. */
export interface ApplyOptions extends ApplyExpectation {
	/**
	 * Copy the memory pages of an image that also records changed globals or table slots. The copy
	 * does not set them: the instance keeps its fresh values, so it is not a booted instance, and
	 * only the caller can restore them (a module's own globals cannot be written from outside).
	 * Without this flag such an image is refused with code `global` or `table`.
	 */
	memoryOnly?: boolean;
}

/** The result of `checkBaked`. */
export interface BakedCheck {
	/** True when every image page reads back from the module's data segments unchanged. */
	equal: boolean;
	/** Byte offset in memory of the first byte where a baked page differs from the image. */
	firstDifference?: number;
}

/**
 * Why an image does not fit: a wrong module `digest` or `context`, a module with `no-memory` or
 * several `memories`, an image over the memory `maximum`, or a `global` or `table` change the
 * operation cannot write.
 */
export type ImageMismatchCode =
	'digest' | 'context' | 'no-memory' | 'memories' | 'maximum' | 'global' | 'table';

/** The image cannot be baked into this module. */
export class ImageMismatchError extends Error {
	/** The reason, for a caller that handles one mismatch differently from another. */
	readonly code: ImageMismatchCode;

	constructor(code: ImageMismatchCode, detail: string) {
		super(`image does not fit the module (${code}): ${detail}`);
		this.name = 'ImageMismatchError';
		this.code = code;
	}
}

/** Why bytes are not an image: a wrong `magic` or `version`, `truncated` input, or `invalid` contents. */
export type ImageFormatCode = 'magic' | 'version' | 'truncated' | 'invalid';

/** Bytes are not an encoded image, or an image object is inconsistent. */
export class ImageFormatError extends Error {
	/** The reason the bytes were rejected. */
	readonly code: ImageFormatCode;

	constructor(code: ImageFormatCode, detail: string) {
		super(`invalid memory image (${code}): ${detail}`);
		this.name = 'ImageFormatError';
		this.code = code;
	}
}

/** Default cap on one data segment (64 MiB); it bounds the string and heap copy made per segment. */
export const maxSegmentBytes = 64 * 1024 * 1024;

const zeroPage = new Uint8Array(pageBytes);
const hexDigest = /^[0-9a-f]{64}$/;
const maxContextBytes = 4096;
const contextBytes = (context: string) => new TextEncoder().encode(context);

/** Lowercase sha256 hex of module bytes, the form `MemoryImage.module` holds. */
export async function moduleDigest(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Memory size to create for an image, and how many of its pages the image carries. */
export function imagePages(image: MemoryImage): ImagePages {
	return { memoryPages: image.byteLength / pageBytes, deltaPages: image.pages.length };
}

function viewOf(source: MemorySource) {
	if (source instanceof WebAssembly.Memory) return new Uint8Array(source.buffer);
	return source instanceof Uint8Array ? source : new Uint8Array(source);
}

/** Index of the first byte where two pages differ, or -1. */
function firstDifference(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number) {
	const aAt = a.byteOffset + aStart;
	const bAt = b.byteOffset + bStart;
	if (!((aAt | bAt) & 3)) {
		const x = new Uint32Array(a.buffer, aAt, pageBytes / 4);
		const y = new Uint32Array(b.buffer, bAt, pageBytes / 4);
		for (let i = 0; i < x.length; i++) {
			if (x[i] === y[i]) continue;
			for (let k = i * 4; ; k++) if (a[aStart + k] !== b[bStart + k]) return k;
		}
		return -1;
	}
	for (let i = 0; i < pageBytes; i++) if (a[aStart + i] !== b[bStart + i]) return i;
	return -1;
}

function assertImage(image: MemoryImage) {
	const bad = (detail: string) => new ImageFormatError('invalid', detail);
	if (!Number.isInteger(image.byteLength) || image.byteLength < 0 || image.byteLength % pageBytes)
		throw bad(`byteLength ${image.byteLength} is not a multiple of ${pageBytes}`);
	const total = image.byteLength / pageBytes;
	let last = -1;
	for (const page of image.pages) {
		if (!Number.isInteger(page) || page <= last || page >= total)
			throw bad(`page ${page} is out of order or beyond ${total} pages`);
		last = page;
	}
	if (image.data.length !== image.pages.length * pageBytes)
		throw bad(`data holds ${image.data.length} bytes for ${image.pages.length} pages`);
	if (image.module !== undefined && !hexDigest.test(image.module))
		throw bad('module is not 64 lowercase hex characters');
	if (image.context !== undefined) {
		const size = contextBytes(image.context).length;
		if (size === 0 || size > maxContextBytes)
			throw bad(`context is ${size} bytes, it must hold 1 to ${maxContextBytes}`);
	}
}

/**
 * Compares a booted memory with a fresh instance of the same module, page by page. A fresh memory
 * shorter than the booted one counts as zero past its end; a longer one is refused. A page the boot
 * zeroed that the module's own data had set is a delta page and ships as zeros.
 */
export function captureImage(
	booted: MemorySource,
	fresh: MemorySource,
	options: CaptureOptions = {}
): MemoryImage {
	const after = viewOf(booted);
	const before = viewOf(fresh);
	if (after.length % pageBytes || before.length % pageBytes)
		throw new RangeError('memory sizes must be multiples of 65,536 bytes');
	if (before.length > after.length)
		throw new RangeError('the fresh memory is larger than the booted memory');
	const pages: number[] = [];
	for (let page = 0; page < after.length / pageBytes; page++) {
		const start = page * pageBytes;
		const same =
			start < before.length
				? firstDifference(after, start, before, start)
				: firstDifference(after, start, zeroPage, 0);
		if (same >= 0) pages.push(page);
	}
	const data = new Uint8Array(pages.length * pageBytes);
	pages.forEach((page, i) =>
		data.set(after.subarray(page * pageBytes, (page + 1) * pageBytes), i * pageBytes)
	);
	const image: MemoryImage = { byteLength: after.length, pages, data };
	if (options.module !== undefined) {
		if (!hexDigest.test(options.module))
			throw new TypeError('module must be 64 lowercase hex characters');
		image.module = options.module;
	}
	if (options.context !== undefined) {
		const size = contextBytes(options.context).length;
		if (size === 0 || size > maxContextBytes)
			throw new TypeError(`context must hold 1 to ${maxContextBytes} UTF-8 bytes`);
		image.context = options.context;
	}
	if (options.globals) {
		const changed: Record<number, GlobalValue> = {};
		for (const [key, value] of Object.entries(options.globals.booted)) {
			const initial = options.globals.fresh[Number(key)];
			if (initial === undefined) throw new TypeError(`no fresh value for global ${key}`);
			if (!Object.is(value, initial)) changed[Number(key)] = value;
		}
		if (Object.keys(changed).length) image.globals = changed;
	}
	if (options.table) {
		const slots: number[] = [];
		const { booted: now, fresh: then } = options.table;
		for (let slot = 0; slot < Math.max(now.length, then.length); slot++) {
			const a = slot < now.length ? now.get(slot) : null;
			const b = slot < then.length ? then.get(slot) : null;
			if ((a?.name ?? null) !== (b?.name ?? null)) slots.push(slot);
		}
		if (slots.length) image.tableSlots = slots;
	}
	return image;
}

/**
 * Copies the image pages into a live memory, which must hold a fresh instance's contents; the
 * memory grows to the image size first. Globals and table slots are not restored, so an image that
 * records changed ones is refused with `ImageMismatchError` code `global` or `table` unless
 * `memoryOnly` is set; `bakeModule` is the route that writes changed globals into the module.
 *
 * `expect` names the module and context digests of the site doing the replay. Each one given must
 * equal the image's own, so an image that carries none is refused too; `ImageMismatchError` has
 * code `digest` or `context`, and nothing is written to the memory.
 */
export function applyImage(
	memory: WebAssembly.Memory,
	image: MemoryImage,
	expect: ApplyOptions = {}
): void {
	assertImage(image);
	for (const [field, code] of [
		['module', 'digest'],
		['context', 'context']
	] as const) {
		const wanted = expect[field];
		if (wanted !== undefined && image[field] !== wanted)
			throw new ImageMismatchError(
				code,
				`replay expects ${field} ${wanted}, image has ${image[field] ?? 'none'}`
			);
	}
	if (!expect.memoryOnly) {
		const globals = Object.keys(image.globals ?? {}).length;
		if (globals)
			throw new ImageMismatchError(
				'global',
				`the image records ${globals} changed global(s) that applyImage cannot set; use bakeModule or pass memoryOnly`
			);
		const slots = image.tableSlots?.length ?? 0;
		if (slots)
			throw new ImageMismatchError(
				'table',
				`the image records ${slots} changed table slot(s) that applyImage cannot set; use bakeModule or pass memoryOnly`
			);
	}
	const needed = image.byteLength / pageBytes;
	const have = memory.buffer.byteLength / pageBytes;
	if (have < needed) memory.grow(needed - have);
	const target = new Uint8Array(memory.buffer);
	image.pages.forEach((page, i) =>
		target.set(image.data.subarray(i * pageBytes, (i + 1) * pageBytes), page * pageBytes)
	);
}

const magic = [0x46, 0x49, 0x4d, 0x47];
const version = 1;
const hasDigest = 1;
const hasGlobals = 2;
const hasTable = 4;
const hasContext = 8;

/**
 * Serializes an image, little endian: magic `FIMG`, u32 version (1), u32 flags (1 digest, 2
 * globals, 4 table slots, 8 context), u32 memory pages, u32 delta pages, then in this order the 32
 * digest bytes, the context (u32 byte count, then UTF-8), the globals (u32 count, then per entry
 * u32 index, u8 kind 0 for a number as f64 or 1 for a bigint as i64, 8 value bytes), the table
 * slots (u32 count, u32 each), the u32 page indexes and the page bytes.
 */
export function encodeImage(image: MemoryImage): Uint8Array {
	assertImage(image);
	const globals = Object.entries(image.globals ?? {});
	const slots = image.tableSlots ?? [];
	const context = image.context === undefined ? undefined : contextBytes(image.context);
	const flags =
		(image.module ? hasDigest : 0) |
		(context ? hasContext : 0) |
		(globals.length ? hasGlobals : 0) |
		(slots.length ? hasTable : 0);
	const head =
		20 +
		(image.module ? 32 : 0) +
		(context ? 4 + context.length : 0) +
		(globals.length ? 4 + globals.length * 13 : 0) +
		(slots.length ? 4 + slots.length * 4 : 0) +
		image.pages.length * 4;
	const out = new Uint8Array(head + image.data.length);
	const view = new DataView(out.buffer);
	out.set(magic);
	view.setUint32(4, version, true);
	view.setUint32(8, flags, true);
	view.setUint32(12, image.byteLength / pageBytes, true);
	view.setUint32(16, image.pages.length, true);
	let at = 20;
	if (image.module) {
		for (let i = 0; i < 32; i++)
			out[at + i] = parseInt(image.module.slice(i * 2, i * 2 + 2), 16);
		at += 32;
	}
	if (context) {
		view.setUint32(at, context.length, true);
		out.set(context, at + 4);
		at += 4 + context.length;
	}
	if (globals.length) {
		view.setUint32(at, globals.length, true);
		at += 4;
		for (const [key, value] of globals) {
			view.setUint32(at, Number(key), true);
			if (typeof value === 'bigint') {
				view.setUint8(at + 4, 1);
				view.setBigInt64(at + 5, value, true);
			} else {
				view.setUint8(at + 4, 0);
				view.setFloat64(at + 5, value, true);
			}
			at += 13;
		}
	}
	if (slots.length) {
		view.setUint32(at, slots.length, true);
		at += 4;
		for (const slot of slots) {
			view.setUint32(at, slot, true);
			at += 4;
		}
	}
	for (const page of image.pages) {
		view.setUint32(at, page, true);
		at += 4;
	}
	out.set(image.data, at);
	return out;
}

/** Parses `encodeImage` output; `data` is a view into `bytes`, not a copy. */
export function decodeImage(bytes: Uint8Array): MemoryImage {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
	let at = 0;
	const need = (count: number) => {
		if (at + count > bytes.length)
			throw new ImageFormatError(
				'truncated',
				`needs ${at + count} bytes, has ${bytes.length}`
			);
	};
	need(20);
	if (!magic.every((value, i) => bytes[i] === value))
		throw new ImageFormatError('magic', 'the bytes do not start with FIMG');
	const found = view.getUint32(4, true);
	if (found !== version)
		throw new ImageFormatError('version', `version ${found}, this reader knows ${version}`);
	const flags = view.getUint32(8, true);
	if (flags & ~15) throw new ImageFormatError('invalid', `unknown flags ${flags}`);
	const memoryPages = view.getUint32(12, true);
	const count = view.getUint32(16, true);
	at = 20;
	const image: MemoryImage = { byteLength: memoryPages * pageBytes, pages: [], data: bytes };
	if (flags & hasDigest) {
		need(32);
		image.module = Array.from(bytes.subarray(at, at + 32), (b) =>
			b.toString(16).padStart(2, '0')
		).join('');
		at += 32;
	}
	if (flags & hasContext) {
		need(4);
		const size = view.getUint32(at, true);
		at += 4;
		need(size);
		try {
			image.context = new TextDecoder('utf-8', { fatal: true }).decode(
				bytes.subarray(at, at + size)
			);
		} catch {
			throw new ImageFormatError('invalid', 'context is not UTF-8');
		}
		at += size;
	}
	if (flags & hasGlobals) {
		need(4);
		const total = view.getUint32(at, true);
		at += 4;
		need(total * 13);
		image.globals = {};
		for (let i = 0; i < total; i++, at += 13) {
			const kind = view.getUint8(at + 4);
			if (kind > 1) throw new ImageFormatError('invalid', `unknown global kind ${kind}`);
			image.globals[view.getUint32(at, true)] =
				kind === 1 ? view.getBigInt64(at + 5, true) : view.getFloat64(at + 5, true);
		}
	}
	if (flags & hasTable) {
		need(4);
		const total = view.getUint32(at, true);
		at += 4;
		need(total * 4);
		image.tableSlots = Array.from({ length: total }, (_, i) =>
			view.getUint32(at + i * 4, true)
		);
		at += total * 4;
	}
	need(count * 4);
	image.pages = Array.from({ length: count }, (_, i) => view.getUint32(at + i * 4, true));
	at += count * 4;
	const length = count * pageBytes;
	need(length);
	if (at + length !== bytes.length)
		throw new ImageFormatError('invalid', `${bytes.length - at - length} trailing bytes`);
	image.data = bytes.subarray(at, at + length);
	assertImage(image);
	return image;
}

interface Cursor {
	bytes: Uint8Array;
	at: number;
}

const truncatedModule = () => new RangeError('truncated wasm module');

function byte(c: Cursor) {
	if (c.at >= c.bytes.length) throw truncatedModule();
	return c.bytes[c.at++]!;
}

function uleb(c: Cursor, limit: number) {
	let value = 0;
	for (let shift = 0; shift < limit * 7; shift += 7) {
		const part = byte(c);
		value += (part & 127) * 2 ** shift;
		if (!(part & 128)) {
			if (!Number.isSafeInteger(value)) throw new RangeError('wasm integer beyond 2^53');
			return value;
		}
	}
	throw new RangeError('invalid wasm integer');
}

const u32 = (c: Cursor) => uleb(c, 5);
const u64 = (c: Cursor) => uleb(c, 10);

function s64(c: Cursor) {
	let value = 0n;
	for (let shift = 0n; shift < 70n; shift += 7n) {
		const part = byte(c);
		value |= BigInt(part & 127) << shift;
		if (!(part & 128)) {
			if (shift < 56n && part & 64) value -= 1n << (shift + 7n);
			if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
				throw new RangeError('unsupported data segment offset');
			return Number(value);
		}
	}
	throw new RangeError('invalid wasm integer');
}

function leb(value: number) {
	const out: number[] = [];
	do {
		const part = value % 128;
		value = Math.floor(value / 128);
		out.push(value ? part | 128 : part);
	} while (value);
	return out;
}

function s32(c: Cursor) {
	let value = 0;
	for (let shift = 0; shift < 35; shift += 7) {
		const part = byte(c);
		value |= (part & 127) << shift;
		if (!(part & 128)) return shift < 25 && part & 64 ? value | (-1 << (shift + 7)) : value;
	}
	throw new RangeError('invalid wasm integer');
}

function name(c: Cursor) {
	const length = u32(c);
	if (c.at + length > c.bytes.length) throw truncatedModule();
	const value = new TextDecoder().decode(c.bytes.subarray(c.at, c.at + length));
	c.at += length;
	return value;
}

/** Calls `visit` with a section's id, a cursor at its body, its end and its start; stops on `false`. */
function eachSection(
	bytes: Uint8Array,
	visit: (id: number, c: Cursor, end: number, start: number) => unknown
) {
	const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
	if (bytes.length < 8 || !header.every((value, i) => bytes[i] === value))
		throw new RangeError('not a wasm module');
	const c: Cursor = { bytes, at: 8 };
	while (c.at < bytes.length) {
		const start = c.at;
		const id = byte(c);
		const length = u32(c);
		const end = c.at + length;
		if (end > bytes.length) throw truncatedModule();
		if (visit(id, c, end, start) === false) return;
		c.at = end;
	}
}

interface MemoryZero {
	imported: boolean;
	initial: number;
	maximum?: number;
	shared: boolean;
	memory64: boolean;
}

/**
 * Reads memory 0 from the import and memory sections, without binaryen. `raise(pages)` returns the
 * bytes with a defined memory's initial pages raised to `pages` (the same bytes if it is already
 * large enough or imported); only the memory section is rewritten, so data segments, names and
 * every other section stay as they are.
 */
function findMemory(bytes: Uint8Array) {
	const imported = memoryImports(bytes)[0];
	if (imported) {
		const { initial, maximum, shared, memory64 } = imported;
		const memory: MemoryZero = { imported: true, initial, maximum, shared, memory64 };
		return { memory, raise: () => bytes };
	}
	let found: { memory: MemoryZero; raise: (pages: number) => Uint8Array } | undefined;
	eachSection(bytes, (id, c, end, start) => {
		if (id !== 5) return;
		const body = c.at;
		if (u32(c) === 0) return false;
		const flags = u32(c);
		if (flags & ~7) throw new RangeError(`unsupported memory flags ${flags}`);
		const limit = flags & 4 ? u64 : u32;
		const from = c.at;
		const initial = limit(c);
		const to = c.at;
		const maximum = flags & 1 ? limit(c) : undefined;
		const memory: MemoryZero = {
			imported: false,
			initial,
			maximum,
			shared: Boolean(flags & 2),
			memory64: Boolean(flags & 4)
		};
		const raise = (pages: number) => {
			if (pages <= initial) return bytes;
			const inner = [
				...bytes.subarray(body, from),
				...leb(pages),
				...bytes.subarray(to, end)
			];
			return Uint8Array.from([
				...bytes.subarray(0, start),
				id,
				...leb(inner.length),
				...inner,
				...bytes.subarray(end)
			]);
		};
		found = { memory, raise };
		return false;
	});
	return found;
}

/** Imported plus defined memories. */
function memoryCount(bytes: Uint8Array) {
	let defined = 0;
	eachSection(bytes, (id, c) => {
		if (id !== 5) return;
		defined = u32(c);
		return false;
	});
	return memoryImports(bytes).length + defined;
}

/**
 * The name binaryen gives memory 0: the names section entry when there is one, else `mimport$0`
 * for an imported memory and `0` for a defined one.
 */
function memoryName(bytes: Uint8Array, imported: boolean) {
	let found = imported ? 'mimport$0' : '0';
	eachSection(bytes, (id, c, end) => {
		if (id !== 0 || name(c) !== 'name') return;
		while (c.at < end) {
			const sub = byte(c);
			const size = u32(c);
			const stop = c.at + size;
			if (sub === 6) {
				for (let n = u32(c); n > 0; n--) {
					const index = u32(c);
					const value = name(c);
					if (index === 0) found = value;
				}
				return false;
			}
			c.at = stop;
		}
	});
	return found;
}

/** Active data segments of memory 0 with constant offsets; any other offset form is refused. */
function activeSegments(bytes: Uint8Array) {
	const segments: { offset: number; data: Uint8Array }[] = [];
	eachSection(bytes, (id, c) => {
		if (id !== 11) return;
		for (let n = u32(c); n > 0; n--) {
			const flags = u32(c);
			if (flags > 2) throw new RangeError(`unsupported data segment flags ${flags}`);
			const memory = flags === 2 ? u32(c) : 0;
			let offset = 0;
			if (flags !== 1) {
				const opcode = byte(c);
				if (opcode === 0x41) offset = s32(c) >>> 0;
				else if (opcode === 0x42) offset = s64(c);
				else throw new RangeError('unsupported data segment offset');
				if (byte(c) !== 0x0b) throw new RangeError('unsupported data segment offset');
			}
			const length = u32(c);
			if (c.at + length > bytes.length) throw truncatedModule();
			if (flags !== 1 && memory === 0)
				segments.push({ offset, data: bytes.subarray(c.at, c.at + length) });
			c.at += length;
		}
		return false;
	});
	return segments;
}

/**
 * Plays a baked module's active data segments over zeroed memory and compares each image page
 * with the result, without instantiating. It reads the module bytes directly, so it works the same
 * whether memory 0 is imported or defined. Passive segments are ignored, an offset other than
 * `i32.const` or `i64.const` throws, and only the image pages are checked, not globals or other
 * pages.
 */
export function checkBaked(baked: Uint8Array, image: MemoryImage): BakedCheck {
	assertImage(image);
	const memory = new Uint8Array(image.byteLength);
	for (const { offset, data } of activeSegments(baked))
		if (offset < memory.length) memory.set(data.subarray(0, memory.length - offset), offset);
	for (let i = 0; i < image.pages.length; i++) {
		const diff = firstDifference(
			memory,
			image.pages[i]! * pageBytes,
			image.data,
			i * pageBytes
		);
		if (diff >= 0) return { equal: false, firstDifference: image.pages[i]! * pageBytes + diff };
	}
	return { equal: true };
}

/** One occurrence of a needle in an image. */
export interface ImageMatch {
	/** Index into the `needles` array passed to `findInImage`. */
	needle: number;
	/** Byte offset in the image's memory. */
	offset: number;
}

/**
 * Every offset at which a needle's bytes occur in the image pages, ascending per needle. A match
 * may span adjacent image pages and never spans a gap, so a needle straddling a delta page and an
 * unchanged page is not found. Overlapping matches are all reported. A baked image is public, so
 * this is how to prove a secret is not in it: pass the secret as bytes, and its base64 and hex
 * forms as further needles.
 */
export function findInImage(image: MemoryImage, needles: Uint8Array[]): ImageMatch[] {
	assertImage(image);
	needles.forEach((needle, i) => {
		if (!needle.length) throw new TypeError(`needle ${i} is empty`);
	});
	const found: ImageMatch[] = [];
	for (let i = 0; i < image.pages.length;) {
		let j = i;
		while (j + 1 < image.pages.length && image.pages[j + 1] === image.pages[j]! + 1) j++;
		const run = image.data.subarray(i * pageBytes, (j + 1) * pageBytes);
		const base = image.pages[i]! * pageBytes;
		needles.forEach((needle, index) => {
			for (let at = run.indexOf(needle[0]!); at >= 0; at = run.indexOf(needle[0]!, at + 1)) {
				if (at + needle.length > run.length) break;
				let k = 1;
				while (k < needle.length && run[at + k] === needle[k]) k++;
				if (k === needle.length) found.push({ needle: index, offset: base + at });
			}
		});
		i = j + 1;
	}
	return found.sort((a, b) => a.needle - b.needle || a.offset - b.offset);
}

const latin1 = (data: Uint8Array) => {
	let text = '';
	for (let at = 0; at < data.length; at += 8192)
		text += String.fromCharCode(...data.subarray(at, at + 8192));
	return text;
};

/** appends one active segment through the C entry point; setMemory drops the module's own segments */
function addSegment(
	binaryen: Binaryen,
	mod: ReturnType<Binaryen['readBinary']>,
	segment: string,
	memory: string,
	offset: number,
	data: Uint8Array,
	memory64: boolean
) {
	const api = binaryen as any;
	const pointers: number[] = [];
	const text = (value: string) => {
		const pointer = api._malloc(value.length + 1);
		api.stringToAscii(value, pointer);
		pointers.push(pointer);
		return pointer;
	};
	const segmentName = text(segment);
	const memoryName = text(memory);
	const bytes = text(latin1(data));
	api._BinaryenAddDataSegment(
		mod.ptr,
		segmentName,
		memoryName,
		0,
		memory64 ? mod.i64.const(BigInt(offset)) : mod.i32.const(offset | 0),
		bytes,
		data.length
	);
	pointers.forEach((pointer) => api._free(pointer));
}

function setGlobal(
	binaryen: Binaryen,
	mod: ReturnType<Binaryen['readBinary']>,
	index: number,
	value: GlobalValue
) {
	const api = binaryen as any;
	const refuse = (detail: string) =>
		new ImageMismatchError('global', `global ${index} ${detail}`);
	if (!Number.isInteger(index) || index < 0 || index >= mod.getNumGlobals())
		throw refuse('does not exist');
	const info = binaryen.getGlobalInfo(mod.getGlobalByIndex(index));
	if (!info.mutable) throw refuse('is not mutable');
	if (!info.init || binaryen.getExpressionId(info.init) !== binaryen.ConstId)
		throw refuse('is imported or has no constant initial value');
	const type = info.type;
	if (type === binaryen.i32 && typeof value === 'number' && Number.isInteger(value))
		api._BinaryenConstSetValueI32(info.init, value | 0);
	else if (type === binaryen.i64 && typeof value === 'bigint')
		api._BinaryenConstSetValueI64(info.init, BigInt.asIntN(64, value));
	else if (type === binaryen.f32 && typeof value === 'number')
		api._BinaryenConstSetValueF32(info.init, value);
	else if (type === binaryen.f64 && typeof value === 'number')
		api._BinaryenConstSetValueF64(info.init, value);
	else throw refuse(`has a type that ${typeof value} does not fit`);
}

/**
 * Returns the module with the image pages as active data segments after its own segments, and
 * the image's changed mutable globals written as their initial values. Adjacent pages merge into
 * one segment, split at `maxSegmentBytes`. The module must have exactly one memory.
 *
 * An imported memory is left alone: whoever instantiates the baked module creates it with at least
 * `imagePages(image).memoryPages` pages. A defined memory whose initial pages are below the image
 * size has them raised to the image size (only the memory section changes); its maximum, shared
 * flag and memory64 flag stay as they are, and one already large enough is untouched.
 *
 * Throws `ImageMismatchError` for a wrong module digest (taken over `bytes` as passed), a module
 * with no memory or with more than one, an image over the memory maximum, a global that cannot be rewritten and changed
 * table slots (unless `allowTableChanges`).
 */
export async function bakeModule(
	bytes: Uint8Array,
	image: MemoryImage,
	options: BakeOptions = {}
): Promise<Uint8Array> {
	assertImage(image);
	const cap = options.maxSegmentBytes ?? maxSegmentBytes;
	if (!Number.isInteger(cap) || cap < pageBytes || cap % pageBytes)
		throw new RangeError('maxSegmentBytes must be a positive multiple of 65,536');
	if (image.module !== undefined) {
		const found = await moduleDigest(bytes);
		if (found !== image.module)
			throw new ImageMismatchError(
				'digest',
				`image is for ${image.module}, module is ${found}`
			);
	}
	if (image.tableSlots?.length && !options.allowTableChanges)
		throw new ImageMismatchError(
			'table',
			`boot changed ${image.tableSlots.length} table slots`
		);
	const located = findMemory(bytes);
	if (!located) throw new ImageMismatchError('no-memory', 'no memory');
	const memories = memoryCount(bytes);
	if (memories > 1)
		throw new ImageMismatchError(
			'memories',
			`module has ${memories} memories, only 1 is baked`
		);
	const { memory: zero } = located;
	const pages = image.byteLength / pageBytes;
	if (zero.maximum !== undefined && pages > zero.maximum)
		throw new ImageMismatchError(
			'maximum',
			`image has ${pages} pages, maximum is ${zero.maximum}`
		);
	const binaryen: Binaryen = (await import('binaryen')).default;
	const mod = binaryen.readBinary(located.raise(pages));
	try {
		for (const [key, value] of Object.entries(image.globals ?? {}))
			setGlobal(binaryen, mod, Number(key), value);
		const memory = memoryName(bytes, zero.imported);
		let count = 0;
		const fresh = () => {
			while (mod.getDataSegment(`folio_image${count}`)) count++;
			return `folio_image${count++}`;
		};
		for (let i = 0; i < image.pages.length;) {
			let j = i;
			while (j + 1 < image.pages.length && image.pages[j + 1] === image.pages[j]! + 1) j++;
			for (let from = i; from <= j; from += cap / pageBytes) {
				const to = Math.min(j + 1, from + cap / pageBytes);
				addSegment(
					binaryen,
					mod,
					fresh(),
					memory,
					image.pages[from]! * pageBytes,
					image.data.subarray(from * pageBytes, to * pageBytes),
					zero.memory64
				);
			}
			i = j + 1;
		}
		return mod.emitBinary();
	} finally {
		mod.dispose();
	}
}
