import type { GlobalValue } from './bake.ts';
import { pageBytes } from './pages.ts';

/** The subset of a Durable Object SQL handle this module uses. */
export interface SqlStorage {
	exec(
		query: string,
		...bindings: (string | number | null | ArrayBuffer)[]
	): {
		toArray(): Record<string, unknown>[];
	};
}

/** The subset of a Durable Object storage handle this module uses. */
export interface DurableObjectStorage {
	readonly sql: SqlStorage;
	transactionSync<T>(closure: () => T): T;
	sync(): Promise<void>;
	setAlarm(scheduledTime: number | Date): Promise<void>;
}

/** The platform CPU warning, read from the `__instance_signal` word of a guest. */
export interface CpuSignal {
	/** Byte address of the u32 word in the guest memory. */
	readonly address: number;
	/** True when the word is nonzero. */
	readonly raised: boolean;
	/** Writes 0 to the word. */
	clear(): void;
}

/** The CPU warning of an instance, or undefined when it does not export `__instance_signal`. */
export function cpuSignal(
	instance: WebAssembly.Instance,
	memory?: WebAssembly.Memory
): CpuSignal | undefined {
	const exported = instance.exports.__instance_signal;
	if (!(exported instanceof WebAssembly.Global)) return undefined;
	const target = memory ?? instance.exports.memory;
	if (!(target instanceof WebAssembly.Memory))
		throw new TypeError('cpuSignal needs the memory the instance uses');
	const address = exported.value as number;
	if (!Number.isInteger(address) || address < 0 || address + 4 > target.buffer.byteLength)
		throw new RangeError(`__instance_signal ${address} lies outside the memory`);
	const word = () => new DataView(target.buffer, address, 4);
	return {
		address,
		get raised() {
			return word().getUint32(0, true) !== 0;
		},
		clear() {
			word().setUint32(0, 0, true);
		}
	};
}

const seedHi = 0x243f6a88;
const seedLo = 0x85a308d3;
const primeHi = 0x9e3779b9;
const primeLo = 0x7f4a7c15;
const pageWords = pageBytes / 4;

// high 32 bits of a uint32 times a uint32, from 16-bit halves
function mulHigh(a: number, b: number): number {
	const a0 = a & 0xffff;
	const a1 = a >>> 16;
	const b0 = b & 0xffff;
	const b1 = b >>> 16;
	const p01 = a0 * b1;
	const p10 = a1 * b0;
	const mid = ((a0 * b0) >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
	return a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
}

function wordsOf(bytes: Uint8Array): Uint32Array {
	if (bytes.byteOffset % 4 === 0)
		return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
	return new Uint32Array(bytes.slice().buffer);
}

/**
 * Hashes each 64 KiB page into two u32 words (low, high). A change detector, not a security hash;
 * the words are read little-endian, as every supported host is.
 */
export function hashPages(memory: WebAssembly.Memory | Uint8Array): Uint32Array {
	const bytes = memory instanceof WebAssembly.Memory ? new Uint8Array(memory.buffer) : memory;
	if (bytes.length % pageBytes)
		throw new RangeError(`hashPages needs whole ${pageBytes} byte pages, got ${bytes.length}`);
	const words = wordsOf(bytes);
	const pages = bytes.length / pageBytes;
	const out = new Uint32Array(pages * 2);
	for (let page = 0; page < pages; page++) {
		let hi = seedHi;
		let lo = seedLo;
		for (let w = page * pageWords; w < (page + 1) * pageWords; w += 2) {
			lo ^= words[w]!;
			hi ^= words[w + 1]!;
			// (hi:lo) * prime mod 2^64, then h ^= h >>> 32
			const productLo = Math.imul(lo, primeLo);
			const productHi =
				(mulHigh(lo >>> 0, primeLo) + Math.imul(lo, primeHi) + Math.imul(hi, primeLo)) >>>
				0;
			lo = productLo ^ productHi;
			hi = productHi;
		}
		out[page * 2] = lo;
		out[page * 2 + 1] = hi;
	}
	return out;
}

/** Page indexes whose hash differs from the previous checkpoint, or every page when there is none. */
export function changedPages(current: Uint32Array, previous: Uint32Array | undefined): number[] {
	if (current.length % 2 || (previous && previous.length % 2))
		throw new RangeError('page hashes come in pairs of words');
	const pages = current.length / 2;
	const known = previous ? previous.length / 2 : 0;
	const changed: number[] = [];
	for (let page = 0; page < pages; page++) {
		if (
			page >= known ||
			current[page * 2] !== previous![page * 2] ||
			current[page * 2 + 1] !== previous![page * 2 + 1]
		)
			changed.push(page);
	}
	return changed;
}

/** One committed checkpoint. */
export interface CheckpointManifest {
	epoch: number;
	byteLength: number;
	hashes: Uint32Array;
	globals: Record<string, number | bigint>;
	state?: string;
}

/** Storage behind a checkpoint. `commit` is all or nothing; `pages` returns the newest copy at or below `epoch`. */
export interface CheckpointStore {
	latest(): CheckpointManifest | undefined;
	pages(epoch: number, indexes: number[]): Map<number, Uint8Array>;
	commit(manifest: CheckpointManifest, pages: Map<number, Uint8Array>): void;
}

/** A checkpoint that cannot be loaded: a `hash`, `size`, `global` or `manifest` mismatch. */
export class CheckpointError extends Error {
	readonly code: 'hash' | 'size' | 'global' | 'manifest';

	constructor(code: 'hash' | 'size' | 'global' | 'manifest', detail: string) {
		super(`checkpoint refused (${code}): ${detail}`);
		this.name = 'CheckpointError';
		this.code = code;
	}
}

/** In-process store for tests and Node. Keeps the newest copy of each page. */
export function memoryCheckpointStore(): CheckpointStore {
	let latest: CheckpointManifest | undefined;
	const copies = new Map<number, { epoch: number; bytes: Uint8Array }>();
	return {
		latest: () => latest,
		pages(epoch, indexes) {
			const found = new Map<number, Uint8Array>();
			for (const index of indexes) {
				const copy = copies.get(index);
				if (copy && copy.epoch <= epoch) found.set(index, copy.bytes);
			}
			return found;
		},
		commit(manifest, pages) {
			if (latest && manifest.epoch <= latest.epoch)
				throw new RangeError(
					`checkpoint epoch ${manifest.epoch} does not follow ${latest.epoch}`
				);
			for (const [index, bytes] of pages) {
				if (bytes.length !== pageBytes)
					throw new RangeError('page bytes must be 65,536 long');
				copies.set(index, { epoch: manifest.epoch, bytes });
			}
			latest = manifest;
		}
	};
}

interface SqlStoreOptions {
	prefix?: string;
	groupPages?: number;
}

type Row = Record<string, unknown>;

const blob = (value: unknown) =>
	value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);

function encodeGlobals(globals: Record<string, number | bigint>): string {
	return JSON.stringify(
		Object.entries(globals).map(([name, value]) => [name, typeof value, String(value)])
	);
}

function decodeGlobals(text: string): Record<string, number | bigint> {
	const out: Record<string, number | bigint> = {};
	for (const [name, kind, value] of JSON.parse(text) as [string, string, string][])
		out[name] = kind === 'bigint' ? BigInt(value) : Number(value);
	return out;
}

// the commit writes group rows, then the manifest, then prunes; any prefix of that leaves the
// previous manifest whole, so the store needs no transaction of its own
function openSqlStore(sql: SqlStorage, options: SqlStoreOptions = {}, guard?: () => void) {
	const prefix = options.prefix ?? 'continuation_';
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
		throw new TypeError('prefix must be a SQL identifier');
	const groupPages = options.groupPages ?? 16;
	if (!Number.isInteger(groupPages) || groupPages < 1)
		throw new RangeError('groupPages must be a positive integer');
	const groupBytes = groupPages * pageBytes;
	const groups = `${prefix}groups`;
	const manifests = `${prefix}manifest`;
	const run = (query: string, ...bindings: (string | number | null | ArrayBuffer)[]): Row[] =>
		sql.exec(query, ...bindings).toArray();

	run(
		`CREATE TABLE IF NOT EXISTS ${groups} (g INTEGER NOT NULL, epoch INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (g, epoch))`
	);
	run(
		`CREATE TABLE IF NOT EXISTS ${manifests} (epoch INTEGER PRIMARY KEY, byte_length INTEGER NOT NULL, hashes BLOB NOT NULL, globals TEXT NOT NULL, state TEXT)`
	);

	const rowAt = (g: number, epoch: number): Uint8Array | undefined => {
		const row = run(
			`SELECT bytes FROM ${groups} WHERE g = ? AND epoch <= ? ORDER BY epoch DESC LIMIT 1`,
			g,
			epoch
		)[0];
		return row ? blob(row.bytes) : undefined;
	};
	const latestRow = () => run(`SELECT * FROM ${manifests} ORDER BY epoch DESC LIMIT 1`)[0];

	return {
		latest(): CheckpointManifest | undefined {
			const row = latestRow();
			if (!row) return undefined;
			return {
				epoch: Number(row.epoch),
				byteLength: Number(row.byte_length),
				hashes: new Uint32Array(blob(row.hashes).slice().buffer),
				globals: decodeGlobals(String(row.globals)),
				state: row.state === null ? undefined : String(row.state)
			};
		},
		pages(epoch: number, indexes: number[]): Map<number, Uint8Array> {
			const found = new Map<number, Uint8Array>();
			const rows = new Map<number, Uint8Array | undefined>();
			for (const index of indexes) {
				const g = Math.floor(index / groupPages);
				if (!rows.has(g)) rows.set(g, rowAt(g, epoch));
				const row = rows.get(g);
				if (!row) continue;
				const at = (index - g * groupPages) * pageBytes;
				found.set(index, row.slice(at, at + pageBytes));
			}
			return found;
		},
		commit(manifest: CheckpointManifest, pages: Map<number, Uint8Array>): void {
			const head = latestRow();
			const last = head ? Number(head.epoch) : 0;
			if (manifest.epoch <= last)
				throw new RangeError(`checkpoint epoch ${manifest.epoch} does not follow ${last}`);
			const byGroup = new Map<number, [number, Uint8Array][]>();
			for (const [index, bytes] of pages) {
				if (bytes.length !== pageBytes)
					throw new RangeError('page bytes must be 65,536 long');
				const g = Math.floor(index / groupPages);
				byGroup.set(g, [...(byGroup.get(g) ?? []), [index, bytes]]);
			}
			run(`DELETE FROM ${groups} WHERE epoch > ?`, last);
			const changed = [...byGroup.keys()].sort((a, b) => a - b);
			for (const g of changed) {
				const row = new Uint8Array(groupBytes);
				const base = rowAt(g, last);
				if (base) row.set(base);
				for (const [index, bytes] of byGroup.get(g)!)
					row.set(bytes, (index - g * groupPages) * pageBytes);
				run(
					`INSERT INTO ${groups} (g, epoch, bytes) VALUES (?, ?, ?)`,
					g,
					manifest.epoch,
					row.buffer
				);
				guard?.();
			}
			run(
				`INSERT INTO ${manifests} (epoch, byte_length, hashes, globals, state) VALUES (?, ?, ?, ?, ?)`,
				manifest.epoch,
				manifest.byteLength,
				manifest.hashes.slice().buffer,
				encodeGlobals(manifest.globals),
				manifest.state ?? null
			);
			for (const g of changed)
				run(`DELETE FROM ${groups} WHERE g = ? AND epoch < ?`, g, manifest.epoch);
			run(`DELETE FROM ${manifests} WHERE epoch < ?`, manifest.epoch);
		}
	};
}

/** DO SQLite store with one row per group of `groupPages` pages (default 16, 1 MiB). Keep one value of `groupPages` per prefix. Commit must run in one synchronous span. */
export function sqlCheckpointStore(sql: SqlStorage, options?: SqlStoreOptions): CheckpointStore {
	return openSqlStore(sql, options);
}

/** Options for `saveCheckpoint`. */
export interface SaveOptions {
	globals?: Record<string, WebAssembly.Global>;
	state?: string;
	stateJson?: unknown;
}

/** Writes the pages that changed since the last manifest, with the globals and host state. */
export function saveCheckpoint(
	store: CheckpointStore,
	memory: WebAssembly.Memory,
	options: SaveOptions = {}
): { epoch: number; pagesWritten: number; bytesWritten: number } {
	if (options.state !== undefined && options.stateJson !== undefined)
		throw new TypeError('pass state or stateJson, not both');
	const hashes = hashPages(memory);
	const previous = store.latest();
	const changed = changedPages(hashes, previous?.hashes);
	const view = new Uint8Array(memory.buffer);
	const pages = new Map<number, Uint8Array>();
	for (const page of changed)
		pages.set(page, view.slice(page * pageBytes, (page + 1) * pageBytes));
	const epoch = (previous?.epoch ?? 0) + 1;
	const globals: Record<string, GlobalValue> = {};
	for (const [name, global] of Object.entries(options.globals ?? {}))
		globals[name] = global.value as GlobalValue;
	store.commit(
		{
			epoch,
			byteLength: memory.buffer.byteLength,
			hashes,
			globals,
			state:
				options.state ??
				(options.stateJson === undefined ? undefined : JSON.stringify(options.stateJson))
		},
		pages
	);
	return { epoch, pagesWritten: changed.length, bytesWritten: changed.length * pageBytes };
}

/**
 * Restores the newest checkpoint into the memory, growing it as needed. Every page is verified
 * before anything is written. Returns undefined when the store is empty. For a runSlice checkpoint,
 * `json()` returns `{budget, measured, steps, host}`.
 */
export function loadCheckpoint(
	store: CheckpointStore,
	memory: WebAssembly.Memory,
	options: { globals?: Record<string, WebAssembly.Global> } = {}
): { epoch: number; state?: string; json<T>(): T } | undefined {
	const manifest = store.latest();
	if (!manifest) return undefined;
	if (manifest.byteLength % pageBytes)
		throw new CheckpointError(
			'manifest',
			`byte length ${manifest.byteLength} is not whole pages`
		);
	const count = manifest.byteLength / pageBytes;
	if (manifest.hashes.length !== count * 2)
		throw new CheckpointError(
			'manifest',
			`${manifest.hashes.length} hash words for ${count} pages`
		);
	if (memory.buffer.byteLength > manifest.byteLength)
		throw new CheckpointError(
			'size',
			`memory holds ${memory.buffer.byteLength} bytes, checkpoint has ${manifest.byteLength}`
		);

	const globals = options.globals ?? {};
	const wanted = Object.keys(globals);
	const recorded = Object.keys(manifest.globals);
	const unmatched = [
		...wanted.filter((n) => !(n in manifest.globals)),
		...recorded.filter((n) => !(n in globals))
	];
	if (unmatched.length)
		throw new CheckpointError('global', `globals differ: ${unmatched.join(', ')}`);

	const copies = store.pages(
		manifest.epoch,
		Array.from({ length: count }, (_, i) => i)
	);
	const bytes: Uint8Array[] = [];
	const bad: number[] = [];
	for (let page = 0; page < count; page++) {
		const copy = copies.get(page);
		if (!copy || copy.length !== pageBytes)
			throw new CheckpointError(
				'manifest',
				`page ${page} has no copy at epoch ${manifest.epoch}`
			);
		bytes.push(copy);
		const [lo, hi] = hashPages(copy);
		if (lo !== manifest.hashes[page * 2] || hi !== manifest.hashes[page * 2 + 1])
			bad.push(page);
	}
	if (bad.length)
		throw new CheckpointError('hash', `${bad.length} page(s) fail, first ${bad[0]}`);

	for (const name of wanted) {
		try {
			globals[name]!.value = manifest.globals[name];
		} catch {
			throw new CheckpointError(
				'global',
				`global ${name} cannot take ${typeof manifest.globals[name]}`
			);
		}
	}
	const have = memory.buffer.byteLength / pageBytes;
	if (have < count) {
		try {
			memory.grow(count - have);
		} catch {
			throw new CheckpointError('size', `memory cannot grow to ${count} pages`);
		}
	}
	const view = new Uint8Array(memory.buffer);
	bytes.forEach((page, index) => view.set(page, index * pageBytes));

	const { epoch, state } = manifest;
	return {
		epoch,
		state,
		json<T>(): T {
			return (state === undefined ? undefined : JSON.parse(state)) as T;
		}
	};
}

/** Why a slice ended. */
export type StopReason = 'finished' | 'signal' | 'budget';

/** Options for `runSlice`. */
export interface SliceOptions {
	storage: DurableObjectStorage;
	memory: WebAssembly.Memory;
	globals?: Record<string, WebAssembly.Global>;
	/** From `cpuSignal()`; cleared at the start of each slice. */
	signal?: CpuSignal;
	/** Runs up to `budgetSteps` guest steps and returns at a quiescent point. */
	run(budgetSteps: number): StopReason | Promise<StopReason>;
	/** The guest's monotonic step counter. */
	steps(): number;
	/** Step budget of the first slice, default 2000. */
	initialBudget?: number;
	/** Host state saved with each checkpoint. */
	state?(): string | undefined;
	/** Called after a restore and before `run`. */
	restore?(state: string | undefined): void;
}

interface Track {
	memory: WebAssembly.Memory;
	budget: number;
	measured: boolean;
	committed: number;
}

interface Envelope {
	budget: number;
	measured: boolean;
	steps: number;
	host?: string;
}

// per storage object: a module-scope entry exists only in the isolate that wrote it
const tracks = new WeakMap<DurableObjectStorage, Track>();
const CUT = new Error('signal raised during a commit');

function readEnvelope(state: string | undefined): Envelope {
	let parsed: Partial<Envelope> | null = null;
	try {
		parsed = JSON.parse(state ?? 'null');
	} catch {
		parsed = null;
	}
	if (
		!parsed ||
		typeof parsed.budget !== 'number' ||
		typeof parsed.measured !== 'boolean' ||
		typeof parsed.steps !== 'number'
	)
		throw new CheckpointError('manifest', 'checkpoint state is not a runSlice record');
	return {
		budget: parsed.budget,
		measured: parsed.measured,
		steps: parsed.steps,
		host: parsed.host
	};
}

/**
 * Runs one alarm event of a guest: restores or commits as needed, runs the guest with the event
 * budget, and commits at a budget stop. A signal stop writes nothing and only re-arms.
 * The manifest state holds a runSlice record (budget, step count, host state), so
 * `loadCheckpoint(...).json()` returns that record for checkpoints written here.
 * Call it from alarm().
 */
export async function runSlice(options: SliceOptions): Promise<{
	finished: boolean;
	restored: boolean;
	stop: StopReason | 'cut';
	epoch: number;
	budget: number;
}> {
	const { storage, memory, signal, run, steps, initialBudget = 2000 } = options;
	if (!Number.isInteger(initialBudget) || initialBudget < 1)
		throw new RangeError(`initialBudget must be a positive integer, got ${initialBudget}`);
	const globals = options.globals ?? {};
	const guard = signal
		? () => {
				if (signal.raised) throw CUT;
			}
		: undefined;
	const store = openSqlStore(storage.sql, {}, guard);
	const commit = (budget: number, measured: boolean) =>
		storage.transactionSync(() =>
			saveCheckpoint(store, memory, {
				globals,
				state: JSON.stringify({
					budget,
					measured,
					steps: steps(),
					host: options.state?.()
				} satisfies Envelope)
			})
		);
	const outcome = (
		finished: boolean,
		restored: boolean,
		stop: StopReason | 'cut',
		budget: number
	) => ({
		finished,
		restored,
		stop,
		epoch: store.latest()?.epoch ?? 0,
		budget
	});
	const signalStop = async (
		track: Track,
		ran: number,
		restored: boolean,
		stop: 'signal' | 'cut'
	) => {
		track.budget = Math.max(initialBudget, Math.round(0.7 * ran));
		track.measured = true;
		await storage.setAlarm(Date.now());
		return outcome(false, restored, stop, track.budget);
	};

	signal?.clear();
	let track: Track;
	let restored = false;
	const known = tracks.get(storage);
	if (known && known.memory === memory) {
		track = known;
		if (steps() > track.committed) {
			try {
				commit(track.budget, track.measured);
			} catch (error) {
				if (error !== CUT) throw error;
				return signalStop(track, 0, restored, 'cut');
			}
			track.committed = steps();
			await storage.sync();
		}
	} else {
		let budget = initialBudget;
		let measured = false;
		let committed = 0;
		const latest = store.latest();
		if (latest) {
			const envelope = readEnvelope(latest.state);
			loadCheckpoint(store, memory, { globals });
			options.restore?.(envelope.host);
			restored = true;
			budget = envelope.budget;
			measured = envelope.measured;
			committed = envelope.steps;
		}
		track = { memory, budget, measured, committed };
		tracks.set(storage, track);
	}

	const before = steps();
	const reason = await run(track.budget);
	const ran = steps() - before;
	if (reason === 'signal' || signal?.raised) return signalStop(track, ran, restored, 'signal');

	if (reason === 'finished') {
		try {
			commit(track.budget, track.measured);
		} catch (error) {
			if (error !== CUT) throw error;
			return signalStop(track, ran, restored, 'cut');
		}
		track.committed = steps();
		await storage.sync();
		return outcome(true, restored, 'finished', track.budget);
	}

	const next = track.measured ? Math.round(1.02 * track.budget) : 2 * track.budget;
	try {
		commit(next, track.measured);
	} catch (error) {
		if (error !== CUT) throw error;
		return signalStop(track, ran, restored, 'cut');
	}
	await storage.sync();
	track.budget = next;
	track.committed = steps();
	await storage.setAlarm(Date.now());
	return outcome(false, restored, 'budget', next);
}
