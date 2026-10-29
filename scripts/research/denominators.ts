import { readFileSync, writeFileSync } from 'node:fs';

type Row = Record<string, any>;
const lines = (path: string) =>
	readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Row);
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Row;

/** Counts kernels that clear a speedup bar for one arm of a paired summary. */
export function speedupCounts(summary: Row, arm: string, bars: number[]) {
	const medians = Object.values(summary.groups as Record<string, Row>).map(
		(group) => group[arm].pairedSpeedup.median as number
	);
	return {
		kernels: medians.length,
		...Object.fromEntries(
			bars.map((bar) => [`atLeast${bar}x`, medians.filter((value) => value >= bar).length])
		)
	};
}

/** One table of denominators: what was built, what the default route did, and what ran faster. */
export function denominators(root: string) {
	const upstream = lines(`${root}/upstream/raw.jsonl`);
	const kernels = upstream.filter((row) => row.kind === 'build');
	const inspect = upstream.filter((row) => row.kind === 'inspect');
	const defaultEntry = json(`${root}/default-entry-repeat/ryzen.summary.json`);
	const forced = json(`${root}/forced-admission-complete/summary.json`);
	const speculative = Object.entries(forced.groups as Record<string, Row>).filter(([, group]) =>
		group['folio-8'].modes.includes('speculative')
	);
	const policies = Object.fromEntries(
		['whole', 'pages', 'checkpoint'].flatMap((policy) =>
			['ryzen', 'm2'].map((machine) => [
				`${machine}-${policy}`,
				speedupCounts(
					json(`${root}/reset-policies/${machine}-${policy}.summary.json`),
					'tasks-8-batched',
					[1, 2, 3]
				)
			])
		)
	);
	const inputs = lines(`${root}/varied-inputs/raw.jsonl`).filter(
		(row) => row.kind === 'comparison'
	);
	return {
		schema: 'folio.denominators.v1',
		scope: 'library kernels, not full applications',
		projects: upstream.filter((row) => row.kind === 'source').length,
		kernels: kernels.length,
		built: kernels.filter((row) => row.artifactSha256).length,
		nativeMatch: upstream.filter((row) => row.kind === 'comparison' && row.passed).length,
		defaultAdmission: {
			inspected: inspect.length,
			withAutomaticPlan: inspect.filter(
				(row) => row.loops.length || row.native.length || row.controlEntries.length
			).length,
			dispatchedWorkers: Object.values(defaultEntry.groups as Record<string, Row>).filter(
				(group) => group['folio-8'].workers.some((count: number) => count > 0)
			).length
		},
		forcedAdmission: {
			completed: Object.keys(forced.groups).length,
			speculative: speculative.length,
			speculativeFasterThanNative: speculative.filter(
				([, group]) => group['folio-8'].pairedSpeedup.median > 1
			).length
		},
		explicitTasksEightWorkersBatched: policies,
		variedInputs: {
			comparisons: inputs.length,
			passed: inputs.filter((row) => row.passed).length
		},
		fullApplications: 0
	};
}

if (import.meta.main) {
	const [root, output] = process.argv.slice(2);
	if (!root || !output)
		throw new Error('usage: denominators.ts RESULTS_CORPUS_DIRECTORY OUTPUT.json');
	const result = denominators(root);
	writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
	console.log(JSON.stringify(result.defaultAdmission));
}
