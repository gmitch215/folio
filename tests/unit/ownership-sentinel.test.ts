import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ARENA_BYTES, relocationMatches } from '../../scripts/research/ownership-alloc-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
import {
	SENTINEL_BASES,
	sentinelModule
} from '../../scripts/research/ownership-sentinel-modules.ts';
import {
	certifyOwnership,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

const outcome = (name: string) => certifyOwnership(sentinelModule(name), options);

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

describe('scans that stop at zero padding', () => {
	test('a scan that reads only nonzero bytes below the padding is proved and matches the runs', () => {
		for (const name of [
			'space',
			'nul',
			'short',
			'step2',
			'inplace',
			'peek',
			'tabnul',
			'offsetscan',
			'belownum',
			'above'
		]) {
			const bytes = sentinelModule(name);
			const c = certificate(name);
			assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
			assert.deepEqual(
				extremeMatches(bytes, c.allocator!.pointerCells, [0, 397, 401]),
				{ ok: true },
				name
			);
			assert.ok(verifyOwnership(bytes, c), name);
		}
	});

	test('a scan with no padding, a short padding or a step wider than the padding is refused', () => {
		for (const name of ['nopad', 'step2short', 'step5']) refusal(name);
	});

	test('padding that is not zero, not at the end or overwritten before the scan is refused', () => {
		for (const name of ['nonzero', 'early', 'overwrite', 'overcopy', 'farstore']) refusal(name);
	});

	test('a pointer that moved past the end of the buffer or a write ahead of the cursor is refused', () => {
		for (const name of ['beyond', 'ahead']) refusal(name);
	});

	test('a table whose entry for byte 0 has the tested bit proves nothing', () => {
		for (const name of ['tabzero', 'tabstore']) refusal(name);
	});

	test('a zero byte read, or a padding that is not the last one made, proves nothing', () => {
		for (const name of ['zeroscan', 'stale']) refusal(name);
	});

	test('the bases and their expected answers are the whole list', () => {
		const certify = [
			'space',
			'nul',
			'short',
			'step2',
			'inplace',
			'peek',
			'tabnul',
			'offsetscan',
			'belownum',
			'above'
		];
		for (const name of Object.keys(SENTINEL_BASES))
			assert.equal(
				outcome(name).kind,
				certify.includes(name) ? 'certificate' : 'refusal',
				name
			);
	});
});
