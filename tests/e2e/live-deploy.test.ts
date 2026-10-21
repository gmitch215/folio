import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, test } from 'vitest';
import { summarizeBrowser } from '../../experiments/browser/analyze.ts';
import { summarizeConsumer } from '../../experiments/consumer/analyze.ts';
import { summarizeManaged } from '../../experiments/managed/analyze.ts';

const live = Boolean(
	process.env.FREE_CLOUDFLARE_ACCOUNT_ID && process.env.FREE_CLOUDFLARE_API_TOKEN
);
// Browser Run is capped at 10 minutes a day on Free, so it stays out of the per-commit set
const browser = live && process.env.FOLIO_E2E_BROWSER === '1';

function deploy(kind: string, env: Record<string, string> = {}) {
	const run = spawnSync(process.execPath, ['experiments/deploy.ts', kind], {
		env: { ...process.env, ...env },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	assert.equal(run.status, 0, `${kind} deploy failed\n${run.stdout}\n${run.stderr}`);
	const stages = run.stdout
		.split('\n')
		.filter((line) => line.startsWith('{"name"'))
		.map((line) => JSON.parse(line));
	const name: string = stages[0].name;
	const directory = `experiments/${['consumer', 'php', 'prepared'].includes(kind) ? 'consumer' : kind}/runs/${name}`;
	const read = (file: string) => readFileSync(`${directory}/${file}`);
	assert.deepEqual(
		JSON.parse(read('after.json').toString()),
		JSON.parse(read('baseline.json').toString())
	);
	assert.ok(stages.some((stage) => stage.stage === 'cleanup' && stage.baselineRestored));
	return { read, directory, path: `${directory}/result.json` };
}

describe.skipIf(!live)('live deploy on the Free account', () => {
	beforeAll(() => {
		execFileSync(process.execPath, ['experiments/managed/prepare.ts'], { stdio: 'pipe' });
		execFileSync(process.execPath, ['experiments/browser/prepare.ts'], { stdio: 'pipe' });
	});

	test('capability probe reports the platform boundary and restores the account', () => {
		const { read } = deploy('cloud');
		const { summary } = JSON.parse(read('result.json').toString());
		assert.equal(summary.ordinaryByteRpcExact, true);
		assert.equal(summary.bundledAtomicExact, true);
		assert.equal(summary.sharedRpc.sab.ok, false);
	});

	test('managed lanes match native memory over every transport and restore the account', () => {
		const { read, path } = deploy('managed');
		const summary = summarizeManaged(path, read('result.json'));
		assert.equal(summary.allWholeMemoryAndScalarExact, true);
		assert.equal(summary.arms.length, 12);
	});

	test.skipIf(!browser)('browser run shares one 256 MiB arena across eight workers', () => {
		const { read, path } = deploy('browser');
		const summary = summarizeBrowser(path, JSON.parse(read('result.json').toString()));
		assert.equal(summary.distinctAgents, 8);
		assert.equal(summary.arenaBytes, 256 * 1024 * 1024);
	});

	test.skipIf(!browser)('consumer harness pairs native and Folio in Browser Run', () => {
		execFileSync(process.execPath, ['experiments/consumer/prepare.ts', 'kernel-control'], {
			stdio: 'pipe'
		});
		const { read, directory } = deploy('consumer', {
			FOLIO_CONSUMER_RUNS: 'kernel-control',
			FOLIO_CONSUMER_PAIRS: '20'
		});
		const first = readFileSync(`${directory}/result-0-kernel-control.json`);
		const summary = summarizeConsumer(JSON.parse(first.toString()).result);
		assert.equal(summary.exactOutputs, true);
		assert.ok(read('meter-before.json').length > 0);
	});
});
