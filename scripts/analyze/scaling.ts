import assert from 'node:assert/strict';
import { parseRows, readRaw, resultsRoot, sha256, stats, writeSummary, type Row } from './lib.ts';

export function analyzeScaling(set = '20261019-d') {
	const root = resultsRoot(set);
	const raw = readRaw(root, 'scaling.jsonl');
	const rows = parseRows(raw);
	const environment = rows.find((row) => row.kind === 'environment')!;
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.equal(samples.length, 207);
	assert.ok(
		samples.every((row) => row.passed && row.verifiedBytes === environment.physicalBytes)
	);
	const workloads: Record<string, Record<string, unknown>> = {};
	for (const name of new Set(samples.map((row) => row.name))) {
		const group = samples.filter((row) => row.name === name);
		const arms: Record<string, unknown> = (workloads[name] = {});
		for (const arm of new Set(group.map((row) => row.arm))) {
			const matches = group.filter((row) => row.arm === arm);
			assert.equal(matches.length, 9);
			const paired = (row: Row) =>
				group.find((other) => other.arm === 'raw' && other.round === row.round)!;
			const profiled = matches.filter((row) => row.report?.profile?.workerWallMs.length);
			const longest = (row: Row) => Math.max(...row.report.profile.workerWallMs);
			arms[arm] = {
				wallMs: stats(matches.map((row) => row.wallMs)),
				pairedSpeedup: stats(matches.map((row) => paired(row).wallMs / row.wallMs)),
				cpuRatio: stats(matches.map((row) => row.cpuMs / paired(row).cpuMs)),
				processCpuPerWall: stats(matches.map((row) => row.cpuMs / row.wallMs)),
				...(profiled.length
					? {
							workerCpuMs: stats(
								profiled.map((row) =>
									row.report.profile.workerCpuMs.reduce(
										(sum: number, value: number) => sum + value,
										0
									)
								)
							),
							longestWorkerMs: stats(profiled.map(longest)),
							// includes message dispatch, scheduling and orchestration; not a pure transport timer
							orchestrationResidualMs: stats(
								profiled.map((row) => row.report.profile.wallMs - longest(row))
							),
							validationMs: stats(
								profiled.map((row) => row.report.profile.validationMs)
							),
							commitMs: stats(profiled.map((row) => row.report.profile.commitMs)),
							trackedReadBytes: stats(
								profiled.map((row) => row.report.profile.readBytes)
							),
							trackedWriteBytes: stats(
								profiled.map((row) => row.report.profile.writeBytes)
							)
						}
					: {})
			};
		}
	}
	const summary = {
		environment,
		measuredSamples: samples.length,
		workloads,
		rssMiB: stats(samples.map((row) => row.rss / 1048576)),
		load: stats(samples.map((row) => row.load[0])),
		hash: sha256(raw)
	};
	writeSummary(root, summary);
	return summary;
}

if (import.meta.main) {
	const summary = analyzeScaling(process.argv[2]);
	for (const [name, arms] of Object.entries(summary.workloads))
		console.log(
			JSON.stringify({
				name,
				arms: Object.fromEntries(
					Object.entries(arms as Record<string, any>).map(([arm, value]) => [
						arm,
						{
							wallMs: value.wallMs.median,
							speed: value.pairedSpeedup.median,
							cpuRatio: value.cpuRatio.median,
							cpuPerWall: value.processCpuPerWall.median,
							residualMs: value.orchestrationResidualMs?.median,
							validationMs: value.validationMs?.median,
							commitMs: value.commitMs?.median
						}
					])
				)
			})
		);
}
