import { expect, test } from 'vitest';
import {
	backingWord,
	lruVictim,
	replayChecksum,
	scanTrace,
	stackDistances,
	touchedPage,
	zipfTrace
} from '../../scripts/probe/elastic/access.ts';

const pages = 8192;
const pagesTouched = (from: number, to: number, working: number, receiver: number) =>
	new Set(
		Array.from({ length: to - from }, (_, k) =>
			touchedPage(from + k, 4096, working, receiver, pages)
		)
	);

test('touched pages: the receiver set is a subset of the four working pages', () => {
	const before = pagesTouched(0, 2048, 4, 4);
	expect(before.size).toBe(4);
	for (const receiver of [1, 2, 4]) {
		const after = pagesTouched(2048, 4096, 4, receiver);
		expect(after.size).toBe(receiver);
		for (const page of after) expect(before.has(page)).toBe(true);
	}
});

test('touched pages: the handoff switches width at the midpoint', () => {
	expect(touchedPage(5, 4096, 4, 1, pages)).toBe(2048);
	expect(touchedPage(2047, 4096, 4, 1, pages)).toBe(3 * 2048);
	expect(touchedPage(2048, 4096, 4, 1, pages)).toBe(0);
});

test('zipf trace: seeded, 70% loads, and page 0 takes its share of the mass', () => {
	const options = { pages: 3072, length: 20000, s: 1.1, readShare: 0.7, seed: 1105 };
	const trace = zipfTrace(options);
	expect(zipfTrace(options)).toEqual(trace);
	const loads = trace.filter((a) => a.kind === 'load').length;
	expect(Math.abs(loads / trace.length - 0.7)).toBeLessThan(0.02);
	let harmonic = 0;
	for (let k = 1; k <= 3072; k++) harmonic += 1 / k ** 1.1;
	const top = trace.filter((a) => a.page === 0).length / trace.length;
	expect(Math.abs(top - 1 / harmonic)).toBeLessThan(0.01);
});

test('scan trace: two passes over every page in order, loads only', () => {
	const trace = scanTrace(4, 2);
	expect(trace.map((a) => a.page)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
	expect(trace.every((a) => a.kind === 'load')).toBe(true);
});

test('lru victim: the least recent stamp, and the first slot on a tie', () => {
	expect(lruVictim([3, 0, 0, 5])).toBe(1);
	expect(lruVictim([4, 2, 9])).toBe(1);
	expect(lruVictim([7])).toBe(0);
});

test('stack distances: distinct pages since the previous touch, -1 when cold', () => {
	const trace = [0, 1, 0, 0, 2, 1].map((page) => ({ kind: 'load' as const, page }));
	expect(stackDistances(trace)).toEqual([-1, -1, 1, 0, -1, 2]);
});

test('replay checksum: a load mixes in the last stored word, else the backing word', () => {
	const trace = [
		{ kind: 'load', page: 0 },
		{ kind: 'store', page: 0 },
		{ kind: 'load', page: 0 }
	] as const;
	const first = backingWord(0);
	expect(replayChecksum(trace)).toBe((Math.imul(first, 31) ^ 1) | 0);
});
