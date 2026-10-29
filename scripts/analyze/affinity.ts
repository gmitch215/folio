import assert from 'node:assert/strict';
import { parseRows, readRaw, resultsRoot, sha256, spread, writeSummary, type Row } from './lib.ts';

export function analyzeAffinity(set = 'execution/placement-pilot') {
	const root = resultsRoot(set);
	const raw = readRaw(root, 'affinity.jsonl');
	const rows = parseRows(raw);
	const { metadata } = rows.shift()!;
	const samples = rows.filter((row) => row.iteration >= 0);
	assert.equal(metadata.arms.length, 8);
	assert.equal(rows.length, (metadata.repeats + metadata.warmups) * metadata.arms.length);
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
	const partner = (row: Row, arm: string) =>
		samples.find((other) => other.iteration === row.iteration && other.arm === arm)!;
	for (const arm of metadata.arms as string[]) {
		const group = samples.filter((row) => row.arm === arm);
		assert.equal(group.length, metadata.repeats);
		assert.equal(new Set(group.map((row) => row.iteration)).size, metadata.repeats);
		const reference = group.map((row) => partner(row, 'raw'));
		assert.ok(reference.every(Boolean));
		const entry: Record<string, any> = (summary.arms[arm] = {
			samples: group.length,
			wallMs: spread(group.map((row) => row.wallMs)),
			cpuMs: spread(group.map((row) => row.cpuMs)),
			pairedSpeedup: spread(group.map((row, i) => reference[i]!.wallMs / row.wallMs)),
			pairedCpuRatio: spread(group.map((row, i) => row.cpuMs / reference[i]!.cpuMs)),
			cpuPerWall: spread(group.map((row) => row.cpuMs / row.wallMs)),
			affinities: group.map((row) => ({ iteration: row.iteration, threads: row.affinity }))
		});
		if (arm.endsWith('-pinned')) {
			const unpinned = arm.replace(/-pinned$/, '-unpinned');
			entry.pairedPinningSpeedup = spread(
				group.map((row) => partner(row, unpinned).wallMs / row.wallMs)
			);
		}
		if (arm === 'raw') continue;
		const reports: Row[] = group.map((row) => row.report);
		entry.execution = {
			modes: [...new Set(reports.map((report) => report.mode))],
			workers: [...new Set(reports.map((report) => report.workers))],
			regions: [...new Set(reports.map((report) => report.regions))],
			replayed: reports.reduce((sum, report) => sum + report.replayed, 0),
			fallbacks: reports.reduce((sum, report) => sum + report.fallbacks, 0),
			validationMs: spread(reports.map((report) => report.profile.validationMs)),
			commitMs: spread(reports.map((report) => report.profile.commitMs))
		};
		const width: number = reports[0]!.workers;
		if (width <= 1) continue;
		// one lane takes every width-th region, so a lane's time is the sum of its regions
		const lanes = reports.map((report) => {
			assert.equal(report.profile.workerWallMs.length, report.regions);
			assert.equal(report.profile.workerCpuMs.length, report.regions);
			const wall: number[] = Array(width).fill(0);
			const cpu: number[] = Array(width).fill(0);
			report.profile.workerWallMs.forEach((value: number, i: number) => {
				wall[i % width]! += value;
			});
			report.profile.workerCpuMs.forEach((value: number, i: number) => {
				cpu[i % width]! += value;
			});
			return { wall, cpu };
		});
		entry.execution.maximumLaneWallMs = spread(lanes.map((lane) => Math.max(...lane.wall)));
		entry.execution.maximumLaneCpuMs = spread(lanes.map((lane) => Math.max(...lane.cpu)));
		entry.execution.maximumLaneWallMinusCpuMs = spread(
			lanes.map((lane) => Math.max(...lane.wall.map((wall, i) => wall - lane.cpu[i]!)))
		);
	}
	writeSummary(root, summary);
	return summary;
}

if (import.meta.main) console.log(JSON.stringify(analyzeAffinity(process.argv[2]), null, 2));
