import { describe, test } from 'vitest';
import { DICT_EDGE_BASES } from '../../scripts/research/ownership-brotli-modules.ts';
import { brotliHarness } from '../helpers/ownership-brotli.ts';

const { refusal, groundTruth, wholeList } = brotliHarness();

const EDGE_OUT = DICT_EDGE_BASES.filter((n) => /(before|after)$/.test(n));
const EDGE_IN = DICT_EDGE_BASES.filter((n) => /(lo|hi)$/.test(n));

describe('a constant table read at an interval index', () => {
	test('the hull of 32768 byte entries and of 32768 half words bounds the arena access', () => {
		groundTruth('dictbyte');
		groundTruth('dictword');
	});

	test('a range that starts and ends around the edges of a summary block takes only the entries it names', () => {
		for (const name of EDGE_OUT) groundTruth(name);
		for (const name of EDGE_IN) refusal(name);
	});

	test('an index past the table, a large entry in range or a store into the table is refused', () => {
		for (const name of [
			'dictpast',
			'dictpastone',
			'dictbigval',
			'dictwordbig',
			'dictstore',
			'dictstoreword'
		])
			refusal(name);
	});

	test('the bases of this file and their expected answers are the whole list', () => {
		wholeList(/^dict/);
	});
});
