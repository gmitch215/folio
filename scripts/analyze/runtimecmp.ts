import { readFileSync, writeFileSync } from 'node:fs';

type Row = { kind: string; [key: string]: any };

export function parseJsonl(text: string): Row[] {
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line));
}

const rowsOf = (rows: Row[], kind: string) => rows.filter((row) => row.kind === kind);

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

const stats = (values: number[]) => ({
	n: values.length,
	mean: sum(values) / values.length,
	min: Math.min(...values),
	max: Math.max(...values)
});

// bun over node; the ratio of means, with each side's n and spread
const ratio = (node: number[], bun: number[]) => {
	const a = stats(node);
	const b = stats(bun);
	return { node: a, bun: b, bunOverNode: b.mean / a.mean };
};

const oracleHashes = (rows: Row[]) =>
	new Map<string, string>(
		rowsOf(rows, 'oracle')[0]!.perUrl.map((u: { url: string; sha256: string }) => [
			u.url,
			u.sha256
		])
	);

const armSamples = (rows: Row[], arm: string) =>
	rowsOf(rows, 'sample').filter((row) => row.arm === arm);

const perPage = (sample: Row, value: number) => value / sample.pages;

export function compareRuntimes(node: Row[], bun: Row[]) {
	const nodeHash = oracleHashes(node);
	const bunHash = oracleHashes(bun);
	const urls = [...nodeHash.keys()];
	const mismatches = urls.filter((url) => nodeHash.get(url) !== bunHash.get(url));
	const arms = [...new Set(rowsOf(node, 'sample').map((row) => row.arm as string))];

	const steady: Record<string, unknown> = {
		oraclePageMs: ratio(
			rowsOf(node, 'oracle')[0]!.perUrl.map((u: { ms: number }) => u.ms),
			rowsOf(bun, 'oracle')[0]!.perUrl.map((u: { ms: number }) => u.ms)
		)
	};
	for (const arm of arms) {
		const n = armSamples(node, arm);
		const b = armSamples(bun, arm);
		steady[arm] = {
			busyMsPerPage: ratio(
				n.map((s) => perPage(s, sum(s.busyMs))),
				b.map((s) => perPage(s, sum(s.busyMs)))
			),
			wallMsPerPage: ratio(
				n.map((s) => perPage(s, s.wallMs)),
				b.map((s) => perPage(s, s.wallMs))
			),
			cpuMsPerPage: ratio(
				n.map((s) => perPage(s, s.processCpuMs)),
				b.map((s) => perPage(s, s.processCpuMs))
			)
		};
	}

	const opens = (rows: Row[]) => rowsOf(rows, 'environment')[0]!;
	const boots = (rows: Row[]) => opens(rows).boots.map((b: { openMs: number }) => b.openMs);

	return {
		hashes: {
			urls: urls.length,
			identical: mismatches.length === 0 && bunHash.size === urls.length,
			mismatches
		},
		warmupFirstRenderMs: ratio(
			rowsOf(node, 'warmup')[0]!.firstRenderMs,
			rowsOf(bun, 'warmup')[0]!.firstRenderMs
		),
		contextOpenMs: ratio([opens(node).contextsOpenMs], [opens(bun).contextsOpenMs]),
		bootOpenMs: ratio(boots(node), boots(bun)),
		steady
	};
}

if (import.meta.main) {
	const [nodeFile, bunFile, out] = process.argv.slice(2);
	if (!nodeFile || !bunFile || !out)
		throw new Error('usage: runtimecmp.ts NODE.jsonl BUN.jsonl OUT.json');
	const result = compareRuntimes(
		parseJsonl(readFileSync(nodeFile, 'utf8')),
		parseJsonl(readFileSync(bunFile, 'utf8'))
	);
	writeFileSync(out, JSON.stringify(result, null, '\t') + '\n');
}
