import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

// table-level SQL dependence of Drupal units, parsed by regex; the row keys are a heuristic.
// usage: analyzeCensus('20261022-sqlcensus', 'census.jsonl', 'summary.json')

export interface Parsed {
	verb: string;
	readTables: string[];
	writeTables: string[];
	idAllocation: boolean;
}

export type TableClass = 'cache' | 'counter' | 'queue' | 'sessions' | 'entity';
type Kind = 'ww' | 'raw';

const control = new Set(['SAVEPOINT', 'RELEASE', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK']);
const counters = new Set(['cachetags', 'sequences', 'flood', 'semaphore', 'key_value_expire']);
// optional schema prefix, then one capture group per quoting style; nameOf picks the one that matched
const name = '(?:(?:"\\w+"|\\w+)\\.)?(?:"([^"]+)"|`([^`]+)`|\\[([^\\]]+)\\]|(\\w+))';
const readRe = new RegExp(`\\b(?:FROM|JOIN)\\s+${name}`, 'gi');
const writeRes = [
	new RegExp(`^\\s*(?:INSERT(?:\\s+OR\\s+\\w+)?|REPLACE)\\s+INTO\\s+${name}`, 'i'),
	new RegExp(`^\\s*UPDATE(?:\\s+OR\\s+\\w+)?\\s+${name}`, 'i'),
	new RegExp(`^\\s*DELETE\\s+FROM\\s+${name}`, 'i'),
	new RegExp(
		`^\\s*CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}`,
		'i'
	)
];
const nameOf = (m: RegExpMatchArray) => m.slice(1).find((g) => g !== undefined)!;
const realTable = (table: string) => !table.startsWith('sqlite_');

export function parseStatement(text: string): Parsed {
	const sql = text.trim();
	const verb = sql.split(/\s+/)[0]!.toUpperCase();
	if (/^SELECT\s+last_insert_rowid\(\)/i.test(sql))
		return { verb, readTables: [], writeTables: [], idAllocation: true };
	if (control.has(verb)) return { verb, readTables: [], writeTables: [], idAllocation: false };
	let body = sql;
	const writeTables: string[] = [];
	for (const re of writeRes) {
		const m = sql.match(re);
		if (!m) continue;
		if (realTable(nameOf(m))) writeTables.push(nameOf(m));
		body = sql.slice(m[0].length);
		break;
	}
	const readTables = new Set<string>();
	for (const m of body.matchAll(readRe)) if (realTable(nameOf(m))) readTables.add(nameOf(m));
	return { verb, readTables: [...readTables], writeTables, idAllocation: false };
}

export function classifyTable(table: string): TableClass {
	if (table.startsWith('cache_')) return 'cache';
	if (counters.has(table)) return 'counter';
	if (table === 'queue') return 'queue';
	if (table === 'sessions') return 'sessions';
	return 'entity';
}

interface Stmt extends Parsed {
	text: string;
	params: unknown[];
}

interface Digest {
	reads: Set<string>;
	writes: Set<string>;
	// row keys per table; '?' marks a statement with no usable key
	writeKeys: Map<string, Set<string>>;
	anyKeys: Map<string, Set<string>>;
}

const UNKNOWN = '?';
const addKey = (map: Map<string, Set<string>>, table: string, key: string) => {
	if (!map.has(table)) map.set(table, new Set());
	map.get(table)!.add(key);
};

/** the first non-null bound parameter, the heuristic row key */
const keyOf = (params: unknown[]) => {
	const first = params.find((p) => p !== null && p !== undefined);
	return first === undefined ? UNKNOWN : JSON.stringify(first);
};

/** an UPDATE binds its SET values before its WHERE values, so the key skips the SET ones */
const writeKeyOf = (s: Stmt) => {
	if (s.verb !== 'UPDATE') return keyOf(s.params);
	const at = s.text.search(/\sWHERE\s/i);
	if (at < 0) return UNKNOWN;
	const sets = (s.text.slice(0, at).match(/\?/g) ?? []).length;
	return keyOf(s.params.slice(sets));
};

export function digest(statements: Stmt[]): Digest {
	const d: Digest = {
		reads: new Set(),
		writes: new Set(),
		writeKeys: new Map(),
		anyKeys: new Map()
	};
	for (const s of statements) {
		for (const table of s.writeTables) {
			d.writes.add(table);
			addKey(d.writeKeys, table, writeKeyOf(s));
			addKey(d.anyKeys, table, writeKeyOf(s));
		}
		for (const table of s.readTables) {
			d.reads.add(table);
			const keyed =
				s.verb === 'SELECT' &&
				table === s.readTables[0] &&
				/\bWHERE\b[\s\S]*=\s*\?/i.test(s.text);
			addKey(d.anyKeys, table, keyed ? keyOf(s.params) : UNKNOWN);
		}
	}
	return d;
}

const CLASSES: TableClass[] = ['cache', 'counter', 'queue', 'sessions', 'entity'];

interface PairTally {
	pairs: number;
	noConflict: number;
	noEntityConflict: number;
	noConflictOutsideCacheCounter: number;
	pairsWith: Record<string, number>;
	entityTableConflicts: number;
	entityRowConflicts: number;
	remainingByTable: Record<string, number>;
}

const emptyTally = (): PairTally => ({
	remainingByTable: {},
	pairs: 0,
	noConflict: 0,
	noEntityConflict: 0,
	noConflictOutsideCacheCounter: 0,
	pairsWith: Object.fromEntries(
		(['ww', 'raw'] as Kind[]).flatMap((k) => CLASSES.map((c) => [`${k}.${c}`, 0]))
	),
	entityTableConflicts: 0,
	entityRowConflicts: 0
});

/** adds the pairs i < j of one ordered list of units (one context, one pass) */
export function addPairs(tally: PairTally, units: Digest[]) {
	for (let i = 0; i < units.length; i++)
		for (let j = i + 1; j < units.length; j++) {
			const a = units[i]!;
			const b = units[j]!;
			const seen = new Set<string>();
			let entityTable = 0;
			let entityRow = 0;
			const tables = new Set([...a.writes, ...b.writes, ...b.reads]);
			for (const table of tables) {
				let kind: Kind | undefined;
				if (a.writes.has(table) && b.writes.has(table)) kind = 'ww';
				else if (a.writes.has(table) && b.reads.has(table)) kind = 'raw';
				if (!kind) continue;
				const cls = classifyTable(table);
				seen.add(`${kind}.${cls}`);
				if (cls !== 'entity') continue;
				entityTable++;
				const left = a.writeKeys.get(table)!;
				const right = b.anyKeys.get(table) ?? new Set<string>();
				const shared = [...left].some((k) => right.has(k));
				if (left.has(UNKNOWN) || right.has(UNKNOWN) || shared) {
					entityRow++;
					tally.remainingByTable[table] = (tally.remainingByTable[table] ?? 0) + 1;
				}
			}
			tally.pairs++;
			if (seen.size === 0) tally.noConflict++;
			if (![...seen].some((k) => k.endsWith('.entity'))) tally.noEntityConflict++;
			if (![...seen].some((k) => !k.endsWith('.cache') && !k.endsWith('.counter')))
				tally.noConflictOutsideCacheCounter++;
			for (const key of seen) tally.pairsWith[key]!++;
			tally.entityTableConflicts += entityTable;
			tally.entityRowConflicts += entityRow;
		}
}

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/** one workload: units from every pass, pairs only inside a pass */
export function summarizeWorkload(units: Row[]) {
	const parsed: (Row & { stmts: Stmt[] })[] = units.map((u) => ({
		...u,
		stmts: (u.statementsLog as { text: string; params: unknown[] }[]).map((s) => ({
			...parseStatement(s.text),
			text: s.text,
			params: s.params
		}))
	}));
	const digests = parsed.map((u) => digest(u.stmts));
	const tally = emptyTally();
	for (const pass of new Set(parsed.map((u) => u.pass))) {
		const ordered = parsed
			.map((u, k) => ({ u, d: digests[k]! }))
			.filter(({ u }) => u.pass === pass)
			.sort((x, y) => x.u.unit - y.u.unit)
			.map(({ d }) => d);
		addPairs(tally, ordered);
	}
	const count = (pick: (d: Digest) => Iterable<string>) => {
		const seen = new Map<string, number>();
		for (const d of digests) for (const t of pick(d)) seen.set(t, (seen.get(t) ?? 0) + 1);
		return Object.fromEntries(
			[...seen]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([t, n]) => [t, { units: n, class: classifyTable(t) }])
		);
	};
	const written = count((d) => d.writes);
	const alwaysWritten = Object.keys(written).filter(
		(t) => (written[t] as { units: number }).units === digests.length
	);
	const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
	const wall = parsed.map((u) => u.wallMs as number);
	const sql = parsed.map((u) => u.sqlMs as number);
	const verbNames = [...new Set(parsed.flatMap((u) => Object.keys(u.verbs as object)))].sort();
	const verbsMedian = Object.fromEntries(
		verbNames.map((v) => [
			v,
			stats(parsed.map((u) => (u.verbs as Record<string, number>)[v] ?? 0)).median
		])
	);
	const ids = parsed.map((u) => u.stmts.filter((s) => s.idAllocation).length);
	return {
		units: parsed.length,
		passes: new Set(parsed.map((u) => u.pass)).size,
		wallMs: stats(wall),
		sqlMs: stats(sql),
		sqlShare: sum(sql) / sum(wall),
		statements: stats(parsed.map((u) => u.stmts.length)),
		verbsMedian,
		written,
		read: count((d) => d.reads),
		alwaysWritten,
		idAllocations: stats(ids),
		pairs: {
			count: tally.pairs,
			noConflict: share(tally.noConflict, tally.pairs),
			noEntityConflict: share(tally.noEntityConflict, tally.pairs),
			noConflictOutsideCacheCounter: share(tally.noConflictOutsideCacheCounter, tally.pairs),
			pairsWith: tally.pairsWith
		},
		rowLevel: {
			heuristic: 'first non-null bound parameter as the row key',
			entityTableConflicts: tally.entityTableConflicts,
			entityRowConflicts: tally.entityRowConflicts,
			disappeared: tally.entityTableConflicts - tally.entityRowConflicts,
			remainingByTable: tally.remainingByTable
		}
	};
}

export function summarizeCensus(rows: Row[]) {
	const units = rows.filter((r) => r.kind === 'unit');
	const names = [...new Set(units.map((u) => u.workload as string))];
	const workloads: Record<string, ReturnType<typeof summarizeWorkload>> = {};
	const shape: Record<string, unknown> = {};
	for (const name of names) {
		const mine = units.filter((u) => u.workload === name);
		workloads[name] = summarizeWorkload(mine);
		const byKey = new Map(mine.map((u) => [`${u.pass}:${u.unit}`, u]));
		const firstPass = mine.filter((u) => u.pass === 1).map((u) => u.unit as number);
		let matched = 0;
		let verbsEqual = 0;
		let setsEqual = 0;
		let statementsEqual = 0;
		for (const unit of firstPass) {
			const a = byKey.get(`1:${unit}`)!;
			const b = byKey.get(`2:${unit}`);
			if (!b) continue;
			matched++;
			if (JSON.stringify(a.verbs) === JSON.stringify(b.verbs)) verbsEqual++;
			if (a.statements === b.statements) statementsEqual++;
			const tables = (u: Row) =>
				JSON.stringify(
					u.statementsLog.map((s: { text: string }) => {
						const p = parseStatement(s.text);
						return [p.writeTables.sort(), p.readTables.sort()];
					})
				);
			if (tables(a) === tables(b)) setsEqual++;
		}
		shape[name] = {
			unitsCompared: matched,
			verbsEqual,
			statementsEqual,
			tableSetsEqual: setsEqual
		};
	}
	const multi = names.filter((n) => workloads[n]!.units >= 2);
	const alwaysWrittenAcrossWorkloads = multi.length
		? multi
				.map((n) => workloads[n]!.alwaysWritten)
				.reduce((acc, list) => acc.filter((t) => list.includes(t)))
		: [];
	return {
		workloads,
		shapeAcrossPasses: shape,
		alwaysWrittenAcrossWorkloads,
		dropped: rows
			.filter((r) => r.kind === 'dropped')
			.map(({ pass, workload, reason }) => ({
				pass,
				workload,
				reason
			})),
		preflight: rows.filter((r) => r.kind === 'preflight'),
		environment: rows.find((r) => r.kind === 'environment')
	};
}

export function analyzeCensus(set: string, file: string, out: string) {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = { ...summarizeCensus(parseRows(raw)), hash: sha256(raw) };
	writeFileSync(new URL(out, root), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}
