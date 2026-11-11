import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	allocModuleOf,
	ARENA_BYTES,
	relocationMatches
} from '../../scripts/research/ownership-alloc-modules.ts';
import {
	CAP_BASES,
	CAP_REFUSALS,
	capModule,
	capRefusal
} from '../../scripts/research/ownership-cap-modules.ts';
import { regionsMatch } from '../../scripts/research/ownership-cursor-modules.ts';
import { extremeMatches, SHIM_FUNCS } from '../../scripts/research/ownership-extent-modules.ts';
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
	const base = CAP_BASES[name]!;
	const statements = base.statements.map((s) => s.replace(from, to));
	assert.notDeepEqual(statements, base.statements, `no ${from} in ${name}`);
	return allocModuleOf(base, statements);
};

const FILLS = [
	'fillzero',
	'fillinstr',
	'fillbyte',
	'fillcut',
	'fillbranch',
	'fillcopy',
	'fillnest',
	'fillover',
	'fillindex',
	'switchshift',
	'bulkwritten',
	'bulkpad',
	'bulkbig'
];
const SELECTS = ['selclamp', 'selfalse', 'selmin', 'selsum'];

describe('a stack struct filled by a long memset', () => {
	test('a field read of the fill is known, and the ground truth agrees', () => {
		for (const name of FILLS) {
			const bytes = capModule(name);
			const c = certificate(bytes);
			assert.ok(verifyOwnership(bytes, c), name);
			assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
			if (!['fillzero', 'fillover', 'fillbranch'].includes(name)) continue;
			assert.deepEqual(
				extremeMatches(bytes, c.allocator!.pointerCells, [496]),
				{ ok: true },
				name
			);
		}
	});

	test('a read past the end of the fill names bytes nothing wrote', () => {
		refusal(edited('fillzero', 'offset=120', 'offset=430'), 'read-before-write');
		refusal(edited('fillzero', 'offset=300', 'offset=414'), 'read-before-write');
		refusal(edited('fillinstr', 'offset=300', 'offset=414'), 'read-before-write');
	});

	test('a store over the fill replaces what a read sees', () => {
		refusal(
			edited(
				'fillcut',
				'(i32.store offset=120 (global.get $sp) (i32.const 8))',
				'(i32.store offset=120 (global.get $sp) (local.get $sum))'
			),
			'ptr-deref'
		);
		refusal(
			edited(
				'fillcut',
				'(global.get $sp) (i32.const 8))',
				'(global.get $sp) (i32.const 800))'
			),
			'ptr-deref'
		);
	});

	test('a store on one path leaves the field unknown after the join, and the other fields known', () => {
		refusal(edited('fillbranch', 'offset=124', 'offset=120'), 'ptr-deref');
		refusal(edited('fillbranch', 'offset=124', 'offset=122'), 'ptr-deref');
	});

	test('a copied struct is written but its bytes are not known', () => {
		refusal(
			edited(
				'fillcopy',
				'(i32.store (local.get $slot) (i32.load offset=120 (global.get $sp)))',
				'(i32.store8 (i32.add (local.get $a) (i32.load offset=120 (global.get $sp))) (local.get $sum))'
			),
			'ptr-deref'
		);
	});

	test('a fill byte that is not zero is not read as zero', () => {
		refusal(
			edited(
				'fillbyte',
				'(i32.load8_u offset=120 (global.get $sp))',
				'(i32.load16_u offset=120 (global.get $sp))'
			),
			'ptr-deref'
		);
	});

	test('a wide store inside the fill splits it', () => {
		refusal(
			edited('fillnest', '(i64.const 8)', '(i64.extend_i32_u (local.get $sum))'),
			'ptr-deref'
		);
		refusal(
			edited(
				'fillnest',
				'offset=120 (global.get $sp) (i64',
				'offset=121 (global.get $sp) (i64'
			),
			'ptr-deref'
		);
	});

	test('a pointer in the fill, two fills that disagree and an index past the end stay refused', () => {
		for (const name of Object.keys(CAP_REFUSALS))
			refusal(capRefusal(name), CAP_REFUSALS[name]!.reason);
	});

	test('a br_table on an index shifted down narrows the index at its target', () => {
		refusal(
			edited(
				'switchshift',
				'(i32.shr_u (local.get $k) (i32.const 6))',
				'(i32.shr_u (local.get $k) (i32.const 7))'
			),
			'read-before-write'
		);
		refusal(
			edited(
				'switchshift',
				'(br_table $rd $out $out $out $out',
				'(br_table $out $rd $out $out $out'
			),
			'read-before-write'
		);
	});

	test('a stack read at an unknown offset may name a byte nothing wrote (found by the adversary)', () => {
		const statements = CAP_REFUSALS.indexpast!.statements.filter((_, i) => i !== 4);
		refusal(allocModuleOf({ stack: true, extra: SHIM_FUNCS, statements }), 'read-before-write');
	});
});

describe('a select whose arm is cut by its own condition', () => {
	test('each arm is bounded by its side of the condition, and the ground truth agrees', () => {
		for (const name of SELECTS) {
			const bytes = capModule(name);
			const c = certificate(bytes);
			assert.ok(verifyOwnership(bytes, c), name);
			assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
		}
	});

	test('a bound that is too loose, or on the wrong arm, is refused', () => {
		refusal(edited('selclamp', '(i32.const 8))))', '(i32.const 100))))'), 'ptr-deref');
		refusal(
			edited(
				'selclamp',
				'(select (local.get $k) (i32.const 7)',
				'(select (i32.const 7) (local.get $k)'
			),
			'ptr-deref'
		);
		refusal(edited('selfalse', 'i32.ge_u', 'i32.lt_u'), 'ptr-deref');
		refusal(edited('selsum', '(i32.const 7)))', '(i32.const 100)))'), 'ptr-deref');
	});

	test('a condition on another value does not bound the arm', () => {
		refusal(
			edited(
				'selclamp',
				'(i32.lt_u (local.get $k) (i32.const 8))',
				'(i32.lt_u (local.get $sum) (i32.const 8))'
			),
			'ptr-deref'
		);
		refusal(
			edited(
				'selmin',
				'(i32.lt_u (local.get $k) (local.get $c))',
				'(i32.lt_u (local.get $c) (local.get $k))'
			),
			'ptr-deref'
		);
	});

	test('a stack address indexed past the frames is accepted and breaks the listed premise, not the domain', () => {
		const indexed =
			'(i32.store (i32.add (global.get $sp) (i32.shl (i32.and (local.get $sum) (i32.const 15)) (i32.const 2))) (local.get $sum))';
		for (const name of ['selclamp', 'selfalse', 'selmin', 'selsum']) {
			const base = CAP_BASES[name]!;
			const own = (statements: string[]) => {
				const bytes = allocModuleOf(base, statements);
				return regionsMatch(bytes, certificate(bytes).windows);
			};
			assert.deepEqual(own(base.statements), { ok: true }, name);
			const bad = [...base.statements.slice(0, 3), indexed, ...base.statements.slice(3)];
			assert.equal(own(bad).ok, false, name);
		}
	});
});
