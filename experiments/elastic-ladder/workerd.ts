import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle, bundleModules } from '../lib/bundle.ts';
import { makeLadderCtx, runCell } from './driver.ts';
import type { LadderConfig, Variant } from './plan.ts';
import { LIVE, VARIANTS, cellsFor, priceCell } from './plan.ts';
import { WORKLOADS } from './programs.ts';

// usage: node experiments/elastic-ladder/workerd.ts [pages] [rowKiB]
// the bundle on local workerd, real SQLite and real Wasm imports, no network; prints price against counters
const pages = Number(process.argv[2] ?? 96);
const rowKiB = Number(process.argv[3] ?? 64);
const config: LadderConfig = {
	...LIVE,
	name: 'workerd',
	pages,
	caps: { rows: 10_000_000, requests: 10_000_000, planningDailyRows: 10_000_000 }
};
const secret = 'local-only';
const mf = new Miniflare(
	convertV4MiniflareOptions({
		workers: [
			{
				name: 'ladder',
				...bundleModules(bundle('elastic-ladder')),
				compatibilityDate: '2026-10-20',
				bindings: { SECRET: secret },
				durableObjects: { EXEC: { className: 'Executor', useSQLite: true } }
			}
		]
	})
);
const fetchImpl = ((input: any, init?: any) =>
	mf.dispatchFetch(String(input), init)) as unknown as typeof fetch;
const rows: object[] = [];
try {
	const variants: Variant[] = Object.values(VARIANTS).map((v) => ({
		...v,
		frames: 16,
		cold: v.cold ? 32 : 0,
		rowBytes: rowKiB * 1024
	}));
	for (const cell of cellsFor(variants, WORKLOADS, pages)) {
		const price = priceCell(cell, config);
		const ctx = await makeLadderCtx({
			config,
			planned: price,
			base: 'http://ladder.local',
			secret,
			fetchImpl,
			rawFile: pathToFileURL(join(tmpdir(), `folio-ladder-workerd-${Date.now()}.jsonl`)),
			log: () => {}
		});
		const result = await runCell(ctx, cell, config);
		rows.push({
			variant: cell.variant.name,
			workload: cell.workload,
			exact: result.exact,
			failure: result.failure,
			price: {
				write: price.writeRows,
				schema: price.schemaRows,
				cleanup: price.cleanupRows,
				read: price.readRows,
				requests: price.requests + price.cleanupRequests
			},
			counters: {
				write: ctx.counters.seen.writeRows,
				schema: ctx.counters.seen.schemaRows,
				cleanup: ctx.counters.seen.cleanupRows,
				read: ctx.readRows.value,
				requests: ctx.counters.seen.requests
			}
		});
	}
} finally {
	await mf.dispose();
}
console.log(JSON.stringify(rows, null, 1));
