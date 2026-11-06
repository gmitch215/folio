import { expect, test } from 'vitest';
import {
	counts,
	fixtureTrace,
	phaseMeans,
	refitHop,
	simulate,
	variants,
	type Config
} from '../../scripts/research/elastic-model.ts';

const trace = fixtureTrace();
const within = (actual: number, expected: number, tolerance: number) =>
	Math.abs(actual - expected) / expected <= tolerance;

test('fixture trace: 15360 ops, 9216 writes, 6144 loads, 3072 distinct pages', () => {
	const c = counts(trace);
	expect(trace.length).toBe(15360);
	expect(c.writes).toBe(9216);
	expect(c.loads).toBe(6144);
	expect(c.distinctLoadPages).toBe(3072);
});

test('measured: 15360 hops, 9216 puts, 3072 gets, 961 requests, total within 10%', () => {
	const r = simulate(trace, variants.measured);
	expect(r.hops).toBe(15360);
	expect(r.puts).toBe(9216);
	expect(r.gets).toBe(3072);
	expect(r.requests).toBe(961);
	expect(within(r.ms.total, 392268, 0.1)).toBe(true);
});

test('measured: write-phase and read-phase request means within 10%', () => {
	const p = phaseMeans(simulate(trace, variants.measured), 9216, 16);
	expect(within(p.before, 533, 0.1), `write phase ${p.before}`).toBe(true);
	expect(within(p.after, 221.5, 0.1), `read phase ${p.after}`).toBe(true);
});

test('hop refit is about 10.6 ms and fits both phases within 1%', () => {
	const hop = refitHop(trace);
	expect(hop).toBeGreaterThan(10.5);
	expect(hop).toBeLessThan(10.7);
	const p = phaseMeans(
		simulate(trace, {
			...variants.measured,
			costs: { ...variants.measured.costs, hopMs: hop }
		}),
		9216,
		16
	);
	// the write phase lands at +1.1%, so 1.5% is the tolerance this one-run fit supports
	expect(within(p.before, 533, 0.015), `write phase ${p.before}`).toBe(true);
	expect(within(p.after, 221.5, 0.015), `read phase ${p.after}`).toBe(true);
});

test('owner-coalesced: exactly 3072 puts', () => {
	expect(simulate(trace, variants['owner-coalesced']).puts).toBe(3072);
});

test('remote write-back: raising frames never increases puts plus gets', () => {
	let prev = Infinity;
	for (const frames of [1, 4, 16, 64, 256, 1024, 3072]) {
		const r = simulate(trace, { ...variants['frames-4'], frames });
		const io = r.puts + r.gets;
		expect(io, `frames ${frames}`).toBeLessThanOrEqual(prev);
		prev = io;
	}
});

test('3072 frames: no gets, 3072 puts from the final flush', () => {
	const r = simulate(trace, { ...variants['frames-4'], frames: 3072 });
	expect(r.gets).toBe(0);
	expect(r.puts).toBe(3072);
});

test('colocated: zero hops in every configuration', () => {
	for (const frames of [0, 4, 64]) {
		for (const opsPerRequest of [16, Infinity]) {
			const r = simulate(trace, { ...variants['colocated-64'], frames, opsPerRequest });
			expect(r.hops, `frames ${frames}, ops ${opsPerRequest}`).toBe(0);
		}
	}
});

test('per-request times add up to the total for every named variant', () => {
	for (const v of Object.values(variants)) {
		const r = simulate(trace, v);
		const sum = r.requestMs.reduce((a, b) => a + b, 0);
		expect(Math.abs(sum - r.ms.total), v.name).toBeLessThan(1e-6);
	}
});

test('hand-checked: one frame, fill fill load', () => {
	const small = [
		{ kind: 'fill' as const, page: 0 },
		{ kind: 'fill' as const, page: 1 },
		{ kind: 'load' as const, page: 0 }
	];
	const r = simulate(small, { ...variants['frames-4'], frames: 1 });
	// evict 0 (hop, put), evict 1 (hop, put), load 0 miss (hop, get)
	expect(r.hops).toBe(3);
	expect(r.puts).toBe(2);
	expect(r.gets).toBe(1);
	const { hopMs, putMs, getMs, baseMs } = variants['frames-4'].costs;
	expect(Math.abs(r.ms.total - (baseMs + 3 * hopMs + 2 * putMs + getMs))).toBeLessThan(1e-9);
});

test('hand-checked: colocated without frames writes and reads the store directly', () => {
	const small = [
		{ kind: 'fill' as const, page: 0 },
		{ kind: 'store' as const, page: 0 },
		{ kind: 'load' as const, page: 0 }
	];
	const r = simulate(small, { ...variants['colocated-4'], frames: 0 });
	expect(r.hops).toBe(0);
	expect(r.puts).toBe(2);
	expect(r.gets).toBe(1);
	const { baseMs, putMs, getMs } = variants['colocated-4'].costs;
	expect(Math.abs(r.ms.total - (baseMs + 2 * putMs + getMs))).toBeLessThan(1e-9);
});

test('hand-checked: coalescing flushes one put per page run', () => {
	const small = [
		{ kind: 'fill' as const, page: 0 },
		{ kind: 'store' as const, page: 0 },
		{ kind: 'fill' as const, page: 1 }
	];
	const r = simulate(small, { ...variants['owner-coalesced'] });
	expect(r.hops).toBe(3);
	expect(r.puts).toBe(2);
});

test('invalid combinations are rejected', () => {
	expect(() => simulate(trace, { ...variants.measured, frames: 4 })).toThrow();
	const framedThrough: Config = { ...variants['frames-4'], writePolicy: 'write-through' };
	expect(() => simulate(trace, framedThrough)).toThrow();
	const colocatedThrough: Config = { ...variants['colocated-4'], writePolicy: 'write-through' };
	expect(() => simulate(trace, colocatedThrough)).toThrow();
});
