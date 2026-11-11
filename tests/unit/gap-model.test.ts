import { expect, test } from 'vitest';
import {
	breakEvenPages,
	inDomain,
	loadModel,
	meterMiB,
	pageRange,
	remainingMiB,
	report,
	routes,
	spillPages,
	storeMsPerPage,
	type Model
} from '../../scripts/research/gap-model.ts';

const models = (['C', 'B2', 'B1'] as const).map(loadModel);
const [C, B2, B1] = models as [Model, Model, Model];
const route = (name: string) => {
	const found = routes.find((r) => r.name === name);
	if (!found) throw new Error(`no route ${name}`);
	return found;
};

test('prediction files match their pre-registered sha256 (loadModel throws otherwise)', () => {
	expect(models.map((m) => m.name)).toEqual(['C', 'B2', 'B1']);
});

test('model C reproduces its in-sample prediction at 3072 reads and 3072 writes', () => {
	const predicted = C.coefficients.baseMs + storeMsPerPage(C) * 3072;
	expect(Math.abs(predicted - 2961.3022485419133)).toBeLessThan(0.01);
});

test('model B2 reproduces the day 2 table value 3,069.0 ms at 3072 reads and writes', () => {
	const predicted = B2.coefficients.baseMs + storeMsPerPage(B2) * 3072;
	expect(Math.abs(predicted - 3069.0)).toBeLessThan(0.05);
});

test('declared domains: C spans reads 513 to 9274 and writes 0 to 4096, B2 starts at 2816 reads', () => {
	expect(C.reads).toEqual([513, 9274]);
	expect(C.writes).toEqual([0, 4096]);
	expect(B2.reads[0]).toBe(2816);
	expect(inDomain(C, 269)).toBe(false);
	expect(inDomain(C, 1000)).toBe(true);
	expect(pageRange(C, 0)).toBe('NO SPILL');
	expect(pageRange(C, 269)).toBe('OUTSIDE RANGE');
});

test('saving at 4 MiB agrees with the linear drop between the 32 and 4 MiB builds (rounding 0.15)', () => {
	for (const r of routes) {
		const drop = r.linear - r.linear4;
		expect(Math.abs(drop - r.save4)).toBeLessThan(0.15);
	}
});

test('thunder flush at the central offset is 5.6 MiB over the line before the shrink', () => {
	expect(remainingMiB(route('thunder flush'), 'central', 0)).toBeCloseTo(5.6, 6);
	expect(meterMiB(route('thunder flush'), 'central')).toBeCloseTo(208.6, 6);
});

test('at the high offset, 7 of 9 routes fit after the 4 MiB shrink alone', () => {
	const fit = routes.filter((r) => remainingMiB(r, 'high', r.save4) <= 0).length;
	expect(fit).toBe(7);
	expect(remainingMiB(route('thunder flush'), 'high', route('thunder flush').save4)).toBeCloseTo(
		16.8,
		6
	);
});

test('spill pages are 16 per MiB, rounded up, and zero below the line', () => {
	expect(spillPages(16.8)).toBe(269);
	expect(spillPages(-3)).toBe(0);
	expect(spillPages(0)).toBe(0);
});

test('break-even spill for a 15 s request is about 29,112 pages under model C', () => {
	expect(Math.abs(breakEvenPages(C) - 29112)).toBeLessThan(2);
	expect(Math.abs(breakEvenPages(C) / 16 - 1819.5)).toBeLessThan(1);
});

test('the 269-page high-offset spill adds under 150 ms on every model, so 15 s is not reached', () => {
	for (const m of models) {
		expect(storeMsPerPage(m) * 269).toBeLessThan(150);
	}
});

test('report prints every section from the data files', () => {
	const text = report(models);
	expect(text).toContain('### Meter at route end');
	expect(text).toContain('### After the 4 MiB stack shrink alone');
	expect(text).toContain('| thunder flush | 122.1 | 179.1 | 208.6 | 248.1 |');
});
