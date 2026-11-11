import { describe, test } from 'vitest';
import { brotliHarness } from '../helpers/ownership-brotli.ts';

const { refusal, groundTruth, wholeList } = brotliHarness();

const WORLDS = ['world', 'worldback', 'worldcount', 'worldsecond'];
const LOWS = ['lwcert', 'lwle', 'lwconst', 'lwge', 'lwjoin', 'lwrange'];

describe('a pointer cell that is null until its count cell is set', () => {
	test('the loop head keeps the null and the allocated world apart', () => {
		for (const name of WORLDS) groundTruth(name);
	});

	test('a pointer stored over, a count set without the pointer, or a world that joins another is refused', () => {
		refusal('worldmix');
		refusal('worldstore', 'final-state');
		refusal('worldcounter', 'escape');
	});
});

describe('the low word of an i64 that a branch bounded', () => {
	test('a wrap taken before an unsigned compare of the same i64 is bounded by it', () => {
		for (const name of LOWS) groundTruth(name);
	});

	test('no compare, a block past the arena, a reversed or signed compare or another i64 proves nothing', () => {
		for (const name of ['lwnone', 'lwbig', 'lwreverse', 'lwsigned', 'lwother']) refusal(name);
	});

	test('the bases of this file and their expected answers are the whole list', () => {
		wholeList(/^(world|lw)/);
	});
});
