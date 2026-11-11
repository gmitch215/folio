import { describe, test } from 'vitest';
import { brotliHarness } from '../helpers/ownership-brotli.ts';

const { refusal, groundTruth, wholeList } = brotliHarness();

const TAILS = ['tail', 'tailmid', 'tailspread', 'tailcount2', 'tailptr2'];

describe('a plain counter that steps with a pointer cursor under a pointer limit', () => {
	test('the counter stays within the cursor offset plus the entry gap, for any step pair', () => {
		for (const name of TAILS) groundTruth(name);
	});

	test('a counter stepped twice or reset, a pointer not stepped or stepped down, a limit past the arena or a signed test is refused', () => {
		for (const name of [
			'tailtwice',
			'tailstill',
			'tailbig',
			'tailfar',
			'tailreset',
			'tailbump',
			'tailstart',
			'tailpdown',
			'tailsum',
			'tailzero'
		])
			refusal(name);
		refusal('tailsigned', 'ptr-compare');
	});

	test('the bases of this file and their expected answers are the whole list', () => {
		wholeList(/^tail/);
	});
});
