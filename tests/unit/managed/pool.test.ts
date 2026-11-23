import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { afterEach, test, vi } from 'vitest';
import {
	LanePool,
	LanePoolError,
	serveLane,
	type LaneClock,
	type LaneCoordinator,
	type LaneTask,
	type TaskRegistry,
	type TaskSpec
} from '../../../src/managed/pool.ts';
import type { SqlStorage } from '../../../src/memory/continuation.ts';
import { crashSql } from '../../helpers/crash-sql.ts';

function fakeSql(db: DatabaseSync): SqlStorage {
	const cache = new Map<string, StatementSync>();
	return {
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
}

// time that moves only when every promise is waiting on it
class VirtualClock implements LaneClock {
	t = 0;
	readonly #timers: { at: number; wake(): void }[] = [];

	now() {
		return this.t;
	}

	sleep(ms: number, signal?: AbortSignal) {
		return new Promise<void>((resolve) => {
			const timer = { at: this.t + ms, wake: resolve };
			this.#timers.push(timer);
			signal?.addEventListener(
				'abort',
				() => {
					this.#timers.splice(this.#timers.indexOf(timer) >>> 0, 1);
					resolve();
				},
				{ once: true }
			);
		});
	}

	step() {
		if (!this.#timers.length) return false;
		this.#timers.sort((a, b) => a.at - b.at);
		const next = this.#timers.shift()!;
		this.t = Math.max(this.t, next.at);
		next.wake();
		return true;
	}
}

async function drive<T>(clock: VirtualClock, promise: Promise<T>): Promise<T> {
	let settled: { value: T } | { error: unknown } | undefined;
	promise.then(
		(value) => (settled = { value }),
		(error) => (settled = { error })
	);
	while (!settled) {
		await new Promise((resolve) => setImmediate(resolve));
		if (!settled && !clock.step()) throw new Error('nothing is waiting on the clock');
	}
	if ('error' in settled) throw settled.error;
	return settled.value;
}

type Fault = 'crash' | 'late' | 'hang';

interface RigOptions {
	count?: number;
	width?: number;
	maxAttempts?: number;
	leaseMs?: number;
	claimBatch?: number;
	// faults by `id#attempt`, or `id#*` for every attempt
	faults?: Record<string, Fault>;
	// ids whose body throws, by `id#attempt` or `id#*`
	throws?: string[];
	duration?(id: string): number;
	db?: DatabaseSync;
	clock?: VirtualClock;
}

function rig(options: RigOptions = {}) {
	const { count = 6, width = 3, leaseMs = 6000 } = options;
	const clock = options.clock ?? new VirtualClock();
	const db = options.db ?? new DatabaseSync(':memory:');
	const runs = new Map<string, number>();
	const outcomes: string[] = [];
	const finished: string[] = [];
	const fault = (id: string, attempt: number) =>
		options.faults?.[`${id}#${attempt}`] ?? options.faults?.[`${id}#*`];
	const registry: TaskRegistry = {
		square: async (args, task) => {
			runs.set(task.id, (runs.get(task.id) ?? 0) + 1);
			await clock.sleep(options.duration?.(task.id) ?? 100);
			if (
				options.throws?.some(
					(key) => key === `${task.id}#${task.attempt}` || key === `${task.id}#*`
				)
			)
				throw new Error('boom');
			finished.push(task.id);
			return String(Number(args) ** 2);
		}
	};
	const lane = serveLane(registry);
	let pool!: LanePool;
	const coordinator = (): LaneCoordinator => ({
		claim: () => pool.claim(),
		fail: (id, attempt, error) => pool.fail(id, attempt, error),
		renew: (holds) => pool.renew(holds),
		async complete(id, attempt, result) {
			const failure = fault(id, attempt);
			if (failure === 'crash') throw new Error('lane reset');
			if (failure === 'hang') return new Promise<never>(() => {});
			if (failure === 'late') await clock.sleep(leaseMs * 2);
			const outcome = await pool.complete(id, attempt, result);
			outcomes.push(`${id}:${outcome}`);
			return outcome;
		}
	});
	const make = (sql = fakeSql(db)) =>
		new LanePool(sql, {
			width,
			leaseMs,
			maxAttempts: options.maxAttempts,
			claimBatch: options.claimBatch,
			clock,
			transport: { work: (index) => lane.work(coordinator()).then(() => index) }
		});
	pool = make();
	const ids = Array.from({ length: count }, (_, i) => `t${String(i).padStart(2, '0')}`);
	const specs: TaskSpec[] = ids.map((id, i) => ({ id, name: 'square', args: String(i) }));
	return {
		clock,
		db,
		runs,
		outcomes,
		finished,
		ids,
		specs,
		make,
		get pool() {
			return pool;
		},
		// a coordinator that resets: the pool is rebuilt over the same storage
		reset() {
			pool = make();
			return pool;
		}
	};
}

type Rig = ReturnType<typeof rig>;

// every task done once, with its own square, and one accepted completion per id
function expectComplete(r: Rig) {
	const rows = r.pool.table.snapshot();
	assert.deepEqual(
		rows.map((row) => [row.id, row.state, row.result]),
		r.ids.map((id, i) => [id, 'done', String(i * i)])
	);
	const accepted = r.outcomes
		.filter((entry) => !entry.endsWith(':ignored'))
		.map((e) => e.split(':')[0]);
	assert.deepEqual([...accepted].sort(), r.ids);
}

afterEach(() => {
	vi.useRealTimers();
});

test('every task finishes once, and results and fold follow id order whatever the finishing order', async () => {
	const r = rig({ count: 8, width: 4, duration: (id) => 1000 - Number(id.slice(1)) * 100 });
	await r.pool.submit(r.specs);
	const report = await drive(r.clock, r.pool.run());
	assert.equal(report.done, 8);
	assert.equal(report.failed, 0);
	assert.equal(report.laneErrors, 0);
	assert.equal(report.wake, undefined);
	expectComplete(r);
	assert.notDeepEqual(r.finished, r.ids);
	assert.deepEqual(
		r.pool.results().map((result) => result.id),
		r.ids
	);
	assert.equal(
		r.pool.fold((acc, result) => `${acc}${result.text()},`, ''),
		'0,1,4,9,16,25,36,49,'
	);
	assert.equal(
		r.pool.fold((acc, result) => acc + result.json<number>(), 0),
		140
	);
});

test('a lane that resets after the body is replayed, and the task is done once', async () => {
	const r = rig({ faults: { 't02#1': 'crash' } });
	await r.pool.submit(r.specs);
	const report = await drive(r.clock, r.pool.run());
	assert.equal(report.laneErrors, 1);
	assert.equal(r.runs.get('t02'), 2);
	assert.equal(r.pool.table.snapshot().find((row) => row.id === 't02')!.attempt, 2);
	for (const id of r.ids.filter((id) => id !== 't02')) assert.equal(r.runs.get(id), 1, id);
	expectComplete(r);
});

test('a task that throws is retried and finishes on a later attempt', async () => {
	const r = rig({ throws: ['t01#1', 't01#2'] });
	await r.pool.submit(r.specs);
	await drive(r.clock, r.pool.run());
	assert.equal(r.runs.get('t01'), 3);
	expectComplete(r);
});

test('a lane that returns after its lease ended loses to the replay', async () => {
	const r = rig({ width: 2, count: 4, faults: { 't01#1': 'late' } });
	await r.pool.submit(r.specs);
	await drive(r.clock, r.pool.run());
	assert.equal(r.runs.get('t01'), 2);
	// the late lane reports after the run has returned
	while (r.clock.step()) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(r.outcomes.filter((entry) => entry === 't01:ignored').length, 1);
	assert.equal(r.outcomes.filter((entry) => entry === 't01:done').length, 1);
	expectComplete(r);
});

test('a lane that never returns does not stop the others from replaying its task', async () => {
	const r = rig({ width: 2, count: 4, faults: { 't00#1': 'hang' } });
	await r.pool.submit(r.specs);
	const report = await drive(r.clock, r.pool.run());
	assert.equal(report.done, 4);
	assert.equal(r.runs.get('t00'), 2);
	expectComplete(r);
});

test('a poison task fails after maxAttempts and the rest still finish', async () => {
	for (const kind of ['crash', 'throw'] as const) {
		const r = rig({
			maxAttempts: 3,
			...(kind === 'crash'
				? { faults: { 't03#*': 'crash' as const } }
				: { throws: ['t03#*'] })
		});
		await r.pool.submit(r.specs);
		const report = await drive(r.clock, r.pool.run());
		assert.equal(report.failed, 1, kind);
		assert.equal(report.done, 5, kind);
		assert.equal(r.runs.get('t03'), 3, kind);
		const poison = r.pool.results().find((result) => result.id === 't03')!;
		assert.equal(poison.state, 'failed');
		assert.ok(poison.error);
		assert.throws(() => poison.text(), LanePoolError);
		assert.throws(
			() => r.pool.fold((acc) => acc, 0),
			(error: unknown) => error instanceof LanePoolError && error.code === 'failed'
		);
	}
});

test('a coordinator that resets between claim and lane start loses nothing', async () => {
	const r = rig({ count: 3, width: 2 });
	await r.pool.submit(r.specs);
	// the claim committed, then the coordinator reset before any lane ran the task
	const [held] = await r.pool.claim();
	const next = r.reset();
	assert.equal(next.table.snapshot().find((row) => row.id === held!.id)!.state, 'running');
	await drive(r.clock, next.run());
	expectComplete(r);
	assert.equal(r.runs.get(held!.id), 1);
	assert.equal(next.table.snapshot().find((row) => row.id === held!.id)!.attempt, 2);
});

test('a lane that holds a claim across a coordinator reset still completes it', async () => {
	const r = rig({ count: 1, width: 1 });
	await r.pool.submit(r.specs);
	const [held] = await r.pool.claim();
	const next = r.reset();
	assert.equal(await next.complete(held!.id, held!.attempt, '0'), 'done');
	assert.equal(await next.complete(held!.id, held!.attempt, 'again'), 'ignored');
	assert.equal(next.table.counts().done, 1);
	assert.equal((await drive(r.clock, next.run())).done, 1);
});

test('resume makes one pass and says when to come back', async () => {
	const r = rig({ count: 3, width: 3, faults: { 't01#1': 'crash' } });
	await r.pool.submit(r.specs);
	const first = await drive(r.clock, r.pool.resume());
	assert.equal(first.done, 2);
	assert.equal(first.running, 1);
	assert.equal(first.laneErrors, 1);
	assert.ok(first.wake! >= r.clock.t + 5000);
	assert.ok(first.wake! >= 6000);
	// the alarm fires: a new coordinator object continues from the table
	r.clock.t = first.wake!;
	const second = await drive(r.clock, r.reset().resume());
	assert.equal(second.done, 3);
	assert.equal(second.wake, undefined);
	expectComplete(r);
	const idle = await drive(r.clock, r.pool.resume());
	assert.equal(idle.kicks, second.kicks);
});

test('resume settles a poison task that no lane will claim again', async () => {
	const r = rig({ count: 1, width: 1, maxAttempts: 1, faults: { 't00#1': 'crash' } });
	await r.pool.submit(r.specs);
	const first = await drive(r.clock, r.pool.resume());
	assert.equal(first.running, 1);
	r.clock.t = first.wake!;
	const second = await drive(r.clock, r.pool.resume());
	assert.equal(second.failed, 1);
	assert.equal(second.wake, undefined);
});

test('claimBatch hands a lane several tasks and it renews the ones it still holds', async () => {
	const r = rig({ count: 6, width: 2, claimBatch: 3 });
	await r.pool.submit(r.specs);
	const renewals: number[] = [];
	const renew = r.pool.renew.bind(r.pool);
	r.pool.renew = async (holds) => (renewals.push(holds.length), renew(holds));
	await drive(r.clock, r.pool.run());
	assert.deepEqual(renewals.sort(), [1, 1, 2, 2]);
	expectComplete(r);
});

test('run throws stalled when lanes keep returning without claiming', async () => {
	const clock = new VirtualClock();
	const sql = fakeSql(new DatabaseSync(':memory:'));
	const quiet = new LanePool(sql, { width: 2, clock, transport: { work: async () => {} } });
	await quiet.submit([{ id: 'a', name: 'f' }]);
	await assert.rejects(
		drive(clock, quiet.run()),
		(error: unknown) => error instanceof LanePoolError && error.code === 'stalled'
	);
	const broken = new LanePool(fakeSql(new DatabaseSync(':memory:')), {
		width: 1,
		clock,
		transport: { work: async () => Promise.reject(new Error('unreachable')) }
	});
	await broken.submit([{ id: 'a', name: 'f' }]);
	await assert.rejects(
		drive(clock, broken.run()),
		(error: unknown) =>
			error instanceof LanePoolError &&
			error.code === 'stalled' &&
			(error.cause as Error).message === 'unreachable'
	);
});

test('run on an empty table returns at once, and close closes the transport', async () => {
	let closed = 0;
	const pool = new LanePool(fakeSql(new DatabaseSync(':memory:')), {
		width: 1,
		transport: {
			work: async () => {},
			close: async () => void closed++
		}
	});
	assert.deepEqual(await pool.run(), {
		queued: 0,
		running: 0,
		done: 0,
		failed: 0,
		kicks: 0,
		laneErrors: 0
	});
	await pool.close();
	assert.equal(closed, 1);
});

test('submit ignores a repeated id, takes JSON arguments and refuses bad specs', async () => {
	const pool = new LanePool(fakeSql(new DatabaseSync(':memory:')), {
		width: 1,
		transport: { work: async () => {} }
	});
	assert.equal(
		await pool.submit([
			{ id: 'a', name: 'f', argsJson: { n: 1 } },
			{ id: 'b', name: 'f', args: new Uint8Array([9]) },
			{ id: 'c', name: 'f' }
		]),
		3
	);
	assert.equal(await pool.submit([{ id: 'a', name: 'f' }]), 0);
	const rows = pool.table.snapshot();
	assert.equal(rows[0]!.args, '{"n":1}');
	assert.deepEqual(rows[1]!.args, new Uint8Array([9]));
	assert.equal(rows[2]!.args, '');
	await assert.rejects(pool.submit([{ id: '', name: 'f' }]), TypeError);
	await assert.rejects(pool.submit([{ id: 'x', name: '' }]), TypeError);
	await assert.rejects(pool.submit([{ id: 'x', name: 'f', args: '1', argsJson: 1 }]), TypeError);
	await assert.rejects(
		pool.submit([{ id: 'x', name: 'f', args: 5 as unknown as string }]),
		TypeError
	);
});

test('the pool refuses a lease under 5 s, a width or batch of zero and a result that is not text or bytes', async () => {
	const sql = fakeSql(new DatabaseSync(':memory:'));
	const transport = { work: async () => {} };
	assert.throws(() => new LanePool(sql, { width: 1, transport, leaseMs: 4999 }), RangeError);
	assert.throws(() => new LanePool(sql, { width: 0, transport }), RangeError);
	assert.throws(() => new LanePool(sql, { width: 1, transport, claimBatch: 0 }), RangeError);
	const pool = new LanePool(sql, { width: 1, transport, leaseMs: 5000 });
	await assert.rejects(pool.complete('a', 1, 5 as unknown as string), TypeError);
	assert.deepEqual(await pool.fail('missing', 1, 'x'), 'ignored');
	assert.deepEqual(await pool.renew([{ id: 'missing', attempt: 1 }]), [false]);
});

test('fold refuses while a task is open', async () => {
	const pool = new LanePool(fakeSql(new DatabaseSync(':memory:')), {
		width: 1,
		transport: { work: async () => {} }
	});
	await pool.submit([{ id: 'a', name: 'f' }]);
	assert.throws(
		() => pool.fold((acc) => acc, 0),
		(error: unknown) => error instanceof LanePoolError && error.code === 'unfinished'
	);
});

// the lane side against a recording coordinator
function recorder(batches: LaneTask[][]) {
	const log: string[] = [];
	const queue = [...batches];
	const coordinator: LaneCoordinator = {
		async claim() {
			return queue.shift() ?? [];
		},
		async complete(id, attempt, result) {
			log.push(
				`complete ${id}#${attempt} ${typeof result === 'string' ? result : [...result]}`
			);
			return 'done';
		},
		async fail(id, attempt, error) {
			log.push(`fail ${id}#${attempt} ${error}`);
			return 'retry';
		},
		async renew(holds) {
			log.push(`renew ${holds.map((hold) => hold.id).join(',')}`);
			return holds.map((hold) => hold.id !== 'gone');
		}
	};
	return { log, coordinator };
}

const task = (id: string, name: string, args = '', attempt = 1): LaneTask => ({
	id,
	name,
	args,
	attempt,
	leaseMs: 6000
});

test('a lane reports a throw, an unknown name, a bad result and names that sit on the prototype as failures', async () => {
	const lane = serveLane({
		boom: () => {
			throw new Error('bad input');
		},
		wrong: (() => 5) as unknown as () => string,
		bytes: () => new Uint8Array([1, 2])
	});
	const { log, coordinator } = recorder([
		[
			task('a', 'boom'),
			task('b', 'missing'),
			task('c', 'wrong'),
			task('d', 'toString'),
			task('e', 'bytes')
		]
	]);
	assert.deepEqual(await lane.work(coordinator), { claimed: 5, completed: 1, failed: 4 });
	assert.deepEqual(
		log.filter((entry) => !entry.startsWith('renew')),
		[
			'fail a#1 bad input',
			'fail b#1 no task named missing',
			'fail c#1 task wrong returned neither a string nor bytes',
			'fail d#1 no task named toString',
			'complete e#1 1,2'
		]
	);
});

test('a lane skips a batched task that its renewal says is no longer its own', async () => {
	const ran: string[] = [];
	const lane = serveLane({
		f: (args) => {
			ran.push(String(args));
			return args;
		}
	});
	const { log, coordinator } = recorder([
		[task('a', 'f', 'a'), task('gone', 'f', 'gone'), task('c', 'f', 'c')]
	]);
	await lane.work(coordinator);
	assert.deepEqual(ran, ['a', 'c']);
	assert.deepEqual(log, ['complete a#1 a', 'renew gone,c', 'renew c', 'complete c#1 c']);
});

test('a task that awaits has its lease renewed on a timer while it runs', async () => {
	vi.useFakeTimers();
	let release!: (value: string) => void;
	const lane = serveLane({
		slow: () => new Promise<string>((resolve) => (release = resolve))
	});
	const { log, coordinator } = recorder([[task('a', 'slow')]]);
	const worked = lane.work(coordinator);
	await vi.advanceTimersByTimeAsync(5000);
	release('ok');
	await worked;
	const renewals = log.filter((entry) => entry === 'renew a');
	assert.ok(renewals.length >= 2, log.join('; '));
	assert.equal(log.at(-1), 'complete a#1 ok');
	const after = log.length;
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(log.length, after);
});

// a coordinator whose writes survive a reset only once the pool has flushed them
function durable() {
	const db = new DatabaseSync(':memory:');
	const clock = new VirtualClock();
	const store = crashSql(db);
	const make = () =>
		new LanePool(store.sql, {
			width: 1,
			leaseMs: 6000,
			clock,
			flush: store.flush,
			transport: { work: async () => {} }
		});
	return { db, clock, store, make };
}

test('a reset before the flush of a submit loses it, and submitting again restores it', async () => {
	const db = new DatabaseSync(':memory:');
	let lose = false;
	const store = crashSql(db, {
		beforeFlush: () => {
			if (!lose) return;
			store.reset();
			throw new Error('reset');
		}
	});
	const pool = new LanePool(store.sql, {
		width: 1,
		flush: store.flush,
		transport: { work: async () => {} }
	});
	await store.flush();
	lose = true;
	await assert.rejects(pool.submit([{ id: 'a', name: 'f' }]), /reset/);
	lose = false;
	assert.equal(pool.table.snapshot().length, 0);
	assert.equal(await pool.submit([{ id: 'a', name: 'f' }]), 1);
	store.reset();
	assert.equal(pool.table.snapshot().length, 1);
});

test('a claim is flushed before it is returned, so a reset after it keeps it and the lease replays it', async () => {
	const d = durable();
	const pool = d.make();
	await pool.submit([{ id: 'a', name: 'f' }]);
	const [held] = await pool.claim();
	assert.equal(held!.attempt, 1);
	d.store.reset();
	const next = d.make();
	assert.equal(next.table.snapshot()[0]!.state, 'running');
	assert.deepEqual(await next.claim(), []);
	d.clock.t = 6000;
	assert.equal((await next.claim())[0]!.attempt, 2);
});

test('a reset between a claim and its flush loses the claim and the next claim replays the task', async () => {
	const db = new DatabaseSync(':memory:');
	let lose: () => void = () => {};
	const store = crashSql(db, { beforeFlush: () => lose() });
	const pool = new LanePool(store.sql, {
		width: 1,
		flush: store.flush,
		transport: { work: async () => {} }
	});
	await pool.submit([{ id: 'a', name: 'f' }]);
	lose = () => {
		store.reset();
		throw new Error('reset');
	};
	await assert.rejects(pool.claim(), /reset/);
	lose = () => {};
	// the lane never got the task, and the table shows the task as it was before the claim
	const row = pool.table.snapshot()[0]!;
	assert.equal(row.state, 'queued');
	assert.equal(row.attempt, 0);
	assert.equal((await pool.claim())[0]!.attempt, 1);
});

test('a reset between a completion and its flush loses the result, and a reset after it keeps the result', async () => {
	const db = new DatabaseSync(':memory:');
	const clock = new VirtualClock();
	let lose = false;
	const store = crashSql(db, {
		beforeFlush: () => {
			if (!lose) return;
			store.reset();
			throw new Error('reset');
		}
	});
	const pool = new LanePool(store.sql, {
		width: 1,
		leaseMs: 6000,
		clock,
		flush: store.flush,
		transport: { work: async () => {} }
	});
	await pool.submit([
		{ id: 'a', name: 'f' },
		{ id: 'b', name: 'f' }
	]);
	const [a] = await pool.claim();
	const [b] = await pool.claim();
	lose = true;
	await assert.rejects(pool.complete(a!.id, a!.attempt, 'lost'), /reset/);
	lose = false;
	assert.equal(pool.table.snapshot()[0]!.state, 'running');
	assert.equal(await pool.complete(b!.id, b!.attempt, 'kept'), 'done');
	store.reset();
	const rows = new LanePool(store.sql, {
		width: 1,
		transport: { work: async () => {} }
	}).table.snapshot();
	assert.deepEqual(
		rows.map((row) => [row.id, row.state, row.result]),
		[
			['a', 'running', null],
			['b', 'done', 'kept']
		]
	);
	clock.t = 6000;
	assert.equal((await pool.claim())[0]!.id, 'a');
});
