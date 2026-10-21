import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Row = Record<string, any>;

/** Reads the pretty-printed, concatenated JSON objects `wrangler tail --format json` writes. */
export function parseTail(text: string): Row[] {
	const events: Row[] = [];
	let depth = 0;
	let start = 0;
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quoted) {
			if (char === '\\') index++;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === '{') {
			if (depth++ === 0) start = index;
		} else if (char === '}' && --depth === 0)
			events.push(JSON.parse(text.slice(start, index + 1)));
	}
	return events;
}

/** One row per invocation with the account host and headers removed. */
export function invocations(events: Row[]) {
	return events
		.filter((event) => event.event?.request)
		.map((event) => ({
			entrypoint: event.entrypoint ?? 'worker',
			model: event.executionModel,
			outcome: event.outcome as string,
			cpuMs: event.cpuTime as number,
			wallMs: event.wallTime as number,
			path: (() => {
				const url = new URL(event.event.request.url);
				return `${url.pathname}${url.search}`;
			})(),
			error: event.exceptions?.[0]?.message?.slice(0, 160) as string | undefined
		}));
}

/** The last line of a streamed plateau is the last step the isolate acknowledged before a reset. */
export function plateauReached(body: string) {
	const lines = body.trim().split('\n').filter(Boolean);
	const last = JSON.parse(lines.at(-1)!);
	return {
		steps: lines.length,
		lastAddedMiB: last.addedMiB as number,
		linearBytes: last.linearBytes as number
	};
}

/** The SHA-256 chain the probe runs in PHP, computed independently. */
export async function expectedChain(n: number) {
	const { createHash } = await import('node:crypto');
	let hash = 'folio';
	for (let index = 0; index < n; index++)
		hash = createHash('sha256').update(`${hash}${index}`).digest('hex');
	return hash;
}

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const range = (values: number[]) => ({
	n: values.length,
	median: median(values),
	min: Math.min(...values),
	max: Math.max(...values)
});

export async function summarizePhp(directory: string) {
	const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
	assert.deepEqual(read('after.json'), read('baseline.json'), 'account baseline differs');
	const steps: Row[] = read('steps.json');
	const calls = invocations(parseTail(readFileSync(join(directory, 'tail.jsonl'), 'utf8')));
	const cpu = (entrypoint: string, prefix: string) =>
		range(
			calls
				.filter((call) => call.entrypoint === entrypoint && call.path === prefix)
				.map((call) => call.cpuMs)
		);
	const output = async (label: string) => {
		const body = JSON.parse(steps.find((step) => step.label === label)!.body);
		return body.output === (await expectedChain(body.n)) ? 'exact' : 'differs';
	};
	const refused = calls.filter((call) => call.outcome !== 'ok');
	const plateau = (label: string) => {
		const step = steps.find((item) => item.label === label);
		return step && step.status === 200 ? plateauReached(step.body) : undefined;
	};
	return {
		run: basename(directory),
		account: read('run.json').account,
		baselineRestored: true,
		statuses: Object.fromEntries(steps.map((step) => [step.label, step.status])),
		cpuMs: {
			workerBoot: cpu('worker', '/worker-boot'),
			workerWork20000: cpu('worker', '/worker-work?n=20000'),
			doBoot: cpu('PhpProbe', '/boot'),
			doWork20000: cpu('PhpProbe', '/work?n=20000'),
			doWork200000: cpu('PhpProbe', '/work?n=200000'),
			doPrepared: calls
				.filter((call) => call.path.startsWith('/prepared'))
				.map((call) => [call.path, call.entrypoint, call.cpuMs, call.outcome])
		},
		outputs: { 'work-0': await output('work-0'), 'work-big-0': await output('work-big-0') },
		plateauJs: plateau('plateau-js'),
		plateauPhp: plateau('plateau-php'),
		refusals: refused.map(({ entrypoint, outcome, path, error }) => ({
			entrypoint,
			outcome,
			path,
			error
		}))
	};
}

// usage: node experiments/consumer/php/analyze.ts RUN_DIRECTORY OUTPUT.json
if (import.meta.main) {
	const [directory, output] = process.argv.slice(2);
	assert.ok(directory && output, 'usage: analyze.ts RUN_DIRECTORY OUTPUT.json');
	writeFileSync(output, `${JSON.stringify(await summarizePhp(directory), null, 2)}\n`);
}
