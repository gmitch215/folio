import type { SqlStorage } from '../memory/continuation.ts';

/** A task argument or result. Structured data travels as JSON text. */
export type TaskValue = string | Uint8Array;

/** Where a task is in its life. `done` and `failed` are final. */
export type TaskState = 'queued' | 'running' | 'done' | 'failed';

/**
 * What a successor does with a running row whose lease ended, when the earlier attempt may have
 * run its effect. `resend` runs the effect again (at least once). `report` ends the row as
 * `failed` and never runs the effect again (at most once).
 */
export type ReplayPolicy = 'resend' | 'report';

/** The replay policy of each kind. A kind that is not listed, and a row with no kind, is `report`. */
export type ReplayPolicies = Readonly<Record<string, ReplayPolicy>>;

/** One row of the task table. */
export interface TaskRow {
	/** The task id, unique in the table. */
	id: string;
	/** The registry key a lane runs. */
	name: string;
	/** The kind of effect the row carries, or null for a row with none. */
	kind: string | null;
	/** The arguments as submitted. */
	args: TaskValue;
	/** Where the row is in its life. */
	state: TaskState;
	/** Claims so far; a running row is on this attempt. */
	attempt: number;
	/** The time a running row's lease ends, in the units of the clock the caller passes. */
	leaseUntil: number | null;
	/** The result, once the row is done. */
	result: TaskValue | null;
	/** The last error, from a failed attempt or an expired last lease. */
	error: string | null;
	/** Submission order, which `claim` follows. */
	seq: number;
}

/** A row a `claim` moved to running. */
export interface ClaimedRow {
	/** The task id. */
	id: string;
	/** The registry key to run. */
	name: string;
	/** The kind of effect the row carries, or null for a row with none. */
	kind: string | null;
	/** The arguments as submitted. */
	args: TaskValue;
	/** The new attempt number. */
	attempt: number;
	/** When the new lease ends. */
	leaseUntil: number;
	/** Submission order. */
	seq: number;
}

/** What `complete` did: wrote the result of the current attempt, of a superseded one, or nothing. */
export type CompletionOutcome = 'done' | 'late' | 'ignored';

/** What `fail` did: put the row back in the queue, ended it, or nothing. */
export type FailureOutcome = 'retry' | 'failed' | 'ignored';

/** Rows still open at a moment in time. */
export interface OpenTasks {
	/** Queued rows and running rows, whatever their lease says. */
	open: number;
	/** Rows a `claim` at that time would take: queued, or running with an expired lease. */
	claimable: number;
	/** The soonest lease end after that time among running rows, if any. */
	nextExpiry?: number;
}

/** Options for `TaskTable`. */
export interface TaskTableOptions {
	/** SQL identifier of the table, `folio_tasks` by default. */
	table?: string;
	/** Executions a task may start before it fails, 3 by default. */
	maxAttempts?: number;
}

/** Options for `TaskTable.claim`. */
export interface ClaimOptions {
	/**
	 * Replay policy by kind. Without it every expired running row is claimed again. With it an
	 * expired running row is claimed again only when its kind is `resend`, and any other kind,
	 * including a row with none, is ended as `failed` instead.
	 */
	policies?: ReplayPolicies;
	/** Ids this claim must leave alone, such as rows the caller failed a moment ago. */
	skip?: readonly string[];
}

type Bound = string | number | null | ArrayBuffer;
type Row = Record<string, unknown>;

// the kinds that may be sent again, as JSON text for json_each
function resendKinds(policies: ReplayPolicies): string {
	const kinds: string[] = [];
	for (const [kind, policy] of Object.entries(policies)) {
		if (policy !== 'resend' && policy !== 'report')
			throw new TypeError(`the policy of ${kind} must be resend or report`);
		if (policy === 'resend') kinds.push(kind);
	}
	return JSON.stringify(kinds);
}

const bytesOf = (value: unknown): TaskValue =>
	typeof value === 'string'
		? value
		: value instanceof Uint8Array
			? value.slice()
			: new Uint8Array(value as ArrayBuffer).slice();

const bind = (value: TaskValue): string | ArrayBuffer =>
	typeof value === 'string' ? value : new Uint8Array(value).buffer;

function rowOf(row: Row): TaskRow {
	return {
		id: String(row.id),
		name: String(row.name),
		kind: row.kind === null ? null : String(row.kind),
		args: bytesOf(row.args),
		state: String(row.state) as TaskState,
		attempt: Number(row.attempt),
		leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
		result: row.result === null ? null : bytesOf(row.result),
		error: row.error === null ? null : String(row.error),
		seq: Number(row.seq)
	};
}

/**
 * A queue of named tasks in SQL with leases and attempt counts. Every method is one transition
 * with no I/O, and the clock is an argument, so a caller controls time and a test can replay it.
 *
 * The table has no I/O, so it cannot flush: a caller that needs a transition to survive a reset
 * awaits the storage's flush after it. Until then the transition can be lost, and no statement
 * depends on the order of the others.
 *
 * Each statement reads and writes only the row it names and moves it along one way: queued to
 * running, running back to queued or on to done or failed, never out of done or failed. A reset
 * that keeps any subset of the statements of an event, in any order, leaves every row in a state
 * that the next `claim` handles: a lost claim leaves the row queued, a lost `complete` or `fail`
 * leaves it running until its lease ends, and a lost lease renewal shortens a lease that the next
 * `renew` or a replay corrects.
 *
 * One rule changes when `claim` gets `policies`: a running row whose lease ended is claimed again
 * only if its kind is `resend`. The `claim` statement itself carries that test, so it holds even
 * when the statement that ends `report` rows was lost, and a `report` row is never claimed twice.
 */
export class TaskTable {
	readonly #sql: SqlStorage;
	readonly #table: string;
	readonly #maxAttempts: number;

	constructor(sql: SqlStorage, options: TaskTableOptions = {}) {
		const table = options.table ?? 'folio_tasks';
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
			throw new TypeError('table must be a SQL identifier');
		const maxAttempts = options.maxAttempts ?? 3;
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
			throw new RangeError('maxAttempts must be a positive integer');
		this.#sql = sql;
		this.#table = table;
		this.#maxAttempts = maxAttempts;
		// args and result carry no type, so a string stays text and bytes stay a blob
		this.#run(
			`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, args, state TEXT NOT NULL, attempt INTEGER NOT NULL, lease_until INTEGER, result, error TEXT, seq INTEGER NOT NULL)`
		);
		// a table made before the kind column existed keeps its rows
		const columns = this.#run(`SELECT name FROM pragma_table_info(?)`, table);
		if (!columns.some((column) => column.name === 'kind'))
			this.#run(`ALTER TABLE ${table} ADD COLUMN kind TEXT`);
	}

	/** Executions a task may start before it fails. */
	get maxAttempts(): number {
		return this.#maxAttempts;
	}

	#run(query: string, ...bindings: Bound[]): Row[] {
		return this.#sql.exec(query, ...bindings).toArray();
	}

	/**
	 * Adds a queued task, with the kind of effect it carries if any. Returns false and changes
	 * nothing when the id exists.
	 */
	enqueue(id: string, name: string, args: TaskValue = '', kind?: string): boolean {
		return (
			this.#run(
				`INSERT OR IGNORE INTO ${this.#table} (id, name, kind, args, state, attempt, lease_until, result, error, seq) VALUES (?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${this.#table})) RETURNING id`,
				id,
				name,
				kind ?? null,
				bind(args)
			).length === 1
		);
	}

	/**
	 * Ends the running rows whose lease ended and whose kind is not `resend`, so that no later
	 * claim runs their effect again, and returns how many. The error names the policy and the
	 * attempt that was lost. `expire` and `claim` do this when they get policies.
	 */
	reportLost(now: number, policies: ReplayPolicies): number {
		return this.#run(
			`UPDATE ${this.#table} SET state = 'failed', lease_until = NULL, error = 'lease expired on attempt ' || attempt || ' of ' || COALESCE('kind ' || kind, 'a row with no kind') || ': policy report, the effect may have run and is not run again' WHERE state = 'running' AND lease_until <= ? AND (kind IS NULL OR kind NOT IN (SELECT value FROM json_each(?))) RETURNING id`,
			now,
			resendKinds(policies)
		).length;
	}

	/**
	 * Fails the running rows whose lease ended after their last allowed attempt and returns how
	 * many. `claim` does this first; call it alone to settle poison rows when nothing will claim.
	 * With `policies` it also ends the rows `reportLost` names, and counts them.
	 */
	expire(now: number, policies?: ReplayPolicies): number {
		const reported = policies ? this.reportLost(now, policies) : 0;
		return (
			reported +
			this.#run(
				`UPDATE ${this.#table} SET state = 'failed', lease_until = NULL, error = ? WHERE state = 'running' AND lease_until <= ? AND attempt >= ? RETURNING id`,
				`lease expired after ${this.#maxAttempts} attempts`,
				now,
				this.#maxAttempts
			).length
		);
	}

	/**
	 * Starts up to `limit` rows, oldest `seq` first: queued rows and running rows whose lease ended.
	 * Each gets the next attempt number and a lease of `leaseMs` from `now`. A running row whose
	 * lease ended on its last allowed attempt becomes `failed` instead, and so does one whose kind
	 * is not `resend` when `options.policies` is given.
	 */
	claim(now: number, leaseMs: number, limit: number, options: ClaimOptions = {}): ClaimedRow[] {
		const { policies, skip } = options;
		this.expire(now, policies);
		const bindings: Bound[] = [now + leaseMs, this.#maxAttempts, now];
		let expired = '';
		if (policies) {
			expired = ' AND kind IN (SELECT value FROM json_each(?))';
			bindings.push(resendKinds(policies));
		}
		let skipped = '';
		if (skip?.length) {
			skipped = ' AND id NOT IN (SELECT value FROM json_each(?))';
			bindings.push(JSON.stringify(skip));
		}
		return this.#run(
			`UPDATE ${this.#table} SET state = 'running', attempt = attempt + 1, lease_until = ? WHERE id IN (SELECT id FROM ${this.#table} WHERE attempt < ? AND (state = 'queued' OR (state = 'running' AND lease_until <= ?${expired}))${skipped} ORDER BY seq LIMIT ?) RETURNING id, name, kind, args, attempt, lease_until, seq`,
			...bindings,
			limit
		)
			.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				kind: row.kind === null ? null : String(row.kind),
				args: bytesOf(row.args),
				attempt: Number(row.attempt),
				leaseUntil: Number(row.lease_until),
				seq: Number(row.seq)
			}))
			.sort((a, b) => a.seq - b.seq);
	}

	/**
	 * Writes the result of any attempt unless the row is already final, so the first completion
	 * wins and a second one changes nothing. `done` means the attempt was the row's current one,
	 * `late` that a superseded attempt finished first. The result is the same for a task whose
	 * body is deterministic.
	 */
	complete(id: string, attempt: number, result: TaskValue): CompletionOutcome {
		const rows = this.#run(
			`UPDATE ${this.#table} SET state = 'done', result = ?, error = NULL, lease_until = NULL WHERE id = ? AND state IN ('queued', 'running') RETURNING attempt`,
			bind(result),
			id
		);
		if (!rows.length) return 'ignored';
		return Number(rows[0]!.attempt) === attempt ? 'done' : 'late';
	}

	/**
	 * Records an error from the row's current attempt: back to `queued` while attempts remain,
	 * `failed` on the last one, or at once when `final` is true. A failure from a superseded
	 * attempt changes nothing.
	 */
	fail(id: string, attempt: number, error: string, final = false): FailureOutcome {
		const rows = this.#run(
			`UPDATE ${this.#table} SET state = CASE WHEN ? OR attempt >= ? THEN 'failed' ELSE 'queued' END, error = ?, lease_until = NULL WHERE id = ? AND attempt = ? AND state = 'running' RETURNING state`,
			final ? 1 : 0,
			this.#maxAttempts,
			error,
			id,
			attempt
		);
		if (!rows.length) return 'ignored';
		return rows[0]!.state === 'failed' ? 'failed' : 'retry';
	}

	/** Moves a running row's lease to `leaseMs` after `now`, never earlier. False for any other row or attempt. */
	renew(id: string, attempt: number, now: number, leaseMs: number): boolean {
		return (
			this.#run(
				`UPDATE ${this.#table} SET lease_until = MAX(lease_until, ?) WHERE id = ? AND attempt = ? AND state = 'running' RETURNING id`,
				now + leaseMs,
				id,
				attempt
			).length === 1
		);
	}

	/** Counts the rows that are not final at `now`. */
	pending(now: number): OpenTasks {
		const row = this.#run(
			`SELECT COUNT(*) AS open, COALESCE(SUM((state = 'queued' OR lease_until <= ?) AND attempt < ?), 0) AS claimable, MIN(CASE WHEN state = 'running' AND lease_until > ? THEN lease_until END) AS next FROM ${this.#table} WHERE state IN ('queued', 'running')`,
			now,
			this.#maxAttempts,
			now
		)[0]!;
		return {
			open: Number(row.open),
			claimable: Number(row.claimable),
			...(row.next === null ? {} : { nextExpiry: Number(row.next) })
		};
	}

	/** Rows per state. */
	counts(): Record<TaskState, number> {
		const counts = { queued: 0, running: 0, done: 0, failed: 0 };
		for (const row of this.#run(
			`SELECT state, COUNT(*) AS n FROM ${this.#table} GROUP BY state`
		))
			counts[String(row.state) as TaskState] = Number(row.n);
		return counts;
	}

	/** Every row in id order, which is the byte order of the id. */
	snapshot(): TaskRow[] {
		return this.#run(`SELECT * FROM ${this.#table} ORDER BY id`).map(rowOf);
	}
}
