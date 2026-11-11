import { describe, test } from 'vitest';
import { brotliHarness } from '../helpers/ownership-brotli.ts';

const { refusal, groundTruth, wholeList } = brotliHarness();

describe('a plain value plus a plain counter against a plain bound', () => {
	test('the counter is cut by the bound minus the addend, for either side and either branch', () => {
		for (const name of [
			'sumle',
			'sumlt',
			'sumswap',
			'sumgt',
			'sumflip',
			'sumstep3',
			'sumbefore',
			'sumgrow'
		])
			groundTruth(name);
	});

	test('a wide bound, an addend that wraps, a signed test, a bound that changes under the test or another counter is refused', () => {
		for (const name of [
			'sumbig',
			'sumopen',
			'sumwrap',
			'sumsigned',
			'sumother',
			'sumrightset',
			'sumbasebump',
			'sumself'
		])
			refusal(name);
		refusal('sumptrbound', 'ptr-compare');
	});
});

describe('a plain counter that steps with a plain cursor under a plain limit', () => {
	test('the counter stays within the cursor range plus the entry gap', () => {
		for (const name of ['tailp', 'tailpmid', 'tailpcursor2', 'tailpsigned']) groundTruth(name);
	});

	test('a counter that outruns the cursor, a cursor that stays or runs down or wraps, a wide limit or a reset is refused', () => {
		for (const name of [
			'tailpcount2',
			'tailpstill',
			'tailpdown',
			'tailpbig',
			'tailpwrap',
			'tailpreset',
			'tailpbump',
			'tailpstart',
			'tailpgrow'
		])
			refusal(name);
		refusal('tailpptr', 'ptr-compare');
	});
});

describe('the bytes left to scan after a loop test relates two locals', () => {
	test('end - pos stays in the gap the test proves, for either side and either branch', () => {
		for (const name of ['rem', 'remle', 'remplain', 'remmirror', 'remexit', 'remtwice'])
			groundTruth(name);
	});

	test('a test that does not order the locals, a signed test, a read before the test, a reversed difference or a changed end is refused', () => {
		for (const name of [
			'remstart',
			'remnone',
			'remsigned',
			'remunder',
			'remswap',
			'remreset',
			'remendbump',
			'remother',
			'rembig',
			'remwrap',
			'remslack'
		])
			refusal(name);
	});
});

describe('the bases of this file and their expected answers', () => {
	test('are the whole list', () => {
		wholeList(/^(sum|tailp|rem)/);
	});
});
