import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';

// usage: node run-bench.ts <config> <reps> <arm,arm,...>; arms interleaved, order rotated each rep
// BENCH_DIR holds build/bench.mjs and the arm modules; the harness is the census harness with the
// recorder replaced by the translation host (see METHOD.md)
const [config, repsArg, armsArg] = process.argv.slice(2);
const root = process.env.BENCH_DIR;
const flags: Record<string, string[]> = {
	default: [],
	optimized: ['--no-liftoff', '--no-wasm-lazy-compilation']
};
if (!root || !config || !flags[config] || !repsArg || !armsArg)
	throw new Error('usage: BENCH_DIR=... run-bench.ts default|optimized reps arms');
const arms = armsArg.split(',');
mkdirSync(`${root}/bench`, { recursive: true });
const out = `${root}/bench/raw-${config}.jsonl`;
const first = Number(process.env.REP0 ?? 1);
for (let rep = first; rep < first + Number(repsArg); rep++) {
	const order = arms.map((_, i) => arms[(i + rep - 1) % arms.length]!);
	for (const arm of order) {
		const tag = `${config}${rep}`;
		const loadStart = loadavg();
		const t0 = Date.now();
		const run = spawnSync(
			process.execPath,
			[...flags[config]!, 'build/bench.mjs', `--mode=${arm}`, '--workload=front', `--rep=${tag}`],
			{ cwd: `${root}/census`, encoding: 'utf8', maxBuffer: 1 << 28 }
		);
		const loadEnd = loadavg();
		let record: Record<string, unknown> = {
			config,
			rep,
			arm,
			startedAt: new Date(t0).toISOString(),
			loadStart,
			loadEnd,
			status: run.status
		};
		try {
			const result = JSON.parse(readFileSync(`${root}/census/runs/front.${arm}${tag}.json`, 'utf8'));
			const f = result.final ?? {};
			record = {
				...record,
				ok: result.ok === true,
				moduleBytes: result.module?.bytes,
				moduleSha256: result.module?.sha256,
				requestMs: f.request?.wallMs,
				request2Ms: f.request2?.wallMs,
				request3Ms: f.request3?.wallMs,
				normalizedSha256: f.request?.sha256Normalized,
				queries: f.request?.queries,
				hostCounts: result.hostCounts,
				counters: result.requestCounters ?? result.counters,
				error: result.error?.slice(0, 300)
			};
		} catch (error) {
			record.error = String(error);
			record.stderr = run.stderr?.slice(-400);
		}
		appendFileSync(out, JSON.stringify(record) + '\n');
	}
}
