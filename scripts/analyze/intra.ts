import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

const median = (values: number[]) => stats(values).median!;
const p95 = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
};
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// explicit parallel API, not automatic extraction: each arm against the plain arm of its round
export function summarizeIntra(rows: Row[], hash: string) {
	const environments = rows.filter((row) => row.kind === 'environment');
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length > 0, 'no samples');
	const names: Record<string, unknown> = {};
	for (const name of [...new Set(samples.map((r) => r.name))]) {
		const group = samples.filter((r) => r.name === name);
		const plain = new Map(group.filter((r) => r.arm === 'plain').map((r) => [r.round, r]));
		const arms: Record<string, unknown> = {};
		for (const arm of [...new Set(group.map((r) => r.arm))]) {
			const s = group.filter((r) => r.arm === arm);
			const paired = s.filter((r) => plain.has(r.round));
			const speedup = paired.map((r) => plain.get(r.round)!.requestMs / r.requestMs);
			const cpuRatio = paired.map((r) => r.processCpuMs / plain.get(r.round)!.processCpuMs);
			const tasks = median(s.map((r) => r.taskMs.length));
			arms[arm] = {
				n: s.length,
				requestMs: {
					...stats(s.map((r) => r.requestMs)),
					p95: p95(s.map((r) => r.requestMs))
				},
				speedupOverPlain: stats(speedup),
				processCpuOverPlain: stats(cpuRatio),
				ownerCpuMs: stats(s.map((r) => r.ownerCpuMs)),
				tasksPerRequest: tasks,
				serverCpuMsSum: stats(s.map((r) => sum(r.serverCpuMs))),
				overlapMs: stats(s.map((r) => r.overlapMs)),
				maxConcurrentTasks: stats(s.map((r) => r.maxConcurrent)),
				distinctWorkers: median(s.map((r) => new Set(r.taskWorker).size)),
				waitMs: stats(s.map((r) => r.waitMs)),
				submitHostMs: stats(s.map((r) => r.submitHostMs)),
				encodeMs: stats(s.map((r) => r.encodeMs)),
				decodeMs: stats(s.map((r) => r.decodeMs)),
				argBytes: median(s.map((r) => r.argBytes)),
				resultBytes: median(s.map((r) => r.resultBytes)),
				// a task that ran in a worker contributes CPU time there; require at least two
				// workers whose task intervals overlapped before calling a sample overlapped
				samplesWithOverlap: s.filter((r) => r.maxConcurrent >= 2).length,
				maxLoad1: Math.max(...s.map((r) => r.load[0]))
			};
		}
		assert.equal(new Set(group.map((r) => r.sha256)).size, 1, `${name}: outputs differ`);
		names[name] = { size: group[0]!.size, outputSha256: group[0]!.sha256, arms };
	}
	const open = environments.map((e) => ({
		contextKind: e.contextKind ?? 'plain',
		contextsOpenMs: e.contextsOpenMs,
		perContextOpenMs: stats(e.boots.map((b: Row) => b.openMs)),
		memoryBytes: e.memoryBytes[0]
	}));
	return {
		environment: environments[0],
		measuredSamples: samples.length,
		contexts: open,
		names,
		hash
	};
}

// the Zend compile share of an uncached Drupal render under the shipped opcache arms
export function summarizeCompile(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const samples = rows.filter((row) => row.kind === 'sample' && row.arm !== 'shm');
	assert.ok(samples.length > 0, 'no samples');
	assert.equal(
		new Set(rows.filter((r) => r.sha256).map((r) => r.sha256)).size,
		1,
		'outputs differ'
	);
	const byArm = (arm: string) => samples.filter((r) => r.arm === arm);
	const off = new Map(byArm('off').map((r) => [r.round, r]));
	const arms: Record<string, unknown> = {};
	for (const arm of [...new Set(samples.map((r) => r.arm))]) {
		const s = byArm(arm);
		const paired = s.filter((r) => off.has(r.round));
		arms[arm] = {
			n: s.length,
			renderWallMs: {
				...stats(s.map((r) => r.renderWallMs)),
				p95: p95(s.map((r) => r.renderWallMs))
			},
			renderThreadCpuMs: stats(s.map((r) => r.renderThreadCpuMs)),
			inflateMs: stats(s.map((r) => r.inflateMs)),
			inflateCalls: median(s.map((r) => r.inflateCalls)),
			sqlMs: stats(s.map((r) => r.sqlMs)),
			wallOverOff: stats(paired.map((r) => r.renderWallMs / off.get(r.round)!.renderWallMs)),
			savedMsVsOff: stats(paired.map((r) => off.get(r.round)!.renderWallMs - r.renderWallMs))
		};
	}
	const packSaved = (arms.pack as any)?.savedMsVsOff?.median as number | undefined;
	const inflateSaved =
		(arms.off as any).inflateMs.median - ((arms.pack as any)?.inflateMs.median ?? 0);
	const offWall = (arms.off as any).renderWallMs.median as number;
	const includes = rows.filter((row) => row.kind === 'includes');
	const perOptimizer: Record<string, unknown> = {};
	for (const optimizer of [...new Set(includes.map((r) => r.optimizer))]) {
		const s = includes.filter((r) => r.optimizer === optimizer);
		const per = s[0]!.perInclude as { bytes: number; ms: number }[];
		const total = sum(per.map((p) => p.ms));
		const sorted = [...per].sort((a, b) => b.ms - a.ms);
		perOptimizer[optimizer] = {
			rounds: s.length,
			includes: s[0]!.includes,
			bytes: s[0]!.bytes,
			compileMs: stats(s.map((r) => r.compileMs)),
			readMs: stats(s.map((r) => r.readMs)),
			compileShareOfOffRender: median(s.map((r) => r.compileMs)) / offWall,
			firstRoundTop10: s[0]!.top,
			firstRoundTop10ShareOfCompile: sum(sorted.slice(0, 10).map((p) => p.ms)) / total,
			firstRoundTop100ShareOfCompile: sum(sorted.slice(0, 100).map((p) => p.ms)) / total,
			includesOver1Ms: per.filter((p) => p.ms > 1).length,
			medianIncludeMs: median(per.map((p) => p.ms))
		};
	}
	return {
		environment,
		measuredSamples: samples.length,
		bake: rows.find((row) => row.kind === 'bake'),
		shm:
			rows.find((row) => row.arm === 'shm') ?? rows.find((row) => row.kind === 'shm-refused'),
		arms,
		packSavedShareOfOff: packSaved === undefined ? undefined : packSaved / offWall,
		packNetOfInflateMs: packSaved === undefined ? undefined : packSaved - inflateSaved,
		packNetOfInflateShareOfOff:
			packSaved === undefined ? undefined : (packSaved - inflateSaved) / offWall,
		perInclude: perOptimizer,
		hash
	};
}

// where the dynamic call_indirect executions of a run go, by site and by purity-census label
export function summarizeIndirect(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const runs: Record<string, unknown> = {};
	for (const row of rows.filter((r) => r.kind === 'counts')) {
		const t = row.triples as number[];
		const sites = new Map<number, { count: number; targets: Map<number, number> }>();
		const label = new Map<string, number>();
		let total = 0;
		for (let i = 0; i < t.length; i += 3) {
			const [site, target, count] = [t[i]!, t[i + 1]!, t[i + 2]!];
			total += count;
			const entry = sites.get(site) ?? { count: 0, targets: new Map() };
			entry.count += count;
			entry.targets.set(target, count);
			sites.set(site, entry);
			const name = row.functions[target]?.label ?? 'unknown';
			label.set(name, (label.get(name) ?? 0) + count);
		}
		const shareAtMost = (limit: number) =>
			sum([...sites.values()].filter((s) => s.targets.size <= limit).map((s) => s.count)) /
			total;
		const targets = new Set<number>();
		for (const s of sites.values()) for (const target of s.targets.keys()) targets.add(target);
		const top = [...sites.entries()]
			.sort((a, b) => b[1].count - a[1].count)
			.slice(0, 10)
			.map(([site, s]) => ({
				site,
				containingFunction: row.siteFn[site]?.fn,
				containingLabel: row.siteFn[site]?.label,
				calls: s.count,
				share: s.count / total,
				distinctTargets: s.targets.size,
				topTargetShare: Math.max(...s.targets.values()) / s.count
			}));
		const topTenShare = sum(top.map((s) => s.share));
		runs[row.label] = {
			outputDigests: [...new Set(row.sha256)],
			dynamicIndirectCalls: total,
			instrumentedSitesExecuted: sites.size,
			distinctTargets: targets.size,
			shareAtSitesWithOneTarget: shareAtMost(1),
			shareAtSitesWithAtMost4Targets: shareAtMost(4),
			shareAtSitesWithAtMost16Targets: shareAtMost(16),
			shareByTargetLabel: Object.fromEntries(
				[...label].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / total])
			),
			topTenSiteShare: topTenShare,
			topSites: top
		};
	}
	return { environment, runs, hash };
}

// can a Wasm memory copy clone a PHP context, and what does the copy cost
export function summarizeSnapshot(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const plain = rows.filter((row) => row.kind === 'plain-sample');
	const drupal = rows.filter((row) => row.kind === 'drupal-sample');
	assert.ok(plain.length > 0, 'no plain samples');
	return {
		environment,
		plain: {
			n: plain.length,
			correctClones: plain.filter((r) => r.correct).length,
			bytes: plain[0]!.bytes,
			copyMs: { ...stats(plain.map((r) => r.copyMs)), p95: p95(plain.map((r) => r.copyMs)) },
			adoptMs: stats(plain.map((r) => r.adoptMs)),
			firstRunMs: stats(plain.map((r) => r.firstRunMs)),
			maxLoad1: Math.max(...plain.map((r) => r.load[0]))
		},
		drupal: {
			n: drupal.length,
			rendered: drupal.filter((r) => r.outcome === 'rendered' && r.sha256 === r.ownerSha256)
				.length,
			bytes: drupal[0]?.bytes,
			copyMs: drupal.length ? stats(drupal.map((r) => r.copyMs)) : undefined,
			outcomes: Object.fromEntries(
				[...new Set(drupal.map((r) => String(r.outcome).split('\n')[0]))].map((o) => [
					o,
					drupal.filter((r) => String(r.outcome).split('\n')[0] === o).length
				])
			)
		},
		hash
	};
}

const summarizers = {
	intra: summarizeIntra,
	compile: summarizeCompile,
	indirect: summarizeIndirect,
	snapshot: summarizeSnapshot
};

export function analyzeIntra(
	kind: keyof typeof summarizers,
	set: string,
	files: string[],
	out: string
) {
	const root = resultsRoot(set);
	const raws = files.map((file) => readRaw(root, file));
	const rows = raws.flatMap((raw) => parseRows(raw));
	const summary = summarizers[kind](rows, sha256(Buffer.concat(raws)));
	writeFileSync(new URL(out, root), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

if (import.meta.main) {
	const [kind, set, out, ...files] = process.argv.slice(2);
	console.log(
		JSON.stringify(analyzeIntra(kind as any, set!, files, out!), null, 1).slice(0, 3000)
	);
}
