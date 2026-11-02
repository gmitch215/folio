import { FootprintCache, RangeSet } from './ranges.ts';
import { writeRunsOf } from './runs.ts';
import type { TransactionResult } from './transaction.ts';

/**
 * Recorded region results, reused when the bytes a region read have not changed.
 *
 * A tracked region's result is a function of its module, its export, its integer arguments, the
 * memory size and the bytes it read from memory before writing them. After an exact tracked
 * execution the memo keeps the read ranges, a SHA-256 of their bytes as they were read, the read
 * addresses, the write set, the return value and the time the execution took. A lookup hashes the
 * current bytes of each recorded entry's ranges and returns the recorded result on equality.
 * Equal module, arguments and bytes give the same execution, so the same writes and value.
 *
 * Host contract, for a host that tracks its own regions:
 *
 * - The module string passed to `keyOf` must identify the module bytes and their instrumentation.
 *   Two calls with the same module string are assumed to execute identically. `ManagedFolio`
 *   assigns a process-local identity per artifact; a host that shares a memo across processes or
 *   restarts must use a content hash of the tracked module instead.
 * - The host supplies the region export, its arguments, the memory at the start of the call and
 *   the call's tracked read and write sets. `record` takes the memory before any write of the
 *   call, because it hashes the read bytes itself. The read set holds only the bytes the region
 *   read before it wrote them, which is what the execution depends on.
 * - The region must be deterministic in its read bytes, arguments and module. It may not read a
 *   clock, randomness, a host import or any mutable global. The compiler refuses global access in
 *   a region span (`summarizeSpan` in `src/extract.ts`); the lane resets its fuel counter before
 *   every call (`FolioLane.execute` in `src/managed.ts`), so the counter carries no state between
 *   calls.
 * - A trap, fuel or budget exhaustion, an inconclusive result or a read the shipped ranges missed
 *   is refused by `record`.
 *
 * `RegionMemo.probe` measures repetition without recording writes, so a host can see the reuse
 * rate on its own traffic before it enables a memo. The probe is an upper bound on hit rate: it
 * keeps no entry limit and no byte budget.
 */

export interface MemoStats {
	lookups: number;
	hits: number;
	misses: number;
	/** Bytes hashed by lookups, summed over each candidate entry. */
	hashedBytes: number;
	/** Estimated cost of every entry recorded; see `RegionMemo` for the estimate. */
	recordedBytes: number;
	/** Estimated cost of the entries currently held. */
	storedBytes: number;
	recorded: number;
	evictions: number;
	/** Recorded execution time of every hit, summed. An estimate of lane time avoided. */
	savedMs: number;
}

export interface MemoOptions {
	/** Budget for stored entries, estimated in bytes. Default 8 MiB. */
	bytes?: number;
	/** Entries kept per key. Default 4. */
	entries?: number;
}

export interface MemoProbe {
	observations: number;
	distinct: number;
	repeats: number;
	/** Repeats divided by observations; an upper bound on the hit rate of a memo with no limits. */
	repeatRate: number;
}

interface Entry {
	key: string;
	memoryBytes: number;
	/** Flat start, length pairs of the bytes the region read. */
	spans: Uint32Array;
	readBytes: number;
	digest: string;
	reads: readonly number[];
	writeAddresses: Uint32Array;
	writeValues: Uint8Array;
	/** The same write set as runs and their bytes, for a caller that commits runs. */
	runs: Uint32Array;
	runData: Uint8Array;
	/** Frozen tuples, built on the first hit so entries that never hit build no tuple objects. */
	writes?: readonly (readonly [number, number])[];
	value: unknown;
	ms: number;
	cost: number;
}

export interface MemoHit {
	result: TransactionResult;
	ms: number;
}

async function digest(
	memory: Uint8Array,
	spans: Uint32Array
): Promise<{ digest: string; bytes: number }> {
	let total = 0;
	for (let i = 1; i < spans.length; i += 2) total += spans[i]!;
	const buffer = new Uint8Array(total);
	let offset = 0;
	for (let i = 0; i < spans.length; i += 2) {
		buffer.set(memory.subarray(spans[i]!, spans[i]! + spans[i + 1]!), offset);
		offset += spans[i + 1]!;
	}
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
	return {
		digest: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
		bytes: total
	};
}

function spanArray(reads: readonly number[]): Uint32Array {
	return Uint32Array.from(RangeSet.fromAddresses(reads).spans().flat());
}

// a run-encoded result (`reads` empty, `readRuns`) is expanded so the record holds one shape
function addressForm(result: TransactionResult): TransactionResult {
	if (!result.readRuns && !result.writeRuns) return result;
	const reads = [...result.reads];
	for (let i = 0; i < (result.readRuns?.length ?? 0); i += 2)
		for (let k = 0; k < result.readRuns![i + 1]!; k++) reads.push(result.readRuns![i]! + k);
	const writes = [...result.writes];
	let at = 0;
	for (let i = 0; i < (result.writeRuns?.length ?? 0); i += 2)
		for (let k = 0; k < result.writeRuns![i + 1]!; k++)
			writes.push([result.writeRuns![i]! + k, result.writeData![at++]!]);
	return {
		...result,
		reads,
		writes,
		readRuns: undefined,
		writeRuns: undefined,
		writeData: undefined
	};
}

export class RegionMemo {
	readonly #budget: number;
	readonly #perKey: number;
	readonly #byKey = new Map<string, Entry[]>();
	// every entry, least recently used first
	readonly #lru = new Set<Entry>();
	#stats: MemoStats = emptyStats();

	constructor(options: MemoOptions = {}) {
		this.#budget = options.bytes ?? 8 * 1048576;
		this.#perKey = options.entries ?? 4;
		if (!Number.isSafeInteger(this.#budget) || this.#budget < 1)
			throw new RangeError('invalid memo byte budget');
		if (!Number.isSafeInteger(this.#perKey) || this.#perKey < 1)
			throw new RangeError('invalid memo entry limit');
	}

	/**
	 * The key for a call in a module, or undefined when an argument is not an exact integer. The
	 * module string is the host's identity for the tracked module; see the contract above.
	 */
	static keyOf(module: string, name: string, args: readonly unknown[]): string | undefined {
		for (const value of args) {
			if (typeof value === 'bigint') continue;
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0))
				return undefined;
		}
		return JSON.stringify([module, FootprintCache.key(name, args as (number | bigint)[])]);
	}

	get stats(): MemoStats {
		return { ...this.#stats };
	}

	/**
	 * Returns the recorded result whose read bytes equal the current bytes, or undefined. With
	 * `runs`, the write set comes as `writeRuns` and `writeData`, which the owner commits as
	 * intervals; otherwise as `[address, value]` tuples.
	 */
	async lookup(
		key: string,
		memory: Uint8Array,
		options: { runs?: boolean } = {}
	): Promise<MemoHit | undefined> {
		this.#stats.lookups++;
		const list = this.#byKey.get(key);
		if (list)
			for (const entry of [...list].reverse()) {
				if (entry.memoryBytes !== memory.byteLength) continue;
				const now = await digest(memory, entry.spans);
				this.#stats.hashedBytes += now.bytes;
				// an entry removed while the digest ran must not be touched back into the LRU
				if (!this.#lru.has(entry) || now.digest !== entry.digest) continue;
				this.#touch(entry);
				this.#stats.hits++;
				this.#stats.savedMs += entry.ms;
				if (options.runs)
					return {
						result: {
							value: entry.value,
							reads: entry.reads.slice(),
							writes: [],
							writeRuns: entry.runs.slice(),
							writeData: entry.runData.slice()
						},
						ms: entry.ms
					};
				entry.writes ??= Array.from(entry.writeAddresses, (address, i) =>
					Object.freeze([address, entry.writeValues[i]!] as const)
				);
				return {
					result: {
						value: entry.value,
						reads: entry.reads.slice(),
						// the tuples are frozen, so the copy cannot change the entry
						writes: entry.writes.slice() as [number, number][]
					},
					ms: entry.ms
				};
			}
		this.#stats.misses++;
		return undefined;
	}

	/**
	 * Records a clean result of an execution that started from `memory`. Returns false when the
	 * result is refused or already held. Throws on a read or write that the memory cannot hold.
	 *
	 * The cost estimate counts 8 bytes per read address and 40 per write (a two-element array and
	 * its slot), plus the hashed span table and the 32-byte digest.
	 */
	async record(
		key: string,
		memory: Uint8Array,
		result: TransactionResult,
		ms = 0
	): Promise<boolean> {
		result = addressForm(result);
		if (
			result.trap !== undefined ||
			result.exhausted ||
			result.inconclusive ||
			result.escapes?.length ||
			!Number.isFinite(ms) ||
			ms < 0
		)
			return false;
		for (const address of result.reads)
			if (!Number.isSafeInteger(address) || address < 0 || address >= memory.byteLength)
				throw new RangeError('memo read outside memory');
		for (const [address, value] of result.writes)
			if (
				!Number.isSafeInteger(address) ||
				address < 0 ||
				address >= memory.byteLength ||
				!Number.isInteger(value) ||
				value < 0 ||
				value > 255
			)
				throw new RangeError('memo write outside memory or not a byte');
		const spans = spanArray(result.reads);
		const seen = await digest(memory, spans);
		const memoryBytes = memory.byteLength;
		const list = this.#byKey.get(key) ?? [];
		if (list.some((entry) => entry.memoryBytes === memoryBytes && entry.digest === seen.digest))
			return false;
		const reads = [...result.reads];
		const writeAddresses = Uint32Array.from(result.writes, ([address]) => address);
		const writeValues = Uint8Array.from(result.writes, ([, value]) => value);
		const packed = writeRunsOf(result.writes);
		const cost =
			spans.byteLength +
			reads.length * 8 +
			writeAddresses.length * 40 +
			packed.runs.byteLength +
			packed.data.byteLength +
			32;
		if (cost > this.#budget) return false;
		const entry: Entry = {
			key,
			memoryBytes,
			spans,
			readBytes: seen.bytes,
			digest: seen.digest,
			reads,
			writeAddresses,
			writeValues,
			runs: packed.runs,
			runData: packed.data,
			value: result.value,
			ms,
			cost
		};
		list.push(entry);
		this.#byKey.set(key, list);
		this.#lru.add(entry);
		this.#stats.recorded++;
		this.#stats.recordedBytes += cost;
		this.#stats.storedBytes += cost;
		while (list.length > this.#perKey) this.#evict(list[0]!);
		while (this.#stats.storedBytes > this.#budget)
			this.#evict(this.#lru.values().next().value!);
		return true;
	}

	/** Drops every entry and resets the counters. */
	clear(): void {
		this.#byKey.clear();
		this.#lru.clear();
		this.#stats = emptyStats();
	}

	/** Counts how often (key, read bytes) pairs repeat. Nothing is recorded. */
	static async probe(
		observations: Iterable<{ key: string; memory: Uint8Array; reads: readonly number[] }>
	): Promise<MemoProbe> {
		const counts = new Map<string, number>();
		let observed = 0;
		for (const { key, memory, reads } of observations) {
			const spans = spanArray(reads);
			const seen = await digest(memory, spans);
			const id = `${key}|${memory.byteLength}|${Array.from(spans).join(',')}|${seen.digest}`;
			counts.set(id, (counts.get(id) ?? 0) + 1);
			observed++;
		}
		let repeats = 0;
		for (const count of counts.values()) repeats += count - 1;
		return {
			observations: observed,
			distinct: counts.size,
			repeats,
			repeatRate: observed ? repeats / observed : 0
		};
	}

	#touch(entry: Entry): void {
		this.#lru.delete(entry);
		this.#lru.add(entry);
		const list = this.#byKey.get(entry.key)!;
		list.splice(list.indexOf(entry), 1);
		list.push(entry);
	}

	#evict(entry: Entry): void {
		this.#lru.delete(entry);
		const list = this.#byKey.get(entry.key);
		if (list) {
			list.splice(list.indexOf(entry), 1);
			if (!list.length) this.#byKey.delete(entry.key);
		}
		this.#stats.storedBytes -= entry.cost;
		this.#stats.evictions++;
	}
}

function emptyStats(): MemoStats {
	return {
		lookups: 0,
		hits: 0,
		misses: 0,
		hashedBytes: 0,
		recordedBytes: 0,
		storedBytes: 0,
		recorded: 0,
		evictions: 0,
		savedMs: 0
	};
}
