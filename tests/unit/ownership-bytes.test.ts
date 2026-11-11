import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	allocModuleOf,
	ARENA_BYTES,
	relocationMatches
} from '../../scripts/research/ownership-alloc-modules.ts';
import { BYTES_BASES, bytesModule } from '../../scripts/research/ownership-bytes-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
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
	const base = BYTES_BASES[name]!;
	const statements = base.statements.map((s) => s.replace(from, to));
	assert.notDeepEqual(statements, base.statements, `no ${from} in ${name}`);
	return allocModuleOf(base, statements);
};

const without = (name: string, text: string) => {
	const base = BYTES_BASES[name]!;
	const statements = base.statements.filter((s) => !s.includes(text));
	assert.notEqual(statements.length, base.statements.length, `no ${text} in ${name}`);
	return allocModuleOf(base, statements);
};

describe('byte fields in the arena', () => {
	test('every hand module certifies and the ground truth agrees', () => {
		for (const name of Object.keys(BYTES_BASES)) {
			const bytes = bytesModule(name);
			const c = certificate(bytes);
			assert.ok(verifyOwnership(bytes, c), name);
			if (!['switchtype', 'signed', 'table', 'cells', 'bitbranch'].includes(name)) continue;
			assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
			assert.deepEqual(extremeMatches(bytes, c.allocator!.pointerCells, [496]), { ok: true });
		}
	});

	test('a switch target narrows the stored type, and a target that names a cell nothing stored is refused', () => {
		refusal(edited('switchtype', '$z $t $t $done', '$t $t $t $done'), 'read-before-write');
		refusal(edited('switchtype', '$z $t $t $done', '$z $t $t $t'), 'read-before-write');
		refusal(without('switchtype', 'offset=24'), 'read-before-write');
	});

	test('a signed byte keeps both halves of its range, and a branch on its sign narrows one half', () => {
		refusal(edited('signed', 'i32.lt_s', 'i32.gt_s'), 'ptr-deref');
		refusal(
			edited('signed', '(i32.xor (local.get $d) (i32.const -1))', '(local.get $d)'),
			'ptr-deref'
		);
		refusal(
			edited(
				'signed',
				'(i32.shl (local.get $d) (i32.const 1))',
				'(i32.shl (local.get $d) (i32.const 3))'
			),
			'ptr-deref'
		);
	});

	test('a compare, a shift and a join of signed bytes keep what they prove and no more', () => {
		refusal(edited('signedcmp', '(i32.const -200)', '(i32.const -100)'), 'ptr-deref');
		refusal(
			edited(
				'signedshl',
				'(i32.shl (local.get $d) (i32.const 1))',
				'(i32.shl (local.get $d) (i32.const 2))'
			),
			'ptr-deref'
		);
		refusal(edited('signedjoin', '(i32.const 128)', '(i32.const 100)'), 'ptr-deref');
		refusal(edited('switchdead', '(i32.const 1))', '(i32.const 3))'), 'ptr-deref');
	});

	test('a constant table at an index set gives the hull of its entries', () => {
		refusal(
			edited(
				'table',
				'(i32.and (local.get $sum) (i32.const 7))',
				'(i32.and (local.get $sum) (i32.const 15))'
			),
			'ptr-deref'
		);
		const base = BYTES_BASES.table!;
		const big = allocModuleOf({ ...base, extra: base.extra!.replace('\\90\\01', '\\90\\02') });
		refusal(big, 'ptr-deref');
	});

	test('a struct table read at its stride gives one field, and the other field or a narrower stride gives both', () => {
		refusal(edited('structs', 'offset=100000', 'offset=100004'), 'ptr-deref');
		refusal(
			edited('structs', '(i32.const 3)) (i32.const 3))', '(i32.const 3)) (i32.const 2))'),
			'ptr-deref'
		);
	});

	test('a set bit and an identity mask keep the lower bound of a masked value', () => {
		refusal(
			edited(
				'bitbranch',
				'(i32.const 256))\n\t\t\t\t(then',
				'(i32.const 128))\n\t\t\t\t(then'
			),
			'ptr-deref'
		);
		refusal(
			edited(
				'bitbranch',
				'(local.set $d (i32.and (local.get $d) (i32.const 511)))',
				'(local.set $d (i32.and (local.get $d) (i32.const 255)))'
			),
			'ptr-deref'
		);
	});

	test('a write at an aligned index joins into the cells it may replace, and an unbounded value or a cell nothing stored is refused', () => {
		refusal(
			edited('cells', '(i32.and (local.get $sum) (i32.const 7)))', '(local.get $sum))'),
			'ptr-deref'
		);
		refusal(
			edited(
				'cells',
				'(i32.shl (i32.and (local.get $len) (i32.const 3)) (i32.const 2))',
				'(i32.shl (i32.and (local.get $len) (i32.const 3)) (i32.const 3))'
			),
			'ptr-deref'
		);
		refusal(without('cells', 'offset=12'), 'ptr-deref');
	});

	test('a read that overlaps a stored pointer is tainted and an integer read beside it is not', () => {
		refusal(
			edited('pointers', '(i32.const 16)) (i32.and', '(i32.const 4)) (i32.and'),
			'ptr-deref'
		);
	});
});
