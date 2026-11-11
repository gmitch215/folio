import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { configOf, makeLadderCtx, runCell } from '../../experiments/elastic-ladder/driver.ts';
import { dryRun, liveCredentials, parse, ready } from '../../experiments/elastic-ladder/live.ts';
import { BASE, SECRET, localWorld } from '../../experiments/elastic-ladder/local.ts';
import type { Cell, LadderConfig, Variant } from '../../experiments/elastic-ladder/plan.ts';
import { LIVE, expectedFor, modelOps, priceCell } from '../../experiments/elastic-ladder/plan.ts';
import type { Workload } from '../../experiments/elastic-ladder/programs.ts';
import { PAGE, WORKLOADS, basePage } from '../../experiments/elastic-ladder/programs.ts';
import { simulateTiers } from '../../scripts/research/elastic-model.ts';

const dir = mkdtempSync(join(tmpdir(), 'folio-elastic-ladder-day3-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the approved path takes the FOLIO pair before the FREE pair', () => {
	const free = { FREE_CLOUDFLARE_ACCOUNT_ID: 'a-free', FREE_CLOUDFLARE_API_TOKEN: 't-free' };
	const picked = { FOLIO_CLOUDFLARE_ACCOUNT_ID: 'a-sel', FOLIO_CLOUDFLARE_API_TOKEN: 't-sel' };
	expect(liveCredentials(picked).account).toBe('a-sel');
	expect(liveCredentials({ ...free, ...picked }).account).toBe('a-sel');
	expect(liveCredentials(free).account).toBe('a-free');
	expect(() => liveCredentials({})).toThrow('set FOLIO_CLOUDFLARE_ACCOUNT_ID');
});

const open = { rows: 1e9, requests: 1e9, planningDailyRows: 1e9 };
const configFor = (pages: number): LadderConfig => ({ ...LIVE, name: 'test', pages, caps: open });
const v4: Variant = { name: 'v4', frames: 4, cold: 0, rowBytes: PAGE, quantum: Infinity };
const cellOf = (pages: number): Cell => ({
	variant: v4,
	workload: 'dense',
	pages,
	repeat: 0
});

async function ctxFor(cell: Cell, fetchImpl: typeof fetch) {
	const config = configFor(cell.pages);
	const records: any[] = [];
	const ctx = await makeLadderCtx({
		config,
		planned: priceCell(cell, config),
		base: BASE,
		secret: SECRET,
		fetchImpl,
		rawFile: pathToFileURL(join(dir, 'raw.jsonl')),
		log: () => {}
	});
	ctx.sink = async (record) => {
		records.push(record);
	};
	return { ctx, config, records };
}

// #region failure records

test('a failed call records the status line, the platform headers and both ends of the body', async () => {
	const body = `<html>${'h'.repeat(3000)}error code: 1042${'t'.repeat(3000)}</html>`;
	const cell = cellOf(24);
	const { ctx, config, records } = await ctxFor(
		cell,
		async () =>
			new Response(body, {
				status: 404,
				statusText: 'Not Found',
				headers: {
					'cf-ray': '8abc-EWR',
					'content-type': 'text/html; charset=UTF-8',
					'set-cookie': 'a=1'
				}
			})
	);
	await runCell(ctx, cell, config);
	const init = records.find((r) => r.op === 'init');
	expect(init.statusLine).toBe('404 Not Found');
	expect(init.headers).toEqual({
		'cf-ray': '8abc-EWR',
		'content-type': 'text/html; charset=UTF-8'
	});
	expect(init.bodyChars).toBe(body.length);
	expect(init.bodyHead).toBe(body.slice(0, 1024));
	expect(init.bodyTail).toBe(body.slice(-1024));
	expect(init.bodyTail.endsWith('</html>')).toBe(true);
	expect(init.error).toBe(body.slice(0, 8192));
});

test('a call that returns 200 records its status line and headers and no body ends', async () => {
	const world = localWorld({ makePage: (page, out) => basePage(page, out) });
	const cell = cellOf(24);
	const { ctx, config, records } = await ctxFor(cell, world.fetchImpl);
	const result = await runCell(ctx, cell, config);
	expect(result.exact).toBe(true);
	const client = records.filter((r) => r.level === 'client');
	expect(client.every((r) => r.statusLine.startsWith('200'))).toBe(true);
	expect(client.every((r) => r.headers['x-front-colo'] === 'LOCAL')).toBe(true);
	expect(client.some((r) => 'bodyHead' in r)).toBe(false);
});

test('the ready wait records its poll count, elapsed time and last status', async () => {
	const statuses = [503, 502, 200];
	const { ctx, records } = await ctxFor(
		cellOf(24),
		async () => new Response('', { status: statuses.shift()! })
	);
	await ready({ sleep: async () => {} } as any, ctx);
	const line = records.find((r) => r.level === 'ready');
	expect(line).toMatchObject({ polls: 3, ok: true, lastStatus: 200 });
	expect(line.elapsedMs).toBeGreaterThanOrEqual(0);
	expect(ctx.counters.retries).toBe(2);
});

test('a ready wait that gives up still records its polls', async () => {
	const { ctx, records } = await ctxFor(
		cellOf(24),
		async () => new Response('', { status: 530 })
	);
	await expect(ready({ sleep: async () => {} } as any, ctx, 4)).rejects.toThrow(/ready/);
	expect(records.find((r) => r.level === 'ready')).toMatchObject({
		polls: 4,
		ok: false,
		lastStatus: 530
	});
});

test('a ready streak counts consecutive successes and a failure resets it', async () => {
	const statuses = [200, 200, 503, 200, 200, 200];
	const sleeps: number[] = [];
	const { ctx, records } = await ctxFor(
		cellOf(24),
		async () => new Response('', { status: statuses.shift()! })
	);
	await ready({ sleep: async (ms: number) => void sleeps.push(ms) } as any, ctx, 30, {
		streak: 3,
		settle: 0
	});
	expect(records.find((r) => r.level === 'ready')).toMatchObject({ polls: 6, ok: true });
	expect(statuses).toEqual([]);
	expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
});

test('a ready settle waits the stated time after the first ready answer and before init', async () => {
	const sleeps: number[] = [];
	const { ctx, records } = await ctxFor(
		cellOf(24),
		async () => new Response('', { status: 200 })
	);
	await ready({ sleep: async (ms: number) => void sleeps.push(ms) } as any, ctx, 30, {
		streak: 1,
		settle: 5000
	});
	expect(sleeps).toEqual([5000]);
	expect(records.find((r) => r.level === 'ready')).toMatchObject({ polls: 1, ok: true });
});

test('the default ready hold waits on nothing once ready answers', async () => {
	const sleeps: number[] = [];
	const { ctx } = await ctxFor(cellOf(24), async () => new Response('', { status: 200 }));
	await ready({ sleep: async (ms: number) => void sleeps.push(ms) } as any, ctx);
	expect(sleeps).toEqual([]);
});

// #endregion

// #region V4e

const makePage = (page: number, out: Uint8Array) => basePage(page, out);
const v4e = (frames: number): Variant => ({
	name: 'v4e',
	frames,
	cold: 0,
	rowBytes: PAGE,
	quantum: Infinity,
	ephemeral: true
});

async function runLocal(workload: Workload, variant: Variant, pages: number) {
	const cell: Cell = { variant, workload, pages, repeat: 0 };
	const world = localWorld({ makePage });
	const { ctx, config } = await ctxFor(cell, world.fetchImpl);
	const result = await runCell(ctx, cell, config);
	return { result, ctx, world, price: priceCell(cell, config) };
}

test('the tier model skips the end-of-run write-back when ephemeral and counts what it dropped', () => {
	const dense = modelOps(expectedFor('dense', 96));
	expect(simulateTiers(dense, { frames: 96, cold: 0 })).toMatchObject({ storeWrites: 96 });
	expect(simulateTiers(dense, { frames: 96, cold: 0, ephemeral: true })).toMatchObject({
		storeReads: 0,
		storeWrites: 0,
		droppedDirty: 96,
		distinctStored: 0
	});
	const small = simulateTiers(dense, { frames: 8, cold: 0, ephemeral: true });
	const full = simulateTiers(dense, { frames: 8, cold: 0 });
	expect(small.storeReads).toBe(full.storeReads);
	expect(small.storeWrites).toBe(full.storeWrites - small.droppedDirty);
	expect(small.distinctStored).toBe(small.storeWrites);
	expect(() => simulateTiers(dense, { frames: 8, cold: 4, ephemeral: true })).toThrow(/cold/);
});

test('V4e is exact on every workload, evicts and reads back exactly, and its price equals its counters', async () => {
	for (const workload of WORKLOADS)
		for (const frames of [96, 8]) {
			const { result, ctx, price, world } = await runLocal(workload, v4e(frames), 96);
			expect(result.exact, `${workload} ${frames}`).toBe(true);
			expect(ctx.counters.seen.writeRows, `${workload} ${frames}`).toBe(price.writeRows);
			expect(ctx.counters.seen.cleanupRows, `${workload} ${frames}`).toBe(price.cleanupRows);
			expect(ctx.readRows.value, `${workload} ${frames}`).toBe(price.readRows);
			expect([...world.backends.values()][0]!.pages.size).toBe(0);
		}
	const resident = await runLocal('dense', v4e(96), 96);
	expect(resident.result.stats).toMatchObject({ storeReads: 0, storeWrites: 0 });
	const evicting = await runLocal('dense', v4e(8), 96);
	expect(evicting.result.stats).toMatchObject({ storeWrites: expect.any(Number) });
	expect((evicting.result.stats as any).storeWrites).toBeGreaterThan(0);
});

test('V4e leaves the pages it did not evict out of the store, V4 does not', async () => {
	const pages = 96;
	const keeps = async (variant: Variant) => {
		const cell: Cell = { variant, workload: 'dense', pages, repeat: 0 };
		const world = localWorld({ makePage });
		const cfg = encodeURIComponent(JSON.stringify(configOf(cell)));
		for (const op of ['init', 'run'])
			await world.fetchImpl(`${BASE}/obj/probe/${op}?cfg=${cfg}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${SECRET}` }
			});
		return world.backends.get('probe')!.pages.size;
	};
	expect(await keeps({ ...v4e(pages) })).toBe(0);
	expect(await keeps({ ...v4e(pages), ephemeral: false, name: 'v4' })).toBe(pages);
});

test('the price of V4e at the live size: no rows at 768 frames, verify reads only what the request stored', () => {
	const config = configFor(768);
	const cell = (frames: number): Cell => ({
		variant: v4e(frames),
		workload: 'dense',
		pages: 768,
		repeat: 0
	});
	expect(priceCell(cell(768), config)).toMatchObject({
		writeRows: 0,
		schemaRows: 2,
		cleanupRows: 0,
		readRows: 0
	});
	// the dense program loads clean pages last, so eviction alone stores every page
	const evicting = priceCell(cell(64), config);
	expect(evicting).toMatchObject({ writeRows: 768, cleanupRows: 768, readRows: 766 + 768 });
	const skewed = (frames: number, ephemeral: boolean) =>
		simulateTiers(modelOps(expectedFor('skewed', 96)), { frames, cold: 0, ephemeral });
	expect(skewed(8, true).droppedDirty).toBeGreaterThan(0);
	expect(skewed(8, true).storeWrites).toBe(
		skewed(8, false).storeWrites - skewed(8, true).droppedDirty
	);
});

test('--variants v4e parses as an ephemeral V4 and the flags still apply', () => {
	const one = parse([
		'--variants',
		'v4e',
		'--pages',
		'768',
		'--frames',
		'768',
		'--row-cap',
		'2000'
	]);
	expect(one.cells[0]!.variant).toMatchObject({ name: 'v4e', frames: 768, ephemeral: true });
	expect(dryRun(one.config, one.cells, {}).fitsRowCap).toBe(true);
});

// #endregion
