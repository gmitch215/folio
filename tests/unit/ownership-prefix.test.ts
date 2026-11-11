import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { routeMatches } from '../../scripts/research/ownership-modules.ts';
import {
	mutantModule,
	PREFIX_BASES,
	PREFIX_INSERTS,
	PREFIX_MUTANTS,
	prefixModuleOf
} from '../../scripts/research/ownership-prefix-modules.ts';
import {
	certifyOwnership,
	OWNERSHIP_REASONS,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const SEEDS = [1, 2, 3];
type Hint = true | { cell: number; base: number };

const certificate = (bytes: Uint8Array, prefix: Hint = true) => {
	const r = certifyOwnership(bytes, { prefix });
	assert.equal(r.kind, 'certificate', r.kind === 'refusal' ? r.reason + ' ' + r.detail : '');
	return r as OwnershipCertificate;
};

const refused = (bytes: Uint8Array, prefix: Hint = true) => {
	const r = certifyOwnership(bytes, { prefix });
	assert.equal(r.kind, 'refusal');
	assert.ok(OWNERSHIP_REASONS.includes((r as OwnershipRefusal).reason));
	return r as OwnershipRefusal;
};

const mutant = (name: string) => PREFIX_MUTANTS.find((m) => m.name === name)!;

// an insertion into the body of the sha base, after `at` statements
const inserted = (name: string, at: number) => {
	const b = PREFIX_BASES.sha!;
	return prefixModuleOf(b, [
		...b.statements.slice(0, at),
		PREFIX_INSERTS[name]!.text,
		...b.statements.slice(at)
	]);
};

const expectReason = (bytes: Uint8Array, allowed: string[], label: string) =>
	assert.ok(allowed.includes(refused(bytes).reason), label);

describe('prefix-written domain', () => {
	test('a cursor-indexed buffer certifies, verifies and matches the private route', () => {
		const bytes = prefixModuleOf(PREFIX_BASES.sha!);
		const c = certificate(bytes);
		assert.equal(c.prefix?.cell, 4160);
		assert.equal(c.prefix?.base, 4096);
		assert.ok(c.windows.some((w) => w.low <= 4096 && w.end >= 4168));
		assert.ok(verifyOwnership(bytes, c));
		assert.ok(routeMatches(bytes, c.windows, SEEDS));
		const tail = prefixModuleOf(PREFIX_BASES.tail!);
		assert.ok(routeMatches(tail, certificate(tail).windows, SEEDS));
	});

	test('the option is opt in, and a wrong buffer base is refused', () => {
		const bytes = prefixModuleOf(PREFIX_BASES.sha!);
		const plain = certifyOwnership(bytes);
		assert.equal(plain.kind, 'refusal');
		assert.equal((plain as OwnershipRefusal).reason, 'read-before-write');
		assert.equal(refused(bytes, { cell: 4160, base: 4097 }).reason, 'prefix-cover');
		assert.equal(certificate(bytes, { cell: 4160, base: 4096 }).prefix?.splits, 1);
	});

	test('a cursor that the frontier does not cover is refused', () => {
		for (const name of [
			'cursor-plus-two',
			'skip-a-byte',
			'conditional-byte',
			'reset-above-prefix'
		])
			expectReason(mutantModule(mutant(name)), mutant(name).expect, name);
		expectReason(
			mutantModule(mutant('byte-below-frontier')),
			['prefix-cover', 'read-before-write'],
			'below'
		);
	});

	test('a wide or data-valued cursor store is refused', () => {
		for (const name of ['cursor-wide', 'cursor-data'])
			expectReason(inserted(name, 2), PREFIX_INSERTS[name]!.expect, name);
	});

	test('a write that can reach the cursor through any other path is refused', () => {
		for (const name of ['wide-store', 'copy-over-cursor', 'cursor-byte'])
			assert.equal(refused(inserted(name, 2)).reason, 'prefix-store', name);
	});

	test('a tag that outlives a store to the cursor is never trusted', () => {
		for (const name of ['stale-local-store', 'stale-address', 'stale-sum'])
			assert.equal(refused(inserted(name, 3)).reason, 'prefix-cover', name);
	});

	test('a read past the frontier and a buffer tail that is never written are refused', () => {
		for (const name of ['read-at-cursor', 'read-first-byte', 'peek-call'])
			assert.equal(refused(inserted(name, 3)).reason, 'read-before-write', name);
		const base = PREFIX_BASES.tail!;
		const open = base.statements.filter((s) => !s.includes('memory.fill'));
		assert.equal(refused(prefixModuleOf(base, open)).reason, 'final-state');
	});

	test('a skipped update and a reset that the prefix covers still certify and match the route', () => {
		const base = PREFIX_BASES.sha!;
		const skipped = prefixModuleOf(
			base,
			base.statements.filter((s) => !s.includes('$update'))
		);
		const reset = mutantModule(mutant('reset-to-five'));
		for (const bytes of [skipped, reset])
			assert.ok(routeMatches(bytes, certificate(bytes).windows, SEEDS));
	});

	test('the reasons are on the closed list', () => {
		for (const reason of ['prefix-store', 'prefix-cover'])
			assert.ok(OWNERSHIP_REASONS.includes(reason as never), reason);
	});
});
