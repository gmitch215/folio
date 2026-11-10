import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { median, parseLines } from './elastic-limits-summary.ts';
import { GATE_TAU, STALL, pairedTau, type BenchRow } from './translation-tax-summary.ts';

export interface DurationRow extends BenchRow {
	site: string;
	workload: string;
	ladder?: { i: number; ms: number; cumMs: number }[];
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** One row per (workload, rung): a plain workload has rung 1, a ladder one rung per render count. */
export function rungs(rows: DurationRow[]) {
	const out: { key: string; site: string; workload: string; rung: number; rows: BenchRow[] }[] =
		[];
	const add = (r: DurationRow, rung: number, ms: number | undefined) => {
		const key = `${r.config}|${r.site}|${r.workload}|${rung}`;
		let cell = out.find((c) => c.key === key);
		if (!cell) out.push((cell = { key, site: r.site, workload: r.workload, rung, rows: [] }));
		cell.rows.push({ ...r, config: key, requestMs: ms });
	};
	for (const r of rows) {
		if (!r.ok) continue;
		if (r.ladder) for (const x of r.ladder) add(r, x.i, x.cumMs);
		else add(r, 1, r.requestMs);
	}
	return out;
}

export function durationTable(rows: DurationRow[], config: string, arms: string[]) {
	return rungs(rows.filter((r) => r.config === config)).map((cell) => {
		const native = cell.rows.filter((r) => r.arm === 'native');
		const nativeMs = native.map((r) => r.requestMs!);
		const perArm: Record<string, unknown> = {};
		for (const arm of arms) {
			const tau = pairedTau(cell.rows, cell.key, arm);
			if (tau) perArm[arm] = tau;
		}
		return {
			site: cell.site,
			workload: cell.workload,
			rung: cell.rung,
			nativeN: nativeMs.length,
			nativeMs,
			nativeMedianMs: nativeMs.length ? round(median(nativeMs)!) : null,
			arms: perArm
		};
	});
}

/** Median per-render time of a ladder by arm and render index, to show where the time falls. */
export function ladderRenders(rows: DurationRow[], config: string) {
	const out: Record<string, Record<number, number>> = {};
	const arms = [...new Set(rows.filter((r) => r.ladder).map((r) => r.arm))];
	for (const arm of arms) {
		const byIndex = new Map<number, number[]>();
		for (const r of rows)
			if (r.config === config && r.arm === arm && r.ok && r.ladder)
				for (const x of r.ladder) byIndex.set(x.i, [...(byIndex.get(x.i) ?? []), x.ms]);
		out[arm] = Object.fromEntries([...byIndex].map(([i, v]) => [i, round(median(v)!)]));
	}
	return out;
}

export function buildSummary(dir: string) {
	const raws: DurationRow[] = [];
	for (const config of ['default', 'optimized']) {
		try {
			raws.push(
				...(parseLines(
					readFileSync(join(dir, `raw-${config}.jsonl`), 'utf8')
				) as DurationRow[])
			);
		} catch {
			// config not run
		}
	}
	const arms = [...new Set(raws.map((r) => r.arm))].filter((a) => a !== 'native');
	const tables: Record<string, unknown> = {};
	const renders: Record<string, unknown> = {};
	for (const config of ['default', 'optimized']) {
		if (!raws.some((r) => r.config === config)) continue;
		tables[config] = durationTable(raws, config, arms);
		renders[config] = ladderRenders(raws, config);
	}
	const hashes: Record<string, number> = {};
	for (const r of raws.filter((x) => x.ok && x.normalizedSha256)) {
		const k = `${r.site}|${r.workload}`;
		hashes[k] = new Set(
			raws
				.filter((x) => x.ok && `${x.site}|${x.workload}` === k && x.normalizedSha256)
				.map((x) => x.normalizedSha256)
		).size;
	}
	const loads = raws
		.flatMap((r) => [r.loadStart?.[0], r.loadEnd?.[0]])
		.filter((x): x is number => x !== undefined);
	const failed = raws
		.filter((r) => !r.ok)
		.map((r) => ({
			config: r.config,
			site: r.site,
			workload: r.workload,
			rep: r.rep,
			arm: r.arm
		}));
	return {
		kind: 'translation-duration',
		gate: { name: 'G-tau', threshold: GATE_TAU, arm: 'bcd', stallRatio: STALL },
		tables,
		ladderRenderMedianMs: renders,
		renderHashesDistinct: hashes,
		failedSamples: failed,
		loadavg1: loads.length ? { min: Math.min(...loads), max: Math.max(...loads) } : null,
		samples: raws.length
	};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const dir = process.argv[2];
	if (!dir) throw new Error('usage: node translation-duration-summary.ts <study subdirectory>');
	writeFileSync(join(dir, 'summary.json'), JSON.stringify(buildSummary(dir), null, '\t') + '\n');
}
