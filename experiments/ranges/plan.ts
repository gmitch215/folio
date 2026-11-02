import type { Counts } from '../concurrency/plan.ts';
import { price, PRICES } from '../concurrency/plan.ts';
import type { Fill } from './layout.ts';
import { ARENAS, FILLS } from './layout.ts';

export type Arm = 'snapshot' | 'ranges-cold' | 'ranges-warm' | 'serial';
export type Lanes = 'worker' | 'do';

export const PREFIX = 'cfw-folio-ranges-';

/** Reads FOLIO_RANGES_LANES; unset or empty means the service-bound Worker lanes. */
export function lanesFrom(value: string | undefined): Lanes {
	const lanes = value || 'worker';
	if (lanes !== 'worker' && lanes !== 'do')
		throw new RangeError(`FOLIO_RANGES_LANES must be worker or do, got ${lanes}`);
	return lanes;
}

export const WIDTH = 4;
export const WAVES = 4;
// the library default of ManagedFolio `ranges.maxRounds`
export const MAX_ROUNDS = 3;
// the library default of ManagedFolio `maximumSnapshotBytes`
export const SNAPSHOT_LIMIT = 31 * 1048576;
export const WARMUPS = 2;
export const DEFAULT_ROUNDS = 10;
export const INVOCATION_CAP = 6000;
export const PER_REQUEST_TARGET = 24;
export const PER_REQUEST_LIMIT = 32;
export const FREE_DAILY_REQUESTS = 100_000;
// ascending kernel rounds; calibration keeps one step below the largest the owner survives
export const LADDER = [2, 4, 8, 16, 32, 64, 128, 256];
export const TRIALS = 8;
// paid plan: no 10 ms cap, so the kernel grows until serial takes this many client milliseconds
export const PAID_LADDER = [256, 1024, 4096, 16384, 65536, 262144];
export const PAID_TARGET_MS = 400;
// cold ranges requests per ladder step, so the owner's own CPU is checked and not only serial's
export const RANGE_TRIALS = 2;
// consecutive failed requests that end a run, so a wedged coordinator is not sent thousands more
export const FAILURE_STREAK = 8;
export const SCRIPTS = 1 + 4;

export interface Group {
	arena: number;
	fill: Fill;
}

export const groups: Group[] = ARENAS.flatMap((arena) => FILLS.map((fill) => ({ arena, fill })));

// cold runs first and warm directly after it, so warm finds the cache the cold run left
const slots: Arm[][] = [['snapshot'], ['ranges-cold', 'ranges-warm'], ['serial']];

const rotate = <T>(items: T[], by: number) => items.map((_, i) => items[(i + by) % items.length]!);

/** The cells of one round in run order: groups rotate by 3, arm slots by 1, odd rounds reversed. */
export function schedule(round: number) {
	const turn = Math.max(round, 0);
	const order = rotate(groups, (turn * 3) % groups.length);
	return (turn % 2 ? [...order].reverse() : order).map((group) => ({
		...group,
		arms: rotate(slots, turn % slots.length).flat()
	}));
}

/** Worker invocations one request makes, counting the coordinator itself. */
export function expectedInvocations(arm: Arm, arena: number, waves = WAVES, width = WIDTH) {
	if (arm === 'serial') return 1;
	if (arm === 'snapshot') return arena > SNAPSHOT_LIMIT ? 1 : 1 + waves * width;
	return 1 + waves * width + (arm === 'ranges-cold' ? width : 0);
}

/** The most one request can make if every dispatch uses all its frames and falls back last. */
export function upperInvocations(arm: Arm, arena: number, waves = WAVES, width = WIDTH) {
	if (arm === 'serial') return 1;
	if (arm === 'snapshot') return expectedInvocations(arm, arena, waves, width);
	return 1 + waves * width * (MAX_ROUNDS + 1);
}

/** Lane calls one request makes: every invocation except the coordinator. */
export const laneCalls = (arm: Arm, arena: number, waves = WAVES, width = WIDTH) =>
	expectedInvocations(arm, arena, waves, width) - 1;

/** Durable Object stub calls one request makes; none when the lanes are Workers. */
export const durableObjectCalls = (arm: Arm, arena: number, lanes: Lanes) =>
	lanes === 'do' ? laneCalls(arm, arena) : 0;

/**
 * Worker invocations when a Durable Object call is not one. The documented 32-invocation limit
 * names service binding calls only; whether a stub call counts is not stated, so the bound that
 * enforces the target counts every lane call either way and this figure is the lower reading.
 */
export const workerInvocations = (arm: Arm, arena: number, lanes: Lanes) =>
	lanes === 'do' ? 1 : expectedInvocations(arm, arena);

const arms: Arm[] = ['snapshot', 'ranges-cold', 'ranges-warm', 'serial'];

// serial owner CPU per kernel round on a Free or paid isolate: 1608 to 1691 ms at 16,384 rounds
// and about 7.0 s at 65,536 in the earlier runs; rounded up
export const SERIAL_MS_PER_ROUND = 0.11;
// lane calls measured about 2.2 times the serial CPU in total at 16,384 rounds; rounded up
export const CPU_FACTOR = 2.5;
// deploys, readiness, tails and cleanup around the measured requests
export const OVERHEAD_SECONDS = 300;
// a measured request is assumed to take at most this many times the serial CPU in wall time
export const WALL_FACTOR = 2;

/**
 * List-rate counts and price of a run at a fixed kernel size, from the schedule request by
 * request. Every figure is an upper bound built on the constants above, not a measurement.
 */
export function priceRun(rounds: number, lanes: Lanes, kernel: number) {
	let topLevel = 1;
	let laneInvocations = 0;
	let objectCalls = 0;
	let cpuMs = 0;
	let cells = 0;
	for (let round = -WARMUPS; round < rounds; round++)
		for (const group of schedule(round)) {
			topLevel += 2;
			for (const arm of group.arms) {
				cells++;
				topLevel++;
				const calls = laneCalls(arm, group.arena);
				if (lanes === 'do') objectCalls += calls;
				else laneInvocations += calls;
				const serial = kernel * SERIAL_MS_PER_ROUND;
				cpuMs += arm === 'serial' ? serial : serial * CPU_FACTOR;
			}
		}
	// readiness touches the four lanes of each of the two coordinators once
	const ready = 2;
	topLevel += ready;
	if (lanes === 'do') objectCalls += 2 * WIDTH;
	const objects = lanes === 'do' ? 2 * WIDTH : 0;
	const activeSeconds =
		OVERHEAD_SECONDS + (cells * WALL_FACTOR * kernel * SERIAL_MS_PER_ROUND) / 1000;
	const counts: Counts = {
		workerRequests: topLevel + laneInvocations,
		cpuMs,
		durableObjectRequests: objectCalls,
		durableObjectGbSeconds: objects * activeSeconds * PRICES.durableObjectBilledGb
	};
	return { counts, price: price(counts), activeSeconds, objects };
}

export interface PlanOptions {
	lanes?: Lanes;
	// a fixed kernel skips the calibration ladder
	kernel?: number;
}

export function plan(rounds = DEFAULT_ROUNDS, options: PlanOptions = {}) {
	const lanes = options.lanes ?? 'worker';
	const perGroup = (group: Group) =>
		1 + arms.reduce((sum, arm) => sum + expectedInvocations(arm, group.arena), 0);
	const perRound = groups.reduce((sum, group) => sum + perGroup(group), 0);
	const calibration = options.kernel ? 1 : 1 + LADDER.length * (TRIALS + RANGE_TRIALS * 21);
	// Durable Object lanes deploy the two coordinators only; readiness touches each one's four lanes
	const deploys = lanes === 'do' ? 2 : SCRIPTS;
	const readiness = lanes === 'do' ? 2 * (1 + WIDTH) : SCRIPTS;
	const total = (rounds + WARMUPS) * perRound + calibration + readiness;
	const perRequest = groups.flatMap((g) => arms.map((arm) => ({ arm, arena: g.arena })));
	return {
		lanes,
		deploys,
		groups: groups.length,
		cellsPerRound: groups.length * arms.length,
		rounds,
		warmups: WARMUPS,
		perRound,
		calibration,
		expected: total,
		cap: INVOCATION_CAP,
		withinCap: total <= INVOCATION_CAP,
		share: total / FREE_DAILY_REQUESTS,
		perRequestExpected: Math.max(...perRequest.map((r) => expectedInvocations(r.arm, r.arena))),
		perRequestUpper: Math.max(...perRequest.map((r) => upperInvocations(r.arm, r.arena))),
		perRequestWithoutObjectCalls: Math.max(
			...perRequest.map((r) => workerInvocations(r.arm, r.arena, lanes))
		),
		durableObjectCallsPlanned:
			lanes === 'do'
				? (rounds + WARMUPS) *
						groups.reduce(
							(sum, g) =>
								sum +
								arms.reduce(
									(n, arm) => n + durableObjectCalls(arm, g.arena, lanes),
									0
								),
							0
						) +
					2 * WIDTH
				: 0,
		durableObjectRows: 0,
		priced: options.kernel ? priceRun(rounds, lanes, options.kernel) : null
	};
}

export interface Sample {
	round: number;
	rid: number;
	arena: number;
	fill: Fill;
	arm: Arm;
	status: number | null;
	error?: string;
	clientWallMs: number;
	invocations: number;
	digest?: string;
	value?: number;
	wallMs?: number;
	bytesOut?: number;
	bytesIn?: number;
	calls?: number;
	laneFailures?: number;
	transportFallbacks?: number;
	escapeRounds?: number;
	footprintHits?: number;
	rangeBytes?: number;
	laneWallMs?: number;
	cpu?: { coordinatorMs: number; laneMs: number; laneMaxMs: number; laneEvents: number };
	exact?: boolean | null;
}

/** Sets `exact` from the serial sample of the same round and cell; a missing reference is null. */
export function link(samples: Sample[]): Sample[] {
	return samples.map((sample) => {
		if (sample.status !== 200) return { ...sample, exact: null };
		const reference = samples.find(
			(other) =>
				other.round === sample.round &&
				other.arena === sample.arena &&
				other.fill === sample.fill &&
				other.arm === 'serial' &&
				other.status === 200
		);
		if (!reference) return { ...sample, exact: null };
		return {
			...sample,
			exact: sample.digest === reference.digest && sample.value === reference.value
		};
	});
}

// the snapshot arm cannot send above its own limit, so native execution there is the documented result
const documentedFallback = (sample: Sample) =>
	sample.arm === 'snapshot' && sample.arena > SNAPSHOT_LIMIT;

/** A request that did not do its job: refused, inexact, or silently run natively. */
export function failureOf(sample: Sample): string | null {
	if (sample.status !== 200)
		return `status ${sample.status ?? 'none'}: ${sample.error ?? ''}`.trim();
	if (sample.exact === false) return 'inexact';
	if (documentedFallback(sample) || sample.arm === 'serial') return null;
	if (sample.laneFailures) return 'lane failure';
	if (sample.transportFallbacks) return 'native fallback';
	return null;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const med = (values: (number | undefined)[]) => {
	const clean = values.filter((value): value is number => value !== undefined);
	return clean.length ? median(clean) : null;
};

export interface Row {
	arena: number;
	fill: Fill;
	arm: Arm;
	requests: number;
	failures: number;
	failureRate: number;
	failureKinds: Record<string, number>;
	exact: number;
	unchecked: number;
	cold: number;
	warm: number;
	used: number;
	clientWallMs: number | null;
	bytesOut: number | null;
	bytesIn: number | null;
	invocationsMedian: number | null;
	invocationsMax: number | null;
	laneWallMs: number | null;
	coordinatorCpuMs: number | null;
	laneCpuMs: number | null;
	laneCpuMaxMs: number | null;
}

/** One row per cell. Medians use the requests that did their job; failures are listed beside them. */
export function summarize(samples: Sample[]): Row[] {
	const linked = link(samples);
	return groups.flatMap((group) =>
		arms.flatMap((arm): Row[] => {
			const rows = linked.filter(
				(s) => s.arena === group.arena && s.fill === group.fill && s.arm === arm
			);
			if (!rows.length) return [];
			const failureKinds: Record<string, number> = {};
			for (const sample of rows) {
				const kind = failureOf(sample);
				if (kind) failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
			}
			// a warm request that found a cold cache is not a warm sample
			const warmState = (s: Sample) =>
				s.escapeRounds === 0 && (s.footprintHits ?? 0) > 0 ? 'warm' : 'cold';
			const used = rows.filter(
				(s) => !failureOf(s) && (arm !== 'ranges-warm' || warmState(s) === 'warm')
			);
			const ranged = rows.filter((s) => s.arm.startsWith('ranges'));
			const failures = Object.values(failureKinds).reduce((a, b) => a + b, 0);
			return [
				{
					...group,
					arm,
					requests: rows.length,
					failures,
					failureRate: failures / rows.length,
					failureKinds,
					exact: rows.filter((s) => s.exact === true).length,
					unchecked: rows.filter((s) => s.status === 200 && s.exact === null).length,
					cold: ranged.filter((s) => s.status === 200 && warmState(s) === 'cold').length,
					warm: ranged.filter((s) => s.status === 200 && warmState(s) === 'warm').length,
					used: used.length,
					clientWallMs: med(used.map((s) => s.clientWallMs)),
					bytesOut: med(used.map((s) => s.bytesOut)),
					bytesIn: med(used.map((s) => s.bytesIn)),
					invocationsMedian: med(used.map((s) => s.invocations)),
					invocationsMax: rows.length
						? Math.max(...rows.map((s) => s.invocations))
						: null,
					laneWallMs: med(used.map((s) => s.laneWallMs)),
					coordinatorCpuMs: med(used.map((s) => s.cpu?.coordinatorMs)),
					laneCpuMs: med(used.map((s) => s.cpu?.laneMs)),
					laneCpuMaxMs: med(used.map((s) => s.cpu?.laneMaxMs))
				}
			];
		})
	);
}

export interface Verdict {
	id: string;
	pass: boolean | null;
	detail: string;
}

const EIGHT = 8388608;

/** The decision rules of METHOD.md applied to the rows; null means the data cannot say. */
export function decide(rows: Row[], samples: Sample[]): Verdict[] {
	const find = (arm: Arm, fill: Fill = 'zero', arena = EIGHT) =>
		rows.find((r) => r.arena === arena && r.fill === fill && r.arm === arm);
	const ratio = (a: number | null | undefined, b: number | null | undefined) =>
		a == null || b == null || b === 0 ? null : a / b;
	const check = (
		id: string,
		value: number | null,
		test: (v: number) => boolean,
		text: string
	) => ({
		id,
		pass: value === null ? null : test(value),
		detail: value === null ? 'no usable samples' : `${text} ${value.toFixed(3)}`
	});
	const linked = link(samples);
	const unequal = linked.filter((s) => s.exact !== true).length;
	const ranged = samples.filter((s) => s.arm.startsWith('ranges') && s.status === 200);
	const bad = rows.filter((r) => r.failureRate > 0.02);
	const wallRatio = (fill: Fill) =>
		ratio(find('ranges-warm', fill)?.clientWallMs, find('snapshot', fill)?.clientWallMs);
	const zero = wallRatio('zero');
	const random = wallRatio('random');
	const control = ratio(zero === null || random === null ? null : Math.abs(random - zero), zero);
	return [
		{
			id: 'exact',
			pass: samples.length > 0 && unequal === 0,
			detail: `${unequal} of ${samples.length} samples not shown exact`
		},
		check(
			'bytes-cold',
			ratio(find('ranges-cold')?.bytesOut, find('snapshot')?.bytesOut),
			(v) => v <= 0.05,
			'ranges cold bytes over snapshot bytes at 8 MiB (at most 0.05):'
		),
		check(
			'bytes-warm',
			ratio(find('ranges-warm')?.bytesOut, find('snapshot')?.bytesOut),
			(v) => v <= 0.05,
			'ranges warm bytes over snapshot bytes at 8 MiB (at most 0.05):'
		),
		check(
			'wall-snapshot',
			zero,
			(v) => v <= 0.8,
			'ranges warm wall over snapshot wall at 8 MiB (at most 0.8):'
		),
		check(
			'wall-cold',
			ratio(find('ranges-cold')?.clientWallMs, find('snapshot')?.clientWallMs),
			(v) => v <= 0.8,
			'ranges cold wall over snapshot wall at 8 MiB, reported beside the warm rule:'
		),
		check(
			'wall-serial',
			ratio(find('serial')?.clientWallMs, find('ranges-warm')?.clientWallMs),
			(v) => v >= 1.5,
			'serial wall over ranges warm wall at 8 MiB (at least 1.5):'
		),
		{
			id: 'invocations',
			pass: ranged.length
				? Math.max(...ranged.map((s) => s.invocations)) <= PER_REQUEST_TARGET
				: null,
			detail: `most invocations in one ranges request: ${
				ranged.length ? Math.max(...ranged.map((s) => s.invocations)) : 'none'
			} (at most ${PER_REQUEST_TARGET})`
		},
		{
			id: 'failure-rate',
			pass: rows.length ? bad.length === 0 : null,
			detail: bad.length
				? `cells above 2%: ${bad.map((r) => `${r.arena}/${r.fill}/${r.arm} ${(r.failureRate * 100).toFixed(1)}%`).join(', ')}`
				: 'no cell above 2%'
		},
		check(
			'nonzero-control',
			control,
			(v) => v <= 0.25,
			'ranges warm over snapshot wall ratio, nonzero against zero fill, relative difference (at most 0.25):'
		)
	];
}

export interface TraceEvent {
	scriptName: string | null;
	cpuTime: number;
	wallTime: number;
	eventTimestamp: number;
	event?: { rpcMethod?: string; request?: { url?: string } };
}

const slack = 50;

/**
 * Joins tail events to requests. A coordinator event names its request through the `rid` query
 * parameter; a lane event belongs to the coordinator event whose time span holds it, so no clock
 * but the platform's is compared. A Durable Object lane runs in the coordinator's own script, so
 * its `execute` events carry the coordinator's name; whether tail labels them so is unverified. The platform reports integer milliseconds of CPU.
 */
export function attribute(events: TraceEvent[], coordinator: string, lanes: string[]) {
	const spans = new Map<number, { start: number; end: number; cpu: number }>();
	for (const e of events) {
		if (e.scriptName !== coordinator || !e.event?.request?.url) continue;
		const rid = Number(new URL(e.event.request.url).searchParams.get('rid'));
		if (Number.isInteger(rid) && rid > 0)
			spans.set(rid, {
				start: e.eventTimestamp - slack,
				end: e.eventTimestamp + e.wallTime + slack,
				cpu: e.cpuTime
			});
	}
	const out = new Map<number, NonNullable<Sample['cpu']>>();
	for (const [rid, span] of spans) {
		const inside = events.filter(
			(e) =>
				(lanes.includes(e.scriptName ?? '') || e.scriptName === coordinator) &&
				e.event?.rpcMethod === 'execute' &&
				e.eventTimestamp >= span.start &&
				e.eventTimestamp <= span.end
		);
		out.set(rid, {
			coordinatorMs: span.cpu,
			laneMs: inside.reduce((sum, e) => sum + e.cpuTime, 0),
			laneMaxMs: inside.reduce((max, e) => Math.max(max, e.cpuTime), 0),
			laneEvents: inside.length
		});
	}
	return out;
}

/** The ladder entry one below the largest that survived, or the first when only it did. */
export function chooseRounds(survived: Record<number, boolean>) {
	let best = -1;
	for (let i = 0; i < LADDER.length && survived[LADDER[i]!]; i++) best = i;
	return best < 0 ? null : LADDER[Math.max(best - 1, 0)]!;
}
