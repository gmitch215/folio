import { Buffer } from 'node:buffer';
import type { PreparedContext } from './compiler.ts';

/** A changed memory or table size requires a newly instantiated context. */
export class ContextResetError extends Error {
	/** Which binding changed size. */
	readonly kind: 'memory-size' | 'table-size';
	constructor(kind: 'memory-size' | 'table-size') {
		super(`context ${kind} changed; instantiate and initialize a new context`);
		this.name = 'ContextResetError';
		this.kind = kind;
	}
}

/** Memory traffic and state restored by a checkpoint operation. */
export interface ContextResetReport {
	/** Bytes compared; zero for a full restore. */
	checkedBytes: number;
	/** Bytes written back to memory. */
	copiedBytes: number;
	/** 64 KiB pages written back. */
	changedPages: number;
	/** Globals whose value was restored. */
	globals: number;
	/** Table slots whose reference was restored. */
	tableSlots: number;
	/** Bytes inside `overwrite` ranges, neither compared nor restored. */
	skippedBytes: number;
}

/** Bytes of one context memory that the caller writes completely before anything reads them. */
export interface ContextRange {
	/** Index into the plan's memories. The default is 0. */
	memory?: number;
	offset: number;
	length: number;
}

/**
 * Captures private Wasm state after initialization. `prepareContext` exposes hidden bindings.
 * Each restore checks current bytes, so different inputs may dirty different pages. Callers own
 * exclusive access and reset host resources and objects behind externref values separately.
 * Memory/table growth requires recreation because Wasm cannot shrink those bindings.
 * @since 1.0.1
 */
export class InstanceCheckpoint {
	readonly #memories: { memory: WebAssembly.Memory; bytes: Uint8Array }[];
	readonly #globals: { global: WebAssembly.Global; value: unknown }[];
	readonly #tables: { table: WebAssembly.Table; slots: unknown[] }[];

	constructor(instance: WebAssembly.Instance, plan: PreparedContext) {
		if (plan.reasons.length)
			throw new TypeError(`context requires recreation: ${plan.reasons.join('; ')}`);
		this.#memories = plan.memories.map((name) => {
			const memory = instance.exports[name];
			if (!(memory instanceof WebAssembly.Memory))
				throw new TypeError(`missing context memory ${name}`);
			return { memory, bytes: Uint8Array.from(new Uint8Array(memory.buffer)) };
		});
		this.#globals = plan.globals.map((name) => {
			const global = instance.exports[name];
			if (!(global instanceof WebAssembly.Global))
				throw new TypeError(`missing context global ${name}`);
			return { global, value: global.value };
		});
		this.#tables = plan.tables.map((name) => {
			const table = instance.exports[name];
			if (!(table instanceof WebAssembly.Table))
				throw new TypeError(`missing context table ${name}`);
			return {
				table,
				slots: Array.from({ length: table.length }, (_, index) => table.get(index))
			};
		});
	}

	/**
	 * Restores all mutable bindings. `full` skips page comparison and copies every memory byte.
	 * Bytes inside `overwrite` are left as they are: the caller must write every one of them
	 * before the program reads it, so a task that rewrites its input region each time does not pay
	 * to compare and copy back the previous task's input.
	 */
	restore(
		strategy: 'changed' | 'full' = 'changed',
		overwrite: ContextRange[] = []
	): ContextResetReport {
		if (strategy !== 'changed' && strategy !== 'full')
			throw new TypeError('invalid context reset strategy');
		for (const { memory, bytes } of this.#memories)
			if (memory.buffer.byteLength !== bytes.length)
				throw new ContextResetError('memory-size');
		for (const { table, slots } of this.#tables)
			if (table.length !== slots.length) throw new ContextResetError('table-size');
		const skipped = this.#ranges(overwrite);
		const report: ContextResetReport = {
			checkedBytes: 0,
			copiedBytes: 0,
			changedPages: 0,
			globals: 0,
			tableSlots: 0,
			skippedBytes: 0
		};
		this.#memories.forEach(({ memory, bytes }, index) => {
			const target = new Uint8Array(memory.buffer);
			let from = 0;
			for (const [start, end] of [
				...skipped[index]!,
				[bytes.length, bytes.length]
			] as const) {
				for (let offset = from; offset < start; offset += 65536) {
					const stop = Math.min(offset + 65536, start);
					const source = bytes.subarray(offset, stop),
						current = target.subarray(offset, stop);
					if (strategy === 'changed') report.checkedBytes += current.length;
					if (
						strategy === 'full' ||
						!Buffer.from(current.buffer, current.byteOffset, current.length).equals(
							Buffer.from(source.buffer, source.byteOffset, source.length)
						)
					) {
						current.set(source);
						report.copiedBytes += current.length;
						report.changedPages++;
					}
				}
				report.skippedBytes += end - start;
				from = end;
			}
		});
		for (const { global, value } of this.#globals) {
			if (!Object.is(global.value, value)) {
				global.value = value;
				report.globals++;
			}
		}
		for (const { table, slots } of this.#tables)
			for (let index = 0; index < slots.length; index++)
				if (!Object.is(table.get(index), slots[index])) {
					table.set(index, slots[index]);
					report.tableSlots++;
				}
		return report;
	}

	/** Validates ranges and returns, per memory, sorted and merged [start, end) pairs. */
	#ranges(overwrite: ContextRange[]): (readonly [number, number])[][] {
		const merged = this.#memories.map(() => [] as [number, number][]);
		for (const { memory = 0, offset, length } of overwrite) {
			const size = this.#memories[memory]?.bytes.length;
			if (size === undefined) throw new RangeError('overwrite range names a missing memory');
			if (
				!Number.isSafeInteger(offset) ||
				!Number.isSafeInteger(length) ||
				offset < 0 ||
				length < 0
			)
				throw new RangeError(
					'overwrite range needs a non-negative integer offset and length'
				);
			if (offset + length > size) throw new RangeError('overwrite range exceeds the memory');
			if (length) merged[memory]!.push([offset, offset + length]);
		}
		return merged.map((pairs) => {
			pairs.sort((a, b) => a[0] - b[0]);
			const out: [number, number][] = [];
			for (const [start, end] of pairs) {
				const last = out[out.length - 1];
				if (last && start <= last[1]) last[1] = Math.max(last[1], end);
				else out.push([start, end]);
			}
			return out;
		});
	}
}
