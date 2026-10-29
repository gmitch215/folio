import assert from 'node:assert/strict';
import { parseRows, readRaw, resultsRoot, sha256, spread, writeSummary, type Row } from './lib.ts';

const arms = ['raw', 'auto-1', 'auto-2', 'auto-4', 'auto-8'];

export function analyzeControl(set = 'execution/control') {
	const root = resultsRoot(set);
	const raw = readRaw(root, 'control.jsonl');
	const rows = parseRows(raw);
	const metadata = rows.shift()!.metadata;
	const samples = rows.filter((row) => row.iteration >= 0);
	assert.equal(rows.length, (metadata.repeats + metadata.warmups) * 5);
	assert.ok(rows.every((row) => row.exact));
	const summary: Record<string, any> = {
		metadata,
		rawSha256: sha256(raw),
		sourceArchiveSha256: sha256(readRaw(root, 'source.tar.gz')),
		samples: samples.length,
		warmupSamples: rows.length - samples.length,
		allWholeMemoryAndReturnsExact: true,
		discardedSamples: 0,
		maximumRssMiB: Math.max(...rows.map((row) => row.rssMiB)),
		minimumFreeMiB: Math.min(...rows.map((row) => row.freeMiB)),
		load1: spread(samples.map((row) => row.load[0])),
		arms: {}
	};
	for (const arm of arms) {
		const group = samples.filter((row) => row.arm === arm);
		assert.equal(group.length, metadata.repeats);
		const reference = group.map((row) =>
			samples.find((other) => other.iteration === row.iteration && other.arm === 'raw')!
		);
		summary.arms[arm] = {
			samples: group.length,
			wallMs: spread(group.map((row) => row.wallMs)),
			cpuMs: spread(group.map((row) => row.cpuMs)),
			pairedSpeedup: spread(group.map((row, i) => reference[i]!.wallMs / row.wallMs)),
			pairedCpuRatio: spread(group.map((row, i) => row.cpuMs / reference[i]!.cpuMs)),
			cpuPerWall: spread(group.map((row) => row.cpuMs / row.wallMs))
		};
		if (arm !== 'raw') {
			const reports: Row[] = group.map((row) => row.report);
			summary.arms[arm].execution = {
				modes: [...new Set(reports.map((report) => report.mode))],
				workers: [...new Set(reports.map((report) => report.workers))],
				regions: [...new Set(reports.map((report) => report.regions))],
				replayed: reports.reduce((sum, report) => sum + report.replayed, 0),
				fallbacks: reports.reduce((sum, report) => sum + report.fallbacks, 0),
				validationMs: spread(reports.map((report) => report.profile.validationMs)),
				commitMs: spread(reports.map((report) => report.profile.commitMs))
			};
		}
	}
	writeSummary(root, summary);
	return summary;
}

if (import.meta.main) console.log(JSON.stringify(analyzeControl(process.argv[2]), null, 2));
