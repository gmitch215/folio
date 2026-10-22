import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
	applyImage,
	bakeModule,
	captureImage,
	checkBaked,
	decodeImage,
	encodeImage,
	findInImage,
	ImageFormatError,
	ImageMismatchError,
	imagePages,
	moduleDigest,
	type BakeOptions,
	type MemoryImage
} from '../../src/bake.ts';

const page = 65536;

function wasm(text: string, debugNames = false) {
	binaryen.setDebugInfo(debugNames);
	const mod = binaryen.parseText(text);
	try {
		return mod.emitBinary();
	} finally {
		mod.dispose();
		binaryen.setDebugInfo(false);
	}
}

const bootable = wasm(`(module
	(import "env" "memory" (memory 1))
	(global $g (mut i32) (i32.const 7))
	(global $big (mut i64) (i64.const 9))
	(global $f (mut f64) (f64.const 1.5))
	(global $fixed i32 (i32.const 5))
	(data (i32.const 0) "AAAA")
	(data (i32.const 70000) "BBBB")
	(export "g" (global $g))
	(export "big" (global $big))
	(export "f" (global $f))
	(func (export "read") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func (export "boot")
		(i32.store (i32.const 0) (i32.const 0))
		(i32.store8 (i32.const 131082) (i32.const 11))
		(i32.store8 (i32.const 262154) (i32.const 12))
		(i32.store8 (i32.const 327690) (i32.const 13))
		(i32.store8 (i32.const 458762) (i32.const 14))
		(global.set $g (i32.const -99))
		(global.set $big (i64.const 1099511627776))
		(global.set $f (f64.const 2.25))))`);

const bytesOf = (memory: WebAssembly.Memory) => new Uint8Array(memory.buffer);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(b);
const instantiate = (bytes: Uint8Array, memory: WebAssembly.Memory) =>
	new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), { env: { memory } })
		.exports as any;

/** a fresh instance and a booted one grown to 8 pages */
function boot() {
	const freshMemory = new WebAssembly.Memory({ initial: 4 });
	const fresh = instantiate(bootable, freshMemory);
	const bootedMemory = new WebAssembly.Memory({ initial: 4 });
	const booted = instantiate(bootable, bootedMemory);
	bootedMemory.grow(4);
	booted.boot();
	new Uint8Array(bootedMemory.buffer)[7 * page + 5] = 77;
	return { freshMemory, fresh, bootedMemory, booted };
}

const globalsOf = (exports: any) => ({
	0: exports.g.value,
	1: exports.big.value,
	2: exports.f.value
});

function segmentCount(bytes: Uint8Array) {
	const mod = binaryen.readBinary(bytes);
	try {
		return (mod as any).getNumDataSegments() as number;
	} finally {
		mod.dispose();
	}
}

test('captureImage keeps differing pages, ascending, and drops pages zero in both', () => {
	const { freshMemory, bootedMemory } = boot();
	const image = captureImage(bootedMemory, freshMemory);
	expect(image.byteLength).toBe(8 * page);
	expect(image.pages).toEqual([0, 2, 4, 5, 7]);
	expect(imagePages(image)).toEqual({ memoryPages: 8, deltaPages: 5 });
	expect(image.data.length).toBe(5 * page);
	expect(image.data[page + 10]).toBe(11);
	expect(image.module).toBeUndefined();
	expect(image.globals).toBeUndefined();
	expect(image.tableSlots).toBeUndefined();
});

test('captureImage agrees with a byte-by-byte reference on seeded random memories', () => {
	let seed = 12345;
	const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
	for (let round = 0; round < 4; round++) {
		const fresh = new Uint8Array(3 * page);
		const booted = new Uint8Array((3 + (round % 3)) * page);
		for (let i = 0; i < 40; i++) fresh[Math.floor(next() * fresh.length)] = 1 + (i % 250);
		booted.set(fresh);
		for (let i = 0; i < 30; i++)
			booted[Math.floor(next() * booted.length)] = Math.floor(next() * 256);
		if (round === 1) booted.fill(0, 0, page);
		const expected: number[] = [];
		for (let p = 0; p < booted.length / page; p++)
			for (let k = 0; k < page; k++)
				if (booted[p * page + k] !== (fresh[p * page + k] ?? 0)) {
					expected.push(p);
					break;
				}
		const image = captureImage(booted, fresh);
		expect(image.pages).toEqual(expected);
		image.pages.forEach((p, i) =>
			expect(
				same(
					image.data.subarray(i * page, (i + 1) * page),
					booted.subarray(p * page, (p + 1) * page)
				)
			).toBe(true)
		);
	}
});

test('captureImage takes memories, array buffers and views', () => {
	const { freshMemory, bootedMemory } = boot();
	const viaMemory = captureImage(bootedMemory, freshMemory);
	const viaBuffer = captureImage(bootedMemory.buffer, freshMemory.buffer);
	const viaView = captureImage(bytesOf(bootedMemory), bytesOf(freshMemory));
	expect(viaBuffer.pages).toEqual(viaMemory.pages);
	expect(same(viaView.data, viaMemory.data)).toBe(true);
	const shifted = new Uint8Array(bytesOf(bootedMemory).length + 1);
	shifted.set(bytesOf(bootedMemory), 1);
	const unaligned = captureImage(shifted.subarray(1), bytesOf(freshMemory));
	expect(unaligned.pages).toEqual(viaMemory.pages);
	expect(same(unaligned.data, viaMemory.data)).toBe(true);
	const both = captureImage(shifted.subarray(1), shifted.subarray(1, 1 + 4 * page));
	expect(both.pages).toEqual([4, 5, 7]);
});

test('captureImage refuses sizes that are not page multiples or a longer fresh memory', () => {
	expect(() => captureImage(new Uint8Array(100), new Uint8Array(0))).toThrow(RangeError);
	expect(() => captureImage(new Uint8Array(page), new Uint8Array(2 * page))).toThrow(
		/larger than the booted/
	);
	expect(captureImage(new Uint8Array(page), new Uint8Array(0)).pages).toEqual([]);
});

test('captureImage records the digest, changed globals and changed table slots', async () => {
	const { freshMemory, fresh, bootedMemory, booted } = boot();
	const digest = await moduleDigest(bootable);
	expect(digest).toBe(createHash('sha256').update(bootable).digest('hex'));
	const image = captureImage(bootedMemory, freshMemory, {
		module: digest,
		globals: { booted: globalsOf(booted), fresh: globalsOf(fresh) }
	});
	expect(image.module).toBe(digest);
	expect(image.globals).toEqual({ 0: -99, 1: 1099511627776n, 2: 2.25 });
	const unchanged = captureImage(freshMemory, freshMemory, {
		globals: { booted: globalsOf(fresh), fresh: globalsOf(fresh) }
	});
	expect(unchanged.globals).toBeUndefined();
	expect(() => captureImage(freshMemory, freshMemory, { module: 'ABC' })).toThrow(TypeError);
	expect(() =>
		captureImage(freshMemory, freshMemory, { globals: { booted: { 5: 1 }, fresh: {} } })
	).toThrow(/no fresh value/);
});

const tabled = wasm(`(module
	(table (export "t") 4 funcref)
	(elem (i32.const 0) $a $b)
	(func $a)
	(func $b)
	(func (export "swap") (table.set (i32.const 0) (ref.func $b)) (table.set (i32.const 3) (ref.func $a))))`);

test('captureImage reports table slots that boot changed, including added ones', () => {
	const open = () =>
		new WebAssembly.Instance(new WebAssembly.Module(tabled as BufferSource)).exports as any;
	const fresh = open();
	const booted = open();
	expect(
		captureImage(new Uint8Array(0), new Uint8Array(0), {
			table: { booted: booted.t, fresh: fresh.t }
		}).tableSlots
	).toBeUndefined();
	booted.swap();
	const image = captureImage(new Uint8Array(0), new Uint8Array(0), {
		table: { booted: booted.t, fresh: fresh.t }
	});
	expect(image.tableSlots).toEqual([0, 3]);
	booted.t.grow(2);
	booted.t.set(5, booted.t.get(1));
	const grown = captureImage(new Uint8Array(0), new Uint8Array(0), {
		table: { booted: booted.t, fresh: fresh.t }
	});
	expect(grown.tableSlots).toEqual([0, 3, 5]);
});

test('bakeModule makes a module whose fresh memory equals the booted memory', async () => {
	const { freshMemory, fresh, bootedMemory, booted } = boot();
	const image = captureImage(bootedMemory, freshMemory, {
		module: await moduleDigest(bootable),
		globals: { booted: globalsOf(booted), fresh: globalsOf(fresh) }
	});
	const baked = await bakeModule(bootable, image);
	expect(WebAssembly.validate(baked as BufferSource)).toBe(true);
	const memory = new WebAssembly.Memory({ initial: imagePages(image).memoryPages });
	const exports = instantiate(baked, memory);
	expect(same(bytesOf(memory), bytesOf(bootedMemory))).toBe(true);
	expect(exports.g.value).toBe(-99);
	expect(exports.big.value).toBe(1099511627776n);
	expect(exports.f.value).toBe(2.25);
	expect(exports.read(2 * page + 10)).toBe(11);
	expect(checkBaked(baked, image)).toEqual({ equal: true });
});

test('bakeModule writes a page the boot zeroed as an explicit zero run', async () => {
	const { freshMemory, bootedMemory } = boot();
	expect(bytesOf(freshMemory).slice(0, 4)).toEqual(new Uint8Array([65, 65, 65, 65]));
	const image = captureImage(bootedMemory, freshMemory);
	expect(image.pages[0]).toBe(0);
	expect(image.data.slice(0, page).every((value) => value === 0)).toBe(true);
	const baked = await bakeModule(bootable, image);
	const memory = new WebAssembly.Memory({ initial: 8 });
	instantiate(baked, memory);
	expect(bytesOf(memory).slice(0, 4)).toEqual(new Uint8Array(4));
	expect(bytesOf(memory)[70000]).toBe(66);
});

test('bakeModule merges adjacent pages and splits at the cap', async () => {
	const { freshMemory, bootedMemory } = boot();
	const image = captureImage(bootedMemory, freshMemory);
	const before = segmentCount(bootable);
	expect(segmentCount(await bakeModule(bootable, image))).toBe(before + 4);
	const split = await bakeModule(bootable, image, { maxSegmentBytes: page });
	expect(segmentCount(split)).toBe(before + 5);
	const mod = binaryen.readBinary(split);
	try {
		expect((mod as any).getDataSegmentInfo(mod.getDataSegmentByIndex(before + 2)).offset).toBe(
			4 * page
		);
	} finally {
		mod.dispose();
	}
	const memory = new WebAssembly.Memory({ initial: 8 });
	instantiate(split, memory);
	expect(same(bytesOf(memory), bytesOf(bootedMemory))).toBe(true);
	await expect(bakeModule(bootable, image, { maxSegmentBytes: 1000 })).rejects.toThrow(
		RangeError
	);
});

test('bakeModule refuses a wrong digest and a bad image', async () => {
	const { freshMemory, bootedMemory } = boot();
	const image = captureImage(bootedMemory, freshMemory, { module: '0'.repeat(64) });
	await expect(bakeModule(bootable, image)).rejects.toMatchObject({
		name: 'ImageMismatchError',
		code: 'digest'
	});
	const plain = captureImage(bootedMemory, freshMemory);
	await expect(bakeModule(bootable, { ...plain, pages: [1, 0] })).rejects.toBeInstanceOf(
		ImageFormatError
	);
	await expect(bakeModule(bootable, { ...plain, data: new Uint8Array(1) })).rejects.toThrow(
		/data holds/
	);
	await expect(bakeModule(bootable, { ...plain, byteLength: 100 })).rejects.toThrow(/multiple/);
	await expect(bakeModule(bootable, { ...plain, module: 'zz' })).rejects.toThrow(/hex/);
});

test('bakeModule refuses a module with no memory or an image over the maximum', async () => {
	const image: MemoryImage = {
		byteLength: 2 * page,
		pages: [1],
		data: new Uint8Array(page).fill(3)
	};
	const none = wasm('(module (func (export "f")))');
	await expect(bakeModule(none, image)).rejects.toMatchObject({ code: 'no-memory' });
	const capped = wasm('(module (import "env" "memory" (memory 1 1)))');
	await expect(bakeModule(capped, image)).rejects.toMatchObject({ code: 'maximum' });
	const definedCap = wasm('(module (memory (export "m") 1 1))');
	await expect(bakeModule(definedCap, image)).rejects.toMatchObject({ code: 'maximum' });
});

const defined = (text: string) => async (image: MemoryImage, options?: BakeOptions) => {
	const bytes = wasm(text);
	const baked = await bakeModule(bytes, image, options);
	expect(WebAssembly.validate(baked as BufferSource)).toBe(true);
	return {
		bytes,
		baked,
		exports: new WebAssembly.Instance(new WebAssembly.Module(baked as BufferSource))
			.exports as any
	};
};

const twoPages: MemoryImage = {
	byteLength: 2 * page,
	pages: [1],
	data: new Uint8Array(page).fill(3)
};

test('bakeModule raises a defined memory that starts below the image and keeps its own data', async () => {
	const { exports, baked } = await defined(
		'(module (memory (export "m") 1) (data (i32.const 0) "own"))'
	)(twoPages);
	expect(exports.m.buffer.byteLength).toBe(2 * page);
	const bytes = new Uint8Array(exports.m.buffer);
	expect(bytes[page + 9]).toBe(3);
	expect(Array.from(bytes.subarray(0, 3))).toEqual([111, 119, 110]);
	expect(checkBaked(baked, twoPages)).toEqual({ equal: true });
});

test('bakeModule leaves a defined memory that is already large enough', async () => {
	const { bytes, baked, exports } = await defined('(module (memory (export "m") 4))')(twoPages);
	expect(exports.m.buffer.byteLength).toBe(4 * page);
	expect(new Uint8Array(exports.m.buffer)[page + 9]).toBe(3);
	const at = (module: Uint8Array) => {
		const mod = binaryen.readBinary(module);
		try {
			return mod.getMemoryInfo().initial;
		} finally {
			mod.dispose();
		}
	};
	expect(at(baked)).toBe(at(bytes));
});

test('bakeModule keeps the maximum, shared and memory64 flags when it raises a memory', async () => {
	const capped = await defined('(module (memory (export "m") 1 2))')(twoPages);
	expect(capped.exports.m.buffer.byteLength).toBe(2 * page);
	expect(() => capped.exports.m.grow(1)).toThrow(RangeError);
	const shared = await defined('(module (memory (export "m") 1 4 shared))')({
		...twoPages,
		byteLength: 3 * page
	});
	expect(shared.exports.m.buffer).toBeInstanceOf(SharedArrayBuffer);
	expect(shared.exports.m.buffer.byteLength).toBe(3 * page);
	expect(shared.exports.m.grow(1)).toBe(3);
	expect(() => shared.exports.m.grow(1)).toThrow(RangeError);
	const wide = await defined('(module (memory (export "m") i64 1 8) (data (i64.const 0) "w"))')(
		twoPages
	);
	expect(wide.exports.m.buffer.byteLength).toBe(2 * page);
	expect(new Uint8Array(wide.exports.m.buffer)[page + 9]).toBe(3);
	expect(new Uint8Array(wide.exports.m.buffer)[0]).toBe(119);
	expect(checkBaked(wide.baked, twoPages)).toEqual({ equal: true });
	const memory64 = binaryen.readBinary(wide.baked);
	try {
		expect(memory64.getMemoryInfo()).toMatchObject({ is64: true, max: 8, initial: 2 });
	} finally {
		memory64.dispose();
	}
});

test('bakeModule rewrites a defined memory section whose limit grows by whole LEB bytes', async () => {
	for (const total of [200, 20000]) {
		const image: MemoryImage = { byteLength: total * page, pages: [], data: new Uint8Array(0) };
		const { baked } = await defined(
			'(module (memory (export "m") 1 40000) (data (i32.const 0) "x") (func (export "f")))'
		)(image);
		const mod = binaryen.readBinary(baked);
		try {
			expect(mod.getMemoryInfo()).toMatchObject({ initial: total, max: 40000 });
			expect((mod as any).getNumDataSegments()).toBe(1);
			expect(mod.getNumFunctions()).toBe(1);
		} finally {
			mod.dispose();
		}
	}
});

test('bakeModule checks the digest and checkBaked reads a module with a defined memory', async () => {
	const bytes = wasm('(module (memory (export "m") 1))');
	const image = { ...twoPages, module: await moduleDigest(bytes) };
	const baked = await bakeModule(bytes, image);
	expect(checkBaked(baked, image)).toEqual({ equal: true });
	expect(checkBaked(bytes, image)).toEqual({ equal: false, firstDifference: page });
	await expect(bakeModule(baked, image)).rejects.toMatchObject({ code: 'digest' });
});

test('bakeModule refuses a memory section it cannot read', async () => {
	const bytes = wasm('(module (memory 1))');
	const header = Array.from(bytes.subarray(0, 8));
	const odd = Uint8Array.from([...header, 5, 3, 1, 0x10, 1]);
	await expect(bakeModule(odd, twoPages)).rejects.toThrow(/memory flags/);
	const empty = Uint8Array.from([...header, 5, 1, 0]);
	await expect(bakeModule(empty, twoPages)).rejects.toMatchObject({ code: 'no-memory' });
});

test('bakeModule refuses globals it cannot rewrite', async () => {
	const base = { byteLength: page, pages: [], data: new Uint8Array(0) };
	const code = async (globals: MemoryImage['globals']) =>
		(await bakeModule(bootable, { ...base, globals }).catch(
			(error) => error
		)) as ImageMismatchError;
	expect((await code({ 9: 1 })).code).toBe('global');
	expect((await code({ 3: 1 })).message).toMatch(/not mutable/);
	expect((await code({ 0: 1.5 })).message).toMatch(/type/);
	expect((await code({ 0: 1n })).message).toMatch(/type/);
	expect((await code({ 1: 1 })).message).toMatch(/type/);
	const imported = wasm(`(module
		(import "env" "memory" (memory 1))
		(import "env" "sp" (global $sp (mut i32))))`);
	await expect(bakeModule(imported, { ...base, globals: { 0: 4 } })).rejects.toMatchObject({
		code: 'global'
	});
});

test('bakeModule rewrites f32 and i64 globals, including negatives', async () => {
	const text = wasm(`(module
		(import "env" "memory" (memory 1))
		(global $a (mut f32) (f32.const 0))
		(global $b (mut i64) (i64.const 0))
		(export "a" (global $a))
		(export "b" (global $b)))`);
	const baked = await bakeModule(text, {
		byteLength: page,
		pages: [],
		data: new Uint8Array(0),
		globals: { 0: 0.5, 1: -2n }
	});
	const exports = instantiate(baked, new WebAssembly.Memory({ initial: 1 }));
	expect(exports.a.value).toBe(0.5);
	expect(exports.b.value).toBe(-2n);
});

test('bakeModule refuses changed table slots unless told to carry them', async () => {
	const image: MemoryImage = {
		byteLength: page,
		pages: [],
		data: new Uint8Array(0),
		tableSlots: [2]
	};
	await expect(bakeModule(bootable, image)).rejects.toMatchObject({ code: 'table' });
	const baked = await bakeModule(bootable, image, { allowTableChanges: true });
	expect(WebAssembly.validate(baked as BufferSource)).toBe(true);
});

test('bakeModule finds a memory name from the names section', async () => {
	const named = wasm('(module (memory $heap (export "m") 2) (data (i32.const 0) "x"))', true);
	const image: MemoryImage = {
		byteLength: 2 * page,
		pages: [1],
		data: new Uint8Array(page).fill(9)
	};
	const baked = await bakeModule(named, image);
	const exports = new WebAssembly.Instance(new WebAssembly.Module(baked as BufferSource))
		.exports as any;
	expect(new Uint8Array(exports.m.buffer)[page]).toBe(9);
	const named2 = wasm(
		'(module (import "env" "memory" (memory $shared 1)) (func (export "f")))',
		true
	);
	const memory = new WebAssembly.Memory({ initial: 2 });
	instantiate(await bakeModule(named2, image), memory);
	expect(bytesOf(memory)[page + 1]).toBe(9);
	const withFunctionNames = wasm(
		'(module (import "env" "memory" (memory 1)) (func $f (export "f")))',
		true
	);
	instantiate(await bakeModule(withFunctionNames, image), memory);
});

test('bakeModule skips a segment name the module already uses', async () => {
	const named = wasm(
		'(module (import "env" "memory" (memory 1)) (data $folio_image0 (i32.const 0) "x"))',
		true
	);
	const image: MemoryImage = { byteLength: page, pages: [0], data: new Uint8Array(page).fill(4) };
	const memory = new WebAssembly.Memory({ initial: 1 });
	instantiate(await bakeModule(named, image), memory);
	expect(bytesOf(memory)[0]).toBe(4);
});

test('checkBaked finds the first differing byte and reads module segments', async () => {
	const { freshMemory, bootedMemory } = boot();
	const image = captureImage(bootedMemory, freshMemory);
	const baked = await bakeModule(bootable, image);
	expect(checkBaked(bootable, image)).toEqual({ equal: false, firstDifference: 0 });
	const changed = { ...image, data: image.data.slice() };
	changed.data[2 * page + 10] = 200;
	expect(checkBaked(baked, changed)).toEqual({ equal: false, firstDifference: 4 * page + 10 });
	const passive = wasm('(module (memory 1) (data "xyz") (data (i32.const 2) "q"))');
	expect(
		checkBaked(passive, { byteLength: page, pages: [0], data: new Uint8Array(page).fill(1) })
			.equal
	).toBe(false);
	const offset = wasm(
		'(module (import "env" "base" (global $b i32)) (memory 1) (data (global.get $b) "x"))'
	);
	expect(() =>
		checkBaked(offset, { byteLength: page, pages: [], data: new Uint8Array(0) })
	).toThrow(/offset/);
	expect(() => checkBaked(new Uint8Array([1, 2, 3]), image)).toThrow(/not a wasm/);
	const header = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
	const lengthTooLong = new Uint8Array([...header, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 1]);
	expect(() => checkBaked(lengthTooLong, image)).toThrow(/invalid wasm integer/);
	const offsetTooLong = new Uint8Array([
		...header,
		11,
		8,
		1,
		0,
		0x41,
		0x80,
		0x80,
		0x80,
		0x80,
		0x80
	]);
	expect(() => checkBaked(offsetTooLong, image)).toThrow(/invalid wasm integer/);
	const flags = new Uint8Array([...header, 11, 3, 1, 5, 0]);
	expect(() => checkBaked(flags, image)).toThrow(/flags/);
	const negative = new Uint8Array([...header, 11, 6, 1, 0, 0x41, 0x7f, 0x0b, 0]);
	expect(
		checkBaked(negative, { byteLength: page, pages: [], data: new Uint8Array(0) }).equal
	).toBe(true);
	expect(() => checkBaked(baked.subarray(0, 40), image)).toThrow(/truncated/);
});

test('checkBaked ignores segments past the image and clips straddling ones', () => {
	const module = wasm(`(module (memory 2)
		(data (i32.const 131000) "ab")
		(data (i32.const 65530) "0123456789"))`);
	const data = new Uint8Array(page);
	data.set([48, 49, 50, 51, 52, 53], page - 6);
	expect(checkBaked(module, { byteLength: page, pages: [0], data })).toEqual({ equal: true });
	data[page - 2] = 0;
	expect(checkBaked(module, { byteLength: page, pages: [0], data })).toEqual({
		equal: false,
		firstDifference: page - 2
	});
});

test('applyImage restores a fresh memory and grows it first', () => {
	const { freshMemory, bootedMemory } = boot();
	const image = captureImage(bootedMemory, freshMemory);
	applyImage(freshMemory, image);
	expect(freshMemory.buffer.byteLength).toBe(8 * page);
	expect(same(bytesOf(freshMemory), bytesOf(bootedMemory))).toBe(true);
	const roomy = new WebAssembly.Memory({ initial: 10 });
	roomy.grow(0);
	applyImage(roomy, image);
	expect(roomy.buffer.byteLength).toBe(10 * page);
	expect(bytesOf(roomy)[2 * page + 10]).toBe(11);
	const capped = new WebAssembly.Memory({ initial: 2, maximum: 3 });
	expect(() => applyImage(capped, image)).toThrow(RangeError);
	expect(() => applyImage(roomy, { ...image, pages: [9] })).toThrow(ImageFormatError);
});

test('encodeImage and decodeImage round trip every field', async () => {
	const { freshMemory, fresh, bootedMemory, booted } = boot();
	const image = captureImage(bootedMemory, freshMemory, {
		module: await moduleDigest(bootable),
		globals: { booted: globalsOf(booted), fresh: globalsOf(fresh) }
	});
	image.tableSlots = [4, 9];
	const encoded = encodeImage(image);
	expect(Array.from(encoded.slice(0, 4))).toEqual([0x46, 0x49, 0x4d, 0x47]);
	expect(encoded.length).toBe(20 + 32 + 4 + 3 * 13 + 4 + 8 + 5 * 4 + 5 * page);
	const decoded = decodeImage(encoded);
	expect(decoded.byteLength).toBe(image.byteLength);
	expect(decoded.pages).toEqual(image.pages);
	expect(decoded.module).toBe(image.module);
	expect(decoded.globals).toEqual({ 0: -99, 1: 1099511627776n, 2: 2.25 });
	expect(decoded.tableSlots).toEqual([4, 9]);
	expect(same(decoded.data, image.data)).toBe(true);
	const bare = decodeImage(encodeImage({ byteLength: 0, pages: [], data: new Uint8Array(0) }));
	expect(bare).toEqual({ byteLength: 0, pages: [], data: new Uint8Array(0) });
	const inner = new Uint8Array(encoded.length + 3);
	inner.set(encoded, 3);
	expect(decodeImage(inner.subarray(3)).pages).toEqual(image.pages);
});

test('decodeImage rejects truncated, foreign, newer and padded input', () => {
	const image: MemoryImage = {
		byteLength: 2 * page,
		pages: [1],
		data: new Uint8Array(page).fill(5)
	};
	const good = encodeImage(image);
	const code = (bytes: Uint8Array) => {
		try {
			decodeImage(bytes);
		} catch (error) {
			return (error as ImageFormatError).code;
		}
	};
	expect(code(good)).toBeUndefined();
	expect(code(good.subarray(0, 10))).toBe('truncated');
	expect(code(good.subarray(0, good.length - 1))).toBe('truncated');
	expect(code(good.subarray(0, 22))).toBe('truncated');
	const wrong = good.slice();
	wrong[0] = 0;
	expect(code(wrong)).toBe('magic');
	const newer = good.slice();
	newer[4] = 2;
	expect(code(newer)).toBe('version');
	const flagged = good.slice();
	flagged[8] = 16;
	expect(code(flagged)).toBe('invalid');
	const padded = new Uint8Array(good.length + 1);
	padded.set(good);
	expect(code(padded)).toBe('invalid');
	const outside = good.slice();
	new DataView(outside.buffer).setUint32(20, 5, true);
	expect(code(outside)).toBe('invalid');
	const withGlobal = encodeImage({ ...image, globals: { 0: 1 } });
	const kind = withGlobal.slice();
	kind[24 + 4] = 7;
	expect(code(kind)).toBe('invalid');
	expect(code(withGlobal.subarray(0, 26))).toBe('truncated');
	const withTable = encodeImage({ ...image, tableSlots: [1] });
	expect(code(withTable.subarray(0, 22))).toBe('truncated');
	const withDigest = encodeImage({ ...image, module: 'ab'.repeat(32) });
	expect(code(withDigest.subarray(0, 40))).toBe('truncated');
	const withContext = encodeImage({ ...image, context: 'site-a' });
	expect(code(withContext.subarray(0, 22))).toBe('truncated');
	expect(code(withContext.subarray(0, 26))).toBe('truncated');
	const notUtf8 = withContext.slice();
	notUtf8[24] = 0xff;
	expect(code(notUtf8)).toBe('invalid');
	expect(() => encodeImage({ ...image, pages: [5] })).toThrow(ImageFormatError);
});

test('the context digest round trips next to the module digest, globals and table slots', async () => {
	const { freshMemory, fresh, bootedMemory, booted } = boot();
	const image = captureImage(bootedMemory, freshMemory, {
		module: await moduleDigest(bootable),
		context: 'site-pack-7 é',
		globals: { booted: globalsOf(booted), fresh: globalsOf(fresh) }
	});
	image.tableSlots = [4];
	expect(image.context).toBe('site-pack-7 é');
	const decoded = decodeImage(encodeImage(image));
	expect(decoded.context).toBe('site-pack-7 é');
	expect(decoded.module).toBe(image.module);
	expect(decoded.globals).toEqual(image.globals);
	expect(decoded.tableSlots).toEqual([4]);
	expect(decodeImage(encodeImage({ ...image, context: undefined })).context).toBeUndefined();
	const plain = captureImage(bootedMemory, freshMemory);
	expect(encodeImage(plain).length).toBe(20 + 5 * 4 + 5 * page);
});

test('a context digest must hold 1 to 4096 UTF-8 bytes', () => {
	const image: MemoryImage = { byteLength: 0, pages: [], data: new Uint8Array(0) };
	expect(() => captureImage(new Uint8Array(0), new Uint8Array(0), { context: '' })).toThrow(
		TypeError
	);
	expect(() =>
		captureImage(new Uint8Array(0), new Uint8Array(0), { context: 'x'.repeat(4097) })
	).toThrow(TypeError);
	expect(
		captureImage(new Uint8Array(0), new Uint8Array(0), { context: 'x'.repeat(4096) }).context
	).toHaveLength(4096);
	expect(() => encodeImage({ ...image, context: '' })).toThrow(ImageFormatError);
	expect(() => encodeImage({ ...image, context: 'é'.repeat(2049) })).toThrow(/4098 bytes/);
});

test('applyImage refuses a module or context digest that differs, and writes nothing', async () => {
	const { freshMemory, bootedMemory } = boot();
	const digest = await moduleDigest(bootable);
	const image = captureImage(bootedMemory, freshMemory, { module: digest, context: 'ctx-a' });
	const code = (expect_: Parameters<typeof applyImage>[2]) => {
		const target = new WebAssembly.Memory({ initial: 4 });
		try {
			applyImage(target, image, expect_);
		} catch (error) {
			expect(target.buffer.byteLength).toBe(4 * page);
			expect(bytesOf(target).every((value) => value === 0)).toBe(true);
			return (error as ImageMismatchError).code;
		}
	};
	expect(code({ module: digest, context: 'ctx-a' })).toBeUndefined();
	expect(code({})).toBeUndefined();
	expect(code({ module: '1'.repeat(64) })).toBe('digest');
	expect(code({ context: 'ctx-b' })).toBe('context');
	expect(code({ module: digest, context: 'ctx-b' })).toBe('context');
	const bare = captureImage(bootedMemory, freshMemory);
	expect(() => applyImage(freshMemory, bare, { module: digest })).toThrow(/image has none/);
	expect(() => applyImage(freshMemory, bare, { context: 'ctx-a' })).toThrow(ImageMismatchError);
	applyImage(freshMemory, image, { module: digest, context: 'ctx-a' });
	expect(same(bytesOf(freshMemory), bytesOf(bootedMemory))).toBe(true);
});

test('bakeModule refuses a module with more than one memory', async () => {
	const image: MemoryImage = { byteLength: page, pages: [0], data: new Uint8Array(page).fill(1) };
	const mixed = wasm('(module (import "env" "memory" (memory 1)) (memory 1))');
	await expect(bakeModule(mixed, image)).rejects.toMatchObject({
		name: 'ImageMismatchError',
		code: 'memories'
	});
	const two = wasm('(module (memory 1) (memory 1))');
	await expect(bakeModule(two, image)).rejects.toMatchObject({ code: 'memories' });
	const importedTwo = wasm(
		'(module (import "env" "a" (memory 1)) (import "env" "b" (memory 1)))'
	);
	await expect(bakeModule(importedTwo, image)).rejects.toThrow(/2 memories/);
	const one = wasm('(module (memory 1))');
	expect(WebAssembly.validate((await bakeModule(one, image)) as BufferSource)).toBe(true);
});

test('findInImage reports every offset of a needle, across adjacent pages and not across a gap', () => {
	const data = new Uint8Array(3 * page);
	const put = (at: number, text: string) => data.set(new TextEncoder().encode(text), at);
	put(10, 'SECRET');
	put(page - 3, 'SECRET');
	put(page + 100, 'SECRETSECRET');
	put(2 * page - 2, 'AB');
	put(2 * page, 'AB');
	const image: MemoryImage = { byteLength: 12 * page, pages: [2, 3, 7], data };
	const needles = [new TextEncoder().encode('SECRET'), new TextEncoder().encode('ABAB')];
	const found = findInImage(image, needles);
	const at = (pageIndex: number, within: number) => pageIndex * page + within;
	expect(found).toEqual([
		{ needle: 0, offset: at(2, 10) },
		{ needle: 0, offset: at(2, page - 3) },
		{ needle: 0, offset: at(3, 100) },
		{ needle: 0, offset: at(3, 106) }
	]);
	expect(findInImage(image, [needles[1]!])).toEqual([]);
	const gap: MemoryImage = {
		byteLength: 12 * page,
		pages: [2, 4],
		data: new Uint8Array(2 * page)
	};
	gap.data.set([83, 69], page - 2);
	gap.data.set([67, 82], page);
	expect(findInImage(gap, [new TextEncoder().encode('SECR')])).toEqual([]);
	expect(findInImage(image, [])).toEqual([]);
	expect(() => findInImage(image, [new Uint8Array(0)])).toThrow(/needle 0 is empty/);
	expect(() => findInImage({ ...image, pages: [1] }, [needles[0]!])).toThrow(ImageFormatError);
	expect(findInImage(image, [new TextEncoder().encode('SECRETSECRETS')])).toEqual([]);
});
