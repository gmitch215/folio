import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const quantile = (values: number[], q: number) => {
	const s = sorted(values);
	return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// summarizes php-concurrent.ts samples: four arms at each width, paired by round
export function summarizeConcurrent(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length > 0, 'no samples');
	const names: Record<string, Record<string, Record<string, unknown>>> = {};
	for (const name of new Set(samples.map((row) => row.name))) {
		const group = samples.filter((row) => row.name === name);
		assert.equal(
			new Set(group.flatMap((row) => row.sha256)).size,
			1,
			`${name}: outputs differ`
		);
		const widths: Record<string, Record<string, unknown>> = (names[name] = {});
		for (const width of new Set(group.map((row) => row.width))) {
			const arms: Record<string, unknown> = (widths[`w${width}`] = {});
			const at = (arm: string) => group.filter((r) => r.width === width && r.arm === arm);
			const ratio = (top: string, bottom: string, field: (r: Row) => number) =>
				at(top).map((r) => field(r) / field(at(bottom).find((o) => o.round === r.round)!));
			for (const arm of new Set(group.filter((r) => r.width === width).map((r) => r.arm))) {
				const cells = at(arm);
				const latency = cells.flatMap((r) => r.latencyMs as number[]);
				arms[arm] = {
					wallMs: stats(cells.map((r) => r.wallMs)),
					throughputPerSecond: stats(cells.map((r) => r.throughput)),
					latencyMs: {
						n: latency.length,
						p50: quantile(latency, 0.5),
						p95: quantile(latency, 0.95),
						max: Math.max(...latency)
					},
					aggregateThreadCpuMs: stats(cells.map((r) => sum(r.threadCpuMs))),
					perInstanceCpuMs: stats(cells.flatMap((r) => r.threadCpuMs)),
					processCpuMs: stats(cells.map((r) => r.processCpuMs)),
					overlapMs: stats(cells.map((r) => r.overlapMs)),
					startSkewMs: stats(cells.map((r) => r.startSkewMs)),
					rssBytes: stats(cells.map((r) => r.rssBytes)),
					load1: stats(cells.map((r) => r.load[0]))
				};
			}
			arms['paired'] = {
				nativeConcurrentVsSerial: stats(
					ratio('native-serial', 'native-concurrent', (r) => r.wallMs)
				),
				folioConcurrentVsSerial: stats(
					ratio('folio-serial', 'folio-concurrent', (r) => r.wallMs)
				),
				folioOverNativeConcurrentWall: stats(
					ratio('folio-concurrent', 'native-concurrent', (r) => r.wallMs)
				),
				folioOverNativeSerialWall: stats(
					ratio('folio-serial', 'native-serial', (r) => r.wallMs)
				)
			};
		}
		const drupal = group.filter((r) => r.runs);
		if (drupal.length) {
			const runs = drupal.flatMap((r) => r.runs as Row[]);
			const field = (key: string) => stats(runs.map((r) => r[key] as number));
			(widths as any).requestParts = {
				n: runs.length,
				serviceMs: field('cpuMs'),
				sqlMs: field('sqlMs'),
				sqlCalls: field('sqlCalls'),
				queries: field('queries'),
				inflateMs: field('inflateMs'),
				inflateCalls: field('inflateCalls'),
				inflateBytes: field('inflateBytes'),
				openMs: stats(drupal.map((r) => r.openMs)),
				openCpuMs: stats(drupal.flatMap((r) => r.boots.map((b: Row) => b.openCpuMs)))
			};
		}
	}
	const memory = rows.filter((row) => row.kind === 'memory');
	return { environment, measuredSamples: samples.length, names, memory, hash };
}

/** bytes one extra context costs, from memory rows of the same arm at two counts */
export function marginalContextBytes(memory: Row[], what: string, mode: string) {
	const rows = memory.filter((r) => r.what === what && r.mode === mode);
	const one = rows.find((r) => r.count === 1);
	return Object.fromEntries(
		rows
			.filter((r) => r.count > 1 && one)
			.map((r) => [
				`count${r.count}`,
				{
					afterRunBytes:
						(r.rssAfterRunBytes -
							r.rssBeforeBytes -
							(one!.rssAfterRunBytes - one!.rssBeforeBytes)) /
						(r.count - 1)
				}
			])
	);
}

export function analyzeConcurrent(set: string, file: string) {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = summarizeConcurrent(parseRows(raw), sha256(raw));
	writeFileSync(
		new URL(file.replace(/\.jsonl$/, '.summary.json'), root),
		`${JSON.stringify(summary, null, 2)}\n`
	);
	return summary;
}

if (import.meta.main) {
	const summary = analyzeConcurrent(process.argv[2]!, process.argv[3]!);
	for (const [name, widths] of Object.entries(summary.names))
		for (const [width, arms] of Object.entries(widths)) {
			if (width === 'requestParts') continue;
			console.log(
				name,
				width,
				Object.fromEntries(
					Object.entries(arms as Record<string, any>)
						.filter(([arm]) => arm !== 'paired')
						.map(([arm, v]) => [
							arm,
							`${v.throughputPerSecond.median.toFixed(2)}/s p95 ${v.latencyMs.p95.toFixed(0)}ms`
						])
				)
			);
		}
}
