import { PAGE } from './programs.ts';

// the durable tier under the frames; a remote owner returns promises where these return values
export interface Backend {
	// rows written by CREATE TABLE
	setup(): number;
	read(page: number): Uint8Array | null | Promise<Uint8Array | null>;
	write(page: number, bytes: Uint8Array): void | Promise<void>;
	// deletes every row and returns how many were deleted
	clear(): number;
	readonly rowsWritten: number;
	readonly rowsRead: number;
}

export interface SqlCursor {
	toArray(): Record<string, unknown>[];
	readonly rowsWritten: number;
	readonly rowsRead: number;
}

// the shape of ctx.storage.sql
export interface Sql {
	exec(query: string, ...bindings: unknown[]): SqlCursor;
}

// the store of a resident variant: no rows, and clear deletes nothing
export class NoStore implements Backend {
	readonly rowsWritten = 0;
	readonly rowsRead = 0;
	setup() {
		return 0;
	}
	read() {
		return null;
	}
	write() {}
	clear() {
		return 0;
	}
}

export class VirtualClock {
	now = 0;
	advance(ms: number) {
		this.now += ms;
	}
}

export interface MemoryCosts {
	readMs: number;
	writeMs: number;
}

// a fake page store: rows are counted by arithmetic and its clock only moves when told to
export class MemoryBackend implements Backend {
	rowsWritten = 0;
	rowsRead = 0;
	readonly pages = new Map<number, Uint8Array>();
	private readonly rows: number;
	private readonly clock: VirtualClock;
	private readonly costs: MemoryCosts;
	private readonly schemaRows: number;
	constructor(
		rowBytes: number,
		clock = new VirtualClock(),
		costs: MemoryCosts = { readMs: 0, writeMs: 0 },
		schemaRows = 2
	) {
		this.rows = PAGE / rowBytes;
		this.clock = clock;
		this.costs = costs;
		this.schemaRows = schemaRows;
	}
	setup() {
		this.rowsWritten += this.schemaRows;
		return this.schemaRows;
	}
	read(page: number) {
		const bytes = this.pages.get(page);
		if (!bytes) return null;
		this.rowsRead += this.rows;
		this.clock.advance(this.costs.readMs);
		// stored arrays are never changed in place, so a reader gets the array itself and only reads it
		return bytes;
	}
	write(page: number, bytes: Uint8Array) {
		if (bytes.length !== PAGE) throw new RangeError('page size');
		this.pages.set(page, bytes.slice());
		this.rowsWritten += this.rows;
		this.clock.advance(this.costs.writeMs);
	}
	clear() {
		const rows = this.pages.size * this.rows;
		this.pages.clear();
		return rows;
	}
}

// the statement carries two bindings per row, and a query takes at most 100 bindings
const ROWS_PER_STATEMENT = 32;
const bytesOf = (value: unknown) =>
	value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);

// pages as rows of rowBytes in one table; row id is page * rowsPerPage + part
export class SqlBackend implements Backend {
	rowsWritten = 0;
	rowsRead = 0;
	private written = new Set<number>();
	private readonly rows: number;
	private readonly sql: Sql;
	private readonly rowBytes: number;
	private readonly wipe: () => void | Promise<void>;
	constructor(sql: Sql, rowBytes: number, wipe: () => void | Promise<void>) {
		this.rows = PAGE / rowBytes;
		this.sql = sql;
		this.rowBytes = rowBytes;
		this.wipe = wipe;
	}
	setup() {
		const cursor = this.sql.exec(
			'CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, v BLOB)'
		);
		cursor.toArray();
		this.rowsWritten += cursor.rowsWritten;
		return cursor.rowsWritten;
	}
	read(page: number) {
		const cursor =
			this.rows === 1
				? this.sql.exec('SELECT v FROM pages WHERE id = ?', page)
				: this.sql.exec(
						'SELECT v FROM pages WHERE id BETWEEN ? AND ? ORDER BY id',
						page * this.rows,
						(page + 1) * this.rows - 1
					);
		const rows = cursor.toArray();
		this.rowsRead += cursor.rowsRead;
		if (rows.length === 0) return null;
		if (rows.length !== this.rows) throw new Error(`page ${page} has ${rows.length} rows`);
		const out = new Uint8Array(PAGE);
		rows.forEach((row, k) => out.set(bytesOf(row.v), k * this.rowBytes));
		return out;
	}
	write(page: number, bytes: Uint8Array) {
		if (bytes.length !== PAGE) throw new RangeError('page size');
		for (let from = 0; from < this.rows; from += ROWS_PER_STATEMENT) {
			const count = Math.min(ROWS_PER_STATEMENT, this.rows - from);
			const bindings: unknown[] = [];
			for (let k = from; k < from + count; k++)
				bindings.push(
					page * this.rows + k,
					bytes.subarray(k * this.rowBytes, (k + 1) * this.rowBytes)
				);
			const cursor = this.sql.exec(
				`INSERT INTO pages (id, v) VALUES ${Array(count).fill('(?, ?)').join(', ')} ` +
					'ON CONFLICT(id) DO UPDATE SET v = excluded.v',
				...bindings
			);
			cursor.toArray();
			this.rowsWritten += cursor.rowsWritten;
		}
		this.written.add(page);
	}
	clear() {
		const rows = this.written.size * this.rows;
		this.written.clear();
		void this.wipe();
		return rows;
	}
}
