import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ARENA_BYTES, relocationMatches } from '../../scripts/research/ownership-alloc-modules.ts';
import { assemble, routeMatches } from '../../scripts/research/ownership-modules.ts';
import {
	COUNT,
	EXTENT_MUTANTS,
	extentBytes,
	mutantBytes,
	PARSER,
	relWat,
	TOKEN_MUTANTS,
	tokenBytes,
	TOKENS
} from '../../scripts/research/ownership-relational-modules.ts';
import { redirectOwnership } from '../../src/ownership-redirect.ts';
import {
	certifyOwnership,
	OWNERSHIP_REASONS,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const certificate = (bytes: Uint8Array) => {
	const r = certifyOwnership(bytes);
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

describe('relational bounds over a token table', () => {
	test('a store loop bounded through memory cells and a walking pointer certifies and routes', () => {
		const bytes = tokenBytes();
		const c = certificate(bytes);
		assert.deepEqual(c.windows, [{ low: TOKENS, end: Math.ceil((PARSER + 12) / 64) * 64 }]);
		assert.ok(verifyOwnership(bytes, c));
		assert.ok(routeMatches(bytes, c.windows, [1, 2, 3, 4, 5, 6]));
		assert.equal(COUNT, 16);
	});

	test('mutants that leave the array or the proof are refused with their reason', () => {
		for (const m of TOKEN_MUTANTS) {
			const bytes = mutantBytes(m);
			const r = certifyOwnership(bytes);
			if (m.reason === 'none') {
				assert.equal(r.kind, 'certificate', m.name);
				assert.ok(
					routeMatches(bytes, (r as OwnershipCertificate).windows, [1, 2, 3, 4]),
					m.name
				);
				continue;
			}
			assert.equal(r.kind, 'refusal', m.name);
			assert.equal((r as OwnershipRefusal).reason, m.reason, m.name);
			assert.ok(OWNERSHIP_REASONS.includes((r as OwnershipRefusal).reason));
		}
	});
});

describe('relations stay inside one call', () => {
	test('a relation made in one call does not bound the locals of the next call', () => {
		// the first call makes b = 16 * a for a in [0, 3]; the second passes a data value as b
		const f = `(func $f (param $a i32) (param $b i32)
			(i32.store8 (i32.add (i32.const ${TOKENS}) (local.get $b)) (i32.const 1))
			(local.set $b (i32.shl (local.get $a) (i32.const 4))))`;
		const body = `(memory.fill (i32.const ${TOKENS}) (i32.const 0) (i32.const 64))
			(call $f (i32.and (local.get $len) (i32.const 3)) (i32.const 0))
			(call $f (i32.and (local.get $len) (i32.const 1)) (local.get $len))`;
		const r = certifyOwnership(assemble(relWat(body, f)));
		assert.ok(r.kind === 'refusal' || r.wildStores > 0);
	});
});

describe('the redirect', () => {
	test('a constant base with a large offset into a window is lowered', () => {
		// jsmn writes its parser at offset 76840 from address 0; the window starts below that offset
		const body = `(i32.store offset=${TOKENS + 4} (i32.const 0) (local.get $len))
			(i32.store (local.get $slot) (i32.load offset=${TOKENS + 4} (i32.const 0)))`;
		const bytes = assemble(relWat(body, '', 40));
		const c = certificate(bytes);
		assert.equal(redirectOwnership(bytes, c).stats.redirected > 0, true);
	});
});

describe('allocation extents', () => {
	const options = { allocator: { arenaBytes: ARENA_BYTES } };

	test('a fixed buffer behind data-sized allocations is indexed at data-dependent offsets', () => {
		const bytes = extentBytes();
		const r = certifyOwnership(bytes, options);
		assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
		assert.deepEqual(relocationMatches(bytes, r as OwnershipCertificate, [1, 2, 3, 4]), {
			ok: true
		});
		assert.ok((r as OwnershipCertificate).allocator!.derefsProved > 0);
	});

	test('an index past the buffer, a limit past the arena or a missing null test is refused', () => {
		for (const m of EXTENT_MUTANTS) {
			const bytes = extentBytes(m.shape);
			const r = certifyOwnership(bytes, options);
			if (m.reason === 'none') {
				assert.equal(r.kind, 'certificate', m.name);
				assert.deepEqual(
					relocationMatches(bytes, r as OwnershipCertificate, [1, 2, 3]),
					{ ok: true },
					m.name
				);
				continue;
			}
			assert.equal(r.kind, 'refusal', m.name);
			assert.equal((r as OwnershipRefusal).reason, m.reason, m.name);
		}
	});
});
