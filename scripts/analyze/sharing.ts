import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, writeSummary, type Row } from './lib.ts';

export function analyzeSharing(set = 'memory/sharing') {
	const root = resultsRoot(set);
	const files = readdirSync(root)
		.filter((name) => name.endsWith('.jsonl'))
		.sort();
	const rows: Row[] = files.flatMap((file) =>
		parseRows(readRaw(root, file)).map((row) => ({ file, ...row }))
	);
	const samples = rows.filter((row) => row.kind === 'sample');
	const environment = rows.find((row) => row.kind === 'environment')!;
	const arms = environment.arms ?? ['native', 'serial-api', 'two', 'four'];
	assert.ok(samples.every((row) => row.passed));
	const hashes = Object.fromEntries(
		[...files, 'source.tar'].map((file) => [file, sha256(readRaw(root, file))])
	);
	if (environment.activeBytes) {
		assert.equal(samples.length, 14);
		const native = samples.filter((row) => row.arm === 'native');
		const parallel = samples.filter((row) => row.arm === 'four');
		assert.equal(native.length, 7);
		assert.equal(parallel.length, 7);
		assert.ok(samples.every((row) => row.fullWordsVerified === environment.activeBytes / 4));
		assert.ok(parallel.every((row) => row.report.mode === 'native-shared'));
		const baseline = (row: Row) => native.find((other) => other.round === row.round)!;
		const summary = {
			environment,
			measuredSamples: samples.length,
			nativeWallMs: stats(native.map((row) => row.wallMs)),
			parallelWallMs: stats(parallel.map((row) => row.wallMs)),
			pairedSpeedup: stats(parallel.map((row) => baseline(row).wallMs / row.wallMs)),
			pairedCpuRatio: stats(parallel.map((row) => row.cpuMs / baseline(row).cpuMs)),
			cpuPerWall: stats(parallel.map((row) => row.cpuMs / row.wallMs)),
			observedRssMiB: stats(samples.map((row) => row.rss / 1048576)),
			hashes
		};
		writeSummary(root, summary);
		return summary;
	}
	assert.equal(samples.length, 3 * arms.length * 7);
	const cpu: Record<string, Record<string, unknown>> = {};
	for (const name of ['tiny', 'stream', 'compute']) {
		const group = samples.filter((row) => row.name === name);
		cpu[name] = {};
		for (const arm of arms) {
			const matches = group.filter((row) => row.arm === arm);
			assert.equal(matches.length, 7);
			const native = (row: Row) =>
				group.find((other) => other.round === row.round && other.arm === 'native')!;
			cpu[name]![arm] = {
				wallMs: stats(matches.map((row) => row.wallMs)),
				cpuMs: stats(matches.map((row) => row.cpuMs)),
				pairedSpeedup: stats(matches.map((row) => native(row).wallMs / row.wallMs)),
				pairedCpuRatio: stats(matches.map((row) => row.cpuMs / native(row).cpuMs)),
				cpuPerWall: stats(matches.map((row) => row.cpuMs / row.wallMs))
			};
		}
	}
	const sharing: Record<string, unknown> = {};
	for (const mode of rows.some((row) => row.kind === 'sharing') ? ['shared', 'copied'] : []) {
		const matches = rows.filter(
			(row) => row.kind === 'sharing' && row.mode === mode && row.mib === 64
		);
		assert.equal(matches.length, 3);
		assert.ok(matches.every((row) => row.passed && new Set(row.isolates).size === 4));
		sharing[mode] = {
			attachDeltaMiB: stats(matches.map((row) => row.attachDelta / 1048576)),
			rssAttachedMiB: stats(matches.map((row) => row.rssAttached / 1048576))
		};
	}
	const large = rows.find((row) => row.kind === 'sharing' && row.mib === 256);
	if (large) assert.ok(large.passed);
	const summary = {
		environment,
		measuredSamples: samples.length,
		cpu,
		sharing,
		large,
		growth: rows.filter((row) => row.kind === 'growth'),
		creatorExit: rows.filter((row) => row.kind === 'creator-exit'),
		hashes
	};
	writeSummary(root, summary);
	return summary;
}

if (import.meta.main) {
	const summary = analyzeSharing(process.argv[2]);
	console.log(
		JSON.stringify(
			'cpu' in summary
				? { cpu: summary.cpu.compute, sharing: summary.sharing, large: summary.large }
				: summary,
			null,
			2
		)
	);
}
