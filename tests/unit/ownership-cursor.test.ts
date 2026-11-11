import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	allocModuleOf,
	ARENA_BYTES,
	relocationMatches,
	type AllocBase
} from '../../scripts/research/ownership-alloc-modules.ts';
import {
	CURSOR_BASES,
	cursorModule,
	DELAYED,
	regionsMatch
} from '../../scripts/research/ownership-cursor-modules.ts';
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

const refusal = (bytes: Uint8Array, reason = 'ptr-deref') => {
	const r = certifyOwnership(bytes, options);
	assert.equal(r.kind, 'refusal');
	assert.equal((r as OwnershipRefusal).reason, reason, (r as OwnershipRefusal).detail);
	return r as OwnershipRefusal;
};

const edited = (name: string, from: string, to: string) => {
	const base: AllocBase = CURSOR_BASES[name]!;
	const statements = base.statements.map((s) => s.replace(from, to));
	assert.notDeepEqual(statements, base.statements, `no ${from} in ${name}`);
	return allocModuleOf(base, statements);
};

const STEP = '(local.set $c (i32.add (local.get $c) (i32.const 4)))';
const BIG = '(local.set $b (i32.add (local.get $b) (i32.const 5)))';
const SMALL = '(else (local.set $b (i32.add (local.get $b) (i32.const 2))))';

describe('output cursor and counter in a loop', () => {
	test('a cursor bounded by its counter and a counter bounded by a multiple are proved', () => {
		for (const name of Object.keys(CURSOR_BASES)) {
			const bytes = cursorModule(name);
			const c = certificate(bytes);
			if (['cursor', 'rotated', 'bottom'].includes(name)) {
				assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
				assert.deepEqual(
					extremeMatches(bytes, c.allocator!.pointerCells, [1, 15, 371, 372, 1000]),
					{ ok: true },
					name
				);
			}
			assert.ok(verifyOwnership(bytes, c), name);
			assert.ok(c.allocator!.derefsProved > 0, name);
		}
	});

	test('a larger step of the cursor than the bound allows is refused', () => {
		refusal(edited('cursor', BIG, BIG.replace('(i32.const 5)', '(i32.const 7)')));
		refusal(edited('rotated', '(i32.const 5))', '(i32.const 8))'));
	});

	test('a data branch that moves the cursor far is refused', () => {
		refusal(edited('cursor', SMALL, SMALL.replace('(i32.const 2)', '(i32.const 40)')));
	});

	test('a counter that is not a constant step or does not move is refused', () => {
		refusal(edited('cursor', STEP, STEP.replace('(i32.const 4)', '(i32.const 1)')));
		refusal(
			edited(
				'cursor',
				STEP,
				'(local.set $c (i32.add (local.get $c) (select (i32.const 4) (i32.const 0) (i32.load8_u (local.get $p)))))'
			)
		);
	});

	test('a counter bound past the arena is refused', () => {
		refusal(edited('cursor', '(i32.const 372)', '(i32.const 1000)'));
	});

	test('a step that does not divide the extent leaves the write past the arena', () => {
		refusal(edited('stride', STEP, STEP.replace('(i32.const 4)', '(i32.const 3)')));
		refusal(edited('stride', 'offset=3', 'offset=4'));
	});

	test('a loop that never ends is refused without running the retry for long', () => {
		const started = performance.now();
		refusal(
			edited(
				'stride',
				'(br_if $d (i32.ge_u (local.get $c)',
				'(br_if $d (i32.lt_u (local.get $c)'
			)
		);
		assert.ok(performance.now() - started < 5000);
	});

	test('a record pointer indexed past its slot is accepted and breaks the listed premise, not the domain', () => {
		// found by the adversary: `$slot` as the store base is a record-derived address, which the checker does not
		// bound; 'record-derived pointers stay inside their regions' is a premise of every certificate
		const own = (name: string) => {
			const bytes = cursorModule(name);
			return regionsMatch(bytes, certificate(bytes).windows);
		};
		for (const name of ['cursor', 'rotated', 'stride', 'teesize', 'bottom'])
			assert.deepEqual(own(name), { ok: true }, name);
		const base = CURSOR_BASES.stride!;
		const statements = base.statements.map((s) =>
			s.replace(
				'(i32.add (local.get $a) (local.get $c))',
				'(i32.add (local.get $slot) (local.get $c))'
			)
		);
		const bad = allocModuleOf(base, statements);
		const c = certificate(bad);
		assert.equal(regionsMatch(bad, c.windows).ok, false);
	});

	test('a step that grows after the first iteration is refused', () => {
		refusal(allocModuleOf(DELAYED));
	});

	test('a bottom-tested loop with a step that does not divide the extent is refused', () => {
		const step = '(local.tee $c (i32.add (local.get $c) (i32.const 4)))';
		refusal(edited('bottom', step, step.replace('(i32.const 4)', '(i32.const 3)')));
		refusal(edited('bottom', 'offset=3', 'offset=4'));
	});

	test('a null allocation is refused', () => {
		refusal(edited('stride', '(if (local.get $a) (then', '(if (i32.const 1) (then'));
	});

	test('the allocation size is not the obligation, the arena is', () => {
		const bytes = edited('cursor', '(i32.const 480)', '(i32.const 100)');
		const c = certificate(bytes);
		assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true });
	});
});
