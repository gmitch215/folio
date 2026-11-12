import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { makeLadderCtx, runCell } from '../../experiments/elastic-ladder/driver.ts';
import type { Pager as PagerType } from '../../experiments/elastic-ladder/engine.ts';
import { Pager, runSegment } from '../../experiments/elastic-ladder/engine.ts';
import { cleanupRun, dryRun, parse, runLive } from '../../experiments/elastic-ladder/live.ts';
import { BASE, SECRET, loadModules, localWorld } from '../../experiments/elastic-ladder/local.ts';
import type { Codec } from '../../experiments/elastic-ladder/lz4.ts';
import { lz4Codec } from '../../experiments/elastic-ladder/lz4.ts';
import type { Cell, LadderConfig, Variant } from '../../experiments/elastic-ladder/plan.ts';
import {
	LIVE,
	TINY,
	VARIANTS,
	cellsFor,
	checkVariant,
	expectedFor,
	modelOps,
	priceCell,
	priceCells,
	rowsOf
} from '../../experiments/elastic-ladder/plan.ts';
import { colocatedAgrees, predictions } from '../../experiments/elastic-ladder/predictions.ts';
import type { Workload } from '../../experiments/elastic-ladder/programs.ts';
import {
	PAGE,
	WORKLOADS,
	basePage,
	denseChecksum,
	denseOps,
	expectedOf
} from '../../experiments/elastic-ladder/programs.ts';
import type { RunConfig } from '../../experiments/elastic-ladder/service.ts';
import { ExecutorObject } from '../../experiments/elastic-ladder/service.ts';
import type { Sql } from '../../experiments/elastic-ladder/store.ts';
import { MemoryBackend, SqlBackend, VirtualClock } from '../../experiments/elastic-ladder/store.ts';
import { redact } from '../../experiments/elastic-limits/redact.ts';
import { fixtureTrace, simulate, simulateTiers } from '../../scripts/research/elastic-model.ts';

const dir = mkdtempSync(join(tmpdir(), 'folio-elastic-ladder-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pageMemo = new Map<number, Uint8Array>();
const makePage = (page: number, out: Uint8Array) => {
	let base = pageMemo.get(page);
	if (!base) {
		base = new Uint8Array(PAGE);
		basePage(page, base);
		pageMemo.set(page, base);
	}
	out.set(base);
};

// above the 256 frames of the largest E3 size, so every size evicts
const PAGES = 272;
const open = { rows: 1e9, requests: 1e9, planningDailyRows: 1e9 };
const configFor = (pages: number): LadderConfig => ({ ...LIVE, name: 'test', pages, caps: open });
const variantOf = (frames: number, cold: number, extra: Partial<Variant> = {}): Variant => ({
	name: cold ? 'v6' : 'v4',
	frames,
	cold,
	rowBytes: PAGE,
	quantum: Infinity,
	...extra
});

// a codec that keeps the raw page; the pool logic does not depend on the codec, and LZ4 is slow enough to crowd the gate
const rawCodec: Codec = {
	compress: (page) => page.slice(),
	decompress: (packed, dst) => dst.set(packed)
};

async function run(
	workload: Workload,
	variant: Variant,
	overrides: Partial<RunConfig> = {},
	pages = PAGES,
	codec: Codec | null = rawCodec
) {
	const config = configFor(pages);
	const cell: Cell = { variant, workload, pages, repeat: 0 };
	const world = localWorld({ makePage, codec: codec ?? undefined });
	const price = priceCell(cell, config);
	const ctx = await makeLadderCtx({
		config,
		planned: price,
		base: BASE,
		secret: SECRET,
		fetchImpl: world.fetchImpl,
		rawFile: pathToFileURL(join(dir, 'raw.jsonl')),
		log: () => {}
	});
	const result = await runCell(ctx, cell, config, overrides);
	return { result, ctx, price, world };
}

const same = (
	price: ReturnType<typeof priceCell>,
	ctx: Awaited<ReturnType<typeof run>>['ctx']
) => ({
	write: [ctx.counters.seen.writeRows, price.writeRows],
	schema: [ctx.counters.seen.schemaRows, price.schemaRows],
	cleanup: [ctx.counters.seen.cleanupRows, price.cleanupRows],
	read: [ctx.readRows.value, price.readRows],
	requests: [ctx.counters.seen.requests, price.requests + price.cleanupRequests],
	internal: [ctx.counters.seen.internal, price.internal]
});

test('the dense program is the fixture the Codex run used, and its trace is the model fixture', () => {
	expect(Array.from(denseOps(3072))).toEqual(
		fixtureTrace(3072).map((op) => op.page * 4 + { load: 0, store: 1, fill: 2 }[op.kind])
	);
	let expected = 0;
	for (let k = 0; k < 3072; k++)
		expected = Math.imul(expected, 31) ^ (Math.imul((k * 17) % 3072, 1664525) ^ 1013904223);
	expect(denseChecksum(3072)).toBe(expected);
	for (const w of WORKLOADS) expect(expectedOf(w, 96).ops.length).toBeGreaterThan(0);
	expect(expectedOf('dense', 3072).ops.length).toBe(15360);
	expect(expectedOf('skewed', 3072).ops.length).toBe(20000);
	expect(expectedOf('scan', 3072).ops.length).toBe(6144);
	expect(expectedOf('chase', 3072).ops.length).toBe(12288);
});

test('the tier model: a worked trace, the old colocated model, and the written predictions grid', () => {
	const ops = [
		{ kind: 'fill', page: 0 },
		{ kind: 'fill', page: 1 },
		{ kind: 'store', page: 0 },
		{ kind: 'load', page: 1 },
		{ kind: 'load', page: 2 }
	] as const;
	// one frame, no pool: fill 0; fill 1 evicts 0 dirty (write); store 0 evicts 1 dirty (write) and reads 0 from
	// the store; load 1 evicts 0 dirty (write) and reads 1; load 2 evicts clean 1 and reads 2; flush none dirty
	expect(simulateTiers(ops, { frames: 1, cold: 0 })).toMatchObject({
		storeReads: 3,
		storeWrites: 3,
		frameHits: 0
	});
	// with a pool of one: fills 1 and store 0 and load 1 hit the pool (two hits), load 2 reads the store,
	// its eviction of dirty 1 pushes dirty 0 out to the store, and the flush writes the last dirty page
	expect(simulateTiers(ops, { frames: 1, cold: 1 })).toMatchObject({
		coldHits: 2,
		compressions: 4,
		storeReads: 1,
		storeWrites: 2,
		coldEvictions: 1
	});
	expect(colocatedAgrees(384)).toBe(true);
	expect(predictions(384)).toHaveLength(48);
	expect(() => simulateTiers(ops, { frames: 0, cold: 0 })).toThrow(/frames/);
});

test('the LZ4 codec round trips heap-like pages and keeps an incompressible page raw', async () => {
	const codec = lz4Codec(loadModules().lz4);
	const page = new Uint8Array(PAGE);
	const back = new Uint8Array(PAGE);
	for (const p of [0, 7]) {
		basePage(p, page);
		const packed = codec.compress(page);
		expect(packed.length).toBeLessThan(PAGE);
		codec.decompress(packed, back);
		expect(Buffer.from(back).equals(Buffer.from(page))).toBe(true);
	}
	let state = 1;
	for (let i = 0; i < PAGE; i++)
		page[i] = (state = Math.imul(state, 1664525) + 1013904223) >>> 24;
	const noise = codec.compress(page);
	expect(noise.length).toBe(PAGE);
	codec.decompress(noise, back);
	expect(Buffer.from(back).equals(Buffer.from(page))).toBe(true);
	const pin = JSON.parse(
		readFileSync(
			new URL('../../experiments/elastic-ladder/wasm/source.json', import.meta.url),
			'utf8'
		)
	);
	const digest = (path: string) =>
		createHash('sha256')
			.update(
				readFileSync(
					new URL(`../../experiments/elastic-ladder/wasm/${path}`, import.meta.url)
				)
			)
			.digest('hex');
	expect(digest('lz4/lz4.c')).toBe(pin.lz4.libLz4cSha256);
	expect(digest('lz4/lz4.h')).toBe(pin.lz4.libLz4hSha256);
	expect(digest('lz4_wasm.c')).toBe(pin.lz4.wrapperSha256);
	const { compilerVersion, ensureLz4 } =
		await import('../../experiments/elastic-ladder/lz4-build.ts');
	const wasm = readFileSync(ensureLz4());
	const expected = pin.lz4WasmByCompiler[compilerVersion()];
	if (expected) expect(createHash('sha256').update(wasm).digest('hex')).toBe(expected);
});

test('every workload is exact on every byte and the executor matches the model, V4 and V6, at the E3 frame counts', async () => {
	for (const workload of WORKLOADS)
		for (const frames of [4, 16, 64, 256])
			for (const cold of [0, 24]) {
				const { result, ctx, price } = await run(workload, variantOf(frames, cold));
				const label = `${workload} frames ${frames} cold ${cold}`;
				expect(result.failure, label).toBeUndefined();
				expect(result.exact, label).toBe(true);
				const model = simulateTiers(modelOps(expectedFor(workload, PAGES)), {
					frames,
					cold
				});
				const stats = result.stats as Record<string, number>;
				for (const key of [
					'frameHits',
					'coldHits',
					'storeReads',
					'storeWrites',
					'compressions',
					'decompressions',
					'coldEvictions'
				] as const)
					expect(stats[key], `${label} ${key}`).toBe(model[key]);
				for (const [name, [seen, want]] of Object.entries(same(price, ctx)))
					expect(seen, `${label} ${name}`).toBe(want);
			}
});

test('the real LZ4 pool is exact and compresses the heap-like workload pages', async () => {
	for (const workload of ['dense', 'skewed'] as const) {
		const { result } = await run(workload, variantOf(16, 24), {}, 96, null);
		expect(result.exact, `${workload}: ${result.failure}`).toBe(true);
		const stats = result.stats as { compressions: number; coldPeakBytes: number };
		expect(stats.compressions).toBeGreaterThan(0);
		expect(stats.coldPeakBytes).toBeLessThan(24 * PAGE);
	}
});

test('a V4 model with no pool agrees with the older colocated model on the same dense trace', () => {
	const ops = modelOps(expectedFor('dense', PAGES));
	for (const frames of [4, 16, 64, 256]) {
		const old = simulate(ops, {
			name: 'c',
			topology: 'colocated',
			frames,
			writePolicy: 'write-back',
			opsPerRequest: Infinity,
			costs: { baseMs: 0, hopMs: 0, putMs: 0, getMs: 0, xferMsPerMiB: 0 }
		});
		const now = simulateTiers(ops, { frames, cold: 0 });
		expect([old.puts, old.gets]).toEqual([now.storeWrites, now.storeReads]);
	}
});

test('exactness holds for random eviction seeds, and for forced eviction at every step', async () => {
	// the five-seed grid over every frame count is section 2 of sweep.ts, at full scale; the gate keeps two seeds
	for (const workload of WORKLOADS)
		for (const randomSeed of [1, 2]) {
			const cold = randomSeed % 2 ? 0 : 24;
			const { result } = await run(workload, variantOf(4, cold), { randomSeed }, 96);
			expect(result.exact, `${workload} seed ${randomSeed}: ${result.failure}`).toBe(true);
		}
	// 96 pages keeps the file fast; 256 frames hold them all there, so the largest size also runs at 272 pages
	for (const workload of ['dense', 'skewed'] as const) {
		const { result } = await run(workload, variantOf(256, 0), { randomSeed: 1 });
		expect(result.exact, `${workload} 256 seed 1: ${result.failure}`).toBe(true);
	}
	for (const workload of WORKLOADS)
		for (const cold of [0, 24]) {
			const { result } = await run(workload, variantOf(4, cold), { evictEvery: true }, 96);
			expect(
				result.exact,
				`${workload} evict every step cold ${cold}: ${result.failure}`
			).toBe(true);
		}
});

test('continuation: a quantum of 1, 7 or 999 resumes from the checkpoint and the request count equals the price', async () => {
	for (const quantum of [1, 7, 999])
		for (const workload of WORKLOADS) {
			const pages = 24;
			const { result, ctx, price } = await run(
				workload,
				variantOf(4, quantum === 7 ? 8 : 0, { quantum }),
				{},
				pages
			);
			expect(result.exact, `${workload} quantum ${quantum}: ${result.failure}`).toBe(true);
			expect(ctx.counters.seen.requests).toBe(price.requests + price.cleanupRequests);
			const ops = expectedFor(workload, pages).ops.length;
			expect(price.requests).toBe(2 + Math.floor(ops / quantum) + 1);
		}
});

test('a resume from a different executor epoch is refused, not run on lost frames', async () => {
	const { dense, trace, lz4 } = loadModules();
	const object = new ExecutorObject({
		makeBackend: (rowBytes) => new MemoryBackend(rowBytes),
		codec: () => lz4Codec(lz4),
		dense,
		trace,
		clock: () => 0,
		makePage
	});
	const cfg: RunConfig = {
		workload: 'dense',
		pages: 24,
		frames: 4,
		cold: 0,
		rowBytes: PAGE,
		quantum: 5
	};
	const call = (op: string, init: RequestInit = {}) =>
		object.fetch(
			new Request(`https://do/${op}?cfg=${encodeURIComponent(JSON.stringify(cfg))}`, {
				method: 'POST',
				...init
			})
		);
	await call('init');
	const first = await call('run');
	expect(first.headers.get('x-done')).toBe('0');
	const checkpoint = await first.arrayBuffer();
	const refused = await call('run', {
		body: checkpoint,
		headers: { 'x-epoch': 'not-this-one', 'x-completion': '0' }
	});
	expect(refused.status).toBe(409);
	expect(((await refused.json()) as { error: string }).error).toMatch(/restarted/);
});

test('an asynchronous handler unwinds and resumes to the same result as a synchronous one', async () => {
	const { dense } = loadModules();
	const pages = 24;
	const sum = async (asynchronous: boolean, quantum: number) => {
		const backend = new MemoryBackend(PAGE);
		const pager: PagerType = new Pager({ frames: 4, cold: 0, pages, backend });
		const handler = (kind: number, at: number, value: number, width: number) =>
			asynchronous
				? Promise.resolve(pager.handle(kind, at, value, width))
				: pager.handle(kind, at, value, width);
		let resume;
		for (;;) {
			const seg = await runSegment(
				{ module: dense, entry: 'run', args: [pages], fuel: 100000000 },
				handler,
				quantum,
				resume
			);
			if (seg.done) return seg.result;
			resume = seg.checkpoint;
		}
	};
	const want = denseChecksum(pages);
	expect(await sum(false, Infinity)).toBe(want);
	expect(await sum(true, Infinity)).toBe(want);
	expect(await sum(true, 3)).toBe(want);
});

test('the SQL backend keeps pages as rows, over real SQLite, for every row size', () => {
	const db = new DatabaseSync(':memory:');
	const sql: Sql = {
		exec(query, ...bindings) {
			const stmt = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
				return { toArray: () => rows, rowsWritten: 0, rowsRead: rows.length };
			}
			const r = stmt.run(...(bindings as never[]));
			// sqlite reports the last statement's changes after a CREATE, so only DML counts
			const dml = /^\s*(insert|update|delete)/i.test(query);
			return { toArray: () => [], rowsWritten: dml ? Number(r.changes) : 0, rowsRead: 0 };
		}
	};
	for (const rowBytes of [PAGE, 8192, 1024]) {
		db.exec('DROP TABLE IF EXISTS pages');
		let wiped = 0;
		const backend = new SqlBackend(sql, rowBytes, () => void wiped++);
		backend.setup();
		const a = new Uint8Array(PAGE);
		const b = new Uint8Array(PAGE);
		basePage(3, a);
		basePage(4, b);
		expect(backend.read(3)).toBeNull();
		backend.write(3, a);
		backend.write(4, b);
		backend.write(3, b);
		const rows = PAGE / rowBytes;
		expect(backend.rowsWritten).toBe(3 * rows);
		expect(Buffer.from(backend.read(3) as Uint8Array).equals(Buffer.from(b))).toBe(true);
		expect(Buffer.from(backend.read(4) as Uint8Array).equals(Buffer.from(b))).toBe(true);
		expect(backend.rowsRead).toBe(2 * rows + (rowBytes === PAGE ? 0 : 0));
		expect(backend.clear()).toBe(2 * rows);
		expect(wiped).toBe(1);
	}
});

test('the fake store counts rows by arithmetic and moves its clock only when told', () => {
	const clock = new VirtualClock();
	const backend = new MemoryBackend(8192, clock, { readMs: 2, writeMs: 3 });
	const page = new Uint8Array(PAGE);
	backend.write(0, page);
	backend.read(0);
	expect(backend.read(1)).toBeNull();
	expect([backend.rowsWritten, backend.rowsRead, clock.now]).toEqual([8, 8, 5]);
	expect(() => backend.write(0, new Uint8Array(10))).toThrow(/page size/);
});

test('the price table equals the counters of a full dense run at the live size', async () => {
	for (const variant of [VARIANTS.v4!]) {
		const { result, ctx, price } = await run('dense', variant, {}, 3072);
		expect(result.exact).toBe(true);
		for (const [name, [seen, want]] of Object.entries(same(price, ctx)))
			expect(seen, name).toBe(want);
		expect(rowsOf(price)).toBe(3072 + 2 + 3072);
	}
});

test('the price table: V4 and V6 rows at full scale, the 4 KiB row size is refused as too costly', () => {
	const table = priceCells(cellsFor(Object.values(VARIANTS), ['dense'], 3072), LIVE);
	expect(table.perCell.map((p) => rowsOf(p))).toEqual([6146, 6146]);
	expect(table.perCell.every((p) => p.internal === 0)).toBe(true);
	const small = priceCell(
		{
			variant: variantOf(64, 0, { rowBytes: 4096 }),
			workload: 'dense',
			pages: 3072,
			repeat: 0
		},
		LIVE
	);
	expect(rowsOf(small)).toBeGreaterThan(LIVE.caps.rows);
	expect(() => checkVariant(variantOf(64, 0, { rowBytes: 3000 }))).toThrow(/rowBytes/);
	expect(() => checkVariant(variantOf(0, 0))).toThrow(/frames/);
	expect(() => checkVariant(variantOf(4, 0, { quantum: 0 }))).toThrow(/quantum/);
});

test('the dry run prices every variant and sends nothing; flags change the cells', () => {
	const { config, cells, values } = parse(['--variants', 'v4,v6', '--workloads', 'dense,skewed']);
	expect(values.approved).toBe(false);
	const out = dryRun(config, cells, {});
	expect(out.network).toBe('none');
	expect(out.table.at(-1)!.cell).toBe('total');
	expect(Object.keys(out.rowsPerVariant)).toEqual(['v4', 'v6']);
	expect(out.fitsRowCap).toBe(false);
	expect(out.environment.FREE_CLOUDFLARE_API_TOKEN).toBe('not set');
	const one = parse([
		'--variants',
		'v6',
		'--cold',
		'512',
		'--quantum',
		'999',
		'--row-cap',
		'9000'
	]);
	expect(one.cells[0]!.variant).toMatchObject({ cold: 512, quantum: 999 });
	expect(dryRun(one.config, one.cells, {}).fitsRowCap).toBe(true);
	expect(() => parse(['--variants', 'v9'])).toThrow(/unknown variant/);
});

const subdomain = 'fake-sub-zzz';
const account = 'fake-account-id-0123456789';
const token = 'fake-token-abcdefghijkl';

function fakeCloud() {
	const scripts = new Map<string, string[]>();
	const forms: FormData[] = [];
	const api = async (path: string, init: any = {}) => {
		const method = init.method ?? 'GET';
		const script = /^\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
		if (method === 'GET' && path === '/workers/scripts')
			return [...scripts.keys()].map((id) => ({ id, modified_on: 'm', created_on: 'c' }));
		if (path.split('?')[0] === '/workers/durable_objects/namespaces') return [];
		if (path.startsWith('/storage/kv') || path === '/d1/database') return [];
		if (path === '/r2/buckets') return { buckets: [] };
		if (path === '/subscriptions') throw new Error('Authentication error');
		if (path === '/workers/subdomain') return { subdomain };
		if (path.endsWith('/subdomain')) return {};
		if (script && method === 'PUT') {
			forms.push(init.body);
			const meta = JSON.parse(await (init.body.get('metadata') as Blob).text());
			scripts.set(script, meta.migrations.steps[0].new_sqlite_classes ?? []);
			return {};
		}
		if (script && method === 'DELETE') {
			expect(scripts.get(script), 'script deleted with classes left').toEqual([]);
			scripts.delete(script);
			return {};
		}
		throw new Error(`fake api: ${method} ${path}`);
	};
	return { api: api as any, scripts, forms };
}

const gqlFor = (spent: number) => async (query: string) => {
	if (query.includes('workersInvocationsAdaptive'))
		return {
			viewer: {
				accounts: [{ w: [{ sum: { requests: 10 } }], d: [{ sum: { rowsWritten: spent } }] }]
			}
		};
	return { viewer: { accounts: [{}] } };
};

function liveDeps(cloud: ReturnType<typeof fakeCloud>, out: string, spent = 5, log: object[] = []) {
	const bundleDir = join(out, 'bundle');
	mkdirSync(bundleDir, { recursive: true });
	for (const name of ['worker.js', 'aaa-fixture.wasm', 'bbb-trace.wasm', 'ccc-lz4.wasm'])
		writeFileSync(join(bundleDir, name), name);
	const world = localWorld({ makePage });
	return {
		api: cloud.api,
		gql: gqlFor(spent) as any,
		fetchImpl: ((input: any, init: any) => {
			const url = String(input);
			expect(url).toMatch(/^https:\/\/(folio-e2|cfw-e2e)-[0-9a-f]{8}\./);
			// the deployed Worker holds a random secret; the local world holds a fixed one
			const headers = { ...init?.headers, authorization: `Bearer ${SECRET}` };
			return world.fetchImpl(url.replace(/^https:\/\/[^/]+/, BASE), { ...init, headers });
		}) as typeof fetch,
		sleep: async () => {},
		log: (line: object) => log.push(line),
		outDir: pathToFileURL(out + '/'),
		creds: { account, token, label: 'FREE' as const },
		bundleDir: () => bundleDir
	};
}

test('the live path deploys, runs two variants, tears down and checks the account against a fake API', async () => {
	const out = join(dir, 'live');
	mkdirSync(out);
	const cloud = fakeCloud();
	const log: object[] = [];
	const config = { ...TINY, caps: { ...TINY.caps, rows: 100000 } };
	const cells = cellsFor(
		Object.values(VARIANTS).map((v) => ({ ...v, frames: 8, cold: v.cold ? 16 : 0 })),
		['dense', 'skewed'],
		config.pages
	);
	const result: any = await runLive(liveDeps(cloud, out, 5, log), config, cells, {
		approved: true
	});
	expect(result.skipped).toBe(false);
	expect(result.failure).toBeUndefined();
	expect(result.results).toHaveLength(4);
	expect(result.results.every((r: any) => r.exact)).toBe(true);
	expect(result.cleanup.accountEqualsBaseline).toBe(true);
	expect(cloud.scripts.size).toBe(0);
	const names = [...(cloud.forms[0] as unknown as { keys(): Iterable<string> }).keys()].sort();
	expect(names).toEqual([
		'aaa-fixture.wasm',
		'bbb-trace.wasm',
		'ccc-lz4.wasm',
		'metadata',
		'worker.js'
	]);
	const meta = JSON.parse(await (cloud.forms[0]!.get('metadata') as Blob).text());
	expect(meta.main_module).toBe('worker.js');
	expect(meta.bindings.map((b: any) => b.name)).toEqual(['SECRET', 'EXEC']);
	const [run] = readdirSync(join(out, 'runs'));
	const counters = JSON.parse(readFileSync(join(out, 'runs', run!, 'counters.json'), 'utf8'));
	const priced = priceCells(cells, config);
	expect(counters.seen.requests).toBe(priced.total.requests + priced.total.cleanupRequests);
	expect(counters.seen.writeRows).toBe(priced.total.writeRows);
	expect(counters.readRows).toBe(priced.total.readRows);
	for (const file of readdirSync(join(out, 'runs', run!))) {
		const text = readFileSync(join(out, 'runs', run!, file), 'utf8');
		for (const value of [account, token, subdomain, 'workers.dev'])
			expect(text.includes(value), `${file} holds ${value}`).toBe(false);
	}
	const raw = readFileSync(join(out, 'runs', run!, 'raw.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
	expect(raw.filter((r) => r.level === 'client').every((r) => r.colo === 'LOCAL')).toBe(true);
	expect(raw.filter((r) => r.level === 'ready')).toHaveLength(1);
	expect(raw.filter((r) => r.op === 'run').length).toBe(cells.length);
	expect(redact('x')).toBe('x');
	const recovered = await cleanupRun(liveDeps(cloud, out), 'folio-e2-00000000', 'x');
	expect(recovered.equalsBaseline).toBe(false);
});

test('a live run refuses without --approved, over the row cap, or on a day with too few rows left', async () => {
	const cloud = fakeCloud();
	const { config, cells } = parse(['--variants', 'v4,v6', '--workloads', 'dense,skewed']);
	const deps = liveDeps(cloud, join(dir, 'refuse'), 79990);
	await expect(runLive(deps, config, cells, { approved: false })).rejects.toThrow(/--approved/);
	await expect(runLive(deps, config, cells, { approved: true })).rejects.toThrow(/row cap/);
	const one = parse(['--variants', 'v4']);
	const skipped: any = await runLive(deps, one.config, one.cells, { approved: true });
	expect(skipped.skipped).toBe(true);
	expect(cloud.scripts.size).toBe(0);
});

test('--paid skips the Free plan refusals and deploys under a cfw-e2e name', async () => {
	const base = fakeCloud();
	const names: string[] = [];
	const cloud = {
		...base,
		api: async (path: string, init: any = {}) => {
			if (path === '/subscriptions')
				return [{ state: 'enabled', rate_plan: { id: 'workers_paid_standard' } }];
			if (init.method === 'PUT') names.push(/\/scripts\/([^/]+)$/.exec(path)![1]!);
			return base.api(path, init);
		}
	};
	const config = { ...TINY, caps: { ...TINY.caps, rows: 100000 } };
	const cells = cellsFor([{ ...VARIANTS.v4!, frames: 8 }], ['dense'], config.pages);
	await expect(
		runLive(liveDeps(cloud as any, join(dir, 'paid-refused')), config, cells, {
			approved: true
		})
	).rejects.toThrow(/paid Workers account refused/);
	expect(parse(['--paid']).values.paid).toBe(true);
	expect(parse([]).values.paid).toBe(false);
	const log: object[] = [];
	const out = join(dir, 'paid');
	const result: any = await runLive(liveDeps(cloud as any, out, 99_999_999, log), config, cells, {
		approved: true,
		paid: true
	});
	expect(result.skipped).toBe(false);
	expect(result.failure).toBeUndefined();
	expect(result.cleanup.accountEqualsBaseline).toBe(true);
	expect(names.filter((n) => n.startsWith('cfw-e2e-')).length).toBeGreaterThan(0);
	expect(names.every((n) => /^cfw-e2e-[0-9a-f]{8}$/.test(n))).toBe(true);
	expect(log).toContainEqual({ plan: 'paid account selected with --paid' });
	const [run] = readdirSync(join(out, 'runs'));
	expect(JSON.parse(readFileSync(join(out, 'runs', run!, 'budget.json'), 'utf8')).plan).toBe(
		'Paid'
	);
	const recovered = await cleanupRun(liveDeps(cloud as any, out), 'cfw-e2e-00000000', 'x');
	expect(recovered.equalsBaseline).toBe(false);
});

async function captured(
	cell: Cell,
	config: LadderConfig,
	fetchImpl: typeof fetch,
	heartbeatMs?: number
) {
	const records: any[] = [];
	const ctx = await makeLadderCtx({
		config,
		planned: priceCell(cell, config),
		base: BASE,
		secret: SECRET,
		fetchImpl,
		rawFile: pathToFileURL(join(dir, 'captured.jsonl')),
		log: () => {},
		heartbeatMs
	});
	ctx.sink = async (record) => {
		records.push(record);
	};
	const result = await runCell(ctx, cell, config);
	return { result, ctx, records };
}

const cellOf = (workload: Workload, variant: Variant, pages: number): Cell => ({
	variant,
	workload,
	pages,
	repeat: 0
});

test('a failed call keeps its error body up to 8 KiB, not 300 characters', async () => {
	const body = `<html>${'e'.repeat(9000)}</html>`;
	const { records } = await captured(
		cellOf('dense', variantOf(4, 0), 24),
		configFor(24),
		async () => new Response(body, { status: 404 })
	);
	expect(records.find((r) => r.op === 'init').error).toBe(body.slice(0, 8192));
});

test('a failed init charges its schema rows; a clear after it charges only the pages init can write', async () => {
	const failures = [
		async () => new Response('<html>404</html>', { status: 404 }),
		async (): Promise<Response> => {
			throw new TypeError('fetch failed');
		}
	];
	for (const workload of ['dense', 'skewed'] as const)
		for (const fetchImpl of failures) {
			const { ctx } = await captured(
				cellOf(workload, variantOf(4, 0), 48),
				configFor(48),
				fetchImpl as typeof fetch
			);
			const initPages = workload === 'dense' ? 0 : 48;
			expect(ctx.counters.seen.writeRows, workload).toBe(initPages + 2);
			expect(ctx.counters.seen.cleanupRows, workload).toBe(initPages);
		}
});

test('a run request logs a heartbeat while it is in flight, and each request records its wall-clock time', async () => {
	const world = localWorld({ makePage });
	const slow = (async (input: string | URL | Request, init?: RequestInit) => {
		if (/\/run\?/.test(String(input))) await new Promise((resolve) => setTimeout(resolve, 40));
		return world.fetchImpl(input, init);
	}) as typeof fetch;
	const { records } = await captured(
		cellOf('dense', variantOf(4, 0), 24),
		configFor(24),
		slow,
		5
	);
	const beats = records.filter((r) => r.level === 'heartbeat');
	expect(beats.length).toBeGreaterThanOrEqual(3);
	expect(beats.every((b) => typeof b.monoMs === 'number' && b.sinceLastMs >= 0)).toBe(true);
	const client = records.filter((r) => r.level === 'client');
	expect(client.every((r) => typeof r.wallClockMs === 'number')).toBe(true);
	expect(client.find((r) => r.op === 'run').wallClockMs).toBeGreaterThanOrEqual(35);
});

test('--repeat-offset labels each cell with its real repeat number', () => {
	const cells = parse(['--variants', 'v4', '--repeats', '2', '--repeat-offset', '3']).cells;
	expect(cells.map((c) => c.repeat)).toEqual([3, 4]);
});

test('the unpaged pair: resident pages move no rows, and a paged V4 with frames equal to pages prices its flush, verify and clear', async () => {
	const pages = 96;
	const unpaged = {
		name: 'unpaged',
		frames: 1,
		cold: 0,
		rowBytes: PAGE,
		quantum: Infinity,
		resident: true
	};
	expect(() => priceCell(cellOf('skewed', unpaged, pages), configFor(pages))).toThrow(/dense/);
	const resident = await run('dense', unpaged, {}, pages);
	expect(resident.result.exact).toBe(true);
	expect(resident.price).toMatchObject({
		writeRows: 0,
		schemaRows: 0,
		cleanupRows: 0,
		readRows: 0,
		requests: 3
	});
	for (const [name, [seen, want]] of Object.entries(same(resident.price, resident.ctx)))
		expect(seen, name).toBe(want);
	const paged = await run('dense', variantOf(pages, 0), {}, pages);
	expect(paged.result.exact).toBe(true);
	expect(paged.price).toMatchObject({
		writeRows: pages,
		schemaRows: 2,
		cleanupRows: pages,
		readRows: pages
	});
	for (const [name, [seen, want]] of Object.entries(same(paged.price, paged.ctx)))
		expect(seen, name).toBe(want);
});

test('a live run names the endpoint whose listing failed, before it deploys anything', async () => {
	const cloud = fakeCloud();
	const refusing = {
		...cloud,
		api: async (path: string, init: any = {}) => {
			if (path === '/workers/scripts' && !init.method) throw new Error('listing refused');
			return cloud.api(path, init);
		}
	};
	const log: object[] = [];
	const { config, cells } = parse(['--variants', 'v4', '--workloads', 'dense']);
	await expect(
		runLive(liveDeps(refusing as any, join(dir, 'listing'), 5, log), config, cells, {
			approved: true
		})
	).rejects.toThrow(/\/workers\/scripts/);
	expect(log).toContainEqual(
		expect.objectContaining({ inventoryErrors: [expect.stringContaining('/workers/scripts')] })
	);
	expect(cloud.scripts.size).toBe(0);
});
