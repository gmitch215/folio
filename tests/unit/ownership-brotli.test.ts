import { describe, test } from 'vitest';
import { brotliHarness } from '../helpers/ownership-brotli.ts';

const { certificate, refusal, groundTruth, wholeList } = brotliHarness();

const COPIES = ['pairlow', 'pairhigh', 'pairafter', 'pairother', 'pairptr'];
const COUNTS = ['i64eq', 'i64add', 'i64less', 'i64signed', 'i64wrap', 'i64extend'];
const SATURATING = ['satsub', 'satsub32'];
const PAIRPTRS = ['pairptrsecond', 'pairptrcmp', 'pairptrdiff', 'pairptragain'];

describe('i64 counters', () => {
	test('a test of counters with exact words is decided, and the arm not taken is not walked', () => {
		for (const name of COUNTS) groundTruth(name);
	});

	test('a counter that differs, overflows a constant, or holds data decides nothing', () => {
		for (const name of ['i64ne', 'i64add1', 'i64lessnot', 'i64unsigned', 'i64data', 'i64half'])
			refusal(name);
	});
});

describe('a subtraction guarded by its own comparison', () => {
	test('block - delta when delta < block is at most block, for an i64 or an i32 delta', () => {
		for (const name of SATURATING) groundTruth(name);
	});

	test('another comparison, another block, a swapped subtraction or a data arm proves nothing', () => {
		for (const name of [
			'satsubge',
			'satsubsigned',
			'satsubother',
			'satsubswap',
			'satsubdata',
			'satsubbig',
			'satsubwide',
			'satsub32ge',
			'satsub32signed',
			'satsubleft',
			'satsubeffect'
		])
			refusal(name);
	});

	test('a bound derived from the arena base is refused at its comparison', () => {
		refusal('satsubtaint', 'ptr-compare');
	});
});

describe('an i64 copy of a struct whose second word was never written', () => {
	test('the word that was written keeps its exact value through the copy', () => {
		for (const name of COPIES) groundTruth(name);
		for (const name of PAIRPTRS) certificate(name);
	});

	test('a word that holds data, the unwritten word, a pointer or a broken cell is not exact', () => {
		for (const name of [
			'pairdata',
			'pairbefore',
			'pairunwritten',
			'pairpointer',
			'pairpartial',
			'pairptrdata',
			'pairptrhalf'
		])
			refusal(name);
	});

	test('the bases of this file and their expected answers are the whole list', () => {
		wholeList(/^(pair|i64|satsub)/);
	});
});
