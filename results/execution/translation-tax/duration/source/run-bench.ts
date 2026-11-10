import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';

// usage: node run-bench.ts <config> <reps> <arm,arm,...> <site:workload[:n],...>
// BENCH_DIR holds census/build/bench.mjs, the harness of the parent study with a site switch
// (stock or thunder) and a ladder workload; WAIT_MS caps the wait for load below 4 before a batch
const [config, repsArg, armsArg, loadsArg] = process.argv.slice(2);
const root = process.env.BENCH_DIR;
const flags: Record<string, string[]> = {
	default: [],
	optimized: ['--no-liftoff', '--no-wasm-lazy-compilation']
};
if (!root || !config || !flags[config] || !repsArg || !armsArg || !loadsArg)
	throw new Error('usage: run-bench.ts default|optimized reps arms site:workload[:n],...');
const arms = armsArg.split(',');
mkdirSync(`${root}/bench`, { recursive: true });
const out = `${root}/bench/raw-${config}.jsonl`;
const first = Number(process.env.REP0 ?? 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const spec of loadsArg.split(',')) {
	const [site, workload, n] = spec.split(':');
	for (let rep = first; rep < first + Number(repsArg); rep++) {
		let waitedMs = 0;
		while (loadavg()[0]! >= 4 && waitedMs < Number(process.env.WAIT_MS ?? 120_000)) {
			await sleep(15_000);
			waitedMs += 15_000;
		}
		const order = arms.map((_, i) => arms[(i + rep - 1) % arms.length]!);
		for (const arm of order) {
			const tag = `${config}-${site}${rep}`;
			const loadStart = loadavg();
			const t0 = Date.now();
			const run = spawnSync(
				process.execPath,
				[
					...flags[config]!,
					'build/bench.mjs',
					`--site=${site}`,
					`--mode=${arm}`,
					`--workload=${workload}`,
					`--n=${n ?? 1}`,
					`--rep=${tag}`
				],
				{ cwd: `${root}/census`, encoding: 'utf8', maxBuffer: 1 << 28 }
			);
			const loadEnd = loadavg();
			let record: Record<string, unknown> = {
				config,
				site,
				workload,
				rep,
				arm,
				startedAt: new Date(t0).toISOString(),
				loadStart,
				loadEnd,
				waitedMs,
				status: run.status
			};
			try {
				const result = JSON.parse(
					readFileSync(`${root}/census/runs/${workload}.${arm}${tag}.json`, 'utf8')
				);
				const f = result.final ?? {};
				record = {
					...record,
					ok: result.ok === true,
					node: result.node,
					v8: result.v8,
					execArgv: result.execArgv,
					moduleBytes: result.module?.bytes,
					moduleSha256: result.module?.sha256,
					requestMs: f.request?.wallMs,
					normalizedSha256: f.request?.sha256Normalized,
					queries: f.request?.queries,
					ladder: result.ladder?.map((x: any) => ({
						i: x.i,
						ms: Math.round(x.ms * 10) / 10,
						cumMs: Math.round(x.cumMs * 10) / 10,
						queries: x.queries
					})),
					hostCounts: result.hostCounts,
					error: result.error?.slice(0, 300)
				};
			} catch (error) {
				record.error = String(error);
			}
			appendFileSync(out, JSON.stringify(record) + '\n');
		}
	}
}
