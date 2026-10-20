import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

type Row = Record<string, any>;

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

export function summarizeBrowser(file: string, result: Row) {
	assert.equal(result.passed, true, result.error);
	assert.equal(result.crossOriginIsolated, true);
	assert.equal(result.sharedArrayBuffer, true);
	assert.equal(result.initialBytes, 256 * 1024 * 1024);
	assert.equal(result.finalBytes, result.initialBytes + 65536);
	assert.equal(result.attached.length, 8);
	assert.equal(new Set(result.attached.map((lane: Row) => lane.id)).size, 8);
	assert.equal(result.alias.atomics, 40000);
	for (const section of ['alias', 'copyControl', 'growth', 'creatorTermination']) {
		assert.equal(result[section].passed, true, section);
	}
	const arms = [0, 1, 2, 4, 8].map((width) => {
		const rows: Row[] = result.raw.filter(
			(row: Row) => row.phase === 'measured' && row.width === width
		);
		assert.equal(rows.length, 3);
		for (const row of rows) {
			assert.equal(row.outputExact, true);
			assert.equal(row.rounds, result.cpu.rounds);
			assert.equal(row.count, 64);
			assert.ok(row.wallMs > 0);
			assert.equal(row.lanes.length, width);
		}
		const ms = rows.map((row) => row.wallMs);
		return {
			width,
			samples: ms,
			medianMs: median(ms),
			minMs: Math.min(...ms),
			maxMs: Math.max(...ms)
		} as Row;
	});
	for (const arm of arms) {
		arm.speedupVsOwner = arms[0]!.medianMs / arm.medianMs;
		arm.speedupVsOneWorker = arms[1]!.medianMs / arm.medianMs;
	}
	return {
		file,
		environment: result.environment ?? 'managed-browser-run',
		userAgent: result.userAgent,
		hardwareConcurrency: result.hardwareConcurrency,
		jspi: result.jspi,
		arenaBytes: result.initialBytes,
		distinctAgents: result.attached.length,
		elapsedMs: result.elapsedMs,
		sessionWallMs: result.sessionWallMs,
		rounds: result.cpu.rounds,
		arms,
		aggregateCpuMeasured: false,
		verification:
			'native atomics and bidirectional alias; copied control isolated; all 64 CPU output words exact'
	};
}

if (import.meta.main) {
	const file = process.argv[2];
	assert.ok(file, 'Usage: node experiments/browser/analyze.ts result.json');
	const summary = summarizeBrowser(file, JSON.parse(await readFile(file, 'utf8')));
	console.log(JSON.stringify(summary, null, 2));
}
