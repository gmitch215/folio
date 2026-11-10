import { backingWord, scanTrace, zipfTrace } from '../../scripts/probe/elastic/access.ts';

export const PAGE = 65536;
export const WORKLOADS = ['dense', 'skewed', 'scan', 'chase'] as const;
export type Workload = (typeof WORKLOADS)[number];
export const KIND = { load: 0, store: 1, fill: 2 } as const;
export const KINDS = ['load', 'store', 'fill'] as const;

// every op as page * 4 + kind
export type PackedOps = Int32Array;

export const entryOf = (workload: Workload) =>
	workload === 'dense' ? 'run' : workload === 'chase' ? 'run_chase' : 'run_trace';

export const linkWord = (page: number) => Math.imul(page + 1, 0x85ebca6b) >>> 0;

// a dense page is the Codex fixture's output: header words, then one byte value
export function denseOps(pages: number): PackedOps {
	const ops = new Int32Array(pages * 5);
	let at = 0;
	for (let p = 0; p < pages; p++) {
		ops[at++] = p * 4 + KIND.fill;
		ops[at++] = p * 4 + KIND.store;
		ops[at++] = p * 4 + KIND.store;
	}
	let page = 0;
	for (let n = 0; n < pages; n++) {
		ops[at++] = page * 4 + KIND.load;
		ops[at++] = page * 4 + KIND.load;
		page = (page + 17) % pages;
	}
	return ops;
}

export function denseChecksum(pages: number) {
	let sum = 0;
	for (let k = 0; k < pages; k++)
		sum = Math.imul(sum, 31) ^ (Math.imul((k * 17) % pages, 1664525) ^ 1013904223);
	return sum;
}

export function densePage(page: number, pages: number, out: Uint8Array) {
	out.fill(page & 255);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	view.setUint32(0, (page + 17) % pages, true);
	view.setInt32(4, Math.imul(page, 1664525) ^ 1013904223, true);
}

// lines of zeros, repeats and noise, so the pages compress about as unevenly as a heap does
export function basePage(page: number, out: Uint8Array) {
	const words = new Uint32Array(out.buffer, out.byteOffset, PAGE / 4);
	for (let line = 0; line < 1024; line++) {
		const h = Math.imul(page * 1024 + line + 1, 0x9e3779b1) >>> 0;
		const kind = (h >>> 8) % 3;
		const base = line * 16;
		if (kind === 0) words.fill(0, base, base + 16);
		else if (kind === 1) words.fill(h, base, base + 16);
		else {
			let s = h | 1;
			for (let j = 0; j < 16; j++) {
				s ^= s << 13;
				s ^= s >>> 17;
				s ^= s << 5;
				words[base + j] = s >>> 0;
			}
		}
	}
	words[32] = backingWord(page) >>> 0;
	words[33] = linkWord(page);
}

export const traceLength = (workload: Workload, pages: number) =>
	workload === 'skewed' ? Math.round((20000 * pages) / 3072) : 0;
export const chaseIterations = (pages: number) => Math.floor((4096 * pages) / 3072);

export interface Expected {
	ops: PackedOps;
	checksum: number;
	// the word at offset 128 each page ends with; null for dense
	finalWords: Int32Array | null;
}

// the ops a workload issues, its checksum and the final word of every page
export function expectedOf(workload: Workload, pages: number): Expected {
	if (workload === 'dense')
		return { ops: denseOps(pages), checksum: denseChecksum(pages), finalWords: null };
	const words = new Int32Array(pages);
	for (let p = 0; p < pages; p++) words[p] = backingWord(p);
	let sum = 0;
	if (workload === 'chase') {
		const n = chaseIterations(pages);
		const ops = new Int32Array(n * 3);
		let p = 0;
		for (let i = 0; i < n; i++) {
			const v = words[p]!;
			sum = Math.imul(sum, 31) ^ v;
			ops[i * 3] = p * 4 + KIND.load;
			ops[i * 3 + 1] = p * 4 + KIND.store;
			ops[i * 3 + 2] = p * 4 + KIND.load;
			words[p] = (v + 1) | 0;
			p = linkWord(p) % pages;
		}
		return { ops, checksum: sum, finalWords: words };
	}
	const trace =
		workload === 'skewed'
			? zipfTrace({
					pages,
					length: traceLength('skewed', pages),
					s: 1.1,
					readShare: 0.7,
					seed: 1105
				})
			: scanTrace(pages, 2);
	const ops = new Int32Array(trace.length);
	trace.forEach(({ kind, page }, i) => {
		ops[i] = page * 4 + KIND[kind];
		if (kind === 'load') sum = Math.imul(sum, 31) ^ words[page]!;
		else words[page] = i;
	});
	return { ops, checksum: sum, finalWords: words };
}

// the page a correct store holds at the end of the run
export function expectedPage(
	workload: Workload,
	page: number,
	pages: number,
	expected: Expected,
	out: Uint8Array,
	base: (page: number, out: Uint8Array) => void = basePage
) {
	if (workload === 'dense') return densePage(page, pages, out);
	base(page, out);
	new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
		128,
		expected.finalWords![page]!,
		true
	);
}
