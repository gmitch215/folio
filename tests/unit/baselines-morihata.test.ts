import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
	buildHand,
	handKernels,
	lateDeviation
} from '../../scripts/research/baselines/hand-kernels.ts';
import { workerSummarizer } from '../../scripts/research/baselines/morihata-parallel.ts';
import {
	foldChunks,
	infer,
	mulberry,
	openStream,
	semiringOf,
	serial,
	Unsupported
} from '../../scripts/research/baselines/morihata.ts';

const random = (seed: number, size: number) => {
	const next = mulberry(seed);
	return Uint8Array.from({ length: size }, () => next() & 255);
};

describe('morihata and sato baseline', () => {
	for (const kernel of handKernels)
		test(`${kernel.name} is ${kernel.expect}`, async () => {
			const verdict = await infer(buildHand(kernel), { trials: 300 });
			assert.equal(
				verdict.verdict === 'supported' ? verdict.semiring : verdict.cls,
				kernel.expect
			);
		});

	test('a supported verdict gives the serial result on a split input', async () => {
		for (const name of ['sum', 'poly31', 'max-suffix']) {
			const subject = buildHand(handKernels.find((k) => k.name === name)!);
			const verdict = await infer(subject, { trials: 300 });
			assert.equal(verdict.verdict, 'supported');
			if (verdict.verdict !== 'supported') continue;
			const stream = openStream(subject);
			const input = random(7, 100003);
			const s = semiringOf(verdict.semiring);
			assert.equal(
				await foldChunks(stream, s, input, 5n, 7),
				serial(stream, input, 5n),
				name
			);
		}
	});

	test('the worker summaries equal the in-process fold', async () => {
		const subject = buildHand(handKernels[1]!);
		const stream = openStream(subject);
		const s = semiringOf('add-mul');
		const input = random(3, 40000);
		const parallel = await foldChunks(
			stream,
			s,
			input,
			0n,
			3,
			workerSummarizer(subject, 'add-mul')
		);
		assert.equal(parallel, serial(stream, input, 0n));
	});

	test('xor state is refused with the body failure named', async () => {
		const verdict = await infer(buildHand(handKernels.find((k) => k.name === 'crc32-step')!), {
			trials: 50
		});
		assert.equal(verdict.verdict, 'unsupported');
		if (verdict.verdict === 'unsupported') {
			assert.equal(verdict.checks.length, 6);
			assert.ok(verdict.checks.every((c) => !c.accepted));
		}
	});

	test('a modulus invisible at small values is caught only by the end to end sample', async () => {
		const verdict = await infer(buildHand(handKernels.find((k) => k.name === 'mod65521')!), {
			trials: 300
		});
		assert.equal(verdict.verdict, 'unsupported');
		if (verdict.verdict === 'unsupported') {
			assert.equal(verdict.cls, 'end-to-end-mismatch');
			assert.ok(verdict.checks.some((c) => c.accepted));
		}
	});

	test('a deviation beyond the sample is accepted and the larger fold is wrong', async () => {
		const subject = buildHand(lateDeviation);
		const verdict = await infer(subject, { trials: 300 });
		assert.equal(verdict.verdict, 'supported');
		const stream = openStream(subject);
		const input = random(11, 4 << 20);
		const parallel = await foldChunks(stream, semiringOf('add-mul'), input, 0n, 4);
		assert.notEqual(parallel, serial(stream, input, 0n));
	});

	test('a module with imports is refused', () => {
		const module = binaryen.parseText(
			'(module (import "e" "g" (func)) (memory (export "memory") 1) (func (export "f")))'
		);
		const bytes = Uint8Array.from(module.emitBinary());
		module.dispose();
		assert.throws(() => openStream({ module: bytes, entry: 'f' }), Unsupported);
	});
});
