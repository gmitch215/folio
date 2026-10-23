import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { consumerRoot } from './consumer-root.ts';
import { loadPlan, openContexts } from './php-contexts.ts';

// usage: node scripts/probe/drupal-breakdown.ts OUTPUT.jsonl [PROCESSES] [INSTANCES]
// each process opens INSTANCES Drupal contexts one after another and renders once in each, so
// instance 0 pays lazy Wasm compilation and later ones reuse the compiled code of the module
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_PLAN, FOLIO_MACHINE as in php-concurrent.ts
const [output, processesArg, instancesArg, child] = process.argv.slice(2);
if (!output) throw new Error('usage: drupal-breakdown.ts OUTPUT.jsonl [PROCESSES] [INSTANCES]');
const instances = Number(instancesArg ?? 4);
const consumer = consumerRoot();
const bundle = process.env.FOLIO_WORKER_BUNDLE;

if (child === 'child') {
	const mode = (process.env.FOLIO_BREAKDOWN_MODE ?? 'native') as 'native' | 'folio';
	const plan =
		mode === 'folio'
			? loadPlan(
					process.env.FOLIO_PLAN ??
						new URL('../../build/php-prepared-admit.bin', import.meta.url).pathname
				)
			: undefined;
	for (let k = 0; k < instances; k++) {
		const open0 = performance.now();
		const cpuOpen = process.cpuUsage();
		const c = await openContexts({ count: 1, kind: 'drupal', mode, plan, bundle, consumer });
		const openMs = performance.now() - open0;
		const openProcessCpuMs = (() => {
			const u = process.cpuUsage(cpuOpen);
			return (u.user + u.system) / 1000;
		})();
		await new Promise((r) => setTimeout(r, 300));
		const cpu0 = process.cpuUsage();
		const wall0 = performance.now();
		const [run] = await c.render();
		const wallMs = performance.now() - wall0;
		const cpu = process.cpuUsage(cpu0);
		console.log(
			JSON.stringify({
				kind: 'sample',
				name: 'drupal-render-breakdown',
				mode,
				instance: k,
				openMs,
				openProcessCpuMs,
				boot: c.boots[0]!.boot,
				renderWallMs: wallMs,
				renderThreadCpuMs: run!.cpuMs,
				renderProcessCpuMs: (cpu.user + cpu.system) / 1000,
				sqlMs: run!.sqlMs,
				sqlCalls: run!.sqlCalls,
				inflateMs: run!.inflateMs,
				inflateCalls: run!.inflateCalls,
				inflateBytes: run!.inflateBytes,
				sha256: run!.sha256
			})
		);
		await c.close();
	}
} else {
	const processes = Number(processesArg ?? 10);
	const lines: string[] = [
		JSON.stringify({
			kind: 'environment',
			machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
			node: process.version,
			cpu: cpus()[0]!.model,
			hardwareThreads: cpus().length,
			processes,
			instances,
			modes: ['native', 'folio']
		})
	];
	for (let p = 0; p < processes; p++)
		for (const mode of p % 2 ? ['folio', 'native'] : ['native', 'folio']) {
			const run = spawnSync(
				process.execPath,
				[
					'--max-old-space-size=1024',
					new URL(import.meta.url).pathname,
					output,
					'1',
					String(instances),
					'child'
				],
				{ encoding: 'utf8', env: { ...process.env, FOLIO_BREAKDOWN_MODE: mode } }
			);
			if (run.status !== 0)
				throw new Error(`${mode} process ${p} failed: ${run.stderr.slice(0, 600)}`);
			for (const line of run.stdout.trim().split('\n'))
				lines.push(JSON.stringify({ ...JSON.parse(line), process: p, load: loadavg() }));
			writeFileSync(output, lines.join('\n') + '\n');
		}
}
