import { Pager, type PagerOptions } from './pager.ts';

// shared by the fixtures and the random differential test.
// layout (64 KiB pages): 0 unused, 1-7 arena, 8-15 pageable, 16-19 table, 20 epoch word, 24-31 frame pool
export const PAGE = 65536;
export const MEMORY_PAGES = 40;
export const tableBase = 16 * PAGE;
export const epochAddr = tableBase + 4 * 65536;

export const translateOptions = {
	shape: 'inline' as const,
	exempt: false,
	hoist: true,
	tableBase,
	arenas: [{ lo: PAGE, size: 7 * PAGE }]
};

export function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s;
	};
}

// pages 1-15: 16-byte nodes whose first two words point at other nodes, the rest random
export function seedData(): Uint8Array {
	const bytes = new Uint8Array(16 * PAGE);
	const dv = new DataView(bytes.buffer);
	const r = rng(12345);
	const node = () => (1 + (r() % 15)) * PAGE + (r() % 4000) * 16;
	for (let page = 1; page < 16; page++)
		for (let k = 0; k < 4000; k++) {
			const a = page * PAGE + k * 16;
			dv.setUint32(a, node(), true);
			dv.setUint32(a + 4, node(), true);
			dv.setUint32(a + 8, r(), true);
			dv.setUint32(a + 12, r(), true);
		}
	return bytes;
}

export interface Outcome {
	result?: number;
	trap?: string;
	pages: string;
}

const hash = (b: Uint8Array) => {
	let h = 2166136261;
	for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619);
	return (h >>> 0).toString(16);
};

const outcome = (instance: WebAssembly.Instance, fn: string, args: number[], pre: [string, number[]][]) => {
	const out: Outcome = { pages: '' };
	try {
		for (const [f, a] of pre) (instance.exports[f] as any)(...a);
		out.result = (instance.exports[fn] as any)(...args);
	} catch (e) {
		out.trap = String((e as Error).message);
	}
	return out;
};

export async function runNative(
	bytes: Uint8Array,
	fn: string,
	args: number[],
	data: Uint8Array,
	pre: [string, number[]][] = []
): Promise<Outcome> {
	const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES });
	new Uint8Array(memory.buffer).set(data);
	const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
	const out = outcome(instance, fn, args, pre);
	const mem = new Uint8Array(memory.buffer);
	out.pages = Array.from({ length: 15 }, (_, k) =>
		hash(mem.subarray((k + 1) * PAGE, (k + 2) * PAGE))
	).join(',');
	return out;
}

export async function runTranslated(
	bytes: Uint8Array,
	fn: string,
	args: number[],
	data: Uint8Array,
	cfg: Partial<PagerOptions>,
	pre: [string, number[]][] = []
): Promise<Outcome & { pager: Pager; counters: Record<string, number> }> {
	const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES });
	const o: PagerOptions = {
		tableBase,
		epochAddr,
		firstPage: 8,
		pages: 8,
		poolPage: 24,
		frames: 3,
		mode: 'dynamic',
		...cfg
	};
	const pager = new Pager(memory, o);
	new Uint8Array(memory.buffer).set(data.subarray(0, 8 * PAGE));
	for (let p = 8; p < 16; p++) pager.seed(p, data.subarray(p * PAGE, (p + 1) * PAGE));
	const { instance } = await WebAssembly.instantiate(bytes, {
		env: { memory },
		...pager.imports()
	});
	const out = outcome(instance, fn, args, pre);
	out.pages = Array.from({ length: 15 }, (_, k) => hash(pager.readPage(k + 1))).join(',');
	const counters: Record<string, number> = {};
	for (const [k, v] of Object.entries(instance.exports))
		if (k.startsWith('__folio_n_'))
			counters[k.slice(10)] = ((v as WebAssembly.Global).value as number) >>> 0;
	return { ...out, pager, counters };
}
