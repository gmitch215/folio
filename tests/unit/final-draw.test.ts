import { expect, test } from 'vitest';
import { draw, type Candidate } from '../../scripts/research/final-cases/draw.ts';

const make = (project: string, count: number): Candidate[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `${project}-f${String(index).padStart(2, '0')}`,
		project,
		build: 'ok',
		native: 'equal'
	}));

const pool = [...make('alpha', 10), ...make('beta', 3), ...make('gamma', 8)];

test('the draw repeats exactly from the same seed and input', () => {
	expect(draw(pool, 'seed-a', 6)).toEqual(draw(pool, 'seed-a', 6));
});

test('input order does not change the draw', () => {
	expect(draw([...pool].reverse(), 'seed-a', 6)).toEqual(draw(pool, 'seed-a', 6));
});

test('a project over the cap contributes the cap and a smaller project contributes all', () => {
	const result = draw(pool, 'seed-a', 6);
	const count = (project: string) => result.drawn.filter((id) => id.startsWith(project)).length;
	expect([count('alpha'), count('beta'), count('gamma')]).toEqual([6, 3, 6]);
	expect(result.projects).toBe(3);
	expect(result.notDrawn.filter((item) => item.reason === 'over-cap')).toHaveLength(6);
});

test('different seeds give different draws', () => {
	expect(draw(pool, 'seed-a', 6).drawn).not.toEqual(draw(pool, 'seed-b', 6).drawn);
});

test('drivers that did not build or differ from native are listed and never drawn', () => {
	const input: Candidate[] = [
		...make('alpha', 2),
		{ id: 'alpha-bad-build', project: 'alpha', build: 'failed', native: 'not-run' },
		{ id: 'alpha-bad-native', project: 'alpha', build: 'ok', native: 'mismatch' }
	];
	const result = draw(input, 'seed-a', 6);
	expect(result.drawn).toEqual(['alpha-f00', 'alpha-f01']);
	expect(result.notDrawn).toEqual([
		{ id: 'alpha-bad-build', reason: 'build-failed' },
		{ id: 'alpha-bad-native', reason: 'native-not-equal' }
	]);
});

test('a pinned seed gives a pinned list', () => {
	expect(draw(pool, 'folio-v1.1-final-corpus', 6).drawn).toEqual([
		'alpha-f00',
		'alpha-f03',
		'alpha-f04',
		'alpha-f05',
		'alpha-f07',
		'alpha-f08',
		'beta-f00',
		'beta-f01',
		'beta-f02',
		'gamma-f00',
		'gamma-f02',
		'gamma-f03',
		'gamma-f04',
		'gamma-f05',
		'gamma-f07'
	]);
});
