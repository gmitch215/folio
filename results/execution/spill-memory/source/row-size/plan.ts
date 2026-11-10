import type { Config, Rung, RowArm } from './config.ts';
import { PAGE, MIB, KIB, RUNGS, groupOf } from './config.ts';

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
// whole rows that fit in mib; every 6d size divides evenly, so the 6d counts are unchanged
export const rowsOfBytes = (mib: number, bytes: number) => Math.floor((mib * MIB) / bytes);
export const spillRows = (mib: number, extentPages: number) =>
	rowsOfBytes(mib, extentPages * PAGE);
export const layouts = (c: Config) => [
	{ name: 'extent', pages: c.rung6.extentPages },
	...(c.rung6.pageRowArm ? [{ name: 'page', pages: 1 }] : [])
];
export const memCells = (c: Config) =>
	c.rung7.sizesMiB.flatMap((mib) => [true, false].map((touch) => ({ mib, touch })));
export const memClassCount = (c: Config) =>
	c.rung7.repeats * memCells(c).length + c.rung7.bare;

// one spilled object over its repeats; calls counts every request but the clear
const objectPrice = (
	repeats: number,
	rows: number,
	sql: boolean,
	schemaRows: number,
	calls: number
): Price => {
	const p = zero();
	p.requests = repeats * calls;
	p.cleanupRequests = repeats;
	p.writeRows = repeats * rows;
	p.cleanupRows = repeats * rows;
	if (sql) p.schemaRows = repeats * schemaRows;
	return p;
};

// one row-size arm of rung 6d or 6e: its object, held once and cleared
const rowPrice = (row: RowArm, schema: number) =>
	objectPrice(row.repeats, rowsOfBytes(row.mib, row.rowKiB * KIB), true, schema, 2);

// the arms of a spill rung, each priced over its repeats
export function armsOf(c: Config, rung: '6b' | '6c' | '6d' | '6e'): Record<string, Price> {
	const schema = c.assumptions.schemaRowsPerTable;
	if (rung === '6b') {
		const r = c.rung6b;
		const object = (mib: number, sql: boolean, calls: number) =>
			objectPrice(r.repeats, spillRows(mib, r.extentPages), sql, schema, calls);
		const arms: Record<string, Price> = {};
		for (const mib of r.sizesMiB) arms[`size${mib}`] = object(mib, true, 2);
		arms[`put${r.putMiB}`] = object(r.putMiB, false, 2);
		arms[`readback${r.armMiB}`] = object(r.armMiB, true, 3);
		arms[`drop${r.armMiB}`] = object(r.armMiB, true, 3);
		// one idle control per mode
		arms.controls = { ...zero(), requests: 2 };
		return arms;
	}
	if (rung === '6d') {
		const r = c.rung6d;
		const arms: Record<string, Price> = {};
		for (const row of r.rows) arms[row.arm] = rowPrice(row, schema);
		arms.decay = objectPrice(
			r.decay.repeats,
			spillRows(r.decay.mib, r.extentPages),
			true,
			schema,
			1 + r.decay.holds
		);
		// spill, hold and clear each cross one stub call from the executor to the owner
		arms.second = {
			...objectPrice(r.secondRepeats, spillRows(r.secondMib, r.extentPages), true, schema, 2),
			internal: 3 * r.secondRepeats
		};
		// the three controls are one hold each
		arms.controls = { ...zero(), requests: 3 };
		return arms;
	}
	if (rung === '6e') {
		const arms: Record<string, Price> = {};
		for (const row of c.rung6e.rows) arms[row.arm] = rowPrice(row, schema);
		// one hold of the CtlSmall control
		arms.controls = { ...zero(), requests: 1 };
		return arms;
	}
	const r = c.rung6c;
	const pages = r.extentPages;
	return {
		// spill, hold, then a ping and a hold per target minute, then the clear
		restart: objectPrice(
			r.repeats,
			spillRows(r.restartMib, pages),
			true,
			schema,
			2 + 2 * r.minutes.length
		),
		small4k: objectPrice(r.repeats, rowsOfBytes(r.smallMib, r.smallRowBytes), true, schema, 2),
		smallExt: objectPrice(r.repeats, spillRows(r.smallMib, pages), true, schema, 2),
		// spill, hold and clear each cross one stub call from the executor to the owner
		second: {
			...objectPrice(r.repeats, spillRows(r.secondMib, pages), true, schema, 2),
			internal: 3 * r.repeats
		},
		// the restart control is a ping and a hold; the other three are one hold each
		controls: { ...zero(), requests: 5 }
	};
}

export function priceRung(c: Config, rung: Rung): Price {
	if (rung === '6b' || rung === '6c' || rung === '6d' || rung === '6e')
		return Object.values(armsOf(c, rung)).reduce(add);
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
	const scripts = new Set(rungs.map((r) => groupOf(r))).size;
	const setup = zero();
	setup.requests = scripts * c.assumptions.readyPolls;
	return { perRung, setup, total: add(total, setup) };
}
