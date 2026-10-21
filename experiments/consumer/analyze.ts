import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Row = Record<string, any>;

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

/** n, median, min, max and the nearest-rank 95th percentile. */
export function spread(values: number[]) {
	const list = sorted(values);
	return {
		n: list.length,
		median: list[Math.floor(list.length / 2)]!,
		min: list[0]!,
		max: list.at(-1)!,
		p95: list[Math.min(list.length - 1, Math.ceil(0.95 * list.length) - 1)]!
	};
}

/** Pairs every arm with the native sample of the same round; throws if any round's outputs differ. */
export function summarizeConsumer(result: Row) {
	assert.equal(result.passed, true, 'session did not pass');
	const rows: Row[] = result.rows;
	const environment = rows.find((row) => row.kind === 'environment')!;
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length > 0 && samples.every((row) => row.passed));
	const cases: Record<string, Record<string, unknown>> = {};
	for (const name of new Set(samples.map((row) => row.name))) {
		const group = samples.filter((row) => row.name === name);
		for (const round of new Set(group.map((row) => row.round))) {
			const inRound = group.filter((row) => row.round === round);
			assert.equal(
				new Set(inRound.map((row) => row.digest)).size,
				1,
				`${name} round ${round}`
			);
			const full = inRound.map((row) => row.sha256).filter(Boolean);
			assert.ok(new Set(full).size <= 1, `${name} round ${round}: full digests differ`);
		}
		const arms: Record<string, unknown> = {};
		for (const arm of new Set(group.map((row) => row.arm))) {
			const mine = group.filter((row) => row.arm === arm);
			const native = (round: number) =>
				group.find((row) => row.arm === 'native' && row.round === round)!.wallMs as number;
			const dispatched = mine.map((row) => row.dispatched).filter(Boolean);
			arms[arm] = {
				wallMs: spread(mine.map((row) => row.wallMs)),
				...(arm === 'native'
					? {}
					: {
							pairedSpeedup: spread(
								mine.map((row) => native(row.round) / row.wallMs)
							),
							dispatch: {
								workers: Math.max(0, ...dispatched.map((item) => item.workers)),
								regions: spread(dispatched.map((item) => item.regions)).median,
								messages: spread(dispatched.map((item) => item.messages ?? 0))
									.median,
								copiedBytes: spread(dispatched.map((item) => item.copiedBytes ?? 0))
									.median,
								modes: [...new Set(dispatched.map((item) => item.mode))].join('+'),
								reasons: [
									...new Set(
										dispatched.map((item) => item.reason).filter(Boolean)
									)
								].join('+')
							}
						})
			};
		}
		cases[name] = arms;
	}
	return {
		consumer: result.consumer,
		pairs: Math.max(...Object.values(cases).map((arms) => (arms.native as any).wallMs.n)),
		truncated: Boolean(result.truncated),
		exactOutputs: true,
		cpuMeasured: false,
		userAgent: result.userAgent,
		hardwareConcurrency: result.hardwareConcurrency,
		crossOriginIsolated: result.crossOriginIsolated,
		jspi: result.jspi,
		moduleBytes: environment.moduleBytes,
		arenaBytes: environment.arenaBytes,
		loops: environment.loops,
		reasons: environment.reasons,
		openMs: environment.openMs,
		elapsedMs: result.elapsedMs,
		cases
	};
}

// usage: node experiments/consumer/analyze.ts RUN_DIRECTORY OUTPUT.json
if (import.meta.main) {
	const [directory, output] = process.argv.slice(2);
	assert.ok(directory && output, 'usage: analyze.ts RUN_DIRECTORY OUTPUT.json');
	const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
	const baseline = read('baseline.json');
	const after = read('after.json');
	assert.deepEqual(after, baseline, 'account baseline differs');
	const results = readdirSync(directory)
		.filter((file) => file.startsWith('result-'))
		.sort()
		.map((file) => summarizeConsumer(read(file).result));
	writeFileSync(
		output,
		`${JSON.stringify({ run: basename(directory), account: read('run.json').account, baselineRestored: true, sessions: results }, null, 2)}\n`
	);
}
