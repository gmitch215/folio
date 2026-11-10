import binaryen from 'binaryen';
import { expect, test } from 'vitest';
import {
	TranslateRefusal,
	initTable,
	translate,
	translationHost,
	type TranslateOptions
} from '../../scripts/research/elastic-translate.ts';
import {
	durationTable,
	ladderRenders
} from '../../scripts/research/translation-duration-summary.ts';
import { hotSet, regionOf, spanReport } from '../../scripts/research/translation-span.ts';
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
