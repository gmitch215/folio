/** Restores observable import lookup order without changing any Wasm index space. */
export function restoreImportOrder(
	bytes: Uint8Array,
	original: readonly WebAssembly.ModuleImportDescriptor[]
): Uint8Array {
	const descriptors = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(bytes)));
	let cursor = 8;
	const uint = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[cursor++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	const type = () => {
		const code = bytes[cursor++]!;
		if (code === 0x63 || code === 0x64) uint();
	};
	const limits = () => {
		const flags = uint();
		uint();
		if (flags & 1) uint();
	};
	while (cursor < bytes.length) {
		const id = bytes[cursor++]!,
			length = uint(),
			start = cursor,
			end = start + length;
		if (id !== 2) {
			cursor = end;
			continue;
		}
		const count = uint(),
			prefix = cursor;
		const records: {
			kind: string;
			descriptor: WebAssembly.ModuleImportDescriptor;
			bytes: Uint8Array;
		}[] = [];
		for (let index = 0; index < count; index++) {
			const begin = cursor;
			for (let name = 0; name < 2; name++) {
				const size = uint();
				cursor += size;
			}
			const kind = bytes[cursor++]!;
			if (kind === 0) uint();
			else if (kind === 1) {
				type();
				limits();
			} else if (kind === 2) limits();
			else if (kind === 3) {
				type();
				cursor++;
			} else if (kind === 4) {
				uint();
				uint();
			} else throw new Error('unsupported import descriptor');
			records.push({
				kind: descriptors[index]!.kind,
				descriptor: descriptors[index]!,
				bytes: bytes.subarray(begin, cursor)
			});
		}
		if (cursor !== end || records.length !== descriptors.length)
			throw new Error('invalid import census');
		const key = (value: WebAssembly.ModuleImportDescriptor) =>
			JSON.stringify([value.kind, value.module, value.name]);
		const occurrences = new Map<string, { indices: number[]; next: number }>();
		const kinds = new Map<string, { indices: number[]; next: number }>();
		for (let index = 0; index < records.length; index++) {
			const name = key(records[index]!.descriptor);
			for (const [map, identity] of [
				[occurrences, name],
				[kinds, records[index]!.kind]
			] as const) {
				const queue = map.get(identity) ?? { indices: [], next: 0 };
				queue.indices.push(index);
				map.set(identity, queue);
			}
		}
		const wanted = original.map((value) => {
			const queue = occurrences.get(key(value));
			const index = queue?.indices[queue.next++];
			if (index === undefined) throw new Error('extraction removed an original import');
			return index;
		});
		const retained = new Set(wanted),
			emitted = new Set<number>(),
			order: number[] = [];
		for (const target of wanted) {
			const queue = kinds.get(records[target]!.kind)!;
			while (queue.next < queue.indices.length && queue.indices[queue.next]! <= target) {
				const index = queue.indices[queue.next++]!;
				if (index !== target && retained.has(index))
					throw new Error('extraction changed per-kind import order');
				emitted.add(index);
				order.push(index);
			}
			if (!emitted.has(target)) throw new Error('extraction changed per-kind import order');
		}
		for (let index = 0; index < records.length; index++)
			if (!emitted.has(index)) order.push(index);
		const result = Uint8Array.from(bytes);
		let write = prefix;
		for (const index of order) {
			result.set(records[index]!.bytes, write);
			write += records[index]!.bytes.length;
		}
		return result;
	}
	if (original.length) throw new Error('extraction removed the import section');
	return bytes;
}
