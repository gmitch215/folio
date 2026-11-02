import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { startLocal } from '../../experiments/sqlite-lanes/local.ts';
import { QUERIES } from '../../experiments/sqlite-lanes/plan.ts';
import {
	buildFixture,
	buildModule,
	type Manifest
} from '../../experiments/sqlite-lanes/prepare.ts';
import { shasOf, shipments } from '../../experiments/sqlite-lanes/ship.ts';

// four shards of a 4,000-row table; the whole table as the serial object
const ROWS = 4000;
const RUN = 'itest';

type Local = Awaited<ReturnType<typeof startLocal>>;
let local: Local;
let dir: string;
let manifest: Manifest;

beforeAll(async () => {
	buildModule();
	dir = mkdtempSync(join(tmpdir(), 'folio-sqlite-lanes-'));
	manifest = buildFixture(dir, ROWS);
	local = await startLocal();
	for (const part of shipments(manifest, dir)) {
		const loaded = await local.load(RUN, part);
		assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
	}
}, 300000);

afterAll(async () => {
	await local?.dispose();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test('merged shard results equal the serial text for every decomposable query', async () => {
	const whole = shasOf(manifest, 'serial');
	const shards = shasOf(manifest, 'shards-4');
	for (const name of QUERIES) {
		const reference = await local.run(RUN, 'reference', name, ROWS, whole);
		assert.equal(reference.status, 200, JSON.stringify(reference.body));
		const expected = reference.body.calls[0].text as string;
		assert.ok(expected.length > 0, `${name} reference is empty`);

		const serial = await local.run(RUN, 'serial', name, ROWS, whole);
		assert.equal(serial.status, 200, JSON.stringify(serial.body));
		assert.equal(serial.body.calls[0].text, expected, `${name} same-plan serial`);

		const sharded = await local.run(RUN, 'shards-4', name, ROWS, shards);
		assert.equal(sharded.status, 200, JSON.stringify(sharded.body));
		assert.equal(sharded.body.merged, expected, `${name} merged`);
		assert.equal(sharded.body.calls.length, 4);
		for (const call of sharded.body.calls) {
			assert.equal(call.warm, true, 'shard was not retained');
			assert.ok(call.vmSteps > 0, 'no VDBE steps reported');
		}
	}
});

test('refuses queries the merge does not support and names it does not know', async () => {
	const shards = shasOf(manifest, 'shards-4');
	for (const name of ['cte', 'index', 'nope']) {
		const refused = await local.run(RUN, 'shards-4', name, ROWS, shards);
		assert.equal(refused.status, 400, name);
		assert.ok(refused.body.error, name);
	}
});

test('a wrong content hash is a miss for every slot, not a stale answer', async () => {
	const wrong = shasOf(manifest, 'shards-4').map(() => '0'.repeat(64));
	const missed = await local.run(RUN, 'shards-4', 'range', ROWS, wrong);
	assert.equal(missed.status, 409);
	assert.deepEqual(missed.body.miss, [0, 1, 2, 3]);
});
