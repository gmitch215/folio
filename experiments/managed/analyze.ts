import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

type Row = Record<string, any>;

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const stats = (values: number[]) => ({
	median: median(values),
	minimum: Math.min(...values),
	maximum: Math.max(...values)
});

export function summarizeManaged(path: string, raw: Buffer) {
	const result = JSON.parse(raw.toString());
	assert.equal(result.passed, true, result.error);
	assert.equal(result.jspi, true);
	assert.equal(result.rows.length, 39);
	assert.equal(result.discardedSamples, 0);
	assert.ok(
		result.rows.every((row: Row) => row.exact && row.checkedBytes === 131072 && row.wallMs > 0)
	);
	const measured: Row[] = result.rows.filter((row: Row) => row.phase === 'measured');
	const serial = measured.filter((row) => row.mode === 'serial');
	const arms = [];
	for (const mode of ['rpc', 'fetch', 'stream', 'websocket']) {
		for (const width of [2, 4, 8]) {
			const rows = measured.filter((row) => row.mode === mode && row.width === width);
			assert.equal(rows.length, 2);
			assert.ok(
				rows.every(
					(row) =>
						row.report.workers === width &&
						row.report.regions === 64 &&
						row.report.fallbacks === 0 &&
						row.report.replayed === 0 &&
						row.report.transportFallbacks === 0
				)
			);
			arms.push({
				mode,
				width,
				wallMs: stats(rows.map((row) => row.wallMs)),
				pairedSpeedup: stats(
					rows.map(
						(row) =>
							serial.find((other) => other.iteration === row.iteration)!.wallMs /
							row.wallMs
					)
				),
				isolateCounts: rows.map(
					(row) => new Set(row.identities.map((lane: Row) => lane.isolate)).size
				),
				sentBytes: rows.map((row) => row.report.transportBytes.sent),
				receivedBytes: rows.map((row) => row.report.transportBytes.received),
				snapshotBytes: rows.map((row) => row.report.snapshotBytes)
			});
		}
	}
	return {
		resultPath: path,
		rawSha256: createHash('sha256').update(raw).digest('hex'),
		sourceSha256: result.sourceSha256,
		measured: measured.length,
		warmups: result.rows.length - measured.length,
		discarded: 0,
		allWholeMemoryAndScalarExact: true,
		jspi: true,
		serialWallMs: stats(serial.map((row) => row.wallMs)),
		aggregateCpuMeasured: false,
		preparationIncludedInWallTime: result.preparationIncludedInWallTime ?? false,
		byteAccounting: 'encoded payloads and snapshots; platform internal copies are unobservable',
		arms
	};
}

if (import.meta.main) {
	const [path, output] = process.argv.slice(2);
	assert.ok(path, 'supply result.json');
	const summary = summarizeManaged(path, await readFile(path));
	if (output) await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
	console.log(JSON.stringify(summary, null, 2));
}
