import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { inlineGlobals, lowerInline } from '../../src/inline.ts';
import { admissionSeam } from '../../src/iteration-admission.ts';
import {
	iterationArena,
	iterationFit,
	iterationSummaryShift,
	iterationSummaryWords
} from '../../src/iteration-layout.ts';
import { Folio } from '../../src/node.ts';
import { markReadSummary, scanReads } from '../../src/read-scan.ts';
import { markReadWindow } from '../../src/read-windows.ts';

const PAGE = 65536;
const BLOCK_BYTES = 2 ** iterationSummaryShift;

function wasm(text: string): Uint8Array {
	binaryen.setDebugInfo(true);
	const module = binaryen.parseText(text);
	try {
		const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
		module.setFeatures(binaryen.Features.All & ~compact);
		assert.ok(module.validate());
		return module.emitBinary();
	} finally {
		module.dispose();
		binaryen.setDebugInfo(false);
	}
}

const rng = (seed: number) => {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const bitOf = (map: Uint8Array, granule: number) => (map[granule >> 3]! >> (granule & 7)) & 1;

// the runs of a bitmap read one bit at a time, the reference the word loops are held to
function referenceRuns(words: Uint32Array): number[] {
	const runs: number[] = [];
	let start = -1;
	const bits = words.length * 32;
	for (let g = 0; g < bits; g++) {
		const set = (words[g >> 5]! >>> (g & 31)) & 1;
		if (set && start < 0) start = g;
		else if (!set && start >= 0) {
			runs.push(start, g - start);
			start = -1;
		}
	}
	if (start >= 0) runs.push(start, bits - start);
	return runs;
}

// the invariant: no non-zero word of the bitmap sits in a block whose summary byte is zero
function uncovered(words: Uint32Array, summary: Uint8Array): number[] {
	const found: number[] = [];
	for (let k = 0; k < words.length; k++) {
		const block = Math.floor(k / iterationSummaryWords);
		if (words[k] && !summary[block]) found.push(block);
	}
	return [...new Set(found)];
}

// #region the scan
function randomBitmap(next: () => number, wordCount: number) {
	const words = new Uint32Array(wordCount);
	const shapes = Math.floor(next() * 6);
	for (let n = 0; n < shapes; n++) {
		const kind = next();
		const at = Math.floor(next() * wordCount);
		if (kind < 0.3) words[at] = (next() * 0x100000000) >>> 0;
		else if (kind < 0.6) {
			// a run that crosses block boundaries, whole words in the middle
			const length = 1 + Math.floor(next() * 3 * iterationSummaryWords);
			for (let k = at; k < Math.min(wordCount, at + length); k++) words[k] = 0xffffffff;
			if (at > 0) words[at - 1] = (words[at - 1]! | 0x80000000) >>> 0;
		} else if (kind < 0.8) {
			const last = wordCount - 1 - Math.floor(next() * 3);
			words[last] = (words[last]! | (1 << Math.floor(next() * 32))) >>> 0;
		} else words[at] = 1 << Math.floor(next() * 32);
	}
	return words;
}

function summaryOf(words: Uint32Array, size: number, next: () => number, extra: number) {
	const summary = new Uint8Array(size);
	for (let k = 0; k < words.length; k++)
		if (words[k]) summary[Math.floor(k / iterationSummaryWords)] = 1;
	// a summary may flag more blocks than it needs
	for (let n = 0; n < extra; n++) summary[Math.floor(next() * size)] = 1;
	return summary;
}

test('the summary scan returns the runs of the full scan and the bit by bit reference, and clears both', () => {
	for (let seed = 1; seed <= 400; seed++) {
		const next = rng(seed * 104729);
		// word counts that are not a multiple of the block, so the last block is short
		const wordCount = [16, 64, 80, 192, 200, 1088, 13184][seed % 7]!;
		const words = randomBitmap(next, wordCount);
		const full = Uint32Array.from(words);
		const sparse = Uint32Array.from(words);
		const size = Math.max(64, 64 * Math.ceil(wordCount / iterationSummaryWords / 64));
		const summary = summaryOf(sparse, size, next, seed % 3);
		assert.deepEqual(uncovered(sparse, summary), []);
		const expected = referenceRuns(words);
		assert.deepEqual(Array.from(scanReads(full)), expected, `full scan, seed ${seed}`);
		assert.deepEqual(Array.from(scanReads(sparse, summary)), expected, `summary, seed ${seed}`);
		assert.ok(full.every((w) => w === 0));
		assert.ok(sparse.every((w) => w === 0));
		assert.ok(summary.every((b) => b === 0));
	}
});

test('the scan reports the words it visited and the words it found set', () => {
	const words = new Uint32Array(10 * iterationSummaryWords + 5);
	words[3] = 1;
	words[4] = 0xffffffff;
	words[5 * iterationSummaryWords + 2] = 7;
	const summary = new Uint8Array(64);
	summary[0] = 1;
	summary[5] = 1;
	summary[7] = 1;
	const stats = { words: 0, set: 0 };
	scanReads(Uint32Array.from(words), summary, stats);
	assert.deepEqual(stats, { words: 3 * iterationSummaryWords, set: 3 });
	const whole = { words: 0, set: 0 };
	scanReads(Uint32Array.from(words), undefined, whole);
	assert.deepEqual(whole, { words: words.length, set: 3 });
	// a flagged block past the bitmap is cleared and visits nothing
	const past = new Uint8Array(64);
	past[40] = 1;
	const none = { words: 0, set: 0 };
	assert.equal(scanReads(Uint32Array.from(words), past, none).length, 0);
	assert.deepEqual(none, { words: 0, set: 0 });
	assert.ok(past.every((b) => b === 0));
});

test('a run that ends at the last word of a block and one that ends at the bitmap end are closed exactly', () => {
	const words = new Uint32Array(3 * iterationSummaryWords);
	for (let k = iterationSummaryWords - 2; k < iterationSummaryWords; k++) words[k] = 0xffffffff;
	for (let k = 2 * iterationSummaryWords + 60; k < words.length; k++) words[k] = 0xffffffff;
	const summary = new Uint8Array(64);
	summary[0] = 1;
	summary[2] = 1;
	assert.deepEqual(Array.from(scanReads(Uint32Array.from(words), summary)), referenceRuns(words));
	// two adjacent flagged blocks with a run across the seam are one run
	const seam = new Uint32Array(3 * iterationSummaryWords);
	seam[iterationSummaryWords - 1] = 0x80000000;
	seam[iterationSummaryWords] = 1;
	const flags = new Uint8Array(64);
	flags[0] = 1;
	flags[1] = 1;
	assert.deepEqual(Array.from(scanReads(Uint32Array.from(seam), flags)), [
		iterationSummaryWords * 32 - 1,
		2
	]);
});

test('mutating the invariant is visible: a block whose byte is zero is skipped, its bits stay set', () => {
	const words = new Uint32Array(4 * iterationSummaryWords);
	words[iterationSummaryWords + 9] = 0xf0;
	words[3 * iterationSummaryWords] = 1;
	const summary = new Uint8Array(64);
	summary[1] = 1;
	summary[3] = 1;
	assert.deepEqual(uncovered(words, summary), []);
	// the mutation: drop one byte
	summary[3] = 0;
	assert.deepEqual(uncovered(words, summary), [3], 'the checker names the block');
	const bits = Uint32Array.from(words);
	const runs = Array.from(scanReads(bits, summary));
	assert.notDeepEqual(runs, referenceRuns(words), 'the scan loses the block');
	assert.equal(bits[3 * iterationSummaryWords], 1, 'and leaves its word set');
});

test('markReadSummary flags every block a range touches, a range that straddles a seam flags both', () => {
	const flagged = (low: number, bytes: number, mask = 63) => {
		const map = new Uint8Array(64);
		markReadSummary(map, 0, mask, low, bytes);
		return Array.from(map.keys()).filter((i) => map[i]);
	};
	assert.deepEqual(flagged(0, 64), [0]);
	assert.deepEqual(flagged(BLOCK_BYTES - 64, 64), [0]);
	assert.deepEqual(flagged(BLOCK_BYTES - 64, 65), [0, 1]);
	assert.deepEqual(flagged(BLOCK_BYTES - 1, 2), [0, 1]);
	assert.deepEqual(flagged(BLOCK_BYTES, BLOCK_BYTES), [1]);
	assert.deepEqual(flagged(BLOCK_BYTES, BLOCK_BYTES + 1), [1, 2]);
	assert.deepEqual(flagged(5 * BLOCK_BYTES + 100, 0), []);
	assert.deepEqual(flagged(70 * BLOCK_BYTES, 1), [6], 'an index wraps to the summary size');
	// every granule of a marked window lies in a flagged block
	const next = rng(11);
	for (let n = 0; n < 300; n++) {
		const low = Math.floor(next() * 40 * BLOCK_BYTES);
		const bytes = 1 + Math.floor(next() * 3 * BLOCK_BYTES);
		const map = new Uint8Array(64);
		markReadSummary(map, 0, 63, low, bytes);
		for (const at of [low, low + bytes - 1, low + Math.floor(bytes / 2)])
			assert.equal(map[Math.floor(at / BLOCK_BYTES) & 63], 1);
	}
});

test('the arena reserves the summary only when asked and sizes it to a power of two of at least 64', () => {
	const off = iterationArena(1 << 20, 32 * PAGE);
	assert.equal(off.ssize, 0);
	assert.equal(off.smaps, 0);
	const on = iterationArena(1 << 20, 32 * PAGE, { readSummary: true });
	assert.equal(on.smaps, on.frameShadow + on.batch * on.frameSlotBytes);
	assert.equal(on.ssize, 64);
	assert.equal(on.bytes, off.bytes + on.batch * 64);
	assert.equal(off.bytes, iterationArena(1 << 20, 32 * PAGE, { readSummary: false }).bytes);
	// a 27 MB memory has 206 blocks of 128 KiB
	assert.equal(iterationArena(0, 412 * PAGE, { readSummary: true }).ssize, 256);
	assert.equal(iterationArena(0, 65536 * PAGE, { readSummary: true }).ssize, 32768);
	// an index of any in-memory address lands inside the summary
	for (const pages of [1, 2, 33, 412, 65536]) {
		const a = iterationArena(0, pages * PAGE, { readSummary: true });
		assert.ok(Math.floor((pages * PAGE - 1) / BLOCK_BYTES) < a.ssize);
		assert.ok(Math.ceil(a.rsize / 4 / iterationSummaryWords) <= a.ssize);
	}
	const fit = iterationFit(1 << 20, { readSummary: true })!;
	assert.ok(fit.base + fit.bytes <= fit.memoryBytes);
});
// #endregion

// #region the lowering
const probe = wasm(`(module
	(import "env" "memory" (memory 8 8 shared))
	(global $sp (mut i32) (i32.const 65536))
	(func (export "ld1") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func (export "ld2") (param i32) (result i32) (i32.load16_u (local.get 0)))
	(func (export "ld4") (param i32) (result i32) (i32.load (local.get 0)))
	(func (export "ld8") (param i32) (result i64) (i64.load (local.get 0)))
	(func (export "ldv") (param i32) (result i32)
		(i32x4.extract_lane 0 (v128.load (local.get 0))))
	(func (export "ald") (param i32) (result i32) (i32.atomic.load (local.get 0)))
	(func (export "rmw") (param i32 i32) (result i32)
		(i32.atomic.rmw.add (local.get 0) (local.get 1)))
	(func (export "st4") (param i32 i32) (i32.store (local.get 0) (local.get 1)))
	(func (export "cpy") (param i32 i32 i32)
		(memory.copy (local.get 0) (local.get 1) (local.get 2)))
)`);

// the marks, the log and the summary sit above the bytes the programs touch, in a memory of 8 pages
const at = {
	rb: 0x60000,
	sb: 0x68000,
	wb: 0x69000,
	lp: 0x6a000,
	ll: 0x6c000,
	sa: 0x6d000,
	arena: [0x70000, 0x78000],
	slot: [0x74000, 0x78000],
	exempt: [0x74000, 0x75000]
} as const;
const SUMMARY = 64;

function open(options: { readSummary?: number; readWindows?: number }, seed = 1) {
	const lowered = lowerInline(probe, { slot: true, stack: 'sp', ...options });
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
	const u8 = new Uint8Array(memory.buffer);
	const next = rng(seed);
	for (let i = 0; i < 0x40000; i++) u8[i] = (next() * 256) | 0;
	const module = new WebAssembly.Module(Uint8Array.from(lowered));
	const { exports } = new WebAssembly.Instance(module, { env: { memory } }) as unknown as {
		exports: Record<string, any>;
	};
	const set = (name: string, value: number) => (exports[name].value = value);
	set(inlineGlobals.readBitmap, at.rb);
	set(inlineGlobals.writeBitmap, at.wb);
	set(inlineGlobals.logPointer, at.lp);
	set(inlineGlobals.logLimit, at.ll);
	set(inlineGlobals.stampAddress, at.sa);
	set(inlineGlobals.arenaLow, at.arena[0]);
	set(inlineGlobals.arenaEnd, at.arena[1]);
	set(inlineGlobals.slotLow, at.slot[0]);
	set(inlineGlobals.slotEnd, at.slot[1]);
	set(inlineGlobals.exemptLow, at.exempt[0]);
	set(inlineGlobals.exemptEnd, at.exempt[1]);
	if (options.readSummary) set(inlineGlobals.readSummary, at.sb);
	return {
		exports,
		u8,
		set,
		names: WebAssembly.Module.exports(module).map((e) => e.name),
		reads: () => new Uint32Array(memory.buffer.slice(at.rb, at.rb + 0x2000)),
		summary: () => u8.slice(at.sb, at.sb + SUMMARY),
		writes: () => u8.slice(at.wb, at.wb + 1024),
		log: () => u8.slice(at.lp, Number(exports[inlineGlobals.logPointer].value))
	};
}

test('the lowering exports the summary global only when asked, and a summary of 0 changes no byte', () => {
	assert.ok(!open({}).names.includes(inlineGlobals.readSummary));
	assert.ok(open({ readSummary: 64 }).names.includes(inlineGlobals.readSummary));
	assert.deepEqual(
		lowerInline(probe, { slot: true, stack: 'sp', readSummary: 0 }),
		lowerInline(probe, { slot: true, stack: 'sp' })
	);
	for (const bad of [-1, 3, 48, 65536, 1.5])
		assert.throws(() => lowerInline(probe, { stack: 'sp', readSummary: bad }), RangeError);
	for (const good of [1, 2, 64, 32768])
		assert.doesNotThrow(() => lowerInline(probe, { stack: 'sp', readSummary: good }));
});

test('a read sets its summary byte, a load that crosses a granule seam in a block flags both blocks', () => {
	const vm = open({ readSummary: SUMMARY });
	vm.exports.ld4(0x100);
	assert.deepEqual(
		Array.from(vm.summary().keys()).filter((i) => vm.summary()[i]),
		[0]
	);
	// the load covers the last two bytes of block 0 and the first two of block 1
	vm.exports.ld4(BLOCK_BYTES - 2);
	assert.deepEqual(
		Array.from(vm.summary().keys()).filter((i) => vm.summary()[i]),
		[0, 1]
	);
	// an access of the exempt window sets nothing
	const quiet = open({ readSummary: SUMMARY });
	quiet.exports.ld4(at.exempt[0] + 8);
	assert.ok(quiet.summary().every((b) => b === 0));
	// a store sets no read byte
	const store = open({ readSummary: SUMMARY });
	store.exports.st4(0x40, 1);
	assert.ok(store.summary().every((b) => b === 0));
	// a bulk copy marks the source range block by block
	const copy = open({ readSummary: SUMMARY });
	copy.exports.cpy(0x200, BLOCK_BYTES - 128, 256);
	assert.deepEqual(
		Array.from(copy.summary().keys()).filter((i) => copy.summary()[i]),
		[0, 1]
	);
	assert.deepEqual(uncovered(copy.reads(), copy.summary()), []);
});

test('a load that traps past the memory still leaves its bit covered by a summary byte', () => {
	const vm = open({ readSummary: SUMMARY });
	// the mark is set before the access, so the bit lands in the bitmap region and the trap follows
	assert.throws(() => vm.exports.ld4(0x90000), WebAssembly.RuntimeError);
	assert.equal(
		Array.from(vm.reads()).some((w) => w !== 0),
		true
	);
	assert.deepEqual(uncovered(vm.reads(), vm.summary()), []);
	assert.equal(vm.summary()[(0x90000 >>> iterationSummaryShift) & (SUMMARY - 1)], 1);
});

test('a one byte summary maps every address to byte 0: a superset, never a miss', () => {
	const vm = open({ readSummary: 1 });
	vm.exports.ld4(3 * BLOCK_BYTES + 8);
	assert.equal(vm.u8[at.sb], 1);
	assert.equal(vm.u8[at.sb + 1], 0);
});

test('summaries cover every non-zero word of the read bitmap and leave the bits and the writes as without', () => {
	const addresses = (next: () => number) => {
		const pick = next();
		if (pick < 0.15) return at.exempt[0] + Math.floor(next() * 0xfe0);
		if (pick < 0.35) {
			// near a block seam, where a load or a range crosses into the next block
			return (1 + Math.floor(next() * 2)) * BLOCK_BYTES - 40 + Math.floor(next() * 80);
		}
		return Math.floor(next() * 0x5fff0);
	};
	for (let seed = 1; seed <= 120; seed++) {
		const next = rng(seed * 7919);
		const plain = open({}, seed);
		const summed = open({ readSummary: SUMMARY }, seed);
		const names = ['ld1', 'ld2', 'ld4', 'ld8', 'ldv', 'ald', 'rmw', 'st4', 'cpy'];
		for (let step = 0; step < 60; step++) {
			const name = names[Math.floor(next() * names.length)]!;
			const a = addresses(next) & (name === 'ald' || name === 'rmw' ? ~3 : ~0);
			const b = Math.floor(next() * 0x50000);
			const n = Math.floor(next() * 120);
			const v = Math.floor(next() * 0xffffffff) | 0;
			const run = (vm: ReturnType<typeof open>) =>
				name === 'cpy'
					? vm.exports.cpy(b, a, n)
					: name === 'st4' || name === 'rmw'
						? vm.exports[name](a, v)
						: vm.exports[name](a);
			assert.equal(run(summed), run(plain), `seed ${seed} step ${step} ${name} ${a}`);
			assert.deepEqual(
				uncovered(summed.reads(), summed.summary()),
				[],
				`seed ${seed} step ${step} ${name} ${a} ${b} ${n}`
			);
		}
		assert.deepEqual(summed.reads(), plain.reads(), `read bits, seed ${seed}`);
		assert.deepEqual(summed.writes(), plain.writes(), `writes, seed ${seed}`);
		assert.deepEqual(summed.log(), plain.log(), `undo log, seed ${seed}`);
		// and the scan of the summed run equals the scan of the plain one
		const words = summed.reads();
		const expected = Array.from(scanReads(plain.reads()));
		const size = Uint8Array.from(summed.summary());
		assert.deepEqual(Array.from(scanReads(words, size)), expected, `scan, seed ${seed}`);
	}
});

test('a premarked read window is covered once markReadSummary has run, including a window across a seam', () => {
	const vm = open({ readSummary: SUMMARY, readWindows: 1 });
	const low = BLOCK_BYTES - 0x800;
	const bytes = 0x1000;
	vm.set(inlineGlobals.readWindow0Low, low);
	vm.set(inlineGlobals.readWindow0Span, bytes - 7);
	markReadWindow(vm.u8, at.rb, low, bytes);
	assert.deepEqual(uncovered(vm.reads(), vm.summary()), [0, 1], 'bits without bytes are caught');
	markReadSummary(vm.u8, at.sb, SUMMARY - 1, low, bytes);
	assert.deepEqual(uncovered(vm.reads(), vm.summary()), []);
	// loads in the window set nothing more; the scan finds one run of 64 granules across the seam
	vm.exports.ld4(low + 0x400);
	vm.exports.ld8(BLOCK_BYTES + 0x7f0);
	const runs = Array.from(scanReads(vm.reads(), Uint8Array.from(vm.summary())));
	assert.deepEqual(runs, [Math.floor(low / 64), bytes / 64]);
});
// #endregion

// #region the pool
beforeEach(() => {
	admissionSeam.scale = 1;
	admissionSeam.batchScale = 1;
	admissionSeam.force = true;
});
afterEach(() => {
	admissionSeam.scale = 1;
	admissionSeam.batchScale = 1;
	admissionSeam.force = false;
});

const layout = { table: 0x10000, dst: 0x30000, fixed: 0x50000, records: 0x60000, spare: 0x58000 };

// an owner whose loop sums `words` words of each record, then a word of a fixed table, then the
// word a pointer in the record names
const reader = (words: number) => `(module
	(import "env" "memory" (memory 48 512))
	(global $sp (mut i32) (i32.const 65536))
	(func $item (param $t i32) (param $f i32)
		(local $src i32) (local $dst i32) (local $i i32) (local $acc i32)
		(local.set $src (i32.load (local.get $t)))
		(local.set $dst (i32.load offset=4 (local.get $t)))
		(loop $each
			(local.set $acc (i32.add (local.get $acc)
				(i32.add
					(i32.load (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 2))))
					(i32.load (i32.add (i32.const ${layout.fixed})
						(i32.shl (i32.and (local.get $i) (i32.const 31)) (i32.const 2)))))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $each (i32.lt_u (local.get $i) (i32.const ${words}))))
		(local.set $acc (i32.add (local.get $acc)
			(i32.load (i32.load (i32.add (local.get $src) (i32.const ${words * 4}))))))
		(i32.store (local.get $dst) (local.get $acc)))
	(func $run (export "run") (param $t i32) (param $n i32) (local $frame i32) (local $c i32)
		(local.set $frame (i32.sub (global.get $sp) (i32.const 64)))
		(global.set $sp (local.get $frame))
		(i32.store (local.get $frame) (i32.const 0))
		(block $done
			(br_if $done (i32.eqz (local.get $n)))
			(local.set $c (local.get $n))
			(loop $each
				(call $item (local.get $t) (local.get $frame))
				(local.set $t (i32.add (local.get $t) (i32.const 8)))
				(br_if $each (local.tee $c (i32.sub (local.get $c) (i32.const 1))))))
		(global.set $sp (i32.add (local.get $frame) (i32.const 64))))
)`;

interface Shape {
	words: number;
	stride: number;
	n: number;
	dst?: (k: number) => number;
	pointer?: (k: number) => number;
}

function image(shape: Shape) {
	const bytes = new Uint8Array(0x300000);
	const view = new DataView(bytes.buffer);
	const next = rng(99);
	for (let i = 0; i < 0x100000; i++) bytes[layout.records + i] = (next() * 256) | 0;
	for (let i = 0; i < 128; i++) bytes[layout.fixed + i] = (next() * 256) | 0;
	for (let k = 0; k < shape.n; k++) {
		const src = layout.records + k * shape.stride;
		view.setUint32(layout.table + 8 * k, src, true);
		view.setUint32(layout.table + 8 * k + 4, shape.dst?.(k) ?? layout.dst + 64 * k, true);
		view.setUint32(src + shape.words * 4, shape.pointer?.(k) ?? layout.spare, true);
	}
	view.setUint32(layout.spare, 5, true);
	return bytes;
}

async function race(shape: Shape, readWindows: boolean, readSummary: boolean) {
	const source = wasm(reader(shape.words));
	const bytes = image(shape);
	const memory = new WebAssembly.Memory({ initial: 48, maximum: 512 });
	new Uint8Array(memory.buffer).set(bytes);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory }
	});
	(instance.exports.run as CallableFunction)(layout.table, shape.n);
	const folio = await Folio.open(source, {
		workers: 4,
		iterationReadWindows: readWindows,
		iterationReadSummary: readSummary
	});
	new Uint8Array(folio.memory.buffer).set(bytes);
	const report = await folio.run('run', [layout.table, shape.n]);
	const same = Buffer.compare(
		new Uint8Array(memory.buffer, PAGE, 47 * PAGE),
		new Uint8Array(folio.memory.buffer, PAGE, 47 * PAGE)
	);
	await folio.close();
	return { report, equal: same === 0 };
}

test('the summary scan reads a few blocks where the full scan reads the whole bitmap, and finds the same words', async () => {
	const shape = { words: 96, stride: 512, n: 60 };
	const full = await race(shape, true, false);
	const sparse = await race(shape, true, true);
	assert.ok(full.equal && sparse.equal);
	const a = full.report.iteration!;
	const b = sparse.report.iteration!;
	assert.equal(b.regions, a.regions);
	assert.equal(b.replayed, 0);
	assert.deepEqual(b.conflicts, a.conflicts);
	assert.equal(b.workerScanSet, a.workerScanSet, 'the same words are set');
	assert.ok(
		a.workerScanWords > 10 * b.workerScanWords,
		`${a.workerScanWords} ${b.workerScanWords}`
	);
	assert.ok(b.workerScanWords > 0);
});

test('the summary is off by default and the run is the same without read windows', async () => {
	const shape = { words: 96, stride: 512, n: 40 };
	const off = await race(shape, false, false);
	const on = await race(shape, false, true);
	assert.ok(off.equal && on.equal);
	assert.equal(on.report.iteration!.regions, off.report.iteration!.regions);
	assert.equal(on.report.iteration!.workerScanSet, off.report.iteration!.workerScanSet);
	assert.ok(on.report.iteration!.workerScanWords < off.report.iteration!.workerScanWords);
});

test('a read window across a block seam and a dependence in its far block are both caught', async () => {
	// 768-byte records from 0x60000: record 170 starts 512 bytes below the 0x80000 seam and its
	// window crosses it. Iteration 169 writes a word inside record 170, past the seam.
	const stride = 768;
	const shape: Shape = {
		words: 200,
		stride,
		n: 220,
		dst: (k) => (k === 169 ? layout.records + 170 * stride + 700 : layout.dst + 64 * k)
	};
	for (const windows of [false, true]) {
		const run = await race(shape, windows, true);
		assert.ok(run.equal, `windows ${windows}`);
		const counts = run.report.iteration!;
		assert.ok(counts.conflicts.raw > 0, `windows ${windows}: the dependence is seen`);
		assert.ok(counts.replayed > 0);
	}
});

test('a mark set at the end of an iteration is found: the pointer word is read last', async () => {
	// from iteration 20 the pointer in the record names the cell the previous iteration wrote
	for (const windows of [false, true]) {
		const run = await race(
			{
				words: 96,
				stride: 1024,
				n: 60,
				pointer: (k) => (k >= 20 ? layout.dst + 64 * (k - 1) : layout.spare)
			},
			windows,
			true
		);
		assert.ok(run.equal, `windows ${windows}`);
		const counts = run.report.iteration!;
		assert.ok(counts.conflicts.raw > 0);
		assert.ok(counts.replayed > 0);
	}
});

test('a loop that shares a scratch cell runs on the window variant with the summary on', async () => {
	// every iteration stores to one cell: the first batch conflicts, a window is found, and the
	// workers switch to the window variant of the module, which has to carry the summary too
	const shape = { words: 96, stride: 512, n: 60, dst: () => layout.dst };
	for (const windows of [false, true]) {
		const run = await race(shape, windows, true);
		assert.ok(run.equal, `windows ${windows}`);
		const counts = run.report.iteration!;
		assert.ok(counts.window, `windows ${windows}: a write window was found`);
		assert.ok(counts.window!.batches > 0);
	}
});

test('a call that traps leaves no stale read marks: the next call on the pool scans the same words', async () => {
	const source = wasm(reader(96));
	const sets: number[] = [];
	for (const readSummary of [false, true]) {
		const folio = await Folio.open(source, {
			workers: 4,
			iterationReadWindows: true,
			iterationReadSummary: readSummary
		});
		const bad = image({
			words: 96,
			stride: 512,
			n: 60,
			pointer: (k) => (k === 40 ? 0x7ffffff0 : layout.spare)
		});
		new Uint8Array(folio.memory.buffer).set(bad);
		await assert.rejects(folio.run('run', [layout.table, 60]), WebAssembly.RuntimeError);
		new Uint8Array(folio.memory.buffer).set(image({ words: 96, stride: 512, n: 60 }));
		const report = await folio.run('run', [layout.table, 60]);
		const counts = report.iteration!;
		assert.equal(counts.replayed, 0);
		assert.deepEqual(counts.conflicts, { raw: 0, war: 0, waw: 0, frame: 0 });
		sets.push(counts.workerScanSet / counts.regions);
		await folio.close();
	}
	assert.equal(sets[0], sets[1]);
});

test('the first batch on learned read windows is one iteration per worker when the bound is low, and a loop that loses ends there', async () => {
	const shape = { words: 96, stride: 512, n: 60 };
	admissionSeam.force = false;
	admissionSeam.scale = 1e4;
	admissionSeam.batchScale = 1e9;
	const lost = await race(shape, true, false);
	assert.ok(lost.equal);
	const a = lost.report.iteration!;
	assert.ok(a.readWindows, 'the windows were learned');
	assert.equal(a.batches, 2);
	assert.equal(a.regions, 8 + 4);
	assert.equal(a.stopped, 'no-admission');
	assert.equal(a.readWindows!.batches, 1);
	// where the bound of the first batch is high there is nothing to prove: full batches follow
	admissionSeam.batchScale = 1e-9;
	const won = await race(shape, true, false);
	assert.ok(won.equal);
	const b = won.report.iteration!;
	assert.equal(b.stopped, undefined);
	assert.equal(b.batches, 3);
	assert.equal(b.regions, 59);
	// without read windows the first batch is a full one and a loop that loses ends there
	admissionSeam.batchScale = 1e9;
	const plain = await race(shape, false, false);
	assert.ok(plain.equal);
	assert.equal(plain.report.iteration!.batches, 1);
	assert.equal(plain.report.iteration!.regions, 32);
});
// #endregion
