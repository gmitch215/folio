import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { startLocal } from '../../../experiments/lane-pool/local.ts';
import { chunk, taskId } from '../../../experiments/lane-pool/task.ts';

type Local = Awaited<ReturnType<typeof startLocal>>;
let local: Local;

const UNITS = 12;
const PASSES = 40;
const expected = Array.from({ length: UNITS }, (_, index) => chunk(index, PASSES));
const run = `it-${Date.now().toString(36)}`;

beforeAll(async () => {
	local = await startLocal();
}, 120000);
afterAll(() => local?.dispose());

test('four lanes on distinct objects return the serial run, every task claimed once', async () => {
	const ready = await local.get('/ready', { run, k: 4 });
	assert.equal(ready.status, 200);
	const lanes = ready.body.lanes as { object: string; isolate: string }[];
	assert.equal(new Set(lanes.map((lane) => lane.object)).size, 4);

	const serial = await local.get('/serial', { name: `${run}-serial`, n: UNITS, passes: PASSES });
	const pool = await local.get('/pool', {
		name: `${run}-pool`,
		run,
		n: UNITS,
		passes: PASSES,
		k: 4
	});
	assert.equal(pool.status, 200, String(pool.body).slice(0, 300));
	assert.deepEqual(serial.body.outputs, expected);
	assert.deepEqual(pool.body.outputs, expected);
	assert.equal(pool.body.report.done, UNITS);
	assert.equal(pool.body.report.failed, 0);
	assert.equal(pool.body.report.laneErrors, 0);

	const state = (await local.get('/state', { name: `${run}-pool` })).body;
	for (let index = 0; index < UNITS; index++) {
		assert.equal(state.attempts[taskId(index)], 1);
		assert.equal(state.accepted[taskId(index)], 1);
	}
	// one local workerd process puts the lane objects in one isolate, so only exactness is asserted
	// here; distinct isolates and the speed-up are what the deployed run measures
	const isolates = new Set(lanes.map((lane) => lane.isolate)).size;
	assert.ok(isolates >= 1 && isolates <= 4);
}, 60000);

test('a lane that resets mid-task is replayed once and the outputs still equal the serial run', async () => {
	const pool = await local.get('/pool', {
		name: `${run}-abort`,
		run,
		n: UNITS,
		passes: PASSES,
		k: 4,
		fault: 'abort',
		index: 5
	});
	assert.equal(pool.status, 200, String(pool.body).slice(0, 300));
	assert.deepEqual(pool.body.outputs, expected);
	assert.ok(pool.body.report.laneErrors >= 1);

	const state = (await local.get('/state', { name: `${run}-abort` })).body;
	for (let index = 0; index < UNITS; index++) {
		assert.equal(state.attempts[taskId(index)], index === 5 ? 2 : 1, taskId(index));
		assert.equal(state.accepted[taskId(index)], 1, taskId(index));
	}
}, 90000);
