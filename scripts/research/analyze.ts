import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { digest } from './environment.ts';

type Row = Record<string, any>;
/** Repeated calls inside one round (routing studies) pair by their call index. */
const slot = (row: Row) => (row.call === undefined ? row.round : row.round * 1000 + row.call);
const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b),
		middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
/** Paired round bootstrap; descriptive uncertainty within a run, not independent-host replication. */
export function distribution(values: number[]) {
	assert.ok(values.length > 0 && values.every(Number.isFinite));
	let state = 0x12345678;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
	const boot = Array.from({ length: 2000 }, () =>
		median(Array.from({ length: values.length }, () => values[next() % values.length]!))
	).sort((a, b) => a - b);
	return {
		n: values.length,
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
		medianCi95: [boot[50]!, boot[1949]!]
	};
}

/** Distribution of numerator over denominator for the pairs whose denominator is positive; process CPU reads 0 for very short runs. */
const ratios = (rows: Row[], pick: (row: Row) => [number, number]) => {
	const values = rows
		.map(pick)
		.filter(([, denominator]) => denominator > 0)
		.map(([n, d]) => n / d);
	return values.length ? distribution(values) : undefined;
};

export function summarizeResearch(rows: Row[], hash: string) {
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length && samples.every((row) => row.passed));
	const key = (row: Row) => row.case ?? JSON.stringify(row.cell) ?? row.name;
	const groups: Record<string, Record<string, unknown>> = {};
	for (const name of new Set(samples.map(key))) {
		const group = samples.filter((row) => key(row) === name),
			arms: Record<string, unknown> = {};
		for (const round of new Set(group.map(slot))) {
			const matches = group.filter((row) => slot(row) === round);
			assert.equal(
				new Set(matches.map((row) => row.outputSha256 ?? row.memorySha256)).size,
				1,
				`different outputs: ${name} round ${round}`
			);
			assert.equal(
				new Set(matches.map((row) => row.arm)).size,
				matches.length,
				'duplicate arm/round'
			);
		}
		const baseline = group.some((row) => row.arm === 'native') ? 'native' : 'initialize';
		for (const arm of new Set(group.map((row) => row.arm))) {
			const selected = group.filter((row) => row.arm === arm);
			const paired = (row: Row) => {
				const native = group.find(
					(other) => slot(other) === slot(row) && other.arm === baseline
				);
				assert.ok(native, `missing ${baseline} pair`);
				return native;
			};
			arms[arm] = {
				wallMs: distribution(selected.map((row) => row.wallMs)),
				cpuMs: distribution(selected.map((row) => row.cpuMs)),
				pairedSpeedup: distribution(selected.map((row) => paired(row).wallMs / row.wallMs)),
				cpuRatio: ratios(selected, (row) => [row.cpuMs, paired(row).cpuMs]),
				cpuRatioPairs: selected.filter((row) => paired(row).cpuMs > 0).length,
				averageBusyCpus: ratios(selected, (row) => [row.cpuMs, row.wallMs]),
				openMs: selected.every((row) => row.openMs !== undefined)
					? distribution(selected.map((row) => row.openMs))
					: undefined,
				modes: [
					...new Set(
						selected
							.map((row) => row.report?.mode ?? row.dispatched?.mode)
							.filter(Boolean)
					)
				],
				workers: [
					...new Set(
						selected
							.map((row) => row.report?.workers ?? row.dispatched?.workers)
							.filter((value) => value !== undefined)
					)
				],
				reasons: selected.reduce<Record<string, number>>((counts, row) => {
					const reason = row.reason ?? row.report?.reason ?? row.dispatched?.reason;
					if (reason) counts[reason] = (counts[reason] ?? 0) + 1;
					return counts;
				}, {}),
				replayed: selected.reduce(
					(sum, row) => sum + (row.report?.replayed ?? row.dispatched?.replayed ?? 0),
					0
				),
				validationMs: selected.every((row) => row.report?.profile)
					? distribution(selected.map((row) => row.report.profile.validationMs))
					: undefined,
				commitMs: selected.every((row) => row.report?.profile)
					? distribution(selected.map((row) => row.report.profile.commitMs))
					: undefined,
				computeMs: selected.every((row) => row.phases)
					? distribution(selected.map((row) => row.phases.computeMs))
					: undefined,
				resetMs: selected.every((row) => row.phases)
					? distribution(selected.map((row) => row.phases.resetMs))
					: undefined
			};
		}
		groups[name] = arms;
	}
	return {
		schema: 'folio.research-summary.v1',
		rawSha256: hash,
		samples: samples.length,
		environments: rows.filter((row) => row.kind === 'environment'),
		bootstrap: {
			resamples: 2000,
			seed: 305419896,
			unit: 'paired round',
			independentReplication: false
		},
		groups
	};
}

if (import.meta.main) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) throw new Error('usage: analyze.ts RAW.jsonl SUMMARY.json');
	const raw = readFileSync(input);
	const result = summarizeResearch(
		raw
			.toString()
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line)),
		digest(raw)
	);
	writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
	console.log(
		JSON.stringify({ samples: result.samples, groups: Object.keys(result.groups).length })
	);
}
