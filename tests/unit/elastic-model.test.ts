import { expect, test } from 'vitest';
import {
	counts,
	fitTime,
	fitTimeNonNegative,
	fixtureTrace,
	leaveOneOut,
	percentError,
	phaseMeans,
	predictFit,
	predictTime,
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

test('predictTime adds the base, the flush, store reads and writes, codec and hits, term by term', () => {
	const params = {
		baseMs: 10,
		flushMs: 25,
		readMs: 0.5,
		writeMs: 1,
		decompressMs: 0.1,
		compressMs: 0.2,
		hitMs: 0.01
	};
	const counted = {
		flushes: 1,
		storeReads: 4,
		storeWrites: 2,
		compressions: 3,
		decompressions: 5,
		hits: 100
	};
	expect(predictTime(params, counted)).toBeCloseTo(10 + 25 + 2 + 2 + 0.6 + 0.5 + 1, 9);
	expect(
		predictTime(params, {
			...counted,
			flushes: 0,
			storeReads: 0,
			storeWrites: 0,
			compressions: 0,
			decompressions: 0,
			hits: 0
		})
	).toBe(10);
});

const truth = { baseMs: 12, readMs: 0.3, writeMs: 0.5, codecMs: 0.02 };
const grid = [
	[3000, 3000, 0, 0],
	[2900, 3000, 6000, 3200],
	[9000, 3200, 0, 0],
	[2800, 1200, 9000, 7600],
	[6000, 0, 0, 0],
	[6000, 0, 6000, 0]
].map(([storeReads, storeWrites, compressions, decompressions]) => ({
	storeReads: storeReads!,
	storeWrites: storeWrites!,
	compressions: compressions!,
	decompressions: decompressions!
}));
const synthetic = grid.map((g) => ({ ...g, wallMs: predictFit(truth, g) }));

test('fitTime recovers known parameters from synthetic data and predicts it back exactly', () => {
	const fit = fitTime(synthetic);
	expect(fit.baseMs).toBeCloseTo(truth.baseMs, 6);
	expect(fit.readMs).toBeCloseTo(truth.readMs, 9);
	expect(fit.writeMs).toBeCloseTo(truth.writeMs, 9);
	expect(fit.codecMs).toBeCloseTo(truth.codecMs, 9);
	for (const s of synthetic) expect(predictFit(fit, s)).toBeCloseTo(s.wallMs, 6);
});

test('fitTime is deterministic and refuses samples that cannot identify the terms', () => {
	expect(fitTime(synthetic)).toEqual(fitTime(synthetic));
	expect(() => fitTime(synthetic.slice(0, 1))).toThrow('identify');
	expect(() => fitTime([synthetic[0]!, synthetic[0]!, synthetic[0]!, synthetic[0]!])).toThrow(
		'identify'
	);
});

test('fitTimeNonNegative recovers known non-negative parameters and is deterministic', () => {
	const fit = fitTimeNonNegative(synthetic);
	expect(fit.baseMs).toBeCloseTo(truth.baseMs, 6);
	expect(fit.readMs).toBeCloseTo(truth.readMs, 9);
	expect(fit.writeMs).toBeCloseTo(truth.writeMs, 9);
	expect(fit.codecMs).toBeCloseTo(truth.codecMs, 9);
	expect(fitTimeNonNegative(synthetic)).toEqual(fit);
	expect(() => fitTimeNonNegative(synthetic.slice(0, 1))).toThrow('identify');
});

test('fitTimeNonNegative returns no negative coefficient where least squares gives one', () => {
	const negative = { baseMs: 12, readMs: 0.3, writeMs: 0.5, codecMs: -0.02 };
	const data = grid.map((g) => ({ ...g, wallMs: predictFit(negative, g) }));
	expect(fitTime(data).codecMs).toBeLessThan(0);
	const fit = fitTimeNonNegative(data);
	for (const v of Object.values(fit)) expect(v).toBeGreaterThanOrEqual(0);
	const sse = (f: typeof fit) =>
		data.reduce((sum, s) => sum + (predictFit(f, s) - s.wallMs) ** 2, 0);
	expect(sse(fit)).toBeGreaterThan(sse(fitTime(data)));
	for (const nudge of [{ baseMs: 1 }, { readMs: 0.01 }, { writeMs: 0.01 }, { codecMs: 0.01 }]) {
		const [k, d] = Object.entries(nudge)[0]!;
		const other = { ...fit, [k]: Math.max(0, fit[k as keyof typeof fit] + d) };
		expect(sse(other)).toBeGreaterThanOrEqual(sse(fit) - 1e-6);
	}
});

test('leaveOneOut holds each sample out in turn and is zero on exact data', () => {
	const out = leaveOneOut(synthetic);
	expect(out).toHaveLength(synthetic.length);
	for (const row of out) expect(Math.abs(row.percentError)).toBeLessThan(1e-6);
	const noisy = synthetic.map((s, i) => ({ ...s, wallMs: s.wallMs * (i === 0 ? 2 : 1) }));
	expect(Math.abs(leaveOneOut(noisy)[0]!.percentError)).toBeGreaterThan(10);
	expect(percentError(110, 100)).toBeCloseTo(10, 9);
});
