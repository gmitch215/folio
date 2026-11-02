import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { ARMS, plan, QUERIES, schedule, type Cell } from '../../experiments/sqlite-lanes/plan.ts';
import {
	catalog,
	ranges,
	shardable,
	UnsupportedQuery,
	type Range
} from '../../experiments/sqlite-lanes/queries.ts';

const SCHEMA =
	'CREATE TABLE t(id INTEGER PRIMARY KEY, k INTEGER, v INTEGER, s TEXT); CREATE TABLE u(id INTEGER PRIMARY KEY, w INTEGER);';

// the fixture rows for one id range; u is complete in every shard, as in the built images
function database(lo: number, hi: number) {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	if (hi >= lo)
		db.prepare(
			`WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x+1 FROM c WHERE x<?)
			 INSERT INTO t SELECT x, (x*7919)%100003, (x*104729)%1000003,
			   printf('%023d', x) || char(97 + x % 26) FROM c`
		).run(lo, hi);
	db.exec(
		'WITH RECURSIVE c(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM c WHERE x<999) INSERT INTO u SELECT x, (x*31+7)%1000 FROM c'
	);
	db.exec('CREATE INDEX ik ON t(k)');
	return db;
}

// the driver's text format: fields joined by '|', NULL as an empty field, one line a row
function text(db: DatabaseSync, sql: string) {
	return db
		.prepare(sql)
		.all()
		.map(
			(row) =>
				`${Object.values(row)
					.map((v) => (v === null ? '' : String(v)))
					.join('|')}\n`
		)
		.join('');
}

const lcg = (seed: number) => {
	let x = seed >>> 0;
	return () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return x / 2 ** 32;
	};
};

// contiguous, disjoint ranges of uneven size that cover 1..rows
function splits(rows: number, width: number, next: () => number): Range[] {
	const cuts = new Set<number>();
	while (cuts.size < width - 1) cuts.add(1 + Math.floor(next() * (rows - 1)));
	const edges = [0, ...[...cuts].sort((a, b) => a - b), rows];
	return edges.slice(0, -1).map((lo, i) => ({ lo: lo + 1, hi: edges[i + 1]! }));
}

test('merged shard partials equal the serial query over random splits', () => {
	const next = lcg(7);
	for (let trial = 0; trial < 20; trial++) {
		const rows = 8 + Math.floor(next() * 300);
		const width = 1 + Math.floor(next() * 6);
		const whole = database(1, rows);
		const shards = splits(rows, width, next).map((r) => ({ r, db: database(r.lo, r.hi) }));
		for (const name of QUERIES) {
			const entry = shardable(name);
			const expected = text(whole, entry.serial());
			const merged = entry.merge(shards.map(({ r, db }) => text(db, entry.partial(r))));
			assert.equal(merged, expected, `${name} rows=${rows} width=${width}`);
		}
	}
});

test('an empty shard contributes nothing and a fixed width-4 split matches the serial text', () => {
	const whole = database(1, 10);
	const empty = database(11, 10);
	const four = ranges(4, 10).map((r) => ({ r, db: database(r.lo, r.hi) }));
	for (const name of QUERIES) {
		const entry = shardable(name);
		const expected = text(whole, entry.serial());
		const withEmpty = entry.merge([
			...four.map(({ r, db }) => text(db, entry.partial(r))),
			text(empty, entry.partial({ lo: 11, hi: 10 }))
		]);
		assert.equal(withEmpty, expected, name);
	}
});

test('refuses queries with no declared merge and names it does not know', () => {
	for (const name of ['cte', 'index', 'SELECT 1', '']) {
		assert.throws(() => shardable(name), UnsupportedQuery, name);
	}
	assert.equal(shardable('range').decomposes, true);
	assert.equal(catalog.cte!.decomposes, false);
});

test('each repetition runs every query-arm cell exactly once, within the invocation cap', () => {
	const all = QUERIES.flatMap((query) => ARMS.map((arm) => `${query}/${arm}`)).sort();
	for (let rep = 0; rep < 6; rep++) {
		const cells: Cell[] = schedule(rep);
		assert.deepEqual(cells.map((c) => `${c.query}/${c.arm}`).sort(), all, `rep ${rep}`);
	}
	const p = plan();
	assert.equal(p.expected, p.topLevel + p.objects);
	assert.ok(p.withinCap, `planned ${p.expected} against ${p.cap}`);
	assert.ok(p.price.total < 0.5, `list-rate price ${p.price.total}`);
});
