import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest } from '../research/export.ts';

// Summarizes results/continuation/<study>/raw.jsonl into summary.json, then writes manifest.json.
// Run after each study's README exists (writeManifest requires it).

type Row = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results', 'continuation');

const STUDIES = [
	'signal',
	'jspi-chain',
	'durable-chain',
	'isolate-life',
	'boundary-commit',
	'deferred-chain',
	'checkpoint-cost',
	'php-park',
	'php-poll-cost'
];

const read = (study: string, file = 'raw.jsonl'): Row[] =>
	readFileSync(join(root, study, file), 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));

const of = (rows: Row[], kind: string) => rows.filter((row) => row.kind === kind);

const numbers = (values: unknown[]) => values.filter((v): v is number => typeof v === 'number');

function median(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) return null;
	return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

const range = (values: number[]) =>
	values.length ? [Math.min(...values), Math.max(...values)] : null;

function countBy(values: unknown[]) {
	const counts: Record<string, number> = {};
	for (const value of values) {
		const key = String(value);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

// a word of 24 at return is the signal (SIGXCPU) written by the runtime
const fired = (row: Row) => row.status === 200 && row.after1024 === 24;

const FINAL_MATCH_NOTE =
	"finalMatch is false for all 3 sync chains. This probe carried only a block count across events, not the guest's state (worker.mjs), so its final value is not expected to match after a reset. The study tests signal stops and completion, not state continuity; the durable-chain and boundary-commit studies test continuity.";

function signal(rows: Row[]) {
	const signalEvents = of(rows, 'signal');
	const ok = signalEvents.filter((row) => row.status === 200);
	const reset = signalEvents.filter((row) => row.status !== 200);
	const chains = of(rows, 'sync-chain');
	return {
		calibration: {
			calls: of(rows, 'calibration').length,
			outcomes: countBy(of(rows, 'calibration').map((row) => row.outcome))
		},
		signalEvents: {
			events: signalEvents.length,
			ok: ok.length,
			resetBeforeReturn: reset.length,
			fired: signalEvents.filter(fired).length,
			okCpuMs: range(numbers(ok.map((row) => row.cpuMs)))
		},
		syncChains: {
			chains: chains.length,
			finished: chains.filter((row) => row.finished && row.error === null).length,
			finalMatch: chains.filter((row) => row.finalMatch).length,
			finalMatchNote: FINAL_MATCH_NOTE,
			slices: of(rows, 'sync-slice').length,
			slicesByOutcome: countBy(of(rows, 'sync-slice').map((row) => row.outcome))
		}
	};
}

function jspiChain(rows: Row[]) {
	const chains = of(rows, 'chain');
	return {
		chains: chains.length,
		finished: chains.filter((row) => row.finished && row.error === null).length,
		lost: chains.filter((row) => row.error !== null).length,
		finalMatch: chains.filter((row) => row.finalMatch).length,
		slices: of(rows, 'slice').length,
		isolateChanges: chains.reduce((sum, row) => sum + (row.isolateChanges ?? 0), 0),
		byMode: countBy(chains.map((row) => `${row.mode}/${row.every}`))
	};
}

function durableChain(rows: Row[]) {
	const burns = of(rows, 'burn');
	const ok = burns.filter((row) => row.status === 200);
	const checkpoints = of(rows, 'checkpoint-cost');
	const byEvent: Record<string, number[]> = {};
	for (const row of ok) (byEvent[row.event] ??= []).push(row.cpuMs);
	const byDirty: Record<string, number[]> = {};
	for (const row of checkpoints) (byDirty[row.dirtyMiB] ??= []).push(row.cK);
	return {
		initEvents: of(rows, 'init').length,
		burnEvents: burns.length,
		stoppedOnSignal: burns.filter(fired).length,
		resetBeforeReturn: burns.filter((row) => row.status !== 200).length,
		okCpuMs: range(numbers(ok.map((row) => row.cpuMs))),
		readAfterBurn: of(rows, 'd2-call').length,
		pollReturnCpuMs: Object.fromEntries(
			Object.entries(byEvent).map(([event, values]) => [event, range(numbers(values))])
		),
		leadMs: 'not measured: the kill line is not in the raw',
		checkpointCostMsByDirtyMiB: Object.fromEntries(
			Object.entries(byDirty).map(([dirty, values]) => [dirty, median(numbers(values))])
		)
	};
}

function isolateLife(rows: Row[]) {
	const out: Record<string, unknown> = {};
	for (const arm of ['s01', 's1', 's5', 'g']) {
		const slices = of(rows, 'slice').filter((row) => row.arm === arm);
		const objects = of(rows, 'object').filter((row) => row.arm === arm);
		let changes = 0;
		const lastSliceStartCpuS: number[] = [];
		for (const object of objects) {
			const mine = slices
				.filter((row) => row.object === object.object)
				.sort((a, b) => a.k - b.k);
			mine.forEach((row, i) => {
				const previous = mine[i - 1];
				if (previous && row.isolate !== previous.isolate) {
					changes++;
					lastSliceStartCpuS.push(previous.isolateBlocksBefore / 800);
				}
			});
		}
		out[arm] = {
			objects: objects.length,
			slices: slices.length,
			isolateChanges: changes,
			lastSliceStartCpuS: range(lastSliceStartCpuS)
		};
	}
	return out;
}

// the driver stored each object's comparison with the reference, not the final value or SHA-256
function finalMatchFor(driver: Row[], arm: string) {
	const objects = driver.filter((row) => row.arm === arm);
	return {
		objects: objects.length,
		finalAndShaMatch: objects.filter((row) => row.finalMatch && row.shaMatch).length,
		referenceSteps: [...new Set(objects.map((row) => row.referenceSteps))],
		perObject: objects.map((row) => ({
			object: row.object,
			steps: row.steps,
			finalAndShaMatch: row.finalMatch === true && row.shaMatch === true
		}))
	};
}

function boundaryCommit(rows: Row[], driver: Row[]) {
	const out: Record<string, unknown> = {};
	for (const arm of ['g0', 'g1']) {
		const events = of(rows, 'event').filter((row) => row.arm === arm);
		let moves = 0;
		let movesAfterCommit = 0;
		const moveRows: Row[] = [];
		for (const object of new Set(events.map((row) => row.object))) {
			const mine = events.filter((row) => row.object === object).sort((a, b) => a.k - b.k);
			mine.forEach((row, i) => {
				const previous = mine[i - 1];
				if (previous && row.isolate !== previous.isolate) {
					moves++;
					if (previous.stop === 'commit') movesAfterCommit++;
					moveRows.push({
						object,
						k: row.k,
						lostSteps: previous.end - row.start,
						previousStop: previous.stop,
						previousEndSource: previous.endSource
					});
				}
			});
		}
		out[arm] = {
			events: events.length,
			stopCounts: countBy(events.map((row) => row.stop)),
			restores: events.filter((row) => row.restored === 1).length,
			isolateMoves: moves,
			movesAfterCommit,
			finalMatch: finalMatchFor(driver, arm),
			moves: moveRows
		};
	}
	return out;
}

// a signal write is pending at a slice that ended on the signal and was followed by a restore
function signalWritesOf(chains: Row[]) {
	const writes = chains.flatMap((row) => row.signalWrites ?? []);
	return {
		total: writes.length,
		landed: writes.filter((write) => write.landed).length,
		slices: writes.map((write) => write.k),
		landedBySlice: writes.map((write) => write.landed)
	};
}

function deferredChain(rows: Row[]) {
	const out: Record<string, unknown> = {};
	for (const arm of ['f0', 'f1', 'f2', 'f3', 'f4']) {
		const chains = of(rows, 'chain').filter((row) => row.arm === arm);
		out[arm] = {
			chains: chains.length,
			finished: chains.filter((row) => row.finished).length,
			finalAndShaMatch: chains.filter((row) => row.finalMatch && row.shaMatch).length,
			restores: chains.reduce((sum, row) => sum + (row.restores ?? 0), 0),
			isolateMoves: chains.reduce(
				(sum, row) => sum + Math.max(0, (row.isolates ?? 1) - 1),
				0
			),
			slices: of(rows, 'slice').filter((row) => row.arm === arm).length,
			signalWrites: signalWritesOf(chains)
		};
	}
	out.f4 = {
		...(out.f4 as object),
		movesLost: of(rows, 'move').map((row) => row.lost)
	};
	out.moves = deferredMoves(rows);
	out.moveRate = moveRate(rows);
	out.signalEventCpuS = signalEventCpu(rows);
	return out;
}

// paired per run: hashPages, then SHA-256 on the same buffer; the ratio is taken per run
function hashBench(rows: Row[]) {
	const sizes = [...new Set(rows.map((row) => row.mib))];
	return Object.fromEntries(
		sizes.map((mib) => {
			const mine = rows.filter((row) => row.mib === mib);
			const hash = numbers(mine.map((row) => row.hashPagesGiBs));
			const sha = numbers(mine.map((row) => row.sha256GiBs));
			const ratios = mine.map((row) => row.hashPagesGiBs / row.sha256GiBs);
			return [
				`${mib}MiB`,
				{
					runs: mine.length,
					nodeVersion: [...new Set(mine.map((row) => row.nodeVersion))],
					hashPagesMedianGiBs: median(hash),
					hashPagesRangeGiBs: range(hash),
					sha256MedianGiBs: median(sha),
					pairedRatioMedian: round3(median(ratios)!),
					pairedRatioRange: range(ratios)?.map(round3)
				}
			];
		})
	);
}

function checkpointCost(rows: Row[], bench: Row[]) {
	const exact = of(rows, 'exact')[0];
	const timing = of(rows, 'timing').find((row) => row.alarm === true);
	const checkpoints = of(rows, 'checkpoints');
	const hash = of(rows, 'hash-pass');
	const pollPairs = of(rows, 'poll-pair');
	return {
		exact: exact
			? { value_equal: exact.value_equal, sha_equal: exact.sha_equal, events: exact.events }
			: null,
		handoffAlarmMedianMs: timing?.amortized_per_event_ms_median ?? null,
		durableRun2Checkpoints: checkpoints.length,
		hashPass: hash.map((row) => ({
			mib: row.mib,
			wasmGiBs: row.wasm_GiBs,
			sha256GiBs: row.sha256_GiBs
		})),
		pollTaxMedianRatio: median(numbers(pollPairs.map((row) => row.ratio))),
		pollTaxRatioRange: range(numbers(pollPairs.map((row) => row.ratio))),
		hashPagesBench: hashBench(bench)
	};
}

function phpPark(rows: Row[]) {
	const out: Record<string, unknown> = {};
	for (const arm of ['P1', 'P2']) {
		const events = of(rows, 'event').filter((row) => row.arm === arm);
		out[arm] = {
			events: events.length,
			parks: countBy(
				events.filter((row) => row.status === 'PARKED').map((row) => row.reason)
			),
			refusalsTotal: events.reduce((sum, row) => sum + (row.refusals ?? 0), 0),
			restoredFrom: events.filter((row) => row.restoredFrom !== undefined).length,
			cut: events.filter((row) => row.cut === true).length,
			stackOkAll: events.every((row) => row.stackOk === true)
		};
	}
	return out;
}

// P0 is the reference; P1 and P2 are equal when their output hash equals P0's
function phpOutput(rows: Row[]) {
	const reference = rows.find((row) => row.arm === 'P0')!;
	const out: Record<string, unknown> = {};
	for (const row of rows) {
		out[row.arm] =
			row.arm === 'P0'
				? { sha256: row.sha256, bytes: row.bytes, reference: true }
				: {
						sha256: row.sha256,
						bytes: row.bytes,
						outputEqual: row.sha256 === null ? null : row.sha256 === reference.sha256
					};
	}
	return out;
}

function phpPollCost(rows: Row[]) {
	const out: Record<string, unknown> = {};
	for (const workload of ['loop', 'fib', 'strarr']) {
		const mine = rows.filter((row) => row.workload === workload);
		const byBuild = (build: string) => mine.filter((row) => row.build === build);
		const perRound = (round: number, build: string) =>
			mine.find((row) => row.round === round && row.build === build)?.ms;
		const ratios = [...new Set(mine.map((row) => row.round))].map(
			(round) => perRound(round, 'I5')! / perRound(round, 'NOOP')!
		);
		out[workload] = {
			samples: mine.length,
			i5MedianMs: median(numbers(byBuild('I5').map((row) => row.ms))),
			noopMedianMs: median(numbers(byBuild('NOOP').map((row) => row.ms))),
			pairedRatioMedian: median(ratios),
			pairedRatioRange: range(ratios)
		};
	}
	return out;
}

// steps a slice ran: to the signal, or to the chain's target on the final slice
function stepsRun(row: Row, last: boolean, target: number) {
	if (row.sigStepsDb !== null) return row.sigStepsDb - row.stepsStart;
	return last ? target - row.stepsStart : null;
}

// tail-reader gaps: no cpu, or steps per cpu-second far from about 1,000 (F23)
function suspect(row: Row, ran: number | null) {
	if (row.cpuMs === null) return true;
	if (ran === null || ran < 5000) return false;
	const rate = ran / (row.cpuMs / 1000);
	return !(rate >= 500 && rate <= 2000);
}

function objectSlices(rows: Row[]) {
	const groups = new Map<string, Row[]>();
	for (const row of of(rows, 'slice')) {
		const key = `${row.arm}/${row.object}`;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	for (const list of groups.values()) list.sort((a, b) => a.k - b.k);
	return groups;
}

function chainTargets(rows: Row[]) {
	return Object.fromEntries(
		of(rows, 'chain').map((row) => [`${row.arm}/${row.object}`, row.steps])
	);
}

// exact one-sided 95% upper bound on a Poisson mean after k events (k = 0 gives -ln 0.05)
function poissonUpper95(k: number) {
	const cdf = (mu: number) => {
		let term = Math.exp(-mu);
		let sum = term;
		for (let i = 1; i <= k; i++) {
			term *= mu / i;
			sum += term;
		}
		return sum;
	};
	let lo = 0;
	let hi = k + 50;
	for (let it = 0; it < 200; it++) {
		const mid = (lo + hi) / 2;
		if (cdf(mid) > 0.05) lo = mid;
		else hi = mid;
	}
	return lo;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function deferredMoves(rows: Row[]) {
	const moves: Row[] = [];
	for (const list of objectSlices(rows).values()) {
		list.forEach((row, i) => {
			const previous = list[i - 1];
			if (!previous || row.isolate === previous.isolate) return;
			const followedSignal = previous.outcome === 'ok' && previous.sigStepsDb !== null;
			moves.push({
				arm: row.arm,
				object: row.object,
				k: row.k,
				followedSignal,
				reset: previous.outcome !== 'ok',
				lostStepsComputed: followedSignal ? previous.sigStepsDb - row.stepsStart : null,
				lostStepsRaw: row.lost
			});
		});
	}
	return moves;
}

// exposure is cpu on the isolate after each object's first isolate change; later moves are
// isolate changes after a clean slice (a reset is not a placement move)
function moveRate(rows: Row[]) {
	const targets = chainTargets(rows);
	const objects: Row[] = [];
	for (const [key, list] of objectSlices(rows)) {
		const target = targets[key];
		const first = list.findIndex((row, i) => i > 0 && row.isolate !== list[i - 1]!.isolate);
		if (first < 0) continue;
		let cpuS = 0;
		let skipped = 0;
		let later = 0;
		list.forEach((row, i) => {
			if (
				i > first &&
				row.isolate !== list[i - 1]!.isolate &&
				list[i - 1]!.outcome === 'ok'
			) {
				later++;
			}
			if (i < first) return;
			if (suspect(row, stepsRun(row, i === list.length - 1, target))) skipped++;
			else cpuS += row.cpuMs / 1000;
		});
		objects.push({
			arm: list[0]!.arm,
			object: list[0]!.object,
			firstMoveK: list[first]!.k,
			resetFirstMove: list[first - 1]!.outcome !== 'ok',
			cpuS: round3(cpuS),
			skippedSlices: skipped,
			laterMoves: later
		});
	}
	const exposure = objects.reduce((sum, object) => sum + object.cpuS, 0);
	const later = objects.reduce((sum, object) => sum + object.laterMoves, 0);
	const mu = poissonUpper95(later);
	return {
		inputs: 'deferred-chain slices only; isolate-life and boundary-commit rows carry no per-slice cpu',
		objects,
		exposureCpuS: round3(exposure),
		laterMoves: later,
		upperMu95: Number(mu.toPrecision(4)),
		upperRatePerCpuS: Number((mu / exposure).toPrecision(4)),
		mfLowerCpuS: Number((exposure / mu).toPrecision(4))
	};
}

// per-event cpu of signal-ended slices, clean by the suspect rule
function signalEventCpu(rows: Row[]) {
	const targets = chainTargets(rows);
	const values: number[] = [];
	for (const [key, list] of objectSlices(rows)) {
		list.forEach((row, i) => {
			const ran = stepsRun(row, i === list.length - 1, targets[key]);
			if (row.outcome === 'ok' && row.sigStepsDb !== null && !suspect(row, ran)) {
				values.push(row.cpuMs / 1000);
			}
		});
	}
	return {
		n: values.length,
		median: round3(median(values) ?? 0),
		range: range(values)?.map(round3) ?? null
	};
}

const SUMMARIES: Record<string, (rows: Row[]) => unknown> = {
	signal,
	'jspi-chain': jspiChain,
	'durable-chain': durableChain,
	'isolate-life': isolateLife,
	'boundary-commit': (rows) => boundaryCommit(rows, read('boundary-commit', 'raw-driver.jsonl')),
	'deferred-chain': deferredChain,
	'checkpoint-cost': (rows) =>
		checkpointCost(rows, read('checkpoint-cost', 'raw-hashpages.jsonl')),
	'php-park': (rows) => ({
		...(phpPark(rows) as object),
		output: phpOutput(read('php-park', 'raw-output.jsonl'))
	}),
	'php-poll-cost': phpPollCost
};

// two-space JSON with short arrays on one line, the form prettier keeps.
function formatJson(value: unknown) {
	const text = JSON.stringify(value, null, 2).replace(
		/\[\n\s*([^[\]{}]*?)\n\s*\]/g,
		(_match, body: string) =>
			`[${body
				.split(',\n')
				.map((item) => item.trim())
				.join(', ')}]`
	);
	return text + '\n';
}

// alarm handoff gap, recorded in the experiment notes, not in a raw file
const HANDOFF_MS = [51, 71];

// the event cost is derived from three studies, so it is computed after all summaries exist
function eventCost(deferred: Row, durable: Row) {
	const Te = deferred.signalEventCpuS.median;
	const L = Te;
	const Ck = durable.checkpointCostMsByDirtyMiB['16'] / 1000;
	const Mf = deferred.moveRate.mfLowerCpuS;
	const aimdRatio = 0.7;
	const aimdGrowth = 1.02;
	const cyclesFull = Math.log(1 / aimdRatio) / Math.log(aimdGrowth);
	const pct = (x: number) => Number((x * 100).toFixed(3));
	const commit = (h: number) => (Ck + h / 1000) / Te;
	const aimd = (cycles: number, h: number) => commit(h) + L / (Mf * cycles);
	const deferredOnly = (h: number) => commit(h) + L / Mf;
	const spread = (f: (h: number) => number) => HANDOFF_MS.map((h) => pct(f(h)));
	return {
		inputs: {
			signalEventCpuS: Te,
			checkpointS16MiB: Ck,
			handoffMs: HANDOFF_MS,
			handoffSource: 'recorded in the experiment notes, not in a raw file',
			lossTerm:
				'S / M_f, with S = signalEventCpuS: a move after a deferred event loses the whole slice',
			mfLowerCpuS: Mf,
			aimdRatio,
			aimdGrowth,
			aimdCyclesFull: Number(cyclesFull.toFixed(2)),
			aimdCyclesText: [13, 18]
		},
		commitPctAtHandoff: spread(commit),
		aimdPctAtHandoff: {
			cycles13: spread((h) => aimd(13, h)),
			cyclesFull: spread((h) => aimd(cyclesFull, h))
		},
		deferredOnlyPctAtHandoff: spread(deferredOnly),
		lossPct: {
			aimdCycles13: pct(L / (Mf * 13)),
			aimdCyclesFull: pct(L / (Mf * cyclesFull)),
			deferredOnly: pct(L / Mf)
		}
	};
}

if (import.meta.main) {
	const summaries = new Map<string, Row>();
	for (const study of STUDIES) {
		const rows = read(study);
		summaries.set(study, {
			schema: 'folio.continuation.summary.v1',
			study,
			rows: rows.length,
			...(SUMMARIES[study]!(rows) as object)
		});
	}
	summaries.get('checkpoint-cost')!.eventCost = eventCost(
		summaries.get('deferred-chain')!,
		summaries.get('durable-chain')!
	);
	for (const study of STUDIES) {
		const directory = join(root, study);
		writeFileSync(join(directory, 'summary.json'), formatJson(summaries.get(study)));
		console.log(JSON.stringify({ study, artifacts: writeManifest(directory) }));
	}
}
