import { parseRows, readRaw, resultsRoot, writeSummary, type Row } from './lib.ts';

// warm block cost summary and the early-launch bound, from php-blocks.ts rows
// usage: analyzeBlocks('20261022-blocks', 'mac-blocks.jsonl', 'summary.json')

// 1.6 ms per 6.3 MB from an earlier run; MB read as 10^6 bytes
const transferMsPerByte = 1.6 / 6.3e6;
// assumed fixed cost per launched block; not measured
const transferMsPerBlock = 0.5;
export const speedupThreshold = 1.2;
export const remoteContexts = [1, 2, 4, 8];
// blocks whose output depends on the request; S_ex leaves these out
export const requestPlugins = new Set([
	'system_main_block',
	'page_title_block',
	'local_tasks_block',
	'system_messages_block',
	'system_breadcrumb_block'
]);

export interface BoundInput {
	/** median warm render wall, ms */
	T: number;
	/** sum of isolated block builds, ms */
	S: number;
	/** remote contexts */
	m: number;
	/** rendered bytes of the launched blocks */
	bytes: number;
	/** launched block count */
	blocks: number;
}

/** early launch at the select-variant event with perfect overlap: T_new = max(T - S, S / m) + X */
export function boundSpeedup({ T, S, m, bytes, blocks }: BoundInput) {
	const transferMs = bytes * transferMsPerByte + blocks * transferMsPerBlock;
	const tNew = Math.max(T - S, S / m) + transferMs;
	return { transferMs, tNew, speedup: T / tNew };
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function summarizeCount(rows: Row[], blocks: number) {
	const renders = rows.filter((row) => row.kind === 'render' && row.blocks === blocks);
	const isolated = rows.find((row) => row.kind === 'isolated' && row.blocks === blocks)!;
	const perBlock = (isolated.perBlock as Row[]).map((block) => ({
		id: block.id as string,
		plugin: block.plugin as string,
		bytes: block.bytes as number,
		medianMs: median(block.ms as number[]),
		repeats: (block.ms as number[]).length
	}));
	const bytesOf = (blocksList: typeof perBlock) => sum(blocksList.map((b) => b.bytes));
	const included = perBlock.filter((b) => !requestPlugins.has(b.plugin));
	const S = sum(perBlock.map((b) => b.medianMs));
	const sExcluding = sum(included.map((b) => b.medianMs));
	const T = median(renders.map((r) => r.wallMs as number));
	const bound = (s: number, list: typeof perBlock) =>
		remoteContexts.map((m) => ({
			m,
			...boundSpeedup({
				T,
				S: s,
				m,
				bytes: bytesOf(list),
				blocks: list.length
			})
		}));
	const plugins: Record<string, number> = {};
	for (const block of perBlock) plugins[block.plugin] = (plugins[block.plugin] ?? 0) + 1;
	return {
		blocks,
		n: renders.length,
		wallMs: median(renders.map((r) => r.wallMs as number)),
		variantMs: median(renders.map((r) => r.variantMs as number)),
		responseMs: median(renders.map((r) => r.responseMs as number)),
		eventToResponseMs: median(renders.map((r) => r.eventToResponseMs as number)),
		renderWriteTables: [...new Set(renders.flatMap((r) => r.writeTables as string[]))].sort(),
		isolatedWriteTables: isolated.writeTables as string[],
		enabledBlocks: perBlock.length,
		launchedBytes: bytesOf(perBlock),
		S,
		sExcluding,
		maxBlockMs: Math.max(...perBlock.map((b) => b.medianMs)),
		plugins,
		perBlock,
		bound: bound(S, perBlock),
		boundExcludingRequest: bound(sExcluding, included)
	};
}

export function summarizeBlocks(rows: Row[]) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const counts = [...new Set(rows.filter((row) => row.kind === 'fixture').map((r) => r.blocks))];
	const fixtures = counts.map((blocks) => summarizeCount(rows, blocks as number));
	const base = fixtures.find((f) => f.blocks === 0)!;
	const differential = fixtures
		.filter((f) => f.blocks > 0)
		.map((f) => ({ blocks: f.blocks, perBlockMs: (f.wallMs - base.wallMs) / f.blocks }));
	// the isolated sum can exceed the in-page increment; this S takes the block share from the differential
	const withDifferential = fixtures.map((f) => ({
		...f,
		boundDifferential: remoteContexts.map((m) => ({
			m,
			...boundSpeedup({
				T: f.wallMs,
				S: f.wallMs - base.wallMs + base.S,
				m,
				bytes: f.launchedBytes,
				blocks: f.enabledBlocks
			})
		}))
	}));
	const largest = (key: 'bound' | 'boundExcludingRequest' | 'boundDifferential') =>
		Object.fromEntries(
			remoteContexts.map((m) => {
				const passing = withDifferential.filter((f) =>
					f[key].some((b) => b.m === m && b.speedup > speedupThreshold)
				);
				return [m, passing.length ? Math.max(...passing.map((f) => f.blocks)) : null];
			})
		);
	return {
		machine: environment.machine,
		node: environment.node,
		cpu: environment.cpu,
		theme: environment.theme,
		modules: environment.modules,
		regions: environment.regions,
		blockPlugins: environment.blockPlugins,
		load: environment.load,
		counts: withDifferential.map(
			({ perBlock, bound, boundExcludingRequest, boundDifferential, ...rest }) => rest
		),
		differential,
		bound: Object.fromEntries(withDifferential.map((f) => [f.blocks, f.bound])),
		boundExcludingRequest: Object.fromEntries(
			withDifferential.map((f) => [f.blocks, f.boundExcludingRequest])
		),
		boundDifferential: Object.fromEntries(
			withDifferential.map((f) => [f.blocks, f.boundDifferential])
		),
		largestBlocksAboveThreshold: {
			all: largest('bound'),
			excludingRequest: largest('boundExcludingRequest'),
			differential: largest('boundDifferential')
		},
		isolated: Object.fromEntries(withDifferential.map((f) => [f.blocks, f.perBlock]))
	};
}

export function analyzeBlocks(set: string, file: string) {
	const root = resultsRoot(set);
	writeSummary(root, summarizeBlocks(parseRows(readRaw(root, file))));
}
