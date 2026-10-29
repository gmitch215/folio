import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../../scripts/research/environment.ts';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const lines = (path: string) =>
	readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
const save = (directory: string, name: string, data: unknown) => {
	const path = join(directory, name),
		text = JSON.stringify(data, null, 2) + '\n';
	if (existsSync(path))
		assert.equal(readFileSync(path, 'utf8'), text, 'refusing to replace completed evidence');
	else writeFileSync(path, text, { flag: 'wx' });
};
const median = (values: number[]) => {
	const a = [...values].sort((a, b) => a - b);
	return a.length % 2 ? a[a.length >> 1]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
};
for (const [role, study] of [
	['configurations', 'boot-configurations-verified'],
	['lifecycle', 'boot-lifecycle-verified']
]) {
	const input = `build/research/${study}`,
		output = `results/boot/${role}`;
	mkdirSync(output, { recursive: true });
	const raw = readFileSync(join(input, 'raw.jsonl'), 'utf8');
	assert.ok(!/\/Users\/|\/private\//i.test(raw), 'private metadata in local records');
	copyFileSync(join(input, 'raw.jsonl'), join(output, 'raw.jsonl'));
	copyFileSync(join(input, 'analysis.json'), join(output, 'summary.json'));
	const samples = lines(join(input, 'raw.jsonl')).filter((row) => row.kind === 'sample');
	const phases = Object.fromEntries(
		[...new Set(samples.map((row) => row.arm))].map((arm) => [
			arm,
			Object.fromEntries(
				[
					'compileMs',
					'copyMs',
					'memoryBytes',
					'firstMs',
					'warmMs',
					'warmCpuMs',
					'instantiateMs',
					'openMs'
				].map((key) => [
					key,
					median(
						samples
							.filter((row) => row.arm === arm)
							.map((row) =>
								key === 'firstMs'
									? row.first.ms
									: key === 'warmMs'
										? row.warm.ms
										: key === 'warmCpuMs'
											? row.warm.cpuMs
											: (row[key] ?? row.marks[key] ?? 0)
							)
					)
				])
			)
		])
	);
	save(output, 'phases.json', phases);
}
const output = 'results/boot/lifecycle/delivery';
mkdirSync(output, { recursive: true });
const groups = [
	['original', '3acbe625'],
	['assets', '3acbe625'],
	['baked', '37f042e3']
];
const publicRows: unknown[] = [],
	meters: unknown[] = [],
	arms: unknown[] = [];
for (const [mode, run] of groups) {
	const directory = `experiments/bootimage/runs/folio-image-cost-${run}`;
	const rows = lines(join(directory, 'requests.jsonl')).filter((row) => row.mode === mode);
	const events = json(join(directory, `${mode}-stored-final.json`)).events.events;
	const deployments = json(join(directory, 'outcomes.json')).filter(
		(row: any) => row.mode === mode
	);
	const ids = new Map<string, number>(),
		objects = new Map<string, number>();
	for (const row of rows) {
		const body = row.status === 200 ? JSON.parse(row.body) : undefined;
		if (!body) {
			publicRows.push({
				mode,
				group: row.group,
				index: row.index,
				at: row.at,
				wallMs: row.wallMs,
				status: row.status,
				bodySha256: digest(row.body),
				failure:
					row.status === 404
						? 'provider Page not found'
						: 'provider Worker threw exception'
			});
			continue;
		}
		if (!ids.has(body.moduleTag)) ids.set(body.moduleTag, ids.size);
		if (!objects.has(body.object)) objects.set(body.object, objects.size);
		const { moduleTag, object, ...safe } = body;
		publicRows.push({
			mode,
			group: row.group,
			index: row.index,
			at: row.at,
			wallMs: row.wallMs,
			status: row.status,
			body: { ...safe, moduleCohort: ids.get(moduleTag), objectCohort: objects.get(object) }
		});
		for (const event of events) {
			const worker = event.$workers;
			if (worker?.event?.search?.tag !== row.tag || worker.cpuTimeMs === undefined) continue;
			meters.push({
				mode,
				tag: row.tag,
				group: row.group,
				index: row.index,
				checked: body.checked,
				executionModel: worker.executionModel,
				cpuTimeMs: worker.cpuTimeMs,
				wallTimeMs: worker.wallTimeMs,
				outcome: worker.outcome
			});
		}
	}
	const meterRows = (meters as any[]).filter(
		(row) => row.mode === mode && row.executionModel === 'durableObject' && !row.checked
	);
	arms.push({
		mode,
		deployment: deployments.find((row: any) => row.deployment),
		requests: rows.length,
		successful: rows.filter((row) => row.status === 200).length,
		memoryChecks: rows
			.filter((row) => row.status === 200 && JSON.parse(row.body).checked)
			.map((row) => ({ tag: row.tag, equal: JSON.parse(row.body).equal })),
		providerErrors: events
			.filter((event: any) => event.source?.message === 'Worker not found.')
			.map(() => ({ message: 'Worker not found.' })),
		moduleCohorts: ids.size,
		objectCohorts: objects.size,
		baselineRestored:
			JSON.stringify(json(join(directory, 'baseline.json'))) ===
			JSON.stringify(json(join(directory, 'after.json'))),
		groups: Object.fromEntries(
			['fresh', 'repeat'].map((group) => [
				group,
				{
					n: meterRows.filter((row) => row.group === group).length,
					cpuMsMedian: median(
						meterRows.filter((row) => row.group === group).map((row) => row.cpuTimeMs)
					),
					wallMsMedian: median(
						meterRows.filter((row) => row.group === group).map((row) => row.wallTimeMs)
					)
				}
			])
		)
	});
}
writeFileSync(
	join(output, 'raw.jsonl'),
	publicRows.map((row) => JSON.stringify(row)).join('\n') + '\n',
	{ flag: 'wx' }
);
writeFileSync(
	join(output, 'meters.jsonl'),
	meters.map((row) => JSON.stringify(row)).join('\n') + '\n',
	{ flag: 'wx' }
);
save(output, 'summary.json', {
	schema: 'folio.boot-delivery.v1',
	arms,
	applicationSqlRows: 0,
	requests: publicRows.length,
	checksums:
		'full-memory FNV-1a consistency checks on four requests per arm; checked requests excluded from cost summaries',
	limitsSource: 'https://developers.cloudflare.com/workers/platform/limits/',
	failedAttempts: [
		{
			stage: 'initial-build',
			modes: 3,
			requests: 0,
			reason: 'virtual import alias not processed as CompiledWasm; fixed literal generated import'
		},
		{
			stage: 'baked-first-readiness',
			requests: 4,
			reason: 'six-second readiness window exhausted; no response body retained; no invocation measurements'
		},
		{
			stage: 'baked-repeat-readiness',
			responses: lines(
				'experiments/bootimage/runs/folio-image-cost-37f042e3/readiness.jsonl'
			).map(({ mode, attempt, status, body }) => ({
				mode,
				attempt,
				status,
				bodySha256: digest(body),
				kind: status === 404 ? 'provider Page not found' : 'ready'
			}))
		}
	],
	meterCompleteness: Object.fromEntries(
		groups.map(([mode]) => [
			mode,
			(meters as any[]).filter(
				(row) => row.mode === mode && row.executionModel === 'durableObject'
			).length
		])
	)
});
const generation = lines('build/research/boot-generation/raw.jsonl');
const life = json('results/boot/lifecycle/summary.json').statistics.groups.base;
const cost = generation.find((row) => row.kind === 'generation');
save('results/boot/lifecycle', 'generation.json', {
	samples: generation,
	model: Object.fromEntries(
		['guarded', 'memory'].map((arm) => {
			const wallSaving = life.native.wallMs.median - life[arm].wallMs.median;
			const cpuSaving = life.native.cpuMs.median - life[arm].cpuMs.median;
			return [
				arm,
				{
					wallSavingMs: wallSaving,
					cpuSavingMs: cpuSaving,
					generationWallBreakEvenBoots: Math.ceil(cost.wallMs / wallSaving),
					generationCpuBreakEvenBoots: Math.ceil(cost.cpuMs / cpuSaving)
				}
			];
		})
	),
	limitations:
		'single local generation observation; model uses difference of cohort medians, excludes storage/network/deployment/retention costs; each native boot includes actual Drupal boot and first render'
});
console.log(JSON.stringify({ published: publicRows.length, arms }));
