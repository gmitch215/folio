import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	allocModuleOf,
	ARENA_BYTES,
	relocationMatches
} from '../../scripts/research/ownership-alloc-modules.ts';
import { regionsMatch } from '../../scripts/research/ownership-cursor-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
import {
	STACKIDX_BASES,
	stackIdxModule
} from '../../scripts/research/ownership-stackidx-modules.ts';
import {
	certifyOwnership,
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

const refusal = (bytes: Uint8Array, reason?: string) => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'refusal');
	if (reason)
		assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
	return r as OwnershipRefusal;
};

const edited = (name: string, from: string, to: string) => {
	const base = STACKIDX_BASES[name]!;
	const statements = base.statements.map((s) => s.replace(from, to));
	assert.notDeepEqual(statements, base.statements, `no ${from} in ${name}`);
	return allocModuleOf(base, statements);
};

const without = (name: string, text: string) => {
	const base = STACKIDX_BASES[name]!;
	const statements = base.statements.filter((s) => !s.includes(text));
	assert.notEqual(statements.length, base.statements.length, `no ${text} in ${name}`);
	return allocModuleOf(base, statements);
};

const INDEX = '(i32.shl (local.get $k) (i32.const 2))';
const CELL = (at: number) => `(i32.store offset=${at} (global.get $sp)`;

describe('a stack array read and written at a bounded data index', () => {
	test('a read joins the cells it may name, and the ground truth agrees', () => {
		for (const name of Object.keys(STACKIDX_BASES)) {
			if (name === 'pointerwrite' || name === 'big') continue;
			const bytes = stackIdxModule(name);
			const c = certificate(bytes);
			assert.ok(verifyOwnership(bytes, c), name);
			if (!['mask', 'constants', 'write', 'branch', 'odd', 'mul'].includes(name)) continue;
			assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
			assert.deepEqual(
				extremeMatches(bytes, c.allocator!.pointerCells, [496]),
				{ ok: true },
				name
			);
		}
	});

	test('an index mask one bit wider reads a cell nothing stored', () => {
		refusal(edited('mask', '(i32.const 3)))', '(i32.const 7)))'), 'read-before-write');
	});

	test('a stride that does not match the cells names cells nothing stored', () => {
		refusal(edited('mask', INDEX, '(i32.shl (local.get $k) (i32.const 1))'), 'ptr-deref');
		refusal(
			edited(
				'wide',
				'(i32.shl (local.get $k) (i32.const 3))',
				'(i32.shl (local.get $k) (i32.const 2))'
			),
			'read-before-write'
		);
	});

	test('an unbounded index and an index that passes the entry stack pointer are not proved', () => {
		refusal(
			edited('mask', '(i32.and (local.get $sum) (i32.const 3))', '(local.get $sum)'),
			'read-before-write'
		);
		refusal(
			edited(
				'mask',
				'(i32.add (global.get $sp) (i32.const 16))',
				'(i32.add (global.get $sp) (i32.const 52))'
			),
			'read-before-write'
		);
		refusal(edited('compare', 'i32.ge_u', 'i32.gt_u'), 'read-before-write');
	});

	test('a cell nothing stored, a cell holding a plain value and a base off by one stay refused', () => {
		refusal(without('mask', 'offset=28'), 'read-before-write');
		refusal(
			edited('mask', `${CELL(28)} (local.get $d))`, `${CELL(28)} (local.get $sum))`),
			'ptr-deref'
		);
		refusal(edited('offset', 'offset=16', 'offset=12'), 'read-before-write');
	});

	test('a read at an index before any cell is written is refused (found by the adversary)', () => {
		const base = STACKIDX_BASES.write!;
		const read =
			'(i32.store8 (i32.add (local.get $a) (i32.and (i32.load (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 2)))) (i32.const 15))) (local.get $sum))';
		const statements = [...base.statements.slice(0, 3), read, ...base.statements.slice(3)];
		refusal(allocModuleOf(base, statements), 'read-before-write');
	});

	test('a set of more than 64 cells is not enumerated', () => {
		refusal(stackIdxModule('big'), 'ptr-deref');
	});

	test('a constant cell outside the allocation is refused', () => {
		refusal(edited('constants', '(i32.const 64))', '(i32.const 1000))'), 'ptr-deref');
	});

	test('a loop over more cells than the array holds reads a byte nothing wrote', () => {
		refusal(
			edited(
				'loop',
				'(i32.ge_u (local.get $k) (i32.const 4))',
				'(i32.ge_u (local.get $k) (i32.const 5))'
			),
			'read-before-write'
		);
	});

	test('a pointer stored at an interval index may sit in any cell it names', () => {
		refusal(stackIdxModule('pointerwrite'), 'ptr-deref');
		refusal(edited('write', '(i32.const 3)))', '(i32.const 7)))'));
	});

	test('a branch that joins two stack addresses keeps both offsets', () => {
		refusal(
			edited('branch', '(i32.const 24)) (i32.and', '(i32.const 32)) (i32.and'),
			'read-before-write'
		);
	});

	test('a stack address indexed past the frames is accepted and breaks the listed premise, not the domain', () => {
		const inserts = [
			'(i32.store (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 31)) (i32.const 2))) (local.get $sum))',
			'(i32.store (i32.add (global.get $sp) (i32.shl (i32.and (local.get $sum) (i32.const 63)) (i32.const 2))) (local.get $sum))'
		];
		for (const name of ['mask', 'compare']) {
			const base = STACKIDX_BASES[name]!;
			const own = (statements: string[]) => {
				const bytes = allocModuleOf(base, statements);
				return regionsMatch(bytes, certificate(bytes).windows);
			};
			assert.deepEqual(own(base.statements), { ok: true }, name);
			for (const text of inserts) {
				const bad = [...base.statements.slice(0, 3), text, ...base.statements.slice(3)];
				assert.equal(own(bad).ok, false, name);
			}
		}
	});
});
