export class SpeculationLimit extends Error {}

export interface TransactionResult {
	value?: unknown;
	reads: number[];
	writes: [number, number][];
	trap?: string;
	errorKind?: string;
	exhausted?: boolean;
	timing?: { wallMs: number; cpuMs: number };
}

export function transaction(memory: WebAssembly.Memory, maxBytes: number) {
	const bytes = new Uint8Array(memory.buffer);
	const reads = new Set<number>();
	const writes = new Map<number, number>();
	function bounds(address: number, offset: number, width: number): number {
		const start = (address >>> 0) + (offset >>> 0);
		if (start + width > bytes.length)
			throw new WebAssembly.RuntimeError('memory access out of bounds');
		return start;
	}
	function limit() {
		if (reads.size + writes.size > maxBytes)
			throw new SpeculationLimit('transaction byte budget');
	}
	function read(at: number): number {
		const own = writes.get(at);
		if (own === undefined) reads.add(at);
		return own ?? bytes[at]!;
	}
	return {
		load(address: number, offset: number, width: number, signed: number): number {
			const start = bounds(address, offset, width);
			let value = 0;
			for (let i = 0; i < width; i++) {
				const at = start + i;
				value |= read(at) << (i * 8);
			}
			limit();
			return signed && width < 4 ? (value << (32 - width * 8)) >> (32 - width * 8) : value;
		},
		store(address: number, value: number, offset: number, width: number): void {
			const start = bounds(address, offset, width);
			for (let i = 0; i < width; i++) writes.set(start + i, (value >>> (i * 8)) & 255);
			limit();
		},
		load64(address: number, offset: number, width: number, signed: number): bigint {
			const start = bounds(address, offset, width);
			let value = 0n;
			for (let i = 0; i < width; i++) value |= BigInt(read(start + i)) << BigInt(i * 8);
			limit();
			return signed || width === 8 ? BigInt.asIntN(width * 8, value) : value;
		},
		store64(address: number, value: bigint, offset: number, width: number): void {
			const start = bounds(address, offset, width);
			for (let i = 0; i < width; i++)
				writes.set(start + i, Number((value >> BigInt(i * 8)) & 255n));
			limit();
		},
		copy(destination: number, source: number, size: number): void {
			const width = size >>> 0;
			const dest = bounds(destination, 0, width);
			const src = bounds(source, 0, width);
			if (width > maxBytes) throw new SpeculationLimit('transaction byte budget');
			const backwards = dest > src && dest < src + width;
			for (let index = 0; index < width; index++) {
				const i = backwards ? width - 1 - index : index;
				writes.set(dest + i, read(src + i));
				limit();
			}
		},
		fill(destination: number, value: number, size: number): void {
			const width = size >>> 0;
			const dest = bounds(destination, 0, width);
			if (width > maxBytes) throw new SpeculationLimit('transaction byte budget');
			for (let i = 0; i < width; i++) {
				writes.set(dest + i, value & 255);
				limit();
			}
		},
		result(value?: unknown, error?: unknown): TransactionResult {
			return {
				value,
				reads: [...reads],
				writes: [...writes],
				...(error instanceof SpeculationLimit
					? { exhausted: true }
					: error
						? {
								trap: error instanceof Error ? error.message : String(error),
								errorKind: error instanceof Error ? error.name : 'Error'
							}
						: {})
			};
		}
	};
}
