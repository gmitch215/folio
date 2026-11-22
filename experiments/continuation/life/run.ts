import { readFile, writeFile } from 'node:fs/promises';
import { createApi, credentials, snapshot, type Api } from '../../lib/cloudflare.ts';

// node run.ts <arm> | analyze | snap-before | snap-after; deployed calls need the account variables (see README)
const arm = process.argv[2] ?? '';
const runs = new URL('./runs/', import.meta.url);
const worker = 'folio-continuation-life';
const BLOCKS_PER_SECOND = 800;
const TARGET = 60 * BLOCKS_PER_SECOND;
const OBJECTS = 5;
const POLL_MS = 30_000;
const TIMEOUT_MS = 20 * 60_000;
const BIN_EDGES = [1, 3, 6, 10, 20, 60];
const BIN_LABELS = [
	'under 1 s',
	'1 to 3 s',
	'3 to 6 s',
	'6 to 10 s',
	'10 to 20 s',
	'20 to 60 s',
	'60 s or more'
];
const ARM_ORDER = ['s01', 's1', 's5', 'g'];

const arms: Record<string, { seconds: number; pauseAfter: number; pauseMs: number }> = {
	s01: { seconds: 0.1, pauseAfter: 0, pauseMs: 0 },
	s1: { seconds: 1, pauseAfter: 0, pauseMs: 0 },
	s5: { seconds: 5, pauseAfter: 0, pauseMs: 0 },
	g: { seconds: 1, pauseAfter: 3 * BLOCKS_PER_SECOND, pauseMs: 10_000 }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid8 = () => crypto.randomUUID().slice(0, 8);
const save = (file: string, value: unknown) =>
	writeFile(new URL(file, runs), `${JSON.stringify(value, null, 2)}\n`);
const load = async (file: string): Promise<any> =>
	JSON.parse(await readFile(new URL(file, runs), 'utf8'));
const parseOrNull = (text: string): any => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const range = (values: number[]) =>
	values.length ? [Math.min(...values), Math.max(...values)] : null;
const count = (values: string[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const value of values) out[value] = (out[value] ?? 0) + 1;
	return out;
};
const binIndex = (seconds: number) => {
	const index = BIN_EDGES.findIndex((edge) => seconds < edge);
	return index === -1 ? BIN_EDGES.length : index;
};

// wrangler tail --format json prints pretty-printed objects back to back, not one per line
function splitObjects(text: string): any[] {
	const out: any[] = [];
	let depth = 0;
	let inString = false;
	let start = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) out.push(parseOrNull(text.slice(start, i + 1)));
		}
	}
	return out;
}

let base = '';

async function connect(): Promise<Api> {
	const client = createApi(credentials());
	if (!base) {
		const subdomain = (await client('/workers/subdomain')).subdomain;
		base = `https://${worker}.${subdomain}.workers.dev`;
	}
	return client;
}

async function call(object: string, route: string, query = ''): Promise<any> {
	const response = await fetch(`${base}/obj/${object}/${route}${query}`, {
		signal: AbortSignal.timeout(60_000)
	});
	const text = await response.text();
	if (!response.ok)
		throw new Error(`${object} ${route} ${response.status}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

async function runArm(name: string) {
	const config = arms[name];
	if (!config) throw new Error(`unknown arm: ${name}`);
	await connect();
	const tag = uuid8();
	const objects = Array.from({ length: OBJECTS }, (_, i) => `e3-${name}-${i}-${tag}`);
	const slice = Math.round(config.seconds * BLOCKS_PER_SECOND);
	const query = `?target=${TARGET}&slice=${slice}&pauseAfter=${config.pauseAfter}&pauseMs=${config.pauseMs}`;
	const startedAt = Date.now();
	await Promise.all(objects.map((object) => call(object, 'start', query)));

	const polls: unknown[] = [];
	let status: any[] = [];
	let timedOut = false;
	for (;;) {
		await sleep(POLL_MS);
		status = await Promise.all(objects.map((object) => call(object, 'status')));
		polls.push({
			t: Date.now() - startedAt,
			objects: status.map((s) => ({
				doId: s.doId,
				isolate: s.isolate,
				isolateBlocks: s.isolateBlocks,
				isolateEvents: s.isolateEvents,
				blocks: s.chain?.blocks ?? null,
				slices: s.chain?.slices ?? null,
				done: s.chain?.done ?? null
			}))
		});
		await save(`${name}-polls.json`, polls);
		if (status.every((s) => s.chain?.done === 1)) break;
		if (Date.now() - startedAt > TIMEOUT_MS) {
			timedOut = true;
			break;
		}
	}

	const result = {
		arm: name,
		tag,
		config,
		slice,
		target: TARGET,
		startedAt,
		endedAt: Date.now(),
		timedOut,
		objects: await Promise.all(
			objects.map(async (object, i) => ({
				object,
				doId: status[i].doId,
				rows: await call(object, 'slices')
			}))
		)
	};
	await save(`${name}.json`, result);
	const slices = result.objects.reduce((n, o) => n + o.rows.length, 0);
	console.log(
		JSON.stringify({
			arm: name,
			slices,
			rowsUpperBound: OBJECTS + 2 * slices,
			timedOut,
			seconds: Math.round((result.endedAt - startedAt) / 1000),
			done: status.map((s) => s.chain?.done)
		})
	);
}

async function snap(file: string) {
	const client = await connect();
	const shot = await snapshot(client);
	await save(file, shot);
	console.log(
		JSON.stringify({
			file,
			scripts: shot.scripts.length,
			namespaces: shot.namespaces.length,
			probeScriptPresent: shot.scripts.includes(worker)
		})
	);
}

// the tail is a sample (wrangler tail drops events under load); the slice rows in each DO are complete
function sliceLogs(record: any): any[] {
	const out: any[] = [];
	for (const entry of record.logs ?? []) {
		const messages = Array.isArray(entry.message) ? entry.message : [entry.message];
		for (const message of messages) {
			const parsed = parseOrNull(String(message));
			if (parsed?.tag === 'slice') out.push(parsed);
		}
	}
	return out;
}

function classify(outcome: string, exceptions: any[] | undefined): string {
	if (outcome === 'exceededMemory') return 'memory';
	if (outcome === 'exceededCpu') return 'CPU';
	if (outcome === 'exceededWallTime' || /storage/i.test(JSON.stringify(exceptions ?? [])))
		return 'storage';
	return 'other';
}

async function analyze() {
	const tail = splitObjects(await readFile(new URL('tail.jsonl', runs), 'utf8')).filter(Boolean);
	const doEvents = tail.filter((r) => r.durableObjectId && r.scriptName === worker);
	const byKey = new Map<string, { record: any; log: any }>();
	const untagged: any[] = [];
	for (const record of doEvents) {
		const logs = sliceLogs(record);
		if (!logs.length) untagged.push(record);
		for (const log of logs) byKey.set(`${log.isolate}:${log.isolateEvents}`, { record, log });
	}
	const claimed = new Set<any>();
	const allRows: any[] = [];
	const allChanges: any[] = [];
	const perArm: Record<string, unknown> = {};
	const sampleNote = {
		doEventsInTail: doEvents.length,
		entryEventsInTail: tail.length - doEvents.length
	};

	for (const name of ARM_ORDER) {
		let result: any;
		try {
			result = await load(`${name}.json`);
		} catch {
			continue;
		}
		const slice: number = result.slice;
		const rows: any[] = [];
		const changes: any[] = [];
		for (const object of result.objects) {
			const sorted = [...object.rows].sort((a: any, b: any) => a.k - b.k);
			let previous: any;
			for (let i = 0; i < sorted.length; i++) {
				const raw = sorted[i];
				const next = sorted[i + 1];
				// a slice completed when the next slice starts from more progress; the last one completed when the arm did not time out
				const completed = next
					? next.object_blocks_before > raw.object_blocks_before
					: !result.timedOut;
				let found = byKey.get(`${raw.isolate}:${raw.isolate_events}`) ?? null;
				let source = found ? 'log' : 'none';
				if (!found && !completed) {
					const near = untagged
						.filter(
							(r) =>
								!claimed.has(r) &&
								r.durableObjectId === object.doId &&
								Math.abs(r.eventTimestamp - raw.start_ms) < 5000
						)
						.sort(
							(a, b) =>
								Math.abs(a.eventTimestamp - raw.start_ms) -
								Math.abs(b.eventTimestamp - raw.start_ms)
						)[0];
					if (near) {
						claimed.add(near);
						found = { record: near, log: null };
						source = 'tail only';
					}
				}
				const record = found?.record;
				const log = found?.log;
				const outcome: string | null = record?.outcome ?? null;
				const row = {
					arm: name,
					object: object.object,
					k: raw.k,
					isolate: raw.isolate,
					isolateEvents: raw.isolate_events,
					isolateBefore: raw.isolate_blocks_before,
					objectBefore: raw.object_blocks_before,
					startMs: raw.start_ms,
					completed,
					cumAfter: raw.isolate_blocks_before + (completed ? slice : 0),
					logCheck: log
						? log.isolateBlocksAfter === raw.isolate_blocks_before + log.burned
						: null,
					source,
					outcome,
					class: completed
						? 'ok'
						: outcome
							? classify(outcome, record?.exceptions)
							: 'not sampled',
					tailAgrees: outcome === null ? null : (outcome === 'ok') === completed,
					cpuMs: record?.cpuTime ?? null,
					wallMs: record?.wallTime ?? null,
					eventTimestamp: record?.eventTimestamp ?? null,
					burned: log?.burned ?? null,
					periodMs: previous ? raw.start_ms - previous.startMs : null,
					changedIn: false
				};
				if (previous && previous.isolate !== row.isolate) {
					row.changedIn = true;
					changes.push({
						arm: name,
						object: object.object,
						from: previous.isolate,
						cumBlocks: previous.cumAfter,
						fromCompleted: previous.completed,
						fromClass: previous.class,
						periodMs: row.periodMs
					});
				}
				rows.push(row);
				previous = row;
			}
		}

		const isolates = new Map<
			string,
			{ slices: number; cumBlocks: number; cpuMs: number; ended: boolean }
		>();
		for (const row of rows) {
			const entry = isolates.get(row.isolate) ?? {
				slices: 0,
				cumBlocks: 0,
				cpuMs: 0,
				ended: false
			};
			entry.slices++;
			entry.cumBlocks = Math.max(entry.cumBlocks, row.cumAfter);
			entry.cpuMs += row.cpuMs ?? 0;
			isolates.set(row.isolate, entry);
		}
		for (const change of changes) isolates.get(change.from)!.ended = true;
		const ended = [...isolates.values()].filter((e) => e.ended);
		const rowCpu = rows.filter((r) => r.completed && r.burned > 0 && r.cpuMs != null);
		const bins = BIN_LABELS.map((label, i) => ({
			bin: label,
			slicesStarted: rows.filter((r) => binIndex(r.isolateBefore / BLOCKS_PER_SECOND) === i)
				.length,
			changes: changes.filter((c) => binIndex(c.cumBlocks / BLOCKS_PER_SECOND) === i).length,
			silent: changes.filter(
				(c) => binIndex(c.cumBlocks / BLOCKS_PER_SECOND) === i && c.fromCompleted
			).length,
			reset: changes.filter(
				(c) => binIndex(c.cumBlocks / BLOCKS_PER_SECOND) === i && !c.fromCompleted
			).length
		}));
		perArm[name] = {
			objects: result.objects.length,
			timedOut: result.timedOut,
			slices: rows.length,
			completed: rows.filter((r) => r.completed).length,
			notCompleted: rows.filter((r) => !r.completed).length,
			tailSampled: rows.filter((r) => r.source !== 'none').length,
			notCompletedClasses: count(rows.filter((r) => !r.completed).map((r) => r.class)),
			tailDisagreesWithRows: rows.filter((r) => r.tailAgrees === false).length,
			logCheckFailures: rows.filter((r) => r.logCheck === false).length,
			isolates: isolates.size,
			changes: changes.length,
			silentChanges: changes.filter((c) => c.fromCompleted).length,
			resetChanges: changes.filter((c) => !c.fromCompleted).length,
			resetChangeClasses: count(
				changes.filter((c) => !c.fromCompleted).map((c) => c.fromClass)
			),
			bins,
			calibrationCpuPerExpected: median(
				rowCpu.map((r) => r.cpuMs / ((r.burned * 1000) / BLOCKS_PER_SECOND))
			),
			calibrationSampled: rowCpu.length,
			periodMsMedian: median(
				rows.filter((r) => r.periodMs != null && !r.changedIn).map((r) => r.periodMs)
			),
			periodMsAtChange: changes.map((c) => c.periodMs),
			endedIsolates: ended.length,
			endedIsolateSlices: range(ended.map((e) => e.slices)),
			endedIsolateSlicesMedian: median(ended.map((e) => e.slices)),
			endedIsolateCpuSecMedian: median(ended.map((e) => e.cumBlocks / BLOCKS_PER_SECOND)),
			endedIsolateCpuSecRange: range(ended.map((e) => e.cumBlocks / BLOCKS_PER_SECOND)),
			endedIsolateTailCpuSecMedian: median(ended.map((e) => e.cpuMs / 1000))
		};
		allRows.push(...rows);
		allChanges.push(...changes);
	}

	const totalBins = BIN_LABELS.map((label, i) => ({
		bin: label,
		slicesStarted: allRows.filter((r) => binIndex(r.isolateBefore / BLOCKS_PER_SECOND) === i)
			.length,
		changes: allChanges.filter((c) => binIndex(c.cumBlocks / BLOCKS_PER_SECOND) === i).length,
		silent: allChanges.filter(
			(c) => binIndex(c.cumBlocks / BLOCKS_PER_SECOND) === i && c.fromCompleted
		).length,
		reset: allChanges.filter(
			(c) => binIndex(c.cumBlocks / BLOCKS_PER_SECOND) === i && !c.fromCompleted
		).length
	}));
	const report = {
		...sampleNote,
		untaggedUnmatched: untagged.filter((r) => !claimed.has(r)).length,
		totalSlices: allRows.length,
		totalChanges: allChanges.length,
		totalBins,
		perArm
	};
	await save('analysis.json', { ...report, changes: allChanges, rows: allRows });
	console.log(JSON.stringify(report, null, 2));
}

if (arm in arms) await runArm(arm);
else if (arm === 'analyze') await analyze();
else if (arm === 'snap-before') await snap('snapshot-before.json');
else if (arm === 'snap-after') await snap('snapshot-after.json');
else throw new Error(`unknown arm: ${arm}`);
