import type { Config, Rung } from './config.ts';
import { PAGE, MIB, RUNGS } from './config.ts';

export interface Price {
	writeRows: number;
	schemaRows: number;
	cleanupRows: number;
	requests: number;
	cleanupRequests: number;
	internal: number;
	external: number;
}

export const zero = (): Price => ({
	writeRows: 0,
	schemaRows: 0,
	cleanupRows: 0,
	requests: 0,
	cleanupRequests: 0,
	internal: 0,
	external: 0
});

export const rowsOf = (p: Price) => p.writeRows + p.schemaRows + p.cleanupRows;
export const requestsOf = (p: Price) => p.requests + p.cleanupRequests;

export function add(a: Price, b: Price): Price {
	const out = zero();
	for (const key of Object.keys(out) as (keyof Price)[]) out[key] = a[key] + b[key];
	return out;
}

export const modes = ['sql', 'put', 'none'] as const;
export const spillRows = (mib: number, extentPages: number) =>
	Math.ceil((mib * MIB) / (extentPages * PAGE));
export const layouts = (c: Config) => [
	{ name: 'extent', pages: c.rung6.extentPages },
	...(c.rung6.pageRowArm ? [{ name: 'page', pages: 1 }] : [])
];
export const memCells = (c: Config) =>
	c.rung7.sizesMiB.flatMap((mib) => [true, false].map((touch) => ({ mib, touch })));
export const memClassCount = (c: Config) =>
	c.rung7.repeats * memCells(c).length + c.rung7.bare;

export function priceRung(c: Config, rung: Rung): Price {
	const p = zero();
	if (rung === 1) {
		const r = c.rung1;
		p.requests = r.repeats * (1 + r.sizesKiB.length * 3);
		p.writeRows = r.repeats * r.sizesKiB.length * 3 * r.n;
		p.schemaRows = c.assumptions.schemaRowsPerTable;
		p.cleanupRows = 3 * r.n;
		p.cleanupRequests = 1;
	} else if (rung === 2) {
		const r = c.rung2;
		const coloCalls = r.coloProbe ? 4 : 0;
		p.requests = r.repeats * (6 + coloCalls);
		// fetch, rpc and self stub on one pair, fetch and rpc on the hinted pair, one warmup each
		p.internal = r.repeats * 5 * (r.n + 1);
		p.external = r.repeats * coloCalls;
	} else if (rung === 3) {
		const r = c.rung3;
		p.requests = r.repeats * 4;
		p.internal = r.repeats * (r.seq + 1 + r.rpcSeq + 1 + 2 * (r.fan + 1));
	} else if (rung === 4) {
		const r = c.rung4;
		p.requests = r.noops + r.ladder.length + r.targetsMs.length * r.repeats;
	} else if (rung === 5) {
		const r = c.rung5;
		p.requests = r.repeats * (3 + r.rmw.length);
		p.writeRows = r.repeats * (1 + r.rmw.reduce((a, b) => a + b, 0));
		p.schemaRows = r.repeats * c.assumptions.schemaRowsPerTable;
		p.cleanupRows = r.repeats;
		p.cleanupRequests = r.repeats;
	} else if (rung === 6) {
		const r = c.rung6;
		for (const layout of layouts(c))
			for (const mode of modes) {
				const rows = mode === 'none' ? 0 : spillRows(r.mib, layout.pages);
				p.requests += r.repeats * 2;
				p.cleanupRequests += r.repeats;
				p.writeRows += r.repeats * rows;
				p.cleanupRows += r.repeats * rows;
				if (mode === 'sql') p.schemaRows += r.repeats * c.assumptions.schemaRowsPerTable;
			}
		p.requests += modes.length;
	} else {
		const r = c.rung7;
		for (const cell of memCells(c))
			p.requests += r.repeats * (cell.touch ? 2 + Math.ceil(cell.mib / r.touchChunkMiB) : 2);
		p.requests += r.bare;
	}
	return p;
}

export function price(c: Config, rungs: readonly Rung[] = RUNGS) {
	const perRung: Partial<Record<Rung, Price>> = {};
	let total = zero();
	for (const rung of rungs) {
		perRung[rung] = priceRung(c, rung);
		total = add(total, perRung[rung]!);
	}
	// each script is polled for readiness before its first measured call
	const scripts = (rungs.some((r) => r !== 7) ? 1 : 0) + (rungs.includes(7) ? 1 : 0);
	const setup = zero();
	setup.requests = scripts * c.assumptions.readyPolls;
	return { perRung, setup, total: add(total, setup) };
}
