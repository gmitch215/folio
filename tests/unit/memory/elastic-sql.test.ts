import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { sqlHolder, type ElasticSql } from '../../../src/memory/elastic-sql.ts';
import { ElasticRegion } from '../../../src/memory/elastic.ts';

// the cursor shape the holder uses, over an in-memory SQLite database (as the continuation tests do)
function fakeSql(db: DatabaseSync): ElasticSql {
	return {
		exec(query, ...bindings) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value
			);
			const statement = db.prepare(query);
			const rows = /^\s*SELECT/i.test(query)
				? (statement.all(...args) as Record<string, unknown>[])
				: (statement.run(...args), []);
			return { toArray: () => rows };
		}
	};
}

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test('sqlHolder keeps chunks in rows and the region reads back exactly after a new isolate', () => {
	const chunkBytes = 4096;
	const byteLength = 8 * chunkBytes;
	const db = new DatabaseSync(':memory:');
	const holder = sqlHolder(fakeSql(db));
	const region = new ElasticRegion({ byteLength, chunkBytes, frames: 2, holder });
	const model = new Uint8Array(byteLength);
	const next = rng(11);
	for (let op = 0; op < 2000; op++) {
		const length = 1 + Math.floor(next() * chunkBytes);
		const offset = Math.floor(next() * (byteLength - length + 1));
		if (next() < 0.5) {
			const fill = Math.floor(next() * 256);
			const bytes = Uint8Array.from({ length }, (_, i) => (fill + i) & 255);
			region.write(offset, bytes);
			model.set(bytes, offset);
		}
	}
	region.flush();
	const rows = db.prepare('SELECT COUNT(*) AS n FROM folio_elastic').get() as { n: number };
	assert.ok(rows.n > 0 && rows.n <= 8);

	const fresh = new ElasticRegion({
		byteLength,
		chunkBytes,
		frames: 2,
		holder: sqlHolder(fakeSql(db))
	});
	fresh.restoreTable(region.snapshotTable());
	const whole = new Uint8Array(byteLength);
	fresh.read(0, whole);
	assert.equal(Buffer.compare(whole, model), 0);
	db.close();
});

test('sqlHolder upserts one row per (region, chunk) and separates regions', () => {
	const db = new DatabaseSync(':memory:');
	const a = sqlHolder(fakeSql(db), 'folio_elastic', 'a');
	const b = sqlHolder(fakeSql(db), 'folio_elastic', 'b');
	a.write(0, 1, new Uint8Array(4096).fill(1));
	a.write(0, 2, new Uint8Array(4096).fill(2));
	b.write(0, 1, new Uint8Array(4096).fill(3));
	const into = new Uint8Array(4096);
	assert.equal(a.read(0, into), 2);
	assert.equal(into[0], 2);
	assert.equal(b.read(0, into), 1);
	assert.equal(into[0], 3);
	assert.equal(a.read(5, into), undefined);
	const count = db.prepare('SELECT COUNT(*) AS n FROM folio_elastic').get() as { n: number };
	assert.equal(count.n, 2);
	db.close();
});

test('sqlHolder refuses a table name that is not a SQL identifier', () => {
	assert.throws(() => sqlHolder(fakeSql(new DatabaseSync(':memory:')), 'a-b'), TypeError);
});
