import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Produces a credential-free record directly from one retained browser extraction run. */
export function summarizeExtraction(directory: string) {
	const read = (file: string) => readFileSync(join(directory, file));
	const run = JSON.parse(read('run.json').toString());
	const result = JSON.parse(read('result.json').toString());
	const baseline = JSON.parse(read('baseline.json').toString());
	const after = JSON.parse(read('after.json').toString());
	assert.deepEqual(after, baseline);
	assert.equal(result.passed, true);
	assert.equal(result.kind, 'browser-automatic-counted-loop');
	assert.equal(result.initialBytes, 256 * 1024 * 1024);
	assert.equal(result.closedPools, 4);
	const median = (values: number[]) =>
		[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
	const arms = [0, 1, 2, 4, 8].map((width) => {
		const rows = result.raw.filter(
			(row: any) => row.phase === 'measured' && row.width === width
		);
		assert.equal(rows.length, 3);
		for (const row of rows) {
			assert.equal(row.fullMemoryExact, true);
			assert.equal(row.returnExact, true);
			assert.equal(row.workers, width > 1 ? width : 0);
		}
		const samples: number[] = rows.map((row: any) => row.wallMs);
		return { width, samples, medianMs: median(samples), speedupVsOwner: 0 };
	});
	for (const arm of arms) arm.speedupVsOwner = arms[0]!.medianMs / arm.medianMs;
	return {
		run: basename(directory),
		account: run.account,
		variant: run.variant,
		passed: true,
		baselineRestored: true,
		baselineCounts: {
			workers: baseline.scripts.length,
			namespaces: baseline.namespaces.length
		},
		sourceArchiveSha256: createHash('sha256').update(read('source.tar.gz')).digest('hex'),
		userAgent: result.userAgent,
		hardwareConcurrency: result.hardwareConcurrency,
		jspi: result.jspi,
		jspiOriginallyAvailable: result.jspiOriginallyAvailable,
		jspiDisabledForProbe: result.jspiDisabledForProbe,
		arenaBytes: result.initialBytes,
		growth: result.growth,
		coverage: result.coverage,
		sessionWallMs: result.sessionWallMs,
		elapsedMs: result.elapsedMs,
		count: result.count,
		rounds: result.rounds,
		arms,
		aggregateCpuMeasured: false,
		energyMeasured: false,
		verification: {
			fullMemoryAndReturnExactCalls: result.raw.filter(
				(row: any) => row.phase !== 'calibration'
			).length,
			closedPools: result.closedPools
		},
		raw: result.raw
	};
}

if (import.meta.main) {
	const [directory, output] = process.argv.slice(2);
	if (!directory || !output) throw new Error('usage: analyze.ts RUN_DIRECTORY OUTPUT.json');
	writeFileSync(output, JSON.stringify(summarizeExtraction(directory), null, 2) + '\n');
}
