import binaryen from 'binaryen';

export const PAGE = 65536;

export interface Regions {
	/** end of the highest active data segment */
	dataEnd: number;
	/** lowest byte of any active data segment */
	dataStart: number;
	/** the stack pointer global's initial value, which is also where the heap starts */
	stackBase: number;
	/** lowest stack byte: the base minus the stack reservation (the bss lies between dataEnd and here) */
	stackEnd: number;
	segments: number;
}

/** TOTAL_STACK of the shipping interpreter, as `emscripten_stack_get_end` reported it in the census. */
export const STACK_RESERVATION = 33554432;

export type Region = 'static' | 'stack' | 'heap';
export type PageCounts = Record<string, [reads: number, writes: number]>;

function reader(bytes: Uint8Array, start: number) {
	let at = start;
	const u = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[at++]!;
			value += (byte & 127) * 2 ** shift;
			shift += 7;
		} while (byte & 128);
		return value;
	};
	const s = () => {
		let value = 0,
			shift = 0,
			byte: number;
		do {
			byte = bytes[at++]!;
			value |= (byte & 127) << shift;
			shift += 7;
		} while (byte & 128);
		if (shift < 32 && byte & 64) value |= -1 << shift;
		return value >>> 0;
	};
	return { u, s, at: () => at, skip: (n: number) => (at += n) };
}

/** Active data segments with an i32.const offset, in module order. */
export function dataSegments(bytes: Uint8Array) {
	const out: { start: number; end: number }[] = [];
	let cursor = 8;
	while (cursor < bytes.length) {
		const r = reader(bytes, cursor);
		const kind = bytes[r.at()]!;
		r.skip(1);
		const length = r.u();
		const payload = r.at();
		if (kind === 11) {
			const d = reader(bytes, payload);
			const count = d.u();
			for (let i = 0; i < count; i++) {
				const flag = d.u();
				if (flag === 2) d.u();
				if (flag === 1) {
					d.skip(d.u());
					continue;
				}
				if (bytes[d.at()] !== 0x41) throw new Error('data segment offset is not i32.const');
				d.skip(1);
				const start = d.s();
				if (bytes[d.at()] !== 0x0b)
					throw new Error('data segment offset is not a constant');
				d.skip(1);
				const size = d.u();
				out.push({ start, end: start + size });
				d.skip(size);
			}
			break;
		}
		cursor = payload + length;
	}
	return out;
}

export function readRegions(bytes: Uint8Array, stackBytes = STACK_RESERVATION): Regions {
	const segments = dataSegments(bytes);
	const mod = binaryen.readBinary(bytes);
	try {
		const info = binaryen.getGlobalInfo(mod.getGlobalByIndex(0));
		if (!info.mutable || info.type !== binaryen.i32)
			throw new Error('global 0 is not a stack pointer');
		const init = binaryen.getExpressionInfo(info.init) as unknown as {
			id: number;
			value: number;
		};
		if (init.id !== binaryen.ConstId) throw new Error('global 0 has no constant initial value');
		return {
			dataStart: Math.min(...segments.map((s) => s.start)),
			dataEnd: Math.max(...segments.map((s) => s.end)),
			stackBase: init.value >>> 0,
			stackEnd: (init.value >>> 0) - stackBytes,
			segments: segments.length
		};
	} finally {
		mod.dispose();
	}
}

/** Region of a byte address; the stack is the span between the end of static data and the stack base. */
export function regionOf(address: number, regions: Regions): Region {
	if (address < regions.stackEnd) return 'static';
	if (address < regions.stackBase) return 'stack';
	return 'heap';
}

export interface RegionStat {
	pages: number;
	accesses: number;
	/** first to last page of the set, in pages, inclusive; 0 when empty */
	spanPages: number;
	first: number | null;
	last: number | null;
}

const empty = (): RegionStat => ({ pages: 0, accesses: 0, spanPages: 0, first: null, last: null });

function stat(pages: number[], counts: PageCounts, region: (page: number) => Region | 'all') {
	const out: Record<Region | 'all', RegionStat> = {
		static: empty(),
		stack: empty(),
		heap: empty(),
		all: empty()
	};
	for (const page of pages) {
		for (const key of [region(page), 'all'] as const) {
			const s = out[key];
			s.pages++;
			s.accesses += counts[page]![0] + counts[page]![1];
			s.first = s.first === null ? page : Math.min(s.first, page);
			s.last = s.last === null ? page : Math.max(s.last, page);
		}
	}
	for (const s of Object.values(out)) s.spanPages = s.first === null ? 0 : s.last! - s.first + 1;
	return out;
}

/** Smallest set of pages, taken in descending access order, that reaches `fraction` of all accesses. */
export function hotSet(counts: PageCounts, fraction: number) {
	const rows = Object.entries(counts)
		.map(([page, [r, w]]) => [Number(page), r + w] as const)
		.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	const total = rows.reduce((sum, row) => sum + row[1], 0);
	const pages: number[] = [];
	let acc = 0;
	for (const [page, n] of rows) {
		pages.push(page);
		acc += n;
		if (acc >= fraction * total) break;
	}
	return { pages, total };
}

/** Region and span of the touched set and of the 90% and 99% hot sets, at 64 KiB pages. */
export function spanReport(counts: PageCounts, regions: Regions, linearBytes: number) {
	const region = (page: number) => regionOf(page * PAGE, regions);
	const touched = Object.keys(counts)
		.map(Number)
		.sort((a, b) => a - b);
	const total = touched.reduce((sum, p) => sum + counts[p]![0] + counts[p]![1], 0);
	const linearPages = linearBytes / PAGE;
	const mixed = [Math.floor(regions.stackEnd / PAGE), Math.floor(regions.stackBase / PAGE)];
	const sets: Record<string, ReturnType<typeof stat>> = {
		touched: stat(touched, counts, region)
	};
	for (const fraction of [0.5, 0.9, 0.99]) {
		const hot = hotSet(counts, fraction).pages;
		sets[`hot${Math.round(fraction * 100)}`] = stat(hot, counts, region);
	}
	const share = Object.fromEntries(
		(['static', 'stack', 'heap'] as const).map((r) => [
			r,
			total ? sets.touched![r]!.accesses / total : 0
		])
	);
	const hot90 = sets.hot90!.all;
	return {
		accesses: total,
		linearPages,
		boundaryPages: mixed,
		accessShare: share,
		sets,
		window: {
			hot90SpanPages: hot90.spanPages,
			hot90SpanMiB: (hot90.spanPages * PAGE) / 1048576,
			hot90Pages: hot90.pages,
			linearMiB: linearBytes / 1048576,
			spanOverLinear: linearPages ? hot90.spanPages / linearPages : null,
			hot90WithoutStackHoleSpanMiB:
				((sets.hot90!.static.spanPages +
					sets.hot90!.stack.spanPages +
					sets.hot90!.heap.spanPages) *
					PAGE) /
				1048576
		}
	};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const { readFileSync } = await import('node:fs');
	const file = process.argv[2];
	if (!file) throw new Error('usage: node translation-span.ts <wasm>');
	console.log(JSON.stringify(readRegions(readFileSync(file)), null, 1));
}
