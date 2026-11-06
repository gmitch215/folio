import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { events } from '../../experiments/cloud/analyze-tail.ts';

const root = resolve(
	process.env.FOLIO_ELASTIC_STUDY ?? 'results/execution/elastic-memory/managed-envelope'
);
const tailPath = process.env.FOLIO_ELASTIC_TAIL;
const read = async (file: string): Promise<any> =>
	JSON.parse(await readFile(join(root, file), 'utf8'));
const raw = await read('raw.json');
assert.equal(raw.exact, true);
assert.equal(raw.logicalMiB, 192);
assert.equal(raw.faultCount, 15360);
assert.equal(raw.handoffs, 960);
assert.equal(raw.segments.length, 961);
assert.equal(raw.rowWrites, 9216);
assert.equal(raw.rowReads, 6144);
assert.ok(raw.segments.every((row: any) => row.wasmBytes === 65536));
assert.equal(raw.checks.length, 4);
assert.ok(
	raw.checks.every(
		(row: any) => row.exact && row.checkedPages === 768 && row.checkedBytes === 50331648
	)
);
assert.equal(
	raw.checks.reduce((sum: number, row: any) => sum + row.checkedBytes, 0),
	201326592
);
assert.equal((await read('cleanup.json')).ownResourcesRestored, true);
assert.equal((await read('first-run/cleanup-later.json')).ownResourcesRestored, true);
const sources = await read('source/sources.json');
for (const row of sources.files) {
	const bytes = await readFile(join(root, 'source', row.path));
	assert.equal(bytes.length, row.bytes);
	assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
}
const manifest = await read('source.json');
assert.equal(
	manifest.workerSha256,
	sources.files.find((row: any) => row.path === 'worker.mjs').sha256
);
assert.equal(
	manifest.wasmSha256,
	sources.files.find((row: any) => row.path === 'fixture.wasm').sha256
);
const requests = (await readFile(join(root, 'requests.jsonl'), 'utf8'))
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));
assert.equal(requests.length, 971);
const statuses = requests.reduce(
	(out: Record<string, number>, row: any) => (
		(out[row.status] = (out[row.status] ?? 0) + 1),
		out
	),
	{}
);
assert.deepEqual(statuses, { 200: 970, 404: 1 });
const runRequests = requests.filter((row: any) => row.path.startsWith('/run?'));
assert.equal(runRequests.length, 961);
assert.equal(
	requests.filter((row: any) => row.path.startsWith('/clear?') && row.status === 200).length,
	4
);
if (!tailPath) throw new Error('set FOLIO_ELASTIC_TAIL to the unpromoted tail-valid.log');
const tail: any[] = events(await readFile(tailPath, 'utf8'));
const models = tail.reduce(
	(out: Record<string, number>, row: any) => (
		(out[row.executionModel] = (out[row.executionModel] ?? 0) + 1),
		out
	),
	{}
);
const outcomes = tail.reduce(
	(out: Record<string, number>, row: any) => (
		(out[row.outcome] = (out[row.outcome] ?? 0) + 1),
		out
	),
	{}
);
const metrics = await read('metrics-do-final.json');
assert.equal(metrics.status, 200);
assert.equal(metrics.body.errors, null);
const namespace = metrics.body.data.viewer.accounts[0];
const roleMetrics = metrics.roles.map((row: any) => ({
	role: row.class,
	...namespace[row.alias][0]
}));
const executor = roleMetrics.find((row: any) => row.role === 'Executor');
const owner = roleMetrics.find((row: any) => row.role === 'PageOwner');
assert.equal(executor.sum.subrequests, 15360);
assert.equal(owner.sum.rowsWritten, 9216);
assert.equal(owner.sum.rowsRead, 9216);
assert.ok(
	roleMetrics.every(
		(row: any) => row.sum.exceededCpuErrors === 0 && row.sum.exceededMemoryErrors === 0
	)
);
const runMs = runRequests.reduce((sum: number, row: any) => sum + row.wallMs, 0);
const summary = {
	exact: true,
	logicalBytes: 201326592,
	verifiedPages: 3072,
	verifiedBytes: 201326592,
	executorWasmBytesEachSegment: 65536,
	executorObjects: 2,
	ownerObjects: 4,
	ownerApplicationCacheBytesEach: 65536,
	physicalIsolateCount: null,
	faults: 15360,
	segments: 961,
	handoffs: 960,
	clientAttempts: 971,
	statuses,
	programOwnerCalls: 15360,
	programExecutorCalls: 961,
	diagnosticsAndCleanupOwnerCalls: 8,
	dataPuts: 9216,
	logicalCleanupDeletedPages: 3072,
	logicalLoadOperations: 6144,
	checkpointResponseBytes: 62914560,
	checkpointResumeRequestBytes: 62914560,
	checkpointPayloadBothDirections: 125829120,
	clientRunHeadersWallMs: runMs,
	totalRunnerWallMs: raw.wallMs,
	wallScope:
		'request log timers stop at response headers; runner wall includes deploy/readiness/15-second wait/verification/cleanup',
	roleMetrics,
	metricScope:
		'namespace periodic whole-isolate samples; no absolute peak or placement guarantee; cleanup billing accounting unreconciled',
	tail: {
		events: tail.length,
		models,
		outcomes,
		cpuMsSum: tail.reduce((sum: number, row: any) => sum + row.cpuTime, 0)
	},
	cleanupBaselineRestored: true,
	firstAttemptPartialAndPropagation404Retained: true,
	frozenSourceManifest: 'propagation/source/sources.json',
	limits: [
		'Fixture supports aligned i32 load/store and whole-page fill only',
		'Client-driven fresh top-level HTTP continuation chain; not one original request',
		'External SQLite backing; no physical shared-memory or parallel CPU proof',
		'No PHP or arbitrary-program proof',
		'Known Free credentials; subscription API billing scope unavailable'
	]
};
let existing;
try {
	existing = await read('summary.json');
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (existing) assert.deepEqual(existing, summary);
else
	await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {
		flag: 'wx'
	});
console.log(JSON.stringify(summary, null, 2));
