import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeAll, test } from 'vitest';
import { runHostProbe } from '../../experiments/cloud/host-probe.ts';
import { runLocal as runCloud } from '../../experiments/cloud/local.ts';
import { runLocal as runManaged } from '../../experiments/managed/local.ts';

beforeAll(() => {
	execFileSync(process.execPath, ['experiments/managed/prepare.ts'], { stdio: 'pipe' });
});

test('portable client in stock workerd reaches the Node execution host with exact memory', async () => {
	const result = await runHostProbe();
	assert.equal(result.report.mode, 'native-shared');
	assert.equal(result.distinctThreads, 4);
	assert.equal(result.assertions.exactWholeMemory, true);
	assert.equal(result.assertions.bigintExact, true);
	assert.equal(result.createdGroups, result.disposedGroups);
	assert.equal(result.cleanup.activeGroups, 0);
});

test('capability probe runs in local workerd and keeps ordinary byte RPC exact', async () => {
	const { summary } = await runCloud();
	assert.equal(summary.ordinaryByteRpcExact, true);
	assert.equal(summary.bundledAtomicExact, true);
	assert.equal(summary.sharedRpc.sab.ok, false);
	assert.equal(summary.cpu.length, 4);
});

test('managed lanes extract regions and match native memory over every transport', async () => {
	const result = await runManaged();
	assert.equal(result.passed, true);
	assert.equal(result.jspi, true);
	assert.equal(result.rows.length, 39);
	assert.ok(result.rows.every((row: { exact: boolean }) => row.exact));
}, 120000);
