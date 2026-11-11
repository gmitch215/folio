import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Abort } from '../elastic-limits/counters.ts';
import type { Gql } from '../elastic-limits/meter.ts';
import { makeGql, spentToday } from '../elastic-limits/meter.ts';
import { redact, remember, scrub } from '../elastic-limits/redact.ts';
import type { Api, Credentials } from '../lib/cloudflare.ts';
import { createApi, credentials, inventory, inventoryDiff, retire } from '../lib/cloudflare.ts';
import { lacksRows, quotaNotice } from '../lib/quota.ts';
import { makeLadderCtx, runCell } from './driver.ts';
import type { Cell, LadderConfig, Variant } from './plan.ts';
import {
	EPHEMERAL,
	LIVE,
	RESIDENT,
	VARIANTS,
	cellsFor,
	priceCells,
	requestsOf,
	rowsOf
} from './plan.ts';
import type { Workload } from './programs.ts';
import { WORKLOADS } from './programs.ts';

const here = new URL('.', import.meta.url);

export interface Deps {
	api: Api;
	gql: Gql;
	fetchImpl: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	log: (line: object) => void;
	outDir: URL;
	creds: Credentials;
	// the directory wrangler's dry run wrote the bundle to
	bundleDir: () => Promise<string> | string;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function dryRun(
	config: LadderConfig,
	cells: readonly Cell[],
	env: Record<string, string | undefined>
) {
	const priced = priceCells(cells, config);
	const row = (label: string, p: (typeof priced)['total']) => ({
		cell: label,
		writeRows: p.writeRows,
		schemaRows: p.schemaRows,
		cleanupRows: p.cleanupRows,
		rowsTotal: rowsOf(p),
		rowsRead: p.readRows,
		clientRequests: requestsOf(p),
		internalCalls: p.internal
	});
	const perVariant: Record<string, number> = {};
	cells.forEach((cell, i) => {
		perVariant[cell.variant.name] =
			(perVariant[cell.variant.name] ?? 0) + rowsOf(priced.perCell[i]!);
	});
	return {
		mode: 'dry-run',
		config: config.name,
		pages: config.pages,
		caps: config.caps,
		variants: [...new Map(cells.map((c) => [c.variant.name, c.variant])).values()],
		table: [
			...cells.map((cell, i) =>
				row(`${cell.variant.name} ${cell.workload} r${cell.repeat}`, priced.perCell[i]!)
			),
			row('setup (ready polls)', priced.setup),
			row('total', priced.total)
		],
		rowsPerVariant: perVariant,
		fitsRowCap: rowsOf(priced.total) <= config.caps.rows,
		fitsRequestCap: requestsOf(priced.total) <= config.caps.requests,
		fitsPlanningLimit: rowsOf(priced.total) <= config.caps.planningDailyRows,
		environment: {
			FREE_CLOUDFLARE_ACCOUNT_ID: env.FREE_CLOUDFLARE_ACCOUNT_ID ? 'set' : 'not set',
			FREE_CLOUDFLARE_API_TOKEN: env.FREE_CLOUDFLARE_API_TOKEN ? 'set' : 'not set'
		},
		network: 'none'
	};
}

async function save(dir: URL, file: string, value: unknown) {
	await writeFile(new URL(file, dir), JSON.stringify(scrub(value), null, 2) + '\n', {
		flag: 'wx'
	});
}

// the main module is the one .js file; every .wasm beside it is an imported module
export const liveCredentials = (env: Record<string, string | undefined>) =>
	credentials({
		FOLIO_CLOUDFLARE_ACCOUNT_ID: env.FOLIO_CLOUDFLARE_ACCOUNT_ID,
		FOLIO_CLOUDFLARE_API_TOKEN: env.FOLIO_CLOUDFLARE_API_TOKEN,
		FREE_CLOUDFLARE_ACCOUNT_ID: env.FREE_CLOUDFLARE_ACCOUNT_ID,
		FREE_CLOUDFLARE_API_TOKEN: env.FREE_CLOUDFLARE_API_TOKEN
	});

export async function readBundle(dir: string) {
	const files = await readdir(dir);
	const main = files.find((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
	assert.ok(main, 'bundle has no main module');
	return {
		main,
		mainBytes: await readFile(`${dir}/${main}`),
		wasm: await Promise.all(
			files
				.filter((f) => f.endsWith('.wasm'))
				.map(async (name) => ({ name, bytes: await readFile(`${dir}/${name}`) }))
		)
	};
}

async function deploy(deps: Deps, name: string, secret: string) {
	const bundle = await readBundle(await deps.bundleDir());
	const metadata = {
		main_module: bundle.main,
		compatibility_date: '2026-10-20',
		bindings: [
			{ name: 'SECRET', type: 'plain_text', text: secret },
			{ name: 'EXEC', type: 'durable_object_namespace', class_name: 'Executor' }
		],
		migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['Executor'] }] }
	};
	const form = new FormData();
	form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
	form.set(
		bundle.main,
		new Blob([bundle.mainBytes], { type: 'application/javascript+module' }),
		bundle.main
	);
	for (const { name: file, bytes } of bundle.wasm)
		form.set(file, new Blob([bytes], { type: 'application/wasm' }), file);
	await deps.api(`/workers/scripts/${name}`, { method: 'PUT', body: form });
	await deps.api(`/workers/scripts/${name}/subdomain`, {
		method: 'POST',
		body: JSON.stringify({ enabled: true }),
		headers: { 'content-type': 'application/json' }
	});
	const subdomain = (await deps.api('/workers/subdomain')).subdomain;
	remember(subdomain);
	return {
		base: `https://${name}.${subdomain}.workers.dev`,
		bundleSha256: createHash('sha256').update(bundle.mainBytes).digest('hex'),
		modules: bundle.wasm.map((m) => m.name)
	};
}

export interface ReadyHold {
	// consecutive 200s required before init
	streak: number;
	// ms to wait after the ready answer before init
	settle: number;
}

const READY_DEFAULT: ReadyHold = { streak: 1, settle: 0 };

export async function ready(
	deps: Pick<Deps, 'sleep'>,
	ctx: Awaited<ReturnType<typeof makeLadderCtx>>,
	polls = 30,
	hold: ReadyHold = READY_DEFAULT
) {
	const began = performance.now();
	let lastStatus = 0;
	const note = (count: number, ok: boolean) =>
		ctx.sink({
			level: 'ready',
			ts: new Date().toISOString(),
			polls: count,
			ok,
			lastStatus,
			elapsedMs: performance.now() - began
		});
	let streak = 0;
	for (let i = 0; i < polls; i++) {
		ctx.counters.guard({});
		ctx.counters.issue({}, i > 0);
		let ok = false;
		lastStatus = 0;
		try {
			const response = await ctx.fetchImpl(`${ctx.base}/ready`, {
				headers: { authorization: `Bearer ${ctx.secret}` },
				signal: AbortSignal.timeout(ctx.timeoutMs)
			});
			lastStatus = response.status;
			await response.arrayBuffer();
			ok = response.ok;
		} catch {
			// not up yet
		}
		ctx.counters.record(0, { requests: 1 });
		streak = ok ? streak + 1 : 0;
		if (ok && streak >= hold.streak) {
			if (hold.settle > 0) await deps.sleep(hold.settle);
			return note(i + 1, true);
		}
		await deps.sleep(1000);
	}
	await note(polls, false);
	throw new Abort('worker did not become ready');
}

const classes = ['Executor'];

// nothing here runs without approved
export async function runLive(
	deps: Deps,
	config: LadderConfig,
	cells: readonly Cell[],
	options: { approved: boolean; hold?: ReadyHold; paid?: boolean }
) {
	assert.ok(options.approved, 'live run needs --approved');
	const paid = options.paid === true;
	remember(deps.creds.account);
	remember(deps.creds.token);
	const priced = priceCells(cells, config);
	assert.ok(rowsOf(priced.total) <= config.caps.rows, 'planned rows pass the row cap');
	assert.ok(
		requestsOf(priced.total) <= config.caps.requests,
		'planned requests pass the request cap'
	);
	const spent = await spentToday(deps.gql);
	deps.log({
		spentToday: spent,
		planned: rowsOf(priced.total),
		planningLimit: config.caps.planningDailyRows
	});
	if (
		!paid &&
		(lacksRows(spent.rowsWritten, rowsOf(priced.total)) ||
			spent.rowsWritten + rowsOf(priced.total) > config.caps.planningDailyRows)
	) {
		deps.log({ skipped: quotaNotice(spent.rowsWritten, rowsOf(priced.total)) });
		return { skipped: true, spent };
	}
	if (paid) deps.log({ plan: 'paid account selected with --paid' });
	else
		try {
			const subs = await deps.api('/subscriptions');
			assert.ok(
				!subs.some(
					(row: any) =>
						row.state === 'enabled' &&
						/workers.*(paid|standard|bundled|unbound)/i.test(row.rate_plan?.id ?? '')
				),
				'paid Workers account refused'
			);
		} catch (error) {
			// the known Free token has no billing scope; any other failure stops the run
			if (!String(error).includes('Authentication error')) throw error;
			deps.log({ plan: 'not verified, billing scope unavailable' });
		}
	const inventoryErrors: string[] = [];
	const baseline = await inventory(deps.api, (path, error) =>
		inventoryErrors.push(`${path}: ${redact(String(error))}`)
	);
	if (inventoryErrors.length) deps.log({ inventoryErrors });
	assert.ok(
		baseline.scripts && baseline.namespaces,
		`account inventory unavailable: ${inventoryErrors.join('; ')}`
	);
	// printed first so a dead driver can still be cleaned up against it
	deps.log({
		baselineSha256: digest(baseline),
		counts: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, v?.length ?? null]))
	});
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = new URL(`runs/${stamp}/`, deps.outDir);
	await mkdir(dir, { recursive: true });
	const name = `${paid ? 'cfw-e2e' : 'folio-e2'}-${crypto.randomUUID().slice(0, 8)}`;
	const secret = crypto.randomUUID();
	remember(secret);
	await save(dir, 'budget.json', {
		config,
		cells: cells.map((c) => ({ ...c.variant, workload: c.workload, repeat: c.repeat })),
		planned: priced,
		expectedSpendUsd: 0,
		plan: paid ? 'Paid' : 'Free'
	});
	let deployed = false;
	let failure: string | undefined;
	let ctx: Awaited<ReturnType<typeof makeLadderCtx>> | undefined;
	const results: object[] = [];
	try {
		const info = await deploy(deps, name, secret);
		deployed = true;
		await save(dir, 'source.json', {
			name,
			modules: info.modules,
			workerSha256: info.bundleSha256
		});
		ctx = await makeLadderCtx({
			config,
			planned: priced.total,
			base: info.base,
			secret,
			fetchImpl: deps.fetchImpl,
			rawFile: new URL('raw.jsonl', dir),
			log: deps.log
		});
		await ready(deps, ctx, 30, options.hold);
		for (const cell of cells) {
			const result = await runCell(ctx, cell, config);
			results.push({ variant: cell.variant.name, workload: cell.workload, ...result });
			if (!result.exact) {
				failure = `${cell.variant.name} ${cell.workload}: ${result.failure ?? 'not exact'}`;
				break;
			}
		}
	} catch (error) {
		failure = redact(String(error));
		deps.log({ failure, abort: error instanceof Abort });
	}
	let cleanup: object = { deployed };
	if (deployed) {
		try {
			await retire(deps.api, name, classes);
		} catch (error) {
			failure = `${failure ?? ''} teardown: ${redact(String(error))}`.trim();
		}
		const own = (entry: Record<string, unknown>) =>
			entry.name === name || entry.script === name;
		let after = await inventory(deps.api);
		let differences = inventoryDiff(baseline, after, own);
		for (let poll = 0; differences.length && poll < 12; poll++) {
			await deps.sleep(2500);
			after = await inventory(deps.api);
			differences = inventoryDiff(baseline, after, own);
		}
		cleanup = {
			differences,
			ownResourcesRestored: differences.every((row) => !row.mine),
			accountEqualsBaseline: differences.length === 0,
			afterSha256: digest(after)
		};
	}
	await save(dir, 'cleanup.json', cleanup);
	if (ctx)
		await save(dir, 'counters.json', {
			seen: ctx.counters.seen,
			readRows: ctx.readRows.value,
			retries: ctx.counters.retries,
			planned: priced.total,
			results,
			failure
		});
	return { skipped: false, spent, failure, results, cleanup, baselineSha256: digest(baseline) };
}

// recovers a run whose driver died: retire the class and check the account against a baseline digest
export async function cleanupRun(deps: Deps, name: string, baselineSha256: string) {
	assert.match(name, /^(folio-e2|cfw-e2e)-[0-9a-f]{8}$/);
	const known = await deps.api('/workers/scripts');
	if (known.some((row: { id: string }) => row.id === name)) await retire(deps.api, name, classes);
	const after = await inventory(deps.api);
	return { name, accountSha256: digest(after), equalsBaseline: digest(after) === baselineSha256 };
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			variants: { type: 'string', default: 'v4,v6' },
			workloads: { type: 'string', default: 'dense' },
			pages: { type: 'string' },
			frames: { type: 'string' },
			cold: { type: 'string' },
			'row-kib': { type: 'string' },
			quantum: { type: 'string' },
			repeats: { type: 'string', default: '1' },
			'repeat-offset': { type: 'string', default: '0' },
			'row-cap': { type: 'string' },
			approved: { type: 'boolean', default: false },
			paid: { type: 'boolean', default: false },
			cleanup: { type: 'string' },
			baseline: { type: 'string' },
			'ready-streak': { type: 'string', default: '1' },
			'ready-settle': { type: 'string', default: '0' }
		}
	});
	const hold: ReadyHold = {
		streak: Number(values['ready-streak']),
		settle: Number(values['ready-settle'])
	};
	assert.ok(
		Number.isInteger(hold.streak) && hold.streak >= 1,
		'--ready-streak is an integer >= 1'
	);
	assert.ok(hold.settle >= 0, '--ready-settle is ms >= 0');
	const known: Record<string, Variant> = { ...VARIANTS, ...RESIDENT, ...EPHEMERAL };
	const names = values.variants!.split(',');
	for (const n of names) assert.ok(n in known, `unknown variant ${n}`);
	const workloads = values.workloads!.split(',') as Workload[];
	for (const w of workloads) assert.ok(WORKLOADS.includes(w), `unknown workload ${w}`);
	const variants: Variant[] = names.map((n) => ({
		...known[n]!,
		...(values.frames ? { frames: Number(values.frames) } : {}),
		...(values.cold && known[n]!.cold > 0 ? { cold: Number(values.cold) } : {}),
		...(values['row-kib'] ? { rowBytes: Number(values['row-kib']) * 1024 } : {}),
		...(values.quantum ? { quantum: Number(values.quantum) } : {})
	}));
	const config: LadderConfig = {
		...LIVE,
		pages: values.pages ? Number(values.pages) : LIVE.pages,
		caps: {
			...LIVE.caps,
			rows: values['row-cap'] ? Number(values['row-cap']) : LIVE.caps.rows
		}
	};
	const cells = cellsFor(
		variants,
		workloads,
		config.pages,
		Number(values.repeats),
		Number(values['repeat-offset'])
	);
	return { values, config, cells, hold };
}

async function main() {
	const { values, config, cells, hold } = parse(process.argv.slice(2));
	const env = process.env;
	if (!values.approved && !values.cleanup) {
		console.log(JSON.stringify(dryRun(config, cells, env), null, 2));
		return;
	}
	const creds = liveCredentials(env);
	remember(creds.account);
	remember(creds.token);
	const { bundle } = await import('../lib/bundle.ts');
	const deps: Deps = {
		api: createApi(creds),
		gql: makeGql(creds),
		fetchImpl: fetch,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log: (line) => console.log(JSON.stringify(scrub(line))),
		outDir: here,
		creds,
		bundleDir: () => bundle('elastic-ladder')
	};
	if (values.cleanup) {
		assert.ok(values.baseline, '--baseline SHA256 of the baseline inventory');
		console.log(JSON.stringify(await cleanupRun(deps, values.cleanup, values.baseline)));
		return;
	}
	console.log(
		JSON.stringify(
			scrub(await runLive(deps, config, cells, { approved: true, hold, paid: values.paid })),
			null,
			2
		)
	);
}

if (import.meta.main) await main();
