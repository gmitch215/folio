import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { breakEven, fit, project, table } from '../../../../experiments/lane-pool/model.ts';
import type { Pair } from '../../../../experiments/lane-pool/plan.ts';

// serial = hop + 16 * unit, pool = hop + overhead + 4 * unit, with a hop of 200, unit of 50, overhead of 400
function pair(serialMs: number, poolMs: number): Pair {
	return {
		pair: 0,
		first: 'serial',
		serialMs,
		poolMs,
		serialStatus: 200,
		poolStatus: 200,
		equal: true
	};
}

const pairs = [pair(1000, 800), pair(1000, 800), pair(1000, 800)];

describe('lane pool model', () => {
	test('the fit recovers the unit cost and the overhead of an exact pair', () => {
		const f = fit(pairs, 200);
		assert.equal(f.unitMs, 50);
		assert.equal(f.overheadMs, 400);
		assert.equal(f.pairs, 3);
	});

	test('a serial wall over two seconds is an errored pair and is left out', () => {
		const f = fit([...pairs, pair(7500, 800)], 200);
		assert.equal(f.pairs, 3);
		assert.equal(f.unitMs, 50);
	});

	test('a projection reproduces the pair it was fitted to', () => {
		const p = project(fit(pairs, 200), 50);
		assert.equal(p.serialMs, 1000);
		assert.equal(p.poolMs, 800);
		assert.equal(p.ratio, 1.25);
	});

	test('the ratio rises with the unit cost and stays under the lane count', () => {
		const f = fit(pairs, 200);
		const small = project(f, 50).ratio;
		const large = project(f, 400).ratio;
		assert.ok(large > small);
		assert.ok(large < 4);
	});

	test('the break-even unit gives exactly the asked ratio', () => {
		const f = fit(pairs, 200);
		assert.ok(Math.abs(project(f, breakEven(f, 1.2)).ratio - 1.2) < 1e-9);
	});

	test('the table has one row per hop and names the break-even', () => {
		const lines = table(pairs).split('\n');
		assert.equal(lines.length, 4);
		assert.match(lines[1] ?? '', /1\.2x at \d+ ms/);
	});
});
