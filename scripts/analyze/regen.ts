import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const p95 = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
};

// bound from the oracle's per-page times; arms can beat it when the oracle runs slower than them
export const spanBound = (ms: number[], width: number) =>
	Math.max(sum(ms) / width, Math.max(...ms));

// width 1 is the serial arm; every other arm is paired with the serial sample of its round
export function summarizeRegen(rows: Row[], hash: string) {
	const environment = rows.find((row) => row.kind === 'environment')!;
	const warmup = rows.find((row) => row.kind === 'warmup')!;
	const oracle = rows.find((row) => row.kind === 'oracle')!;
	const samples = rows.filter((row) => row.kind === 'sample');
	assert.ok(samples.length > 0, 'no samples');
	assert.ok(oracle && warmup, 'no oracle or warmup row');
	const serial = new Map(samples.filter((r) => r.width === 1).map((r) => [r.round, r]));
	const perUrl = oracle.perUrl as { url: string; ms: number; bytes: number }[];
	const pageMs = perUrl.map((p) => p.ms);
	const front = perUrl.find((p) => p.url === '/')!;
	const nodeMs = perUrl.filter((p) => p.url !== '/').map((p) => p.ms);
	const arms: Record<string, unknown> = {};
	for (const width of [...new Set(samples.map((r) => r.width as number))].sort((a, b) => a - b)) {
		const s = samples.filter((r) => r.width === width);
		const paired = s.filter((r) => serial.has(r.round));
		arms[width === 1 ? 'serial' : `regen-${width}`] = {
			width,
			n: s.length,
			wallMs: { ...stats(s.map((r) => r.wallMs)), p95: p95(s.map((r) => r.wallMs)) },
			speedupOverSerial: stats(paired.map((r) => serial.get(r.round)!.wallMs / r.wallMs)),
			processCpuOverSerial: stats(
				paired.map((r) => r.processCpuMs / serial.get(r.round)!.processCpuMs)
			),
			busyMaxOverMin: stats(s.map((r) => Math.max(...r.busyMs) / Math.min(...r.busyMs))),
			busyMaxMs: stats(s.map((r) => Math.max(...r.busyMs))),
			pagesPerWorkerMin: stats(s.map((r) => Math.min(...r.pagesPerWorker))),
			pagesPerWorkerMax: stats(s.map((r) => Math.max(...r.pagesPerWorker))),
			oracleBoundSpeedup: sum(pageMs) / spanBound(pageMs, width),
			maxLoad1: Math.max(...s.map((r) => r.load[0]))
		};
	}
	return {
		environment,
		measuredSamples: samples.length,
		warmup: {
			contexts: warmup.firstRenderMs.length,
			firstRenderMs: stats(warmup.firstRenderMs),
			firstOverSteadyNode: stats(warmup.firstRenderMs).median! / stats(nodeMs).median!
		},
		oracle: {
			pages: perUrl.length,
			totalMs: sum(pageMs),
			frontMs: front.ms,
			longest: perUrl.reduce((a, b) => (b.ms > a.ms ? b : a)),
			nodeMs: stats(nodeMs),
			perUrl
		},
		arms,
		hash
	};
}

export function analyzeRegen(set: string, file: string, out: string) {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = summarizeRegen(parseRows(raw), sha256(raw));
	writeFileSync(new URL(out, root), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}
