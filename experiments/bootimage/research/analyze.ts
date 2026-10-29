import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeResearch } from '../../../scripts/research/analyze.ts';
import { digest } from '../../../scripts/research/environment.ts';

const [directory, output] = process.argv.slice(2);
assert.ok(directory && output, 'usage: analyze.ts RUN_DIRECTORY OUTPUT_JSON');
const raw = readFileSync(join(directory, 'raw.jsonl'));
const rows = raw
	.toString()
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));
const samples = rows.filter((row) => row.kind === 'sample');
assert.ok(samples.length > 0);
const native = (row: any) =>
	samples.find(
		(other) => other.name === row.name && other.round === row.round && other.arm === 'plain'
	);
const compared = samples.map((row) => ({
	...row,
	equal:
		native(row).first.sha256 === row.first.sha256 &&
		native(row).first.status === row.first.status
}));
const safe = compared.filter((row) => row.arm !== 'unguarded');
assert.ok(
	safe.every((row) => row.equal),
	'guarded replay differs from native'
);
const names = [...new Set(samples.map((row) => row.name))];
const random = samples
	.filter((row) => row.useImage)
	.map((row) => JSON.stringify(row.security.random));
const forms = samples.flatMap((row) => row.first.formBuildIds);
const result = {
	schema: 'folio.boot-research.v1',
	rawSha256: digest(raw),
	names,
	strictEligible: names.filter((name) => samples.find((row) => row.name === name).eligible)
		.length,
	resetEligible: names.filter((name) => samples.find((row) => row.name === name).resetEligible)
		.length,
	comparisons: compared.map((row) => ({
		name: row.name,
		arm: row.arm,
		round: row.round,
		eligible: row.eligible,
		resetEligible: row.resetEligible,
		useImage: row.useImage,
		equal: row.equal,
		status: row.first.status,
		bodySha256: row.first.sha256,
		wallMs: row.wallMs,
		cpuMs: row.cpuMs
	})),
	safety: {
		guardedComparisons: safe.length,
		guardedEqual: safe.filter((row) => row.equal).length,
		keyEqual: safe.every((row) => row.security.keySha === native(row).security.keySha),
		saltEqual: safe.every((row) => row.security.saltSha === native(row).security.saltSha),
		replayedRandomSequences: random.length,
		uniqueRandomSequences: new Set(random).size,
		formBuildIds: forms.length,
		uniqueFormBuildIds: new Set(forms).size,
		replayFailures: samples.flatMap((row) => [
			...(row.marks.replay?.streamsFailed ?? []),
			...(row.marks.replay?.handlesFailed ?? [])
		]),
		renewalErrors: samples.flatMap((row) => row.renewal?.errors ?? [])
	},
	statistics: summarizeResearch(
		[
			...rows.filter((row) => row.kind === 'environment'),
			...safe.map((row) => ({
				kind: 'sample',
				case: row.name,
				arm: row.arm === 'plain' ? 'native' : row.arm,
				round: row.round,
				wallMs: row.wallMs,
				cpuMs: row.cpuMs,
				openMs: row.marks.openMs,
				outputSha256: row.first.sha256,
				passed: row.equal
			}))
		],
		digest(raw)
	)
};
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(
	JSON.stringify({
		samples: samples.length,
		names: names.length,
		strictEligible: result.strictEligible,
		resetEligible: result.resetEligible,
		safety: result.safety
	})
);
