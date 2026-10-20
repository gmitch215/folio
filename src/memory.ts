export interface MemoryImport {
	module: string;
	name: string;
	initial: number;
	maximum?: number;
	shared: boolean;
	memory64: boolean;
}

/** Reads imported memory limits without changing the module or compiling its functions. */
export function memoryImports(bytes: Uint8Array): MemoryImport[] {
	let offset = 8;
	const byte = () => {
		if (offset >= bytes.length) throw new RangeError('truncated wasm metadata');
		return bytes[offset++]!;
	};
	const unsigned = () => {
		let value = 0n,
			shift = 0n;
		for (let i = 0; i < 10; i++) {
			const part = byte();
			value |= BigInt(part & 127) << shift;
			if (!(part & 128)) {
				if (value > BigInt(Number.MAX_SAFE_INTEGER))
					throw new RangeError('memory limit exceeds JS integer precision');
				return Number(value);
			}
			shift += 7n;
		}
		throw new RangeError('invalid wasm integer');
	};
	const name = () => {
		const length = unsigned();
		const end = offset + length;
		if (end > bytes.length) throw new RangeError('truncated wasm name');
		const value = new TextDecoder().decode(bytes.subarray(offset, end));
		offset = end;
		return value;
	};
	const reference = () => {
		const type = byte();
		if (type === 0x63 || type === 0x64) {
			while (byte() & 128) {}
		}
	};
	while (offset < bytes.length) {
		const section = byte();
		const length = unsigned();
		const end = offset + length;
		if (end > bytes.length) throw new RangeError('truncated wasm section');
		if (section !== 2) {
			offset = end;
			continue;
		}
		const count = unsigned();
		const memories: MemoryImport[] = [];
		for (let i = 0; i < count; i++) {
			const module = name(),
				base = name(),
				kind = byte();
			if (kind === 0) unsigned();
			else if (kind === 1) {
				reference();
				const flags = unsigned();
				unsigned();
				if (flags & 1) unsigned();
			} else if (kind === 2) {
				const flags = unsigned();
				if (flags & ~7) throw new TypeError('unsupported memory-limit metadata');
				const initial = unsigned(),
					maximum = flags & 1 ? unsigned() : undefined;
				memories.push({
					module,
					name: base,
					initial,
					maximum,
					shared: Boolean(flags & 2),
					memory64: Boolean(flags & 4)
				});
			} else if (kind === 3) {
				reference();
				byte();
			} else if (kind === 4) {
				byte();
				unsigned();
			} else throw new TypeError('unsupported wasm import metadata');
		}
		return memories;
	}
	return [];
}
