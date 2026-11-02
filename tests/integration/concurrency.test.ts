import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, test } from 'vitest';
import { startLocal } from '../../experiments/concurrency/local.ts';
import { lcg, SEED } from '../../experiments/concurrency/plan.ts';

type Local = Awaited<ReturnType<typeof startLocal>>;
let local: Local;

beforeAll(async () => {
	execFileSync(process.execPath, ['experiments/concurrency/prepare.ts'], { stdio: 'pipe' });
	local = await startLocal();
	assert.equal((await local.ready()).status, 200);
}, 120000);
afterAll(() => local.dispose());

test('the worker, worker-one and Durable Object arms return the reference result per call', async () => {
	const rounds = 250_000;
	for (const arm of ['worker', 'worker-one', 'do-same', 'do-hint'] as const) {
		const { status, body } = await local.run(arm, 4, rounds, 11);
		assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
		assert.equal(body.calls.length, 4);
		for (const call of body.calls) {
			assert.equal(call.ok, true, JSON.stringify(call));
			assert.equal(call.checksum, lcg(rounds), arm);
			assert.ok(Number.isFinite(call.entered));
		}
		assert.deepEqual(
			body.calls.map((c: any) => c.slot),
			[0, 1, 2, 3]
		);
	}
});

test('an empty loop returns the seed', async () => {
	const { body } = await local.run('worker', 1, 0);
	assert.equal(body.calls[0].checksum, SEED);
});

test('four lane Workers answer from four isolates and one lane Worker from one', async () => {
	const four = (await local.run('worker', 4, 1000)).body;
	assert.equal(new Set(four.calls.map((c: any) => c.isolate)).size, 4);
	const one = (await local.run('worker-one', 4, 1000)).body;
	assert.equal(new Set(one.calls.map((c: any) => c.isolate)).size, 1);
	// the four calls are four distinct calls into that one isolate
	assert.equal(new Set(one.calls.map((c: any) => c.call)).size, 4);
});

test('the Durable Object arms address four named instances', async () => {
	for (const arm of ['do-same', 'do-hint'] as const) {
		const { body } = await local.run(arm, 4, 1000);
		assert.equal(new Set(body.calls.map((c: any) => c.instance)).size, 4, arm);
	}
});

test('the direct arm reaches each lane Worker on its own route', async () => {
	const rounds = 250_000;
	const { results } = await local.direct(4, rounds, 21);
	assert.equal(results.length, 4);
	for (const result of results) {
		assert.equal(result.status, 200);
		assert.equal(result.body.checksum, lcg(rounds));
	}
	assert.equal(new Set(results.map((r) => r.body.isolate)).size, 4);
});

test('a width above four is refused', async () => {
	const response = await local.run('worker', 5, 1);
	assert.equal(response.status, 400);
});
