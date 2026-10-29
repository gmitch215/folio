import { existsSync } from 'node:fs';
import type { MemoryImage } from '../../src/bake.ts';
import { parseRows, readRaw, resultsRoot, stats, writeSummary, type Row } from './lib.ts';

// page drop summary: which pages of a baked image hold dlmalloc free memory, and what a render
// that poisons them still produces. usage: analyzePageDrop('boot/residency')

export const pageBytes = 65_536;

/** dlmalloc 2.8 on a 32-bit target: the fields of `malloc_state` this analysis reads */
export const dl = {
	treemap: 4,
	dvsize: 8,
	topsize: 12,
	dv: 20,
	top: 24,
	smallbins: 40,
	treebins: 304,
	seg: 448,
	smallBinCount: 32,
	treeBinCount: 32,
	minLarge: 256,
	minChunk: 16
} as const;

export type ChunkKind = 'inuse' | 'free' | 'tree' | 'dv' | 'top';

export interface Chunk {
	at: number;
	size: number;
	kind: ChunkKind;
}

/** one chunk owns the bytes [at + 4, at + size + 4): its head, its payload, the next prev_foot */
export interface HeapWalk {
	base: number;
	end: number;
	chunks: Chunk[];
	top: number;
	dv: number;
	anomalies: string[];
}

export type ByteClass = 'live' | 'free' | 'top' | 'meta';

export interface Range {
	start: number;
	end: number;
	cls: ByteClass;
}

const view = (mem: Uint8Array) => new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

/** the one segment of the heap, read from the allocator state at `gm` */
export function readSegment(mem: Uint8Array, gm: number) {
	const dv = view(mem);
	const at = gm + dl.seg;
	const base = dv.getUint32(at, true);
	const size = dv.getUint32(at + 4, true);
	const next = dv.getUint32(at + 8, true);
	if (next !== 0) throw new Error('the heap has more than one segment');
	return { base, size, end: base + size };
}

/**
 * Walks the chunks of the segment from its first chunk to the top chunk. A bad head ends the walk
 * and is recorded, so a damaged heap never classifies as droppable past the damage.
 */
export function walkHeap(mem: Uint8Array, gm: number): HeapWalk {
	const dv = view(mem);
	const u32 = (a: number) => dv.getUint32(a, true);
	const seg = readSegment(mem, gm);
	const top = u32(gm + dl.top);
	const dvAt = u32(gm + dl.dv);
	const topSize = u32(gm + dl.topsize);
	const chunks: Chunk[] = [];
	const anomalies: string[] = [];
	let p = seg.base;
	while (p < top) {
		const head = u32(p + 4);
		const size = head & ~7;
		const inuse = (head & 2) !== 0;
		if (size < dl.minChunk || size % 8 || p + size > top) {
			anomalies.push(`chunk ${p} has size ${size} (head ${head})`);
			break;
		}
		if (((u32(p + size + 4) & 1) !== 0) !== inuse)
			anomalies.push(`chunk ${p} cinuse ${inuse} but its successor's pinuse bit disagrees`);
		const kind: ChunkKind = inuse
			? 'inuse'
			: p === dvAt
				? 'dv'
				: size >= dl.minLarge
					? 'tree'
					: 'free';
		if (p === dvAt && (inuse || size !== u32(gm + dl.dvsize)))
			anomalies.push(`dv at ${p} has size ${size}, state says ${u32(gm + dl.dvsize)}`);
		chunks.push({ at: p, size, kind });
		p += size;
	}
	if (p === top) {
		const head = u32(top + 4);
		if ((head & ~7) !== topSize) anomalies.push(`top head size ${head & ~7}, state ${topSize}`);
		chunks.push({ at: top, size: topSize, kind: 'top' });
	} else anomalies.push(`walk ended at ${p}, top is ${top}`);
	if (dvAt && !chunks.some((chunk) => chunk.at === dvAt))
		anomalies.push(`dv ${dvAt} is not a chunk start`);
	return { base: seg.base, end: seg.end, chunks, top, dv: dvAt, anomalies };
}

/**
 * Labels every byte of the segment. Kept for the allocator: heads, the links of a free chunk (two
 * words for a small chunk, six for a tree chunk, two for the dv which is not linked), the foot of
 * a free chunk, the head of the top chunk and the bytes after it. Free: the rest of a free chunk.
 */
export function labelRanges(walk: HeapWalk): Range[] {
	const out: Range[] = [];
	const add = (start: number, end: number, cls: ByteClass) => {
		if (end <= start) return;
		const last = out.at(-1);
		if (last && last.cls === cls && last.end === start) last.end = end;
		else out.push({ start, end, cls });
	};
	add(walk.base, walk.base + 4, 'meta');
	for (const { at, size, kind } of walk.chunks) {
		const own = at + 4;
		const end = at + size + 4;
		if (kind === 'inuse') {
			add(own, own + 4, 'meta');
			add(own + 4, end, 'live');
		} else if (kind === 'top') {
			add(own, own + 4, 'meta');
			add(own + 4, at + size, 'top');
			add(at + size, end, 'meta');
		} else {
			const links = kind === 'tree' ? 28 : 12;
			add(own, at + 4 + links, 'meta');
			add(at + 4 + links, at + size, 'free');
			add(at + size, end, 'meta');
		}
	}
	const last = walk.chunks.at(-1);
	if (last) add(last.at + last.size + 4, walk.end, 'meta');
	return out;
}

export type Region = 'data' | 'stack' | 'heap' | 'beyond';

export interface Layout {
	dataEnd: number;
	stackTop: number;
	heapEnd: number;
}

/** data: below the stack, stack: below the heap base, heap: the allocator segment, beyond: after it */
export function regionOf(layout: Layout, page: number): Region {
	const start = page * pageBytes;
	const end = start + pageBytes;
	if (end <= layout.dataEnd) return 'data';
	if (start >= layout.heapEnd) return 'beyond';
	if (end <= layout.stackTop) return start < layout.dataEnd ? 'data' : 'stack';
	return 'heap';
}

export interface PageClass {
	page: number;
	region: Region;
	live: number;
	free: number;
	top: number;
	meta: number;
	outside: number;
	zero: boolean;
	/** bytes that differ from the fresh instance, and how many of them lie in free or top bytes */
	differ: number;
	differInDroppable: number;
	/** every byte of the page lies in free or top bytes */
	strict: boolean;
	/** every byte that differs from the fresh instance lies in free or top bytes */
	droppable: boolean;
}

/**
 * Per delta page: bytes by label, and the two drop tests. `strict` is the rule that needs no
 * knowledge of the fresh instance (the page lies inside free bodies). `droppable` also accepts a
 * page whose live and meta bytes equal the fresh instance's, which reads the same once dropped.
 */
export function classifyPages(
	mem: Uint8Array,
	fresh: Uint8Array,
	ranges: Range[],
	layout: Layout,
	pages: number[]
): PageClass[] {
	const out: PageClass[] = [];
	const wanted = new Set(pages);
	const drop = ranges.filter((range) => range.cls === 'free' || range.cls === 'top');
	const rows = new Map<number, PageClass>();
	for (const page of wanted) {
		const start = page * pageBytes;
		let differ = 0;
		let zero = true;
		for (let i = 0; i < pageBytes; i++) {
			const byte = mem[start + i]!;
			if (byte !== 0) zero = false;
			if (byte !== (fresh[start + i] ?? 0)) differ++;
		}
		rows.set(page, {
			page,
			region: regionOf(layout, page),
			live: 0,
			free: 0,
			top: 0,
			meta: 0,
			outside: pageBytes,
			zero,
			differ,
			differInDroppable: 0,
			strict: false,
			droppable: false
		});
	}
	for (const range of ranges) {
		const first = Math.floor(range.start / pageBytes);
		const last = Math.floor((range.end - 1) / pageBytes);
		for (let page = first; page <= last; page++) {
			const row = rows.get(page);
			if (!row) continue;
			const lo = Math.max(range.start, page * pageBytes);
			const hi = Math.min(range.end, (page + 1) * pageBytes);
			row[range.cls] += hi - lo;
			row.outside -= hi - lo;
		}
	}
	for (const range of drop) {
		const first = Math.floor(range.start / pageBytes);
		const last = Math.floor((range.end - 1) / pageBytes);
		for (let page = first; page <= last; page++) {
			const row = rows.get(page);
			if (!row) continue;
			const lo = Math.max(range.start, page * pageBytes);
			const hi = Math.min(range.end, (page + 1) * pageBytes);
			for (let i = lo; i < hi; i++) if (mem[i] !== (fresh[i] ?? 0)) row.differInDroppable++;
		}
	}
	for (const row of rows.values()) {
		row.strict = row.free + row.top === pageBytes;
		row.droppable = row.differInDroppable === row.differ;
		out.push(row);
	}
	return out.sort((a, b) => a.page - b.page);
}

export interface Allocation {
	ok: boolean;
	errors: string[];
	chunks: number;
	free: number;
	linked: number;
}

/**
 * Checks the allocator from its own state: every small bin and tree bin link must land on the head
 * of a free chunk of the right size class, every free chunk must be linked, and the chunk walk
 * must reach the top chunk. This reads the memory the way malloc and free would.
 */
export function checkAllocator(mem: Uint8Array, gm: number): Allocation {
	const dv = view(mem);
	const u32 = (a: number) => dv.getUint32(a, true);
	const walk = walkHeap(mem, gm);
	const errors = [...walk.anomalies];
	const free = new Map<number, Chunk>();
	for (const chunk of walk.chunks)
		if (chunk.kind === 'free' || chunk.kind === 'tree') free.set(chunk.at, chunk);
	const seen = new Set<number>();
	const visit = (p: number, want: 'free' | 'tree', where: string) => {
		const chunk = free.get(p);
		if (!chunk) {
			errors.push(`${where}: ${p} is not a free chunk head`);
			return false;
		}
		if (chunk.kind !== want) errors.push(`${where}: ${p} is ${chunk.kind}, expected ${want}`);
		if (seen.has(p)) errors.push(`${where}: ${p} is linked twice`);
		seen.add(p);
		return true;
	};
	for (let i = 0; i < dl.smallBinCount; i++) {
		const bin = gm + dl.smallbins + i * 8;
		const where = `smallbin ${i}`;
		let p = u32(bin + 8);
		for (let guard = 0; p !== bin && guard < 1e7; guard++) {
			if (!visit(p, 'free', where)) break;
			const chunk = free.get(p)!;
			if (chunk.size >> 3 !== i) errors.push(`${where}: chunk ${p} has size ${chunk.size}`);
			if (u32(u32(p + 8) + 12) !== p) errors.push(`${where}: ${p} fd.bk does not return`);
			p = u32(p + 8);
		}
	}
	const tree = (t: number, where: string, depth: number) => {
		if (!t) return;
		if (depth > 64) {
			errors.push(`${where}: tree deeper than 64`);
			return;
		}
		let u = t;
		for (let guard = 0; guard < 1e7; guard++) {
			if (!visit(u, 'tree', where)) return;
			u = u32(u + 8);
			if (u === t) break;
		}
		tree(u32(t + 16), where, depth + 1);
		tree(u32(t + 20), where, depth + 1);
	};
	for (let i = 0; i < dl.treeBinCount; i++)
		tree(u32(gm + dl.treebins + i * 4), `treebin ${i}`, 0);
	for (const p of free.keys()) if (!seen.has(p)) errors.push(`free chunk ${p} is in no bin`);
	return {
		ok: errors.length === 0,
		errors: errors.slice(0, 20),
		chunks: walk.chunks.length,
		free: free.size,
		linked: seen.size
	};
}

export interface Tally {
	pages: number;
	bytes: number;
}

const tally = (rows: PageClass[]): Tally => ({
	pages: rows.length,
	bytes: rows.length * pageBytes
});

/** the classification of one image as one table: counts and bytes per class and per region */
export function summarizeClasses(rows: PageClass[], walk: HeapWalk, ranges: Range[]) {
	const regions = {} as Record<Region, Tally>;
	for (const region of ['data', 'stack', 'heap', 'beyond'] as Region[])
		regions[region] = tally(rows.filter((row) => row.region === region));
	const bytes = { live: 0, free: 0, top: 0, meta: 0 };
	for (const range of ranges) bytes[range.cls] += range.end - range.start;
	const kinds: Record<string, { chunks: number; bytes: number }> = {};
	for (const chunk of walk.chunks) {
		const row = (kinds[chunk.kind] ??= { chunks: 0, bytes: 0 });
		row.chunks++;
		row.bytes += chunk.size;
	}
	const inHeap = rows.filter((row) => row.region === 'heap');
	return {
		deltaPages: tally(rows),
		regions,
		allZero: tally(rows.filter((row) => row.zero)),
		heapBytesByLabel: bytes,
		chunks: kinds,
		pagesWithFreeShareAtLeast: Object.fromEntries(
			[0.01, 0.1, 0.5, 0.9].map((share) => [
				share,
				rows.filter((row) => (row.free + row.top) / pageBytes >= share).length
			])
		),
		strict: tally(rows.filter((row) => row.strict)),
		strictInHeap: tally(inHeap.filter((row) => row.strict)),
		droppable: tally(rows.filter((row) => row.droppable)),
		droppableByRegion: Object.fromEntries(
			(['data', 'stack', 'heap', 'beyond'] as Region[]).map((region) => [
				region,
				tally(rows.filter((row) => row.droppable && row.region === region))
			])
		),
		unclassified: tally(rows.filter((row) => row.outside > 0 && row.region === 'heap')),
		anomalies: walk.anomalies.length
	};
}

/** the image without the pages in `drop`; the dropped pages read as the fresh instance */
export function dropPages(image: MemoryImage, drop: Set<number>): MemoryImage {
	const pages: number[] = [];
	const parts: Uint8Array[] = [];
	image.pages.forEach((page, i) => {
		if (drop.has(page)) return;
		pages.push(page);
		parts.push(image.data.subarray(i * pageBytes, (i + 1) * pageBytes));
	});
	const data = new Uint8Array(pages.length * pageBytes);
	parts.forEach((part, i) => data.set(part, i * pageBytes));
	return { ...image, pages, data };
}

/**
 * Bytes of the delta pages that equal the fresh instance in runs of at least `minRun`. An image
 * that stored only the other bytes, as data segments with gaps, would replay to the same memory.
 */
export function equalRuns(mem: Uint8Array, fresh: Uint8Array, pages: number[], minRun: number) {
	let bytes = 0;
	let runs = 0;
	for (const page of pages) {
		const start = page * pageBytes;
		let run = 0;
		for (let i = 0; i <= pageBytes; i++) {
			if (i < pageBytes && mem[start + i] === (fresh[start + i] ?? 0)) {
				run++;
				continue;
			}
			if (run >= minRun) {
				bytes += run;
				runs++;
			}
			run = 0;
		}
	}
	return { minRun, bytes, runs };
}

/** the free chunk sizes, largest first: a page can only come out of a chunk of 64 KiB or more */
export const largestFree = (walk: HeapWalk, count = 5) =>
	walk.chunks
		.filter((chunk) => chunk.kind !== 'inuse' && chunk.kind !== 'top')
		.map((chunk) => chunk.size)
		.sort((a, b) => b - a)
		.slice(0, count);

/** a page list as the `a-b,c` form the poison route takes, and back */
export const maskOf = (pages: number[]) =>
	runsOf(pages)
		.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
		.join(',');

export function parseMask(mask: string): number[] {
	const pages: number[] = [];
	for (const part of mask.split(',')) {
		if (!part) continue;
		const [a, b] = part.split('-').map(Number) as [number, number | undefined];
		for (let page = a; page <= (b ?? a); page++) pages.push(page);
	}
	return pages;
}

export interface Step {
	step: string;
	status: number;
	bytes: number;
	sha: string;
}

export interface Trial {
	pass: boolean;
	steps: Step[];
	failed?: string;
	wallMs: number;
	boot?: unknown;
}

/** a trial passes when it has every reference step with the same status and normalized body */
export function judgeTrial(trial: Trial, reference: Step[]): Trial {
	const bad = reference.find((want, i) => {
		const got = trial.steps[i];
		return !got || got.status !== want.status || got.sha !== want.sha;
	});
	if (!bad && trial.steps.length === reference.length && !trial.failed)
		return { ...trial, pass: true };
	return { ...trial, pass: false, failed: trial.failed ?? bad?.step ?? 'length' };
}

/** what a render is compared on: the fields that differ per object or per request are masked */
export const normalizeBody = (body: string) =>
	body
		.replace(/js-view-dom-id-[A-Za-z0-9_-]+/g, 'js-view-dom-id-X')
		.replace(/form-[A-Za-z0-9_-]{30,}/g, 'form-X');

/** splits sorted pages into runs of adjacent pages, for printing and for the bisect */
export function runsOf(pages: number[]): [number, number][] {
	const runs: [number, number][] = [];
	for (const page of pages) {
		const last = runs.at(-1);
		if (last && last[1] + 1 === page) last[1] = page;
		else runs.push([page, page]);
	}
	return runs;
}

/**
 * Poison search. `passes(set)` renders with the set poisoned and says whether every render stayed
 * equal. A failing set splits in halves, searched together, down to single pages. A render depends
 * only on the poisoned pages it reads, so the passing sets combine; the caller confirms the union.
 */
export async function bisectPoison(
	candidates: number[],
	passes: (set: number[]) => Promise<boolean>
): Promise<{ kept: number[]; bad: number[]; tries: number }> {
	let tries = 0;
	const bad: number[] = [];
	const ok: number[] = [];
	const go = async (set: number[]): Promise<void> => {
		if (!set.length) return;
		tries++;
		if (await passes(set)) {
			ok.push(...set);
			return;
		}
		if (set.length === 1) {
			bad.push(...set);
			return;
		}
		const mid = set.length >> 1;
		await Promise.all([go(set.slice(0, mid)), go(set.slice(mid))]);
	};
	await go(candidates);
	return { kept: ok.sort((a, b) => a - b), bad: bad.sort((a, b) => a - b), tries };
}

const mib = (bytes: number) => Math.round((bytes / 1_048_576) * 100) / 100;

const by = <T>(rows: T[], key: (row: T) => string) => {
	const groups = new Map<string, T[]>();
	for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
	return groups;
};

/** the probe rows as one summary: classification, the drops, the poison search, cold times, scans */
export function summarizePageDrop(rows: Row[]) {
	const of = (kind: string) => rows.filter((row) => row.kind === kind);
	const trials = of('trial');
	const search = trials.filter((row) => row.phase === 'search');
	return {
		interpreter: [...new Set(rows.map((row) => `${row.wasmSha256}:${row.glueSha256}`))],
		classify: of('classify')
			.slice(-1)
			.map((row) => ({
				image: row.image,
				snapshotEqualsDump: row.snapshotEqualsDump,
				allocator: row.allocator,
				largestFreeChunks: row.largestFreeChunks,
				mixedPages: row.mixedPages,
				stackPages: row.stackPages,
				equalRuns: row.equalRuns,
				summary: row.summary
			})),
		drops: of('drop').map((row) => ({
			name: row.name,
			droppedPages: row.droppedPages,
			keptPages: row.keptPages,
			keptBytes: row.keptBytes,
			bakedBytes: row.bakedBytes,
			growthOverPlainMiB: mib(row.bakedBytes - row.plainBytes),
			checkEqual: row.checkEqual,
			droppedReadFresh: row.droppedReadFresh,
			droppedPagesNotInsideFreeBytes: row.droppedPagesNotInsideFreeBytes,
			allocatorOk: row.allocatorOk,
			allocatorErrors: row.allocator?.errors?.length ?? null
		})),
		trials: {
			baseline: trials
				.filter((row) => /^(reference|baseline)/.test(row.phase))
				.map((row) => ({ phase: row.phase, pass: row.pass })),
			search: {
				n: search.length,
				pass: search.filter((row) => row.pass).length,
				passedPages: search
					.filter((row) => row.pass)
					.reduce((sum, row) => sum + row.pages, 0)
			},
			confirm: trials
				.filter((row) => row.phase.startsWith('confirm') || row.phase.startsWith('check'))
				.map((row) => ({ phase: row.phase, pages: row.pages, pass: row.pass }))
		},
		poison: of('poison').map((row) => ({
			candidates: row.candidates,
			clearedPages: row.clearedPages,
			neededPages: row.neededPages,
			tries: row.tries,
			confirm: row.confirm,
			classesOfCleared: row.classesOfCleared
		})),
		followUp: [...of('greedy'), ...of('reverify')].map((row) => ({
			kind: row.kind,
			clearedPages: row.clearedPages,
			refusedPages: row.refusedPages,
			flipped: row.flipped,
			confirm: row.confirm
		})),
		checks: of('check').map((row) => ({ label: row.label, runs: row.runs, rekey: row.rekey })),
		cold: [...by(of('cold'), (row) => row.label)].map(([label, group]) => ({
			label,
			n: group.length,
			firstWallMs: stats(group.map((row) => row.firstWallMs)),
			firstRenderMs: stats(group.map((row) => row.firstRenderMs)),
			rebootWallMs: stats(group.map((row) => row.rebootWallMs)),
			load1: stats(group.map((row) => row.load1)),
			bodies: [...new Set(group.map((row) => row.sha))]
		})),
		scans: of('scan').map((row) => ({
			image: row.image,
			pages: row.pages,
			results: row.results
		})),
		bundles: of('bundle').map((row) => ({
			label: row.label,
			moduleBytes: row.moduleBytes,
			totalUploadKiB: row.totalUploadKiB,
			nonModuleKiB: row.nonModuleKiB,
			limitMiB: row.limitMiB
		}))
	};
}

export function analyzePageDrop(set: string) {
	const root = resultsRoot(set);
	const name = 'rows.jsonl';
	if (!existsSync(new URL(name, root))) throw new Error(`no ${name} in ${set}`);
	const summary = summarizePageDrop(parseRows(readRaw(root, name)));
	writeSummary(root, summary);
	return summary;
}

if (import.meta.main) analyzePageDrop(process.argv[2] ?? 'boot/residency');
