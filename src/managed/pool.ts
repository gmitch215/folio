import type { SqlStorage } from '../memory/continuation.ts';
import type { CompletionOutcome, FailureOutcome, TaskRow, TaskState, TaskValue } from './tasks.ts';
import { TaskTable } from './tasks.ts';

/** A task a lane claimed. */
export interface LaneTask {
	/** The task id. */
	id: string;
	/** The registry key to run. */
	name: string;
	/** The arguments as submitted, text or bytes. */
	args: TaskValue;
	/** The claim number of this task; a replay gets the next one. */
	attempt: number;
	/** The lease the claim granted, in milliseconds. */
	leaseMs: number;
}

/** A claimed task named by id and attempt. */
export interface LaneHold {
	/** The task id. */
	id: string;
	/** The claim number the lane holds. */
	attempt: number;
}

/**
 * What a lane calls on the coordinator. `LanePool` implements it, and a Durable Object stub that
 * forwards the four methods to a pool satisfies it.
 */
export interface LaneCoordinator {
	/** Claims up to `claimBatch` tasks, or none when nothing is ready. */
	claim(): Promise<LaneTask[]>;
	/** Writes a result. The first completion of an id wins. */
	complete(id: string, attempt: number, result: TaskValue): Promise<CompletionOutcome>;
	/** Records an error from an attempt. */
	fail(id: string, attempt: number, error: string): Promise<FailureOutcome>;
	/** Extends the leases of tasks the lane still holds; false marks a task that is no longer its own. */
	renew(holds: readonly LaneHold[]): Promise<boolean[]>;
}

/** Runs one named task. Return the result, or a promise of it; a throw fails the attempt. */
export type TaskFunction = (args: TaskValue, task: LaneTask) => TaskValue | Promise<TaskValue>;

/** The tasks a lane can run, by name. */
export type TaskRegistry = Record<string, TaskFunction>;

/** What one `work` call did. */
export interface LaneWorked {
	/** Tasks the lane claimed. */
	claimed: number;
	/** Tasks it finished and reported done. */
	completed: number;
	/** Tasks it reported as failed. */
	failed: number;
}

/** How the coordinator reaches a lane. */
export interface LaneTransport {
	/**
	 * Asks lane `lane` (0 up to `width - 1`) to work the queue. Resolves when the lane's claim
	 * comes back empty. Reject, or time out, when the lane stops answering: a call that never
	 * settles keeps its lane busy for the life of the pool.
	 */
	work(lane: number): Promise<unknown>;
	/** Releases the lanes' connections or objects. */
	close?(): Promise<void>;
}

/** Time for the pool. `sleep` resolves after `ms`, or as soon as the signal aborts. */
export interface LaneClock {
	/** Milliseconds on any clock the pool and its lanes agree on. */
	now(): number;
	/** Resolves after `ms`, or when `signal` aborts. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** A task to submit. Pass `args` or `argsJson`, not both. */
export interface TaskSpec {
	/** Unique id. Results come back in the byte order of the id. */
	id: string;
	/** Key into the lane's registry. */
	name: string;
	/** The arguments, text or bytes. */
	args?: TaskValue;
	/** Serialized with `JSON.stringify` into `args`. */
	argsJson?: unknown;
}

/** One task's outcome. */
export interface LaneResult {
	/** The task id. */
	id: string;
	/** The registry key that ran. */
	name: string;
	/** Where the task ended up. */
	state: TaskState;
	/** Claims the task took. */
	attempt: number;
	/** The raw result, once the task is done. */
	value?: TaskValue;
	/** The last error, for a failed task. */
	error?: string;
	/** The result as text. Throws unless the task is done. */
	text(): string;
	/** The result parsed as JSON. Throws unless the task is done. */
	json<T = unknown>(): T;
}

/** The state of the pool after a `run` or a `resume`. */
export interface LaneReport {
	/** Tasks waiting to be claimed. */
	queued: number;
	/** Tasks claimed and not yet reported. */
	running: number;
	/** Tasks with a result. */
	done: number;
	/** Tasks that ran out of attempts. */
	failed: number;
	/** Lane calls made since the pool was built. */
	kicks: number;
	/** Lane calls that rejected. */
	laneErrors: number;
	/** When to call `resume` again, in clock time, at least the 5 s alarm floor ahead. Unset when nothing is open. */
	wake?: number;
}

/** Options for `LanePool`. */
export interface LanePoolOptions {
	/** How lanes are called. */
	transport: LaneTransport;
	/** Lanes to use at once. */
	width: number;
	/**
	 * Lease granted to a claim, in milliseconds. Default 15,000, minimum 5,000. The alarm that
	 * calls `resume` cannot be set closer than 5 s, so a shorter lease could not be enforced
	 * sooner than that anyway. Only a task that awaits renews its lease; a synchronous task has to
	 * finish inside it.
	 */
	leaseMs?: number;
	/** Executions a task may start before it fails. Default 3. */
	maxAttempts?: number;
	/** Tasks a lane claims per call. Default 1. */
	claimBatch?: number;
	/** Time source. Defaults to `Date.now` and timers. */
	clock?: LaneClock;
	/** SQL identifier of the task table. Default `folio_tasks`. */
	table?: string;
	/**
	 * Resolves once every earlier write survives a reset; pass `() => ctx.storage.sync()` inside a
	 * Durable Object. The pool awaits it after `submit`, after a claim before the tasks reach the
	 * lane, and after a completion before it is acknowledged. Without it the pool trusts the
	 * storage to be durable at each await.
	 */
	flush?: () => Promise<void>;
}

/** A pool that cannot finish. `code` is `failed` (a task failed), `unfinished` or `stalled` (no lane claims). */
export class LanePoolError extends Error {
	/** Why the pool could not finish. */
	readonly code: 'failed' | 'unfinished' | 'stalled';

	constructor(code: 'failed' | 'unfinished' | 'stalled', detail: string, cause?: unknown) {
		super(`lane pool ${code}: ${detail}`, cause === undefined ? undefined : { cause });
		this.name = 'LanePoolError';
		this.code = code;
	}
}

const minLeaseMs = 5000;
// lane calls in a row that claim nothing while work is ready
const stallLimit = 3;

const systemClock: LaneClock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				'abort',
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true }
			);
		})
};

const isValue = (value: unknown): value is TaskValue =>
	typeof value === 'string' || value instanceof Uint8Array;

const decode = (value: TaskValue): string =>
	typeof value === 'string' ? value : new TextDecoder().decode(value);

function resultOf(row: TaskRow): LaneResult {
	const finished = () => {
		if (row.state !== 'done' || row.result === null)
			throw new LanePoolError('failed', `task ${row.id} is ${row.state}: ${row.error ?? ''}`);
		return decode(row.result);
	};
	return {
		id: row.id,
		name: row.name,
		state: row.state,
		attempt: row.attempt,
		...(row.result === null ? {} : { value: row.result }),
		...(row.error === null ? {} : { error: row.error }),
		text: finished,
		json: <T = unknown>() => JSON.parse(finished()) as T
	};
}

/**
 * The coordinator side of a durable lane pool. Tasks are rows in the object's own SQLite, lanes
 * on other objects claim them by RPC, and a lane that resets loses only the tasks it was
 * running: their leases end and the next claim replays them. A coordinator that resets loses
 * only the transitions since its last flush; build a new pool over the same storage and call
 * `run` or `resume`.
 *
 * A write is durable once an await or a flush has passed it, so the pool flushes after the three
 * transitions that must survive (enqueue, claim, complete) and before anything depends on them.
 * A failure report, a lease renewal and the expiry of a lease are not flushed: losing one only
 * brings the same replay that a lane reset brings.
 *
 * Each id's result is written once. A task body runs at least once, so the result is exactly
 * once in the table and effectively once for a task whose body is deterministic or idempotent.
 */
export class LanePool implements LaneCoordinator {
	/** The task table, for callers that read rows directly. */
	readonly table: TaskTable;
	readonly #transport: LaneTransport;
	readonly #width: number;
	readonly #leaseMs: number;
	readonly #batch: number;
	readonly #clock: LaneClock;
	readonly #flush: () => Promise<void>;
	#claims = 0;
	#kicks = 0;
	#laneErrors = 0;
	#lastError: unknown;

	constructor(sql: SqlStorage, options: LanePoolOptions) {
		const { width, leaseMs = 15000, claimBatch = 1 } = options;
		if (!Number.isInteger(width) || width < 1)
			throw new RangeError('width must be a positive integer');
		if (!Number.isInteger(leaseMs) || leaseMs < minLeaseMs)
			throw new RangeError(`leaseMs must be an integer of at least ${minLeaseMs}`);
		if (!Number.isInteger(claimBatch) || claimBatch < 1)
			throw new RangeError('claimBatch must be a positive integer');
		this.table = new TaskTable(sql, { table: options.table, maxAttempts: options.maxAttempts });
		this.#transport = options.transport;
		this.#width = width;
		this.#leaseMs = leaseMs;
		this.#batch = claimBatch;
		this.#clock = options.clock ?? systemClock;
		this.#flush = options.flush ?? (async () => {});
	}

	/**
	 * Adds tasks and returns how many were new, once they are flushed. An id that exists is
	 * ignored, so repeating a submit that failed is safe.
	 */
	async submit(tasks: readonly TaskSpec[]): Promise<number> {
		let added = 0;
		for (const task of tasks) {
			if (typeof task.id !== 'string' || !task.id) throw new TypeError('a task needs an id');
			if (typeof task.name !== 'string' || !task.name)
				throw new TypeError(`task ${task.id} needs a name`);
			if (task.args !== undefined && task.argsJson !== undefined)
				throw new TypeError('pass args or argsJson, not both');
			const args =
				task.argsJson === undefined ? (task.args ?? '') : JSON.stringify(task.argsJson);
			if (!isValue(args))
				throw new TypeError(`args of task ${task.id} must be a string or bytes`);
			if (this.table.enqueue(task.id, task.name, args)) added++;
		}
		await this.#flush();
		return added;
	}

	/**
	 * Claims up to `claimBatch` tasks for a lane and flushes the claim before it returns, so a
	 * lane never runs a task whose claim a reset could still take back. Settles poison tasks first.
	 */
	async claim(): Promise<LaneTask[]> {
		const rows = this.table.claim(this.#clock.now(), this.#leaseMs, this.#batch);
		await this.#flush();
		if (rows.length) this.#claims++;
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			args: row.args,
			attempt: row.attempt,
			leaseMs: this.#leaseMs
		}));
	}

	/** Writes a task's result unless the task is already final, and flushes before it answers. */
	async complete(id: string, attempt: number, result: TaskValue): Promise<CompletionOutcome> {
		if (!isValue(result)) throw new TypeError('a task result must be a string or bytes');
		const outcome = this.table.complete(id, attempt, result);
		await this.#flush();
		return outcome;
	}

	/** Records an error from an attempt; the task retries until `maxAttempts`. */
	async fail(id: string, attempt: number, error: string): Promise<FailureOutcome> {
		return this.table.fail(id, attempt, String(error));
	}

	/** Extends the lease of each hold that is still the task's current attempt. */
	async renew(holds: readonly LaneHold[]): Promise<boolean[]> {
		const now = this.#clock.now();
		return holds.map((hold) => this.table.renew(hold.id, hold.attempt, now, this.#leaseMs));
	}

	/**
	 * Calls lanes until every task is `done` or `failed`. Lanes that reset or return late are
	 * replayed after their leases end, so this can wait a lease length. Throws `stalled` when
	 * lanes keep returning without claiming work that is ready. Failed tasks do not throw here;
	 * read `failed` in the report, or let `fold` throw.
	 */
	async run(): Promise<LaneReport> {
		const busy = new Map<number, Promise<void>>();
		let fruitless = 0;
		for (;;) {
			const now = this.#clock.now();
			this.table.expire(now);
			const open = this.table.pending(now);
			if (open.open === 0) return this.#report(now);
			if (fruitless >= stallLimit)
				throw new LanePoolError(
					'stalled',
					`${stallLimit} lane calls in a row claimed nothing while ${open.claimable} tasks were ready`,
					this.#lastError
				);
			let wanted = Math.min(this.#width - busy.size, Math.ceil(open.claimable / this.#batch));
			for (let lane = 0; wanted > 0 && lane < this.#width; lane++) {
				if (busy.has(lane)) continue;
				wanted--;
				const before = this.#claims;
				busy.set(
					lane,
					this.#kick(lane).then(() => {
						fruitless = this.#claims === before ? fruitless + 1 : 0;
						busy.delete(lane);
					})
				);
			}
			const wake = new AbortController();
			const waits: Promise<unknown>[] = [...busy.values()];
			if (open.nextExpiry !== undefined)
				waits.push(this.#clock.sleep(open.nextExpiry - now, wake.signal));
			if (!waits.length)
				throw new LanePoolError('stalled', 'no lane is working and no lease is pending');
			await Promise.race(waits);
			wake.abort();
		}
	}

	/**
	 * One pass for an alarm: settles poison tasks, calls lanes for the work that is ready, waits
	 * for those calls and reports. `wake` says when to call again.
	 */
	async resume(): Promise<LaneReport> {
		const now = this.#clock.now();
		this.table.expire(now);
		const open = this.table.pending(now);
		const lanes = Math.min(this.#width, Math.ceil(open.claimable / this.#batch));
		await Promise.all(Array.from({ length: lanes }, (_, lane) => this.#kick(lane)));
		const after = this.#clock.now();
		this.table.expire(after);
		return this.#report(after);
	}

	/** Every task in id order, whatever its state. */
	results(): LaneResult[] {
		return this.table.snapshot().map(resultOf);
	}

	/**
	 * Folds the results in id order, whatever order the tasks finished in. Throws `unfinished`
	 * while a task is open and `failed` when one failed.
	 */
	fold<T>(combine: (acc: T, result: LaneResult, index: number) => T, init: T): T {
		const all = this.results();
		const failed = all.filter((result) => result.state === 'failed');
		if (failed.length)
			throw new LanePoolError(
				'failed',
				`${failed.length} tasks failed, first ${failed[0]!.id}: ${failed[0]!.error ?? ''}`
			);
		const open = all.filter((result) => result.state !== 'done');
		if (open.length) throw new LanePoolError('unfinished', `${open.length} tasks are not done`);
		return all.reduce((acc, result, index) => combine(acc, result, index), init);
	}

	/** Closes the transport. */
	close(): Promise<void> {
		return Promise.resolve(this.#transport.close?.());
	}

	async #kick(lane: number): Promise<void> {
		this.#kicks++;
		try {
			await this.#transport.work(lane);
		} catch (error) {
			this.#laneErrors++;
			this.#lastError = error;
		}
	}

	#report(now: number): LaneReport {
		const counts = this.table.counts();
		const wake =
			counts.queued + counts.running === 0
				? undefined
				: Math.max(this.table.pending(now).nextExpiry ?? 0, now + minLeaseMs);
		return {
			...counts,
			kicks: this.#kicks,
			laneErrors: this.#laneErrors,
			...(wake === undefined ? {} : { wake })
		};
	}
}

const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * The lane side. Returns the methods of a lane object: `work(coordinator)` claims tasks from the
 * coordinator, runs `registry[name](args)` for each and reports the result, until a claim comes
 * back empty. A task that returns a promise has its lease renewed while it runs; between the tasks
 * of one claimed batch the lane renews the ones it still holds and skips any that are no longer
 * its own. A task that throws, or names nothing in the registry, is reported as failed, and the
 * pool retries it up to `maxAttempts`. A lane that resets mid-task reports nothing, and the lease
 * ends the claim.
 */
export function serveLane(registry: TaskRegistry): {
	/** Works the queue through `coordinator` until a claim comes back empty. */
	work(coordinator: LaneCoordinator): Promise<LaneWorked>;
} {
	return {
		async work(coordinator) {
			const worked: LaneWorked = { claimed: 0, completed: 0, failed: 0 };
			for (;;) {
				const batch = await coordinator.claim();
				if (!batch.length) return worked;
				worked.claimed += batch.length;
				const held = new Map(batch.map((task) => [task.id, task]));
				const holds = () => [...held.values()].map(({ id, attempt }) => ({ id, attempt }));
				for (const [index, task] of batch.entries()) {
					if (index > 0 && held.size) {
						const before = holds();
						const kept = await coordinator.renew(before);
						before.forEach((hold, at) => {
							if (!kept[at]) held.delete(hold.id);
						});
					}
					if (!held.has(task.id)) continue;
					let timer: ReturnType<typeof setInterval> | undefined;
					let outcome: { value: TaskValue } | { error: string };
					try {
						const fn = Object.hasOwn(registry, task.name)
							? registry[task.name]
							: undefined;
						if (!fn) throw new Error(`no task named ${task.name}`);
						const pending = fn(task.args, task);
						let value: unknown = pending;
						if (typeof (pending as Promise<TaskValue>)?.then === 'function') {
							timer = setInterval(
								() => void coordinator.renew(holds()).catch(() => {}),
								Math.max(1000, Math.floor(task.leaseMs / 3))
							);
							value = await pending;
						}
						if (!isValue(value))
							throw new TypeError(
								`task ${task.name} returned neither a string nor bytes`
							);
						outcome = { value };
					} catch (error) {
						outcome = { error: message(error) };
					} finally {
						clearInterval(timer);
					}
					held.delete(task.id);
					if ('value' in outcome) {
						await coordinator.complete(task.id, task.attempt, outcome.value);
						worked.completed++;
					} else {
						await coordinator.fail(task.id, task.attempt, outcome.error);
						worked.failed++;
					}
				}
			}
		}
	};
}
