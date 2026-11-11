import { readFileSync, writeFileSync } from 'node:fs';
import { median, parseLines } from './elastic-limits-summary.ts';
import { GATE_TAU, pairedTau, type BenchRow } from './translation-tax-summary.ts';

export interface TauRow extends BenchRow {
	site: string;
	workload: string;
	requestCpuMs?: number;
}

/** `requestMs` is the locked instrument; main-thread CPU is a load-robust second reading and never decides the gate. */
export type Metric = 'requestMs' | 'requestCpuMs';

/** Load average over which a sample cannot support a gate claim. */
export const LOAD_LIMIT = 4;
export const MIN_PAIRS = 10;

const round = (x: number) => Math.round(x * 1000) / 1000;

function binomialCdf(n: number, upTo: number) {
	let term = 1;
	let sum = 0;
	for (let i = 0; i <= upTo; i++) {
		sum += term;
		term = (term * (n - i)) / (i + 1);
	}
	return sum / 2 ** n;
}

/** Distribution-free interval for a median: order statistics k and n + 1 - k with at least 95% coverage. */
export function medianCi(values: number[]): [number, number] | null {
	const x = [...values].sort((a, b) => a - b);
	const n = x.length;
	let k = 0;
	while (k + 1 <= n / 2 && 2 * binomialCdf(n, k) <= 0.05) k++;
	return k ? [x[k - 1]!, x[n - k]!] : null;
}

const quiet = (r: TauRow) =>
	(r.loadStart?.[0] ?? Infinity) < LOAD_LIMIT && (r.loadEnd?.[0] ?? Infinity) < LOAD_LIMIT;

/** Paired tau of one arm on one route against `baseline`, with a median interval and the load check. */
export function routeTau(
	rows: TauRow[],
	site: string,
	workload: string,
	arm: string,
	baseline = 'native',
	metric: Metric = 'requestMs'
) {
	const cell = rows
		.filter((r) => r.site === site && r.workload === workload && r.config === 'default')
		.filter((r) => r.arm === arm || r.arm === baseline)
		.map((r) => ({
			...r,
			config: 'x',
			arm: r.arm === baseline ? 'native' : r.arm,
			requestMs: r[metric]
		}));
	const tau = pairedTau(cell, 'x', arm);
	if (!tau) return null;
	const loud = cell.filter((r) => r.ok && !quiet(r)).length;
	const ci = medianCi(tau.ratios.map((x) => x - 1));
	const claimGrade = tau.n >= MIN_PAIRS && loud === 0;
	return {
		...tau,
		tauCi: ci ? ci.map(round) : null,
		samples: cell.filter((r) => r.ok).length,
		samplesAtLoadLimit: loud,
		claimGrade: claimGrade && metric === 'requestMs',
		meetsGate: claimGrade && metric === 'requestMs' && tau.tau <= GATE_TAU
	};
}

/** One entry per route and arm; the baseline of a `-zma` arm is `native-zma`. */
export function tauTable(rows: TauRow[], arms: string[]) {
	const routes = [...new Set(rows.map((r) => `${r.site}:${r.workload}`))].sort();
	return routes.map((route) => {
		const [site, workload] = route.split(':') as [string, string];
		const nativeMs = rows
			.filter((r) => r.site === site && r.workload === workload && r.arm === 'native' && r.ok)
			.map((r) => r.requestMs!);
		const out: Record<string, unknown> = {};
		const cpu: Record<string, unknown> = {};
		for (const arm of arms) {
			const base = arm.endsWith('-zma') ? 'native-zma' : 'native';
			const t = routeTau(rows, site, workload, arm, base);
			if (t) out[arm] = t;
			const c = routeTau(rows, site, workload, arm, base, 'requestCpuMs');
			if (c) cpu[arm] = c;
		}
		const hashes = rows
			.filter((r) => r.site === site && r.workload === workload && r.ok && r.normalizedSha256)
			.map((r) => r.normalizedSha256);
		return {
			route,
			nativeN: nativeMs.length,
			nativeMedianMs: nativeMs.length ? round(median(nativeMs)!) : null,
			renderHashesDistinct: new Set(hashes).size,
			arms: out,
			cpuArms: cpu
		};
	});
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	const [output, ...inputs] = process.argv.slice(2);
	if (!output || !inputs.length)
		throw new Error('usage: node translation-tau2-summary.ts out.json raw.jsonl ...');
	const rows = inputs.flatMap((f) => parseLines(readFileSync(f, 'utf8'))) as TauRow[];
	const arms = [...new Set(rows.map((r) => r.arm))].filter((a) => !a.startsWith('native'));
	writeFileSync(output, JSON.stringify(tauTable(rows, arms), null, 1) + '\n');
	console.log(`wrote ${output}: ${rows.length} rows`);
}
