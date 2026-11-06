import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire,
	spawnWrangler,
	stopTail
} from '../lib/cloudflare.ts';

const sourceDirectory = new URL('.', import.meta.url);
const directory = new URL(process.env.FOLIO_MANAGED_OUTPUT ?? './runs/', sourceDirectory);
await mkdir(directory, { recursive: true });
const creds = credentials({
	FREE_CLOUDFLARE_ACCOUNT_ID: process.env.FREE_CLOUDFLARE_ACCOUNT_ID,
	FREE_CLOUDFLARE_API_TOKEN: process.env.FREE_CLOUDFLARE_API_TOKEN
});
const api = createApi(creds);
const name = `folio-elastic-${crypto.randomUUID().slice(0, 8)}`;
const run = crypto.randomUUID(),
	secret = crypto.randomUUID();
const save = (path: string, value: unknown) =>
	writeFile(new URL(path, directory), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const budget = {
	clientRequestCap: 2000,
	doCallCap: 25000,
	logicalRowWriteCap: 16000,
	plannedDataPuts: 3072 * 3,
	plannedCleanupDeletedRows: 3072,
	expectedSpendUsd: 0,
	plan: 'Free',
	storageAmplification:
		'not measured; logical operations do not assert platform billed row totals'
};
await save('budget.json', budget);
const baseline = await inventory(api);
assert.ok(baseline.scripts && baseline.namespaces, 'account inventory unavailable');
await save('baseline.json', baseline);
let freePlan: unknown;
try {
	const subs = await api('/subscriptions');
	assert.ok(
		!subs.some(
			(row: any) =>
				row.state === 'enabled' &&
				/workers.*(paid|standard|bundled|unbound)/i.test(row.rate_plan?.id ?? '')
		),
		'paid Workers account refused'
	);
	freePlan = { verified: true };
} catch (error) {
	if (!String(error).includes('Authentication error')) throw error;
	freePlan = { verified: false, reason: 'known Free credential pair; billing scope unavailable' };
}
await save('plan.json', freePlan);
await copyFile(
	new URL(
		'../../results/execution/elastic-memory/managed-envelope/source/fixture.wasm',
		sourceDirectory
	),
	new URL('./fixture.wasm', directory)
);
const fixture = await readFile(new URL('./fixture.wasm', directory));
const source = await readFile(new URL('./worker.mjs', sourceDirectory));
await save('source.json', {
	name,
	run,
	wasmBytes: fixture.length,
	wasmSha256: createHash('sha256').update(fixture).digest('hex'),
	workerSha256: createHash('sha256').update(source).digest('hex')
});
const metadata = {
	main_module: 'worker.mjs',
	compatibility_date: '2026-10-20',
	bindings: [
		{ name: 'SECRET', type: 'plain_text', text: secret },
		{ name: 'EXECUTORS', type: 'durable_object_namespace', class_name: 'Executor' },
		{ name: 'PAGES', type: 'durable_object_namespace', class_name: 'PageOwner' }
	],
	migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['Executor', 'PageOwner'] }] }
};
const form = new FormData();
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
form.set('fixture.wasm', new Blob([fixture], { type: 'application/wasm' }), 'fixture.wasm');
let deployed = false,
	started = false;
let tail: ReturnType<typeof spawnWrangler> | undefined;
let requests = 0,
	doCalls = 0,
	rowWrites = 0,
	rowReads = 0,
	faultCount = 0,
	handoffs = 0;
let result: number | undefined, failure: string | undefined;
const segments: object[] = [],
	checks: object[] = [];
const began = performance.now();
let base = '';
async function once(path: string, body?: ArrayBuffer, expectedCalls = 1) {
	assert.ok(++requests <= budget.clientRequestCap, 'client request cap');
	doCalls += expectedCalls;
	assert.ok(doCalls <= budget.doCallCap, 'DO call cap');
	const at = performance.now();
	const response = await fetch(base + path, {
		method: body ? 'POST' : 'GET',
		body,
		headers: { authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(30000)
	});
	await appendFile(
		new URL('./requests.jsonl', directory),
		JSON.stringify({
			request: requests,
			path,
			status: response.status,
			wallMs: performance.now() - at,
			plannedDoCalls: expectedCalls
		}) + '\n'
	);
	return response;
}
async function ask(path: string, body?: ArrayBuffer, expectedCalls = 1) {
	for (let attempt = 0; ; attempt++) {
		const response = await once(path, body, expectedCalls);
		if (response.status !== 404 || attempt === 4) return response;
		await response.arrayBuffer();
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
}
try {
	await api(`/workers/scripts/${name}`, { method: 'PUT', body: form });
	deployed = true;
	await api(`/workers/scripts/${name}/subdomain`, {
		method: 'POST',
		body: JSON.stringify({ enabled: true }),
		headers: { 'content-type': 'application/json' }
	});
	const subdomain = (await api('/workers/subdomain')).subdomain;
	base = `https://${name}.${subdomain}.workers.dev`;
	let ready = false;
	for (let attempt = 0; attempt < 30 && !ready; attempt++) {
		const response = await ask('/ready');
		ready = response.ok;
		if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	assert.ok(ready, 'Worker did not become ready');
	await new Promise((resolve) => setTimeout(resolve, 15000));
	tail = spawnWrangler(
		creds,
		['tail', name, '--format', 'json', '--sampling-rate', '1'],
		new URL('./tail.log', directory),
		{ cwd: new URL('../../', sourceDirectory) }
	);
	tail.done.catch(() => {});
	let checkpoint: ArrayBuffer | undefined,
		completion = 0;
	started = true;
	for (;;) {
		const query = new URLSearchParams({
			pages: '3072',
			segment: '16',
			run,
			lane: String(handoffs % 2),
			resume: checkpoint ? '1' : '0',
			completion: String(completion)
		});
		const response = await ask(`/run?${query}`, checkpoint, 17);
		if (!response.ok) {
			failure = `run HTTP ${response.status}`;
			await save('failure-body.json', {
				status: response.status,
				body: await response.text()
			});
			break;
		}
		if (response.headers.get('content-type')?.includes('application/json')) {
			const body: any = await response.json();
			result = body.result;
			faultCount += body.faults;
			rowWrites += body.rowWrites;
			rowReads += body.rowReads;
			segments.push({ done: true, ...body });
			break;
		}
		completion = Number(response.headers.get('x-completion'));
		faultCount += Number(response.headers.get('x-faults'));
		rowWrites += Number(response.headers.get('x-row-writes'));
		rowReads += Number(response.headers.get('x-row-reads'));
		assert.ok(rowWrites + 3072 < budget.logicalRowWriteCap, 'logical row budget');
		checkpoint = await response.arrayBuffer();
		assert.equal(checkpoint.byteLength, 65536);
		segments.push({
			done: false,
			faults: Number(response.headers.get('x-faults')),
			wasmBytes: Number(response.headers.get('x-wasm-bytes')),
			bytes: checkpoint.byteLength
		});
		handoffs++;
		if (handoffs % 64 === 0)
			console.log(
				JSON.stringify({ phase: 'executing', handoffs, faultCount, rowWrites, requests })
			);
	}
	if (!failure) {
		let expected = 0;
		for (let k = 0; k < 3072; k++)
			expected = Math.imul(expected, 31) ^ (Math.imul((k * 17) % 3072, 1664525) ^ 1013904223);
		assert.equal(result, expected);
		assert.equal(faultCount, 15360);
		for (let owner = 0; owner < 4; owner++) {
			const response = await ask(`/verify?run=${run}&owner=${owner}&pages=3072`);
			assert.ok(response.ok, `verify HTTP ${response.status}`);
			const body: any = await response.json();
			assert.equal(body.exact, true);
			assert.equal(body.checkedPages, 768);
			checks.push(body);
		}
	}
} catch (error) {
	failure = String(error);
} finally {
	if (deployed && started && base)
		for (let owner = 0; owner < 4; owner++) {
			try {
				const response = await ask(`/clear?run=${run}&owner=${owner}`);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
			} catch (error) {
				await appendFile(
					new URL('./cleanup-errors.jsonl', directory),
					JSON.stringify({ owner, error: String(error) }) + '\n'
				);
			}
		}
	await stopTail(tail);
	if (deployed) await retire(api, name, ['Executor', 'PageOwner']);
	let after = await inventory(api);
	let differences = inventoryDiff(
		baseline,
		after,
		(entry) => entry.name === name || entry.script === name
	);
	for (let poll = 0; differences.some((row) => row.mine) && poll < 12; poll++) {
		await new Promise((resolve) => setTimeout(resolve, 2500));
		after = await inventory(api);
		differences = inventoryDiff(
			baseline,
			after,
			(entry) => entry.name === name || entry.script === name
		);
	}
	await save('after.json', after);
	await save('cleanup.json', {
		differences,
		ownResourcesRestored: differences.every((row) => !row.mine)
	});
}
await save('raw.json', {
	kind: 'managed-free-elastic-memory',
	source: 'source.json',
	budget,
	logicalMiB: 192,
	physicalExecutorWasmBytes: 65536,
	segment: 16,
	result,
	failure,
	exact: !failure && checks.length === 4,
	requests,
	plannedDoCalls: doCalls,
	rowWrites,
	rowReads,
	faultCount,
	handoffs,
	checkpointBytes: handoffs * 65536,
	segments,
	checks,
	wallMs: performance.now() - began,
	limitations: [
		'billed CPU and peak memory require telemetry',
		'logical row counts exclude internal amplification',
		'one fixture, client-driven continuation, not a durable execution root or PHP render'
	]
});
console.log(
	JSON.stringify({
		phase: 'finished',
		exact: !failure && checks.length === 4,
		failure,
		handoffs,
		faultCount,
		requests
	})
);
