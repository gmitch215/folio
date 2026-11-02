import type { Counts } from '../concurrency/plan.ts';
import { PRICES, price } from '../concurrency/plan.ts';

export type Arm = 'serial' | 'ranges-cold' | 'ranges-warm';
export const PREFIX = 'cfw-folio-corpus-';
export const WIDTH = 4;
export const MAX_ROUNDS = 3;
export const WARMUPS = 1;
export const DEFAULT_ROUNDS = 3;
export const INVOCATION_CAP = 2000;
export const PER_REQUEST_LIMIT = 32;
export const FREE_CPU_LIMIT_MS = 10;
export const FAILURE_STREAK = 6;
export const SPEEDUP_TARGET = 1.2;
// the transaction byte budget a lane request gets by default, and the call cap per lane request
export const DEFAULT_BUDGET = 262144;

export interface Cell {
	driver: string;
	/** Records per run, and records per call (0: one call per record). */
	fit: { n: number; k: number };
	exceed: { n: number; k: number };
}

/**
 * Batch sizes from the local measurement: `fit` keeps every lane request under the default
 * budget, `exceed` goes just over it. Unmeasured on a deployed lane.
 */
export const cells: Cell[] = [
	{ driver: 'miniz-crc32', fit: { n: 28, k: 0 }, exceed: { n: 32, k: 0 } },
	{ driver: 'xxhash32', fit: { n: 4, k: 0 }, exceed: { n: 8, k: 0 } },
	{ driver: 'md5-slot', fit: { n: 28, k: 0 }, exceed: { n: 32, k: 0 } },
	{ driver: 'aes-cbc-encrypt-slot', fit: { n: 60, k: 0 }, exceed: { n: 64, k: 4 } },
	{ driver: 'jsmn-parse-slot', fit: { n: 64, k: 0 }, exceed: { n: 256, k: 4 } }
];

/** Warm tracked addresses per record and the owner cost per address, from local in-process runs. */
export const MAC: Record<string, { tracked: number; ownerNs: number; laneNs: number }> = {
	'miniz-crc32': { tracked: 33804, ownerNs: 31, laneNs: 209 },
	xxhash32: { tracked: 131084, ownerNs: 33, laneNs: 115 },
	'md5-slot': { tracked: 32892, ownerNs: 34, laneNs: 237 },
	'aes-cbc-encrypt-slot': { tracked: 16894, ownerNs: 57, laneNs: 808 },
	'jsmn-parse-slot': { tracked: 13371, ownerNs: 68, laneNs: 345 }
};

export function only(list: string | undefined): Cell[] {
	if (!list) return cells;
	const wanted = list.split(',').filter(Boolean);
	for (const id of wanted)
		if (!cells.some((cell) => cell.driver === id)) throw new RangeError(`unknown driver ${id}`);
	return cells.filter((cell) => wanted.includes(cell.driver));
}

export interface Step {
	driver: string;
	kind: 'fit' | 'exceed';
	arm: Arm;
	n: number;
	k: number;
}

/** One round: every driver once, the first one rotating by round; the three fit arms cold before warm. */
export function schedule(round: number, list: Cell[] = cells): Step[] {
	const steps: Step[] = [];
	const shift = ((round % list.length) + list.length) % list.length;
	const rotated = [...list.slice(shift), ...list.slice(0, shift)];
	const arms: Arm[] =
		round % 2
			? ['ranges-cold', 'ranges-warm', 'serial']
			: ['serial', 'ranges-cold', 'ranges-warm'];
	for (const cell of rotated) {
		for (const arm of arms) steps.push({ driver: cell.driver, kind: 'fit', arm, ...cell.fit });
		for (const arm of ['serial', 'ranges-cold'] as const)
			steps.push({ driver: cell.driver, kind: 'exceed', arm, ...cell.exceed });
	}
	return steps;
}

/** Lane calls one request makes: cold learns for up to `MAX_ROUNDS` frames per lane, warm sends one. */
export function laneCalls(step: Step, width = WIDTH): number {
	if (step.arm === 'serial') return 0;
	return step.arm === 'ranges-cold' ? width * MAX_ROUNDS : width;
}

/** Owner CPU in ms at the local per-address cost; an estimate that decides the Free plan question. */
export function ownerCpuMs(step: Step): number {
	if (step.arm === 'serial') return 0;
	const mac = MAC[step.driver];
	return mac ? (step.n * mac.tracked * mac.ownerNs) / 1e6 : NaN;
}

export function priceRun(rounds: number, list: Cell[] = cells) {
	let topLevel = list.length;
	let objectCalls = list.length * WIDTH;
	let cpuMs = 0;
	let requests = 0;
	for (let round = -WARMUPS; round < rounds; round++)
		for (const step of schedule(round, list)) {
			requests++;
			topLevel++;
			objectCalls += laneCalls(step);
			const mac = MAC[step.driver];
			if (step.arm !== 'serial' && mac)
				cpuMs += ownerCpuMs(step) + (step.n * mac.tracked * mac.laneNs) / 1e6;
		}
	const objects = list.length * WIDTH;
	// every object is assumed alive for the whole run at 128 MB; an assumption, not a measurement
	const activeSeconds = 300 + requests * 2;
	const counts: Counts = {
		workerRequests: topLevel,
		cpuMs,
		durableObjectRequests: objectCalls,
		durableObjectGbSeconds: objects * activeSeconds * PRICES.durableObjectBilledGb
	};
	return { counts, price: price(counts), objects, activeSeconds, requests };
}

export function plan(rounds = DEFAULT_ROUNDS, list: Cell[] = cells) {
	let invocations = list.length * (1 + WIDTH);
	let worst = 0;
	for (let round = -WARMUPS; round < rounds; round++)
		for (const step of schedule(round, list)) {
			const used = 1 + laneCalls(step);
			invocations += used;
			worst = Math.max(worst, used);
		}
	const priced = priceRun(rounds, list);
	return {
		drivers: list.map((cell) => cell.driver),
		rounds,
		warmups: WARMUPS,
		requests: priced.requests,
		invocations,
		cap: INVOCATION_CAP,
		withinCap: invocations <= INVOCATION_CAP,
		perRequestWorst: worst,
		durableObjectRows: 0,
		priced
	};
}

export interface Sample {
	round: number;
	rid: number;
	driver: string;
	kind: 'fit' | 'exceed';
	arm: Arm;
	n: number;
	status: number | null;
	error?: string;
	clientWallMs: number;
	digest?: string;
	wallMs?: number;
	exhaustedCalls?: number;
	fallbacks?: number;
	transportFallbacks?: number;
	laneFailures?: number;
	escapeRounds?: number;
	footprintHits?: number;
	rangeBytes?: number;
	bytesOut?: number;
	bytesIn?: number;
	tracked?: number;
}

const median = (values: number[]) =>
	values.length ? [...values].sort((a, b) => a - b)[values.length >> 1]! : null;

export interface Row {
	driver: string;
	kind: string;
	arm: string;
	requests: number;
	failures: number;
	used: number;
	clientWallMs: number | null;
	exactAll: boolean;
	exhaustedCalls: number;
	fallbacks: number;
	bytesOut: number | null;
	bytesIn: number | null;
	tracked: number | null;
}

/** A warm sample whose own report shows learning is cold and does not count as warm. */
export const isWarm = (sample: Sample) =>
	sample.arm !== 'ranges-warm' || (!sample.escapeRounds && (sample.footprintHits ?? 0) > 0);

export function summarize(samples: Sample[]): Row[] {
	const keys = [...new Set(samples.map((s) => `${s.driver}|${s.kind}|${s.arm}`))];
	return keys.map((key) => {
		const [driver, kind, arm] = key.split('|') as [string, string, string];
		const mine = samples.filter((s) => `${s.driver}|${s.kind}|${s.arm}` === key);
		const used = mine.filter((s) => s.status === 200 && isWarm(s));
		const serial = new Map(
			samples
				.filter((s) => s.arm === 'serial' && s.status === 200)
				.map((s) => [`${s.driver}|${s.kind}|${s.round}`, s.digest])
		);
		const reference = (s: Sample) => serial.get(`${s.driver}|${s.kind}|${s.round}`);
		return {
			driver,
			kind,
			arm,
			requests: mine.length,
			failures: mine.filter((s) => s.status !== 200).length,
			used: used.length,
			clientWallMs: median(used.map((s) => s.clientWallMs)),
			exactAll: mine
				.filter((s) => s.status === 200)
				.every((s) => reference(s) !== undefined && s.digest === reference(s)),
			exhaustedCalls: mine.reduce((sum, s) => sum + (s.exhaustedCalls ?? 0), 0),
			fallbacks: mine.reduce((sum, s) => sum + (s.fallbacks ?? 0), 0),
			bytesOut: median(used.map((s) => s.bytesOut ?? 0)),
			bytesIn: median(used.map((s) => s.bytesIn ?? 0)),
			tracked: median(used.map((s) => s.tracked ?? 0))
		};
	});
}

export interface Verdict {
	id: string;
	pass: boolean | null;
	detail: string;
}

/** Decision rules fixed before any deployed run; see METHOD.md. */
export function decide(rows: Row[], samples: Sample[]): Verdict[] {
	const verdicts: Verdict[] = [];
	const exact = rows.length > 0 && rows.every((row) => row.exactAll);
	verdicts.push({
		id: 'exact',
		pass: rows.length ? exact : false,
		detail: 'every sample equals the serial digest'
	});
	for (const driver of [...new Set(rows.map((r) => r.driver))]) {
		const serial = rows.find(
			(r) => r.driver === driver && r.kind === 'fit' && r.arm === 'serial'
		);
		const warm = rows.find(
			(r) => r.driver === driver && r.kind === 'fit' && r.arm === 'ranges-warm'
		);
		const ratio =
			serial?.clientWallMs && warm?.clientWallMs
				? serial.clientWallMs / warm.clientWallMs
				: null;
		verdicts.push({
			id: `speedup-${driver}`,
			pass: ratio === null ? null : ratio >= SPEEDUP_TARGET,
			detail:
				ratio === null
					? 'no usable pair'
					: `serial over ranges-warm wall ${ratio.toFixed(3)}, target ${SPEEDUP_TARGET}`
		});
	}
	const failed = samples.filter((s) => s.status !== 200).length;
	verdicts.push({
		id: 'failure-rate',
		pass: samples.length ? failed / samples.length <= 0.02 : null,
		detail: `${failed} of ${samples.length} requests failed`
	});
	const fitExhausted = rows
		.filter((r) => r.kind === 'fit')
		.reduce((sum, r) => sum + r.exhaustedCalls, 0);
	verdicts.push({
		id: 'fit-stays-under-budget',
		pass: samples.length ? fitExhausted === 0 : null,
		detail: `${fitExhausted} exhausted calls in fit cells`
	});
	const exceed = rows.filter((r) => r.kind === 'exceed' && r.arm !== 'serial');
	verdicts.push({
		id: 'exceed-falls-back-exactly',
		pass: exceed.length ? exceed.every((r) => r.exhaustedCalls > 0 && r.fallbacks > 0) : null,
		detail: 'every exceed cell exhausted a call and the owner ran the rest natively'
	});
	return verdicts;
}
