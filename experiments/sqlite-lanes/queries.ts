export const FIXTURE_ROWS = 1_000_000;
export const LOOKUP_ROWS = 1000;

export interface Range {
	lo: number;
	hi: number;
}

// id ranges [lo, hi] that cover 1..rows once each, contiguous and disjoint
export function ranges(width: number, rows = FIXTURE_ROWS): Range[] {
	return Array.from({ length: width }, (_, i) => ({
		lo: 1 + Math.floor((i * rows) / width),
		hi: Math.floor(((i + 1) * rows) / width)
	}));
}

export class UnsupportedQuery extends Error {}

type Merge = (texts: string[]) => string;

interface Decomposable {
	decomposes: true;
	serial: () => string;
	partial: (range: Range) => string;
	merge: Merge;
}

interface Refused {
	decomposes: false;
	serial: () => string;
	reason: string;
}

export type Entry = Decomposable | Refused;

const where = (range: Range, lead = 'WHERE') => `${lead} id BETWEEN ${range.lo} AND ${range.hi}`;

export const catalog: Record<string, Entry> = {
	range: {
		decomposes: true,
		serial: () => 'SELECT count(*), sum(v) FROM t WHERE k BETWEEN 1000 AND 60000',
		partial: (r) =>
			`SELECT count(*), sum(v) FROM t WHERE k BETWEEN 1000 AND 60000 AND id BETWEEN ${r.lo} AND ${r.hi}`,
		merge: mergeSums
	},
	group: {
		decomposes: true,
		serial: () => 'SELECT k % 64, count(*), sum(v) FROM t GROUP BY k % 64 ORDER BY 1',
		partial: (r) =>
			`SELECT k % 64, count(*), sum(v) FROM t ${where(r)} GROUP BY k % 64 ORDER BY 1`,
		merge: mergeGroups
	},
	like: {
		decomposes: true,
		serial: () => "SELECT count(*) FROM t WHERE s LIKE '%x%'",
		partial: (r) =>
			`SELECT count(*) FROM t WHERE s LIKE '%x%' AND id BETWEEN ${r.lo} AND ${r.hi}`,
		merge: mergeCounts
	},
	join: {
		decomposes: true,
		serial: () => 'SELECT count(*), sum(t.v * u.w) FROM t JOIN u ON t.k % 1000 = u.id',
		partial: (r) =>
			`SELECT count(*), sum(t.v * u.w) FROM t JOIN u ON t.k % 1000 = u.id WHERE t.id BETWEEN ${r.lo} AND ${r.hi}`,
		merge: mergeSums
	},
	topk: {
		decomposes: true,
		serial: () => 'SELECT id, s FROM t ORDER BY s DESC LIMIT 10',
		partial: (r) => `SELECT id, s FROM t ${where(r)} ORDER BY s DESC LIMIT 10`,
		merge: mergeTopK
	},
	cte: {
		decomposes: false,
		serial: () =>
			'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<100000) SELECT count(*), sum(x) FROM c',
		reason: 'each row is produced from the previous row; the query text has no range to split'
	},
	index: {
		decomposes: false,
		serial: () => 'CREATE INDEX ik ON t(k)',
		reason: 'one b-tree build with one write cursor; no partial result can be merged into the index'
	}
};

// the whole table as one range, the form a serial arm runs so its plan matches the partials
export const wholeRange = (rows = FIXTURE_ROWS): Range => ranges(1, rows)[0]!;

// refuses names that are not in the catalog and queries with no declared merge; never guesses
export function shardable(name: string): Decomposable {
	const entry = catalog[name];
	if (!entry) throw new UnsupportedQuery(`unknown query ${JSON.stringify(name)}`);
	if (!entry.decomposes)
		throw new UnsupportedQuery(`${name} does not decompose: ${entry.reason}`);
	return entry;
}

// partial results are text rows; a NULL sum (no rows) is an empty field
function parseRows(text: string): string[][] {
	return text
		.split('\n')
		.filter((line) => line.length)
		.map((line) => line.split('|'));
}

function mergeSums(texts: string[]) {
	let count = 0n;
	let sum = 0n;
	let any = false;
	for (const text of texts) {
		for (const [c, s] of parseRows(text)) {
			count += BigInt(c!);
			if (s !== '') {
				sum += BigInt(s!);
				any = true;
			}
		}
	}
	return `${count}|${any ? sum : ''}\n`;
}

// one-column count queries reduce to a single count
function mergeCounts(texts: string[]) {
	let count = 0n;
	for (const text of texts) for (const [c] of parseRows(text)) count += BigInt(c!);
	return `${count}\n`;
}

function mergeGroups(texts: string[]) {
	const groups = new Map<string, { count: bigint; sum: bigint; any: boolean }>();
	for (const text of texts) {
		for (const [key, c, s] of parseRows(text)) {
			const entry = groups.get(key!) ?? { count: 0n, sum: 0n, any: false };
			entry.count += BigInt(c!);
			if (s !== '') {
				entry.sum += BigInt(s!);
				entry.any = true;
			}
			groups.set(key!, entry);
		}
	}
	return [...groups.keys()]
		.sort((a, b) => Number(a) - Number(b))
		.map((key) => {
			const e = groups.get(key)!;
			return `${key}|${e.count}|${e.any ? e.sum : ''}\n`;
		})
		.join('');
}

// s is unique (it carries the row number), so ties do not arise
function mergeTopK(texts: string[]) {
	const rows = texts.flatMap((text) => parseRows(text).map(([id, s]) => ({ id: id!, s: s! })));
	rows.sort((a, b) => (a.s < b.s ? 1 : a.s > b.s ? -1 : 0));
	return rows
		.slice(0, 10)
		.map(({ id, s }) => `${id}|${s}\n`)
		.join('');
}
