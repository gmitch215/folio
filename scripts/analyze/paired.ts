import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

// p95 and worst sample, for the tail that a median hides
const tail = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)],
		max: sorted.at(-1)
	};
};

// summarizes paired native-against-Folio samples: workloads.jsonl, consumers.jsonl and similar
export function summarizePaired(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length > 0 && samples.every((row) => row.passed));
	const workloads: Record<string, Record<string, unknown>> = {};
	for (const name of new Set(samples.map((row) => row.name))) {
		const group = samples.filter((row) => row.name === name);
		for (const round of new Set(group.map((row) => row.round)))
			assert.equal(
				new Set(group.filter((row) => row.round === round).map((row) => row.outputSha256))
					.size,
				1,
				`${name} round ${round}: outputs differ`
			);
		const arms: Record<string, unknown> = (workloads[name] = {});
		for (const arm of new Set(group.map((row) => row.arm))) {
			const matches = group.filter((row) => row.arm === arm);
			const paired = (row: Row) =>
				group.find((other) => other.arm === 'native' && other.round === row.round)!;
			const dispatched = matches.map((row) => row.dispatched).filter(Boolean);
			const before = arm.startsWith('folio-')
				? group.filter((row) => row.arm === arm.replace('folio-', 'old-'))
				: [];
			arms[arm] = {
				wallMs: stats(matches.map((row) => row.wallMs)),
				wallTailMs: tail(matches.map((row) => row.wallMs)),
				cpuMs: stats(matches.map((row) => row.cpuMs)),
				...(arm === 'native'
					? {}
					: {
							pairedSpeedup: stats(
								matches.map((row) => paired(row).wallMs / row.wallMs)
							),
							cpuRatio: stats(matches.map((row) => row.cpuMs / paired(row).cpuMs))
						}),
				...(before.length
					? {
							versusOld: stats(
								matches.map(
									(row) =>
										before.find((old) => old.round === row.round)!.wallMs /
										row.wallMs
								)
							)
						}
					: {}),
				...(dispatched.length
					? {
							workersDispatched: stats(dispatched.map((d: Row) => d.workers)),
							regionsEnqueued: stats(dispatched.map((d: Row) => d.regions)),
							replayed: dispatched.reduce(
								(sum: number, d: Row) => sum + d.replayed,
								0
							),
							fallbacks: dispatched.reduce(
								(sum: number, d: Row) => sum + d.fallbacks,
								0
							),
							modes: [...new Set(dispatched.map((d: Row) => d.mode))]
						}
					: {})
			};
		}
	}
	return {
		environment,
		measuredSamples: samples.length,
		workloads,
		load: stats(samples.map((row) => row.load[0])),
		hash
	};
}

export function analyzePaired(set: string, file = 'workloads.jsonl') {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = summarizePaired(parseRows(raw), sha256(raw));
	writeFileSync(
		new URL(file.replace(/\.jsonl$/, '.summary.json'), root),
		`${JSON.stringify(summary, null, 2)}\n`
	);
	return summary;
}

if (import.meta.main) {
	const summary = analyzePaired(process.argv[2]!, process.argv[3]);
	for (const [name, arms] of Object.entries(summary.workloads))
		console.log(
			JSON.stringify({
				name,
				arms: Object.fromEntries(
					Object.entries(arms as Record<string, any>).map(([arm, value]) => [
						arm,
						{
							wallMs: value.wallMs.median,
							speed: value.pairedSpeedup?.median,
							cpuRatio: value.cpuRatio?.median,
							workers: value.workersDispatched?.max,
							regions: value.regionsEnqueued?.max
						}
					])
				)
			})
		);
}
