import binaryen from 'binaryen';
import { expect, test } from 'vitest';
import {
	initTable,
	translate,
	TranslateRefusal,
	translationHost,
	type CensusSite,
	type TranslateOptions
} from '../../scripts/research/elastic-translate.ts';
import {
	durationTable,
	ladderRenders
} from '../../scripts/research/translation-duration-summary.ts';
import { hotSet, regionOf, spanReport } from '../../scripts/research/translation-span.ts';
import { medianCi, routeTau, tauTable } from '../../scripts/research/translation-tau2-summary.ts';
import { classShares, pairedTau } from '../../scripts/research/translation-tax-summary.ts';

const PAGE = 65536;
const TABLE = 8 * PAGE;
const options: TranslateOptions = { tableBase: TABLE, staticLimit: 0, stackFloor: 0 };

function assemble(body: string, memory = '(import "env" "memory" (memory 12 12))') {
	const wat = `(module ${memory} (global $sp (mut i32) (i32.const 262144)) ${body})`;
	const mod = binaryen.parseText(wat);
	mod.setFeatures(
		binaryen.Features.MVP | binaryen.Features.BulkMemory | binaryen.Features.Atomics
	);
	const bytes = mod.emitBinary();
	mod.dispose();
	return bytes;
}

const loads: [string, string, number][] = [
	['i32.load8_s', 'i32', 1],
	['i32.load8_u', 'i32', 1],
	['i32.load16_s', 'i32', 2],
	['i32.load16_u', 'i32', 2],
	['i32.load', 'i32', 4],
	['i64.load8_u', 'i64', 1],
	['i64.load16_s', 'i64', 2],
	['i64.load32_u', 'i64', 4],
	['i64.load', 'i64', 8],
	['f32.load', 'f32', 4],
	['f64.load', 'f64', 8]
];
const stores: [string, string][] = [
	['i32.store8', 'i32'],
	['i32.store16', 'i32'],
	['i32.store', 'i32'],
	['i64.store8', 'i64'],
	['i64.store32', 'i64'],
	['i64.store', 'i64'],
	['f32.store', 'f32'],
	['f64.store', 'f64']
];

function everyAccess() {
	let body = '';
	for (const [op, type] of loads) {
		const name = op.replace('.', '_');
		body += `(func (export "${name}") (param i32) (result ${type}) (${op} (local.get 0)))`;
		body += `(func (export "${name}_o") (param i32) (result ${type}) (${op} offset=5 align=1 (local.get 0)))`;
	}
	for (const [op, type] of stores) {
		const name = op.replace('.', '_');
		body += `(func (export "${name}") (param i32 ${type}) (${op} (local.get 0) (local.get 1)))`;
		body += `(func (export "${name}_o") (param i32 ${type}) (${op} offset=3 align=1 (local.get 0) (local.get 1)))`;
	}
	return assemble(body);
}

function instantiate(bytes: Uint8Array, translated: boolean, delta?: Record<number, number>) {
	const memory = new WebAssembly.Memory({ initial: 12, maximum: 12 });
	const host = translationHost(memory, TABLE);
	if (translated) {
		initTable(memory, TABLE, 4);
		const table = new Int32Array(memory.buffer, TABLE, 65536);
		for (const [page, value] of Object.entries(delta ?? {})) table[Number(page)] = value;
	}
	const bytesView = new Uint8Array(memory.buffer, 0, 4 * PAGE);
	for (let i = 0; i < bytesView.length; i++) bytesView[i] = (i * 2654435761) >>> 24;
	const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {
		env: { memory },
		...host.imports
	});
	return { memory, host, exports: instance.exports as Record<string, (...args: any[]) => any> };
}

function attempt(run: () => unknown) {
	try {
		const value = run();
		return typeof value === 'number' && Number.isNaN(value) ? 'NaN' : value;
	} catch (error) {
		return `trap:${(error as Error).constructor.name}`;
	}
}

const addresses = [
	0,
	1,
	2,
	3,
	4093,
	PAGE - 8,
	PAGE - 4,
	PAGE - 3,
	PAGE - 1,
	PAGE,
	PAGE + 7,
	3 * PAGE - 2
];

for (const shape of ['inline', 'call'] as const) {
	test(`${shape}: every load and store width agrees with the original, offsets and page crossings included`, () => {
		const original = everyAccess();
		const { bytes, stats } = translate(original, { ...options, shape });
		expect(stats.loads).toBe(loads.length * 2);
		expect(stats.stores).toBe(stores.length * 2);
		expect(stats.sites.checked).toBe((loads.length + stores.length) * 2);
		const native = instantiate(original, false);
		const moved = instantiate(bytes, true);
		for (const [op] of loads)
			for (const suffix of ['', '_o'])
				for (const address of addresses) {
					const name = op.replace('.', '_') + suffix;
					expect(
						attempt(() => moved.exports[name]!(address)),
						`${name} @ ${address}`
					).toEqual(attempt(() => native.exports[name]!(address)));
				}
		for (const [op, type] of stores)
			for (const suffix of ['', '_o'])
				for (const address of addresses) {
					const name = op.replace('.', '_') + suffix;
					const value =
						type === 'i64' ? 0x1122334455667788n : type === 'i32' ? 0x55aa33cc : 1.5;
					attempt(() => native.exports[name]!(address, value));
					attempt(() => moved.exports[name]!(address, value));
				}
		const a = new Uint8Array(native.memory.buffer, 0, 4 * PAGE);
		const b = new Uint8Array(moved.memory.buffer, 0, 4 * PAGE);
		expect(Buffer.compare(a, b)).toBe(0);
		expect(moved.host.counts.straddles).toBeGreaterThan(0);
	});
}

test('a translated address lands in the frame the table names', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load offset=4 (local.get 0)))'
	);
	const { bytes } = translate(original, options);
	const moved = instantiate(bytes, true, { 1: 2 * PAGE });
	new DataView(moved.memory.buffer).setUint32(3 * PAGE + 8, 0xdeadbeef, true);
	expect(moved.exports.read!(PAGE + 4)).toBe(0xdeadbeef | 0);
});

test('a page the table does not hold traps with the typed miss message', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load (local.get 0)))'
	);
	const { bytes } = translate(original, options);
	const moved = instantiate(bytes, true);
	expect(() => moved.exports.read!(5 * PAGE + 16)).toThrow(
		'folio.translate: page miss at 0x00050010 (4 bytes)'
	);
});

test('an access crossing into a page with a different frame traps as a page straddle', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load (local.get 0)))'
	);
	const { bytes } = translate(original, options);
	const moved = instantiate(bytes, true, { 1: 3 * PAGE });
	expect(() => moved.exports.read!(PAGE - 2)).toThrow('page straddle at 0x00010000');
	expect(moved.exports.read!(PAGE - 4)).toBeTypeOf('number');
});

test('ptr plus offset past 4 GiB traps instead of wrapping into low memory', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load offset=8 (local.get 0)))'
	);
	const { bytes } = translate(original, options);
	expect(() => instantiate(bytes, true).exports.read!(-1)).toThrow('address wrap');
	expect(() => instantiate(original, false).exports.read!(-1)).toThrow(WebAssembly.RuntimeError);
});

test('memory.copy, memory.fill and atomics are refused with their names', () => {
	const copy = assemble(
		'(func (export "f") (memory.copy (i32.const 0) (i32.const 16) (i32.const 8)))'
	);
	expect(() => translate(copy, options)).toThrow(TranslateRefusal);
	try {
		translate(copy, options);
	} catch (error) {
		expect((error as TranslateRefusal).reasons).toEqual(['memory.copy']);
	}
	const fill = assemble(
		'(func (export "f") (memory.fill (i32.const 0) (i32.const 1) (i32.const 8)))'
	);
	expect(() => translate(fill, options)).toThrow('memory.fill');
	const atomic = assemble(
		'(func (export "f") (result i32) (i32.atomic.load (i32.const 0)))',
		'(import "env" "memory" (memory 12 12 shared))'
	);
	expect(() => translate(atomic, options)).toThrow('atomics');
});

test('exempt leaves stack and static accesses alone and bounds the stack pointer', () => {
	const original = assemble(`
		(func (export "frame") (param i32) (result i32) (local $fp i32) (local $r i32)
			(global.set $sp (local.tee $fp (i32.sub (global.get $sp) (i32.const 32))))
			(i32.store offset=8 (local.get $fp) (local.get 0))
			(i32.store (i32.const 100) (i32.const 7))
			(local.set $r (i32.add (i32.load offset=8 (local.get $fp)) (i32.load (i32.const 100))))
			(global.set $sp (i32.add (global.get $sp) (i32.const 32)))
			(local.get $r))
		(func (export "heap") (param i32) (result i32) (i32.load (local.get 0)))`);
	const { bytes, stats } = translate(original, {
		...options,
		exempt: true,
		staticLimit: 1024,
		stackFloor: 262144 - 4096
	});
	expect(stats.sites).toEqual({ stack: 2, static: 2, hoisted: 0, checked: 1 });
	expect(stats.prologueChecks).toBe(1);
	const moved = instantiate(bytes, true);
	expect(moved.exports.frame!(35)).toBe(42);
	expect(moved.host.counts.slow).toBe(0);
	const low = translate(original, {
		...options,
		exempt: true,
		staticLimit: 1024,
		stackFloor: 262144
	});
	expect(() => instantiate(low.bytes, true).exports.frame!(1)).toThrow('stack window');
});

test('hoist lifts the lookup of a loop-invariant base out of a call-free loop', () => {
	const original = assemble(`
		(func (export "sum") (param $base i32) (param $n i32) (result i32) (local $s i32)
			(loop $l
				(local.set $s (i32.add (local.get $s) (i32.load offset=4 (local.get $base))))
				(local.set $n (i32.sub (local.get $n) (i32.const 1)))
				(br_if $l (local.get $n)))
			(local.get $s))`);
	const plain = translate(original, options);
	const hoisted = translate(original, { ...options, hoist: true });
	expect(hoisted.stats.hoistedLoops).toBe(1);
	expect(hoisted.stats.sites.hoisted).toBe(1);
	expect(plain.stats.sites.checked).toBe(1);
	const native = instantiate(original, false);
	const moved = instantiate(hoisted.bytes, true);
	expect(moved.exports.sum!(PAGE - 8, 5)).toBe(native.exports.sum!(PAGE - 8, 5));
	expect(() => moved.exports.sum!(6 * PAGE, 2)).toThrow('page miss');
});

test('floor checks no access, so a page the table does not hold reads like the original', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load offset=4 (local.get 0)))'
	);
	const { bytes, stats } = translate(original, { ...options, floor: true });
	expect(stats.sites.checked).toBe(0);
	expect(stats.sites.static).toBe(1);
	expect(() =>
		instantiate(translate(original, options).bytes, true).exports.read!(6 * PAGE)
	).toThrow('page miss');
	expect(instantiate(bytes, true).exports.read!(6 * PAGE)).toBe(
		instantiate(original, false).exports.read!(6 * PAGE)
	);
});

test('census counts each checked access in its own slot and leaves the access untranslated', () => {
	const original = assemble(`
		(func (export "f") (param $p i32) (result i32)
			(i32.store offset=8 (local.get $p) (i32.const 7))
			(i32.add (i32.load (local.get $p)) (i32.load offset=4 (local.get $p))))`);
	const base = 10 * PAGE;
	const sites: CensusSite[] = [];
	const { bytes, stats } = translate(original, { ...options, census: { base, sites } });
	expect(stats.sites.checked).toBe(3);
	expect(sites.map((s) => [s.id, s.store, s.bytes, s.offset])).toEqual([
		[0, true, 4, 8],
		[1, false, 4, 0],
		[2, false, 4, 4]
	]);
	const moved = instantiate(bytes, true);
	new Int32Array(moved.memory.buffer, base, 3).fill(0);
	const native = instantiate(original, false);
	for (const p of [64, PAGE - 8, 6 * PAGE])
		expect(moved.exports.f!(p)).toBe(native.exports.f!(p));
	expect([...new Int32Array(moved.memory.buffer, base, 4)]).toEqual([
		3,
		3,
		3,
		expect.any(Number)
	]);
});

test('elision labels split sound, region and oracle groups at calls, writes and other lookups', () => {
	const original = assemble(`
		(func $g)
		(func (export "interleave") (param $p i32) (param $q i32) (result i32)
			(i32.add (i32.load (local.get $p))
			(i32.add (i32.load offset=4 (local.get $p))
			(i32.add (i32.load (local.get $q))
				(i32.load offset=8 (local.get $p))))))
		(func (export "calls") (param $p i32) (result i32)
			(drop (i32.load (local.get $p)))
			(call $g)
			(drop (i32.load offset=4 (local.get $p)))
			(local.set $p (i32.add (local.get $p) (i32.const 8)))
			(i32.load offset=4 (local.get $p)))
		(func (export "chase") (param $p i32) (result i32)
			(drop (i32.load (local.get $p)))
			(drop (i32.load (i32.load offset=4 (local.get $p))))
			(i32.load offset=8 (local.get $p)))
		(func (export "walk") (param $p i32) (param $n i32) (param $q i32)
			(loop $l
				(drop (i32.load (local.get $q)))
				(drop (i32.load8_u (local.get $p)))
				(local.set $p (i32.add (local.get $p) (i32.const 1)))
				(br_if $l (i32.sub (local.get $n) (i32.const 1)))))`);
	const sites: CensusSite[] = [];
	translate(original, { ...options, census: { base: 10 * PAGE, sites } });
	const label = (fn: number) =>
		sites.filter((s) => s.fn === fn).map((s) => `${s.sound[0]}${s.region[0]}${s.oracle[0]}`);
	const fns = Object.fromEntries(
		['interleave', 'calls', 'chase', 'walk'].map((n, i) => [n, i + 1])
	) as Record<string, number>;
	expect(label(fns.interleave!)).toEqual(['lll', 'mmm', 'lll', 'lmm']);
	expect(label(fns.calls!)).toEqual(['lll', 'lll', 'lll']);
	expect(sites.filter((s) => s.fn === fns.chase).map((s) => s.shape)).toEqual([
		'local',
		'local',
		'other',
		'local'
	]);
	expect(label(fns.chase!)).toEqual(['lll', 'mmm', 'nnn', 'llm']);
	const walk = sites.filter((s) => s.fn === fns.walk);
	expect(walk.map((s) => s.loop)).toEqual(['invariant', 'affine']);
	expect(walk.map((s) => s.loopCalls || s.loopInner)).toEqual([false, false]);
});

test('a group of accesses off one pointer pays one lookup and agrees with the original at every page edge', () => {
	const original = assemble(`
		(func (export "sum") (param $p i32) (result i32)
			(i32.store offset=12 (local.get $p) (i32.const 77))
			(i32.add (i32.add (i32.load (local.get $p)) (i32.load offset=4 (local.get $p)))
				(i32.add (i32.load8_u offset=8 (local.get $p)) (i32.load offset=12 (local.get $p)))))`);
	const plain = translate(original, { ...options, count: true });
	const grouped = translate(original, { ...options, count: true, groups: true });
	expect(plain.stats.sites.checked).toBe(5);
	expect(grouped.stats.sites.checked).toBe(5);
	expect(grouped.stats.groupSites).toBe(4);
	const moved = instantiate(grouped.bytes, true);
	const native = instantiate(original, false);
	for (const p of [0, 4, PAGE - 16, PAGE - 12, PAGE - 4, 2 * PAGE - 17, 3 * PAGE - 20])
		expect(
			attempt(() => moved.exports.sum!(p)),
			`p=${p}`
		).toEqual(attempt(() => native.exports.sum!(p)));
	const c = counted(grouped.bytes);
	c.e.sum(PAGE + 64);
	expect([c.e.__folio_n_checked.value, c.e.__folio_n_member.value]).toEqual([5, 4]);
	expect(c.host.counts.slow).toBe(0);
});

test('a group never reuses a page once another lookup could have evicted it', () => {
	const original = assemble(`
		(func (export "mix") (param $p i32) (param $q i32) (result i32) (local $s i32)
			(local.set $s (i32.load (local.get $p)))
			(local.set $s (i32.add (local.get $s) (i32.load offset=4 (local.get $p))))
			(local.set $s (i32.add (local.get $s) (i32.load (local.get $q))))
			(local.set $s (i32.add (local.get $s) (i32.load offset=8 (local.get $p))))
			(i32.store offset=12 (local.get $p) (local.get $s))
			(i32.add (local.get $s) (i32.load offset=12 (local.get $p))))`);
	const { bytes, stats } = translate(original, { ...options, groups: true });
	expect(stats.groupSites).toBe(3);
	const A = 1;
	const B = 2;
	const FRAME = 5;
	const memory = new WebAssembly.Memory({ initial: 12, maximum: 12 });
	const view = new Uint8Array(memory.buffer);
	const backing = new Map<number, Uint8Array>();
	for (const page of [A, B]) {
		const data = new Uint8Array(PAGE).map((_, i) => (i * 31 + page * 7) & 255);
		backing.set(page, data);
	}
	const table = new Int32Array(memory.buffer, TABLE, 65536).fill(-1);
	let resident = -1;
	let handlerCalls = 0;
	const frame = () => view.subarray(FRAME * PAGE, (FRAME + 1) * PAGE);
	const evict = () => {
		if (resident < 0) return;
		backing.get(resident)!.set(frame());
		table[resident] = -1;
		resident = -1;
	};
	const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {
		env: { memory },
		folio: {
			slow(pointer: number, offset: number, size: number) {
				handlerCalls++;
				const address = pointer + offset;
				const page = address >>> 16;
				if ((address + size - 1) >>> 16 !== page) throw new Error('span straddles pages');
				if (resident !== page) {
					evict();
					frame().set(backing.get(page)!);
					table[page] = (FRAME - page) * PAGE;
					resident = page;
				}
				return table[page]!;
			},
			stack_miss() {
				throw new Error('stack');
			}
		}
	});
	const mix = instance.exports.mix as (p: number, q: number) => number;
	const native = instantiate(original, false);
	const nativeView = new Uint8Array(native.memory.buffer);
	for (const page of [A, B]) nativeView.set(backing.get(page)!, page * PAGE);
	const got = mix(A * PAGE + 16, B * PAGE + 32);
	expect(got).toBe(native.exports.mix!(A * PAGE + 16, B * PAGE + 32));
	evict();
	expect(handlerCalls).toBe(3);
	for (const page of [A, B])
		expect(backing.get(page)).toEqual(nativeView.slice(page * PAGE, (page + 1) * PAGE));
});

test('counters report the dynamic share of each access class', () => {
	const original = assemble(`
		(func (export "f") (param i32) (result i32) (local $fp i32)
			(local.set $fp (i32.sub (global.get $sp) (i32.const 16)))
			(i32.store (local.get $fp) (local.get 0))
			(i32.add (i32.load (local.get $fp)) (i32.load (local.get 0))))`);
	const { bytes } = translate(original, { ...options, exempt: true, count: true });
	const memory = new WebAssembly.Memory({ initial: 12, maximum: 12 });
	initTable(memory, TABLE, 4);
	const host = translationHost(memory, TABLE);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {
		env: { memory },
		...host.imports
	});
	const e = instance.exports as Record<string, any>;
	e.f(64);
	e.f(64);
	expect([e.__folio_n_stack.value, e.__folio_n_checked.value]).toEqual([4, 2]);
});

function counted(bytes: Uint8Array, delta?: Record<number, number>) {
	const memory = new WebAssembly.Memory({ initial: 12, maximum: 12 });
	initTable(memory, TABLE, 4);
	const table = new Int32Array(memory.buffer, TABLE, 65536);
	for (const [page, value] of Object.entries(delta ?? {})) table[Number(page)] = value;
	const host = translationHost(memory, TABLE);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {
		env: { memory },
		...host.imports
	});
	return { memory, host, e: instance.exports as Record<string, any> };
}

const walk = `
	(func (export "walk") (param $p i32) (param $n i32) (result i32) (local $s i32)
		(loop $l
			(local.set $s (i32.add (local.get $s) (i32.load8_u (i32.add (local.get $p) (local.get $n)))))
			(local.set $n (i32.sub (local.get $n) (i32.const 1)))
			(br_if $l (local.get $n)))
		(local.get $s))`;

for (const cache of ['function', 'site'] as const) {
	test(`cache ${cache}: every width agrees with the original and a hit skips the lookup`, () => {
		const original = everyAccess();
		const { bytes } = translate(original, { ...options, cache });
		const native = instantiate(original, false);
		const moved = instantiate(bytes, true);
		for (const [op] of loads)
			for (const suffix of ['', '_o'])
				for (const address of addresses) {
					const name = op.replace('.', '_') + suffix;
					expect(
						attempt(() => moved.exports[name]!(address)),
						`${name} @ ${address}`
					).toEqual(attempt(() => native.exports[name]!(address)));
				}
		const a = new Uint8Array(native.memory.buffer, 0, 4 * PAGE);
		const b = new Uint8Array(moved.memory.buffer, 0, 4 * PAGE);
		expect(Buffer.compare(a, b)).toBe(0);
	});

	test(`cache ${cache}: the delta of the cached page is used and a page change refreshes it`, () => {
		const original = assemble(walk);
		const { bytes } = translate(original, { ...options, cache, count: true });
		const plain = translate(original, options);
		const run = (b: Uint8Array) => {
			const m = counted(b, { 1: 2 * PAGE, 2: 3 * PAGE });
			const view = new Uint8Array(m.memory.buffer);
			for (let i = 0; i < 64; i++) {
				view[3 * PAGE + i] = i + 1;
				view[PAGE + i] = 100;
			}
			return m;
		};
		const cached = run(bytes);
		const reference = run(plain.bytes);
		expect(cached.e.walk(2 * PAGE - 4, 40)).toBe(reference.e.walk(2 * PAGE - 4, 40));
		expect(cached.e.walk(PAGE + 0, 40)).toBe(reference.e.walk(PAGE + 0, 40));
		expect(cached.e.walk(PAGE + 0, 40)).toBe(reference.e.walk(PAGE + 0, 40));
		expect(cached.host.counts.slow).toBe(reference.host.counts.slow);
		// 120 loads, two page changes in the first call: far fewer misses than loads
		const misses = cached.e.__folio_n_miss.value;
		expect(misses).toBeLessThan(10);
		expect(misses).toBeGreaterThanOrEqual(2);
	});

	test(`cache ${cache}: a page the table does not hold still traps, first access included`, () => {
		const original = assemble(
			'(func (export "read") (param i32) (result i32) (i32.load (local.get 0)))'
		);
		const { bytes } = translate(original, { ...options, cache });
		expect(() => counted(bytes).e.read(5 * PAGE + 16)).toThrow(
			'folio.translate: page miss at 0x00050010 (4 bytes)'
		);
		expect(() => counted(bytes).e.read(0xfffffff0 | 0)).toThrow();
		expect(() => counted(bytes).e.read(-1)).toThrow();
	});
}

test('cache site keeps its entry across calls and cache function does not', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load (local.get 0)))'
	);
	const misses = (cache: 'function' | 'site') => {
		const m = counted(translate(original, { ...options, cache, count: true }).bytes);
		for (let i = 0; i < 5; i++) m.e.read(PAGE + 8 * i);
		return m.e.__folio_n_miss.value;
	};
	expect(misses('site')).toBe(1);
	expect(misses('function')).toBe(5);
});

test('an access inside a pinned range skips the table and one that leaves it uses the table', () => {
	const original = assemble(
		'(func (export "read") (param i32) (result i32) (i32.load (local.get 0)))'
	);
	const arenas = [{ lo: 2 * PAGE, size: 2 * PAGE }];
	const { bytes } = translate(original, { ...options, arenas, count: true });
	const m = counted(bytes, { 2: -1, 3: -1 });
	new DataView(m.memory.buffer).setUint32(2 * PAGE + 8, 0x01020304, true);
	expect(m.e.read(2 * PAGE + 8)).toBe(0x01020304);
	expect(m.e.read(4 * PAGE - 4)).toBeTypeOf('number');
	expect(m.host.counts.slow).toBe(0);
	expect(m.e.__folio_n_miss.value).toBe(0);
	expect(m.e.read(PAGE + 4)).toBeTypeOf('number');
	expect(m.e.__folio_n_miss.value).toBe(1);
	expect(() => m.e.read(4 * PAGE - 2)).toThrow('page miss');
	expect(() => m.e.read(2 * PAGE - 1)).toThrow('page straddle');
	expect(() => m.e.read(4 * PAGE)).toThrow('page miss');
});

test('a pinned range ignores sites whose offset reaches the range start', () => {
	const original = assemble(`
		(func (export "low") (param i32) (result i32) (i32.load offset=8 (local.get 0)))
		(func (export "flat") (param i32) (result i32) (i32.load (local.get 0)))`);
	const { bytes } = translate(original, { ...options, arenas: [{ lo: 4, size: PAGE }] });
	const m = counted(bytes, { 0: -1 });
	expect(m.e.flat(8)).toBeTypeOf('number');
	expect(() => m.e.low(0)).toThrow('page miss');
	expect(() => m.e.flat(0xfffffff8 | 0)).toThrow();
});

test('every width agrees with the original under a pinned range, edges included', () => {
	const original = everyAccess();
	const arenas = [{ lo: PAGE, size: 2 * PAGE }];
	const { bytes } = translate(original, { ...options, arenas });
	const native = instantiate(original, false);
	const moved = instantiate(bytes, true);
	for (const [op] of loads)
		for (const suffix of ['', '_o'])
			for (const address of addresses) {
				const name = op.replace('.', '_') + suffix;
				expect(
					attempt(() => moved.exports[name]!(address)),
					`${name} @ ${address}`
				).toEqual(attempt(() => native.exports[name]!(address)));
			}
	for (const [op, type] of stores)
		for (const suffix of ['', '_o'])
			for (const address of addresses) {
				const name = op.replace('.', '_') + suffix;
				const value =
					type === 'i64' ? 0x1122334455667788n : type === 'i32' ? 0x55aa33cc : 1.5;
				attempt(() => native.exports[name]!(address, value));
				attempt(() => moved.exports[name]!(address, value));
			}
	const a = new Uint8Array(native.memory.buffer, 0, 4 * PAGE);
	const b = new Uint8Array(moved.memory.buffer, 0, 4 * PAGE);
	expect(Buffer.compare(a, b)).toBe(0);
});

const row = (arm: string, rep: number, requestMs: number) => ({
	config: 'default',
	arm,
	rep,
	requestMs,
	ok: true
});

test('paired tau takes the median of per-repeat ratios and keeps the range', () => {
	const rows = [
		row('native', 1, 100),
		row('native', 2, 200),
		row('native', 3, 100),
		row('bcd', 1, 250),
		row('bcd', 2, 300),
		row('bcd', 3, 150),
		row('bcd', 4, 999)
	];
	const t = pairedTau(rows, 'default', 'bcd')!;
	expect(t.n).toBe(3);
	expect(t.ratios).toEqual([2.5, 1.5, 1.5]);
	expect(t.tau).toBe(0.5);
	expect([t.tauMin, t.tauMax]).toEqual([0.5, 1.5]);
	expect(t.stalledPairs).toBe(0);
	const stalled = pairedTau(
		[...rows, row('native', 4, 100), row('bcd', 5, 100000), row('native', 5, 100)],
		'default',
		'bcd'
	)!;
	expect(stalled.stalledPairs).toBe(1);
	expect(stalled.n).toBe(4);
	expect(pairedTau(rows, 'default', 'missing')).toBeNull();
	expect(
		pairedTau([{ ...row('native', 1, 1), ok: false }, row('b', 1, 2)], 'default', 'b')
	).toBeNull();
});

test('class shares add up and the exempt share is stack plus static', () => {
	const s = classShares({
		__folio_n_stack: 60,
		__folio_n_static: 10,
		__folio_n_hoisted: 5,
		__folio_n_checked: 25
	});
	expect(s.total).toBe(100);
	expect(s.exempt).toBe(0.7);
	expect(s.share.checked).toBe(0.25);
});

const regions = {
	dataStart: 0,
	dataEnd: 100,
	stackBase: 40 * PAGE,
	stackEnd: 4 * PAGE,
	segments: 1
};

test('regions split at the stack end and base, and a hot set reaches its share of accesses', () => {
	expect(regionOf(4 * PAGE - 1, regions)).toBe('static');
	expect(regionOf(4 * PAGE, regions)).toBe('stack');
	expect(regionOf(40 * PAGE, regions)).toBe('heap');
	const counts = { 0: [10, 0], 39: [80, 0], 41: [5, 0], 50: [5, 0] } as Record<
		string,
		[number, number]
	>;
	expect(hotSet(counts, 0.5).pages).toEqual([39]);
	expect(hotSet(counts, 0.9).pages).toEqual([39, 0]);
});

test('the span of the hot set runs from its first to its last page, holes included', () => {
	const counts = { 0: [10, 0], 39: [80, 0], 50: [10, 0] } as Record<string, [number, number]>;
	const r = spanReport(counts, regions, 60 * PAGE);
	expect(r.sets.hot99!.all.spanPages).toBe(51);
	expect(r.window.hot90SpanPages).toBe(40);
	expect(r.window.spanOverLinear).toBeCloseTo(40 / 60);
	expect(r.accessShare.stack).toBeCloseTo(0.8);
	expect(r.sets.touched!.heap.pages).toBe(1);
});

test('a ladder sample gives one cumulative rung per render and tau per rung', () => {
	const ladder = (arm: string, rep: number, ms: number[]) => ({
		config: 'default',
		site: 'thunder',
		workload: 'ladder',
		arm,
		rep,
		ok: true,
		ladder: ms.map((m, k) => ({
			i: k + 1,
			ms: m,
			cumMs: ms.slice(0, k + 1).reduce((a, b) => a + b, 0)
		}))
	});
	const rows = [
		ladder('native', 1, [100, 50]),
		ladder('bcd', 1, [300, 100]),
		ladder('native', 2, [100, 50]),
		ladder('bcd', 2, [250, 100])
	];
	const t = durationTable(rows, 'default', ['bcd']);
	expect(t.map((c) => [c.rung, c.nativeMedianMs])).toEqual([
		[1, 100],
		[2, 150]
	]);
	expect((t[0]!.arms.bcd as any).tau).toBe(1.75);
	expect((t[1]!.arms.bcd as any).tau).toBeCloseTo(1.5, 5);
	expect(ladderRenders(rows, 'default').bcd).toEqual({ 1: 275, 2: 100 });
});

test('a median interval needs six samples and takes order statistics around the middle', () => {
	expect(medianCi([1, 2, 3, 4, 5])).toBeNull();
	expect(medianCi([1, 2, 3, 4, 5, 6])).toEqual([1, 6]);
	expect(medianCi([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toEqual([2, 9]);
});

test('a route only supports a gate claim with ten quiet pairs, and a zma arm pairs with its own native', () => {
	const sample = (arm: string, rep: number, requestMs: number, load = 1) => ({
		config: 'default',
		site: 'stock',
		workload: 'front',
		arm,
		rep,
		requestMs,
		ok: true,
		loadStart: [load],
		loadEnd: [load]
	});
	const quiet: ReturnType<typeof sample>[] = [];
	for (let rep = 1; rep <= 10; rep++)
		quiet.push(
			sample('native', rep, 100),
			sample('bcd', rep, 180),
			sample('native-zma', rep, 200),
			sample('r-all-zma', rep, 300)
		);
	const bcd = routeTau(quiet, 'stock', 'front', 'bcd')!;
	expect([bcd.tau, bcd.n, bcd.claimGrade, bcd.meetsGate]).toEqual([0.8, 10, true, true]);
	expect(bcd.tauCi).toEqual([0.8, 0.8]);
	const zma = routeTau(quiet, 'stock', 'front', 'r-all-zma', 'native-zma')!;
	expect(zma.tau).toBe(0.5);
	const loud = quiet.map((r) => (r.rep === 3 && r.arm === 'bcd' ? { ...r, loadEnd: [6] } : r));
	const noisy = routeTau(loud, 'stock', 'front', 'bcd')!;
	expect([noisy.samplesAtLoadLimit, noisy.claimGrade, noisy.meetsGate]).toEqual([
		1,
		false,
		false
	]);
	const few = routeTau(
		quiet.filter((r) => r.rep <= 9),
		'stock',
		'front',
		'bcd'
	)!;
	expect([few.n, few.claimGrade]).toEqual([9, false]);
	const slow = quiet.map((r) => (r.arm === 'bcd' ? { ...r, requestMs: 400 } : r));
	expect(routeTau(slow, 'stock', 'front', 'bcd')!.meetsGate).toBe(false);
	const table = tauTable(
		[
			...quiet,
			{ ...quiet[0]!, arm: 'bcd', normalizedSha256: 'a' },
			{ ...quiet[1]!, normalizedSha256: 'b' }
		],
		['bcd', 'r-all-zma']
	);
	expect(table[0]!.renderHashesDistinct).toBe(2);
	expect(table.map((t) => [t.route, t.nativeN, t.nativeMedianMs])).toEqual([
		['stock:front', 10, 100]
	]);
});
