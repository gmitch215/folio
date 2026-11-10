import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Seen } from '../elastic-limits/counters.ts';
import { makeLadderCtx, runCell } from './driver.ts';
import { BASE, SECRET, localWorld } from './local.ts';
import type { Cell, LadderConfig, LadderPrice, Variant } from './plan.ts';
import { LIVE, VARIANTS, cellsFor, priceCell } from './plan.ts';
import { FRAMES, type Prediction } from './predictions.ts';
import type { Workload } from './programs.ts';
import { PAGE, WORKLOADS, basePage } from './programs.ts';
import type { RunConfig } from './service.ts';

// usage: node experiments/elastic-ladder/sweep.ts OUTDIR PREDICTIONS.json [pages]
// OUTDIR gets sweep-raw.json, sweep-summary.json and price-check.json

const out = resolve(process.argv[2] ?? '.');
const predictionsFile = process.argv[3];
if (!predictionsFile) throw new Error('usage: sweep.ts OUTDIR PREDICTIONS.json [pages]');
const pages = Number(process.argv[4] ?? 3072);
const config: LadderConfig = {
	...LIVE,
	name: 'local',
	pages,
	caps: { rows: 10_000_000, requests: 10_000_000, planningDailyRows: 10_000_000 }
};
const memo = new Map<number, Uint8Array>();
const makePage = (page: number, bytes: Uint8Array) => {
	let base = memo.get(page);
	if (!base) {
		base = new Uint8Array(PAGE);
		basePage(page, base);
		memo.set(page, base);
	}
	bytes.set(base);
};
const quiet = () => {};
let files = 0;

async function runOne(cell: Cell, overrides: Partial<RunConfig> = {}) {
	// codec timings here are local harness timings, not platform figures
	const world = localWorld({ makePage, timer: () => performance.now() });
	const price = priceCell(cell, config);
	const ctx = await makeLadderCtx({
		config,
		planned: price,
		base: BASE,
		secret: SECRET,
		fetchImpl: world.fetchImpl,
		rawFile: pathToFileURL(
			join(tmpdir(), `folio-ladder-sweep-${process.pid}-${files++}.jsonl`)
		),
		log: quiet
	});
	const result = await runCell(ctx, cell, config, overrides);
	return { result, seen: ctx.counters.seen, readRows: ctx.readRows.value, price };
}

const variantOf = (frames: number, cold: number, quantum = Infinity): Variant => ({
	name: cold ? 'v6' : 'v4',
	frames,
	cold,
	rowBytes: PAGE,
	quantum
});
const cellOf = (workload: Workload, variant: Variant): Cell => ({
	variant,
	workload,
	pages,
	repeat: 0
});

const predicted: Prediction[] = JSON.parse(readFileSync(predictionsFile, 'utf8')).rows;
const compared = [
	'frameHits',
	'coldHits',
	'storeReads',
	'storeWrites',
	'compressions',
	'decompressions',
	'coldEvictions'
] as const;

let exactAll = true;

// 1. predictions against the executor
const matches: object[] = [];
for (const p of predicted.filter((row) => row.pages === pages)) {
	const r = await runOne(cellOf(p.workload, variantOf(p.frames, p.cold)));
	const stats = r.result.stats as Record<string, number>;
	const miss = compared.filter((key) => stats[key] !== p[key]);
	exactAll &&= r.result.exact;
	matches.push({
		workload: p.workload,
		frames: p.frames,
		cold: p.cold,
		exact: r.result.exact,
		matches: miss.length === 0,
		miss: miss.map((key) => ({ key, predicted: p[key], measured: stats[key] })),
		measured: Object.fromEntries(compared.map((key) => [key, stats[key]])),
		coldPeakBytes: stats.coldPeakBytes,
		pooledPages: r.result.pooled,
		poolRatioAtEnd: r.result.pooled ? (r.result.pooled * PAGE) / stats.coldBytes! : null,
		compressUsPerPage: stats.compressions
			? (stats.compressMs! * 1000) / stats.compressions
			: null,
		decompressUsPerPage: stats.decompressions
			? (stats.decompressMs! * 1000) / stats.decompressions
			: null,
		countersEqualPrice: countersEqual(r.seen, r.readRows, r.price)
	});
	console.log(JSON.stringify(matches.at(-1)!).slice(0, 160));
}

function countersEqual(seen: Seen, readRows: number, price: LadderPrice) {
	return (
		seen.writeRows === price.writeRows &&
		seen.schemaRows === price.schemaRows &&
		seen.cleanupRows === price.cleanupRows &&
		seen.requests === price.requests + price.cleanupRequests &&
		seen.internal === price.internal &&
		readRows === price.readRows
	);
}

// 2. exactness under every eviction pattern: five seeds, the E3 frame counts, forced eviction, continuation
const stress: object[] = [];
const stressCell = async (
	label: string,
	workload: Workload,
	frames: number,
	cold: number,
	overrides: Partial<RunConfig>,
	quantum = Infinity
) => {
	const r = await runOne(cellOf(workload, variantOf(frames, cold, quantum)), overrides);
	exactAll &&= r.result.exact;
	stress.push({
		label,
		workload,
		frames,
		cold,
		...overrides,
		quantum: Number.isFinite(quantum) ? quantum : null,
		exact: r.result.exact,
		failure: r.result.failure,
		requests: r.result.requests
	});
};
for (const workload of WORKLOADS)
	for (const frames of FRAMES)
		for (const cold of [0, 256]) {
			for (const randomSeed of [1, 2, 3, 4, 5])
				await stressCell('random', workload, frames, cold, { randomSeed });
			await stressCell('continue', workload, frames, cold, {}, 999);
		}
for (const workload of WORKLOADS)
	for (const cold of [0, 256])
		await stressCell('evict-every', workload, 4, cold, { evictEvery: true });
console.log(JSON.stringify({ stressCells: stress.length, exactAll }));

// 3. the price table against the counters of a full local run at the live config
const priceRows: object[] = [];
const priced = [...Object.values(VARIANTS), { ...VARIANTS.v6!, quantum: 999 }];
for (const cell of cellsFor(priced, WORKLOADS, pages)) {
	const r = await runOne(cell);
	const want = priceCell(cell, config);
	priceRows.push({
		variant: cell.variant.name,
		quantum: Number.isFinite(cell.variant.quantum) ? cell.variant.quantum : null,
		workload: cell.workload,
		price: {
			writeRows: want.writeRows,
			schemaRows: want.schemaRows,
			cleanupRows: want.cleanupRows,
			readRows: want.readRows,
			requests: want.requests + want.cleanupRequests,
			internal: want.internal
		},
		counters: {
			writeRows: r.seen.writeRows,
			schemaRows: r.seen.schemaRows,
			cleanupRows: r.seen.cleanupRows,
			readRows: r.readRows,
			requests: r.seen.requests,
			internal: r.seen.internal
		},
		equal: countersEqual(r.seen, r.readRows, want),
		exact: r.result.exact
	});
	exactAll &&= r.result.exact;
}

const summary = {
	schema: 'folio.ladder-sweep.v1',
	pages,
	node: process.version,
	allExact: exactAll,
	predictionRows: matches.length,
	predictionMatches: matches.filter((m: any) => m.matches).length,
	predictionMisses: matches.filter((m: any) => !m.matches),
	countersEqualPriceEverywhere: matches.every((m: any) => m.countersEqualPrice),
	stressCells: stress.length,
	stressAllExact: stress.every((s: any) => s.exact),
	priceRows: priceRows.length,
	priceEqualsCounters: priceRows.every((r: any) => r.equal)
};
writeFileSync(join(out, 'sweep-raw.json'), JSON.stringify({ matches, stress }, null, '\t') + '\n', {
	flag: 'wx'
});
writeFileSync(join(out, 'sweep-summary.json'), JSON.stringify(summary, null, '\t') + '\n', {
	flag: 'wx'
});
writeFileSync(join(out, 'price-check.json'), JSON.stringify(priceRows, null, '\t') + '\n', {
	flag: 'wx'
});
console.log(JSON.stringify(summary));
