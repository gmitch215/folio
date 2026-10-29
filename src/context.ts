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

	/** Restores all mutable bindings. `full` skips page comparison and copies every memory byte. */
	restore(strategy: 'changed' | 'full' = 'changed'): ContextResetReport {
		if (strategy !== 'changed' && strategy !== 'full')
			throw new TypeError('invalid context reset strategy');
		for (const { memory, bytes } of this.#memories)
			if (memory.buffer.byteLength !== bytes.length)
				throw new ContextResetError('memory-size');
		for (const { table, slots } of this.#tables)
			if (table.length !== slots.length) throw new ContextResetError('table-size');
		const report: ContextResetReport = {
			checkedBytes: 0,
			copiedBytes: 0,
			changedPages: 0,
			globals: 0,
			tableSlots: 0
		};
		for (const { memory, bytes } of this.#memories) {
			const target = new Uint8Array(memory.buffer);
			for (let offset = 0; offset < bytes.length; offset += 65536) {
				const source = bytes.subarray(offset, offset + 65536),
					current = target.subarray(offset, offset + 65536);
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
		}
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
}
