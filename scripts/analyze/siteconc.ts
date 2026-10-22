import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';
import { summarizeRegen } from './regen.ts';

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const quantile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
};
const withP95 = (values: number[]) => ({ ...stats(values), p95: quantile(values, 0.95) });

type Sample = Row & { run: number };

const cpuOf = (s: Sample) =>
	s.armKind === 'spin'
		? s.clientCpuMs
		: sum(s.perHost.map((h: Row) => h.workerdCpuMs + h.bunCpuMs));

// pairs each sample with the sample of `base` taken in the same run and round
const paired = (
	samples: Sample[],
	arm: string,
	base: string,
	f: (a: Sample, b: Sample) => number
) => {
	const baseline = new Map(
		samples.filter((s) => s.arm === base).map((s) => [`${s.run}:${s.round}`, s])
	);
	return samples
		.filter((s) => s.arm === arm && baseline.has(`${s.run}:${s.round}`))
		.map((s) => f(s, baseline.get(`${s.run}:${s.round}`)!));
};

// one run is a list of rows from one invocation of the probe; arms are paired within a round
export function summarizeSite(runs: Row[][], folio?: Row[]) {
	assert.ok(runs.length > 0, 'no runs');
	const samples: Sample[] = runs.flatMap((rows, run) =>
		rows.filter((r) => r.kind === 'sample').map((r) => ({ ...r, run }) as Sample)
	);
	assert.ok(samples.length > 0, 'no samples');
	const environments = runs.map((rows) => rows.find((r) => r.kind === 'environment')!);
	const boots = runs.flatMap((rows, run) =>
		rows
			.filter((r) => r.kind === 'boot')
			.map((r) => ({
				run,
				host: r.host,
				readyMs: r.readyMs,
				firstWarmMs: r.warmMs[0],
				steadyWarmMs: r.warmMs[2],
				workerdRssMb: r.workerdRssKb / 1024,
				workerdFootprintMb: r.workerdFootprintMb ?? null,
				bunFootprintMb: r.bunFootprintMb ?? null,
				bunRssMb: r.bunRssKb / 1024,
				warmAllRender: r.warmCache.every((c: string) => c === 'RENDER'),
				warmAll200: r.warmStatus.every((c: number) => c === 200)
			}))
	);
	const endMemory = runs.flatMap((rows, run) =>
		rows
			.filter((r) => r.kind === 'memory')
			.map((r) => ({
				run,
				freeMemMb: r.freeMemMb,
				workerdRssMb: stats(r.hosts.map((h: Row) => h.workerdRssKb / 1024)),
				workerdFootprintMb: stats(r.hosts.map((h: Row) => h.workerdFootprintMb)),
				bunFootprintMb: stats(r.hosts.map((h: Row) => h.bunFootprintMb))
			}))
	);
	const arms: Record<string, unknown> = {};
	for (const name of [...new Set(samples.map((s) => s.arm as string))]) {
		const s = samples.filter((x) => x.arm === name);
		const first = s[0]!;
		const baseName = first.armKind === 'spin' ? 'spin-c1' : 'queue-c1';
		const http = first.armKind !== 'spin';
		const rss = (key: string) => s.flatMap((x) => x.perHost.map((h: Row) => h[key] / 1024));
		const perRequest = s.flatMap((x) => (http ? x.ms : x.spinMs)) as number[];
		arms[name] = {
			kind: first.armKind,
			c: first.c,
			processes: first.hosts,
			n: s.length,
			runs: new Set(s.map((x) => x.run)).size,
			wallMs: withP95(s.map((x) => x.wallMs)),
			reqPerS: stats(s.map((x) => (1000 * x.requests) / x.wallMs)),
			requestMs: {
				n: perRequest.length,
				p50: quantile(perRequest, 0.5),
				p95: quantile(perRequest, 0.95)
			},
			speedupOverC1: stats(paired(samples, name, baseName, (a, b) => b.wallMs / a.wallMs)),
			cpuMsPerBatch: stats(s.map(cpuOf)),
			cpuOverC1: stats(paired(samples, name, baseName, (a, b) => cpuOf(a) / cpuOf(b))),
			...(first.armKind === 'static'
				? {
						speedupOverQueueSameC: stats(
							paired(
								samples,
								name,
								`queue-c${first.c}`,
								(a, b) => b.wallMs / a.wallMs
							)
						)
					}
				: {}),
			...(http
				? {
						notRender: sum(
							s.map((x) => x.cache.filter((c: string) => c !== 'RENDER').length)
						),
						notOk: sum(s.map((x) => x.status.filter((c: number) => c !== 200).length)),
						gateAheadMax: Math.max(...s.flatMap((x) => x.gateAhead)),
						gateAheadMedianOfMax: stats(s.map((x) => Math.max(...x.gateAhead))).median,
						workerdRssMb: stats(rss('workerdRssKb')),
						bunRssMb: stats(rss('bunRssKb')),
						requestsPerProcess: stats(s.flatMap((x) => x.perHostRequests))
					}
				: {}),
			load1: stats(s.map((x) => x.load[0]))
		};
	}
	const serial = arms['queue-c1'] as Row;
	const batch = Object.values(arms)
		.filter((a: any) => (a.kind === 'queue' && a.c === 1) || a.kind === 'static')
		.map((a: any) => ({
			arm: a.kind === 'queue' ? 'one process, serial' : `${a.processes} processes`,
			wallMs: a.wallMs.median,
			speedup: a.speedupOverC1.median,
			speedupMin: a.speedupOverC1.min,
			speedupMax: a.speedupOverC1.max,
			cpuOverSerial: a.cpuOverC1.median,
			workerdRssMbPerProcess: a.workerdRssMb.median
		}));
	const regen = folio ? summarizeRegen(folio, 'inline') : undefined;
	return {
		environment: environments[0],
		runs: runs.length,
		measuredSamples: samples.length,
		serialBatchWallMs: serial.wallMs,
		boots,
		endMemory,
		hostErrors: runs.map((rows) => rows.find((r) => r.kind === 'hostLog')?.errors ?? null),
		arms,
		batch,
		folioRegen: regen && {
			machine: regen.environment.machine,
			pairs: regen.measuredSamples,
			serialWallMs: (regen.arms.serial as Row).wallMs,
			arms: Object.fromEntries(
				Object.entries(regen.arms)
					.filter(([k]) => k !== 'serial')
					.map(([k, v]: [string, any]) => [
						k,
						{
							wallMs: v.wallMs,
							speedupOverSerial: v.speedupOverSerial,
							processCpuOverSerial: v.processCpuOverSerial
						}
					])
			)
		}
	};
}

export function analyzeSiteConc(set: string) {
	const root = resultsRoot(set);
	const dirs = readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^run-\d+$/.test(d.name))
		.map((d) => d.name)
		.sort();
	const raws = dirs.map((d) => readRaw(root, `${d}/samples.jsonl`));
	const folioFile = new URL('folio-regen.jsonl', root);
	const folioRaw = existsSync(folioFile) ? readRaw(root, 'folio-regen.jsonl') : undefined;
	const summary = {
		...summarizeSite(raws.map(parseRows), folioRaw ? parseRows(folioRaw) : undefined),
		hash: sha256(Buffer.concat([...raws, ...(folioRaw ? [folioRaw] : [])]))
	};
	writeFileSync(new URL('summary.json', root), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

if (import.meta.main) analyzeSiteConc(process.argv[2] ?? '20261022-site-concurrency');
