import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

const median = (values: number[]) => stats(values).median!;

// splits the uncached Drupal render into host SQL, ROM inflate, lazy Wasm compile and PHP execution
export function summarizeBreakdown(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length > 0, 'no samples');
	assert.equal(new Set(samples.map((row) => row.sha256)).size, 1, 'render outputs differ');
	const modes: Record<string, unknown> = {};
	for (const mode of new Set(samples.map((row) => row.mode))) {
		const group = samples.filter((row) => row.mode === mode);
		const field = (rowsIn: Row[], key: (r: Row) => number) => stats(rowsIn.map(key));
		const part = (rowsIn: Row[]) => {
			const wall = median(rowsIn.map((r) => r.renderWallMs));
			const sql = median(rowsIn.map((r) => r.sqlMs));
			const inflate = median(rowsIn.map((r) => r.inflateMs));
			return {
				n: rowsIn.length,
				renderWallMs: field(rowsIn, (r) => r.renderWallMs),
				sqlMs: field(rowsIn, (r) => r.sqlMs),
				sqlCalls: median(rowsIn.map((r) => r.sqlCalls)),
				inflateMs: field(rowsIn, (r) => r.inflateMs),
				inflateCalls: median(rowsIn.map((r) => r.inflateCalls)),
				inflateBytes: median(rowsIn.map((r) => r.inflateBytes)),
				phpExecutionMs: median(rowsIn.map((r) => r.renderWallMs - r.sqlMs - r.inflateMs)),
				sqlShare: sql / wall,
				inflateShare: inflate / wall,
				renderThreadCpuMs: field(rowsIn, (r) => r.renderThreadCpuMs),
				otherThreadCpuMs: field(rowsIn, (r) => r.renderProcessCpuMs - r.renderThreadCpuMs),
				openMs: field(rowsIn, (r) => r.openMs),
				seedMs: field(rowsIn, (r) => r.boot.seedMs),
				phpBootMs: field(rowsIn, (r) => r.boot.phpBootMs),
				drupalBootMs: field(rowsIn, (r) => r.boot.drupalBootMs)
			};
		};
		const cold = group.filter((r) => r.instance === 0);
		const warm = group.filter((r) => r.instance >= 2);
		const coldPart = part(cold);
		const warmPart = part(warm);
		modes[mode] = {
			cold: coldPart,
			warm: warmPart,
			lazyCompileMs: coldPart.renderWallMs.median! - warmPart.renderWallMs.median!,
			lazyCompileShareOfCold:
				(coldPart.renderWallMs.median! - warmPart.renderWallMs.median!) /
				coldPart.renderWallMs.median!,
			byInstance: Object.fromEntries(
				[...new Set(group.map((r) => r.instance))].map((k) => [
					k,
					stats(group.filter((r) => r.instance === k).map((r) => r.renderWallMs))
				])
			)
		};
	}
	return { environment, measuredSamples: samples.length, modes, hash };
}

/** bytes per extra context from memory rows: (RSS at count N minus RSS at count 1) / (N - 1) */
export function summarizeMemory(rows: Row[]) {
	const memory = rows.filter((row) => row.kind === 'memory');
	const out: Record<string, unknown> = {};
	for (const key of new Set(memory.map((r) => `${r.what}-${r.mode}`))) {
		const group = memory.filter((r) => `${r.what}-${r.mode}` === key);
		const one = group.find((r) => r.count === 1);
		out[key] = {
			byCount: Object.fromEntries(
				group.map((r) => [
					r.count,
					{
						rssBeforeBytes: r.rssBeforeBytes,
						rssAfterRunBytes: r.rssAfterRunBytes,
						maxRssBytes: r.maxRssBytes,
						wasmMemoryBytes: r.wasmMemoryBytes[0],
						perContextOpenBytes: r.perContextOpenBytes,
						perContextAfterRunBytes: r.perContextAfterRunBytes
					}
				])
			),
			marginalBytesPerExtraContext: one
				? Object.fromEntries(
						group
							.filter((r) => r.count > 1)
							.map((r) => [
								r.count,
								(r.rssAfterRunBytes -
									r.rssBeforeBytes -
									(one.rssAfterRunBytes - one.rssBeforeBytes)) /
									(r.count - 1)
							])
					)
				: undefined
		};
	}
	return out;
}

export function analyzeBreakdown(set: string, file: string) {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = summarizeBreakdown(parseRows(raw), sha256(raw));
	writeFileSync(
		new URL(file.replace(/\.jsonl$/, '.summary.json'), root),
		`${JSON.stringify(summary, null, 2)}\n`
	);
	return summary;
}

export function analyzeMemory(set: string, files: string[]) {
	const root = resultsRoot(set);
	const summary = summarizeMemory(files.flatMap((name) => parseRows(readRaw(root, name))));
	writeFileSync(new URL('memory.summary.json', root), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

if (import.meta.main) {
	const [set, file, ...memoryFiles] = process.argv.slice(2);
	if (file === 'memory') {
		analyzeMemory(set!, memoryFiles);
	} else {
		const summary = analyzeBreakdown(set!, file!);
		console.log(JSON.stringify(summary.modes, null, 1).slice(0, 3000));
	}
}
