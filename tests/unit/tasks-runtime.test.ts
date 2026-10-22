import assert from 'node:assert/strict';
import { test } from 'vitest';
import { type TaskRuntimeReport, verdicts } from '../../scripts/probe/tasks-runtime.ts';

test('each check gets one verdict: ok, failed with the error, or skipped', () => {
	const report: TaskRuntimeReport = {
		runtime: 'bun',
		version: '1.4.4',
		checks: [
			{ name: 'join', ok: true, detail: 'text FOLIO' },
			{
				name: 'joinAsync',
				ok: false,
				detail: 'TypeError: Atomics.waitAsync is not a function'
			},
			{ name: 'audit', ok: false, detail: 'no pool, the start check failed', skipped: true }
		]
	};
	assert.deepEqual(verdicts(report), [
		'join: ok',
		'joinAsync: failed: TypeError: Atomics.waitAsync is not a function',
		'audit: skipped (no pool, the start check failed)'
	]);
});

test('a report with no checks has no verdicts', () => {
	assert.deepEqual(verdicts({ checks: [] }), []);
});
