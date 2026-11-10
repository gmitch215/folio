import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	ALLOC_BASES,
	ALLOC_INSERTS,
	ALLOC_REFUSALS,
	allocBytes,
	allocModuleOf,
	ARENA_BYTES,
	ARENAS,
	relocationMatches,
	SLICE
} from '../../scripts/research/ownership-alloc-modules.ts';
import { redirectOwnership } from '../../src/ownership-redirect.ts';
import {
	certifyOwnership,
	guardRecords,
	OWNERSHIP_REASONS,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

const certificate = (bytes: Uint8Array) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

const refusal = (bytes: Uint8Array, reason: string) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'refusal');
	assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
	assert.ok(OWNERSHIP_REASONS.includes((r as OwnershipRefusal).reason));
	return r as OwnershipRefusal;
};

const list = ALLOC_BASES.list!;
const at = (base: typeof list, insert: string, position: number) => {
	const add = ALLOC_INSERTS[insert]!;
	return allocModuleOf(
		base,
		[...base.statements.slice(0, position), add.text, ...base.statements.slice(position)],
		insert
	);
};

describe('allocator certificate', () => {
	test('a bump allocator with a linked list inside the arena certifies and relocates', () => {
		const bytes = allocBytes('list');
		const c = certificate(bytes);
		assert.deepEqual(c.windows, [{ low: 4096, end: 4160 }]);
		assert.deepEqual(c.allocator?.pointerCells, [[4096, 4100]]);
		assert.deepEqual(c.allocator?.arenaTaint, [
			[20, 24],
			[52, 56]
		]);
		assert.equal(c.wildStores, 0);
		assert.ok(c.allocator!.derefsProved > 0);
		assert.ok(verifyOwnership(bytes, c));
		assert.deepEqual(relocationMatches(bytes, c, [1, 2, 3, 4, 5, 6]), { ok: true });
		assert.ok(guardRecords(c, [[ARENAS, ARENAS + 8 * SLICE]]));
		assert.ok(!guardRecords(c, [[4100, 4110]]));
	});

	test('byte buffers, a bounded loop and a stack spill certify and relocate', () => {
		for (const name of ['bytes', 'chain', 'spill']) {
			const bytes = allocBytes(name);
			const c = certificate(bytes);
			assert.deepEqual(relocationMatches(bytes, c, [1, 2, 3]), { ok: true }, name);
		}
	});

	test('without the option the allocator module is still refused as before', () => {
		const r = certifyOwnership(allocBytes('list'));
		assert.equal(r.kind, 'refusal');
		assert.equal((r as OwnershipRefusal).reason, 'allocator');
		const c = certificate(allocBytes('list'));
		assert.equal(c.kind, 'certificate');
		assert.equal(certifyOwnership(allocBytes('bytes')).kind, 'refusal');
	});

	test('one minimal refusing module per provenance rule', () => {
		assert.deepEqual(
			ALLOC_REFUSALS.map((x) => x.rule),
			['store', 'return', 'import', 'compare', 'control', 'deref', 'cursor']
		);
		for (const x of ALLOC_REFUSALS) refusal(x.build(), x.reason);
	});

	test('the provenance reasons are in the closed list and map to one obligation', () => {
		for (const reason of [
			'ptr-store',
			'ptr-return',
			'ptr-import',
			'ptr-compare',
			'ptr-control',
			'ptr-deref'
		])
			assert.ok(OWNERSHIP_REASONS.includes(reason as never), reason);
		const r = refusal(at(list, 'store-ptr-out', list.statements.length), 'ptr-store');
		assert.equal(r.obligation, 'provenance');
	});

	test('pointer operations that keep the offset certify and relocate', () => {
		for (const insert of [
			'return-ptr-diff',
			'compare-zero',
			'compare-ptrs',
			'truthy',
			'store-bounded',
			'copy-arena-data-out',
			'copy-out-arena',
			'fill-arena',
			'shift-base',
			'store-ptr-window',
			'store-ptr-arena-masked',
			'bump-set-twice',
			'alloc-data-size-use'
		]) {
			const bytes = at(list, insert, 5);
			const c = certificate(bytes);
			assert.deepEqual(relocationMatches(bytes, c, [1, 2, 3, 4]), { ok: true }, insert);
		}
	});

	test('a pointer that leaves the arena or reaches control flow is refused with its reason', () => {
		const cases: [string, string][] = [
			['store-ptr-field-out', 'ptr-store'],
			['store-ptr-masked-out', 'ptr-store'],
			['store-ptr-shifted-out', 'ptr-store'],
			['store-ptr-plus-data-out', 'ptr-store'],
			['store-ptr-wide-out', 'ptr-store'],
			['store-ptr-input', 'ptr-store'],
			['copy-arena-out', 'ptr-store'],
			['fill-ptr-byte', 'ptr-store'],
			['import-ptr-field', 'ptr-import'],
			['compare-signed-const', 'ptr-compare'],
			['compare-data', 'ptr-compare'],
			['compare-wide', 'ptr-compare'],
			['hash-select', 'ptr-control'],
			['hash-xor-branch', 'ptr-control'],
			['hash-mul-branch', 'ptr-control'],
			['deref-negative', 'ptr-deref'],
			['deref-edge', 'ptr-deref'],
			['deref-dynamic', 'ptr-deref'],
			['store-dynamic', 'ptr-deref'],
			['copy-arena-dynamic', 'ptr-deref'],
			['return-ptr-sum', 'ptr-return']
		];
		for (const [insert, reason] of cases)
			refusal(at(list, insert, list.statements.length), reason);
		// the shifted base puts the first allocation past the arena, so it only matters before bump_set
		refusal(at(list, 'shift-base-far', 0), 'ptr-deref');
		certificate(at(list, 'shift-base-far', list.statements.length));
	});

	test('a pointer stored in a window, the arena or the stack keeps its taint when read back', () => {
		// a store at a bounded window address kills the region cell, so the next malloc is not a plain offset
		const killed = allocModuleOf(
			list,
			[
				...list.statements.slice(0, 1),
				ALLOC_INSERTS['store-ptr-window-bounded']!.text,
				...list.statements.slice(1)
			],
			undefined
		);
		const killedResult = certifyOwnership(killed, options);
		assert.equal(killedResult.kind, 'refusal');
		assert.ok(
			['ptr-deref', 'final-state', 'read-before-write'].includes(
				(killedResult as OwnershipRefusal).reason
			)
		);
		// a zeroed next field loses the cell; the walk then reads a tainted value it cannot dereference
		refusal(at(list, 'fill-arena-over-ptr', 10), 'ptr-deref');
		// the adversary found this one: a pointer stored above the entry stack pointer left the frame
		refusal(at(list, 'stack-store-ptr', list.statements.length), 'ptr-store');
		// a spilled pointer reloaded from the stack is still a pointer
		const spill = ALLOC_BASES.spill!;
		refusal(at(spill, 'reload-out', spill.statements.length - 1), 'ptr-store');
		refusal(at(spill, 'reload-hash', spill.statements.length - 1), 'ptr-control');
	});

	test('a cursor read before bump_set is refused and one after it is not', () => {
		refusal(at(list, 'cursor-read-out', 0), 'read-before-write');
		refusal(at(list, 'limit-read-out', 0), 'read-before-write');
		certificate(at(list, 'cursor-read-out', 5));
		certificate(at(list, 'alloc-past-limit', 5));
	});

	test('the checker states what it assumes and what a router that moves the arena must do', () => {
		const c = certificate(allocBytes('list'));
		assert.equal(c.allocator?.arenaBytes, ARENA_BYTES);
		assert.deepEqual(Object.keys(c.allocator!.rules).sort(), [
			'compare',
			'control',
			'deref',
			'import',
			'return',
			'store'
		]);
		assert.match(c.allocator!.shiftRule, /pointerCells/);
		assert.ok(c.allocator!.assumptions.length >= 3);
	});

	test('the certificate is bound to the arena size it was made with', () => {
		const bytes = allocBytes('list');
		const c = certificate(bytes);
		assert.ok(
			!verifyOwnership(bytes, { ...c, allocator: { ...c.allocator!, arenaBytes: 64 } })
		);
		const bigger = certifyOwnership(bytes, { allocator: { arenaBytes: 4096 } });
		assert.equal(bigger.kind, 'certificate');
	});

	test('assuming heap dereferences are in bounds never returns a certificate', () => {
		const bytes = at(list, 'deref-dynamic', list.statements.length);
		const r = certifyOwnership(bytes, {
			allocator: { arenaBytes: ARENA_BYTES, assumeInArena: true }
		});
		assert.equal(r.kind, 'refusal');
		assert.match((r as OwnershipRefusal).detail, /heap dereferences|plain offset/);
		const ok = certifyOwnership(allocBytes('list'), {
			allocator: { arenaBytes: ARENA_BYTES, assumeInArena: true }
		});
		assert.equal(ok.kind, 'certificate');
	});

	test('the redirect accepts an allocator certificate', () => {
		const bytes = allocBytes('list', undefined, 40);
		const c = certificate(bytes);
		const redirect = redirectOwnership(bytes, c);
		assert.ok(redirect.stats.redirected > 0);
		assert.equal(c.wildStores, 0);
	});

	test('every insertion operator expects only reasons from the closed list', () => {
		for (const [name, add] of Object.entries(ALLOC_INSERTS))
			for (const reason of add.expect)
				assert.ok(reason === 'none' || OWNERSHIP_REASONS.includes(reason as never), name);
	});
});
