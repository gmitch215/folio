import { expect, test } from 'vitest';
import { summarizeBreakdown, summarizeMemory } from '../../scripts/analyze/breakdown.ts';
import { summarizeConcurrent } from '../../scripts/analyze/concurrent.ts';
import { overlapMs } from '../../scripts/probe/php-contexts.ts';

test('overlap counts only the time two or more intervals run at once', () => {
	expect(overlapMs([])).toBe(0);
	expect(overlapMs([{ startMs: 0, endMs: 10 }])).toBe(0);
	expect(
		overlapMs([
			{ startMs: 0, endMs: 10 },
			{ startMs: 10, endMs: 20 }
		])
	).toBe(0);
	expect(
		overlapMs([
			{ startMs: 0, endMs: 10 },
			{ startMs: 4, endMs: 20 },
			{ startMs: 6, endMs: 8 }
		])
	).toBe(6);
});

const cell = (arm: string, width: number, round: number, wallMs: number) => ({
	kind: 'sample',
	name: 'w',
	arm,
	width,
	round,
	wallMs,
	throughput: (width / wallMs) * 1000,
	processCpuMs: wallMs,
	threadCpuMs: Array(width).fill(100),
	latencyMs: Array(width).fill(wallMs),
	startSkewMs: 1,
	overlapMs: arm.endsWith('concurrent') ? 90 : 0,
	sha256: Array(width).fill('a'),
	rssBytes: 1,
	load: [1, 1, 1]
});

test('concurrent summary pairs each arm against its round and keeps the CPU sums', () => {
	const rows = [{ kind: 'environment' }];
	for (let round = 0; round < 3; round++)
		for (const arm of [
			'native-serial',
			'native-concurrent',
			'folio-serial',
			'folio-concurrent'
		])
			rows.push(cell(arm, 2, round, arm.endsWith('serial') ? 200 : 105) as any);
	const summary = summarizeConcurrent(rows as any, 'h');
	const w2: any = summary.names['w']!['w2'];
	expect(w2.paired.nativeConcurrentVsSerial.median).toBeCloseTo(200 / 105);
	expect(w2.paired.folioOverNativeConcurrentWall.median).toBe(1);
	expect(w2['native-concurrent'].aggregateThreadCpuMs.median).toBe(200);
	expect(w2['native-concurrent'].latencyMs.p95).toBe(105);
});

test('concurrent summary refuses samples whose outputs differ', () => {
	const bad = { ...cell('native-serial', 1, 0, 10), sha256: ['b'] };
	expect(() =>
		summarizeConcurrent(
			[{ kind: 'environment' }, cell('native-serial', 1, 1, 10), bad] as any,
			'h'
		)
	).toThrow(/outputs differ/);
});

test('breakdown splits the render and prices lazy compilation as cold minus warm', () => {
	const sample = (instance: number, wall: number) => ({
		kind: 'sample',
		mode: 'native',
		instance,
		sha256: 'a',
		renderWallMs: wall,
		sqlMs: 10,
		sqlCalls: 5,
		inflateMs: 50,
		inflateCalls: 7,
		inflateBytes: 100,
		renderThreadCpuMs: wall,
		renderProcessCpuMs: wall + 100,
		openMs: 1,
		boot: { seedMs: 1, phpBootMs: 2, drupalBootMs: 3 }
	});
	const rows = [{ kind: 'environment' }, sample(0, 900), sample(1, 800), sample(2, 800)];
	const summary: any = summarizeBreakdown(rows as any, 'h');
	expect(summary.modes.native.lazyCompileMs).toBe(100);
	expect(summary.modes.native.warm.phpExecutionMs).toBe(740);
	expect(summary.modes.native.warm.otherThreadCpuMs.median).toBe(100);
});

test('memory summary gives the marginal bytes of an extra context', () => {
	const row = (count: number, after: number) => ({
		kind: 'memory',
		what: 'cpu',
		mode: 'native',
		count,
		rssBeforeBytes: 100,
		rssAfterRunBytes: after,
		maxRssBytes: after,
		wasmMemoryBytes: [64],
		perContextOpenBytes: 0,
		perContextAfterRunBytes: 0
	});
	const summary: any = summarizeMemory([row(1, 300), row(4, 900)]);
	expect(summary['cpu-native'].marginalBytesPerExtraContext[4]).toBe((800 - 200) / 3);
});
