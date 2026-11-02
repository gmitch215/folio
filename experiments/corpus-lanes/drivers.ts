// the portable half of a corpus driver: records, memory layout and the output slots; the same
// bytes feed the owner in a Worker and the serial oracle in Node
export const BASE = 1 << 20;
const align = (value: number, to = 65536) => Math.ceil(value / to) * to;

export interface Driver {
	id: string;
	/** Output bytes per record, a multiple of 64: reads are tracked at 64-byte granules. */
	slot: number;
	inputBytes: number;
	auxBytes: number;
	/** Private scratch bytes per record, for kernels whose context must not live on the stack. */
	arena: number;
	make(i: number): Uint8Array;
	aux?(i: number): Uint8Array;
}

const rng = (seed: number) => {
	let state = seed | 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
};
const random = (size: number) => (i: number) => {
	const next = rng(Math.imul(i + 1, 2654435761) ^ 0x7f4a7c15);
	const data = new Uint8Array(size);
	for (let k = 0; k < size; k++) data[k] = Math.floor(next() * 256);
	return data;
};
const json = (objects: number) => (i: number) =>
	new TextEncoder().encode(
		'[' +
			Array.from(
				{ length: objects },
				(_, k) => `{"items":[${k},${i},3],"valid":true,"text":"hello${(k + i) % 10}"}`
			).join(',') +
			']'
	);
const keyIv = (i: number) => random(32)(i + 1000);

export const drivers: Driver[] = [
	{ id: 'synthetic-sum', slot: 64, inputBytes: 4096, auxBytes: 0, arena: 0, make: random(4096) },
	{ id: 'miniz-crc32', slot: 64, inputBytes: 32768, auxBytes: 0, arena: 0, make: random(32768) },
	{ id: 'xxhash32', slot: 64, inputBytes: 131072, auxBytes: 0, arena: 0, make: random(131072) },
	{ id: 'md5-slot', slot: 64, inputBytes: 32768, auxBytes: 0, arena: 128, make: random(32768) },
	{
		id: 'aes-cbc-encrypt-slot',
		slot: Math.ceil((32 + 8192) / 64) * 64,
		inputBytes: 8192,
		auxBytes: 32,
		arena: 512,
		make: random(8192),
		aux: keyIv
	},
	{
		id: 'jsmn-parse-slot',
		slot: Math.ceil((32 + 704 * 16) / 64) * 64,
		inputBytes: 0,
		auxBytes: 0,
		arena: 64,
		make: json(64)
	}
];

export const driverOf = (id: string): Driver => {
	const found = drivers.find((driver) => driver.id === id);
	if (!found) throw new RangeError(`unknown driver ${id}`);
	return found;
};

export interface Layout {
	table: number;
	aux: number;
	out: number;
	arena: number;
	data: number;
	end: number;
	pages: number;
}

export function layoutFor(driver: Driver, n: number, inputLength = driver.inputBytes): Layout {
	const table = BASE;
	const aux = align(table + align(n * 16, 4096), 4096);
	const out = align(aux + n * driver.auxBytes, 4096);
	const arena = align(out + n * driver.slot, 4096);
	const data = align(arena + n * driver.arena, 4096);
	const end = data + n * align(inputLength + 32, 32);
	return { table, aux, out, arena, data, end, pages: Math.ceil(end / 65536) + 2 };
}

/** Writes `n` records into a memory: the table of (input, length, aux, arena) words and the data. */
export function fill(bytes: Uint8Array, driver: Driver, layout: Layout, n: number): void {
	const words = new Uint32Array(bytes.buffer, bytes.byteOffset + layout.table, 4 * n);
	let at = layout.data;
	for (let i = 0; i < n; i++) {
		const input = driver.make(i);
		bytes.set(input, at);
		if (driver.aux) bytes.set(driver.aux(i), layout.aux + i * driver.auxBytes);
		words[4 * i] = at;
		words[4 * i + 1] = input.length;
		words[4 * i + 2] = driver.auxBytes ? layout.aux + i * driver.auxBytes : 0;
		words[4 * i + 3] = driver.arena ? layout.arena + i * driver.arena : 0;
		at += align(input.length + 32, 32);
	}
}

export const outputBytes = (bytes: Uint8Array, driver: Driver, layout: Layout, n: number) =>
	bytes.subarray(layout.out, layout.out + n * driver.slot);

/** The entry and arguments for `n` records, `k` per call; k of 0 is one call per record. */
export const entryOf = (layout: Layout, n: number, k: number) =>
	k
		? { name: 'bulk_chunks', args: [layout.table, n, layout.out, k] }
		: { name: 'bulk', args: [layout.table, n, layout.out] };
