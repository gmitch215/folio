import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SqlStorage } from '../../src/memory/continuation.ts';

// a Durable Object's SQL handle where a write survives a reset only once flush() has returned;
// reset() drops every write since the last flush, as a killed event does
export function crashSql(db: DatabaseSync, hooks: { beforeFlush?: () => void } = {}) {
	const cache = new Map<string, StatementSync>();
	db.exec('BEGIN');
	const sql: SqlStorage = {
		exec(query, ...bindings) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value
			);
			let statement = cache.get(query);
			if (!statement) cache.set(query, (statement = db.prepare(query)));
			const rows = /^\s*SELECT|RETURNING/i.test(query)
				? (statement.all(...args) as Record<string, unknown>[])
				: (statement.run(...args), []);
			return { toArray: () => rows };
		}
	};
	return {
		sql,
		async flush() {
			hooks.beforeFlush?.();
			db.exec('COMMIT');
			db.exec('BEGIN');
		},
		reset() {
			db.exec('ROLLBACK');
			db.exec('BEGIN');
		}
	};
}
