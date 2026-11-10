// fault-budget governor for one paged request (GAME-PLAN E2c). Research instrument until the G-E2 gate passes.

// census trace: a two-level LRU stream. An access (page * 2 + isWrite) appears only when the page is outside the
// top-W recency window; LEAVE | page appears when a page falls out of that window into the rest of the LRU.
export const CENSUS_WINDOW_PAGES = 32;
export const LEAVE = 0x80000000;

export interface Tier {
	fillMs: number;
	evictMs: number;
}

export interface GovernorConfig {
	// cap on delta = tau * native + paging cost, in seconds
	capSeconds: number;
	wallCapSeconds: number;
	tau: number;
	tiers: Record<string, Tier>;
}

export interface Counters {
	misses: Record<string, number>;
	evictions: Record<string, number>;
	decodeMs: number;
	pagingSeconds: number;
	deltaSeconds: number;
}

export type BudgetReason = 'delta' | 'wall' | 'clock';

export class PagingBudgetExceeded extends Error {
	readonly code = 'PAGING_BUDGET_EXCEEDED';
	readonly reason: BudgetReason;
	readonly projectedSeconds: number;
	readonly capSeconds: number;
	readonly counters: Counters;

	constructor(
		reason: BudgetReason,
		projectedSeconds: number,
		capSeconds: number,
		counters: Counters
	) {
		super(
			`paging budget exceeded (${reason}): ${projectedSeconds} s against a cap of ${capSeconds} s`
		);
		this.name = 'PagingBudgetExceeded';
		this.reason = reason;
		this.projectedSeconds = projectedSeconds;
		this.capSeconds = capSeconds;
		this.counters = counters;
	}
}

// the fixed rule: delta at most 2 s plus 1 times the profiled native time, and 15 s wall in any case.
export function budgetFor(profiledNativeSeconds: number) {
	return { capSeconds: 2 + profiledNativeSeconds, wallCapSeconds: 15 };
}

export interface Governor {
	onMiss(tier: string): void;
	onEvict(tier: string): void;
	onDecode(ms: number): void;
	check(nativeElapsedMs: number): void;
	pagingSeconds(): number;
	counters(): Counters;
}

export function createGovernor(config: GovernorConfig, clock: () => number): Governor {
	const { capSeconds, wallCapSeconds, tau, tiers } = config;
	if (!(capSeconds >= 0) || !(wallCapSeconds > 0) || !(tau >= 0))
		throw new RangeError('governor cap, wall cap or tau out of range');
	const misses: Record<string, number> = {};
	const evictions: Record<string, number> = {};
	for (const [name, tier] of Object.entries(tiers)) {
		if (!(tier.fillMs >= 0 && tier.evictMs >= 0))
			throw new RangeError(`tier ${name} cost out of range`);
		misses[name] = 0;
		evictions[name] = 0;
	}
	const start = clock();
	let last = start;
	let nativeMs = 0;
	let pagingMs = 0;
	let decodeMs = 0;

	function tierOf(name: string): Tier {
		const tier = tiers[name];
		if (!tier) throw new RangeError(`unknown tier ${name}`);
		return tier;
	}
	function pagingSeconds(): number {
		return (pagingMs + decodeMs) / 1000;
	}
	function counters(): Counters {
		const paging = pagingSeconds();
		return {
			misses: { ...misses },
			evictions: { ...evictions },
			decodeMs,
			pagingSeconds: paging,
			deltaSeconds: (tau * nativeMs) / 1000 + paging
		};
	}

	return {
		onMiss(name) {
			pagingMs += tierOf(name).fillMs;
			misses[name]! += 1;
		},
		onEvict(name) {
			pagingMs += tierOf(name).evictMs;
			evictions[name]! += 1;
		},
		onDecode(ms) {
			if (!(ms >= 0)) throw new RangeError('decode time out of range');
			decodeMs += ms;
		},
		check(nativeElapsedMs) {
			const now = clock();
			// fail closed: a clock that goes backwards or reports NaN cannot prove the budget holds
			if (!(now >= last))
				throw new PagingBudgetExceeded(
					'clock',
					(now - start) / 1000,
					wallCapSeconds,
					counters()
				);
			last = now;
			nativeMs = nativeElapsedMs;
			const delta = (tau * nativeMs) / 1000 + pagingSeconds();
			if (delta > capSeconds)
				throw new PagingBudgetExceeded('delta', delta, capSeconds, counters());
			const wall = (now - start) / 1000;
			if (wall > wallCapSeconds)
				throw new PagingBudgetExceeded('wall', wall, wallCapSeconds, counters());
		},
		pagingSeconds,
		counters
	};
}

export interface TraceRun {
	events: Uint32Array;
	budgetPages: number;
	windowPages: number;
	nativeMs: number;
	tier: string;
	config: GovernorConfig;
}

function restCapacity({ budgetPages, windowPages }: TraceRun): number {
	const cap = budgetPages - windowPages;
	if (!(cap >= 1)) throw new RangeError('resident budget must exceed the window');
	return cap;
}

function emptyRecord(config: GovernorConfig): Record<string, number> {
	return Object.fromEntries(Object.keys(config.tiers).map((name) => [name, 0]));
}

// independent of createGovernor: a timestamp LRU over the rest list, with costs summed once at the end.
export function replay(run: TraceRun): Counters {
	const cap = restCapacity(run);
	const resident = new Set<number>();
	const stamp = new Map<number, number>();
	let misses = 0;
	let evictions = 0;
	for (let i = 0; i < run.events.length; i++) {
		const e = run.events[i]!;
		if (e >= LEAVE) {
			const page = e - LEAVE;
			if (resident.size === cap) {
				let victim = -1;
				let oldest = Infinity;
				for (const p of resident) {
					if (stamp.get(p)! < oldest) {
						oldest = stamp.get(p)!;
						victim = p;
					}
				}
				resident.delete(victim);
				evictions++;
			}
			resident.add(page);
			stamp.set(page, i);
		} else {
			const page = e >>> 1;
			if (resident.has(page)) resident.delete(page);
			else misses++;
		}
	}
	const tier = run.config.tiers[run.tier];
	if (!tier) throw new RangeError(`unknown tier ${run.tier}`);
	const paging = (misses * tier.fillMs + evictions * tier.evictMs) / 1000;
	return {
		misses: { ...emptyRecord(run.config), [run.tier]: misses },
		evictions: { ...emptyRecord(run.config), [run.tier]: evictions },
		decodeMs: 0,
		pagingSeconds: paging,
		deltaSeconds: (run.config.tau * run.nativeMs) / 1000 + paging
	};
}

export interface GovernedRun {
	counters: Counters;
	aborted?: PagingBudgetExceeded;
	atEvent: number;
}

// drives the governor through the trace: native time advances with the event index, and the clock is
// native time plus paging time, so the wall cap sees both.
export function runGoverned(run: TraceRun): GovernedRun {
	const cap = restCapacity(run);
	const { events, tier } = run;
	const n = events.length;
	let nativeNow = 0;
	let gov: Governor | undefined;
	gov = createGovernor(run.config, () => nativeNow + (gov?.pagingSeconds() ?? 0) * 1000);

	let maxPage = 0;
	for (let i = 0; i < n; i++) {
		const e = events[i]!;
		const page = e >= LEAVE ? e - LEAVE : e >>> 1;
		if (page > maxPage) maxPage = page;
	}
	const res = new Uint8Array(maxPage + 1);
	const prev = new Int32Array(maxPage + 1).fill(-1);
	const next = new Int32Array(maxPage + 1).fill(-1);
	let head = -1;
	let tail = -1;
	let count = 0;
	function unlink(p: number) {
		const a = prev[p]!;
		const b = next[p]!;
		if (a >= 0) next[a] = b;
		else head = b;
		if (b >= 0) prev[b] = a;
		else tail = a;
		res[p] = 0;
		count--;
	}
	function link(p: number) {
		prev[p] = -1;
		next[p] = head;
		if (head >= 0) prev[head] = p;
		else tail = p;
		head = p;
		res[p] = 1;
		count++;
	}

	let aborted: PagingBudgetExceeded | undefined;
	let atEvent = n;
	function step(i: number, native: number) {
		nativeNow = native;
		try {
			gov!.check(native);
		} catch (error) {
			if (!(error instanceof PagingBudgetExceeded)) throw error;
			aborted = error;
			atEvent = i;
		}
	}

	for (let i = 0; i < n && !aborted; i++) {
		const e = events[i]!;
		if (e >= LEAVE) {
			if (count === cap) {
				unlink(tail);
				gov.onEvict(tier);
			}
			link(e - LEAVE);
		} else {
			const p = e >>> 1;
			if (res[p] === 1) unlink(p);
			else gov.onMiss(tier);
		}
		step(i, (run.nativeMs * (i + 1)) / n);
	}
	if (!aborted && n === 0) step(0, run.nativeMs);
	return { counters: gov.counters(), aborted, atEvent };
}
