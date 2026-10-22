import { expect, test } from 'vitest';
import { classifyTable, parseStatement, summarizeCensus } from '../../scripts/analyze/sqlcensus.ts';

test('parseStatement reads FROM, JOIN and the write target of each verb', () => {
	expect(parseStatement('SELECT "a" FROM "node_field_data" "n" JOIN node ON 1 = 1')).toEqual({
		verb: 'SELECT',
		readTables: ['node_field_data', 'node'],
		writeTables: [],
		idAllocation: false
	});
	expect(
		parseStatement('INSERT OR REPLACE INTO `cachetags` (tag) VALUES (?)').writeTables
	).toEqual(['cachetags']);
	expect(parseStatement('UPDATE [users_field_data] SET name = ? WHERE uid = ?')).toMatchObject({
		verb: 'UPDATE',
		writeTables: ['users_field_data'],
		readTables: []
	});
});

test('parseStatement does not read the DELETE target but reads its subquery', () => {
	expect(
		parseStatement('DELETE FROM "queue" WHERE item_id IN (SELECT item_id FROM "sessions")')
	).toMatchObject({ writeTables: ['queue'], readTables: ['sessions'] });
});

test('parseStatement counts last_insert_rowid as an id allocation and ignores control verbs', () => {
	expect(parseStatement('SELECT last_insert_rowid() AS id')).toMatchObject({
		idAllocation: true,
		readTables: []
	});
	expect(parseStatement('SELECT changes()')).toMatchObject({
		idAllocation: false,
		readTables: []
	});
	for (const sql of ['SAVEPOINT x', 'RELEASE x', 'PRAGMA foreign_keys = ON']) {
		expect(parseStatement(sql)).toMatchObject({ readTables: [], writeTables: [] });
	}
});

test('parseStatement takes a schema-qualified and created table', () => {
	expect(parseStatement('CREATE TABLE "key_value_expire" ("name" TEXT)')).toMatchObject({
		writeTables: ['key_value_expire']
	});
	expect(parseStatement('SELECT 1 FROM "main"."queue"').readTables).toEqual(['queue']);
});

test('classifyTable sorts cache, counter, queue, sessions and entity tables', () => {
	expect(classifyTable('cache_render')).toBe('cache');
	expect(classifyTable('cachetags')).toBe('counter');
	expect(classifyTable('key_value_expire')).toBe('counter');
	expect(classifyTable('queue')).toBe('queue');
	expect(classifyTable('sessions')).toBe('sessions');
	expect(classifyTable('node_field_data')).toBe('entity');
});

const unit = (pass: number, unitIndex: number, statements: object[]) => ({
	kind: 'unit',
	pass,
	workload: 'synthetic',
	unit: unitIndex,
	wallMs: 10,
	sqlMs: 2,
	statements: statements.length,
	verbs: {},
	statementsLog: statements
});

const write = (table: string, key: number) => ({
	text: `UPDATE "${table}" SET title = ? WHERE nid = ?`,
	params: ['title ' + key, key],
	rows: 0,
	rowsWritten: 1,
	ms: 1
});
const read = (table: string, key: number) => ({
	text: `SELECT "x" FROM "${table}" WHERE "nid" = ?`,
	params: [key],
	rows: 1,
	rowsWritten: 0,
	ms: 1
});

test('summarizeCensus reports table-level conflicts and row-level entity conflicts', () => {
	const rows = [
		unit(1, 1, [write('node', 1), write('cachetags', 1)]),
		unit(1, 2, [write('node', 2), write('cache_render', 2)]),
		unit(1, 3, [read('node', 1)]),
		unit(2, 1, [write('node', 1)]),
		unit(2, 2, [write('node', 2)])
	];
	const { workloads } = summarizeCensus(rows);
	const s = workloads.synthetic!;
	// pass 1 has three pairs, pass 2 has one; every pair writes node, so none is conflict free
	expect(s.pairs.count).toBe(4);
	expect(s.pairs.pairsWith['ww.entity']).toBe(2);
	expect(s.pairs.pairsWith['raw.entity']).toBe(2);
	expect(s.pairs.noConflict).toBe(0);
	expect(s.rowLevel.entityTableConflicts).toBe(4);
	// writes to nid 1 and nid 2 separate; the read of nid 1 still meets unit 1's write
	expect(s.rowLevel.entityRowConflicts).toBe(1);
	expect(s.rowLevel.disappeared).toBe(3);
	expect(s.rowLevel.remainingByTable).toEqual({ node: 1 });
});

test('summarizeCensus keeps the cache and counter pairs out of the entity share', () => {
	const rows = [unit(1, 1, [write('cache_render', 1)]), unit(1, 2, [write('cache_render', 2)])];
	const s = summarizeCensus(rows).workloads.synthetic!;
	expect(s.pairs.noEntityConflict).toBe(1);
	expect(s.pairs.noConflictOutsideCacheCounter).toBe(1);
	expect(s.pairs.noConflict).toBe(0);
});

test('summarizeCensus returns null shares when a workload has one unit', () => {
	const s = summarizeCensus([unit(1, 1, [write('node', 1)])]).workloads.synthetic!;
	expect(s.pairs.count).toBe(0);
	expect(s.pairs.noConflict).toBeNull();
	expect(s.sqlShare).toBeCloseTo(0.2);
});
