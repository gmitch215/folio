import type { SqlStorage } from '../memory/continuation.ts';
import type { ClaimedRow, ReplayPolicies, TaskRow, TaskValue } from './tasks.ts';
import { TaskTable } from './tasks.ts';

/** Thrown by an effect to end its row as `failed` with no retry. */
export class PermanentError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'PermanentError';
	}
}

/** What an effect receives for one attempt. */
export interface OutboxContext {
	/** The row id. */
	id: string;
	/** The kind the row was enqueued with. */
	kind: string;
	/** The claim number of this attempt; a replay gets the next one. */
	attempt: number;
	/**
	 * The idempotency key. It is the row id and is the same on every attempt, so use it as the
	 * `Message-ID` of a mail or the `Idempotency-Key` header of a request.
	 */
	key: string;
	/** The arguments as enqueued, text or bytes. */
	args: TaskValue;
}

/**
 * Runs the effect of one row. Return its result, or nothing, or a promise of either. Throw a
 * `PermanentError` when it can never succeed, and any other error when it did not happen and
 * trying again is safe.
 */
export type OutboxEffect = (context: OutboxContext) => void | TaskValue | Promise<void | TaskValue>;

/** A row to enqueue. Pass `args` or `argsJson`, not both. */
export interface OutboxItem {
	/** Unique id, which is also the idempotency key. Rows run in the byte order of the id. */
	id: string;
	/** The kind of effect, such as `mail` or `http`. It picks the replay policy. */
	kind: string;
	/** The arguments, text or bytes. */
	args?: TaskValue;
	/** Serialized with `JSON.stringify` into `args`. */
	argsJson?: unknown;
}

/** Time for the outbox. */
export interface OutboxClock {
	/** Milliseconds on any clock the outbox and its readers agree on. */
	now(): number;
}

/** What one `drain` did. */
export interface OutboxReport {
	/** Rows whose effect finished and whose result was written. */
	done: number;
	/** Rows ended as `failed` by a `PermanentError`, by their last attempt or by an exhausted lease. */
	failed: number;
	/** Rows whose effect threw and that wait for another attempt. */
	retried: number;
	/** Rows ended as `failed` because their lease ended and their kind is `report`. */
	reported: number;
}

/** What `resume` returns. */
export interface OutboxResume extends OutboxReport {
	/** When to call `resume` again, at least 5 s ahead. Unset when no row is open. */
	wake?: number;
}

/** Options for `Outbox`. */
export interface OutboxOptions {
	/** Runs the effect of a row. */
	effect: OutboxEffect;
	/**
	 * What to do with a row whose lease ended while it ran, by kind. `resend` runs the effect
	 * again. `report` ends the row as `failed` and never runs it again. A kind that is not listed
	 * is `report`.
	 */
	policies?: ReplayPolicies;
	/**
	 * Resolves once every earlier write survives a reset; pass `() => ctx.storage.sync()` inside a
	 * Durable Object. Awaited after an enqueue, after a claim before the effect, after a
	 * completion and after a failure. Without it the outbox trusts the storage to be durable at
	 * each await.
	 */
	flush?: () => Promise<void>;
	/** Time source. Defaults to `Date.now`. */
	clock?: OutboxClock;
	/** Lease of a claim, in milliseconds. Default 15,000, minimum 5,000. An effect that awaits renews it. */
	leaseMs?: number;
	/** Executions a row may start before it fails. Default 3. */
	maxAttempts?: number;
	/** Rows run at once by `drain`. Default 1. */
	width?: number;
	/** SQL identifier of the table. Default `folio_tasks`. */
	table?: string;
}

const minLeaseMs = 5000;

const isValue = (value: unknown): value is TaskValue =>
	typeof value === 'string' || value instanceof Uint8Array;

const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * A durable outbox for effects that must not be lost or repeated without notice: mail, outbound
 * requests, Redis commands, cron units. Rows live in the task table of the object's own SQLite.
 *
 * Each row goes through four steps in this order: claim, flush, effect, complete, flush. The
 * flush after the claim is what gives `report` its meaning. A reset after it leaves a running
 * row that a successor knows may have run its effect, and the successor ends it as `failed`
 * instead of running it again. A reset before it loses the claim, and nothing ran. The flush
 * after the completion keeps a finished effect from being replayed after a reset.
 *
 * So a `resend` kind runs its effect at least once and a `report` kind at most once. A reported
 * row is the operator's: it is final, and sending the effect again means a new id.
 */
export class Outbox {
	/** The task table, for callers that read rows directly. */
	readonly table: TaskTable;
	readonly #effect: OutboxEffect;
	readonly #policies: ReplayPolicies;
	readonly #flush: () => Promise<void>;
	readonly #clock: OutboxClock;
	readonly #leaseMs: number;
	readonly #width: number;

	constructor(sql: SqlStorage, options: OutboxOptions) {
		const { leaseMs = 15000, width = 1 } = options;
		if (typeof options.effect !== 'function') throw new TypeError('effect must be a function');
		if (!Number.isInteger(leaseMs) || leaseMs < minLeaseMs)
			throw new RangeError(`leaseMs must be an integer of at least ${minLeaseMs}`);
		if (!Number.isInteger(width) || width < 1)
			throw new RangeError('width must be a positive integer');
		for (const [kind, policy] of Object.entries(options.policies ?? {}))
			if (policy !== 'resend' && policy !== 'report')
				throw new TypeError(`the policy of ${kind} must be resend or report`);
		this.#policies = { ...options.policies };
		this.table = new TaskTable(sql, { table: options.table, maxAttempts: options.maxAttempts });
		this.#effect = options.effect;
		this.#flush = options.flush ?? (async () => {});
		this.#clock = options.clock ?? { now: () => Date.now() };
		this.#leaseMs = leaseMs;
		this.#width = width;
	}

	/**
	 * Adds rows and returns how many were new, once they are flushed. An id that exists is
	 * ignored, so repeating an enqueue that failed is safe.
	 */
	async enqueue(items: readonly OutboxItem[]): Promise<number> {
		let added = 0;
		for (const item of items) {
			if (typeof item.id !== 'string' || !item.id) throw new TypeError('a row needs an id');
			if (typeof item.kind !== 'string' || !item.kind)
				throw new TypeError(`row ${item.id} needs a kind`);
			if (item.args !== undefined && item.argsJson !== undefined)
				throw new TypeError('pass args or argsJson, not both');
			const args =
				item.argsJson === undefined ? (item.args ?? '') : JSON.stringify(item.argsJson);
			if (!isValue(args))
				throw new TypeError(`args of row ${item.id} must be a string or bytes`);
			if (this.table.enqueue(item.id, item.kind, args, item.kind)) added++;
		}
		await this.#flush();
		return added;
	}

	/**
	 * Runs every row that is ready, `width` at a time, and returns what happened. A row whose
	 * effect threw waits for the next `drain` instead of running again at once. Rows whose lease
	 * ended are replayed or reported by their kind first.
	 */
	async drain(): Promise<OutboxReport> {
		const report: OutboxReport = { done: 0, failed: 0, retried: 0, reported: 0 };
		const attempted: string[] = [];
		for (;;) {
			const now = this.#clock.now();
			report.reported += this.table.reportLost(now, this.#policies);
			report.failed += this.table.expire(now);
			const rows = this.table.claim(now, this.#leaseMs, this.#width, {
				policies: this.#policies,
				skip: attempted
			});
			await this.#flush();
			if (!rows.length) return report;
			attempted.push(...rows.map((row) => row.id));
			await Promise.all(rows.map((row) => this.#run(row, report)));
		}
	}

	/**
	 * One pass for an alarm: `drain`, then when to call again. `wake` is at least 5 s ahead and
	 * never before the soonest lease ends, and it is unset when no row is open.
	 */
	async resume(): Promise<OutboxResume> {
		const report = await this.drain();
		const now = this.#clock.now();
		const open = this.table.pending(now);
		return {
			...report,
			...(open.open === 0 ? {} : { wake: Math.max(open.nextExpiry ?? 0, now + minLeaseMs) })
		};
	}

	/** Every row in id order, whatever its state. */
	results(): TaskRow[] {
		return this.table.snapshot();
	}

	async #run(row: ClaimedRow, report: OutboxReport): Promise<void> {
		let timer: ReturnType<typeof setInterval> | undefined;
		let outcome: { value: TaskValue } | { error: unknown };
		try {
			const pending = this.#effect({
				id: row.id,
				kind: row.kind ?? '',
				attempt: row.attempt,
				key: row.id,
				args: row.args
			});
			let value: unknown = pending;
			if (typeof (pending as Promise<unknown>)?.then === 'function') {
				timer = setInterval(
					() => this.table.renew(row.id, row.attempt, this.#clock.now(), this.#leaseMs),
					Math.max(1000, Math.floor(this.#leaseMs / 3))
				);
				value = await pending;
			}
			// a result of the wrong type is a bug in the effect, and running it again would repeat the effect
			if (value !== undefined && !isValue(value))
				throw new PermanentError(
					`effect of kind ${row.kind} returned neither text, bytes nor nothing`
				);
			outcome = { value: value ?? '' };
		} catch (error) {
			outcome = { error };
		} finally {
			clearInterval(timer);
		}
		if ('value' in outcome) {
			const completion = this.table.complete(row.id, row.attempt, outcome.value);
			await this.#flush();
			if (completion !== 'ignored') report.done++;
			return;
		}
		const failure = this.table.fail(
			row.id,
			row.attempt,
			message(outcome.error),
			outcome.error instanceof PermanentError
		);
		await this.#flush();
		if (failure === 'retry') report.retried++;
		else if (failure === 'failed') report.failed++;
	}
}
