import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Api, Credentials } from '../../../../experiments/lib/cloudflare.ts';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire
} from '../../../../experiments/lib/cloudflare.ts';
import { lacksRows, quotaNotice } from '../../../../experiments/lib/quota.ts';
import type { Config, Rung } from './config.ts';
import {
	LADDER_BINDINGS,
	LADDER_CLASSES,
	LIVE,
	MEM_CLASSES,
	RUNGS,
	TINY
} from './config.ts';
import { Abort } from './counters.ts';
import { makeCtx } from './harness.ts';
import type { Gql } from './meter.ts';
import { makeGql, namespacesOf, readSettled, spentToday } from './meter.ts';
import { memClassCount, price, priceRung, requestsOf, rowsOf } from './plan.ts';
import { redact, remember, scrub } from './redact.ts';
import { memOrder, runLadder, runMem } from './runner.ts';

const here = new URL('.', import.meta.url);

export interface Deps {
	api: Api;
	gql: Gql;
	fetchImpl: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	log: (line: object) => void;
	outDir: URL;
	creds: Credentials;
	alignMinute: boolean;
	meterWait: { firstWaitMs?: number; pollMs?: number; maxPolls?: number };
}

type Group = 'ladder' | 'mem';

export const groupsFor = (rungs: readonly Rung[]): Group[] => [
	...(rungs.some((r) => r !== 7) ? (['ladder'] as const) : []),
	...(rungs.includes(7) ? (['mem'] as const) : [])
];

const digest = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function dryRun(config: Config, rungs: readonly Rung[], env: Record<string, string | undefined>) {
	const priced = price(config, rungs);
	const row = (label: string, p: ReturnType<typeof priceRung>) => ({
		rung: label,
		writeRows: p.writeRows,
		schemaRows: p.schemaRows,
		cleanupRows: p.cleanupRows,
		rowsTotal: rowsOf(p),
		clientRequests: requestsOf(p),
		internalCalls: p.internal,
		externalCalls: p.external
	});
	return {
		mode: 'dry-run',
		config: config.name,
		rungs: RUNGS.filter((r) => rungs.includes(r)),
		groups: groupsFor(rungs),
		caps: config.caps,
		table: [
			...RUNGS.filter((r) => rungs.includes(r)).map((r) => row(`rung ${r}`, priced.perRung[r]!)),
			row('setup (ready polls)', priced.setup),
			row('total', priced.total)
		],
		memClasses: rungs.includes(7) ? memClassCount(config) : 0,
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
	await writeFile(new URL(file, dir), JSON.stringify(scrub(value), null, 2) + '\n', { flag: 'wx' });
}

async function deploy(deps: Deps, group: Group, name: string, secret: string) {
	const classes = group === 'ladder' ? LADDER_CLASSES : MEM_CLASSES;
	const source = await readFile(new URL(`worker-${group}.mjs`, here));
	const metadata = {
		main_module: 'worker.mjs',
		compatibility_date: '2026-10-20',
		bindings: [
			{ name: 'SECRET', type: 'plain_text', text: secret },
			{ name: 'COLO_PROBE', type: 'plain_text', text: 'on' },
			...classes.map((c) => ({
				name: group === 'ladder' ? LADDER_BINDINGS[c] : c,
				type: 'durable_object_namespace',
				class_name: c
			}))
		],
		migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: classes }] }
	};
	const form = new FormData();
	form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
	form.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
	await deps.api(`/workers/scripts/${name}`, { method: 'PUT', body: form });
	await deps.api(`/workers/scripts/${name}/subdomain`, {
		method: 'POST',
		body: JSON.stringify({ enabled: true }),
		headers: { 'content-type': 'application/json' }
	});
	const subdomain = (await deps.api('/workers/subdomain')).subdomain;
	remember(subdomain);
	return {
		classes,
		base: `https://${name}.${subdomain}.workers.dev`,
		workerSha256: createHash('sha256').update(source).digest('hex')
	};
}

async function runGroup(
	deps: Deps,
	config: Config,
	rungs: readonly Rung[],
	group: Group,
	baseline: Awaited<ReturnType<typeof inventory>>
) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const dir = new URL(`runs/${stamp}-${group}/`, deps.outDir);
	await mkdir(dir, { recursive: true });
	const name = `folio-e1-${group}-${crypto.randomUUID().slice(0, 8)}`;
	const secret = crypto.randomUUID();
	remember(secret);
	const mine = rungs.filter((r) => (group === 'mem' ? r === 7 : r !== 7));
	const planned = price(config, mine);
	await save(dir, 'budget.json', { config, rungs: mine, planned, expectedSpendUsd: 0, plan: 'Free' });
	const began = new Date(Date.now() - 60000).toISOString();
	let deployed = false,
		failure: string | undefined,
		ctx: Awaited<ReturnType<typeof makeCtx>> | undefined,
		info: Awaited<ReturnType<typeof deploy>> | undefined,
		order: ReturnType<typeof memOrder> | undefined;
	let namespaces: { id: string; cls: string }[] = [];
	try {
		info = await deploy(deps, group, name, secret);
		deployed = true;
		await save(dir, 'source.json', { name, group, workerSha256: info.workerSha256 });
		ctx = await makeCtx({
			config,
			rungs: mine,
			base: info.base,
			secret,
			fetchImpl: deps.fetchImpl,
			rawFile: new URL('raw.jsonl', dir),
			sleep: deps.sleep,
			alignMinute: deps.alignMinute && mine.includes(6),
			log: deps.log
		});
		if (group === 'ladder') await runLadder(ctx, mine);
		else {
			order = memOrder(config);
			await runMem(ctx, MEM_CLASSES.slice(0, memClassCount(config)));
		}
	} catch (error) {
		failure = redact(String(error));
		deps.log({ failure, abort: error instanceof Abort });
	}
	let cleanup: object = { deployed };
	if (deployed) {
		try {
			// the namespace ids are needed for the meter after the script is gone
			namespaces = await namespacesOf(deps.api, name);
			await save(dir, 'namespaces.json', namespaces);
			await retire(deps.api, name, info!.classes);
		} catch (error) {
			failure = `${failure ?? ''} teardown: ${redact(String(error))}`.trim();
		}
		const own = (entry: Record<string, unknown>) => entry.name === name || entry.script === name;
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
	if (ctx) {
		await save(dir, 'counters.json', {
			seen: ctx.counters.seen,
			byRung: ctx.counters.byRung,
			retries: ctx.counters.retries,
			planned: planned.total,
			failure
		});
	}
	let meter: object = { skipped: 'nothing deployed or no namespaces' };
	if (namespaces.length) {
		try {
			meter = await readSettled(deps.gql, namespaces, began, {
				sleep: deps.sleep,
				onPoll: deps.log,
				...deps.meterWait
			});
		} catch (error) {
			meter = { error: redact(String(error)) };
		}
	}
	await save(dir, 'meter.json', {
		scope: 'durableObjectsPeriodicGroups per class namespace and minute; max is the largest sample',
		classes: order
			? order.map((o) => ({ cls: MEM_CLASSES[o.cls], mib: o.mib, touch: o.touch, repeat: o.repeat }))
			: undefined,
		...meter
	});
	return { group, dir: dir.pathname.split('/runs/')[1], failure, cleanup };
}

/** the live run; nothing here runs without `approved` */
export async function runLive(
	deps: Deps,
	config: Config,
	rungs: readonly Rung[],
	options: { approved: boolean }
) {
	assert.ok(options.approved, 'live run needs --approved');
	remember(deps.creds.account);
	remember(deps.creds.token);
	const priced = price(config, rungs);
	assert.ok(rowsOf(priced.total) <= config.caps.rows, 'planned rows pass the row cap');
	assert.ok(requestsOf(priced.total) <= config.caps.requests, 'planned requests pass the request cap');
	const spent = await spentToday(deps.gql);
	deps.log({ spentToday: spent, planned: rowsOf(priced.total), planningLimit: config.caps.planningDailyRows });
	if (lacksRows(spent.rowsWritten, rowsOf(priced.total)) || spent.rowsWritten + rowsOf(priced.total) > config.caps.planningDailyRows) {
		deps.log({ skipped: quotaNotice(spent.rowsWritten, rowsOf(priced.total)) });
		return { skipped: true, spent };
	}
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
	const baseline = await inventory(deps.api);
	assert.ok(baseline.scripts && baseline.namespaces, 'account inventory unavailable');
	// printed first so a dead driver can still be cleaned up against it
	deps.log({ baselineSha256: digest(baseline), counts: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, v?.length ?? null])) });
	const outcomes = [];
	for (const group of groupsFor(rungs)) {
		const outcome = await runGroup(deps, config, rungs, group, baseline);
		outcomes.push(outcome);
		if (outcome.failure) break;
	}
	return { skipped: false, spent, outcomes, baselineSha256: digest(baseline) };
}

/** recovers a group whose driver died: retire the classes and check the account against a baseline digest */
export async function cleanupGroup(deps: Deps, name: string, group: Group, baselineSha256: string) {
	assert.match(name, /^folio-e1-(ladder|mem)-[0-9a-f]{8}$/);
	const classes = group === 'ladder' ? LADDER_CLASSES : MEM_CLASSES;
	const known = await deps.api('/workers/scripts');
	if (known.some((row: { id: string }) => row.id === name)) await retire(deps.api, name, classes);
	const after = await inventory(deps.api);
	return { name, accountSha256: digest(after), equalsBaseline: digest(after) === baselineSha256 };
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			rungs: { type: 'string' },
			approved: { type: 'boolean', default: false },
			'row-cap': { type: 'string' },
			'page-rows': { type: 'boolean', default: false },
			config: { type: 'string', default: 'live' },
			cleanup: { type: 'string' },
			group: { type: 'string' },
			baseline: { type: 'string' }
		}
	});
	const rungs = (values.rungs ? values.rungs.split(',').map(Number) : [...RUNGS]) as Rung[];
	for (const r of rungs) assert.ok((RUNGS as readonly number[]).includes(r), `unknown rung ${r}`);
	const base = values.config === 'tiny' ? TINY : LIVE;
	const config: Config = {
		...base,
		caps: { ...base.caps, rows: values['row-cap'] ? Number(values['row-cap']) : base.caps.rows },
		rung6: { ...base.rung6, pageRowArm: values['page-rows'] }
	};
	return { values, rungs, config };
}

async function main() {
	const { values, rungs, config } = parse(process.argv.slice(2));
	const env = process.env;
	if (!values.approved && !values.cleanup) {
		console.log(JSON.stringify(dryRun(config, rungs, env), null, 2));
		return;
	}
	assert.equal(config.name, 'live', 'a live run uses the live config');
	const creds = credentials({
		FREE_CLOUDFLARE_ACCOUNT_ID: env.FREE_CLOUDFLARE_ACCOUNT_ID,
		FREE_CLOUDFLARE_API_TOKEN: env.FREE_CLOUDFLARE_API_TOKEN
	});
	remember(creds.account);
	remember(creds.token);
	const deps: Deps = {
		api: createApi(creds),
		gql: makeGql(creds),
		fetchImpl: fetch,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log: (line) => console.log(JSON.stringify(scrub(line))),
		outDir: here,
		creds,
		alignMinute: true,
		meterWait: {}
	};
	if (values.cleanup) {
		assert.ok(values.group === 'ladder' || values.group === 'mem', '--group ladder or mem');
		assert.ok(values.baseline, '--baseline SHA256 of the baseline inventory');
		console.log(
			JSON.stringify(await cleanupGroup(deps, values.cleanup, values.group as Group, values.baseline))
		);
		return;
	}
	console.log(JSON.stringify(scrub(await runLive(deps, config, rungs, { approved: true })), null, 2));
}

if (import.meta.main) await main();
