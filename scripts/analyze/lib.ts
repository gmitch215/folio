import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Row = Record<string, any>;

export const sha256 = (data: Uint8Array | string) =>
	createHash('sha256').update(data).digest('hex');

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

// scaling and sharing summaries keep n, min and max beside the median
export function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		n: sorted.length,
		median: sorted[Math.floor(sorted.length / 2)],
		min: sorted[0],
		max: sorted.at(-1)
	};
}

// control and affinity summaries spell the extremes out
export const spread = (values: number[]) => ({
	median: median(values),
	minimum: Math.min(...values),
	maximum: Math.max(...values)
});

export function resultsRoot(set: string) {
	assert.match(set, /^[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*$/, 'invalid measurement set');
	const base = process.env.FOLIO_RESULTS_ROOT
		? pathToFileURL(resolve(process.env.FOLIO_RESULTS_ROOT) + sep)
		: new URL('../../results/', import.meta.url);
	return new URL(`${set}/`, base);
}

export const parseRows = (raw: Buffer): Row[] =>
	raw
		.toString()
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));

export const readRaw = (root: URL, name: string) => readFileSync(new URL(name, root));

export function writeSummary(root: URL, summary: unknown, trailing = '\n') {
	writeFileSync(new URL('summary.json', root), `${JSON.stringify(summary, null, 2)}${trailing}`);
}
