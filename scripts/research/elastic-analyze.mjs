import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const study = resolve(
	process.env.FOLIO_ELASTIC_STUDY ?? 'results/execution/elastic-memory/capacity-local'
);
const read = (name) => JSON.parse(readFileSync(join(study, name), 'utf8'));
const run = read('raw.json'),
	full = read('full-scan.json'),
	compiled = read('compiled.json'),
	native = read('native.json');
const backing = read('backing-verification.json');
assert.equal(backing.rows.length, 3);
for (const row of backing.rows) {
	assert.equal(row.bytesVerified, 2147483648);
	assert.equal(row.pagesVerified, 32768);
	assert.equal(row.sha256, run.backingSha256);
	assert.equal(row.exact, true);
}
for (const [artifact, prefix] of [
	[run, 'source-final/'],
	[full, 'source-full-scan/']
]) {
	for (const source of artifact.sources) {
		const bytes = readFileSync(join(study, prefix + source.path));
		assert.equal(bytes.length, source.bytes);
		assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
	}
}
assert.equal(run.rows.length, 15);
assert.equal(full.rows.length, 1);
assert.equal(compiled.rows.length, 3);
assert.equal(native.rows.length, 2);
assert.ok([...run.rows, ...full.rows, ...compiled.rows, ...native.rows].every((r) => r.exact));
for (const row of [...run.rows, ...full.rows, ...compiled.rows])
	assert.equal(row.value, row.expected);
for (const [file, expected] of [
	['guest.wasm', compiled.originalSha256],
	['elastic.wasm', compiled.transformedSha256]
]) {
	const bytes = readFileSync(join(study, 'source-compiled', file));
	assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
}
for (const row of native.rows) {
	assert.equal(row.actual, row.expected);
	assert.equal(row.actual, compiled.rows.find((c) => c.logicalMiB === row.logicalMiB).value);
	assert.equal(row.comparedBytes, row.logicalMiB * 1048576);
	assert.equal(row.comparedPages, row.logicalMiB * 16);
}
for (const row of run.rows.filter((r) => r.mode.startsWith('elastic'))) {
	assert.ok(row.segments.every((s) => s.stats.wasmBytes === 327680));
	assert.ok(row.sampledHeapMax < 32 * 1048576);
}
assert.equal(
	full.rows[0].segments.reduce((sum, s) => sum + s.stats.fetchedPages, 0),
	32768
);
assert.equal(full.rows[0].fetchBytes, 2147483648);
for (const row of compiled.rows)
	assert.ok(row.segments.every((s) => s.wasmBytes === 131072 && s.cacheMax <= 4));
const o1 = run.rows
	.filter((r) => r.mode === 'elastic' && r.working === 4)
	.map((r) => ({
		logicalMiB: r.mib,
		executorWasmBytes: r.segments[0].stats.wasmBytes,
		sampledHeapMax: r.sampledHeapMax,
		checkpointBytes: r.checkpointBytes,
		fetchBytes: r.fetchBytes,
		exact: r.exact
	}));
const o2 = run.rows
	.filter((r) => r.working === 4 && r.mib <= 512)
	.map((r) => ({
		mode: r.mode,
		logicalMiB: r.mib,
		wasmBytes: r.segments[0].stats.wasmBytes,
		checkpointBytes: r.checkpointBytes,
		fetchBytes: r.fetchBytes,
		totalPayloadBytes: r.totalPayloadBytes,
		checkpointCopyMs: r.segments[0].copyMs,
		faults: r.segments.reduce((sum, s) => sum + s.stats.faults, 0),
		wallMs: r.wallMs
	}));
const compiledRows = compiled.rows.map((r) => ({
	logicalMiB: r.logicalMiB,
	exact: r.exact,
	freshExecutorIsolates: r.freshExecutorIsolates,
	checkpointBytes: r.checkpointBytes,
	executorWasmBytes: r.segments[0].wasmBytes,
	cachePages: Math.max(...r.segments.map((s) => s.cacheMax)),
	sampledHeapMax: Math.max(...r.segments.map((s) => s.heapMax)),
	fetchBytes: r.segments.reduce((sum, s) => sum + s.readBytes, 0),
	writebackBytes: r.segments.reduce((sum, s) => sum + s.writeBytes, 0),
	dirtyPagesVerified: r.dirtyPagesVerified
}));
const result = {
	o1,
	o2,
	fullScan: {
		logicalMiB: full.rows[0].mib,
		executorWasmBytes: full.rows[0].segments[0].stats.wasmBytes,
		sampledHeapMax: full.rows[0].sampledHeapMax,
		fetchedPages: 32768,
		fetchBytes: full.rows[0].fetchBytes,
		checkpointBytes: full.rows[0].checkpointBytes,
		totalPayloadBytes: full.rows[0].totalPayloadBytes,
		value: full.rows[0].value,
		exact: full.rows[0].exact
	},
	thrashing: run.rows
		.filter((r) => r.working === 128)
		.map((r) => ({
			mode: r.mode,
			logicalMiB: r.mib,
			totalPayloadBytes: r.totalPayloadBytes,
			fetchBytes: r.fetchBytes,
			checkpointBytes: r.checkpointBytes,
			exact: r.exact
		})),
	mutable: run.rows
		.filter((r) => r.mode === 'elastic-write')
		.map((r) => ({
			logicalMiB: r.mib,
			dirtyPagesVerified: r.dirtyPagesVerified,
			fetchBytes: r.fetchBytes,
			writebackBytes: r.writebackBytes,
			checkpointBytes: r.checkpointBytes,
			totalPayloadBytes: r.totalPayloadBytes,
			exact: r.exact
		})),
	compiled: compiledRows,
	native: native.rows,
	backing: backing.rows,
	checks: {
		cases: run.rows.length + full.rows.length + compiled.rows.length + native.rows.length,
		allExact: true,
		nativeComparedBytes: native.rows.reduce((sum, r) => sum + r.comparedBytes, 0),
		archivedSourceHashes: true,
		compiledModuleHashes: true
	},
	interpretation: [
		'fixed executor Wasm memory and bounded sampled heap through 2GiB logical state',
		'constant transfer is shared with post-copy/lazy controls; not a novel property by itself',
		'four-frame thrashing increases transfer; no universal speedup',
		'local process RSS and memoryUsage counters are not managed isolate peak memory'
	],
	limitations: run.limitations
};
writeFileSync(join(study, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ o1, o2, compiled: compiledRows, checks: result.checks }, null, 2));
