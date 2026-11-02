import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { inlineGlobals, lowerInline } from '../../src/inline.ts';
import { admissionSeam } from '../../src/iteration-admission.ts';
import { Folio } from '../../src/node.ts';
import {
	type ReadWindowSample,
	learnReadWindows,
	markReadWindow,
	readWindowsAt,
	readWindowsClear,
	readWindowsPay
} from '../../src/read-windows.ts';

const PAGE = 65536;

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

// #region the lowering
const probe = wasm(`(module
	(import "env" "memory" (memory 4 4 shared))
	(global $sp (mut i32) (i32.const 65536))
	(func (export "ld1") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func (export "ld2") (param i32) (result i32) (i32.load16_u (local.get 0)))
	(func (export "ld4") (param i32) (result i32) (i32.load (local.get 0)))
	(func (export "ld8") (param i32) (result i64) (i64.load (local.get 0)))
	(func (export "ldv") (param i32) (result i32)
		(i32x4.extract_lane 0 (v128.load (local.get 0))))
	(func (export "ald") (param i32) (result i32) (i32.atomic.load (local.get 0)))
	(func (export "st1") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
	(func (export "st4") (param i32 i32) (i32.store (local.get 0) (local.get 1)))
)`);

// where the test puts the marks and the undo log, above the bytes the programs touch
const at = {
	rb: 0x30000,
	wb: 0x31000,
	lp: 0x32000,
	ll: 0x33000,
	sa: 0x34000,
	arena: [0x38000, 0x3c000],
	slot: [0x3a000, 0x3c000],
	exempt: [0x3a000, 0x3b000]
} as const;

function open(
	options: { readWindows?: number; readCount?: boolean; exemptFirst?: boolean },
	seed = 1
) {
	const lowered = lowerInline(probe, { slot: true, stack: 'sp', ...options });
	const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
	const u8 = new Uint8Array(memory.buffer);
	const next = rng(seed);
	for (let i = 0; i < 0x20000; i++) u8[i] = (next() * 256) | 0;
	const { exports } = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(lowered)), {
		env: { memory }
	}) as unknown as { exports: Record<string, any> };
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
	const window = (index: number, low: number, bytes: number) => {
		const [lowName, spanName] =
			index === 0
				? [inlineGlobals.readWindow0Low, inlineGlobals.readWindow0Span]
				: [inlineGlobals.readWindow1Low, inlineGlobals.readWindow1Span];
		set(lowName, low);
		set(spanName, bytes ? bytes - 7 : 0);
		if (bytes) markReadWindow(u8, at.rb, low, bytes);
	};
	const bits = (base: number, size: number) => u8.slice(base, base + size);
	return {
		exports,
		u8,
		window,
		reads: () => bits(at.rb, 512),
		writes: () => bits(at.wb, 1024),
		log: () => u8.slice(at.lp, Number(exports[inlineGlobals.logPointer].value)),
		entries: () => (Number(exports[inlineGlobals.logPointer].value) - at.lp) / 40,
		names: WebAssembly.Module.exports(new WebAssembly.Module(Uint8Array.from(lowered))).map(
			(e) => e.name
		)
	};
}
const bitOf = (map: Uint8Array, granule: number) => (map[granule >> 3]! >> (granule & 7)) & 1;
const count = (map: Uint8Array) =>
	map.reduce((n, b) => n + b.toString(2).replace(/0/g, '').length, 0);

test('the lowering exports the read window globals only when asked, and default bytes do not change', () => {
	const plain = open({});
	assert.ok(!plain.names.includes(inlineGlobals.readWindow0Low));
	const one = open({ readWindows: 1 });
	assert.ok(one.names.includes(inlineGlobals.readWindow0Low));
	assert.ok(one.names.includes(inlineGlobals.readWindow0Span));
	assert.ok(!one.names.includes(inlineGlobals.readWindow1Low));
	assert.ok(open({ readWindows: 2 }).names.includes(inlineGlobals.readWindow1Span));
	assert.deepEqual(
		lowerInline(probe, { slot: true, stack: 'sp', readWindows: 0 }),
		lowerInline(probe, { slot: true, stack: 'sp' })
	);
	for (const bad of [-1, 3, 1.5])
		assert.throws(() => lowerInline(probe, { stack: 'sp', readWindows: bad }), RangeError);
});

test('a load inside a window sets no mark; every other access is tracked as before', () => {
	const vm = open({ readWindows: 2 });
	vm.window(0, 0x4000, 0x800);
	vm.window(1, 0x6040, 0x80);
	const base = count(vm.reads());
	// the bits set by the window itself: 0x800 / 64 granules and two for the second window
	assert.equal(base, 32 + 2);
	const r = vm.exports;
	for (const addr of [0x4000, 0x4100, 0x47f8]) r.ld4(addr);
	r.ld1(0x4200);
	r.ld2(0x4202);
	r.ld8(0x4208);
	r.ld4(0x6040);
	r.ld8(0x6080 - 8);
	assert.equal(count(vm.reads()), base, 'hits add no bits');
	assert.equal(vm.entries(), 0);
	// the last seven bytes of a window and an edge crossing are tracked
	r.ld4(0x47fc);
	assert.equal(bitOf(vm.reads(), 0x47fc >> 6), 1);
	r.ld4(0x3ffe);
	assert.equal(bitOf(vm.reads(), 0x3fc0 >> 6), 1, 'the granule below the window');
	// a read the window does not hold marks its granule
	r.ld4(0x9000);
	assert.equal(bitOf(vm.reads(), 0x9000 >> 6), 1);
	// a 16-byte load is tracked even inside a window
	const before = count(vm.reads());
	r.ldv(0x8010);
	assert.equal(count(vm.reads()), before + 1);
	r.ldv(0x4300);
	assert.equal(count(vm.reads()), before + 1, 'inside the window the bits are already set');
	// stores and atomic loads are tracked and log undo entries inside a window
	r.st4(0x4100, 7);
	assert.equal(vm.entries(), 1);
	assert.equal(bitOf(vm.writes(), 0x4100 >> 5), 1);
	r.ald(0x4400);
	assert.equal(vm.entries(), 2);
	// a window with no bytes tracks everything
	const off = open({ readWindows: 1 });
	off.window(0, 0x4000, 0);
	off.exports.ld4(0x4100);
	assert.equal(bitOf(off.reads(), 0x4100 >> 6), 1);
});

test('the counting lowering counts loads by where they landed and changes no result', () => {
	assert.ok(!open({ readWindows: 2 }).names.includes(inlineGlobals.readHits));
	assert.ok(!open({ readCount: true }).names.includes(inlineGlobals.readHits), 'needs windows');
	const counted = open({ readWindows: 2, readCount: true });
	const plain = open({ readWindows: 2 });
	for (const vm of [counted, plain]) {
		vm.window(0, 0x4000, 0x800);
		vm.window(1, 0x6040, 0x80);
	}
	const global = (name: string) => Number(counted.exports[name].value);
	const loads: [string, number][] = [
		['ld4', 0x4000],
		['ld1', 0x4200],
		['ld8', 0x6040],
		['ld4', 0x9000],
		['ld4', 0x47fc],
		['ld4', 0x3a010],
		['ld4', 0x3a800]
	];
	for (const [fn, address] of loads)
		assert.equal(counted.exports[fn](address), plain.exports[fn](address));
	assert.equal(global(inlineGlobals.readHits), 3);
	assert.equal(global(inlineGlobals.readExempt), 2);
	assert.equal(global(inlineGlobals.readMisses), 2, 'a load over the window end is a miss');
	// stores, atomics and 16-byte loads are not counted
	for (const vm of [counted, plain]) {
		vm.exports.st4(0x4100, 1);
		vm.exports.ald(0x4400);
		vm.exports.ldv(0x4300);
	}
	assert.equal(global(inlineGlobals.readHits), 3);
	assert.equal(global(inlineGlobals.readMisses), 2);
	assert.deepEqual(counted.reads(), plain.reads());
	assert.deepEqual(counted.writes(), plain.writes());
});

test('testing the exempt window first changes no result, mark or count', () => {
	const make = (exemptFirst: boolean) => {
		const vm = open({ readWindows: 2, readCount: true, exemptFirst });
		vm.window(0, 0x4000, 0x800);
		vm.window(1, 0x6040, 0x80);
		return vm;
	};
	const [a, b] = [make(false), make(true)];
	const next = rng(7);
	const spots = [0x4000, 0x47fc, 0x6040, 0x6078, 0x3a010, 0x3aff8, 0x3b000, 0x9000, 0x3ffe];
	for (let i = 0; i < 300; i++) {
		const fn = ['ld1', 'ld2', 'ld4', 'ld8', 'ldv', 'ald'][(next() * 6) | 0]!;
		const address =
			(spots[(next() * spots.length) | 0]! + ((next() * 16) | 0)) & (fn === 'ald' ? ~3 : ~0);
		assert.equal(a.exports[fn](address), b.exports[fn](address), `${fn} ${address}`);
	}
	assert.deepEqual(a.reads(), b.reads());
	assert.equal(a.entries(), b.entries());
	for (const name of [inlineGlobals.readHits, inlineGlobals.readMisses, inlineGlobals.readExempt])
		assert.equal(a.exports[name].value, b.exports[name].value, name);
});

test('a load in the exempt window sets no mark and does not reach the window guards', () => {
	const vm = open({ readWindows: 2 });
	vm.window(0, 0x4000, 0x800);
	const before = vm.reads();
	vm.exports.ld4(0x3a100);
	vm.exports.ld8(0x3a200);
	assert.deepEqual(vm.reads(), before);
	assert.equal(vm.entries(), 0);
});

test('a window never reaches the slot checks: the same address outside a window still traps in the arena', () => {
	const vm = open({ readWindows: 1 });
	vm.window(0, 0x4000, 0x800);
	assert.throws(() => vm.exports.ld4(at.arena[0] + 8), WebAssembly.RuntimeError);
	// the own slot and the exempt window behave as without windows
	vm.exports.ld4(at.exempt[0] + 8);
	assert.equal(bitOf(vm.reads(), (at.exempt[0] + 8) >> 6), 0);
	vm.exports.ld4(at.exempt[1] + 8);
	assert.equal(bitOf(vm.reads(), (at.exempt[1] + 8) >> 6), 1);
});

test('windows leave the read set a superset of the tracked one, equal outside the windows, and the writes identical', () => {
	const addresses = (next: () => number, wins: { low: number; bytes: number }[]) => {
		const pick = next();
		if (pick < 0.4) {
			const w = wins[(next() * wins.length) | 0]!;
			return w.low - 12 + ((next() * (w.bytes + 24)) | 0);
		}
		if (pick < 0.55) return at.exempt[0] + ((next() * 0x1fe0) | 0);
		return (next() * 0x1fff0) | 0;
	};
	for (let seed = 1; seed <= 150; seed++) {
		const next = rng(seed * 7919);
		const wins = [0, 1].map(() => ({
			low: (((next() * 0x1c000) | 0) & ~7) + 0x100,
			bytes: 64 * (4 + ((next() * 60) | 0))
		}));
		const tracked = open({}, seed);
		const windowed = open({ readWindows: 2 }, seed);
		wins.forEach((w, i) => windowed.window(i, w.low, w.bytes));
		const names = ['ld1', 'ld2', 'ld4', 'ld8', 'ldv', 'ald', 'st1', 'st4'];
		for (let step = 0; step < 80; step++) {
			const name = names[(next() * names.length) | 0]!;
			const address = addresses(next, wins) & (name === 'ald' ? ~3 : ~0);
			const value = (next() * 0xffffffff) | 0;
			const a = name.startsWith('st')
				? tracked.exports[name](address, value)
				: tracked.exports[name](address);
			const b = name.startsWith('st')
				? windowed.exports[name](address, value)
				: windowed.exports[name](address);
			assert.equal(a, b, `seed ${seed} step ${step} ${name} ${address}`);
		}
		assert.deepEqual(windowed.writes(), tracked.writes(), `writes, seed ${seed}`);
		assert.deepEqual(windowed.log(), tracked.log(), `undo log, seed ${seed}`);
		assert.deepEqual(
			windowed.u8.slice(0, 0x20000),
			tracked.u8.slice(0, 0x20000),
			`memory, seed ${seed}`
		);
		const inWindow = (g: number) =>
			wins.some(
				(w) => g >= Math.floor(w.low / 64) && g <= Math.floor((w.low + w.bytes - 1) / 64)
			);
		const a = tracked.reads();
		const b = windowed.reads();
		for (let g = 0; g < 4096; g++) {
			if (bitOf(a, g)) assert.equal(bitOf(b, g), 1, `lost granule ${g}, seed ${seed}`);
			else if (bitOf(b, g))
				assert.ok(inWindow(g), `extra granule ${g} outside a window, seed ${seed}`);
		}
	}
});
// #endregion

// #region the pure parts
test('markReadWindow sets the bits of every granule the range touches and no others', () => {
	const next = rng(5);
	for (let n = 0; n < 300; n++) {
		const low = (next() * 100000) | 0;
		const bytes = 1 + ((next() * 6000) | 0);
		const map = new Uint8Array(4096);
		markReadWindow(map, 0, low, bytes);
		const first = Math.floor(low / 64);
		const last = Math.floor((low + bytes - 1) / 64);
		for (let g = 0; g < 4096 * 8; g++)
			assert.equal(bitOf(map, g), g >= first && g <= last ? 1 : 0, `${low} ${bytes} ${g}`);
	}
});

test('windows move with the iteration, leave memory out and stay clear of forbidden ranges', () => {
	const windows = {
		strided: { index: 1, low: 1000, stride: 544, bytes: 576 },
		fixed: { low: 4096, bytes: 192 }
	};
	assert.deepEqual(readWindowsAt(windows, 1, 1 << 20), [
		{ low: 960, bytes: 576 },
		{ low: 4096, bytes: 192 }
	]);
	assert.equal(
		readWindowsAt(windows, 3, 1 << 20)[0]!.low,
		64 * Math.floor((1000 + 2 * 544) / 64)
	);
	assert.equal(
		readWindowsAt(windows, 1000, 5000).length,
		1,
		'a strided window past memory drops'
	);
	assert.equal(readWindowsClear(windows, 1, 8, 1 << 20, [[1 << 19, (1 << 19) + 4096]]), true);
	assert.equal(readWindowsClear(windows, 1, 8, 1 << 20, [[4000, 4100]]), false, 'the fixed one');
	assert.equal(
		readWindowsClear(windows, 1, 8, 1 << 20, [[2000, 2100]]),
		false,
		'the strided one'
	);
	assert.equal(readWindowsClear(windows, 1, 8, 3000, []), false, 'the fixed one is past memory');
});

// a sample of one completed iteration: a run of `length` granules from the granule of byte `from`
const sample = (
	index: number,
	from: number,
	length: number,
	extra: [number, number][] = [],
	written: number[] = []
): ReadWindowSample => ({
	index,
	status: 0,
	reads: Int32Array.from(
		[[Math.floor(from / 64), length] as [number, number], ...extra]
			.sort((x, y) => x[0] - y[0])
			.flat()
	),
	written: Int32Array.from(written)
});

test('learning follows a stride of whole granules and of 32 bytes, and a fixed run every iteration read', () => {
	const exact = learnReadWindows(
		[1, 2, 3, 4, 5, 6, 7, 8].map((k) => sample(k, 65536 + 512 * k, 6, [[1024, 3]]))
	);
	assert.deepEqual(exact.windows!.strided, { index: 1, low: 66048, stride: 512, bytes: 384 });
	assert.deepEqual(exact.windows!.fixed, { low: 65536, bytes: 192 });
	const packed = learnReadWindows(
		[1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
			const start = 70000 + 544 * k;
			return sample(k, start, Math.floor((start + 383) / 64) - Math.floor(start / 64) + 1);
		})
	);
	assert.equal(packed.windows!.strided!.stride, 544);
	assert.equal(packed.windows!.strided!.bytes, (7 + 2) * 64, 'one granule of slack at each end');
	for (let k = 1; k <= 8; k++) {
		const [w] = readWindowsAt(packed.windows!, k, 1 << 22);
		const first = 70000 + 544 * k;
		assert.ok(w!.low <= first && w!.low + w!.bytes >= first + 384, `iteration ${k}`);
	}
});

test('runs of unequal length give a window the length of the shortest', () => {
	const lengths = [12, 30, 8, 22, 15, 9, 27, 11];
	const found = learnReadWindows(lengths.map((n, i) => sample(i + 1, 65536 + 4096 * (i + 1), n)));
	assert.deepEqual(found.windows!.strided, { index: 1, low: 69632, stride: 4096, bytes: 8 * 64 });
});

test('learning refuses what is not a stride, too little data, and a window another iteration wrote in', () => {
	const ks = [1, 2, 3, 4, 5, 6, 7, 8];
	assert.match(
		learnReadWindows(ks.slice(0, 2).map((k) => sample(k, 4096 * k, 8))).reason!,
		/fewer than three/
	);
	assert.match(
		learnReadWindows(
			[...ks.map((k) => ({ ...sample(k, 4096 * k, 8), status: k === 1 ? 1 : 0 }))].slice(0, 3)
		).reason!,
		/fewer than three/
	);
	const jumpy = [1, 2, 3, 4].map((k, i) => sample(k, [4096, 9000, 12288, 40000][i]!, 8));
	assert.match(learnReadWindows(jumpy).reason!, /one stride/);
	assert.match(learnReadWindows(ks.map((k) => sample(k, 4096 * k, 2))).reason!, /256 bytes/);
	assert.match(
		learnReadWindows(
			ks.map((k) => sample(k, 4096 * k, 6, [], k === 4 ? [(4096 * 5 + 64) / 32] : []))
		).reason!,
		/wrote inside the strided window/
	);
	// the fixed run is dropped when an iteration wrote in it
	const wrote = learnReadWindows(
		ks.map((k) => sample(k, 4096 * k, 6, [[1024, 3]], k === 2 ? [(1024 * 64) / 32] : []))
	);
	assert.ok(wrote.windows!.strided);
	assert.equal(wrote.windows!.fixed, undefined);
	// a window an iteration wrote in itself is kept: only others' writes conflict
	const own = learnReadWindows(ks.map((k) => sample(k, 4096 * k, 6, [], [(4096 * k + 64) / 32])));
	assert.ok(own.windows!.strided);
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

const layout = {
	table: 0x10000,
	dst: 0x30000,
	fixed: 0x50000,
	records: 0x60000,
	spare: 0x58000,
	scatter: 0xc0000
};

// an owner whose loop sums `words` words of each record, then a word of a fixed table, then the
// word a pointer in the record names; `$item` takes the table entry (src, dst)
const reader = (words: number, extra: { scatter?: number; stack?: number } = {}) => `(module
	(import "env" "memory" (memory 32 128))
	(global $sp (mut i32) (i32.const 65536))
	(func $item (param $t i32) (param $f i32)
		(local $src i32) (local $dst i32) (local $i i32) (local $acc i32) (local $j i32) (local $top i32)
		(local.set $src (i32.load (local.get $t)))
		(local.set $dst (i32.load offset=4 (local.get $t)))
		(local.set $top (global.get $sp))
		(global.set $sp (i32.sub (global.get $sp) (i32.const 512)))
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
		${
			extra.scatter
				? `(local.set $j (i32.const 0))
		(loop $far
			(local.set $acc (i32.add (local.get $acc)
				(i32.load (i32.add (i32.const ${layout.scatter}) (i32.shl (local.get $j) (i32.const 7))))))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br_if $far (i32.lt_u (local.get $j) (i32.const ${extra.scatter}))))`
				: ''
		}
		${
			extra.stack
				? `(local.set $j (i32.const 0))
		(loop $own
			(i32.store (i32.add (global.get $sp) (i32.shl (i32.and (local.get $j) (i32.const 63)) (i32.const 2)))
				(local.get $acc))
			(local.set $acc (i32.add (local.get $acc)
				(i32.load (i32.add (global.get $sp) (i32.shl (i32.and (local.get $j) (i32.const 63)) (i32.const 2))))))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br_if $own (i32.lt_u (local.get $j) (i32.const ${extra.stack}))))`
				: ''
		}
		(global.set $sp (local.get $top))
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
	// the cell iteration k writes; default is its own cell
	dst?: (k: number) => number;
	// the address of the word read through the pointer in record k
	pointer?: (k: number) => number;
}

function image(shape: Shape) {
	const bytes = new Uint8Array(0x100000);
	const view = new DataView(bytes.buffer);
	const next = rng(99);
	for (let i = 0; i < 0x40000; i++) bytes[layout.records + i] = (next() * 256) | 0;
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

async function race(
	shape: Shape,
	readWindows: boolean,
	extra: { scatter?: number; stack?: number } = {}
) {
	const source = wasm(reader(shape.words, extra));
	const bytes = image(shape);
	const memory = new WebAssembly.Memory({ initial: 32, maximum: 128 });
	new Uint8Array(memory.buffer).set(bytes);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(source)), {
		env: { memory }
	});
	(instance.exports.run as CallableFunction)(layout.table, shape.n);
	const folio = await Folio.open(source, { workers: 4, iterationReadWindows: readWindows });
	new Uint8Array(folio.memory.buffer).set(bytes);
	const report = await folio.run('run', [layout.table, shape.n]);
	const same = Buffer.compare(
		new Uint8Array(memory.buffer, PAGE, 31 * PAGE),
		new Uint8Array(folio.memory.buffer, PAGE, 31 * PAGE)
	);
	await folio.close();
	return { report, equal: same === 0 };
}

test('read windows are off unless asked for, and the result is the same either way', async () => {
	const shape = { words: 96, stride: 512, n: 40 };
	const off = await race(shape, false);
	assert.ok(off.equal);
	assert.equal(off.report.iteration!.readWindows, undefined);
	assert.equal(off.report.iteration!.readWindowRefused, undefined);
	assert.equal(off.report.iteration!.batches, 2);
});

test('the first batch learns a strided and a fixed window, later batches use them and equal the serial run', async () => {
	const run = await race({ words: 96, stride: 512, n: 60 }, true);
	assert.ok(run.equal);
	const counts = run.report.iteration!;
	assert.equal(counts.regions, 59);
	assert.equal(counts.replayed, 0);
	assert.deepEqual(counts.conflicts, { raw: 0, war: 0, waw: 0, frame: 0 });
	const windows = counts.readWindows!;
	assert.equal(windows.learnedFrom, 8);
	assert.equal(windows.strided!.stride, 512);
	assert.equal(windows.strided!.bytes, 448, 'the pointer word extends the run by a granule');
	assert.deepEqual(windows.fixed, { low: layout.fixed, bytes: 128 });
	assert.ok(windows.batches >= 1);
	// iterations 1 to 8 ran fully tracked, the rest on the windows
	assert.equal(counts.batches, 1 + windows.batches);
	assert.equal(counts.stopped, undefined);
});

test('a window that reaches a granule an earlier iteration writes costs one batch and no correctness', async () => {
	// stride 544 leaves a granule of slack around each window; from iteration 20 the result cell
	// sits in the granule of slack before the next record, which that iteration never reads
	const stride = 544;
	const shape: Shape = {
		words: 96,
		stride,
		n: 100,
		dst: (k) => (k >= 20 ? layout.records + k * stride + 480 : layout.dst + 64 * k)
	};
	const control = await race(shape, false);
	assert.ok(control.equal);
	assert.equal(control.report.iteration!.replayed, 0, 'without windows nothing conflicts');
	const run = await race(shape, true);
	assert.ok(run.equal);
	const counts = run.report.iteration!;
	assert.ok(counts.readWindows);
	assert.equal(counts.readWindowRefused, 'a batch on the read windows conflicted');
	assert.ok(counts.conflicts.raw > 0);
	assert.ok(counts.replayed > 0);
	assert.equal(counts.stopped, undefined, 'the loop goes on without the windows');
});

test('a read outside the learned window stays tracked, so a true dependence there is still caught', async () => {
	// from iteration 20 the pointer in the record names the cell the previous iteration wrote
	const run = await race(
		{
			words: 96,
			stride: 1024,
			n: 60,
			pointer: (k) => (k >= 20 ? layout.dst + 64 * (k - 1) : layout.spare)
		},
		true
	);
	assert.ok(run.equal);
	const counts = run.report.iteration!;
	assert.ok(counts.readWindows);
	assert.ok(counts.conflicts.raw > 0);
	assert.ok(counts.replayed > 0);
});

test('too few iterations to learn from leave the windows unlearned and the run correct', async () => {
	const run = await race({ words: 96, stride: 512, n: 3 }, true);
	assert.ok(run.equal);
	assert.equal(run.report.iteration?.readWindows, undefined);
});

test('the gate arms windows when hits outnumber misses and not when misses do', () => {
	const windows = { strided: { index: 0, low: 0, stride: 512, bytes: 1024 } };
	const pays = (hits: number, misses: number, frame = false, bytes = 1024) =>
		readWindowsPay(
			{ hits, misses, exempt: 0 },
			{ strided: { ...windows.strided, bytes } },
			frame,
			8
		).pay;
	assert.equal(pays(30_000, 100), true);
	assert.equal(pays(100, 30_000), false);
	assert.equal(pays(0, 0), false, 'no load to save');
	assert.equal(pays(0, 10), false);
	// 39 instructions saved per hit against 6 spent per miss, and a margin of the tracked cost
	assert.equal(pays(220, 1000), false);
	assert.equal(pays(220, 1000, true), true, 'the frame shadow makes a tracked load dearer');
	assert.equal(pays(1000, 0, false, 1 << 22), false, 'marking four MiB of window costs more');
});

test('the gate picks the order of the checks from the counts and charges the guards to the loads that run them', () => {
	const strided = { index: 0, low: 0, stride: 512, bytes: 1024 };
	const fixed = { low: 4096, bytes: 128 };
	const hits = readWindowsPay({ hits: 1000, misses: 0, exempt: 0 }, { strided }, false, 8);
	assert.equal(hits.order, 'window', 'hits alone are cheapest with the windows first');
	assert.equal(hits.pay, true);
	const stack = readWindowsPay(
		{ hits: 1000, misses: 0, exempt: 5_000_000 },
		{ strided },
		false,
		8
	);
	assert.equal(stack.order, 'exempt', 'mostly exempt loads go first');
	assert.equal(stack.spent, hits.spent, 'an exempt load then pays for no guard');
	assert.ok(stack.saved < hits.saved, 'a hit costs 10 more behind the exempt check');
	const one = readWindowsPay({ hits: 1000, misses: 500, exempt: 0 }, { strided }, false, 8);
	const two = readWindowsPay(
		{ hits: 1000, misses: 500, exempt: 0 },
		{ strided, fixed },
		false,
		8
	);
	assert.ok(two.spent > one.spent, 'a miss runs through two guards');
	assert.ok(two.saved < one.saved, 'a hit in the second window costs more');
});

test('counts are the same across calls, so the gate decides the same way', async () => {
	const shape = { words: 96, stride: 512, n: 60 };
	const runs = [];
	for (let call = 0; call < 2; call++) runs.push(await race(shape, true));
	for (const run of runs) assert.ok(run.equal);
	const gates = runs.map((r) => r.report.iteration!.readWindowGate!);
	assert.ok(gates[0]);
	assert.deepEqual(gates[0], gates[1]);
	assert.equal(gates[0].armed, true);
	assert.equal(gates[0].order, 'window');
	assert.ok(gates[0].counts.hits > gates[0].counts.misses);
});

test('a loop whose loads miss the windows lowers without them after one counted batch', async () => {
	// 1500 scattered loads per iteration, one in every other granule, against 192 hits
	const shape = { words: 96, stride: 512, n: 60 };
	const run = await race(shape, true, { scatter: 1500 });
	assert.ok(run.equal);
	const counts = run.report.iteration!;
	const gate = counts.readWindowGate!;
	assert.ok(gate, 'the first batch on the windows was counted');
	assert.equal(gate.armed, false);
	assert.ok(gate.counts.misses > 4 * gate.counts.hits);
	assert.equal(counts.readWindowRefused, 'the windows would not pay for the loop');
	assert.equal(counts.readWindows!.batches, 1, 'only the counted batch ran on them');
	assert.equal(counts.replayed, 0);
	assert.equal(counts.stopped, undefined);
	// the same loop with the gate seam off keeps them armed, and the result is still serial
	admissionSeam.gate = false;
	const kept = await race(shape, true, { scatter: 1500 });
	admissionSeam.gate = true;
	assert.ok(kept.equal);
	assert.equal(kept.report.iteration!.readWindowGate!.armed, true);
	assert.ok(kept.report.iteration!.readWindows!.batches > 1);
});

test('a loop whose loads are mostly in its own stack keeps the windows and pays nothing for them', async () => {
	const shape = { words: 96, stride: 512, n: 60 };
	const run = await race(shape, true, { stack: 600 });
	assert.ok(run.equal);
	const counts = run.report.iteration!;
	const gate = counts.readWindowGate!;
	assert.ok(gate.counts.exempt > 2 * gate.counts.hits, 'most loads are exempt');
	assert.equal(gate.order, 'exempt');
	assert.ok(gate.counts.misses < gate.counts.hits / 10, 'a few loads per iteration are outside');
	assert.equal(gate.armed, true);
	assert.ok(counts.readWindows!.batches > 1);
});

test('the short learning batch leaves later batches on the grid of full ones', async () => {
	admissionSeam.trace = true;
	try {
		const off = await race({ words: 96, stride: 512, n: 130 }, false);
		const on = await race({ words: 96, stride: 512, n: 130 }, true);
		assert.ok(off.equal && on.equal);
		const steps = (r: typeof on) => r.report.iteration!.admission!.trace!;
		const grid = (r: typeof on, from: number) =>
			steps(r)
				.slice(from, -1)
				.every((t) => (t.first + t.count - 1) % 32 === 0);
		assert.ok(grid(off, 0), 'full batches end on multiples of 32 from iteration 1');
		assert.deepEqual(
			steps(on)
				.slice(0, 2)
				.map((t) => t.count),
			[8, 24]
		);
		assert.ok(grid(on, 1), 'after the learning batch the grid is the same');
		assert.equal(steps(on).at(-1)!.first + steps(on).at(-1)!.count, 130);
	} finally {
		admissionSeam.trace = false;
	}
});

test('an owner called twice in one run reports the gate once and sums the batches', async () => {
	const twice = reader(96).replace(
		/\)$/,
		'(func (export "wrap") (param $t i32) (param $n i32) (call $run (local.get $t) (local.get $n)) (call $run (local.get $t) (local.get $n))))'
	);
	const folio = await Folio.open(wasm(twice), { workers: 4, iterationReadWindows: true });
	new Uint8Array(folio.memory.buffer).set(image({ words: 96, stride: 512, n: 60 }));
	const report = await folio.run('wrap', [layout.table, 60]);
	await folio.close();
	const counts = report.iteration!;
	assert.equal(counts.readWindowGate!.armed, true);
	assert.equal(typeof counts.readWindowGate!.iterations, 'number');
	assert.equal(typeof counts.workerMarkMs, 'number');
	assert.ok(counts.readWindows!.batches >= 2);
});

test('a second call on the same Folio counts and arms the windows the same way', async () => {
	const source = wasm(reader(96));
	const folio = await Folio.open(source, { workers: 4, iterationReadWindows: true });
	new Uint8Array(folio.memory.buffer).set(image({ words: 96, stride: 512, n: 60 }));
	const first = await folio.run('run', [layout.table, 60]);
	const second = await folio.run('run', [layout.table, 60]);
	await folio.close();
	for (const report of [first, second]) {
		assert.equal(report.iteration!.readWindowGate!.armed, true);
		assert.equal(report.iteration!.replayed, 0);
	}
	assert.deepEqual(
		first.iteration!.readWindowGate!.counts,
		second.iteration!.readWindowGate!.counts
	);
});
// #endregion
