import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runBootImage } from './bootimage/drive.ts';
import { isVariant, readinessAttempts, requestBound } from './bootimage/plan.ts';
import { collect } from './cloud/run.ts';
import { readMeter, runPhp, runSessions } from './consumer/drive.ts';
import {
	classesFor,
	createApi,
	credentials,
	isKind,
	openRun,
	retire,
	snapshot,
	spawnWrangler,
	stopTail,
	type Child
} from './lib/cloudflare.ts';

const kind = process.argv[2];
assert.ok(
	isKind(kind),
	'usage: node experiments/deploy.ts cloud|managed|browser|consumer|php|prepared|bootimage'
);

// each run is bounded up front; run.json records the bound beside the evidence
const budgets = {
	cloud: { invocations: 57, sqlCalls: 0, expectedCharges: 0 },
	managed: {
		externalDriverRequests: 1,
		maximumLaneInvocations: 640,
		maximumTotalInvocations: 700,
		sqlCalls: 0,
		expectedCharges: 0
	},
	browser: {
		sessions: 1,
		maximumSessionSeconds: 85,
		externalDriverRequests: 1,
		maximumAssetRequests: 32,
		maximumGateReads: 1,
		maximumGateWrites: 1,
		expectedCharges: 0
	},
	consumer: {
		maximumSessions: 5,
		maximumSessionSeconds: 75,
		externalDriverRequests: 7,
		maximumGateReads: 5,
		maximumGateWrites: 5,
		expectedCharges: 0
	},
	php: { maximumRequests: 40, maximumDurableObjectRequests: 38, sqlCalls: 0, expectedCharges: 0 },
	prepared: {
		maximumRequests: 40,
		maximumDurableObjectRequests: 38,
		sqlCalls: 0,
		expectedCharges: 0
	},
	bootimage: requestBound(
		isVariant(process.env.FOLIO_BOOTIMAGE_VARIANT) ? process.env.FOLIO_BOOTIMAGE_VARIANT : 'a'
	)
};

const sourceFiles = {
	cloud: [],
	managed: [
		'experiments/managed/build',
		'experiments/managed/artifact.ts',
		'experiments/managed/prepare.ts'
	],
	browser: [
		'experiments/browser/probe.ts',
		'experiments/browser/prepare.ts',
		'build/fixture.wasm',
		'build/sharing.wasm'
	],
	consumer: ['experiments/consumer'],
	php: ['experiments/consumer'],
	prepared: ['experiments/consumer'],
	bootimage: ['experiments/bootimage']
};

// one deploy per variant: three modules together pass the 64 MiB bundle
const bootVariant = process.env.FOLIO_BOOTIMAGE_VARIANT;
if (kind === 'bootimage')
	assert.ok(isVariant(bootVariant), 'set FOLIO_BOOTIMAGE_VARIANT to a, b or c');

const configs = {
	consumer: 'experiments/consumer/wrangler.jsonc',
	php: 'experiments/consumer/php/wrangler.jsonc',
	prepared: 'experiments/consumer/php/wrangler.prepared.jsonc',
	bootimage: `experiments/bootimage/wrangler.${bootVariant}.jsonc`
} as const;

const root = new URL('../', import.meta.url);
const extraction = kind === 'browser' && process.env.FOLIO_BROWSER_EXTRACTION === '1';
const creds = credentials();
const api = createApi(creds);
const name = `cfw-folio-${kind === 'cloud' ? '' : `${kind}-`}${crypto.randomUUID().slice(0, 8)}`;
const config = extraction
	? 'experiments/browser/extraction/wrangler.jsonc'
	: kind in configs
		? configs[kind as keyof typeof configs]
		: `experiments/${kind}/wrangler.jsonc`;
const consumerNames = (process.env.FOLIO_CONSUMER_RUNS ?? 'kernel-control,gmux-abi,tinyimg').split(
	','
);
const consumerPairs = Number(process.env.FOLIO_CONSUMER_PAIRS ?? 30);
const secret = crypto.randomUUID();
const { directory, save } = await openRun(kind, name);

const baseline = await snapshot(api);
await save('baseline.json', baseline);

if (kind === 'cloud') {
	// the token may lack billing scope; the run never changes a plan, and 57 calls cost under $0.003
	try {
		const subscriptions = await api('/subscriptions');
		await save(
			'plan.json',
			subscriptions.map((row: any) => ({ product: row.rate_plan?.id, state: row.state }))
		);
		assert.ok(
			!subscriptions.some(
				(row: any) =>
					row.state === 'enabled' &&
					/workers.*(paid|standard|bundled|unbound)/i.test(row.rate_plan?.id ?? '')
			),
			'paid Workers subscription detected'
		);
	} catch (error) {
		if (!String(error).includes('Authentication error')) throw error;
		await save('plan.json', {
			unavailable: 'token lacks billing scope',
			authorizedAccount: creds.label,
			marginalCostBoundUSD: 0.003
		});
	}
}

const subdomain = (await api('/workers/subdomain')).subdomain;
const url = `https://${name}.${subdomain}.workers.dev`;
await save('run.json', {
	name,
	kind,
	variant: extraction ? 'automatic-extraction' : kind === 'bootimage' ? bootVariant : 'original',
	url,
	startedAt: new Date().toISOString(),
	account: creds.label,
	budget: budgets[kind]
});
if (sourceFiles[kind].length) {
	execFileSync(
		'tar',
		[
			'--exclude=experiments/consumer/build',
			'--exclude=experiments/consumer/runs',
			'--exclude=experiments/bootimage/build',
			'--exclude=experiments/bootimage/runs',
			'-czf',
			new URL('source.tar.gz', directory).pathname,
			'src',
			'package.json',
			'experiments/lib',
			'experiments/deploy.ts',
			...(kind in configs ? [] : [`experiments/${kind}/worker.ts`]),
			config,
			...sourceFiles[kind],
			...(extraction
				? [
						'experiments/browser/extraction/worker.ts',
						'experiments/browser/extraction/prepare.ts',
						'experiments/browser/extraction/probe.ts',
						'experiments/browser/build/extraction-assets.json'
					]
				: [])
		],
		{ cwd: root }
	);
}
const log = (stage: string, extra: object = {}) =>
	console.log(JSON.stringify({ name, stage, ...extra }));
const meter = () => readMeter(creds.account, creds.token);
if (kind in configs) {
	const before = await meter();
	await save('meter-start.json', before);
	log('meter-start', before);
}
if (kind === 'bootimage')
	await save(
		'expected.json',
		JSON.parse(readFileSync(new URL('bootimage/build/expected.json', import.meta.url), 'utf8'))
	);
const wrangler = (args: string[], file: string, input?: string): Child =>
	spawnWrangler(creds, args, new URL(file, directory), { cwd: root, input });

log('baseline', { workers: baseline.scripts.length, namespaces: baseline.namespaces.length });
let tail: Child | undefined;
let attempted = false;
try {
	attempted = true; // cleanup also covers a partial deployment
	await wrangler(['deploy', '--config', config, '--name', name], 'deploy.log').done;
	if (kind !== 'cloud') {
		await wrangler(
			['secret', 'put', 'PROBE_TOKEN', '--config', config, '--name', name],
			'secret.log',
			`${secret}\n`
		).done;
		// a fresh workers.dev route can answer 404 for a while; 401 means the worker itself replied
		const readiness: { attempt: number; status: number }[] = [];
		const attempts = kind === 'bootimage' ? readinessAttempts : 20;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const check = await fetch(`${url}/run`, { signal: AbortSignal.timeout(10000) });
			readiness.push({ attempt, status: check.status });
			await check.body?.cancel();
			if (check.status === 401) break;
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		await save('readiness.json', readiness);
		assert.equal(readiness.at(-1)?.status, 401, 'deployed route did not become ready');
	}
	tail = wrangler(['tail', name, '--config', config, '--format', 'json'], 'tail.jsonl');
	void tail.done.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 5000));
	log('measure', { kind });
	if (kind === 'cloud') {
		const result = await collect(url);
		await save('result.json', result);
		console.log(JSON.stringify(result.summary));
	} else if (kind === 'consumer') {
		const requests = consumerNames.map(
			(consumer) => `consumer=${consumer}&pairs=${consumerPairs}`
		);
		const results = await runSessions(url, secret, requests, save, log, meter);
		assert.ok(
			results.length === requests.length && results.every((item) => item.passed),
			'a consumer session failed; raw results retained'
		);
	} else if (kind === 'php' || kind === 'prepared') {
		await runPhp(url, secret, kind, save, log, meter);
	} else if (kind === 'bootimage') {
		await runBootImage(url, secret, bootVariant as 'a' | 'b' | 'c', save, log, meter);
	} else {
		const began = performance.now();
		const response = await fetch(`${url}/run`, {
			method: 'POST',
			headers: { authorization: `Bearer ${secret}` },
			signal: AbortSignal.timeout(kind === 'browser' ? 105000 : 180000)
		});
		const body = await response.text();
		let result: any;
		try {
			result = JSON.parse(body);
		} catch {
			result = { error: body.slice(0, 4096) };
		}
		await save('response.json', {
			status: response.status,
			externalWallMs: performance.now() - began,
			result
		});
		await save('result.json', result);
		log('result', {
			status: response.status,
			passed: result.passed,
			error: result.error?.slice(0, 512)
		});
		assert.ok(response.ok && result.passed, 'deployed probe failed; raw result retained');
	}
	await new Promise((resolve) => setTimeout(resolve, 5000));
} finally {
	await stopTail(tail);
	if (attempted) {
		if ((await snapshot(api)).scripts.includes(name)) await retire(api, name, classesFor[kind]);
		const after = await snapshot(api);
		await save('after.json', after);
		if (kind in configs) {
			const end = await meter();
			await save('meter-end.json', end);
			log('meter-end', end);
		}
		assert.deepEqual(after, baseline, 'account resource baseline differs');
		log('cleanup', { baselineRestored: true });
	}
}
