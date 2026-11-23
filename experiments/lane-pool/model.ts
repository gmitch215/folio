import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Pair } from './plan.ts';
import { UNITS, WIDTH } from './plan.ts';

export interface Fit {
	hop: number;
	unitMs: number;
	overheadMs: number;
	pairs: number;
}

export interface Projection {
	unitMs: number;
	serialMs: number;
	poolMs: number;
	ratio: number;
}

// hop values cover the spread of the empty calls in the deployed run
export const HOPS = [198, 244, 272];
export const PROJECT_UNITS = [54, 100, 190, 234];

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[sorted.length >> 1] ?? Number.NaN;
}

// serial wall is the hop plus the units; pool wall is the hop, a fixed overhead and a lane's share
export function fit(pairs: readonly Pair[], hop: number): Fit {
	const valid = pairs.filter((p) => p.serialMs !== undefined && p.serialMs < 2000);
	const units = valid.map((p) => (p.serialMs - hop) / UNITS);
	const overheads = valid.map((p, i) => p.poolMs - hop - (UNITS / WIDTH) * (units[i] ?? 0));
	return { hop, unitMs: median(units), overheadMs: median(overheads), pairs: valid.length };
}

export function project(f: Fit, unitMs: number): Projection {
	const serialMs = f.hop + UNITS * unitMs;
	const poolMs = f.hop + f.overheadMs + (UNITS / WIDTH) * unitMs;
	return { unitMs, serialMs, poolMs, ratio: serialMs / poolMs };
}

// the unit cost at which serial over pool reaches the ratio
export function breakEven(f: Fit, ratio: number): number {
	return (ratio * (f.hop + f.overheadMs) - f.hop) / (UNITS - (ratio * UNITS) / WIDTH);
}

export function table(pairs: readonly Pair[]): string {
	const lines = [
		'hop ms | unit ms | overhead ms | ratio at ' + PROJECT_UNITS.join(', ') + ' ms units'
	];
	for (const hop of HOPS) {
		const f = fit(pairs, hop);
		const ratios = PROJECT_UNITS.map((u) => project(f, u).ratio.toFixed(2));
		lines.push(
			`${hop} | ${f.unitMs.toFixed(1)} | ${f.overheadMs.toFixed(0)} | ${ratios.join(', ')}` +
				` (1.2x at ${breakEven(f, 1.2).toFixed(0)} ms)`
		);
	}
	return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const file = process.argv[2] ?? 'results/managed/lane-pool-check1/raw-pairs.json';
	console.log(table(JSON.parse(readFileSync(file, 'utf8')) as Pair[]));
}
