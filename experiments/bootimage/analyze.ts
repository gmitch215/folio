import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { invocations, parseTail } from '../consumer/php/analyze.ts';
import { moduleOf, type Variant } from './plan.ts';

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
		deploy: log,
		meter: {
			start: has('meter-start.json') ? read('meter-start.json') : null,
			end: has('meter-end.json') ? read('meter-end.json') : null
		},
		measured: has('steps.json')
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
