import { expect, test } from 'vitest';
import {
	bisectPoison,
	checkAllocator,
	classifyPages,
	dl,
	dropPages,
	equalRuns,
	judgeTrial,
	labelRanges,
	largestFree,
	maskOf,
	normalizeBody,
	pageBytes,
	parseMask,
	regionOf,
	runsOf,
	summarizeClasses,
	summarizePageDrop,
	walkHeap,
	type ChunkKind,
	type Layout,
	type Step
} from '../../scripts/analyze/pagedrop.ts';
import type { MemoryImage } from '../../src/bake.ts';

const gm = 1024;
const base = pageBytes;

interface Spec {
	kind: ChunkKind;
	size: number;
}

/** a dlmalloc 2.8 heap of 32-bit chunks: the first spec at `base`, the top chunk last, bins linked */
function heap(specs: Spec[], pages = 8) {
	const mem = new Uint8Array(pages * pageBytes);
	const dv = new DataView(mem.buffer);
	const put = (at: number, value: number) => dv.setUint32(at, value, true);
	let at = base;
	let prevInUse = true;
	let dvAt = 0;
	let dvSize = 0;
	const small = new Map<number, number[]>();
	const tree: number[] = [];
	const starts: number[] = [];
	for (const { kind, size } of specs) {
		starts.push(at);
		const inUse = kind === 'inuse';
		put(at + 4, size | (prevInUse ? 1 : 0) | (inUse ? 2 : 0));
		if (kind === 'free') small.set(size >> 3, [...(small.get(size >> 3) ?? []), at]);
		if (kind === 'tree') tree.push(at);
		if (kind === 'dv') [dvAt, dvSize] = [at, size];
		if (!inUse && kind !== 'top') put(at + size, size);
		prevInUse = inUse;
		at += size;
	}
	const top = starts.at(-1)!;
	const topSize = specs.at(-1)!.size;
	put(gm + dl.top, top);
	put(gm + dl.topsize, topSize);
	put(gm + dl.dv, dvAt);
	put(gm + dl.dvsize, dvSize);
	put(gm + dl.seg, base);
	put(gm + dl.seg + 4, at + 40 - base);
	for (let index = 0; index < dl.smallBinCount; index++) {
		const bin = gm + dl.smallbins + index * 8;
		put(bin + 8, bin);
		put(bin + 12, bin);
	}
	for (const [index, list] of small) {
		const bin = gm + dl.smallbins + index * 8;
		const ring = [bin, ...list];
		ring.forEach((p, i) => {
			put(p + 8, ring[(i + 1) % ring.length]!);
			put(p + 12, ring[(i + ring.length - 1) % ring.length]!);
		});
	}
	if (tree.length) {
		put(gm + dl.treebins, tree[0]!);
		tree.forEach((p, i) => {
			put(p + 8, tree[(i + 1) % tree.length]!);
			put(p + 12, tree[(i + tree.length - 1) % tree.length]!);
		});
	}
	return { mem, starts };
}

const specs: Spec[] = [
	{ kind: 'inuse', size: 64 },
	{ kind: 'free', size: 32 },
	{ kind: 'inuse', size: 48 },
	{ kind: 'tree', size: 3 * pageBytes },
	{ kind: 'inuse', size: 64 },
	{ kind: 'top', size: 2 * pageBytes + 1000 }
];

test('walkHeap lists every chunk with its kind and flags a head that disagrees with its successor', () => {
	const { mem, starts } = heap(specs);
	const walk = walkHeap(mem, gm);
	expect(walk.anomalies).toEqual([]);
	expect(walk.chunks.map((chunk) => chunk.kind)).toEqual([
		'inuse',
		'free',
		'inuse',
		'tree',
		'inuse',
		'top'
	]);
	expect(walk.chunks.map((chunk) => chunk.at)).toEqual(starts);
	const broken = mem.slice();
	new DataView(broken.buffer).setUint32(starts[2]! + 4, 48 | 1 | 2, true);
	expect(walkHeap(broken, gm).anomalies.join()).toMatch(/pinuse/);
	new DataView(broken.buffer).setUint32(starts[1]! + 4, 7, true);
	expect(walkHeap(broken, gm).anomalies.join()).toMatch(/has size/);
});

test('labelRanges keeps heads, links and feet, tiles the segment, and frees only chunk bodies', () => {
	const { mem, starts } = heap(specs);
	const walk = walkHeap(mem, gm);
	const ranges = labelRanges(walk);
	expect(ranges[0]!.start).toBe(base);
	for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.start).toBe(ranges[i - 1]!.end);
	expect(ranges.at(-1)!.end).toBe(walk.end);
	const at = (address: number) => ranges.find((r) => r.start <= address && address < r.end)!.cls;
	const small = starts[1]!;
	expect([at(small + 4), at(small + 8), at(small + 12)]).toEqual(['meta', 'meta', 'meta']);
	expect([at(small + 16), at(small + 31)]).toEqual(['free', 'free']);
	expect(at(small + 32)).toBe('meta');
	const big = starts[3]!;
	expect([at(big + 4), at(big + 31)]).toEqual(['meta', 'meta']);
	expect(at(big + 32)).toBe('free');
	expect(at(big + 3 * pageBytes - 1)).toBe('free');
	expect(at(big + 3 * pageBytes)).toBe('meta');
	expect(at(starts[0]! + 8)).toBe('live');
	const top = starts[5]!;
	expect([at(top + 4), at(top + 8), at(top + 2 * pageBytes + 999)]).toEqual([
		'meta',
		'top',
		'top'
	]);
	expect(at(top + 2 * pageBytes + 1000)).toBe('meta');
});

test('classifyPages drops only pages inside free bodies, or pages whose other bytes equal the fresh instance', () => {
	const { mem } = heap(specs);
	const walk = walkHeap(mem, gm);
	const ranges = labelRanges(walk);
	for (const range of ranges)
		if (range.cls === 'free' || range.cls === 'top') mem.fill(0xa5, range.start, range.end);
	const fresh = new Uint8Array(mem.length);
	const layout: Layout = { dataEnd: base, stackTop: base, heapEnd: walk.end };
	const rows = classifyPages(mem, fresh, ranges, layout, [0, 1, 2, 3, 4, 5, 6]);
	expect(rows.filter((row) => row.strict).map((row) => row.page)).toEqual([2, 3, 5]);
	// page 6 holds top bytes and then zeros that equal the fresh instance
	expect(rows.filter((row) => row.droppable).map((row) => row.page)).toEqual([2, 3, 5, 6]);
	expect(rows.find((row) => row.page === 1)).toMatchObject({ strict: false, droppable: false });
	expect(rows.find((row) => row.page === 0)!.region).toBe('data');
	expect(rows.find((row) => row.page === 6)!.outside).toBeGreaterThan(0);
	expect(regionOf(layout, 7)).toBe('beyond');
	const summary = summarizeClasses(rows, walk, ranges);
	expect(summary.strict.pages).toBe(3);
	expect(summary.pagesWithFreeShareAtLeast[0.9]).toBe(5);
	expect(summary.droppable.pages).toBe(4);
	expect(summary.chunks.tree).toEqual({ chunks: 1, bytes: 3 * pageBytes });
	expect(largestFree(walk, 2)).toEqual([3 * pageBytes, 32]);
	// a live byte in the middle of the tree chunk's body keeps its page and only its page
	const at = 2 * pageBytes + 5;
	mem[at] = 1;
	const split = ranges.flatMap((range) =>
		range.start <= at && at < range.end
			? [
					{ ...range, end: at },
					{ start: at, end: at + 1, cls: 'live' as const },
					{ ...range, start: at + 1 }
				]
			: [range]
	);
	const kept = classifyPages(mem, fresh, split, layout, [2, 3]);
	expect(kept.map((row) => [row.strict, row.droppable])).toEqual([
		[false, false],
		[true, true]
	]);
});

test('checkAllocator accepts a linked heap and names a broken link, an unlinked chunk and a damaged head', () => {
	const { mem, starts } = heap([
		...specs.slice(0, 3),
		{ kind: 'tree', size: 512 },
		...specs.slice(4)
	]);
	expect(checkAllocator(mem, gm)).toMatchObject({ ok: true, free: 2, linked: 2 });
	const broken = mem.slice();
	new DataView(broken.buffer).setUint32(starts[1]! + 8, starts[0]!, true);
	expect(checkAllocator(broken, gm).errors.join()).toMatch(/not a free chunk head/);
	const lost = mem.slice();
	new DataView(lost.buffer).setUint32(gm + dl.treebins, 0, true);
	expect(checkAllocator(lost, gm).errors.join()).toMatch(/is in no bin/);
	const zeroed = mem.slice();
	zeroed.fill(0, starts[1]! + 4, starts[1]! + 16);
	expect(checkAllocator(zeroed, gm).ok).toBe(false);
});

test('dropPages removes pages from an image and equalRuns counts bytes equal to the fresh memory', () => {
	const data = new Uint8Array(3 * pageBytes).map((_, i) => (i % pageBytes < 100 ? 7 : 0));
	const image: MemoryImage = { byteLength: 9 * pageBytes, pages: [2, 4, 5], data };
	const less = dropPages(image, new Set([4]));
	expect(less.pages).toEqual([2, 5]);
	expect(less.data.length).toBe(2 * pageBytes);
	expect(less.byteLength).toBe(image.byteLength);
	const mem = new Uint8Array(9 * pageBytes);
	mem.fill(7, 2 * pageBytes, 2 * pageBytes + 100);
	mem.fill(9, 4 * pageBytes + 1000, 4 * pageBytes + 1100);
	const fresh = new Uint8Array(9 * pageBytes);
	expect(equalRuns(mem, fresh, [2, 4], 1000)).toEqual({
		minRun: 1000,
		bytes: 65_436 + 1000 + 64_436,
		runs: 3
	});
});

test('maskOf and parseMask round trip, and runsOf joins adjacent pages', () => {
	const pages = [1, 2, 3, 7, 9, 10];
	expect(runsOf(pages)).toEqual([
		[1, 3],
		[7, 7],
		[9, 10]
	]);
	expect(maskOf(pages)).toBe('1-3,7,9-10');
	expect(parseMask('1-3,7,9-10')).toEqual(pages);
	expect(parseMask('')).toEqual([]);
});

test('bisectPoison finds exactly the pages the render reads when each page alone decides the result', async () => {
	const pages = Array.from({ length: 200 }, (_, i) => i * 3);
	const read = new Set([0, 3, 90, 91 * 3, 450, 597]);
	const seen: number[][] = [];
	const result = await bisectPoison(pages, async (set) => {
		seen.push(set);
		return !set.some((page) => read.has(page));
	});
	expect(result.bad).toEqual(
		[...read].filter((page) => pages.includes(page)).sort((a, b) => a - b)
	);
	expect(result.kept.length + result.bad.length).toBe(pages.length);
	expect(result.kept.some((page) => read.has(page))).toBe(false);
	expect(result.tries).toBe(seen.length);
	expect(result.tries).toBeLessThan(pages.length);
	expect((await bisectPoison([], async () => true)).tries).toBe(0);
	const everything = await bisectPoison([1, 2, 3], async () => false);
	expect(everything).toMatchObject({ kept: [], bad: [1, 2, 3] });
});

test('judgeTrial passes only a trial with every reference step equal, and keeps a transport failure', () => {
	const ref: Step[] = [
		{ step: '/', status: 200, bytes: 10, sha: 'a' },
		{ step: '/x', status: 404, bytes: 5, sha: 'b' }
	];
	const trial = { pass: true, steps: ref.map((step) => ({ ...step })), wallMs: 1 };
	expect(judgeTrial(trial, ref).pass).toBe(true);
	expect(judgeTrial({ ...trial, steps: [ref[0]!] }, ref)).toMatchObject({
		pass: false,
		failed: '/x'
	});
	const changed = [ref[0]!, { ...ref[1]!, sha: 'c' }];
	expect(judgeTrial({ ...trial, steps: changed }, ref)).toMatchObject({
		pass: false,
		failed: '/x'
	});
	const status = [{ ...ref[0]!, status: 500 }, ref[1]!];
	expect(judgeTrial({ ...trial, steps: status }, ref)).toMatchObject({
		pass: false,
		failed: '/'
	});
	expect(judgeTrial({ ...trial, failed: 'boot' }, ref)).toMatchObject({
		pass: false,
		failed: 'boot'
	});
});

test('normalizeBody masks the per-object ids and nothing else', () => {
	const form = 'form-ldc-g8qdbuuvryszo4-u4bpz1vbahqfyamkk-euxn0o';
	const body = `<div class="js-view-dom-id-0a1b2c3d" data-drupal-selector="${form}"><p class="form-item">x</p></div>`;
	const out = normalizeBody(body);
	expect(out).toBe(
		'<div class="js-view-dom-id-X" data-drupal-selector="form-X"><p class="form-item">x</p></div>'
	);
	expect(normalizeBody(out)).toBe(out);
});

test('summarizePageDrop keeps the last classification, counts search trials and groups cold rows by label', () => {
	const tag = { wasmSha256: 'w', glueSha256: 'g' };
	const cold = (label: string, ms: number) => ({
		...tag,
		kind: 'cold',
		label,
		firstWallMs: ms,
		firstRenderMs: ms - 10,
		rebootWallMs: ms + 5,
		load1: 1,
		sha: 'x'
	});
	const rows = [
		{ ...tag, kind: 'classify', image: 'old' },
		{ ...tag, kind: 'classify', image: 'new' },
		{ ...tag, kind: 'trial', phase: 'search', pass: true, pages: 3 },
		{ ...tag, kind: 'trial', phase: 'search', pass: false, pages: 8 },
		{ ...tag, kind: 'trial', phase: 'confirm-0', pass: true, pages: 3 },
		{
			...tag,
			kind: 'drop',
			name: 'sound',
			bakedBytes: 2_097_152 + 100,
			plainBytes: 100,
			keptPages: 5
		},
		cold('a', 300),
		cold('a', 100),
		cold('a', 200),
		cold('b', 50)
	];
	const summary = summarizePageDrop(rows);
	expect(summary.interpreter).toEqual(['w:g']);
	expect(summary.classify.map((row) => row.image)).toEqual(['new']);
	expect(summary.trials.search).toEqual({ n: 2, pass: 1, passedPages: 3 });
	expect(summary.trials.confirm).toEqual([{ phase: 'confirm-0', pages: 3, pass: true }]);
	expect(summary.drops[0]).toMatchObject({ growthOverPlainMiB: 2, keptPages: 5 });
	expect(summary.cold.map((row) => [row.label, row.n, row.firstWallMs.median])).toEqual([
		['a', 3, 200],
		['b', 1, 50]
	]);
});
