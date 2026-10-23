import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { peakConcurrency } from '../../src/tasks.ts';
import { consumerRoot } from './consumer-root.ts';
import { type Contexts, overlapMs } from './php-contexts.ts';
import { costCode, defaultSizes, openTaskContexts, requestCode, workloads } from './php-tasks.ts';

// explicit parallel API, not automatic extraction
// usage: node scripts/probe/php-intra.ts OUTPUT.jsonl [PAIRS] [WIDTHS] [WORKLOADS]
//        node scripts/probe/php-intra.ts calibrate OUTPUT.jsonl [1] [WIDTHS] [WORKLOADS]
// arms per round, order rotated: plain (the request calls its functions directly, untouched native
// PHP), api-inline (the same request through task_submit and task_join in one context, serialized
// copies but no second context), api-W (W task contexts)
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_MACHINE as in php-concurrent.ts
const [first, ...rest] = process.argv.slice(2);
const calibrate = first === 'calibrate';
const output = calibrate ? rest[0]! : first;
if (!output) throw new Error('usage: php-intra.ts OUTPUT.jsonl [PAIRS] [WIDTHS] [WORKLOADS]');
const args = calibrate ? rest.slice(1) : rest;
const pairs = Number(args[0] ?? 20);
const widths = (args[1] ?? '1,2,4,8').split(',').map(Number);
const names = args[2] ? args[2].split(',') : workloads.map((w) => w.name);
const consumer = consumerRoot();
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const jobCount = Number(process.env.FOLIO_JOBS ?? 8);
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify(row));
	writeFileSync(output, lines.join('\n') + '\n');
};

type Arm = 'plain' | 'api-inline' | `api-${number}`;
const arms: Arm[] = ['plain', 'api-inline', ...widths.map((w) => `api-${w}` as Arm)];
const top = Math.max(...widths);
let contexts: Contexts;

async function sample(arm: Arm, code: { plain: string; api: string; inline: string }) {
	const width = arm.startsWith('api-') && arm !== 'api-inline' ? Number(arm.slice(4)) : 0;
	if (width) await contexts.setWidth(0, width);
	const cpu0 = process.cpuUsage();
	const wall0 = performance.now();
	const run = await contexts.run(
		0,
		arm === 'plain' ? code.plain : arm === 'api-inline' ? code.inline : code.api,
		true
	);
	const wallMs = performance.now() - wall0;
	const cpu = process.cpuUsage(cpu0);
	const cost = JSON.parse((await contexts.run(0, costCode, true)).output!);
	const log = (run.taskLog ?? []) as any[];
	return {
		arm,
		width,
		wallMs,
		requestMs: run.endMs - run.startMs,
		ownerCpuMs: run.cpuMs,
		processCpuMs: (cpu.user + cpu.system) / 1000,
		serverCpuMs: log.map((t) => t.cpuMs),
		taskMs: log.map((t) => t.endMs - t.startMs),
		taskIntervals: log.map((t) => [t.startMs - run.startMs, t.endMs - run.startMs]),
		taskWorker: log.map((t) => t.worker),
		overlapMs: overlapMs(log),
		maxConcurrent: peakConcurrency(log),
		waitMs: log.reduce((s, t) => s + t.waitMs, 0),
		submitHostMs: log.reduce((s, t) => s + t.submitHostMs, 0),
		encodeMs: cost.encodeNs / 1e6,
		decodeMs: cost.decodeNs / 1e6,
		argBytes: log.reduce((s, t) => s + t.argBytes, 0),
		resultBytes: log.reduce((s, t) => s + t.resultBytes, 0),
		sha256: run.sha256,
		output: run.output,
		load: loadavg()
	};
}

for (const kind of ['plain', 'drupal'] as const) {
	const chosen = names.filter(
		(name) => (workloads.find((w) => w.name === name)!.kind ?? 'plain') === kind
	);
	if (!chosen.length) continue;
	const t0 = performance.now();
	contexts = await openTaskContexts({ servers: top, kind, mode: 'native', bundle, consumer });
	emit({
		kind: 'environment',
		contextKind: kind,
		experiment: 'B-a explicit parallel API, not automatic extraction',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		cpu: cpus()[0]!.model,
		hardwareThreads: cpus().length,
		affinity: process.env.FOLIO_AFFINITY,
		pairs,
		widths,
		jobs: jobCount,
		contextsOpenMs: performance.now() - t0,
		boots: contexts.boots.map((b) => b.boot),
		memoryBytes: contexts.boots.map((b) => b.memoryBytes)
	});
	for (const name of chosen) {
		const workload = workloads.find((w) => w.name === name)!;
		const size = defaultSizes[name]!;
		const code = {
			plain: requestCode(workload, size, 'plain', jobCount),
			api: requestCode(workload, size, 'api', jobCount),
			inline: requestCode(workload, size, 'inline', jobCount)
		};
		let expected: string | undefined;
		for (const arm of arms) {
			const r = await sample(arm, code);
			expected ??= r.output;
			if (r.output !== expected) throw new Error(`${name} ${arm}: output differs from plain`);
		}
		if (calibrate) {
			const r = await sample('plain', code);
			emit({
				kind: 'calibration',
				name,
				size,
				plainMs: r.requestMs,
				perJobMs: r.requestMs / jobCount
			});
			continue;
		}
		for (let round = 0; round < pairs; round++) {
			for (let k = 0; k < arms.length; k++) {
				const arm = arms[(k + round) % arms.length]!;
				const r = await sample(arm, code);
				if (r.output !== expected)
					throw new Error(`${name} ${arm}: output differs from plain`);
				const { output: _output, ...row } = r;
				emit({ kind: 'sample', experiment: 'B-a', name, size, round, ...row });
			}
		}
	}
	await contexts.close();
}
