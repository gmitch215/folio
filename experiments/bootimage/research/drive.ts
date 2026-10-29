import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { researchEnvironment } from '../../../scripts/research/environment.ts';

const [directory, runtimeArg, mode = 'configurations', pairsArg = '15'] = process.argv.slice(2);
assert.ok(
	directory && runtimeArg,
	'usage: drive.ts OUTPUT_DIRECTORY RUNTIME_DIRECTORY [configurations|lifecycle] [PAIRS]'
);
const runtime = resolve(runtimeArg),
	output = resolve(directory),
	pairs = Number(pairsArg);
assert.ok(
	['configurations', 'lifecycle'].includes(mode) && Number.isSafeInteger(pairs) && pairs > 0
);
mkdirSync(output, { recursive: true });
const raw = join(output, 'raw.jsonl');
writeFileSync(raw, '', { flag: 'wx' });
appendFileSync(
	raw,
	JSON.stringify({
		...researchEnvironment({
			mode,
			pairs,
			clock: 'Node elapsed and process CPU',
			independentProcessPerSample: true
		}),
		inputs: JSON.parse(readFileSync(join(runtime, 'inputs.json'), 'utf8'))
	}) + '\n'
);
const names =
	mode === 'configurations'
		? [
				'base',
				'rename',
				'mail',
				'timezone',
				'theme',
				'color',
				'module',
				'maintenance',
				'cache',
				'alias',
				'content',
				'key',
				'salt'
			]
		: ['base'];
const arms =
	mode === 'configurations'
		? ['plain', 'guarded', 'reset', 'unguarded']
		: ['plain', 'guarded', 'memory'];
for (const name of names)
	for (let round = 0; round < (mode === 'configurations' ? 1 : pairs); round++) {
		for (let turn = 0; turn < arms.length; turn++) {
			const arm = arms[(turn + round) % arms.length]!;
			const child = spawnSync(
				process.execPath,
				[
					'--expose-gc',
					join(runtime, 'run.mjs'),
					'case',
					raw,
					name,
					arm,
					`${mode}-${Date.now().toString(36)}-${round}`
				],
				{
					env: {
						...process.env,
						FOLIO_BOOTIMAGE_ROOT: runtime,
						FOLIO_BOOTIMAGE_CHILD: '1'
					},
					encoding: 'utf8',
					timeout: 120000
				}
			);
			appendFileSync(
				join(output, 'run.log'),
				`${name} ${arm} ${round}\n${child.stdout}\n${child.stderr}\n`
			);
			assert.equal(child.status, 0, `${name}/${arm} failed; see run.log`);
		}
	}
const rows = readFileSync(raw, 'utf8')
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));
const samples = rows.filter((row) => row.kind === 'sample');
for (const row of samples) {
	const native = samples.find(
		(other) => other.name === row.name && other.round === row.round && other.arm === 'plain'
	);
	assert.ok(native);
	assert.match(native.first.sha256, /^[a-f0-9]{64}$/);
	assert.ok(
		native.first.status < 500 || (row.name === 'maintenance' && native.first.status === 503),
		'native render failed'
	);
	row.equal =
		native.first.sha256 === row.first.sha256 && native.first.status === row.first.status;
	if (row.security && native.security && row.arm !== 'unguarded') {
		assert.equal(row.security.keySha, native.security.keySha, 'private key differs');
		assert.equal(row.security.saltSha, native.security.saltSha, 'salt differs');
	}
	if (row.arm !== 'unguarded') assert.ok(row.equal, `${row.name}/${row.arm} differs from native`);
}
writeFileSync(
	join(output, 'summary.json'),
	JSON.stringify(
		{
			names: names.length,
			samples: samples.length,
			strictEligible: [
				...new Set(samples.filter((row) => row.eligible).map((row) => row.name))
			].length,
			resetEligible: [
				...new Set(samples.filter((row) => row.resetEligible).map((row) => row.name))
			].length,
			comparisons: samples.map((row) => ({
				name: row.name,
				arm: row.arm,
				round: row.round,
				eligible: row.eligible,
				resetEligible: row.resetEligible,
				useImage: row.useImage,
				equal: row.equal,
				wallMs: row.wallMs,
				cpuMs: row.cpuMs,
				warmMs: row.warm.ms,
				renewal: row.renewal
			}))
		},
		null,
		2
	) + '\n'
);
console.log(JSON.stringify({ mode, names: names.length, samples: samples.length, complete: true }));
