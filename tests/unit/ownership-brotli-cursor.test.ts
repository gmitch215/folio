import { describe, test } from 'vitest';
import { brotliHarness } from '../helpers/ownership-brotli.ts';

const { refusal, groundTruth, wholeList } = brotliHarness();

const CURSORS = ['curdec', 'curword', 'curarms'];
const POINTERS = ['ptrle', 'ptrlt', 'ptrswap', 'ptrcursor', 'ptrsame'];

describe('a pointer that steps up while a guarded counter steps down', () => {
	test('the pointer stays within its start plus the counter bound, for a byte or a word step', () => {
		for (const name of CURSORS) groundTruth(name);
	});

	test('a counter skipped on one path, a doubled pointer step, a larger bound or a counter reset is refused', () => {
		for (const name of [
			'curdecskip',
			'curtwice',
			'curbig',
			'curreset',
			'curstep2',
			'curwordbig',
			'curbump',
			'curarmsdiff',
			'curpdown'
		])
			refusal(name);
	});
});

describe('an offset added to a pointer and tested against another pointer', () => {
	test('the test bounds the offset, and the pointer it names when it is the cursor', () => {
		for (const name of POINTERS) groundTruth(name);
	});

	test('a limit past the arena, a test that bounds nothing, a signed test or an offset reassigned by the other side is refused', () => {
		for (const name of ['ptrbig', 'ptrreverse', 'ptrsigned', 'ptrsplit', 'ptrrightset'])
			refusal(name);
	});

	test('the bases of this file and their expected answers are the whole list', () => {
		wholeList(/^(cur|ptr)/);
	});
});
