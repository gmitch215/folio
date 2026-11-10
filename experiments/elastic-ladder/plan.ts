import { simulateTiers, type Op } from '../../scripts/research/elastic-model.ts';
import type { Price } from '../elastic-limits/plan.ts';
import { add, requestsOf, rowsOf, zero } from '../elastic-limits/plan.ts';
import type { Expected, Workload } from './programs.ts';
import { KINDS, PAGE, WORKLOADS, expectedOf } from './programs.ts';

// a variant is a configuration; a new tier or backend adds fields here and a handler in the executor
export interface Variant {
	name: string;
	frames: number;
	// compressed pool capacity in pages, 0 for none
	cold: number;
	// bytes per SQLite row; 64 KiB is one row per page, and every size at 8 KiB or more is above the E1d cliff
	rowBytes: number;
	// page operations per request; Infinity runs the whole program in one request
	quantum: number;
	// every page in the object's memory with no pager and no store; frames and cold are unused, dense only
	resident?: boolean;
}

export const VARIANTS: Record<string, Variant> = {
	v4: { name: 'v4', frames: 64, cold: 0, rowBytes: PAGE, quantum: Infinity },
	v6: { name: 'v6', frames: 64, cold: 1024, rowBytes: PAGE, quantum: Infinity }
};

// kept apart from VARIANTS, which the full-scale sweep and the live tests enumerate
export const RESIDENT: Record<string, Variant> = {
	unpaged: {
		name: 'unpaged',
		frames: 1,
		cold: 0,
		rowBytes: PAGE,
		quantum: Infinity,
		resident: true
	}
};

export interface LadderConfig {
	name: string;
	pages: number;
	caps: { rows: number; requests: number; planningDailyRows: number };
	assumptions: { schemaRowsPerTable: number; readyPolls: number };
}

export const LIVE: LadderConfig = {
	name: 'live',
	pages: 3072,
	caps: { rows: 8000, requests: 1500, planningDailyRows: 80000 },
	assumptions: { schemaRowsPerTable: 2, readyPolls: 1 }
};
export const SCALED: LadderConfig = { ...LIVE, name: 'scaled', pages: 384 };
export const TINY: LadderConfig = { ...LIVE, name: 'tiny', pages: 48 };

export interface Cell {
	variant: Variant;
	workload: Workload;
	pages: number;
	repeat: number;
}

export interface LadderPrice extends Price {
	readRows: number;
}

export const zeroPrice = (): LadderPrice => ({ ...zero(), readRows: 0 });
export const addPrice = (a: LadderPrice, b: LadderPrice): LadderPrice => ({
	...add(a, b),
	readRows: a.readRows + b.readRows
});

export function checkVariant(v: Variant) {
	if (!Number.isInteger(v.frames) || v.frames < 1) throw new Error('frames must be >= 1');
	if (!Number.isInteger(v.cold) || v.cold < 0) throw new Error('cold must be >= 0');
	if (!(v.quantum >= 1)) throw new Error('quantum must be >= 1');
	if (![1024, 2048, 4096, 8192, 16384, 32768, PAGE].includes(v.rowBytes))
		throw new Error('rowBytes must divide 65536 and be at least 1024');
}

const memo = new Map<string, Expected>();
export function expectedFor(workload: Workload, pages: number) {
	const key = `${workload}:${pages}`;
	let value = memo.get(key);
	if (!value) memo.set(key, (value = expectedOf(workload, pages)));
	return value;
}

export const modelOps = (expected: Expected): Op[] =>
	Array.from(expected.ops, (op) => ({ kind: KINDS[op & 3]!, page: op >> 2 }));

export const rowsPerPage = (v: Variant) => PAGE / v.rowBytes;

export function priceCell(cell: Cell, config: LadderConfig): LadderPrice {
	checkVariant(cell.variant);
	const expected = expectedFor(cell.workload, cell.pages);
	const ops = expected.ops.length;
	const q = cell.variant.quantum;
	const p = zeroPrice();
	p.requests = 1 + (Number.isFinite(q) ? Math.floor(ops / q) + 1 : 1) + 1;
	p.cleanupRequests = 1;
	if (cell.variant.resident) {
		if (cell.workload !== 'dense')
			throw new Error('a resident variant runs the dense chain only');
		return p;
	}
	const model = simulateTiers(modelOps(expected), cell.variant);
	const rpp = rowsPerPage(cell.variant);
	const init = cell.workload === 'dense' ? 0 : cell.pages;
	p.writeRows = (init + model.storeWrites) * rpp;
	p.schemaRows = config.assumptions.schemaRowsPerTable;
	p.cleanupRows = cell.pages * rpp;
	p.readRows = (model.storeReads + cell.pages) * rpp;
	return p;
}

export function priceCells(cells: readonly Cell[], config: LadderConfig) {
	const perCell = cells.map((cell) => priceCell(cell, config));
	const setup = zeroPrice();
	setup.requests = config.assumptions.readyPolls;
	return { perCell, setup, total: perCell.reduce(addPrice, setup) };
}

export const cellsFor = (
	variants: readonly Variant[],
	workloads: readonly Workload[],
	pages: number,
	repeats = 1,
	repeatOffset = 0
): Cell[] =>
	variants.flatMap((variant) =>
		workloads.flatMap((workload) =>
			Array.from({ length: repeats }, (_, repeat) => ({
				variant,
				workload,
				pages,
				repeat: repeatOffset + repeat
			}))
		)
	);

export const ALL_WORKLOADS = WORKLOADS;
export { requestsOf, rowsOf };
