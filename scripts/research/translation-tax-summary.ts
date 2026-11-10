import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { median, parseLines } from './elastic-limits-summary.ts';
import { spanReport, type PageCounts, type Regions } from './translation-span.ts';

export interface BenchRow {
	config: string;
	rep: number;
	arm: string;
	ok?: boolean;
	requestMs?: number;
	normalizedSha256?: string;
	counters?: Record<string, number>;
	hostCounts?: { slow: number; straddles: number };
	moduleBytes?: number;
	loadStart?: number[];
	loadEnd?: number[];
}

/** G-tau threshold from the plan; fixed before any measurement. */
export const GATE_TAU = 1;
/** Ratio of a sample to the median native time above which a pair is dropped as a stall. */
export const STALL = 50;

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Per-pair ratios arm over native within one repeat; tau is the ratio minus one. */
export function pairedTau(rows: BenchRow[], config: string, arm: string) {
	const ok = rows.filter((r) => r.config === config && r.ok && r.requestMs !== undefined);
	const native = new Map(ok.filter((r) => r.arm === 'native').map((r) => [r.rep, r.requestMs!]));
	const armRows = ok.filter((r) => r.arm === arm);
	const all = armRows
		.filter((r) => native.has(r.rep))
		.map((r) => ({ rep: r.rep, ms: r.requestMs!, base: native.get(r.rep)! }));
	// a sample over 50 times the median native time is a machine stall, not a measurement
	const limit = STALL * median([...native.values()])!;
	const kept = all.filter((p) => p.ms <= limit && p.base <= limit);
	const ratios = kept.map((p) => p.ms / p.base);
	if (!ratios.length) return null;
	const med = median(ratios)!;
	return {
		n: ratios.length,
		stalledPairs: all.length - kept.length,
		unfilteredMedianRatio: round(median(all.map((p) => p.ms / p.base))!),
		ms: kept.map((p) => p.ms),
		medianMs: round(median(kept.map((p) => p.ms))!),
		ratios: ratios.map(round),
		medianRatio: round(med),
		minRatio: round(Math.min(...ratios)),
		maxRatio: round(Math.max(...ratios)),
		tau: round(med - 1),
		tauMin: round(Math.min(...ratios) - 1),
		tauMax: round(Math.max(...ratios) - 1)
	};
}

/** Dynamic share of each access class from the `count` arm, and the exempt fraction. */
export function classShares(counters: Record<string, number>) {
	const names = ['stack', 'static', 'hoisted', 'checked'] as const;
	const n = Object.fromEntries(names.map((k) => [k, counters[`__folio_n_${k}`] ?? 0]));
	const total = names.reduce((sum, k) => sum + n[k]!, 0);
	return {
		counts: n,
		total,
		share: Object.fromEntries(names.map((k) => [k, total ? round(n[k]! / total) : 0])),
		exempt: total ? round((n.stack! + n.static!) / total) : 0
	};
}

export function buildSummary(dir: string) {
	const read = (path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));
	const regions: Regions = read('span/regions.json');
	const span: Record<string, unknown> = {};
	for (const w of ['front', 'admin', 'modules', 'flush']) {
		const j = read(`span/${w}.counts.json`);
		span[w] = spanReport(j.counts.request.pages as PageCounts, regions, j.finalMemoryBytes);
	}
	const raws: BenchRow[] = [];
	for (const config of ['default', 'optimized']) {
		const file = join(dir, `bench/raw-${config}.jsonl`);
		if (existsSync(file)) raws.push(...(parseLines(readFileSync(file, 'utf8')) as BenchRow[]));
	}
	const arms: Record<string, unknown> = {};
	const names = [...new Set(raws.map((r) => r.arm))].filter((a) => a !== 'native');
	const build: Record<string, unknown> = {};
	for (const name of names) {
		const file = join(dir, `arms/${name}.json`);
		if (existsSync(file)) build[name] = read(`arms/${name}.json`);
	}
	for (const config of ['default', 'optimized']) {
		const perArm: Record<string, unknown> = {};
		for (const name of names) {
			const tau = pairedTau(raws, config, name);
			if (tau) perArm[name] = tau;
		}
		const native = raws.filter((r) => r.config === config && r.arm === 'native' && r.ok);
		arms[config] = {
			native: {
				n: native.length,
				ms: native.map((r) => r.requestMs),
				medianMs: native.length ? round(median(native.map((r) => r.requestMs!))!) : null
			},
			arms: perArm
		};
	}
	// the last count row: the first ones counted the whole process, not the request
	const counted = raws.filter((r) => r.arm === 'count' && r.ok && r.counters).at(-1);
	const normalized = new Set(raws.filter((r) => r.ok).map((r) => r.normalizedSha256));
	const loads = raws
		.flatMap((r) => [r.loadStart?.[0], r.loadEnd?.[0]])
		.filter((x) => x !== undefined);
	const verdict = (config: string) => {
		const bcd = (arms[config] as any)?.arms?.bcd;
		return {
			config,
			tau: bcd?.tau ?? null,
			tauRange: bcd ? [bcd.tauMin, bcd.tauMax] : null,
			pairs: bcd?.n ?? 0,
			pass: bcd ? bcd.tau <= GATE_TAU : null
		};
	};
	return {
		kind: 'translation-tax',
		gate: {
			name: 'G-tau',
			threshold: GATE_TAU,
			arm: 'bcd',
			default: verdict('default'),
			optimized: verdict('optimized')
		},
		regions,
		span,
		classes: counted ? classShares(counted.counters!) : null,
		hostCounts: counted?.hostCounts ?? null,
		build,
		bench: arms,
		renderHashesDistinct: normalized.size,
		loadavg1: loads.length
			? { min: Math.min(...(loads as number[])), max: Math.max(...(loads as number[])) }
			: null
	};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const dir = process.argv[2];
	if (!dir) throw new Error('usage: node translation-tax-summary.ts <study dir>');
	writeFileSync(join(dir, 'summary.json'), JSON.stringify(buildSummary(dir), null, '\t') + '\n');
}
