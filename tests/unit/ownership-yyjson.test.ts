import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ARENA_BYTES, relocationMatches } from '../../scripts/research/ownership-alloc-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
import { YYJSON_BASES, yyjsonModule } from '../../scripts/research/ownership-yyjson-modules.ts';
import {
	certifyOwnership,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

const outcome = (name: string) => certifyOwnership(yyjsonModule(name), options);

const certificate = (name: string) => {
	const r = outcome(name);
	assert.equal(
		r.kind,
		'certificate',
		r.kind === 'refusal' ? `${name} ${r.reason} ${r.detail}` : ''
	);
	return r as OwnershipCertificate;
};

const refusal = (name: string, reason = 'ptr-deref') => {
	const r = outcome(name);
	assert.equal(r.kind, 'refusal', name);
	assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
};

const SIZE = ['second', 'secondmul'];
const SCAN = [
	'digits',
	'digits208',
	'digits64',
	'held',
	'heldjoin',
	'word',
	'copyword',
	'copycell',
	'switchbyte',
	'twobytes'
];
const ORDER = ['order'];
const CERTIFY = [...SIZE, ...SCAN, ...ORDER];

const truth = (names: string[], lengths: number[]) => {
	for (const name of names) {
		const bytes = yyjsonModule(name);
		const c = certificate(name);
		assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
		assert.deepEqual(
			extremeMatches(bytes, c.allocator!.pointerCells, lengths),
			{ ok: true },
			name
		);
		assert.ok(verifyOwnership(bytes, c), name);
	}
};

describe('allocation size bounds reach the pointer', () => {
	test('a store inside the size lower bound of a non-exact allocation is proved and matches the runs', () => {
		truth(SIZE, [0, 1, 479, 480, 481, 5000]);
	});

	test('a store past the size lower bound is refused', () => {
		for (const name of ['secondpast', 'secondshort']) refusal(name);
	});
});

describe('scans that stop at zero padding, other test shapes', () => {
	test('a digit test, a byte held in a local, a 64 bit test and a word compare are proved and match the runs', () => {
		truth(SCAN, [0, 1, 491, 492, 493]);
	});

	test('a test the zero byte passes, or a word with a zero top byte, is refused', () => {
		for (const name of [
			'digits209',
			'digits64wide',
			'wordtop0',
			'copyword7',
			'copycell8',
			'copymask',
			'switchbyte5',
			'twobytes6'
		])
			refusal(name);
	});
});

describe('allocations made after the padding', () => {
	test('a later allocation is above the padding and keeps it alive', () => {
		truth(ORDER, [0, 1, 100, 491, 492]);
	});

	test('a write to the padding, or a cursor reset between the allocation and its test, is refused', () => {
		for (const name of ['orderkill', 'orderstale']) refusal(name);
	});
});

describe('the list', () => {
	test('the bases and their expected answers are the whole list', () => {
		for (const name of Object.keys(YYJSON_BASES))
			assert.equal(
				outcome(name).kind,
				CERTIFY.includes(name) ? 'certificate' : 'refusal',
				name
			);
	});
});
