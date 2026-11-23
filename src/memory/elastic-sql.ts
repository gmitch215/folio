import type { SyncHolder } from './elastic.ts';

/** The subset of a Durable Object SQL handle this module uses. */
export interface ElasticSql {
	exec(
		query: string,
		...bindings: (string | number | ArrayBuffer)[]
	): {
		toArray(): Record<string, unknown>[];
	};
}

/**
 * A `SyncHolder` over one SQL table, one row per (region, chunk). The table is created on first use.
 */
export function sqlHolder(
	sql: ElasticSql,
	table = 'folio_elastic',
	region = 'default'
): SyncHolder {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
		throw new TypeError('table must be a SQL identifier');
	let ready = false;
	const ensure = (): void => {
		if (ready) return;
		sql.exec(
			`CREATE TABLE IF NOT EXISTS ${table} (region TEXT NOT NULL, idx INTEGER NOT NULL, version INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (region, idx))`
		).toArray();
		ready = true;
	};
	return {
		read(index, into) {
			ensure();
			const row = sql
				.exec(
					`SELECT version, bytes FROM ${table} WHERE region = ? AND idx = ?`,
					region,
					index
				)
				.toArray()[0];
			if (!row) return undefined;
			const bytes =
				row.bytes instanceof Uint8Array
					? row.bytes
					: new Uint8Array(row.bytes as ArrayBuffer);
			if (bytes.length !== into.length)
				throw new RangeError(
					`chunk ${index} holds ${bytes.length} bytes, expected ${into.length}`
				);
			into.set(bytes);
			return Number(row.version);
		},
		write(index, version, bytes) {
			ensure();
			sql.exec(
				`INSERT INTO ${table} (region, idx, version, bytes) VALUES (?, ?, ?, ?) ON CONFLICT (region, idx) DO UPDATE SET version = excluded.version, bytes = excluded.bytes`,
				region,
				index,
				version,
				bytes.slice().buffer as ArrayBuffer
			).toArray();
		}
	};
}
