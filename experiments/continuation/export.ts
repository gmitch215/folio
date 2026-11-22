import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Writes results/continuation/<study>/raw.jsonl from the ignored runs/ directories. Ids, paths,
// bodies and notes are dropped; objects and isolates become ordinals in order of first appearance.
// usage: node export.ts [php-poll-cost-directory]   (the directory holds loop.tsv, fib.tsv, strarr.tsv)

type Row = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
// CONTINUATION_RESULTS redirects the output, so a rerun can be diffed against the committed copies.
const results = process.env.CONTINUATION_RESULTS ?? join(repo, 'results', 'continuation');
const runs = (arm: string, file: string) => join(here, arm, 'runs', file);
const php = (file: string) => join(repo, 'experiments', 'continuation-php', 'runs', file);
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const DENY = new Set([
	'isolate',
	'rid',
	'path',
	'doId',
	'object',
	'state',
	'ordinal',
	'tail',
	'notes',
	'markers',
	'logs',
	'startMs',
	'endMs',
	'eventTimestamp',
	'startedAt',
	'endedAt'
]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}/;

function scalars(source: unknown): Row {
	const row: Row = {};
	if (!source || typeof source !== 'object') return row;
	for (const [key, value] of Object.entries(source)) {
		if (DENY.has(key)) continue;
		if (typeof value === 'number' || typeof value === 'boolean') row[key] = value;
		else if (typeof value === 'string' && value.length <= 24 && !UUID.test(value))
			row[key] = value;
	}
	return row;
}

function tailRow(tail: any): Row {
	return {
		outcome: tail?.outcome ?? null,
		cpuMs: tail?.cpuTime ?? null,
		wallMs: tail?.wallTime ?? null
	};
}

// ordinal of an id in order of first appearance; the map is per arm
function ordinal(map: Map<string, number>, id: string): number {
	if (!map.has(id)) map.set(id, map.size);
	return map.get(id)!;
}

function write(study: string, rows: Row[], file = 'raw.jsonl') {
	const directory = join(results, study);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, file), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
	return rows.length;
}

function signal(): Row[] {
	const rows: Row[] = [];
	const map1 = new Map<string, number>();
	for (const c of load(runs('signal', 'a1.json')).calls) {
		const object = ordinal(map1, c.object);
		rows.push({
			study: 'signal',
			kind: 'calibration',
			object,
			blocks: c.blocks,
			status: c.status,
			...tailRow(c.tail),
			blocksDone: c.body?.blocksDone ?? null
		});
	}
	const map2 = new Map<string, number>();
	for (const c of load(runs('signal', 'a2.json')).calls) {
		const object = ordinal(map2, c.object);
		rows.push({
			study: 'signal',
			kind: 'signal',
			object,
			event: c.event,
			blocks: c.blocks,
			status: c.status,
			...tailRow(c.tail),
			blocksDone: c.body?.blocksDone ?? null,
			before1024: c.body?.before1024 ?? null,
			after1024: c.body?.after1024 ?? null
		});
	}
	rows.push({
		study: 'signal',
		kind: 'prose',
		arm: 'a3',
		source: 'results text',
		note: 'terminated word read 0 on 3 of 3; invalid as designed'
	});
	const a4 = load(runs('signal', 'a4.json'));
	a4.chains.forEach((chain: any, object: number) => {
		rows.push({
			study: 'signal',
			kind: 'sync-chain',
			object,
			finished: chain.finished,
			error: chain.error ?? null,
			finalMatch: chain.finalMatch,
			slices: chain.slices,
			isolateChanges: chain.isolateChanges,
			exceeded: chain.exceeded
		});
		for (const s of chain.slicesDetail)
			rows.push({
				study: 'signal',
				kind: 'sync-slice',
				object,
				k: s.k,
				blocks: s.blocks,
				before1024: s.before1024,
				cpuMs: s.cpuMs,
				outcome: s.outcome
			});
	});
	return rows;
}

function jspiChain(): Row[] {
	const rows: Row[] = [];
	rows.push({
		study: 'jspi-chain',
		kind: 'prose',
		arm: 'a0',
		every: 50,
		blocks: 2000,
		slices: 40,
		passed: true,
		source: 'results text',
		note: 'local workerd, final state equal to the reference'
	});
	const a5 = load(runs('signal', 'a5.json'));
	a5.chains.forEach((chain: any, object: number) => {
		rows.push({
			study: 'jspi-chain',
			kind: 'chain',
			object,
			mode: chain.mode,
			every: chain.every,
			target: chain.target,
			finished: chain.finished,
			error: chain.error ?? null,
			finalMatch: chain.finalMatch,
			slices: chain.slices,
			isolateChanges: chain.isolateChanges,
			exceeded: chain.exceeded
		});
		for (const s of chain.slicesDetail)
			rows.push({
				study: 'jspi-chain',
				kind: 'slice',
				object,
				k: s.k,
				blocks: s.blocks,
				before1024: s.before1024,
				cpuMs: s.cpuMs,
				outcome: s.outcome
			});
	});
	return rows;
}

function durableChain(): Row[] {
	const rows: Row[] = [];
	rows.push({
		study: 'durable-chain',
		kind: 'prose',
		arm: 'd0',
		slices: 30,
		restores: 3,
		passed: true,
		source: 'results text',
		note: 'local workerd, no signal'
	});
	const map = new Map<string, number>();
	for (const c of load(runs('durable', 'd1.json')).calls) {
		const object = ordinal(map, c.object);
		rows.push({
			study: 'durable-chain',
			kind: c.event === 1 ? 'init' : 'burn',
			arm: 'd1',
			object,
			event: c.event,
			status: c.status,
			...scalars(c.body),
			...tailRow(c.tail)
		});
	}
	const map2 = new Map<string, number>();
	for (const c of load(runs('durable', 'd2.json')).calls) {
		const object = ordinal(map2, c.object);
		rows.push({
			study: 'durable-chain',
			kind: 'd2-call',
			arm: 'd2',
			object,
			event: c.event,
			status: c.status,
			...scalars(c.body),
			...tailRow(c.tail)
		});
	}
	rows.push({
		study: 'durable-chain',
		kind: 'prose',
		arm: 'd3',
		chains: 3,
		finished: 0,
		slicesKilled: 21,
		source: 'results text',
		note: 'tail records only; no d3.json was written'
	});
	for (const p of load(runs('durable', 'd5.json')).perObject) {
		rows.push({
			study: 'durable-chain',
			kind: 'checkpoint-cost',
			arm: 'd5',
			dirtyMiB: p.dirty,
			baseCpuMs: p.baseCpuMs,
			ckCpuMs: p.ckCpuMs,
			controlCpuMs: p.controlCpuMs,
			cK: p.C_k,
			rows: p.rows,
			checkpoints: p.checkpointsCk,
			okEvents: p.outcomes.filter((o: string) => o === 'ok').length
		});
	}
	return rows;
}

function isolateLife(): Row[] {
	const rows: Row[] = [];
	for (const arm of ['s01', 's1', 's5', 'g']) {
		const data = load(runs('life', `${arm}.json`));
		data.objects.forEach((object: any, index: number) => {
			const isolates = new Map<string, number>();
			const first = object.rows[0]?.start_ms ?? 0;
			rows.push({
				study: 'isolate-life',
				kind: 'object',
				arm,
				object: index,
				slices: object.rows.length,
				done: object.done ?? null,
				timedOut: data.timedOut
			});
			for (const r of object.rows) {
				rows.push({
					study: 'isolate-life',
					kind: 'slice',
					arm,
					object: index,
					k: r.k,
					isolate: ordinal(isolates, r.isolate),
					isolateEvents: r.isolate_events,
					isolateBlocksBefore: r.isolate_blocks_before,
					objectBlocksBefore: r.object_blocks_before,
					startMs: r.start_ms - first
				});
			}
		});
	}
	return rows;
}

function boundaryCommit(): Row[] {
	const rows: Row[] = [];
	const addEvents = (
		arm: string,
		events: any[],
		object: number,
		isolates: Map<string, number>
	) => {
		for (const e of events)
			rows.push({
				study: 'boundary-commit',
				kind: 'event',
				arm,
				object,
				k: e.k,
				isolate: ordinal(isolates, e.isolate),
				restored: e.restored,
				start: e.start,
				budget: e.budget,
				stop: e.stop,
				endSource: e.endSource ?? null,
				end: e.end,
				budgetAfter: e.budgetAfter,
				rows: e.rows
			});
	};
	const g0 = load(runs('deferred', 'g0-bc.json'));
	addEvents('g0', g0.events, 0, new Map());
	const traces = load(runs('deferred', 'g1-bc-retrace.json')).traces;
	const objects = new Map<string, number>();
	for (const [id, trace] of Object.entries<any>(traces))
		addEvents('g1', trace.events, ordinal(objects, id), new Map());
	return rows;
}

function deferredChain(): Row[] {
	const rows: Row[] = [];
	for (const arm of ['f0', 'f1', 'f2', 'f3', 'f4']) {
		const data = load(runs('deferred', `${arm}.json`));
		const objects = new Map<string, number>();
		for (const [id, chain] of Object.entries<any>(data.chains)) {
			const object = ordinal(objects, id);
			rows.push({
				study: 'deferred-chain',
				kind: 'chain',
				arm,
				object,
				finished: chain.finished,
				steps: chain.steps,
				finalMatch: chain.finalMatch,
				shaMatch: chain.shaMatch,
				restores: chain.restores,
				isolates: chain.isolates.length,
				signalWrites: chain.signalWrites
			});
			const isolates = new Map<string, number>();
			for (const s of chain.slices) {
				rows.push({
					study: 'deferred-chain',
					kind: 'slice',
					arm,
					object,
					k: s.k,
					isolate: ordinal(isolates, s.isolate ?? ''),
					restored: s.restored,
					lost: s.lost,
					unsavedSeen: s.unsavedSeen,
					stepsStart: s.stepsStart,
					sigStepsDb: s.sigStepsDb,
					ranAtSignal: s.ranAtSignal,
					outcome: s.outcome,
					cpuMs: s.cpuMs,
					checkpointRows: s.checkpointRows,
					bookkeepingRows: s.bookkeepingRows,
					checkpoints: s.checkpointWhy?.length ?? 0
				});
			}
		}
		if (arm === 'f4') {
			const moves = load(runs('deferred', 'f4-moves.json')).moves;
			const objects4 = new Set<string>(Object.keys(data.chains));
			for (const m of moves)
				rows.push({
					study: 'deferred-chain',
					kind: 'move',
					arm,
					object: [...objects4].indexOf(m.object),
					k: m.k,
					restored: m.restored,
					lost: m.lost
				});
		}
	}
	return rows;
}

function checkpointCost(): Row[] {
	const rows: Row[] = [];
	for (const run of [1, 2, 3, 4]) {
		const data = load(runs('local', `results-l1-run${run}.json`)).runs[`run${run}`];
		if (run === 4) {
			rows.push({
				study: 'checkpoint-cost',
				kind: 'poll-tax',
				arm: 'run4',
				...scalars(data)
			});
			data.polled_ms.forEach((polled: number, pair: number) =>
				rows.push({
					study: 'checkpoint-cost',
					kind: 'poll-pair',
					arm: 'run4',
					pair,
					polledMs: polled,
					plainMs: data.plain_ms[pair],
					ratio: data.ratios[pair]
				})
			);
			continue;
		}
		rows.push({
			study: 'checkpoint-cost',
			kind: 'summary',
			arm: `run${run}`,
			...scalars(data)
		});
		if (data.exact)
			rows.push({
				study: 'checkpoint-cost',
				kind: 'exact',
				arm: `run${run}`,
				...scalars(data.exact)
			});
		for (const [kind, value] of Object.entries<any>(data)) {
			if (!Array.isArray(value) || typeof value[0] !== 'object') continue;
			for (const element of value)
				rows.push({
					study: 'checkpoint-cost',
					kind,
					arm: `run${run}`,
					...scalars(element)
				});
		}
	}
	const run3 = load(runs('local', 'results-l1-run3.json')).runs;
	for (const entry of run3.run3)
		rows.push({ study: 'checkpoint-cost', arm: 'run3', ...scalars(entry) });
	rows.push({
		study: 'checkpoint-cost',
		kind: 'summary',
		arm: 'run3',
		run3WallS: run3.run3_wall_s
	});
	return rows;
}

function phpPark(): Row[] {
	const rows: Row[] = [];
	for (const arm of ['P1', 'P2']) {
		for (const e of load(php(`${arm}-events.json`)))
			rows.push({
				study: 'php-park',
				kind: 'event',
				arm,
				...scalars(e),
				markers: e.markers?.length ?? 0
			});
		rows.push({ study: 'php-park', kind: 'run', arm, ...scalars(load(php(`${arm}.json`))) });
	}
	rows.push({ study: 'php-park', kind: 'run', arm: 'P0', ...scalars(load(php('P0.json'))) });
	return rows;
}

// P0's output is the file; P1 and P2 carry their hash in the run record (P1 names it finalSha256).
// Byte lengths are recorded for P0 only.
function phpOutput(): Row[] {
	const reference = readFileSync(php('P0-output.txt'));
	const p1 = load(php('P1.json'));
	const p2 = load(php('P2.json'));
	return [
		{
			study: 'php-park',
			kind: 'output',
			arm: 'P0',
			sha256: createHash('sha256').update(reference).digest('hex'),
			bytes: reference.length,
			source: 'P0-output.txt'
		},
		{
			study: 'php-park',
			kind: 'output',
			arm: 'P1',
			sha256: p1.finalSha256 ?? null,
			bytes: null,
			source: p1.finalSha256 ? 'P1.json finalSha256' : 'not recorded',
			note: 'byte length not recorded'
		},
		{
			study: 'php-park',
			kind: 'output',
			arm: 'P2',
			sha256: p2.outputSha256 ?? null,
			bytes: null,
			source: p2.outputSha256 ? 'P2.json outputSha256' : 'not recorded',
			note: 'byte length not recorded'
		}
	];
}

function phpPollCost(directory: string): Row[] {
	const rows: Row[] = [];
	for (const workload of ['loop', 'fib', 'strarr']) {
		const [header, ...lines] = readFileSync(join(directory, `${workload}.tsv`), 'utf8')
			.trim()
			.split('\n');
		const names = header!.split('\t');
		for (const line of lines) {
			const cells = line.split('\t');
			const row: Row = { study: 'php-poll-cost' };
			names.forEach((name, i) => {
				const value = cells[i] ?? '';
				row[name] =
					value !== '' && !Number.isNaN(Number(value)) && !/[a-z]/i.test(value)
						? Number(value)
						: value;
			});
			rows.push(row);
		}
	}
	return rows;
}

// the driver's final value and memory SHA-256 for each object, against the reference run
function boundaryCommitDriver(): Row[] {
	const rows: Row[] = [];
	const reference = load(runs('deferred', 'reference.json'));
	const objectFinal = (arm: string, object: number, chain: any, referenceKey: string): Row => ({
		study: 'boundary-commit',
		kind: 'object-final',
		arm,
		object,
		finished: chain.finished,
		steps: chain.steps,
		finalMatch: chain.finalMatch,
		shaMatch: chain.shaMatch,
		referenceSteps: Number(referenceKey),
		referenceFinal: reference[referenceKey].final,
		referenceSha: reference[referenceKey].sha
	});
	const g0 = load(runs('deferred', 'g0.json'));
	const g0Objects = new Map<string, number>();
	for (const [id, chain] of Object.entries<any>(g0.chains))
		rows.push(objectFinal('g0', ordinal(g0Objects, id), chain, '30000'));
	const g1 = load(runs('deferred', 'g1.json'));
	const g1Objects = new Map<string, number>();
	for (const id of Object.keys(load(runs('deferred', 'g1-bc-retrace.json')).traces))
		ordinal(g1Objects, id);
	for (const [id, chain] of Object.entries<any>(g1.chains)) {
		if (!g1Objects.has(id)) throw new Error(`g1 chain ${id} has no trace`);
		rows.push(objectFinal('g1', g1Objects.get(id)!, chain, '120000'));
	}
	return rows;
}

// the I9 hashPages samples, recorded once; scripts/probe/hashpages-bench.ts writes the same rows
function hashBench(): Row[] {
	return load(runs('local', 'hashpages-i9.json')).rows.map((row: Row) => ({
		study: 'checkpoint-cost',
		kind: 'hash-bench',
		...row
	}));
}

if (import.meta.main) {
	const counts: Record<string, number> = {
		signal: write('signal', signal()),
		'jspi-chain': write('jspi-chain', jspiChain()),
		'durable-chain': write('durable-chain', durableChain()),
		'isolate-life': write('isolate-life', isolateLife()),
		'boundary-commit': write('boundary-commit', boundaryCommit()),
		'boundary-commit/raw-driver': write(
			'boundary-commit',
			boundaryCommitDriver(),
			'raw-driver.jsonl'
		),
		'deferred-chain': write('deferred-chain', deferredChain()),
		'checkpoint-cost': write('checkpoint-cost', checkpointCost()),
		'checkpoint-cost/raw-hashpages': write(
			'checkpoint-cost',
			hashBench(),
			'raw-hashpages.jsonl'
		),
		'php-park': write('php-park', phpPark()),
		'php-park/raw-output': write('php-park', phpOutput(), 'raw-output.jsonl')
	};
	const pollDirectory = process.argv[2];
	if (pollDirectory) counts['php-poll-cost'] = write('php-poll-cost', phpPollCost(pollDirectory));
	console.log(JSON.stringify(counts));
}
