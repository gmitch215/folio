import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ARENA_BYTES, relocationMatches } from '../../scripts/research/ownership-alloc-modules.ts';
import {
	DISPATCH_BASES,
	dispatchModule
} from '../../scripts/research/ownership-dispatch-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
import {
	certifyOwnership,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

const outcome = (name: string) => certifyOwnership(dispatchModule(name), options);

const certificate = (name: string) => {
	const r = outcome(name);
	assert.equal(
		r.kind,
		'certificate',
		r.kind === 'refusal' ? `${name} ${r.reason} ${r.detail}` : ''
	);
	return r as OwnershipCertificate;
};

const refusal = (name: string) => {
	const r = outcome(name);
	assert.equal(r.kind, 'refusal', name);
	assert.equal((r as OwnershipRefusal).reason, 'ptr-deref', (r as OwnershipRefusal).detail);
};

const truth = (names: string[]) => {
	for (const name of names) {
		const bytes = dispatchModule(name);
		const c = certificate(name);
		assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
		assert.deepEqual(
			extremeMatches(bytes, c.allocator!.pointerCells, [0, 1, 491, 492, 493]),
			{ ok: true },
			name
		);
		assert.ok(verifyOwnership(bytes, c), name);
	}
};

const LOOPS = ['dispatch', 'dispatch3', 'dispatch4', 'dispatchfall'];
const ENTRIES = ['dispatchentry'];
const LOOP_MUTANTS = [
	'dispatchdata',
	'dispatchfromdata',
	'dispatchoutside',
	'dispatchnoreset',
	'dispatchpast',
	'dispatchfallbad',
	'dispatch5',
	'dispatch6'
];
const ENTRY_MUTANTS = ['dispatchentrybad', 'dispatchentrydata'];

describe('a loop that dispatches on a state local keeps the relations of each state', () => {
	test('each value of the state local has its own loop head, up to the world limit', () => {
		truth(LOOPS);
	});

	test('a state local set from data, a value outside the table, a missing reset, a reset past the source, or more values than worlds is refused', () => {
		for (const name of LOOP_MUTANTS) refusal(name);
	});
});

describe('paths that reach the loop with different state values', () => {
	test('the loop starts from one head per value when a block merges them', () => {
		truth(ENTRIES);
	});

	test('two paths with the same value and different relations, or a value set from data, are refused', () => {
		for (const name of ENTRY_MUTANTS) refusal(name);
	});
});

describe('the list', () => {
	test('the lists above are every base', () => {
		assert.deepEqual(
			Object.keys(DISPATCH_BASES).sort(),
			[...LOOPS, ...ENTRIES, ...LOOP_MUTANTS, ...ENTRY_MUTANTS].sort()
		);
	});
});
