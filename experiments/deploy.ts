import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { collect } from './cloud/run.ts';
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
assert.ok(isKind(kind), 'usage: node experiments/deploy.ts cloud|managed|browser');

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
	}
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
	]
};

const root = new URL('../', import.meta.url);
const creds = credentials();
const api = createApi(creds);
const name = `cfw-folio-${kind === 'cloud' ? '' : `${kind}-`}${crypto.randomUUID().slice(0, 8)}`;
const config = `experiments/${kind}/wrangler.jsonc`;
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
	url,
	startedAt: new Date().toISOString(),
	account: creds.label,
	budget: budgets[kind]
});
if (sourceFiles[kind].length) {
	execFileSync(
		'tar',
		[
			'-czf',
			new URL('source.tar.gz', directory).pathname,
			'src',
			'package.json',
			'experiments/lib',
			'experiments/deploy.ts',
			`experiments/${kind}/worker.ts`,
			config,
			...sourceFiles[kind]
		],
		{ cwd: root }
	);
}
const log = (stage: string, extra: object = {}) =>
	console.log(JSON.stringify({ name, stage, ...extra }));
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
		for (let attempt = 0; attempt < 20; attempt++) {
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
		assert.deepEqual(after, baseline, 'account resource baseline differs');
		log('cleanup', { baselineRestored: true });
	}
}
