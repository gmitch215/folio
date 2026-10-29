import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readMeter } from '../../consumer/drive.ts';
import {
	createApi,
	openRun,
	retire,
	snapshot,
	spawnWrangler,
	stopTail,
	type Child
} from '../../lib/cloudflare.ts';

const root = new URL('../../../', import.meta.url);
const config = 'experiments/managed/phases/wrangler.jsonc';
const account = process.env.FREE_CLOUDFLARE_ACCOUNT_ID;
const token = process.env.FREE_CLOUDFLARE_API_TOKEN;
assert.ok(account && token, 'Free account credentials are required');
const creds = { account, token, label: 'FREE' as const };
const api = createApi(creds);
const name = `cfw-folio-phases-${crypto.randomUUID().slice(0, 8)}`;
const secret = crypto.randomUUID();
const { directory, save } = await openRun('managed', name);
const wrangler = (args: string[], file: string, input?: string) =>
	spawnWrangler(creds, args, new URL(file, directory), { cwd: root, input });
const baseline = await snapshot(api);
await save('baseline.json', baseline);
await save('meter-before.json', await readMeter(account, token));
const source = () =>
	execFileSync(
		process.execPath,
		[
			'-e',
			"import {researchEnvironment} from './scripts/research/environment.ts'; console.log(JSON.stringify(researchEnvironment({study:'managed-phases'})))"
		],
		{ cwd: root, encoding: 'utf8' }
	);
const environment = JSON.parse(source());
const files = [
	config,
	'experiments/managed/phases/worker.ts',
	'experiments/managed/phases/drive.ts',
	'experiments/managed/artifact.ts',
	'experiments/managed/build/original.wasm',
	'experiments/managed/build/coordinator.wasm',
	'experiments/managed/build/transactional.wasm'
];
const sources = files.map((path) => {
	const bytes = readFileSync(new URL(path, root));
	return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
await save('source.json', { environment, sources });
execFileSync(
	'tar',
	[
		'-czf',
		new URL('source.tar.gz', directory).pathname,
		'src',
		'experiments/managed/phases',
		'experiments/managed/artifact.ts',
		'experiments/managed/build',
		'experiments/lib/cloudflare.ts',
		'package.json'
	],
	{ cwd: root }
);
await save('run.json', {
	name,
	startedAt: new Date().toISOString(),
	account: 'FREE',
	budget: {
		maximumRequests: 1200,
		sqlCalls: 0,
		temporaryScripts: 1,
		classes: 2,
		maximumObjects: 114,
		maximumMinutes: 10,
		expectedCharges: 0
	}
});
const rows: unknown[] = [];
const subdomain = (await api('/workers/subdomain')).subdomain;
const url = `https://${name}.${subdomain}.workers.dev`;
let attempted = false,
	tail: Child | undefined;
let externalCalls = 0;
const call = async (input: Record<string, unknown>) => {
	assert.ok(++externalCalls < 400, 'external request budget exceeded');
	const began = performance.now();
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(60000)
		});
		const result = await response.json();
		const row = {
			...input,
			status: response.status,
			wallMs: performance.now() - began,
			...(result as object)
		};
		rows.push(row);
		return row as any;
	} catch (error) {
		const row = {
			...input,
			status: 0,
			wallMs: performance.now() - began,
			passed: false,
			error: String(error)
		};
		rows.push(row);
		return row;
	}
};
try {
	attempted = true;
	await wrangler(['deploy', '--config', config, '--name', name], 'deploy.log').done;
	await wrangler(
		['secret', 'put', 'PROBE_TOKEN', '--config', config, '--name', name],
		'secret.log',
		`${secret}\n`
	).done;
	const readiness: number[] = [];
	for (let attempt = 0; attempt < 20; attempt++) {
		const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
		readiness.push(response.status);
		await response.body?.cancel();
		if (response.status === 401) break;
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	await save('readiness.json', readiness);
	assert.equal(readiness.at(-1), 401, 'route not ready');
	tail = wrangler(['tail', name, '--config', config, '--format', 'json'], 'tail.jsonl');
	void tail.done.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 5000));
	for (let step = 0; step < 3; step++) {
		await new Promise((resolve) => setTimeout(resolve, 20000));
		console.log(
			JSON.stringify({ study: 'managed-phases', propagationWaitMs: (step + 1) * 20000 })
		);
	}
	let cell = 0;
	// operations are counted per invocation so first-use and steady-state CPU come from differences between counts
	const measureOperations = async () => {
		const plan = [2, 128].flatMap((pages) =>
			[true, false].flatMap((serial) =>
				[0, 1, 5].flatMap((operations) =>
					[0, 1, 2].map((repeat) => ({ pages, serial, operations, repeat }))
				)
			)
		);
		let state = 0x2545f491;
		for (let index = plan.length - 1; index > 0; index--) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			const other = state % (index + 1);
			[plan[index], plan[other]] = [plan[other]!, plan[index]!];
		}
		const width = Number(process.env.FOLIO_PHASE_WIDTHS ?? 4);
		for (const item of plan) {
			const key = `cell-${cell++}-${crypto.randomUUID().slice(0, 8)}`;
			await call({
				...item,
				key,
				width,
				action: 'measure',
				tag: `${key}-cell`,
				config: { key, pages: item.pages, width, count: 64, rounds: 2097152 }
			});
			console.log(JSON.stringify({ study: 'managed-phases', cell, total: plan.length }));
			await save(`checkpoint-${cell}.json`, { rows });
		}
	};
	const measure = process.env.FOLIO_PHASE_ENTRY === 'measure';
	const pageCounts = measure
		? []
		: (process.env.FOLIO_PHASE_PAGES ?? '2,32,128').split(',').map(Number);
	const widths = (process.env.FOLIO_PHASE_WIDTHS ?? '1,2,4,8').split(',').map(Number);
	if (measure) await measureOperations();
	for (const pages of pageCounts) {
		for (const width of widths) {
			for (const serial of [true, false]) {
				const key = `cell-${cell++}-${crypto.randomUUID().slice(0, 8)}`;
				const base = { key, pages, width, serial };
				if (process.env.FOLIO_PHASE_ENTRY !== 'separate') {
					const result = await call({
						...base,
						action:
							process.env.FOLIO_PHASE_ENTRY === 'held'
								? 'cell'
								: process.env.FOLIO_PHASE_ENTRY === 'reentrant'
									? 'reentrant'
									: 'direct',
						tag: `${key}-cell`,
						config: { key, pages, width, count: 64, rounds: 2097152 }
					});
					if (result.passed) {
						for (const row of result.result.rows) rows.push({ ...base, ...row });
					}
					console.log(
						JSON.stringify({
							study: 'managed-phases',
							cell,
							total: 24,
							failures: rows.filter((row: any) => !row.passed).length
						})
					);
					await save(`checkpoint-${cell}.json`, { rows });
					continue;
				}
				const setup = await call({
					...base,
					action: 'setup',
					tag: `${key}-setup`,
					config: { key, pages, width, count: 64, rounds: 2097152 }
				});
				if (setup.passed) {
					for (let iteration = 0; iteration < 4; iteration++) {
						const result = await call({
							...base,
							action: 'operation',
							iteration,
							tag: `${key}-op-${iteration}`
						});
						if (!result.passed) break;
					}
					for (const phase of ['copy', 'transport'])
						await call({ ...base, action: 'phase', phase, tag: `${key}-${phase}` });
				}
				await call({ ...base, action: 'close', tag: `${key}-close` });
				console.log(
					JSON.stringify({
						study: 'managed-phases',
						cell,
						total: 24,
						failures: rows.filter((row: any) => !row.passed).length
					})
				);
				await save(`checkpoint-${cell}.json`, { rows });
			}
		}
	}
	await save('result.json', {
		rows,
		externalCalls,
		entryMode:
			process.env.FOLIO_PHASE_ENTRY === 'measure'
				? 'measure'
				: process.env.FOLIO_PHASE_ENTRY === 'separate'
					? 'separate'
					: process.env.FOLIO_PHASE_ENTRY === 'held'
						? 'held-cell'
						: process.env.FOLIO_PHASE_ENTRY === 'reentrant'
							? 'reentrant'
							: 'direct',
		discardedSamples: 0
	});
	await new Promise((resolve) => setTimeout(resolve, 10000));
} finally {
	await stopTail(tail);
	if (attempted) {
		const namespaces: { script: string }[] = await api('/workers/durable_objects/namespaces');
		if (namespaces.some((row) => row.script === name))
			await retire(api, name, ['PhaseLane', 'PhaseOwner']);
		else await api(`/workers/scripts/${name}`, { method: 'DELETE' });
	}
	const after = await snapshot(api);
	await save('after.json', after);
	await save('meter-after.json', await readMeter(account, token));
	await save('final.json', {
		externalCalls,
		rows,
		sourceAfter: JSON.parse(source()),
		baselineRestored: JSON.stringify(after) === JSON.stringify(baseline)
	});
	console.log(
		JSON.stringify({
			study: 'managed-phases',
			name,
			baselineRestored: JSON.stringify(after) === JSON.stringify(baseline),
			externalCalls
		})
	);
	assert.deepEqual(after, baseline, 'account baseline changed');
}
