import binaryen from 'binaryen';
import { expect, test } from 'vitest';
import { installGlueHooks, patchGlue } from '../../scripts/research/elastic-pager-glue.ts';
import {
	LogicalHeap,
	Lz4PoolStore,
	Pager,
	physicalPagesFor,
	type Layout,
	type PageStore
} from '../../scripts/research/elastic-pager.ts';
import { translate } from '../../scripts/research/elastic-translate.ts';

const PAGE = 65536;
// pages 0 to 3 identity, table in page 4, frames in physical pages 5 to 8 then 12 and up, heap from page 16
const layout: Layout = {
	tableBase: 4 * PAGE,
	identity: [[0, 5]],
	heapStart: 16,
	frameRuns: [
		[5, 9],
		[12, Infinity]
	]
};
const HEAP = 16 * PAGE;

class MapStore implements PageStore {
	pages = new Map<number, Uint8Array>();
	reads: number[] = [];
	writes: number[] = [];
	storedBytes = 0;
	read(page: number, into: Uint8Array) {
		this.reads.push(page);
		into.set(this.pages.get(page)!);
	}
	write(page: number, bytes: Uint8Array) {
		this.writes.push(page);
		this.pages.set(page, bytes.slice());
	}
}

function make(frames: number, store: PageStore = new MapStore(), logicalPages = 64) {
	const memory = new WebAssembly.Memory({ initial: physicalPagesFor(layout, frames) });
	const pager = new Pager({ memory, layout, frames, store, logicalBytes: logicalPages * PAGE });
	return { memory, pager, heap: new LogicalHeap(pager), store: store as MapStore };
}

const pattern = (n: number, seed: number) =>
	Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

test('physical pages cover the identity region and the frames after the first run', () => {
	expect(physicalPagesFor(layout, 4)).toBe(9);
	expect(physicalPagesFor(layout, 6)).toBe(14);
	expect(physicalPagesFor({ ...layout, tableBase: 4 * PAGE, writeTableBase: 40 * PAGE }, 4)).toBe(
		44
	);
});

test('the table starts identity below the heap, miss in the reserved range and above', () => {
	const { memory } = make(4);
	const table = new Int32Array(memory.buffer, layout.tableBase, 65536);
	expect(Array.from(table.subarray(0, 5))).toEqual([0, 0, 0, 0, 0]);
	expect(table[5]).toBe(-1);
	expect(table[16]).toBe(-1);
	expect(table[40000]).toBe(-1);
});

test('a string spanning two pages reads and writes through the views', () => {
	const { heap } = make(4);
	const text = 'x'.repeat(40) + 'café' + 'y'.repeat(40);
	const bytes = new TextEncoder().encode(text + '\0');
	const at = HEAP + PAGE - 50;
	heap.write(at, bytes);
	expect(new TextDecoder().decode(heap.cstr(at))).toBe(text);
	expect(heap.cstr(at, 10).length).toBe(10);
	expect(heap.views.HEAPU8[at + 49]).toBe(bytes[49]);
	expect(heap.views.HEAPU8.slice(at, at + bytes.length)).toEqual(bytes);
});

test('a file read crossing a page lands byte for byte', () => {
	const { heap, pager } = make(4);
	const source = pattern(100_000, 7);
	const at = HEAP + 2 * PAGE - 10;
	heap.views.HEAP8.set(source, at);
	expect(heap.read(at, source.length)).toEqual(source);
	expect(pager.stats.zero + pager.stats.hard).toBeGreaterThanOrEqual(3);
});

test('a result larger than a page round trips through three pages', () => {
	const { heap } = make(4);
	const sql = pattern(3 * PAGE + 123, 3);
	heap.write(HEAP + 5, sql);
	expect(heap.read(HEAP + 5, sql.length)).toEqual(sql);
});

test('a write to an evicted page fills from the store, then survives another eviction', () => {
	const { heap, pager, store } = make(2);
	heap.write(HEAP, pattern(100, 1));
	heap.write(HEAP + PAGE, pattern(100, 2));
	heap.write(HEAP + 2 * PAGE, pattern(100, 3));
	heap.write(HEAP + 3 * PAGE, pattern(100, 4));
	expect(store.writes.length).toBeGreaterThan(0);
	heap.write(HEAP + 10, pattern(5, 9));
	heap.write(HEAP + 3 * PAGE, pattern(100, 5));
	heap.write(HEAP + 2 * PAGE, pattern(100, 6));
	const expected = pattern(100, 1);
	expected.set(pattern(5, 9), 10);
	expect(heap.read(HEAP, 100)).toEqual(expected);
	expect(heap.read(HEAP + PAGE, 100)).toEqual(pattern(100, 2));
	expect(pager.stats.hard).toBeGreaterThan(0);
	expect(store.reads.length).toBe(pager.stats.hard);
});

test('copyWithin across a page boundary matches a plain array in both directions', () => {
	const { heap } = make(3);
	const base = HEAP + PAGE - 300;
	const model = pattern(2000, 11);
	heap.write(base, model);
	heap.views.HEAPU8.copyWithin(base + 100, base, base + 1500);
	model.copyWithin(100, 0, 1500);
	expect(heap.read(base, 2000)).toEqual(model);
	heap.views.HEAPU8.copyWithin(base, base + 60, base + 1900);
	model.copyWithin(0, 60, 1900);
	expect(heap.read(base, 2000)).toEqual(model);
});

test('copyWithin moves page chunks frame to frame on a two frame pool, overlapping or not', () => {
	for (const shift of [-70_000, -5, 5, 70_000]) {
		const { heap } = make(2);
		const base = HEAP + 4 * PAGE;
		const model = pattern(5 * PAGE + 321, 13);
		heap.write(base, model);
		const from = base + 3000;
		const length = 4 * PAGE + 99;
		heap.views.HEAPU8.copyWithin(from + shift, from, from + length);
		const out = new Uint8Array(model.length + 4 * PAGE);
		out.set(model, 2 * PAGE);
		out.copyWithin(2 * PAGE + 3000 + shift, 2 * PAGE + 3000, 2 * PAGE + 3000 + length);
		expect(Buffer.compare(heap.read(base - 2 * PAGE, out.length), out)).toBe(0);
		expect(heap.stats.copies).toBe(1);
		expect(heap.stats.copyBytes).toBe(length);
	}
});

test('a copy on a pool of two frames dirties the target pages and not the source pages', () => {
	const { heap, store } = make(2);
	heap.write(HEAP, pattern(PAGE, 5));
	heap.read(HEAP + PAGE, 1);
	heap.read(HEAP + 3 * PAGE, 1);
	heap.read(HEAP + 5 * PAGE, 1);
	store.writes.length = 0;
	heap.views.HEAPU8.copyWithin(HEAP + 6 * PAGE, HEAP, HEAP + 1000);
	heap.read(HEAP + 8 * PAGE, 1);
	heap.read(HEAP + 10 * PAGE, 1);
	expect(store.writes).toEqual([22]);
	expect(heap.read(HEAP + 6 * PAGE, 1000)).toEqual(pattern(PAGE, 5).subarray(0, 1000));
});

test('fill and typed element access split at page edges', () => {
	const { heap } = make(3);
	heap.views.HEAPU8.fill(0xab, HEAP + PAGE - 3, HEAP + PAGE + 3);
	expect(Array.from(heap.read(HEAP + PAGE - 4, 8))).toEqual([
		0, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0
	]);
	heap.views.HEAP32[(HEAP + PAGE - 4) / 4] = -2;
	heap.views.HEAPF64[(HEAP + 2 * PAGE) / 8] = 1.5;
	expect(heap.views.HEAP32[(HEAP + PAGE - 4) / 4]).toBe(-2);
	expect(heap.views.HEAPU32[(HEAP + PAGE - 4) / 4]).toBe(0xfffffffe);
	expect(heap.views.HEAPF64[(HEAP + 2 * PAGE) / 8]).toBe(1.5);
	expect(heap.views.HEAPU8.length).toBe(64 * PAGE);
});

test('subarray is a live view inside one page and a copy across a boundary', () => {
	const { heap } = make(3);
	heap.write(HEAP, pattern(64, 1));
	const live = heap.views.HEAPU8.subarray(HEAP, HEAP + 64);
	live[0] = 200;
	expect(heap.views.HEAPU8[HEAP]).toBe(200);
	const copy = heap.views.HEAPU8.subarray(HEAP + PAGE - 2, HEAP + PAGE + 2);
	copy[0] = 99;
	expect(heap.views.HEAPU8[HEAP + PAGE - 2]).toBe(0);
});

test('a host access outside the heap or in the reserved range throws a typed error', () => {
	const { heap } = make(3);
	expect(() => heap.read(6 * PAGE, 4)).toThrow('page miss');
	expect(() => heap.read(64 * PAGE, 4)).toThrow('page miss');
	expect(heap.read(2 * PAGE, 4)).toEqual(new Uint8Array(4));
});

test('eviction clears the entry, CLOCK keeps a referenced frame and remaps a soft fault', () => {
	const { heap, pager, memory } = make(2);
	const table = () => new Int32Array(memory.buffer, layout.tableBase, 65536);
	heap.write(HEAP, pattern(8, 1));
	heap.write(HEAP + PAGE, pattern(8, 2));
	expect(table()[16]).not.toBe(-1);
	expect(table()[17]).not.toBe(-1);
	heap.write(HEAP + 2 * PAGE, pattern(8, 3));
	const mapped = [16, 17, 18].filter((p) => table()[p] !== -1);
	expect(mapped.length).toBeLessThanOrEqual(2);
	expect(pager.stats.evictions).toBe(1);
	const soft = pager.stats.soft;
	const resident = [16, 17, 18].filter((p) => pager.isResident(p));
	expect(resident.length).toBe(2);
	const unmapped = resident.find((p) => table()[p] === -1);
	if (unmapped !== undefined) {
		heap.read(unmapped * PAGE, 1);
		expect(pager.stats.soft).toBe(soft + 1);
		expect(table()[unmapped]).not.toBe(-1);
	}
});

test('a clean frame is not written back, a changed one is, one changed back is not', () => {
	const { heap, pager, store } = make(1);
	heap.write(HEAP, pattern(4, 1));
	heap.read(HEAP + PAGE, 1);
	expect(store.writes).toEqual([16]);
	heap.read(HEAP, 1);
	expect(pager.stats.writebacks).toBe(1);
	heap.read(HEAP + PAGE, 1);
	expect(pager.stats.cleanEvictions).toBeGreaterThanOrEqual(1);
	expect(store.writes).toEqual([16]);
	const before = heap.read(HEAP, 4);
	heap.write(HEAP, pattern(4, 9));
	heap.write(HEAP, before);
	heap.read(HEAP + PAGE, 1);
	expect(store.writes).toEqual([16]);
});

test('the lz4 pool store round trips a page through the codec', () => {
	const codec = {
		compress: (page: Uint8Array) => page.slice(0, 100),
		decompress: (packed: Uint8Array, dst: Uint8Array) => dst.set(packed)
	};
	const store = new Lz4PoolStore(codec);
	store.write(3, new Uint8Array(PAGE).fill(5));
	expect(store.storedBytes).toBe(100);
	const out = new Uint8Array(PAGE);
	store.read(3, out);
	expect(out[99]).toBe(5);
	expect(() => store.read(4, out)).toThrow('no stored page');
});

// the slow path of the translated module, with frames that are not contiguous
function module() {
	const wat = `(module (import "env" "memory" (memory 20)) (global $sp (mut i32) (i32.const 65536))
		(func (export "put") (param i32 i64) (i64.store (local.get 0) (local.get 1)))
		(func (export "get") (param i32) (result i64) (i64.load (local.get 0)))
		(func (export "put32") (param i32 i32) (i32.store (local.get 0) (local.get 1)))
		(func (export "get32") (param i32) (result i32) (i32.load (local.get 0)))
		(func (export "sum") (param i32 i32) (result i32) (local $s i32)
			(loop $l
				(local.set $s (i32.add (local.get $s) (i32.load (local.get 0))))
				(local.set 0 (i32.add (local.get 0) (i32.const 4)))
				(local.set 1 (i32.sub (local.get 1) (i32.const 1)))
				(br_if $l (local.get 1)))
			(local.get $s)))`;
	const mod = binaryen.parseText(wat);
	mod.setFeatures(binaryen.Features.MVP);
	const bytes = mod.emitBinary();
	mod.dispose();
	return translate(bytes, { tableBase: layout.tableBase, staticLimit: 0, stackFloor: 0 }).bytes;
}

function run(frames: number) {
	const store = new MapStore();
	const memory = new WebAssembly.Memory({
		initial: Math.max(20, physicalPagesFor(layout, frames))
	});
	const pager = new Pager({ memory, layout, frames, store, logicalBytes: 40 * PAGE });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(module())), {
		env: { memory },
		folio: { slow: pager.slow, stack_miss: pager.stackMiss }
	});
	return { ex: instance.exports as Record<string, (...a: any[]) => any>, pager, store };
}

test('a translated module on a two frame pool equals the same program on all frames', () => {
	const small = run(2);
	const big = run(30);
	for (const { ex } of [small, big]) {
		for (let page = 16; page < 30; page++) ex.put32!(page * PAGE + 8, page * 1000);
		ex.put32!(16 * PAGE + 4, 7);
	}
	const sums = [small, big].map(({ ex }) => {
		let total = 0;
		for (let page = 16; page < 30; page++) total = (total + ex.get32!(page * PAGE + 8)) | 0;
		return [total, ex.get32!(16 * PAGE + 4), ex.sum!(16 * PAGE, 100)];
	});
	expect(sums[0]).toEqual(sums[1]);
	expect(small.pager.stats.evictions).toBeGreaterThan(10);
	expect(big.pager.stats.evictions).toBe(0);
});

test('an access straddling two pages whose frames are apart moves them together', () => {
	const { ex, pager } = run(6);
	ex.put32!(20 * PAGE + 4, 5);
	ex.put32!(21 * PAGE + 4, 6);
	ex.put32!(22 * PAGE + 4, 7);
	ex.put!(20 * PAGE + PAGE - 4, 0x1122334455667788n);
	expect(ex.get!(20 * PAGE + PAGE - 4)).toBe(0x1122334455667788n);
	expect(ex.get32!(21 * PAGE)).toBe(0x11223344);
	expect(ex.get32!(21 * PAGE + 4)).toBe(6);
	ex.put!(21 * PAGE + PAGE - 4, -1n);
	expect(ex.get!(21 * PAGE + PAGE - 4)).toBe(-1n);
	expect(pager.stats.straddles).toBeGreaterThanOrEqual(2);
	expect(ex.get32!(20 * PAGE + 4)).toBe(5);
	expect(ex.get32!(22 * PAGE)).toBe(-1);
	expect(ex.get32!(22 * PAGE + 4)).toBe(7);
});

test('a straddle between frames in different runs relocates both pages and keeps every value', () => {
	const { ex, pager } = run(6);
	for (let page = 20; page < 26; page++) ex.put32!(page * PAGE + 16, page * 11);
	ex.put!(23 * PAGE + PAGE - 4, 0x0102030405060708n);
	expect(pager.stats.pairMoves).toBeGreaterThanOrEqual(2);
	expect(ex.get!(23 * PAGE + PAGE - 4)).toBe(0x0102030405060708n);
	for (let page = 20; page < 26; page++) expect(ex.get32!(page * PAGE + 16)).toBe(page * 11);
});

test('the glue patch swaps the views and both string helpers, and refuses a glue it does not know', () => {
	const toString =
		'var UTF8ToString=(ptr,maxBytesToRead)=>{ptr>>>=0;return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):""};';
	const fromString =
		'var stringToUTF8=(str,outPtr,maxBytesToWrite)=>stringToUTF8Array(str,HEAPU8,outPtr,maxBytesToWrite);';
	const source = `var cfwSafeSubarray=function(v){return v};${toString}${fromString}`;
	const patched = patchGlue(source);
	expect(patched).toContain('__folioHeapHook');
	expect(patched).toContain('h.cstr(ptr,maxBytesToRead)');
	expect(patched).toContain('h.write(outPtr');
	expect(patched).not.toContain(toString);
	expect(() => patchGlue(source.replace('cfwSafeSubarray', 'other'))).toThrow('glue anchor');
	expect(() => patchGlue(source + toString)).toThrow('glue anchor');
	const fn = new Function(
		'UTF8ArrayToString',
		'stringToUTF8Array',
		'HEAPU8',
		`${patched.replace('var cfwSafeSubarray=function(v){return v};', '')};return {UTF8ToString,stringToUTF8}`
	);
	const { heap } = make(3);
	installGlueHooks(heap);
	try {
		const decode = (b: Uint8Array, i: number, m: number) =>
			new TextDecoder().decode(b.subarray(i, Number.isFinite(m) ? i + m : undefined));
		const encode = (s: string, h: Uint8Array, at: number, max: number) => {
			const bytes = new TextEncoder().encode(s);
			const n = Math.min(bytes.length, max - 1);
			h.set(bytes.subarray(0, n), at);
			h[at + n] = 0;
			return n;
		};
		const t = fn(decode, encode, undefined);
		const at = HEAP + PAGE - 7;
		expect(t.stringToUTF8('café across a page', at, 64)).toBe(19);
		expect(t.UTF8ToString(at)).toBe('café across a page');
		expect(t.UTF8ToString(at, 5)).toBe('café');
		expect(t.UTF8ToString(0)).toBe('');
	} finally {
		installGlueHooks(undefined);
	}
});

test('a host write to an evicted page is visible to the next wasm load', () => {
	const { ex, pager } = run(2);
	const heap = new LogicalHeap(pager);
	ex.put32!(17 * PAGE, 11);
	for (let page = 18; page < 24; page++) ex.put32!(page * PAGE, page);
	heap.views.HEAP32[(17 * PAGE) / 4] = 4242;
	expect(ex.get32!(17 * PAGE)).toBe(4242);
	expect(heap.views.HEAP32[(17 * PAGE) / 4]).toBe(4242);
});

// #region dirty bit from the pass
// read table in pages 4 to 7, write table in pages 8 to 11, frames from page 12 with a gap at 14 to 19
const dlayout: Layout = {
	tableBase: 4 * PAGE,
	writeTableBase: 8 * PAGE,
	identity: [[0, 12]],
	heapStart: 16,
	frameRuns: [
		[12, 14],
		[20, Infinity]
	]
};

function dmodule(extra = '') {
	const wat = `(module (import "env" "memory" (memory 20)) (global $sp (mut i32) (i32.const 65536))
		(func (export "put") (param i32 i64) (i64.store (local.get 0) (local.get 1)))
		(func (export "get") (param i32) (result i64) (i64.load (local.get 0)))
		(func (export "put32") (param i32 i32) (i32.store (local.get 0) (local.get 1)))
		(func (export "get32") (param i32) (result i32) (i32.load (local.get 0)))
		(func (export "put8") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
		(func (export "get8") (param i32) (result i32) (i32.load8_u (local.get 0)))
		(func (export "rmw") (param i32) (i32.store (local.get 0) (i32.add (i32.load (local.get 0)) (i32.const 1))))
		${extra})`;
	const mod = binaryen.parseText(wat);
	mod.setFeatures(binaryen.Features.MVP | binaryen.Features.BulkMemory);
	const bytes = mod.emitBinary();
	mod.dispose();
	return bytes;
}

const dopts = { tableBase: dlayout.tableBase, writeTableBase: dlayout.writeTableBase, dirty: true };

function drun(frames: number, verify = false) {
	const store = new MapStore();
	const memory = new WebAssembly.Memory({
		initial: Math.max(20, physicalPagesFor(dlayout, frames))
	});
	const pager = new Pager({
		memory,
		layout: dlayout,
		frames,
		store,
		logicalBytes: 40 * PAGE,
		verify
	});
	const bytes = translate(dmodule(), dopts).bytes;
	const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {
		env: { memory },
		folio: pager.imports.folio
	});
	return { ex: instance.exports as Record<string, (...a: any[]) => any>, pager, store, memory };
}

const touch = (ex: Record<string, (...a: any[]) => any>, from: number, to: number) => {
	for (let page = from; page < to; page++) ex.get32!(page * PAGE);
};

test('a store to a clean page faults once and a load never faults dirty', () => {
	const { ex, pager } = drun(30);
	expect(ex.get32!(20 * PAGE)).toBe(0);
	expect(ex.get32!(20 * PAGE + 8)).toBe(0);
	expect(pager.stats.wslow).toBe(0);
	ex.put32!(20 * PAGE + 4, 5);
	expect(pager.stats.wslow).toBe(1);
	ex.put32!(20 * PAGE + 8, 6);
	ex.put8!(20 * PAGE + 100, 7);
	ex.rmw!(20 * PAGE + 4);
	expect(pager.stats.wslow).toBe(1);
	expect(ex.get32!(20 * PAGE + 4)).toBe(6);
	ex.put32!(21 * PAGE, 1);
	expect(pager.stats.wslow).toBe(2);
});

test('only stored pages are written back, loaded pages are evicted clean', () => {
	const { ex, pager, store } = drun(2);
	ex.put32!(20 * PAGE, 77);
	ex.get32!(21 * PAGE);
	touch(ex, 22, 30);
	expect(pager.stats.evictions).toBeGreaterThan(4);
	expect(store.writes).toEqual([20]);
	expect(pager.stats.writebacks).toBe(1);
	expect(ex.get32!(20 * PAGE)).toBe(77);
});

test('an evicted page reloads clean and is not written again until a store', () => {
	const { ex, pager, store } = drun(2);
	ex.put32!(20 * PAGE, 9);
	touch(ex, 21, 26);
	expect(store.writes).toEqual([20]);
	expect(ex.get32!(20 * PAGE)).toBe(9);
	touch(ex, 21, 26);
	expect(store.writes).toEqual([20]);
	ex.put32!(20 * PAGE + 4, 10);
	touch(ex, 21, 26);
	expect(store.writes).toEqual([20, 20]);
	expect(ex.get32!(20 * PAGE + 4)).toBe(10);
	expect(pager.stats.writebacks).toBe(2);
});

test('with verify a dirty page whose bytes came back equal is not written, and one that changed is', () => {
	for (const verify of [false, true]) {
		const { ex, pager, store } = drun(2, verify);
		ex.get32!(20 * PAGE);
		ex.put32!(20 * PAGE + 4, 5);
		ex.rmw!(20 * PAGE + 4);
		ex.put32!(20 * PAGE + 4, 5);
		ex.put32!(21 * PAGE + 4, 0);
		ex.put32!(22 * PAGE + 4, 3);
		touch(ex, 23, 30);
		expect(pager.stats.dirtyMarks).toBe(3);
		expect(store.writes.sort()).toEqual(verify ? [20, 22] : [20, 21, 22]);
		expect(ex.get32!(20 * PAGE + 4)).toBe(5);
		expect(ex.get32!(22 * PAGE + 4)).toBe(3);
	}
});

test('a store that crosses a page marks both pages dirty with one delta', () => {
	const { ex, pager, store } = drun(6);
	ex.get32!(20 * PAGE);
	ex.get32!(22 * PAGE);
	ex.put!(20 * PAGE + PAGE - 4, 0x1122334455667788n);
	expect(pager.stats.wslow).toBeGreaterThanOrEqual(1);
	expect(ex.get!(20 * PAGE + PAGE - 4)).toBe(0x1122334455667788n);
	touch(ex, 24, 40);
	expect(store.writes.sort()).toEqual([20, 21]);
	expect(ex.get!(20 * PAGE + PAGE - 4)).toBe(0x1122334455667788n);
	ex.put!(30 * PAGE + PAGE - 4, -5n);
	ex.put!(30 * PAGE + PAGE - 4, -6n);
	expect(ex.get!(30 * PAGE + PAGE - 4)).toBe(-6n);
});

test('the clock hand clears the write entry and a later store refaults without a fill', () => {
	const { ex, pager, memory } = drun(3);
	const read = () => new Int32Array(memory.buffer, dlayout.tableBase, 65536);
	const write = () => new Int32Array(memory.buffer, dlayout.writeTableBase!, 65536);
	ex.put32!(20 * PAGE, 1);
	expect(write()[20]).toBe(read()[20]);
	expect(write()[20]).not.toBe(-1);
	touch(ex, 21, 24);
	expect(pager.stats.unmaps).toBeGreaterThan(0);
	const cleared = [20, 21, 22, 23].filter((p) => pager.isResident(p) && read()[p] === -1);
	for (const p of cleared) expect(write()[p]).toBe(-1);
	const hard = pager.stats.hard;
	const faults = pager.stats.wslow;
	const resident = [20, 21, 22, 23].filter((p) => pager.isResident(p));
	for (const p of resident) ex.put32!(p * PAGE + 4, p);
	expect(pager.stats.hard).toBe(hard);
	expect(pager.stats.wslow).toBeGreaterThan(faults);
	for (const p of [20, 21, 22, 23])
		expect(ex.get32!(p * PAGE + 4)).toBe(resident.includes(p) ? p : 0);
});

test('host writes mark a page dirty, host reads and copies out do not', () => {
	const { ex, pager, store } = drun(2);
	const heap = new LogicalHeap(pager);
	heap.read(20 * PAGE, 16);
	heap.views.HEAPU8.slice(21 * PAGE, 21 * PAGE + 8);
	touch(ex, 22, 26);
	expect(store.writes).toEqual([]);
	heap.write(20 * PAGE, pattern(8, 4));
	heap.views.HEAP32[(21 * PAGE) / 4] = 5;
	heap.views.HEAPU8.fill(3, 22 * PAGE, 22 * PAGE + 4);
	touch(ex, 23, 28);
	expect(store.writes.sort()).toEqual([20, 21, 22]);
	expect(heap.read(20 * PAGE, 8)).toEqual(pattern(8, 4));
	heap.views.HEAPU8.copyWithin(24 * PAGE, 20 * PAGE, 20 * PAGE + 8);
	touch(ex, 25, 30);
	expect(store.writes).toContain(24);
});

test('a live subarray counts as a write because the caller may store through it', () => {
	const { ex, pager, store } = drun(2);
	const heap = new LogicalHeap(pager);
	const view = heap.views.HEAPU8.subarray(20 * PAGE, 20 * PAGE + 4);
	view[1] = 9;
	touch(ex, 21, 26);
	expect(store.writes).toEqual([20]);
	expect(heap.views.HEAPU8[20 * PAGE + 1]).toBe(9);
	expect(pager.stats.viewDirty).toBe(1);
});

test('a translated module on a two frame pool with the dirty bit equals all frames resident', () => {
	const small = drun(2);
	const big = drun(30);
	for (const { ex } of [small, big]) {
		for (let page = 16; page < 30; page++) ex.put32!(page * PAGE + 8, page * 1000);
		for (let page = 16; page < 30; page++) ex.rmw!(page * PAGE + 8);
		ex.put!(17 * PAGE + PAGE - 4, 0x0102030405060708n);
	}
	const read = ({ ex }: ReturnType<typeof drun>) => {
		const out: (number | bigint)[] = [];
		for (let page = 16; page < 30; page++) out.push(ex.get32!(page * PAGE + 8));
		out.push(ex.get!(17 * PAGE + PAGE - 4));
		return out;
	};
	expect(read(small)).toEqual(read(big));
	expect(small.pager.stats.writebacks).toBeGreaterThan(10);
	expect(big.pager.stats.evictions).toBe(0);
});

test('the pass refuses the dirty bit with a shared lookup and keeps refusing bulk memory ops', () => {
	const bytes = dmodule();
	for (const bad of [{ hoist: true }, { cache: 'function' }, { groups: true }, { shape: 'call' }])
		expect(() => translate(bytes, { ...dopts, ...bad } as any)).toThrow('dirty');
	expect(() => translate(bytes, { tableBase: dopts.tableBase, dirty: true })).toThrow(
		'writeTableBase'
	);
	const fill = dmodule(
		'(func (export "fill") (param i32 i32 i32) (memory.fill (local.get 0) (local.get 1) (local.get 2)))'
	);
	const copy = dmodule(
		'(func (export "copy") (param i32 i32 i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)))'
	);
	expect(() => translate(fill, dopts)).toThrow('memory.fill');
	expect(() => translate(copy, dopts)).toThrow('memory.copy');
});
// #endregion
