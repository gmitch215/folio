import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { openOldBuild } from './old-build.ts';

// usage: [FOLIO_OLD_BUILD=1] node scripts/probe/php-render-pairs.ts OUTPUT.jsonl [PAIRS] [WORKERS,...]
// runs the uncached Drupal render of php-render.ts in alternating native and folio processes
const [output, pairsArg, workersArg] = process.argv.slice(2);
if (!output) throw new Error('usage: php-render-pairs.ts OUTPUT.jsonl [PAIRS] [WORKERS]');
const pairs = Number(pairsArg ?? 10);
const widths = (workersArg ?? '2,8').split(',').map(Number);
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
);
const bundle = new URL('../../build/php-render.mjs', import.meta.url).pathname;
const scratch = new URL('../../build/php-render-pairs/', import.meta.url).pathname;
mkdirSync(scratch, { recursive: true });
const normalize = (html: string) =>
	html
		.replace(/(js-view-dom-id-)[0-9a-f]{64}/g, '$1')
		.replace(/("permissionsHash":")[0-9a-f]{64}/g, '$1');

// the first run also builds the bundle and the prepared plan when they are missing
const build = spawnSync(
	process.execPath,
	[new URL('./php-render.ts', import.meta.url).pathname, 'native', join(scratch, 'build.json')],
	{ env: { ...process.env, FOLIO_CONSUMER: consumer }, stdio: 'ignore' }
);
if (build.status !== 0) throw new Error('php-render.ts failed');
const oldBuild = process.env.FOLIO_OLD_BUILD === '1' ? await openOldBuild() : undefined;
const oldSource = new URL('../../build/old-build/src/', import.meta.url).href;
const plans = {
	old: new URL('../../build/php-prepared.bin', import.meta.url).pathname,
	folio: new URL('../../build/php-prepared-admit.bin', import.meta.url).pathname
};
const arms = [
	'native',
	...widths.flatMap((width) => [...(oldBuild ? [`old-${width}`] : []), `folio-${width}`])
];
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify(row));
	writeFileSync(output, lines.join('\n') + '\n');
};
emit({
	kind: 'environment',
	node: process.version,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	arms,
	pairs,
	warmup: 1,
	...(oldBuild ? { oldBuildSha256: oldBuild.digest } : {}),
	measured: 'time and process CPU between the drupal-booted and drupal-rendered stages'
});
for (let round = -1; round < pairs; round++) {
	for (let turn = 0; turn < arms.length; turn++) {
		const arm = arms[(turn + round + 1) % arms.length]!;
		const path = join(scratch, `${arm}.json`);
		const run = spawnSync(
			process.execPath,
			[
				bundle,
				arm === 'native' ? 'native' : 'folio',
				path,
				...(arm === 'native' ? [] : [plans[arm.startsWith('old-') ? 'old' : 'folio']])
			],
			{
				env: {
					...process.env,
					FOLIO_CONSUMER: consumer,
					FOLIO_WORKERS: arm === 'native' ? '' : arm.slice(arm.indexOf('-') + 1),
					...(arm.startsWith('old-') ? { FOLIO_SRC_DIR: oldSource } : {})
				},
				encoding: 'utf8'
			}
		);
		if (run.status !== 0) throw new Error(`${arm} failed: ${run.stderr.slice(0, 400)}`);
		const result = JSON.parse(readFileSync(path, 'utf8'));
		const stage = (name: string) => result.stages.find((item: any) => item.name === name);
		const booted = stage('drupal-booted');
		const rendered = stage('drupal-rendered');
		const digest = createHash('sha256')
			.update(normalize(readFileSync(path + '.html', 'utf8')))
			.digest('hex');
		if (round < 0) continue;
		const report = result.reports?.at(-1);
		emit({
			kind: 'sample',
			name: 'drupal-uncached-render',
			arm,
			round,
			wallMs: rendered.wallMs - booted.wallMs,
			cpuMs: rendered.cpuMs - booted.cpuMs,
			bootMs: booted.wallMs,
			outputSha256: digest,
			passed: result.ok === true && result.render.status === 200,
			dispatched: report && {
				workers: report.workers,
				regions: report.regions,
				replayed: report.replayed,
				fallbacks: report.fallbacks,
				mode: report.mode,
				reason: report.reason,
				workerCpuMs:
					report.profile?.workerCpuMs.reduce((a: number, b: number) => a + b, 0) ?? 0
			},
			load: loadavg()
		});
	}
}
