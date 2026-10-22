import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { invocations, parseTail } from '../consumer/php/analyze.ts';
import {
	boundaryName,
	boundaryObjects,
	memoryConfigs,
	meterName,
	meterObjects,
	meterRequests,
	moduleOf,
	type MemoryConfig,
	type Variant
} from './plan.ts';

type Row = Record<string, any>;

/** Upload size and the startup time Wrangler prints after the upload response. */
export function parseDeployLog(text: string) {
	const upload = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(text);
	const startup = /Worker Startup Time: (\d+) ms/.exec(text);
	return {
		uploadKiB: upload ? Number(upload[1]) : null,
		gzipKiB: upload ? Number(upload[2]) : null,
		startupMs: startup ? Number(startup[1]) : null,
		uploaded: /Uploaded cfw-folio-/.test(text),
		refusal: /ERROR|\[ERROR\]|\bX \[/.test(text)
			? text
					.replace(/\u001b\[[0-9;]*m/g, '')
					.split('\n')
					.filter((line) => /error|refus|limit|exceed|too large/i.test(line))
					.slice(0, 6)
					.map((line) => line.trim().slice(0, 300))
			: undefined
	};
}

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function range(values: number[]) {
	return values.length
		? {
				n: values.length,
				median: median(values)!,
				min: Math.min(...values),
				max: Math.max(...values)
			}
		: { n: 0 };
}

const parse = (body: unknown): Row => {
	try {
		return JSON.parse(String(body));
	} catch {
		return { raw: String(body ?? '').slice(0, 200) };
	}
};

export interface Input {
	variant: Variant;
	steps: Row[];
	tail: string;
	expected: Record<string, { checksum: number; memoryBytes: number }>;
}

/** One row per step joined to its Durable Object invocation, then ranges per group. */
export function summarizeSteps({ variant, steps, tail, expected }: Input) {
	const calls = invocations(parseTail(tail));
	const want = expected[moduleOf[variant]]!;
	const rows = steps.map((step) => {
		const body = parse(step.body);
		const durable = calls.find(
			(call) => call.entrypoint !== 'worker' && call.path === step.path
		);
		return {
			label: step.label as string,
			group: step.group as string,
			path: step.path as string,
			status: step.status as number | undefined,
			wallMs: step.wallMs as number | undefined,
			cpuMs: durable?.cpuMs,
			outcome: durable?.outcome,
			error: (durable?.error ?? body.error ?? step.error)?.toString().slice(0, 200) as
				string | undefined,
			memoryBytes: body.memoryBytes as number | undefined,
			checksum: body.checksum as number | undefined,
			checksumMatches:
				body.checksum === undefined ? undefined : body.checksum === want.checksum,
			memoryMatches:
				body.memoryBytes === undefined ? undefined : body.memoryBytes === want.memoryBytes,
			moduleTag: body.moduleTag as string | undefined,
			moduleCalls: body.moduleCalls as number | undefined,
			objectCalls: body.objectCalls as number | undefined
		};
	});
	const groups = [...new Set(rows.map((row) => row.group))];
	const count = (values: unknown[]) => {
		const tally: Record<string, number> = {};
		for (const value of values) tally[String(value)] = (tally[String(value)] ?? 0) + 1;
		return tally;
	};
	return {
		rows,
		groups: Object.fromEntries(
			groups.map((group) => {
				const members = rows.filter((row) => row.group === group);
				return [
					group,
					{
						cpuMs: range(
							members.flatMap((row) => (row.cpuMs === undefined ? [] : [row.cpuMs]))
						),
						outcomes: count(members.map((row) => row.outcome)),
						statuses: count(members.map((row) => row.status))
					}
				];
			})
		),
		checksums: {
			expected: want.checksum,
			checked: rows.filter((row) => row.checksum !== undefined).length,
			matching: rows.filter((row) => row.checksumMatches).length
		},
		memory: {
			expectedBytes: want.memoryBytes,
			reported: rows.filter((row) => row.memoryBytes !== undefined).length
		},
		moduleTags: [...new Set(rows.flatMap((row) => (row.moduleTag ? [row.moduleTag] : [])))]
			.length,
		warmObject: rows
			.filter((row) => row.path.includes('obj=warm&'))
			.map((row) => [
				row.label,
				row.moduleTag,
				row.moduleCalls,
				row.objectCalls,
				row.outcome
			]),
		refused: rows
			.filter((row) => row.outcome !== undefined && row.outcome !== 'ok')
			.map(({ label, outcome, error }) => ({ label, outcome, error }))
	};
}

/** Invocations in a tail file; a tail that never connected holds an error text and gives none. */
export function tailCalls(tail: string) {
	try {
		return invocations(parseTail(tail));
	} catch {
		return [];
	}
}

const mebibyte = 1048576;
const toMiB = (bytes: number) => bytes / mebibyte;

const objectOf = (path: string) => new URL(`https://x${path}`).searchParams.get('obj') ?? '';

/**
 * One row per boundary object: what the keep request reported, the largest live total any answered
 * step reported, and how the first unanswered step and the request after it looked.
 */
export function summarizeBoundary(config: MemoryConfig, index: number, steps: Row[], tail: string) {
	const calls = tailCalls(tail);
	const obj = boundaryName(config, index);
	const mine = steps.filter((step) => objectOf(step.path) === obj);
	const keep = mine.find((step) => step.group === `${config.id}-keep`);
	const keepBody = parse(keep?.body);
	const answered = mine.filter((step) => {
		const body = parse(step.body);
		return step.group === `${config.id}-ballast` && step.status === 200 && body.held === true;
	});
	const failed = mine.find(
		(step) => step.group === `${config.id}-ballast` && !answered.includes(step)
	);
	const after = mine.find((step) => step.group === `${config.id}-after`);
	const afterBody = parse(after?.body);
	const last = parse(answered.at(-1)?.body);
	const tailed = (step?: Row) =>
		step
			? calls.find((call) => call.entrypoint !== 'worker' && call.path === step.path)
			: undefined;
	const failure = tailed(failed);
	const failedBody = parse(failed?.body);
	const nonOk = mine.flatMap((step) => {
		const call = tailed(step);
		return call && call.outcome !== 'ok'
			? [{ label: step.label as string, outcome: call.outcome, error: call.error }]
			: [];
	});
	return {
		object: obj,
		keepStatus: keep?.status as number | undefined,
		memoryBytes: keepBody.memoryBytes as number | undefined,
		isolateShared:
			keepBody.moduleCalls === undefined
				? undefined
				: keepBody.moduleCalls > keepBody.objectCalls,
		moduleTag: keepBody.moduleTag as string | undefined,
		answeredSteps: answered.length,
		largestLiveBytes: (last.liveBytes ?? 0) as number,
		largestBallastBytes: (last.ballastBytes ?? 0) as number,
		reset: failed
			? {
					status: failed.status as number | undefined,
					heldFalse: failedBody.held === false,
					tagChanged:
						failedBody.moduleTag === undefined
							? undefined
							: failedBody.moduleTag !== keepBody.moduleTag,
					error: (failedBody.error ?? failed.error)?.toString().slice(0, 200) as
						string | undefined,
					tailNotOk: nonOk,
					outcome: failure?.outcome,
					tailError: failure?.error,
					afterStatus: after?.status as number | undefined,
					afterHeld: afterBody.held as boolean | undefined,
					afterTagChanged:
						afterBody.moduleTag === undefined
							? undefined
							: afterBody.moduleTag !== keepBody.moduleTag
				}
			: undefined
	};
}

/** Boundaries per configuration: range of the largest live total and of the ballast alone, in MiB. */
export function summarizeConfig(config: MemoryConfig, steps: Row[], tail: string, objects: number) {
	const rows = Array.from({ length: objects }, (_, index) =>
		summarizeBoundary(config, index, steps, tail)
	);
	const usable = rows.filter((row) => row.keepStatus === 200 && row.isolateShared !== true);
	return {
		config,
		objects: rows,
		discarded: rows.length - usable.length,
		capped: rows.filter((row) => !row.reset).length,
		liveAllMiB: range(rows.map((row) => toMiB(row.largestLiveBytes))),
		ballastAllMiB: range(rows.map((row) => toMiB(row.largestBallastBytes))),
		liveMiB: range(usable.map((row) => toMiB(row.largestLiveBytes))),
		ballastMiB: range(usable.map((row) => toMiB(row.largestBallastBytes)))
	};
}

/** Median ballast boundary of one configuration minus another's, against the memory size between them. */
export function boundaryShift(
	from: { ballastMiB: { median?: number } },
	to: { ballastMiB: { median?: number } },
	memoryDeltaMiB: number
) {
	if (from.ballastMiB.median === undefined || to.ballastMiB.median === undefined)
		return undefined;
	return { shiftMiB: from.ballastMiB.median - to.ballastMiB.median, memoryDeltaMiB };
}

export interface PeriodicRow {
	objectId: string;
	name: string;
	duration: number;
	activeTime: number;
	cpuTime: number;
	exceededMemoryErrors: number;
	rowsRead: number;
	rowsWritten: number;
}

/** Flattens the durableObjectsPeriodicGroups reply; a field the reply lacks reads as zero. */
export function flattenPeriodic(body: any): PeriodicRow[] {
	const groups = body?.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups ?? [];
	return groups.map((group: any) => ({
		objectId: String(group?.dimensions?.objectId ?? ''),
		name: String(group?.dimensions?.name ?? ''),
		duration: Number(group?.sum?.duration ?? 0),
		activeTime: Number(group?.sum?.activeTime ?? 0),
		cpuTime: Number(group?.sum?.cpuTime ?? 0),
		exceededMemoryErrors: Number(group?.sum?.exceededMemoryErrors ?? 0),
		rowsRead: Number(group?.sum?.rowsRead ?? 0),
		rowsWritten: Number(group?.sum?.rowsWritten ?? 0)
	}));
}

/** GB-s of one Durable Object: the product's allocation check is duration over activeTime. */
export const gbPerActiveSecond = (row: Pick<PeriodicRow, 'duration' | 'activeTime'>) =>
	row.activeTime === 0 ? undefined : row.duration / (row.activeTime / 1e6);

/** Instantiate-only objects of one configuration: per object and summed, per request and per active second. */
export function summarizeMeter(config: MemoryConfig, rows: PeriodicRow[]) {
	const names = Array.from({ length: meterObjects }, (_, index) => meterName(config, index));
	const mine = names.map((name) => ({
		name,
		row: rows.find((row) => row.name === name)
	}));
	const found = mine.flatMap(({ name, row }) => (row ? [{ ...row, name }] : []));
	const total = found.reduce(
		(sum, row) => ({
			duration: sum.duration + row.duration,
			activeTime: sum.activeTime + row.activeTime,
			cpuTime: sum.cpuTime + row.cpuTime,
			exceededMemoryErrors: sum.exceededMemoryErrors + row.exceededMemoryErrors
		}),
		{ duration: 0, activeTime: 0, cpuTime: 0, exceededMemoryErrors: 0 }
	);
	const requests = found.length * meterRequests;
	return {
		config,
		objectsFound: found.length,
		requests,
		perObject: found.map((row) => ({
			name: row.name,
			durationGbS: row.duration,
			activeSeconds: row.activeTime / 1e6,
			cpuMs: row.cpuTime / 1000,
			gbPerActiveSecond: gbPerActiveSecond(row)
		})),
		total,
		gbPerActiveSecond: gbPerActiveSecond(total),
		durationPerRequestGbS: requests ? total.duration / requests : undefined,
		activeSecondsPerRequest: requests ? total.activeTime / 1e6 / requests : undefined,
		cpuMsPerRequest: requests ? total.cpuTime / 1000 / requests : undefined
	};
}

/** exceededMemoryErrors the meter recorded for each boundary object. */
export function boundaryErrors(config: MemoryConfig, rows: PeriodicRow[], objects: number) {
	return Array.from({ length: objects }, (_, index) => {
		const name = boundaryName(config, index);
		return {
			name,
			exceededMemoryErrors: rows.find((row) => row.name === name)?.exceededMemoryErrors
		};
	});
}

export function summarizeMemoryRun(
	variant: Variant,
	steps: Row[],
	tail: string,
	periodic: PeriodicRow[] | undefined,
	objects: number
) {
	const configs = memoryConfigs[variant].map((config) => ({
		...summarizeConfig(config, steps, tail, objects),
		meter: periodic ? summarizeMeter(config, periodic) : undefined,
		meterErrors: periodic ? boundaryErrors(config, periodic, objects) : undefined
	}));
	return { configs };
}

export function summarizeRun(directory: string) {
	const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
	const has = (file: string) => existsSync(join(directory, file));
	const run = read('run.json');
	const log = parseDeployLog(readFileSync(join(directory, 'deploy.log'), 'utf8'));
	const restored = has('after.json') && has('baseline.json');
	if (restored)
		assert.deepEqual(read('after.json'), read('baseline.json'), 'account baseline differs');
	return {
		run: basename(directory),
		account: run.account,
		variant: run.variant as Variant,
		baselineRestored: restored,
		mode: (run.mode ?? 'startup') as string,
		periodic: has('periodic-meta.json') ? read('periodic-meta.json') : undefined,
		deploy: log,
		meter: {
			start: has('meter-start.json') ? read('meter-start.json') : null,
			end: has('meter-end.json') ? read('meter-end.json') : null
		},
		measured:
			has('steps.json') && run.mode === 'memory'
				? summarizeMemoryRun(
						run.variant,
						read('steps.json'),
						readFileSync(join(directory, 'tail.jsonl'), 'utf8'),
						has('periodic-late.json')
							? flattenPeriodic(read('periodic-late.json'))
							: has('periodic.json')
								? flattenPeriodic(read('periodic.json'))
								: undefined,
						boundaryObjects
					)
				: has('steps.json')
					? summarizeSteps({
							variant: run.variant,
							steps: read('steps.json'),
							tail: readFileSync(join(directory, 'tail.jsonl'), 'utf8'),
							expected: read('expected.json')
						})
					: undefined
	};
}

// usage: node experiments/bootimage/analyze.ts OUTPUT.json RUN_DIRECTORY...
if (import.meta.main) {
	const [output, ...directories] = process.argv.slice(2);
	assert.ok(output && directories.length, 'usage: analyze.ts OUTPUT.json RUN_DIRECTORY...');
	const runs = directories.map((directory) => summarizeRun(directory));
	writeFileSync(output, `${JSON.stringify({ runs }, null, 2)}\n`, { flag: 'wx' });
}
