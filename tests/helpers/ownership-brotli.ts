import assert from 'node:assert/strict';
import { ARENA_BYTES, relocationMatches } from '../../scripts/research/ownership-alloc-modules.ts';
import {
	BROTLI_BASES,
	BROTLI_CERTIFY,
	brotliModule
} from '../../scripts/research/ownership-brotli-modules.ts';
import { extremeMatches } from '../../scripts/research/ownership-extent-modules.ts';
import {
	certifyOwnership,
	verifyOwnership,
	type OwnershipCertificate,
	type OwnershipRefusal
} from '../../src/ownership.ts';

const options = { allocator: { arenaBytes: ARENA_BYTES } };

// one checker run per base in a file: the ground truth and the answer list share it
export function brotliHarness() {
	const answers = new Map<string, ReturnType<typeof certifyOwnership>>();
	const outcome = (name: string) => {
		if (!answers.has(name)) answers.set(name, certifyOwnership(brotliModule(name), options));
		return answers.get(name)!;
	};
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
	const groundTruth = (name: string) => {
		const bytes = brotliModule(name);
		const c = certificate(name);
		assert.deepEqual(relocationMatches(bytes, c, [1]), { ok: true }, name);
		assert.deepEqual(
			extremeMatches(bytes, c.allocator!.pointerCells, [0, 9, 400]),
			{ ok: true },
			name
		);
		assert.ok(verifyOwnership(bytes, c), name);
	};
	// every base the file's pattern names has the expected answer
	const wholeList = (pattern: RegExp) => {
		for (const name of Object.keys(BROTLI_BASES).filter((n) => pattern.test(n)))
			assert.equal(
				outcome(name).kind,
				BROTLI_CERTIFY.includes(name) ? 'certificate' : 'refusal',
				name
			);
	};
	return { outcome, certificate, refusal, groundTruth, wholeList };
}
