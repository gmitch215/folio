import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import type { Rung } from '../../experiments/elastic-limits/config.ts';
import {
	ALL_RUNGS,
	CONTROL_OF,
	GROUP_CLASSES,
	LIVE,
	MEM_CLASSES,
	MIB,
	PAGE,
	RUNGS,
	SPILL_CLASSES,
	TINY,
	bindingOf,
	groupOf
} from '../../experiments/elastic-limits/config.ts';
import { Abort, Counters } from '../../experiments/elastic-limits/counters.ts';
import { makeCtx } from '../../experiments/elastic-limits/harness.ts';
import type { Deps } from '../../experiments/elastic-limits/live.ts';
import {
	cleanupGroup,
	dryRun,
	groupsFor,
	parse,
	runLive
} from '../../experiments/elastic-limits/live.ts';
import {
	makeGql,
	readSettled,
	signature,
	spentToday
} from '../../experiments/elastic-limits/meter.ts';
import {
	armsOf,
	layouts,
	memClassCount,
	price,
	priceRung,
	requestsOf,
	rowsOf,
	rowsOfBytes,
	zero
} from '../../experiments/elastic-limits/plan.ts';
import { redact, remember, scrub } from '../../experiments/elastic-limits/redact.ts';
import {
	call,
	memOrder,
	runLadder,
	runMem,
	runSpill,
	rung6b
} from '../../experiments/elastic-limits/runner.ts';
import { redactIsolates, reduceNamespaces } from '../../scripts/research/elastic-limits-promote.ts';
import {
	arms,
	holds,
	median,
	mergeUnlisted,
	meterClasses,
	parseLines,
	peak,
	platformLadder,
	quantile,
	rung1,
	rung4,
	rung5,
	rung6,
	rung7,
	spillMemory
} from '../../scripts/research/elastic-limits-summary.ts';

const dir = mkdtempSync(join(tmpdir(), 'folio-elastic-limits-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const rawFile = () => pathToFileURL(join(dir, `raw-${files++}.jsonl`));
const lines = (url: URL) =>
	readFileSync(url, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));

// planted values are built at run time so this file passes the redaction scan
const host = ['demo', 'free'].join('-') + ['.workers', 'dev'].join('.');
const account = 'fake-account-id-0123456789';
const token = 'fake-token-abcdefghijkl';
const subdomain = 'fake-sub-zzz';
const secret = 'test-secret';

// a stand-in for the deployed Workers: it answers every op with the fields the runner reads
function fakeWorker(hooks: Record<string, () => never> = {}) {
	const tables = new Set<string>();
	const reply = (role: string, name: string, op: string, args: any): Record<string, unknown> => {
		if (op === 'ping' || op === 'clear')
			return op === 'clear' ? { cleared: true, keysSeen: null } : { ok: 1 };
		if (op === 'colo') return { colo: 'AAA', probe: true };
		if (role === 'own')
			return {
				shape: args.shape,
				rows: args.shape === 'none' ? 0 : args.n,
				setupRows: args.shape === 'sql' && !tables.has(name) ? (tables.add(name), 2) : 0,
				per: args.shape === 'await' ? Array(args.n).fill(0) : []
			};
		if (role === 'exec' && op === 'hop') {
			const count = args.mode === 'local' ? 0 : args.n + 1;
			return { timings: Array.from({ length: count }, (_, i) => ({ i: i - 1, ms: 1 })) };
		}
		if (role === 'exec' && op === 'fan') {
			const all = args.kind.startsWith('all') ? [{ i: 'all', ms: 1 }] : [];
			const each = Array.from({ length: args.count + 1 }, (_, i) => ({ i: i - 1, ms: 1 }));
			return { timings: [...each, ...all], ok: args.count + 1 };
		}
		if (role === 'store')
			return op === 'init'
				? { rows: 1, setupRows: 2 }
				: { rows: op === 'rmw' ? args.n : 0, setupRows: 0 };
		if (role === 'burn') return { iters: args.iters };
		if (/^m\d\d$/i.test(role)) return { held: args.ms ?? 0, bytes: (args.mib ?? 0) * MIB };
		if (op === 'hold') return { held: args.ms };
		if (op === 'readback') return { rows: 0, read: args.mib * MIB };
		if (op === 'spill') {
			const none = role === 'spillnone' || role.startsWith('ctl');
			const put = role === 'spillput' || role === 'putone';
			const bytes = args.rowBytes ?? args.extentPages * PAGE;
			const count = Math.floor((args.mib * MIB) / bytes);
			const object = args.owner ?? name;
			const sql = !none && !put;
			const setupRows = sql && !tables.has(object) ? (tables.add(object), 2) : 0;
			return { rows: none ? 0 : count, setupRows, bytes: count * bytes };
		}
		throw new Error(`fake worker: ${role} ${op}`);
	};
	return (async (input: any, init?: any) => {
		const url = new URL(String(input));
		const key = url.pathname;
		if (hooks[key]) hooks[key]!();
		if (url.pathname === '/ready') return Response.json({ ready: true });
		const [, role = '', name = '', op = ''] = url.pathname.split('/');
		const args = JSON.parse(String(init?.body ?? '{}'));
		const body: Record<string, unknown> = reply(role, name, op, args);
		if (role === 'secexec' && op !== 'ping') Object.assign(body, { forwards: 1 });
		return Response.json({ isolate: 'i', ...body }, { headers: { 'x-front-colo': 'AAA' } });
	}) as unknown as typeof fetch;
}

const ctxFor = (rungs: Rung[], fetchImpl: typeof fetch, extra: object = {}) =>
	makeCtx({
		config: TINY,
		rungs,
		base: 'http://worker.local',
		secret,
		fetchImpl,
		rawFile: rawFile(),
		run: 'itest',
		sleep: async () => {},
		log: () => {},
		...extra
	});

test('every ladder rung runs against the fake worker and the counters equal the price', async () => {
	const ladder: Rung[] = [5, 6, 4, 1, 2, 3];
	const ctx = await ctxFor(ladder, fakeWorker());
	await runLadder(ctx, ladder);
	const priced = price(TINY, ladder);
	for (const rung of ladder) {
		const want = priceRung(TINY, rung);
		const got = ctx.counters.byRung[rung]!;
		expect(got.writeRows, `rung ${rung} write rows`).toBe(want.writeRows);
		expect(got.cleanupRows, `rung ${rung} cleanup rows`).toBe(want.cleanupRows);
		expect(got.schemaRows, `rung ${rung} schema rows`).toBe(want.schemaRows);
		expect(got.requests, `rung ${rung} requests`).toBe(want.requests + want.cleanupRequests);
		expect(got.internal, `rung ${rung} internal`).toBe(want.internal);
		expect(got.external, `rung ${rung} external`).toBe(want.external);
	}
	expect(ctx.counters.seen.requests).toBe(priced.total.requests + priced.total.cleanupRequests);
	expect(ctx.counters.byRung[0]!.requests).toBe(priced.setup.requests);
	expect(ctx.counters.retries).toBe(0);
	const projected = ctx.counters.projected();
	expect(projected.requests).toBe(ctx.counters.seen.requests);
	expect(projected.internal).toBe(ctx.counters.seen.internal);
});

test('the raw file has one object per client call and one per inner call', async () => {
	const url = rawFile();
	const ctx = await ctxFor([1, 6], fakeWorker(), { rawFile: url });
	await runLadder(ctx, [1, 6]);
	const records = lines(url);
	const client = records.filter((r) => r.level === 'client');
	const inner = records.filter((r) => r.level === 'inner');
	for (const r of client)
		for (const key of ['rung', 'shape', 'size', 'repeat', 'wallMs', 'status', 'ts', 'colo'])
			expect(r, `client line lacks ${key}`).toHaveProperty(key);
	expect(inner.filter((r) => r.rung === 1 && r.shape === 'await').length).toBe(
		TINY.rung1.sizesKiB.length * TINY.rung1.n * TINY.rung1.repeats
	);
	const none = client.filter((r) => r.rung === 6 && r.op === 'spill' && r.mode === undefined);
	expect(none.length).toBe(layouts(TINY).length * 3 * TINY.rung6.repeats);
});

test.each(['6b', '6c', '6d', '6e'] as const)(
	'rung %s runs against the fake worker, every arm equals its price',
	async (rung) => {
		const url = rawFile();
		const ctx = await ctxFor([rung], fakeWorker(), { rawFile: url });
		await runSpill(ctx, [rung]);
		const want = priceRung(TINY, rung);
		const got = ctx.counters.byRung[rung]!;
		expect(got.writeRows).toBe(want.writeRows);
		expect(got.cleanupRows).toBe(want.cleanupRows);
		expect(got.schemaRows).toBe(want.schemaRows);
		expect(got.requests).toBe(want.requests + want.cleanupRequests);
		expect(got.internal).toBe(want.internal);
		expect(ctx.counters.retries).toBe(0);
		const records = lines(url).filter((r) => r.level === 'client' && r.rung === rung);
		const priced = armsOf(TINY, rung);
		expect(new Set(records.map((r) => r.arm))).toEqual(new Set(Object.keys(priced)));
		const sum = (xs: any[], key: string) => xs.reduce((a, r) => a + (r[key] ?? 0), 0);
		for (const [arm, p] of Object.entries(priced)) {
			const mine = records.filter((r) => r.arm === arm);
			const clears = mine.filter((r) => r.op === 'clear');
			const calls = mine.filter((r) => r.op !== 'clear');
			expect(calls.length, `${arm} requests`).toBe(p.requests);
			expect(clears.length, `${arm} clears`).toBe(p.cleanupRequests);
			expect(sum(calls, 'rows'), `${arm} write rows`).toBe(p.writeRows);
			expect(sum(clears, 'planned'), `${arm} cleared rows`).toBe(p.cleanupRows);
			expect(sum(mine, 'forwards'), `${arm} forwards`).toBe(p.internal);
		}
	}
);

test('rung 6b reads each extent once and holds after the drop arm clears', async () => {
	const url = rawFile();
	const ctx = await ctxFor(['6b'], fakeWorker(), { rawFile: url });
	await rung6b(ctx);
	const records = lines(url).filter((r) => r.level === 'client');
	expect(records.filter((r) => r.op === 'readback').length).toBe(TINY.rung6b.repeats);
	const shapes = records.filter((r) => r.repeat === 0).map((r) => r.shape);
	const at = (prefix: string) => shapes.findIndex((s) => s.startsWith(prefix));
	expect(at('hold-drop')).toBeLessThan(at('clear-drop'));
	expect(at('clear-drop')).toBeLessThan(at('tail-drop'));
	for (const r of records) {
		expect(r.startMinute).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
		expect(r.endMinute >= r.startMinute).toBe(true);
	}
});

test('rung 6c restart runs a ping and a hold at each target minute, the clear last', async () => {
	const url = rawFile();
	const ctx = await ctxFor(['6c'], fakeWorker(), { rawFile: url });
	await runSpill(ctx, ['6c']);
	const restart = lines(url).filter(
		(r) => r.level === 'client' && r.arm === 'restart' && r.repeat === 0
	);
	expect(restart.map((r) => r.shape)).toEqual([
		'spill',
		'hold',
		'ping-0.01',
		'fresh-0.01',
		'ping-0.02',
		'fresh-0.02',
		'clear'
	]);
	expect(new Set(restart.map((r) => r.object)).size).toBe(1);
});

test('rung 6d decay holds run in order and the clear is last', async () => {
	const url = rawFile();
	const ctx = await ctxFor(['6d'], fakeWorker(), { rawFile: url });
	await runSpill(ctx, ['6d']);
	const decay = lines(url).filter(
		(r) => r.level === 'client' && r.arm === 'decay' && r.repeat === 0
	);
	const holdsOf = decay.filter((r) => r.op === 'hold');
	expect(decay.map((r) => r.op)).toEqual(['spill', ...holdsOf.map(() => 'hold'), 'clear']);
	expect(holdsOf.map((r) => r.hold)).toEqual(holdsOf.map((_, i) => i + 1));
	expect(holdsOf.length).toBe(TINY.rung6d.decay.holds);
});

test('every class of rungs 6b to 6e holds one arm and has a listed control', async () => {
	const urls = [];
	for (const rung of ['6b', '6c', '6d', '6e'] as const) {
		const url = rawFile();
		const ctx = await ctxFor([rung], fakeWorker(), { rawFile: url });
		await runSpill(ctx, [rung]);
		urls.push(url);
	}
	const seen = new Map<string, Set<string>>();
	for (const r of urls.flatMap(lines).filter((x) => x.level === 'client' && x.class)) {
		if (!seen.has(r.class)) seen.set(r.class, new Set());
		seen.get(r.class)!.add(r.arm);
	}
	for (const [cls, arm] of seen) expect(arm.size, `${cls} holds ${[...arm]}`).toBe(1);
	for (const cls of [...seen.keys(), ...Object.values(CONTROL_OF)])
		expect(SPILL_CLASSES).toContain(cls);
});

test('rung 7 runs every instance once and rotates the cells with a bare control at each end', async () => {
	const n = memClassCount(TINY);
	const ctx = await ctxFor([7], fakeWorker());
	const order = await runMem(ctx, MEM_CLASSES.slice(0, n));
	expect(ctx.counters.byRung[7]!.requests).toBe(priceRung(TINY, 7).requests);
	expect(order.length).toBe(n);
	const live = memOrder(LIVE);
	expect(live.length).toBe(26);
	expect(live[0]!.touch).toBeNull();
	expect(live.at(-1)!.touch).toBeNull();
	const key = (o: { mib: number; touch: boolean | null }) => `${o.mib}/${o.touch}`;
	const cells = live.filter((o) => o.touch !== null);
	for (let k = 0; k < LIVE.rung7.repeats; k++)
		expect(new Set(cells.filter((o) => o.repeat === k).map(key)).size).toBe(4);
	expect(key(cells[0]!)).not.toBe(key(cells[4]!));
});

test('a fetch failure waits a minute, retries five times and charges no rows', async () => {
	let tries = 0;
	const pauses: number[] = [];
	const ctx = await ctxFor(
		[1],
		(async () => {
			tries++;
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch,
		{ sleep: async (ms: number) => void pauses.push(ms) }
	);
	const reply = await call(
		ctx,
		{ rung: 1, shape: 'clear', size: 0, repeat: 0 },
		'own',
		'x',
		'clear',
		{},
		{ rows: 64 }
	);
	expect(tries).toBe(6);
	expect(pauses).toEqual([60000, 60000, 60000, 60000, 60000]);
	expect(reply.status).toBe(0);
	expect(ctx.counters.retries).toBe(5);
	expect(ctx.counters.seen.requests).toBe(6);
	expect(ctx.counters.rows).toBe(0);
});

test('a timeout may have reached the object, so every attempt charges its rows', async () => {
	let tries = 0;
	const pauses: number[] = [];
	const ctx = await ctxFor(
		[1],
		(async () => {
			tries++;
			throw new DOMException('aborted', 'TimeoutError');
		}) as unknown as typeof fetch,
		{ sleep: async (ms: number) => void pauses.push(ms) }
	);
	await call(
		ctx,
		{ rung: 1, shape: 'clear', size: 0, repeat: 0 },
		'own',
		'x',
		'clear',
		{},
		{ rows: 64 }
	);
	expect(tries).toBe(3);
	expect(pauses).toEqual([500, 500]);
	expect(ctx.counters.retries).toBe(2);
	expect(ctx.counters.seen.cleanupRows).toBe(3 * 64);
});

test('a failed hold ends its object and the clear waits for a probe to answer', async () => {
	const inner = fakeWorker();
	let holdFails = 6;
	let probeFails = 2;
	const fetchImpl = (async (input: any, init?: any) => {
		const url = String(input);
		if (url.endsWith('/smallrows/itest-d-small4k-0/hold') && holdFails-- > 0)
			throw new TypeError('fetch failed');
		if (url.endsWith('/smallrows/itest-d-small4k-0/ping') && probeFails-- > 0)
			throw new TypeError('fetch failed');
		return inner(input, init);
	}) as unknown as typeof fetch;
	const pauses: number[] = [];
	const url = rawFile();
	const ctx = await ctxFor(['6d'], fetchImpl, {
		rawFile: url,
		sleep: async (ms: number) => void pauses.push(ms)
	});
	await runSpill(ctx, ['6d']);
	const object = lines(url).filter(
		(r) => r.level === 'client' && r.object === 'itest-d-small4k-0'
	);
	expect(object.map((r) => r.op)).toEqual([
		'spill',
		...Array(6).fill('hold'),
		'ping',
		'ping',
		'ping',
		'clear'
	]);
	expect(object.filter((r) => r.op === 'ping').map((r) => r.status)).toEqual([0, 0, 200]);
	expect(pauses.filter((ms) => ms === 60000).length).toBe(8);
	const want = priceRung(TINY, '6d');
	expect(ctx.counters.byRung['6d']!.writeRows).toBe(want.writeRows);
	expect(ctx.counters.byRung['6d']!.cleanupRows).toBe(want.cleanupRows);
	expect(ctx.counters.retries).toBe(5);
});

test('a failed hold whose probes never answer skips its clear and the run goes on', async () => {
	const inner = fakeWorker();
	const fetchImpl = (async (input: any, init?: any) => {
		const url = String(input);
		if (/\/smallrows\/itest-d-small4k-0\/(hold|ping)$/.test(url))
			throw new TypeError('fetch failed');
		return inner(input, init);
	}) as unknown as typeof fetch;
	const url = rawFile();
	const ctx = await ctxFor(['6d'], fetchImpl, { rawFile: url });
	await runSpill(ctx, ['6d']);
	const all = lines(url).filter((r) => r.level === 'client');
	const object = all.filter((r) => r.object === 'itest-d-small4k-0');
	expect(object.some((r) => r.op === 'clear')).toBe(false);
	expect(object.filter((r) => r.op === 'ping').length).toBe(5);
	expect(object.filter((r) => r.op === 'skip').length).toBe(1);
	const next = all.filter((r) => r.object === 'itest-d-small16k-0' && r.op === 'clear');
	expect(next[0]?.status).toBe(200);
	expect(ctx.counters.byRung['6d']!.cleanupRows).toBe(priceRung(TINY, '6d').cleanupRows - 256);
});

test('a cap stops the run before the call that would pass it', async () => {
	const requests = await ctxFor([1], fakeWorker(), {
		config: { ...TINY, caps: { ...TINY.caps, requests: 3 } }
	});
	await expect(runLadder(requests, [1])).rejects.toBeInstanceOf(Abort);
	expect(requests.counters.seen.requests).toBe(3);
	const rows = await ctxFor([1], fakeWorker(), {
		config: { ...TINY, caps: { ...TINY.caps, rows: 4 } }
	});
	await expect(runLadder(rows, [1])).rejects.toThrow(/row cap/);
	expect(rows.counters.rows).toBeLessThanOrEqual(4);
});

test('a network failure retries twice at most and no host reaches the raw file', async () => {
	let tries = 0;
	const url = rawFile();
	const ctx = await ctxFor(
		[1],
		(async () => {
			tries++;
			throw new Error(`connect refused to ${host}`);
		}) as unknown as typeof fetch,
		{ rawFile: url }
	);
	const reply = await call(
		ctx,
		{ rung: 1, shape: 'none', size: 0, repeat: 0 },
		'own',
		'x',
		'write',
		{}
	);
	expect(tries).toBe(3);
	expect(reply.status).toBe(0);
	expect(ctx.counters.retries).toBe(2);
	const text = readFileSync(url, 'utf8');
	expect(text).not.toContain(host);
	expect(text).toContain('<workers.dev>');
});

test('counters guard caps, project the total and count a retry only in the observed total', () => {
	const planned = { ...zero(), writeRows: 10, requests: 4 };
	const counters = new Counters(planned, { rows: 12, requests: 3, planningDailyRows: 100 });
	counters.issue({ rows: 5 });
	counters.record(1, { requests: 1, writeRows: 5 });
	counters.issue({ rows: 5 }, true);
	counters.record(1, { requests: 1, writeRows: 5 });
	expect(counters.retries).toBe(1);
	expect(counters.projected()).toEqual({
		rows: 10 + 5,
		requests: 2 + 3,
		internal: 0,
		external: 0
	});
	expect(() => counters.guard({ rows: 3 })).toThrow(/row cap/);
	counters.record(1, { requests: 1 });
	expect(() => counters.guard({})).toThrow(/request cap/);
});

test('redaction removes workers.dev hosts and remembered values from every line', () => {
	remember(account);
	remember(token);
	remember(subdomain);
	remember('abc');
	expect(
		redact(`https://x.${subdomain}${['.workers', 'dev'].join('.')}/a ${account} ${token}`)
	).toBe('https://<workers.dev>/a <redacted> <redacted>');
	expect(redact('abc')).toBe('abc');
	expect(scrub({ a: [`${host}`], b: token })).toEqual({ a: ['<workers.dev>'], b: '<redacted>' });
});

test('the price arithmetic matches the notes', () => {
	expect(rowsOf(price(LIVE).total)).toBe(6386);
	expect(requestsOf(price(LIVE).total)).toBe(550);
	expect(price(LIVE).total.internal).toBe(5153);
	expect(rowsOf(price(LIVE, ['6b']).total)).toBe(4554);
	expect(requestsOf(price(LIVE, ['6b']).total)).toBe(81);
	expect(rowsOf(price(LIVE, ['6c']).total)).toBe(16976);
	expect(price(LIVE, ['6c']).total.internal).toBe(6);
	const d = price(LIVE, ['6d']).total;
	expect([rowsOf(d), requestsOf(d), d.internal]).toEqual([29784, 52, 3]);
	const e = price(LIVE, ['6e']).total;
	expect([rowsOf(e), requestsOf(e), e.internal]).toEqual([46428, 14, 0]);
	expect(rowsOfBytes(16, 6144)).toBe(2730);
	expect(rowsOfBytes(64, 4096)).toBe(16384);
	expect(rowsOfBytes(16, 16384)).toBe(1024);
	expect(Object.keys(armsOf(LIVE, '6e'))).toEqual(['rows8k', 'rows6k', 'big4k', 'controls']);
	expect(armsOf(LIVE, '6e').big4k).toEqual({
		...zero(),
		writeRows: 16384,
		cleanupRows: 16384,
		schemaRows: 2,
		requests: 2,
		cleanupRequests: 1
	});
	expect(memClassCount(LIVE)).toBe(26);
});

test('the dry run prices every rung, names the environment and touches no network', () => {
	const real = globalThis.fetch;
	globalThis.fetch = (() => {
		throw new Error('dry run used the network');
	}) as unknown as typeof fetch;
	try {
		const out = dryRun(LIVE, RUNGS, {});
		expect(out.network).toBe('none');
		expect(out.environment.FREE_CLOUDFLARE_ACCOUNT_ID).toBe('not set');
		expect(out.fitsRowCap && out.fitsRequestCap && out.fitsPlanningLimit).toBe(true);
		expect(out.table.at(-1)!.rung).toBe('total');
		expect(dryRun(LIVE, ['6d'], {}).arms.length).toBe(10);
		expect(dryRun(LIVE, ['6b'], {}).fitsRowCap).toBe(true);
		const pages = dryRun({ ...LIVE, rung6: { ...LIVE.rung6, pageRowArm: true } }, RUNGS, {});
		expect(pages.fitsRowCap).toBe(false);
	} finally {
		globalThis.fetch = real;
	}
	expect(groupsFor(RUNGS)).toEqual(['ladder', 'mem']);
	expect(groupsFor([6, '6b'])).toEqual(['ladder', 'spill']);
	expect(ALL_RUNGS.map(groupOf).filter((g) => g === 'spill').length).toBe(4);
	expect(GROUP_CLASSES.mem.length).toBe(26);
	expect(bindingOf('spill', 'Size0')).toBe('SIZE0');
	expect(bindingOf('ladder', 'Executor')).toBe('EXEC');
	expect(bindingOf('mem', 'M00')).toBe('M00');
	expect(parse(['--rungs', '6d,1', '--row-cap', '30000']).config.caps.rows).toBe(30000);
	expect(parse(['--rungs', '6d,1']).rungs).toEqual(['6d', 1]);
});

// a stand-in for the Cloudflare API: scripts, namespaces, retirement and an account inventory
function fakeCloud() {
	const scripts = new Map<string, string[]>();
	const hex = (s: string) => Buffer.from(s.padEnd(16, '0')).toString('hex').slice(0, 32);
	const api = async (path: string, init: any = {}) => {
		const method = init.method ?? 'GET';
		const script = /^\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
		if (method === 'GET' && path === '/workers/scripts')
			return [...scripts.keys()].map((id) => ({ id, modified_on: 'm', created_on: 'c' }));
		if (path.split('?')[0] === '/workers/durable_objects/namespaces')
			return [...scripts].flatMap(([s, classes]) =>
				classes.map((c) => ({ id: hex(s + c), name: `${s}_${c}`, script: s, class: c }))
			);
		if (path.startsWith('/storage/kv') || path === '/d1/database') return [];
		if (path === '/r2/buckets') return { buckets: [] };
		if (path === '/subscriptions') throw new Error('Authentication error');
		if (path === '/workers/subdomain') return { subdomain };
		if (path.endsWith('/subdomain')) return {};
		if (script && method === 'PUT') {
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
	return { api: api as any, scripts };
}

function fakeGql(spent = 5) {
	return async (query: string) => {
		if (query.includes('workersInvocationsAdaptive'))
			return {
				viewer: {
					accounts: [
						{ w: [{ sum: { requests: 10 } }], d: [{ sum: { rowsWritten: spent } }] }
					]
				}
			};
		const out: Record<string, unknown> = {};
		for (const m of query.matchAll(/n(\d+): durableObjectsPeriodicGroups/g))
			out[`n${m[1]}`] = [
				{
					dimensions: { datetimeMinute: '2026-11-05T00:00:00Z' },
					max: { memoryUsageBytes: 1e7 + Number(m[1]) },
					sum: {
						cpuTime: 1,
						exceededCpuErrors: 0,
						exceededMemoryErrors: 0,
						rowsWritten: 0,
						rowsRead: 0,
						subrequests: 0
					}
				}
			];
		return { viewer: { accounts: [out] } };
	};
}

const depsFor = (cloud: ReturnType<typeof fakeCloud>, out: string, spent = 5, log: object[] = []) =>
	({
		api: cloud.api,
		gql: fakeGql(spent),
		fetchImpl: ((input: any, init: any) => {
			const url = String(input);
			expect(url).toMatch(/^https:\/\/folio-e1-(ladder|spill|mem)-[0-9a-f]{8}\./);
			const path = url.replace(/^https:\/\/[^/]+/, 'http://worker.local');
			return fakeWorker()(path, init);
		}) as typeof fetch,
		sleep: async () => {},
		log: (line: object) => log.push(line),
		outDir: pathToFileURL(out + '/'),
		creds: { account, token, label: 'FREE' as const },
		alignMinute: false,
		meterWait: {}
	}) satisfies Deps;

test('the live path deploys, runs, tears down and checks the account against a fake API', async () => {
	const out = join(dir, 'live');
	mkdirSync(out);
	const cloud = fakeCloud();
	const log: object[] = [];
	const result: any = await runLive(depsFor(cloud, out, 5, log), TINY, RUNGS, { approved: true });
	expect(result.skipped).toBe(false);
	expect(result.outcomes.map((o: any) => o.group)).toEqual(['ladder', 'mem']);
	for (const o of result.outcomes) {
		expect(o.failure, String(o.failure)).toBeUndefined();
		expect(o.cleanup.accountEqualsBaseline).toBe(true);
		expect(o.cleanup.ownResourcesRestored).toBe(true);
	}
	expect(cloud.scripts.size).toBe(0);
	expect(log.some((l: any) => l.baselineSha256)).toBe(true);
	const runs = readdirSync(join(out, 'runs'));
	expect(runs.length).toBe(2);
	for (const run of runs) {
		const names = readdirSync(join(out, 'runs', run)).sort();
		expect(names).toEqual([
			'budget.json',
			'cleanup.json',
			'counters.json',
			'meter.json',
			'namespaces.json',
			'raw.jsonl',
			'source.json'
		]);
		const counters = JSON.parse(readFileSync(join(out, 'runs', run, 'counters.json'), 'utf8'));
		expect(counters.seen.requests).toBe(
			counters.planned.requests + counters.planned.cleanupRequests
		);
		for (const name of names) {
			const text = readFileSync(join(out, 'runs', run, name), 'utf8');
			for (const value of [account, token, subdomain, 'workers.dev'])
				expect(text.includes(value), `${name} holds ${value}`).toBe(false);
		}
	}
	const recovered = await cleanupGroup(
		depsFor(cloud, out),
		'folio-e1-ladder-00000000',
		'ladder',
		'x'
	);
	expect(recovered.equalsBaseline).toBe(false);
});

test('a live run refuses a plan over the row cap, or a day with too few rows, before it deploys', async () => {
	const cloud = fakeCloud();
	const deps = depsFor(cloud, dir, 79990);
	for (const rung of ['6c', '6d', '6e'] as const)
		await expect(runLive(deps, LIVE, [rung], { approved: true })).rejects.toThrow(/row cap/);
	const skipped: any = await runLive(deps, LIVE, [1], { approved: true });
	expect(skipped.skipped).toBe(true);
	await expect(runLive(deps, LIVE, [1], { approved: false })).rejects.toThrow(/--approved/);
	expect(cloud.scripts.size).toBe(0);
});

test('the meter reads until two reads agree and the daily spend comes from one query', async () => {
	let n = 0;
	const gql = async (query: string) => {
		if (query.includes('workersInvocationsAdaptive')) return fakeGql(7)(query);
		n++;
		return fakeGql()(query);
	};
	const polls: object[] = [];
	const ids = [{ id: 'a'.repeat(32), cls: 'Owner' }];
	const out = await readSettled(gql, ids, '2026-11-05T00:00:00Z', {
		sleep: async () => {},
		onPoll: (line) => polls.push(line)
	});
	expect(out.settled).toBe(true);
	expect(out.polls).toBe(2);
	expect(n).toBe(2);
	expect(signature(out.rows)).toContain('Owner');
	expect((await spentToday(gql)).rowsWritten).toBe(7);
	await expect(
		readSettled(gql, [{ id: 'x', cls: 'Owner' }], '', { sleep: async () => {} })
	).rejects.toThrow(/bad namespace id/);
	const rejected = makeGql({ account, token, label: 'FREE' }, (async () =>
		Response.json({ errors: [`bad ${token}`] }, { status: 400 })) as unknown as typeof fetch);
	remember(token);
	await expect(rejected('query')).rejects.toThrow(/graphql: .*<redacted>/);
});

// rows as the runner writes them, small enough to read
const hold = (cls: string, minute: string, extra: object = {}) => ({
	level: 'client',
	rung: '6d',
	op: 'hold',
	class: cls,
	arm: cls.startsWith('Ctl') ? 'controls' : 'sweep',
	shape: 'hold',
	repeat: 0,
	status: 200,
	startMinute: `2026-11-06T${minute}:00Z`,
	endMinute: `2026-11-06T${minute}:00Z`,
	...extra
});
const sample = (cls: string, minute: string, mibValue: number, rowsWritten = 0) => ({
	cls,
	minute: `2026-11-06T${minute}:00Z`,
	maxMemoryBytes: mibValue * MIB,
	rowsWritten,
	rowsRead: 0
});

test('R is the class peak in the hold minutes minus the control hold of its class', () => {
	const raw = [
		hold('CtlSmall', '00:41'),
		hold('Small16', '00:47', { mib: 16, rowBytes: 16384 }),
		hold('Small16', '00:49', { mib: 16, rowBytes: 16384, repeat: 1 })
	];
	const meter = {
		rows: [
			sample('CtlSmall', '00:41', 1.5),
			sample('Small16', '00:47', 17.75),
			sample('Small16', '00:49', 3.5)
		]
	};
	const list = holds(raw, meter).holds;
	expect(list.map((h) => h.rMiB)).toEqual([null, 16.25, 2]);
	expect(peak(meter, 'Small16', '2026-11-06T00:48:00Z', '2026-11-06T00:48:00Z')).toBeNull();
	expect(peak(meter, 'Small16', '2026-11-06T00:47:00Z', '2026-11-06T00:49:00Z')).toBe(17.75);
	const grouped = arms(raw, meter);
	expect(grouped).toHaveLength(1);
	expect(grouped[0]).toMatchObject({ n: 2, rMiB: [16.25, 2], rowKiB: 16, medianRMiB: 9.125 });
});

test('classes past the listing page are matched to their rows by order and rows written', () => {
	const spill = (cls: string, rows: number) => ({
		level: 'client',
		op: 'spill',
		class: cls,
		rows,
		setupRows: 2
	});
	const raw = [spill('A', 8), spill('B', 4), spill('C', 6)];
	const meter = { rows: [sample('A', '00:01', 3, 10)] };
	const unlisted = [
		sample('unknown-0', '00:02', 5, 6),
		sample('unknown-0', '00:03', 5, 0),
		sample('unknown-1', '00:04', 9, 8)
	];
	const merged = mergeUnlisted(raw, meter, unlisted);
	expect(merged.rows!.map((r) => r.cls)).toEqual(['A', 'B', 'B', 'C']);
	expect(() => mergeUnlisted(raw, meter, unlisted.slice(0, 2))).toThrow(/differ/);
	expect(() =>
		mergeUnlisted(raw, meter, [{ ...unlisted[0]!, rowsWritten: 1 }, unlisted[2]!])
	).toThrow(/rows written/);
});

test('quantiles interpolate and the per-run summaries read synthetic rows', () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
	expect(quantile([], 0.5)).toBeNull();
	const call1 = (shape: string, size: number, wallMs: number) => ({
		level: 'client',
		rung: 1,
		shape,
		size,
		op: 'write',
		n: 16,
		wallMs,
		status: 200
	});
	const rows1 = rung1([
		call1('none', 0, 50),
		call1('await', 1024, 82),
		call1('noawait', 1024, 90),
		call1('sql', 1024, 74)
	]);
	expect(rows1.noopBase).toEqual({ n: 1, medianMs: 50 });
	expect(rows1.cells.map((c) => c.netMedianMs)).toEqual([32, 40, 24]);
	expect(rows1.cells[0]!.netPerWriteMs).toBe(2);
	expect(rows1.spread).toEqual([{ sizeKiB: 1, wallMedianRatioMaxOverMin: 1.216 }]);
	const four = (shape: string, wallMs: number, iters?: number, warmup = false) => ({
		level: 'client',
		rung: 4,
		shape,
		wallMs,
		iters,
		warmup,
		status: 200
	});
	const cpu = rung4([
		four('noop', 90, undefined, true),
		four('noop', 60),
		four('ladder', 300, 100)
	]);
	expect(cpu).toMatchObject({
		requests: 3,
		ok: 3,
		noopMedianMs: 60,
		maxIters: 100,
		maxWallMs: 300
	});
	const five = (shape: string, n: number, wallMs: number, repeat = 0) => ({
		level: 'client',
		rung: 5,
		shape,
		n,
		wallMs,
		repeat,
		status: 200,
		size: 65536
	});
	expect(rung5([five('rmw', 50, 100), five('rmw', 200, 200)]).slopes).toEqual([
		{ repeat: 0, msPerCycle: 0.667 }
	]);
	const meter = {
		classes: [
			{ cls: 'M00', mib: 64, touch: true, repeat: 0 },
			{ cls: 'M01', mib: 64, touch: true, repeat: 1 }
		],
		rows: [sample('M00', '00:01', 65.5), sample('M00', '00:02', 65.25)]
	};
	expect(rung7(meter).cells).toEqual([
		{
			linearMiB: 64,
			arm: 'written',
			planned: 2,
			measured: 1,
			values: [
				{ repeat: 0, meterMiB: 65.5 },
				{ repeat: 1, meterMiB: null }
			],
			minMiB: 65.5,
			maxMiB: 65.5
		}
	]);
	expect(meterClasses(meter)[0]).toMatchObject({
		cls: 'M00',
		minutes: 2,
		maxMiB: 65.5,
		minMiB: 65.25
	});
	const spills = [
		{
			level: 'client',
			rung: 6,
			op: 'spill',
			role: 'spillsql',
			object: 'o',
			shape: 'spill',
			repeat: 0,
			ts: '2026-11-05T20:36:10.000Z',
			wallMs: 1000,
			rows: 64,
			sqlRows: 64,
			bytes: MIB * 64
		},
		{
			level: 'client',
			rung: 6,
			op: 'hold',
			role: 'spillsql',
			object: 'c',
			shape: 'control-sql',
			repeat: -1,
			ts: '2026-11-05T20:34:10.000Z',
			wallMs: 70000,
			status: 200
		}
	];
	const objects = rung6(spills, {
		rows: [sample('SpillSql', '20:36', 36), sample('SpillSql', '20:35', 1.5)].map((r) => ({
			...r,
			minute: r.minute.replace('2026-11-06', '2026-11-05')
		}))
	});
	expect(objects.map((o) => [o.control, o.peakMiB, o.rMiB])).toEqual([
		[true, 1.5, null],
		[false, 36, 34.5]
	]);
	expect(parseLines('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
});

test('promotion replaces module ids with ordinals that keep equality, and reduces listings', () => {
	const a = ['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-');
	const b = ['123e4567', 'e89b', '12d3', 'a456', '426614174001'].join('-');
	const out = redactIsolates(
		`{"isolate":"${a}"}\n{"isolate":"${b}"}\n{"isolate":"${a.toUpperCase()}"}\n`
	);
	expect(out.isolates).toBe(2);
	expect(out.text).toBe(
		'{"isolate":"isolate-0"}\n{"isolate":"isolate-1"}\n{"isolate":"isolate-0"}\n'
	);
	expect(
		reduceNamespaces([
			{ id: 'a'.repeat(32), cls: 'Owner' },
			{ id: 'b'.repeat(32), cls: 'Store' }
		])
	).toEqual({
		count: 2,
		classes: ['Owner', 'Store']
	});
});

test('the committed summaries regenerate from the committed raw files', () => {
	const read = (path: string) =>
		readFileSync(join('results/execution', path, 'summary.json'), 'utf8');
	expect(
		JSON.stringify(platformLadder('results/execution/platform-ladder'), null, 2) + '\n'
	).toBe(read('platform-ladder'));
	expect(JSON.stringify(spillMemory('results/execution/spill-memory'), null, 2) + '\n').toBe(
		read('spill-memory')
	);
	expect(statSync(dir).isDirectory()).toBe(true);
});
