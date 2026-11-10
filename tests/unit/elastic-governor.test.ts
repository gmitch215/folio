import { expect, test } from 'vitest';
import {
	CENSUS_WINDOW_PAGES,
	LEAVE,
	PagingBudgetExceeded,
	budgetFor,
	createGovernor,
	replay,
	runGoverned,
	type GovernorConfig,
	type TraceRun
} from '../../scripts/research/elastic-governor.ts';

const storage = { fillMs: 0.11, evictMs: 0.29 };

function config(fields: Partial<GovernorConfig> = {}): GovernorConfig {
	return { capSeconds: 1, wallCapSeconds: 15, tau: 0, tiers: { storage }, ...fields };
}

function run(events: Uint32Array, fields: Partial<TraceRun> = {}): TraceRun {
	return {
		events,
		budgetPages: 64,
		windowPages: CENSUS_WINDOW_PAGES,
		nativeMs: 1000,
		tier: 'storage',
		config: config(),
		...fields
	};
}

// census-format events from a plain access list; the window is the exact top-W recency list.
function censusEvents(pages: number[], windowPages = CENSUS_WINDOW_PAGES): Uint32Array {
	const out: number[] = [];
	const recent: number[] = [];
	for (const page of pages) {
		const at = recent.indexOf(page);
		if (at >= 0) {
			recent.splice(at, 1);
			recent.unshift(page);
			continue;
		}
		out.push(page * 2);
		recent.unshift(page);
		if (recent.length > windowPages) out.push((LEAVE | recent.pop()!) >>> 0);
	}
	return Uint32Array.from(out);
}

function thrown(fn: () => void): PagingBudgetExceeded {
	try {
		fn();
	} catch (error) {
		if (error instanceof PagingBudgetExceeded) return error;
		throw error;
	}
	throw new Error('expected PagingBudgetExceeded');
}

const cyclic = Array.from({ length: 10 * 512 }, (_, i) => i % 512);

test('a thrash trace aborts at its delta cap, before the trace ends', () => {
	const cap = 0.5;
	const result = runGoverned(run(censusEvents(cyclic), { config: config({ capSeconds: cap }) }));
	const error = result.aborted!;
	expect(error.reason).toBe('delta');
	expect(error.projectedSeconds).toBeGreaterThanOrEqual(cap * 0.95);
	expect(error.projectedSeconds).toBeLessThanOrEqual(cap * 1.05);
	expect(result.atEvent).toBeLessThan(censusEvents(cyclic).length);
});

test('the abort is a typed error, distinct from a trap or a platform kill', () => {
	const result = runGoverned(run(censusEvents(cyclic), { config: config({ capSeconds: 0.5 }) }));
	const error = result.aborted!;
	expect(error).toBeInstanceOf(PagingBudgetExceeded);
	expect(error).toBeInstanceOf(Error);
	expect(error.code).toBe('PAGING_BUDGET_EXCEEDED');
	expect(error.name).toBe('PagingBudgetExceeded');
	expect(error).not.toBeInstanceOf(WebAssembly.RuntimeError);
	expect(error.capSeconds).toBe(0.5);
	expect(error.counters.misses.storage).toBeGreaterThan(0);
});

test('a trace at 99% of its cap is never aborted', () => {
	const events = censusEvents(Array.from({ length: 100 }, (_, i) => i));
	const total = replay(run(events)).deltaSeconds;
	expect(total).toBeGreaterThan(0);
	const result = runGoverned(run(events, { config: config({ capSeconds: total / 0.99 }) }));
	expect(result.aborted).toBeUndefined();
	expect(result.counters.deltaSeconds).toBeCloseTo(total, 12);
});

test('governor counters equal an independent replay of the same trace', () => {
	let seed = 7;
	const pages = Array.from({ length: 4000 }, () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed % 300;
	});
	const r = run(censusEvents(pages), {
		nativeMs: 250,
		config: config({ capSeconds: Infinity, wallCapSeconds: Infinity, tau: 1.86 })
	});
	const governed = runGoverned(r);
	const independent = replay(r);
	expect(independent.evictions.storage).toBeGreaterThan(0);
	expect(governed.aborted).toBeUndefined();
	expect(governed.counters.misses).toEqual(independent.misses);
	expect(governed.counters.evictions).toEqual(independent.evictions);
	expect(governed.counters.deltaSeconds).toBeCloseTo(independent.deltaSeconds, 9);
	expect(governed.counters.pagingSeconds).toBeCloseTo(independent.pagingSeconds, 9);
});

test('window hits never miss, so the window keeps exact LRU order', () => {
	const pages = [...Array(33).keys(), 0];
	const r = run(censusEvents(pages), { budgetPages: 33 });
	expect(replay(r).misses.storage).toBe(33);
	expect(replay(r).evictions.storage).toBe(0);
});

test('the wall cap fires on a slow native run with little paging', () => {
	let now = 0;
	const gov = createGovernor(config({ ...budgetFor(16) }), () => now);
	now = 16000;
	const error = thrown(() => gov.check(16000));
	expect(error.reason).toBe('wall');
	expect(error.projectedSeconds).toBe(16);
});

test('the 2 s plus native rule fires on a long native run with heavy paging', () => {
	let now = 0;
	const gov = createGovernor(
		config({ ...budgetFor(10), tiers: { storage: { fillMs: 1, evictMs: 0 } } }),
		() => now
	);
	for (let i = 0; i < 12001; i++) gov.onMiss('storage');
	now = 10000 + 12001;
	const error = thrown(() => gov.check(10000));
	expect(error.reason).toBe('delta');
	expect(error.projectedSeconds).toBeCloseTo(12.001, 9);
});

test('the translation tax alone can trip the delta cap', () => {
	let now = 0;
	const gov = createGovernor(config({ ...budgetFor(10), tau: 1.86 }), () => now);
	now = 10000;
	expect(thrown(() => gov.check(10000)).reason).toBe('delta');
});

test('zero misses cost only the translation tax and never abort below the cap', () => {
	const result = runGoverned(
		run(new Uint32Array(0), { nativeMs: 500, config: config({ tau: 1 }) })
	);
	expect(result.aborted).toBeUndefined();
	expect(result.counters.misses.storage).toBe(0);
	expect(result.counters.deltaSeconds).toBeCloseTo(0.5, 12);
});

test('a clock that does not advance never trips the wall cap', () => {
	const gov = createGovernor(config(), () => 0);
	for (let i = 0; i < 5; i++) {
		gov.onMiss('storage');
		gov.check(1000 * i);
	}
	expect(gov.counters().misses.storage).toBe(5);
});

test('a clock that goes backwards, or reports NaN, fails closed with a typed error', () => {
	let now = 100;
	const gov = createGovernor(config(), () => now);
	gov.check(0);
	now = 50;
	expect(thrown(() => gov.check(0)).reason).toBe('clock');
	now = Number.NaN;
	expect(thrown(() => gov.check(0)).reason).toBe('clock');
});

test('a negative cap is rejected at construction, and unknown tiers throw', () => {
	expect(() => createGovernor(config({ capSeconds: -1 }), () => 0)).toThrow(RangeError);
	const gov = createGovernor(config(), () => 0);
	expect(() => gov.onMiss('pool')).toThrow(RangeError);
});

test('decode time is charged as paging cost', () => {
	const gov = createGovernor(config(), () => 0);
	gov.onDecode(250);
	expect(gov.counters().decodeMs).toBe(250);
	expect(gov.counters().pagingSeconds).toBeCloseTo(0.25, 12);
});
