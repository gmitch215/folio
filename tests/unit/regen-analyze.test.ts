import { expect, test } from 'vitest';
import { spanBound, summarizeRegen } from '../../scripts/analyze/regen.ts';

const environment = { kind: 'environment', machine: 'synthetic', boots: [] };
const warmup = { kind: 'warmup', firstRenderMs: [100, 120] };
const oracle = {
	kind: 'oracle',
	perUrl: [
		{ url: '/', ms: 300, bytes: 1 },
		{ url: '/node/1', ms: 50, bytes: 1 },
		{ url: '/node/2', ms: 50, bytes: 1 },
		{ url: '/node/3', ms: 100, bytes: 1 }
	]
};

const sample = (round: number, width: number, wallMs: number, extra: object) => ({
	kind: 'sample',
	round,
	arm: width === 1 ? 'serial' : `regen-${width}`,
	width,
	pages: 4,
	wallMs,
	busyMs: [wallMs],
	pagesPerWorker: [4],
	processCpuMs: wallMs,
	load: [1, 0, 0],
	...extra
});

const rows = [
	environment,
	warmup,
	oracle,
	sample(0, 1, 500, {}),
	sample(1, 1, 500, {}),
	sample(0, 2, 250, { busyMs: [260, 240], pagesPerWorker: [2, 2], processCpuMs: 520 }),
	sample(1, 2, 300, { busyMs: [300, 200], pagesPerWorker: [2, 2], processCpuMs: 500 })
];

test('summarizeRegen pairs each arm with the serial sample of its round', () => {
	const summary = summarizeRegen(rows, 'h');
	const serial = summary.arms.serial as any;
	const regen = summary.arms['regen-2'] as any;
	expect(serial.speedupOverSerial.median).toBe(1);
	expect(regen.n).toBe(2);
	expect(regen.speedupOverSerial.min).toBeCloseTo(500 / 300);
	expect(regen.speedupOverSerial.max).toBe(2);
	expect(regen.processCpuOverSerial.median).toBeCloseTo(1.04);
	expect(regen.busyMaxOverMin.min).toBeCloseTo(260 / 240);
	expect(regen.busyMaxOverMin.max).toBeCloseTo(1.5);
	expect(regen.pagesPerWorkerMin.median).toBe(2);
	expect(summary.hash).toBe('h');
});

test('summarizeRegen reports the warmup, the front page and the oracle bound', () => {
	const summary = summarizeRegen(rows, 'h');
	const regen = summary.arms['regen-2'] as any;
	expect(summary.warmup.contexts).toBe(2);
	expect(summary.warmup.firstRenderMs.median).toBe(120);
	expect(summary.warmup.firstOverSteadyNode).toBeCloseTo(2.4);
	expect(summary.oracle.totalMs).toBe(500);
	expect(summary.oracle.frontMs).toBe(300);
	expect(summary.oracle.longest.url).toBe('/');
	expect(regen.oracleBoundSpeedup).toBeCloseTo(500 / 300);
	expect(summary.measuredSamples).toBe(4);
});

test('spanBound is the larger of the even share and the longest page', () => {
	expect(spanBound([300, 50, 50, 100], 2)).toBe(300);
	expect(spanBound([10, 10, 10, 10], 4)).toBe(10);
	expect(spanBound([10, 10, 10, 10], 1)).toBe(40);
});

test('summarizeRegen refuses a file without samples', () => {
	expect(() => summarizeRegen([environment, warmup, oracle], 'h')).toThrow('no samples');
});
