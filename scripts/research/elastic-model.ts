import { writeFileSync } from 'node:fs';

// trace-driven cost model of the managed elastic-memory fixture; costs are parameters, not measurements

export const PAGE_BYTES = 65536;
const CONTROL_BYTES = 65536;
const MIB = 1024 * 1024;

export interface Costs {
	baseMs: number;
	hopMs: number;
	putMs: number;
	getMs: number;
	xferMsPerMiB: number;
}

export const defaultCosts: Costs = {
	baseMs: 50,
	hopMs: 10.6,
	putMs: 20,
	getMs: 0.3,
	xferMsPerMiB: 0
};

export type Op = { kind: 'fill' | 'store' | 'load'; page: number };
export type Topology = 'remote-owner' | 'colocated';
export type WritePolicy = 'write-through' | 'write-back';

export interface Config {
	name: string;
	topology: Topology;
	frames: number;
	writePolicy: WritePolicy;
	opsPerRequest: number;
	costs: Costs;
	coalesce?: boolean;
}

type Fields = Omit<Config, 'name' | 'costs' | 'opsPerRequest'> & { opsPerRequest?: number };

function variant(name: string, fields: Fields): Config {
	return { name, costs: { ...defaultCosts }, opsPerRequest: 16, ...fields };
}

export const variants = {
	measured: variant('measured', {
		topology: 'remote-owner',
		frames: 0,
		writePolicy: 'write-through'
	}),
	'owner-coalesced': variant('owner-coalesced', {
		topology: 'remote-owner',
		frames: 0,
		writePolicy: 'write-through',
		coalesce: true
	}),
	'frames-4': variant('frames-4', {
		topology: 'remote-owner',
		frames: 4,
		writePolicy: 'write-back'
	}),
	'frames-64': variant('frames-64', {
		topology: 'remote-owner',
		frames: 64,
		writePolicy: 'write-back'
	}),
	'frames-256': variant('frames-256', {
		topology: 'remote-owner',
		frames: 256,
		writePolicy: 'write-back'
	}),
	'colocated-4': variant('colocated-4', {
		topology: 'colocated',
		frames: 4,
		writePolicy: 'write-back'
	}),
	'colocated-64': variant('colocated-64', {
		topology: 'colocated',
		frames: 64,
		writePolicy: 'write-back'
	}),
	'colocated-64-one-request': variant('colocated-64-one-request', {
		topology: 'colocated',
		frames: 64,
		writePolicy: 'write-back',
		opsPerRequest: Infinity
	})
};

export function withCosts(config: Config, costs: Partial<Costs>): Config {
	return { ...config, costs: { ...config.costs, ...costs } };
}

function checkConfig({ topology, frames, writePolicy, opsPerRequest, coalesce = false }: Config) {
	const remote = topology === 'remote-owner';
	if (!remote && topology !== 'colocated') throw new Error(`unknown topology ${topology}`);
	if (!Number.isInteger(frames) || frames < 0) throw new Error('frames must be an integer');
	if (!(opsPerRequest >= 1)) throw new Error('opsPerRequest must be >= 1');
	if (remote && (frames === 0) !== (writePolicy === 'write-through')) {
		throw new Error('remote-owner: frames 0 is write-through, frames >= 1 is write-back');
	}
	if (!remote && writePolicy !== 'write-back') throw new Error('colocated is write-back');
	if (coalesce && (!remote || frames !== 0)) {
		throw new Error('coalesce applies to remote-owner with frames 0 only');
	}
}

export interface Result {
	ops: number;
	requests: number;
	hops: number;
	puts: number;
	gets: number;
	bytesMoved: number;
	ms: { base: number; hop: number; put: number; get: number; xfer: number; total: number };
	requestMs: number[];
}

// Requests are ceil(ops / opsPerRequest), each paying baseMs. Frames held at a request
// boundary ride in the checkpoint, charged both ways at xferMsPerMiB.
export function simulate(trace: readonly Op[], config: Config): Result {
	checkConfig(config);
	const { topology, frames, opsPerRequest, costs, coalesce = false } = config;
	const remote = topology === 'remote-owner';
	const framed = frames > 0;
	const out: Result = {
		ops: trace.length,
		requests: 0,
		hops: 0,
		puts: 0,
		gets: 0,
		bytesMoved: 0,
		ms: { base: 0, hop: 0, put: 0, get: 0, xfer: 0, total: 0 },
		requestMs: []
	};
	const cache = new Map<number, boolean>();
	let ownerPage = -1;
	let pendingPage = -1;
	let cur = 0;

	const charge = (bucket: Exclude<keyof Result['ms'], 'total'>, ms: number) => {
		out.ms[bucket] += ms;
		cur += ms;
	};
	const hop = () => {
		out.hops++;
		charge('hop', costs.hopMs);
	};
	const put = () => {
		out.puts++;
		charge('put', costs.putMs);
		if (remote) out.bytesMoved += PAGE_BYTES;
	};
	const get = () => {
		out.gets++;
		charge('get', costs.getMs);
		if (remote) out.bytesMoved += PAGE_BYTES;
	};
	const checkpoint = () => {
		const held = framed ? cache.size : 0;
		const frameBytes = 2 * PAGE_BYTES * held;
		charge('xfer', (costs.xferMsPerMiB * frameBytes) / MIB);
		out.bytesMoved += frameBytes + (remote ? 2 * CONTROL_BYTES : 0);
	};

	const remoteOp = (kind: Op['kind'], page: number) => {
		if (coalesce && pendingPage !== -1 && pendingPage !== page) {
			put();
			pendingPage = -1;
		}
		hop();
		if (kind === 'load') {
			if (ownerPage !== page) {
				get();
				ownerPage = page;
			}
			return;
		}
		ownerPage = page;
		if (coalesce) pendingPage = page;
		else put();
	};

	const localOp = (kind: Op['kind']) => {
		if (kind === 'load') get();
		else put();
	};

	const framedOp = (kind: Op['kind'], page: number) => {
		if (cache.has(page)) {
			const dirty = cache.get(page) || kind !== 'load';
			cache.delete(page);
			cache.set(page, dirty);
			return;
		}
		if (cache.size >= frames) {
			const [victim, dirty] = cache.entries().next().value!;
			cache.delete(victim);
			if (dirty) {
				if (remote) hop();
				put();
			}
		}
		if (kind === 'fill') {
			cache.set(page, true);
			return;
		}
		if (remote) hop();
		get();
		cache.set(page, kind === 'store');
	};

	if (trace.length > 0) charge('base', costs.baseMs);
	for (let n = 0; n < trace.length; n++) {
		if (n > 0 && n % opsPerRequest === 0) {
			checkpoint();
			out.requestMs.push(cur);
			cur = 0;
			charge('base', costs.baseMs);
		}
		const { kind, page } = trace[n]!;
		if (framed) framedOp(kind, page);
		else if (remote) remoteOp(kind, page);
		else localOp(kind);
	}

	if (framed) {
		for (const [, dirty] of cache) {
			if (!dirty) continue;
			if (remote) hop();
			put();
		}
	}
	if (coalesce && pendingPage !== -1) put();
	if (trace.length > 0) out.requestMs.push(cur);
	// the last op ends on a request boundary, so the client makes one more request to read the result
	if (trace.length > 0 && trace.length % opsPerRequest === 0) {
		out.ms.base += costs.baseMs;
		out.requestMs.push(costs.baseMs);
	}

	out.requests = out.requestMs.length;
	out.ms.total = out.ms.base + out.ms.hop + out.ms.put + out.ms.get + out.ms.xfer;
	return out;
}

// Mean request time before and after the first `splitOp` operations.
export function phaseMeans(result: Result, splitOp: number, opsPerRequest: number) {
	const split = splitOp / opsPerRequest;
	const before = result.requestMs.slice(0, split);
	const after = result.requestMs.slice(split);
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	return {
		before: mean(before),
		after: mean(after),
		nBefore: before.length,
		nAfter: after.length
	};
}

// fill, two stores per page, then a strided traversal of two loads per page.
export function fixtureTrace(pages = 3072, stride = 17): Op[] {
	const ops: Op[] = [];
	for (let i = 0; i < pages; i++) {
		ops.push({ kind: 'fill', page: i });
		ops.push({ kind: 'store', page: i }, { kind: 'store', page: i });
	}
	let page = 0;
	for (let n = 0; n < pages; n++) {
		ops.push({ kind: 'load', page }, { kind: 'load', page });
		page = (page + stride) % pages;
	}
	return ops;
}

export function counts(trace: readonly Op[]) {
	const out = {
		ops: trace.length,
		fills: 0,
		stores: 0,
		loads: 0,
		writes: 0,
		distinctLoadPages: 0
	};
	const loaded = new Set<number>();
	for (const op of trace) {
		if (op.kind === 'fill') out.fills++;
		else if (op.kind === 'store') out.stores++;
		else {
			out.loads++;
			loaded.add(op.page);
		}
	}
	out.writes = out.fills + out.stores;
	out.distinctLoadPages = loaded.size;
	return out;
}

export interface TierConfig {
	frames: number;
	cold: number;
	// dirty frames are written only on eviction; nothing is written back when the request ends
	ephemeral?: boolean;
}

export interface TierResult {
	ops: number;
	frameHits: number;
	coldHits: number;
	storeReads: number;
	storeWrites: number;
	compressions: number;
	decompressions: number;
	coldEvictions: number;
	// pages the run wrote to the store at least once
	distinctStored: number;
	// dirty pages still resident when an ephemeral run ends, never written
	droppedDirty: number;
}

// Frames and a compressed pool, both LRU, a page in at most one of them. A frame victim goes to the
// pool whole (compressed, dirty or not); a pool victim is written to the store only when dirty.
// A fill drops any pooled copy without decoding it. Pool capacity counts pages, so counts are exact.
export function simulateTiers(
	trace: readonly Op[],
	{ frames, cold, ephemeral = false }: TierConfig
): TierResult {
	if (!Number.isInteger(frames) || frames < 1) throw new Error('frames must be >= 1');
	if (!Number.isInteger(cold) || cold < 0) throw new Error('cold must be >= 0');
	if (ephemeral && cold > 0) throw new Error('an ephemeral run needs cold 0');
	const stored = new Set<number>();
	const out: TierResult = {
		ops: trace.length,
		frameHits: 0,
		coldHits: 0,
		storeReads: 0,
		storeWrites: 0,
		compressions: 0,
		decompressions: 0,
		coldEvictions: 0,
		distinctStored: 0,
		droppedDirty: 0
	};
	const write = (page: number) => {
		out.storeWrites++;
		stored.add(page);
	};
	const framed = new Map<number, boolean>();
	const pooled = new Map<number, boolean>();
	const evictPooled = () => {
		const [victim, dirty] = pooled.entries().next().value!;
		pooled.delete(victim);
		out.coldEvictions++;
		if (dirty) {
			out.decompressions++;
			write(victim);
		}
	};
	for (const { kind, page } of trace) {
		if (framed.has(page)) {
			out.frameHits++;
			const dirty = framed.get(page)! || kind !== 'load';
			framed.delete(page);
			framed.set(page, dirty);
			continue;
		}
		let dirty = kind !== 'load';
		if (kind === 'fill') pooled.delete(page);
		else if (pooled.has(page)) {
			out.coldHits++;
			out.decompressions++;
			dirty = pooled.get(page)! || kind === 'store';
			pooled.delete(page);
		} else out.storeReads++;
		if (framed.size >= frames) {
			const [victim, victimDirty] = framed.entries().next().value!;
			framed.delete(victim);
			if (cold > 0) {
				pooled.set(victim, victimDirty);
				out.compressions++;
				if (pooled.size > cold) evictPooled();
			} else if (victimDirty) write(victim);
		}
		framed.set(page, dirty);
	}
	for (const [page, dirty] of framed) {
		if (!dirty) continue;
		if (ephemeral) out.droppedDirty++;
		else write(page);
	}
	for (const [page, dirty] of pooled) {
		if (!dirty) continue;
		out.decompressions++;
		write(page);
	}
	out.distinctStored = stored.size;
	return out;
}

export interface TimeParams {
	baseMs: number;
	// fixed cost of a request that wrote to the store
	flushMs: number;
	readMs: number;
	writeMs: number;
	decompressMs: number;
	compressMs: number;
	hitMs: number;
}

export interface TimeCounts {
	flushes: number;
	storeReads: number;
	storeWrites: number;
	compressions: number;
	decompressions: number;
	hits: number;
}

// wall time of one request from its counts: base, flush, store reads and writes, codec and hits
export function predictTime(p: TimeParams, c: TimeCounts): number {
	return (
		p.baseMs +
		c.flushes * p.flushMs +
		c.storeReads * p.readMs +
		c.storeWrites * p.writeMs +
		c.decompressions * p.decompressMs +
		c.compressions * p.compressMs +
		c.hits * p.hitMs
	);
}

// model B: one fixed term per request plus one cost per store read, store write and codec call
export interface TimeFit {
	baseMs: number;
	readMs: number;
	writeMs: number;
	codecMs: number;
}

export interface TimeSample {
	wallMs: number;
	storeReads: number;
	storeWrites: number;
	compressions: number;
	decompressions: number;
}

const featuresOf = (s: Omit<TimeSample, 'wallMs'>) => [
	1,
	s.storeReads / 1000,
	s.storeWrites / 1000,
	(s.compressions + s.decompressions) / 1000
];

// least squares over the listed feature columns through the normal equations, in scaled units
function solveColumns(samples: readonly TimeSample[], cols: readonly number[]): number[] {
	const n = cols.length;
	const a = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
	for (const s of samples) {
		const x = featuresOf(s);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) a[i]![j]! += x[cols[i]!]! * x[cols[j]!]!;
			a[i]![n]! += x[cols[i]!]! * s.wallMs;
		}
	}
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++)
			if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
		if (Math.abs(a[pivot]![col]!) < 1e-9) throw new Error('samples do not identify the model');
		[a[col], a[pivot]] = [a[pivot]!, a[col]!];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = a[r]![col]! / a[col]![col]!;
			for (let c = col; c <= n; c++) a[r]![c]! -= f * a[col]![c]!;
		}
	}
	return a.map((row, i) => row[n]! / row[i]!);
}

const toFit = ([baseMs, readMs, writeMs, codecMs]: readonly number[]): TimeFit => ({
	baseMs: baseMs!,
	readMs: readMs! / 1000,
	writeMs: writeMs! / 1000,
	codecMs: codecMs! / 1000
});

// ordinary least squares; throws when the samples cannot identify all four terms
export function fitTime(samples: readonly TimeSample[]): TimeFit {
	return toFit(solveColumns(samples, [0, 1, 2, 3]));
}

// non-negative least squares: the optimum is the unconstrained fit on some subset of terms with
// the rest at zero, so take the feasible subset fit with the smallest squared error
export function fitTimeNonNegative(samples: readonly TimeSample[]): TimeFit {
	solveColumns(samples, [0, 1, 2, 3]);
	let best: { sse: number; v: number[] } | undefined;
	for (let mask = 1; mask < 16; mask++) {
		const cols = [0, 1, 2, 3].filter((c) => mask & (1 << c));
		let sol: number[];
		try {
			sol = solveColumns(samples, cols);
		} catch {
			continue;
		}
		if (sol.some((v) => v < 0)) continue;
		const v = [0, 0, 0, 0];
		cols.forEach((c, i) => (v[c] = sol[i]!));
		const f = toFit(v);
		const sse = samples.reduce((sum, s) => sum + (predictFit(f, s) - s.wallMs) ** 2, 0);
		if (!best || sse < best.sse - 1e-9) best = { sse, v };
	}
	return toFit(best!.v);
}

export function predictFit(fit: TimeFit, s: Omit<TimeSample, 'wallMs'>): number {
	return predictTime(
		{
			baseMs: fit.baseMs,
			flushMs: 0,
			readMs: fit.readMs,
			writeMs: fit.writeMs,
			decompressMs: fit.codecMs,
			compressMs: fit.codecMs,
			hitMs: 0
		},
		{
			flushes: 0,
			storeReads: s.storeReads,
			storeWrites: s.storeWrites,
			compressions: s.compressions,
			decompressions: s.decompressions,
			hits: 0
		}
	);
}

// percent error of predicted against measured, signed
export const percentError = (predicted: number, measured: number) =>
	((predicted - measured) / measured) * 100;

export function leaveOneOut(samples: readonly TimeSample[], fitter = fitTime) {
	return samples.map((held, i) => {
		const fit = fitter(samples.filter((_, j) => j !== i));
		const predicted = predictFit(fit, held);
		return {
			predicted,
			measured: held.wallMs,
			percentError: percentError(predicted, held.wallMs)
		};
	});
}

export function solveLinear(f: (x: number) => number, target: number) {
	const a = f(0);
	return (target - a) / (f(1) - a);
}

// largest x in [lo, hi] with fn(x) <= limit, for nondecreasing fn; null if none.
export function largestValue(fn: (x: number) => number, limit: number, lo: number, hi: number) {
	if (fn(lo) > limit) return null;
	if (fn(hi) <= limit) return hi;
	let a = lo;
	let b = hi;
	for (let i = 0; i < 80; i++) {
		const m = (a + b) / 2;
		if (fn(m) <= limit) a = m;
		else b = m;
	}
	return a;
}

export const measuredTarget = {
	total: 392268,
	requests: 961,
	writeReq: 576,
	readReq: 385,
	writeMean: 533,
	readMean: 221.5
};

// one-parameter refit of the hop cost to the read-phase mean of the measured run
export function refitHop(trace: readonly Op[]) {
	const split = counts(trace).writes;
	const readMeanAt = (hopMs: number) =>
		phaseMeans(simulate(trace, withCosts(variants.measured, { hopMs })), split, 16).after;
	return solveLinear(readMeanAt, measuredTarget.readMean);
}

if (import.meta.main) {
	const trace = fixtureTrace();
	const c = counts(trace);
	const split = c.writes;
	const run = (v: Config, costs: Partial<Costs> = {}) => simulate(trace, withCosts(v, costs));
	const pct = (model: number, meas: number) => `${(((model - meas) / meas) * 100).toFixed(1)}%`;
	const secs = (ms: number) => (ms / 1000).toFixed(1);
	const table = (rows: (string | number)[][]) => {
		const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
		for (const r of rows) console.log(r.map((x, i) => String(x).padEnd(widths[i]!)).join('  '));
	};

	console.log('MODEL, not a measurement. Defaults:', JSON.stringify(defaultCosts));
	console.log(
		`trace: ${c.ops} ops, ${c.writes} writes, ${c.loads} loads, ${c.distinctLoadPages} pages\n`
	);

	const measured = run(variants.measured);
	const phases = phaseMeans(measured, split, 16);
	const hopFit = refitHop(trace);
	const hopFitRun = run(variants.measured, { hopMs: hopFit });
	const hopFitPhases = phaseMeans(hopFitRun, split, 16);
	console.log('(1) calibration, defaults');
	table([
		['quantity', 'measured', 'model', 'model vs measured'],
		[
			'total ms',
			measuredTarget.total,
			measured.ms.total.toFixed(1),
			pct(measured.ms.total, measuredTarget.total)
		],
		[
			'requests',
			measuredTarget.requests,
			measured.requests,
			measured.requests - measuredTarget.requests
		],
		[
			'write-phase requests',
			measuredTarget.writeReq,
			phases.nBefore,
			phases.nBefore - measuredTarget.writeReq
		],
		['read-phase requests', measuredTarget.readReq, phases.nAfter, 'includes terminal'],
		[
			'write-phase mean ms',
			measuredTarget.writeMean,
			phases.before.toFixed(1),
			pct(phases.before, measuredTarget.writeMean)
		],
		[
			'read-phase mean ms',
			measuredTarget.readMean,
			phases.after.toFixed(1),
			pct(phases.after, measuredTarget.readMean)
		]
	]);
	console.log(
		`\nhop refit to the read phase: ${hopFit.toFixed(3)} ms (default ${defaultCosts.hopMs})`
	);
	console.log(
		`refit write-phase mean ${hopFitPhases.before.toFixed(1)} ms, total ${hopFitRun.ms.total.toFixed(0)} ms`
	);

	const rows: (string | number)[][] = [
		['variant', 'requests', 'hops', 'puts', 'gets', 'total s', 'GiB moved']
	];
	const dom: (string | number)[][] = [['variant', 'dominant term', 'share of total']];
	const summary: Record<string, Result> = {};
	const keys = ['base', 'hop', 'put', 'get', 'xfer'] as const;
	for (const [name, v] of Object.entries(variants)) {
		const r = run(v);
		const key = keys.reduce((a, b) => (r.ms[a] >= r.ms[b] ? a : b));
		summary[name] = r;
		rows.push([
			name,
			r.requests,
			r.hops,
			r.puts,
			r.gets,
			secs(r.ms.total),
			(r.bytesMoved / 2 ** 30).toFixed(3)
		]);
		dom.push([name, key, `${((r.ms[key] / r.ms.total) * 100).toFixed(1)}%`]);
	}
	console.log('\n(2) named variants, default costs');
	table(rows);
	console.log('\n(3) dominant term');
	table(dom);

	const colocatedFn = (limit: number) => (x: number) =>
		run(variants['colocated-64-one-request'], { putMs: x }).ms.total;
	const colocatedRows: (string | number)[][] = [['limit', 'largest colocated putMs']];
	for (const limit of [60000, 10000, 2000]) {
		const x = largestValue(colocatedFn(limit), limit, 0, 1000);
		colocatedRows.push([`${limit / 1000} s`, x === null ? 'none' : x.toFixed(3)]);
	}
	console.log('\n(4) colocated-64, opsPerRequest Infinity');
	table(colocatedRows);

	const remoteFn = (limit: number) => (x: number) =>
		run(variants['frames-64'], { hopMs: x }).ms.total;
	const remoteRows: (string | number)[][] = [['limit', 'largest hopMs', 'total at hopMs 0 (s)']];
	for (const limit of [60000, 10000, 2000]) {
		const x = largestValue(remoteFn(limit), limit, 0, 1000);
		remoteRows.push([
			`${limit / 1000} s`,
			x === null ? 'none' : x.toFixed(3),
			secs(run(variants['frames-64'], { hopMs: 0 }).ms.total)
		]);
	}
	console.log('\n(5) remote-owner frames-64 write-back');
	table(remoteRows);

	const out = process.argv[2];
	if (out) {
		const doc = {
			note: 'MODEL, not a measurement. Costs are parameters.',
			defaults: defaultCosts,
			pageBytes: PAGE_BYTES,
			refit: { hopMs: hopFit },
			variants: summary,
			thresholds: {
				colocated64OneRequestPutMs: colocatedRows.slice(1),
				remoteFrames64HopMs: remoteRows.slice(1)
			}
		};
		writeFileSync(out, `${JSON.stringify(doc, null, '\t')}\n`, { flag: 'wx' });
		console.log(`\nwrote ${out}`);
	}
}
