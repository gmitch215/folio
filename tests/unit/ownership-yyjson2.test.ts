import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ARENA_BYTES, relocationMatches } from '../../scripts/research/ownership-alloc-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
import { YYJSON2_BASES, yyjson2Module } from '../../scripts/research/ownership-yyjson2-modules.ts';
import {
	certifyOwnership,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

const outcome = (name: string) => certifyOwnership(yyjson2Module(name), options);

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

const WORDS = ['wordjoin', 'wordsummary'];
const TRAILS = ['trail', 'trailcopy'];
const CERTIFY = [...WORDS, ...TRAILS];

const truth = (names: string[]) => {
	for (const name of names) {
		const bytes = yyjson2Module(name);
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

describe('a word local joins words read at the address in another local', () => {
	test('the word of the first copy and the words of a loop that moves the address are tested through the address local', () => {
		truth(WORDS);
	});

	test('a word read from another address, a moved or changed local, a store to the padding, or a copy past it is refused', () => {
		for (const name of [
			'wordjoinother',
			'wordjoinback',
			'wordjoinmove',
			'wordjoinc',
			'wordjoinstore',
			'wordjoinpast',
			'wordsummaryother'
		])
			refusal(name);
	});
});

describe('a destination pointer that trails a source pointer', () => {
	test('writes at the destination are inside the bound of the source tests, also through a copy of the destination', () => {
		truth(TRAILS);
	});

	test('a destination that can pass the source, or that is reset to the padding, is refused', () => {
		for (const name of ['trailup', 'trailpast', 'trailreset', 'trailcopyup']) refusal(name);
	});
});

describe('the list', () => {
	test('the bases and their expected answers are the whole list', () => {
		for (const name of Object.keys(YYJSON2_BASES))
			assert.equal(
				outcome(name).kind,
				CERTIFY.includes(name) ? 'certificate' : 'refusal',
				name
			);
	});
});
