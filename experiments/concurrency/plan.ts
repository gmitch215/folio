export type Arm = 'worker' | 'worker-one' | 'do-same' | 'do-hint' | 'direct';
export type Level = 'empty' | 'low' | 'high';

export const ARMS: Arm[] = ['worker', 'worker-one', 'do-same', 'do-hint', 'direct'];
export const LEVELS: Level[] = ['empty', 'low', 'high'];
export const LOADED: Level[] = ['low', 'high'];
export const TARGET_CPU_MS: Record<Level, number> = { empty: 0, low: 70, high: 340 };
export const WIDTH = 4;
export const KS = [1, WIDTH] as const;
export const HINTS = ['wnam', 'enam', 'weur', 'apac'];
export const SEED = 12345;
export const REPS = 12;
export const WARMUPS = 1;
export const INVOCATION_CAP = 1500;
export const FAILURE_STREAK = 8;
// decision rule of METHOD.md
export const MAX_INDEX = 1.5;
export const MIN_CPU_OVER_WALL = 0.8;
// a one-call net wall below this says nothing about overlap
export const MIN_NET_MS = 5;
export const USABLE_MIN = 6;
export const FAILURE_RATE_MAX = 0.02;
export const CALIBRATION_TOLERANCE = 0.2;
export const PROBE_ROUNDS = [1_000_000, 10_000_000, 100_000_000];
export const PROBE_MIN_NET_MS = 10;
export const MAX_ROUNDS = 4_000_000_000;
export const PREFIX = 'cfw-folio-concurrency-';
export const TAIL_PROBE = 'concurrency-lane';

export interface Cell {
	arm: Arm;
	level: Level;
	k: number;
}

const blocks = LEVELS.flatMap((level) => KS.map((k) => ({ level, k })));

const rotate = <T>(items: T[], by: number) => items.map((_, i) => items[(i + by) % items.length]!);

/**
 * The cells of one repetition in run order: the six level and width blocks rotate by one a
 * repetition, the arms inside a block rotate by the repetition plus the block, odd repetitions run
 * in reverse. Arms are interleaved at cell level so slow drift touches all of them.
 */
export function schedule(rep: number): Cell[] {
	const turn = Math.max(rep, 0);
	const order = rotate(blocks, turn % blocks.length).flatMap((block, b) =>
		rotate(ARMS, (turn + b) % ARMS.length).map((arm) => ({ arm, ...block }))
	);
	return turn % 2 ? order.reverse() : order;
}

/** Worker, Durable Object and lane invocations one cell makes, counting the coordinator. */
export const invocations = (arm: Arm, k: number) => (arm === 'direct' ? k : 1 + k);
export const topLevel = (arm: Arm, k: number) => (arm === 'direct' ? k : 1);
export const durableObjectCalls = (arm: Arm, k: number) => (arm.startsWith('do-') ? k : 0);

// calibration: empty trials, probe trials per attempt, then verification passes
export const CAL_EMPTY = 5;
export const CAL_PROBE = 5;
export const CAL_VERIFY = 3;
export const CAL_PASSES = 2;
const CAL_REQUESTS =
	CAL_EMPTY + PROBE_ROUNDS.length * CAL_PROBE + CAL_PASSES * LOADED.length * CAL_VERIFY;
// the probe stops once one call nets PROBE_MIN_NET_MS, so a probe call is far below the loaded levels
const CAL_CPU_UPPER_MS =
	PROBE_ROUNDS.length * CAL_PROBE * TARGET_CPU_MS.low +
	CAL_PASSES * CAL_VERIFY * LOADED.reduce((sum, level) => sum + TARGET_CPU_MS[level] * 1.5, 0);
// readiness: one coordinator probe touches the coordinator, four lanes, four same and four hinted
// objects; the four direct routes are probed on their own
const READY = 1 + 3 * WIDTH;
const WHERE = 1 + 3 * WIDTH;
const OBJECTS = 2 * WIDTH;
// assumption, not a measurement: every object counted active for this long
export const ACTIVE_SECONDS_UPPER = 900;

// list rates read from the pricing pages on 2026-11-02; the monthly included amounts are not applied
export const PRICES = {
	read: '2026-11-02',
	sources: [
		'https://developers.cloudflare.com/workers/platform/pricing/',
		'https://developers.cloudflare.com/durable-objects/platform/pricing/'
	],
	workersRequestsPerMillion: 0.3,
	workersCpuPerMillionMs: 0.02,
	durableObjectRequestsPerMillion: 0.15,
	durableObjectGbSecondsPerMillion: 12.5,
	durableObjectBilledGb: 0.128
};

export interface Counts {
	workerRequests: number;
	cpuMs: number;
	durableObjectRequests: number;
	durableObjectGbSeconds: number;
}

export function price(counts: Counts) {
	const usd = {
		workerRequests: (counts.workerRequests / 1e6) * PRICES.workersRequestsPerMillion,
		cpu: (counts.cpuMs / 1e6) * PRICES.workersCpuPerMillionMs,
		durableObjectRequests:
			(counts.durableObjectRequests / 1e6) * PRICES.durableObjectRequestsPerMillion,
		durableObjectDuration:
			(counts.durableObjectGbSeconds / 1e6) * PRICES.durableObjectGbSecondsPerMillion
	};
	return { usd, total: Object.values(usd).reduce((a, b) => a + b, 0) };
}

export function plan(reps = REPS, warmups = WARMUPS) {
	const cells = schedule(0);
	const perRep = cells.reduce((sum, c) => sum + invocations(c.arm, c.k), 0);
	const perRepTop = cells.reduce((sum, c) => sum + topLevel(c.arm, c.k), 0);
	const perRepObjects = cells.reduce((sum, c) => sum + durableObjectCalls(c.arm, c.k), 0);
	const perRepCpu = cells.reduce((sum, c) => sum + c.k * TARGET_CPU_MS[c.level], 0);
	const rounds = reps + warmups;
	const expected = rounds * perRep + 2 * CAL_REQUESTS + READY + WIDTH + WHERE;
	const counts: Counts = {
		workerRequests: rounds * perRepTop + CAL_REQUESTS + 1 + WIDTH + 1,
		cpuMs: rounds * perRepCpu + CAL_CPU_UPPER_MS,
		durableObjectRequests: rounds * perRepObjects + OBJECTS + OBJECTS,
		durableObjectGbSeconds: OBJECTS * ACTIVE_SECONDS_UPPER * PRICES.durableObjectBilledGb
	};
	return {
		scripts: 1 + WIDTH,
		objects: OBJECTS,
		cellsPerRep: cells.length,
		reps,
		warmups,
		perRep,
		perRepTopLevel: perRepTop,
		calibrationRequests: CAL_REQUESTS,
		expected,
		cap: INVOCATION_CAP,
		withinCap: expected <= INVOCATION_CAP,
		topLevelRequests: counts.workerRequests,
		counts,
		price: price(counts)
	};
}

export interface Call {
	slot: number;
	ok: boolean;
	error?: string;
	isolate?: string;
	instance?: string;
	call?: number;
	checksum?: number;
	entered?: number;
	colo?: string | null;
	cpuMs?: number;
	wallMs?: number;
}

export interface Sample {
	rep: number;
	rid: number;
	arm: Arm;
	level: Level;
	k: number;
	rounds: number;
	status: number | null;
	error?: string;
	clientWallMs: number;
	exact?: boolean;
	coordinatorIsolate?: string;
	coordinatorColo?: string | null;
	calls: Call[];
}

/** The reference result of the kernel: the same linear congruential loop in plain JavaScript. */
export function lcg(rounds: number) {
	let x = SEED | 0;
	for (let i = 0; i < rounds; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
	return x >>> 0;
}

export const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Nearest-rank quantile, q in (0, 1]. */
export const quantile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
};

const med = (values: number[]) => (values.length ? median(values) : null);

/** The overlap index; null when the one-call net wall is too small to divide by. */
export function overlapIndex(
	wall4: number,
	empty4: number,
	wall1: number,
	empty1: number,
	minNet = MIN_NET_MS
) {
	const net1 = wall1 - empty1;
	return net1 < minNet ? null : (wall4 - empty4) / net1;
}

/** CPU over wall: summed cpu of the events over summed wall of the same events. */
export function cpuOverWall(events: { cpuMs: number; wallMs: number }[]) {
	const wall = events.reduce((sum, e) => sum + e.wallMs, 0);
	return wall > 0 ? events.reduce((sum, e) => sum + e.cpuMs, 0) / wall : null;
}

/** The rounds that would net `target` ms, scaled from one measurement, capped at the i32 range. */
export function scaleRounds(rounds: number, netMs: number, targetMs: number) {
	if (netMs <= 0) return Math.min(MAX_ROUNDS, rounds * 10);
	return Math.min(MAX_ROUNDS, Math.max(1, Math.round((rounds * targetMs) / netMs)));
}

export const withinTolerance = (netMs: number, targetMs: number) =>
	Math.abs(netMs / targetMs - 1) <= CALIBRATION_TOLERANCE;

export interface TraceEvent {
	scriptName?: string | null;
	cpuTime: number;
	wallTime: number;
	outcome?: string;
	logs?: { message: unknown[] }[];
}

/** Maps `rid:slot` to the platform's cpu and wall for that call, read from the lane's own log line. */
export function attribute(events: TraceEvent[]) {
	const out = new Map<string, { cpuMs: number; wallMs: number }>();
	for (const event of events)
		for (const log of event.logs ?? [])
			for (const message of log.message) {
				if (typeof message !== 'string') continue;
				let value: any;
				try {
					value = JSON.parse(message);
				} catch {
					continue;
				}
				if (value?.probe === TAIL_PROBE)
					out.set(`${value.rid}:${value.slot}`, {
						cpuMs: event.cpuTime,
						wallMs: event.wallTime
					});
			}
	return out;
}

/** Copies the attributed cpu and wall onto each call. */
export function join(samples: Sample[], trace: Map<string, { cpuMs: number; wallMs: number }>) {
	return samples.map((sample) => ({
		...sample,
		calls: sample.calls.map((call) => {
			const hit = trace.get(`${sample.rid}:${call.slot}`);
			return hit ? { ...call, ...hit } : call;
		})
	}));
}

const eventsOf = (rows: Sample[]) =>
	rows.flatMap((s) =>
		s.calls.flatMap((c) =>
			c.cpuMs === undefined ? [] : [{ cpuMs: c.cpuMs, wallMs: c.wallMs ?? 0 }]
		)
	);

const usable = (sample: Sample) =>
	sample.status === 200 && sample.exact !== false && sample.calls.every((call) => call.ok);

export interface Row {
	arm: Arm;
	level: Level;
	k: number;
	requests: number;
	failures: number;
	usable: number;
	wallMs: number | null;
	wallP10: number | null;
	wallP90: number | null;
	wallMin: number | null;
	wallMax: number | null;
	events: number;
	eventCoverage: number;
	cpuMsPerCall: number | null;
	cpuOverWall: number | null;
	eventRatioMedian: number | null;
	eventWallP90: number | null;
	driftFirstHalf: number | null;
	driftSecondHalf: number | null;
	belowShare: number | null;
	isolatesPerRequest: number | null;
	isolatesTotal: number;
	instancesTotal: number;
	startSpreadMs: number | null;
}

/** One row per arm, level and width. Medians use the requests that did their job. */
export function summarize(samples: Sample[]): Row[] {
	return ARMS.flatMap((arm) =>
		LEVELS.flatMap((level) =>
			KS.flatMap((k): Row[] => {
				const all = samples.filter((s) => s.arm === arm && s.level === level && s.k === k);
				if (!all.length) return [];
				const good = all.filter(usable);
				const walls = good.map((s) => s.clientWallMs);
				const events = eventsOf(good);
				const calls = good.reduce((sum, s) => sum + s.calls.length, 0);
				const reps = [...new Set(good.map((s) => s.rep))].sort((a, b) => a - b);
				const half = reps[reps.length >> 1];
				const ratio = (rows: Sample[]) => cpuOverWall(eventsOf(rows));
				const spreads = good.flatMap((s) => {
					const entered = s.calls.flatMap((c) =>
						c.entered === undefined ? [] : [c.entered]
					);
					return entered.length > 1 ? [Math.max(...entered) - Math.min(...entered)] : [];
				});
				const perEventRatio = events
					.filter((e) => e.wallMs > 0)
					.map((e) => e.cpuMs / e.wallMs);
				return [
					{
						arm,
						level,
						k,
						requests: all.length,
						failures: all.length - good.length,
						usable: good.length,
						wallMs: med(walls),
						wallP10: walls.length ? quantile(walls, 0.1) : null,
						wallP90: walls.length ? quantile(walls, 0.9) : null,
						wallMin: walls.length ? Math.min(...walls) : null,
						wallMax: walls.length ? Math.max(...walls) : null,
						events: events.length,
						eventCoverage: calls ? events.length / calls : 0,
						cpuMsPerCall: med(events.map((e) => e.cpuMs)),
						cpuOverWall: cpuOverWall(events),
						eventRatioMedian: med(perEventRatio),
						eventWallP90: events.length
							? quantile(
									events.map((e) => e.wallMs),
									0.9
								)
							: null,
						driftFirstHalf: ratio(
							good.filter((s) => half !== undefined && s.rep < half)
						),
						driftSecondHalf: ratio(
							good.filter((s) => half !== undefined && s.rep >= half)
						),
						belowShare: perEventRatio.length
							? perEventRatio.filter((r) => r < MIN_CPU_OVER_WALL).length /
								perEventRatio.length
							: null,
						isolatesPerRequest: med(
							good.map((s) => new Set(s.calls.map((c) => c.isolate)).size)
						),
						isolatesTotal: new Set(good.flatMap((s) => s.calls.map((c) => c.isolate)))
							.size,
						instancesTotal: new Set(good.flatMap((s) => s.calls.map((c) => c.instance)))
							.size,
						startSpreadMs: med(spreads)
					}
				];
			})
		)
	);
}

export interface Verdict {
	arm: Arm;
	level: Level;
	pass: boolean | null;
	index: number | null;
	cpuOverWall: number | null;
	isolates: number;
	detail: string;
}

/** The decision rule of METHOD.md for each arm and loaded level; null means the data cannot say. */
export function decide(rows: Row[]): Verdict[] {
	const find = (arm: Arm, level: Level, k: number) =>
		rows.find((r) => r.arm === arm && r.level === level && r.k === k);
	return ARMS.flatMap((arm) =>
		LOADED.map((level): Verdict => {
			const one = find(arm, level, 1);
			const four = find(arm, level, WIDTH);
			const empty1 = find(arm, 'empty', 1);
			const empty4 = find(arm, 'empty', WIDTH);
			const index =
				one?.wallMs != null &&
				four?.wallMs != null &&
				empty1?.wallMs != null &&
				empty4?.wallMs != null
					? overlapIndex(four.wallMs, empty4.wallMs, one.wallMs, empty1.wallMs)
					: null;
			const ratio = four?.cpuOverWall ?? null;
			const base = {
				arm,
				level,
				index,
				cpuOverWall: ratio,
				isolates: four?.isolatesTotal ?? 0
			};
			const rate = Math.max(
				...[one, four, empty1, empty4].map((r) => (r ? r.failures / r.requests : 0))
			);
			const text = `index ${index?.toFixed(2) ?? 'none'} (at most ${MAX_INDEX}), cpu over wall ${ratio?.toFixed(2) ?? 'none'} (at least ${MIN_CPU_OVER_WALL}), failures ${(rate * 100).toFixed(1)}%`;
			if (
				index === null ||
				ratio === null ||
				[one, four, empty1, empty4].some((r) => !r || r.usable < USABLE_MIN)
			)
				return { ...base, pass: null, detail: `no verdict: ${text}` };
			return {
				...base,
				pass: index <= MAX_INDEX && ratio >= MIN_CPU_OVER_WALL,
				detail: rate > FAILURE_RATE_MAX ? `above the failure rate limit: ${text}` : text
			};
		})
	);
}
