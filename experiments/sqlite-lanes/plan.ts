import { PRICES, price } from '../concurrency/plan.ts';
import { catalog } from './queries.ts';

export const PREFIX = 'cfw-folio-sqlite-lanes-';
export const REPS = 12;
export const WARMUPS = 2;
export const INVOCATION_CAP = 1500;
export const ARMS = ['serial', 'shards-4', 'shards-8'] as const;
export type Arm = (typeof ARMS)[number];
export const QUERIES = Object.keys(catalog).filter((name) => catalog[name]!.decomposes);
// the whole table is loaded as two parts; each shard ships in one part
export const SERIAL_PARTS = 2;
export const READY_PROBES = 30;
// assumption, not a measurement: every object counted active for this long
export const ACTIVE_SECONDS_UPPER = 900;
// the timings below are Node numbers on a Mac; this factor covers a slower platform
export const CPU_SLACK = 3;
// single-instance Node medians, unsplit, summed over the five decomposable queries
export const SERIAL_MS_PER_PASS = 895.7 + 870.5 + 90.5 + 225.4 + 265.5;

export interface Cell {
	query: string;
	arm: Arm;
}

const rotate = <T>(items: readonly T[], by: number) =>
	items.map((_, i) => items[(i + by) % items.length]!);

// one repetition in run order: queries rotate by one a repetition, arms inside a query rotate too, odd
// repetitions run in reverse so drift touches every cell
export function schedule(rep: number): Cell[] {
	const turn = Math.max(rep, 0);
	const order = rotate(QUERIES, turn % QUERIES.length).flatMap((query, q) =>
		rotate(ARMS, (turn + q) % ARMS.length).map((arm) => ({ query, arm }))
	);
	return turn % 2 ? order.reverse() : order;
}

// durable object calls one cell makes: the serial arm one, a shard arm one per shard
export const objectCalls = (arm: Arm) =>
	arm === 'serial' ? 1 : Number(arm.slice('shards-'.length));

// top-level requests a cell makes: the owner
export const TOP_LEVEL_PER_CELL = 1;

export function plan(reps = REPS, warmups = WARMUPS) {
	const cells = schedule(0);
	const cellsPerRep = cells.length;
	const repetitions = reps + warmups;
	const perRepTop = cellsPerRep * TOP_LEVEL_PER_CELL;
	const perRepObjects = cells.reduce((sum, c) => sum + objectCalls(c.arm), 0);
	// reference: the unsplit serial text, once per query before the repetitions
	const reference = { top: QUERIES.length, objects: QUERIES.length };
	// loads: serial in parts, then every shard once; each part is one owner request and one object call
	const loadParts = SERIAL_PARTS + ARMS.slice(1).reduce((sum, arm) => sum + objectCalls(arm), 0);
	const topLevel = perRepTop * repetitions + reference.top + loadParts + READY_PROBES;
	const objects = perRepObjects * repetitions + reference.objects + loadParts;
	const expected = topLevel + objects;
	const serialPassMs = SERIAL_MS_PER_PASS * ARMS.length * CPU_SLACK;
	const counts = {
		workerRequests: topLevel,
		cpuMs: serialPassMs * repetitions,
		durableObjectRequests: objects,
		durableObjectGbSeconds: 0
	};
	const objectNames = 1 + 4 + 8;
	counts.durableObjectGbSeconds =
		objectNames * ACTIVE_SECONDS_UPPER * PRICES.durableObjectBilledGb;
	return {
		reps,
		warmups,
		repetitions,
		cellsPerRep,
		perRepInvocations: perRepTop + perRepObjects,
		loadParts,
		topLevel,
		objects,
		expected,
		cap: INVOCATION_CAP,
		withinCap: expected <= INVOCATION_CAP,
		objectNames,
		counts,
		price: price(counts)
	};
}

export const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
