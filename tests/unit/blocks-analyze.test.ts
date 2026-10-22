import { expect, test } from 'vitest';
import { boundSpeedup, summarizeBlocks } from '../../scripts/analyze/blocks.ts';

test('bound takes the longer of the local rest and the remote share', () => {
	const local = boundSpeedup({ T: 100, S: 40, m: 2, bytes: 0, blocks: 0 });
	expect(local.tNew).toBe(60);
	expect(local.speedup).toBeCloseTo(100 / 60, 10);

	const remoteBound = boundSpeedup({ T: 100, S: 90, m: 1, bytes: 0, blocks: 0 });
	expect(remoteBound.tNew).toBe(90);
	expect(remoteBound.speedup).toBeCloseTo(100 / 90, 10);
});

test('transfer adds 1.6 ms per 6.3 MB and 0.5 ms per launched block', () => {
	const bound = boundSpeedup({ T: 100, S: 40, m: 2, bytes: 6.3e6, blocks: 2 });
	expect(bound.transferMs).toBeCloseTo(1.6 + 1.0, 10);
	expect(bound.tNew).toBeCloseTo(60 + 2.6, 10);
});

const environment = {
	kind: 'environment',
	machine: 'synthetic',
	node: 'v0',
	cpu: 'synthetic',
	theme: 'olivero',
	modules: [],
	regions: ['content'],
	blockPlugins: [],
	load: [0, 0, 0],
	counts: [0, 2]
};

const fixture = (blocks: number) => ({ kind: 'fixture', blocks, theme: 'olivero' });

const render = (blocks: number, wallMs: number) => ({
	kind: 'render',
	blocks,
	wallMs,
	variantMs: 1,
	responseMs: wallMs - 1,
	eventToResponseMs: wallMs - 2,
	writeTables: ['cache_render']
});

const isolated = (blocks: number, perBlock: object[]) => ({
	kind: 'isolated',
	blocks,
	writeTables: ['cache_render'],
	statements: 0,
	perBlock
});

const block = (id: string, plugin: string, bytes: number, ms: number[]) => ({
	id,
	plugin,
	bytes,
	ms
});

test('summary splits S with and without request-dependent blocks', () => {
	const rows = [
		environment,
		fixture(0),
		render(0, 10),
		render(0, 12),
		render(0, 11),
		isolated(0, [
			block('page_title_block', 'page_title_block', 50, [1, 1, 1]),
			block('system_main_block', 'system_main_block', 500, [5, 5, 5])
		]),
		fixture(2),
		render(2, 30),
		render(2, 32),
		render(2, 31),
		isolated(2, [
			block('page_title_block', 'page_title_block', 50, [1, 1, 1]),
			block('system_main_block', 'system_main_block', 500, [5, 5, 5]),
			block('folio_clone_1', 'system_powered_block', 100, [2, 2, 2]),
			block('folio_clone_2', 'system_powered_block', 100, [4, 4, 4])
		])
	];
	const summary = summarizeBlocks(rows);
	const two = summary.counts.find((c) => c.blocks === 2)!;
	expect(two.S).toBe(1 + 5 + 2 + 4);
	expect(two.sExcluding).toBe(2 + 4);
	expect(two.maxBlockMs).toBe(5);
	expect(summary.differential).toEqual([{ blocks: 2, perBlockMs: (31 - 11) / 2 }]);
	expect(summary.bound[2]!.find((b) => b.m === 1)!.tNew).toBeCloseTo(
		Math.max(31 - 12, 12) + (750 * 1.6) / 6.3e6 + 4 * 0.5,
		10
	);
	// differential S: T(2) - (T(0) - S(0)) = 31 - (11 - 6)
	expect(summary.boundDifferential[2]!.find((b) => b.m === 1)!.tNew).toBeCloseTo(
		26 + (750 * 1.6) / 6.3e6 + 4 * 0.5,
		10
	);
});
