import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { test } from 'vitest';
import { TaskTable, type TaskRow, type TaskValue } from '../../../src/managed/tasks.ts';
import type { SqlStorage } from '../../../src/memory/continuation.ts';

interface Faults {
	// a write that runs and answers, then is undone, as a reset that loses it after the reply
	lose?: (query: string) => boolean;
}

// a durable object's SQL handle over an in-memory SQLite database
function fakeSql(db: DatabaseSync, faults: Faults = {}): SqlStorage {
	const cache = new Map<string, StatementSync>();
	return {
		exec(query, ...bindings) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value
			);
			let statement = cache.get(query);
			if (!statement) cache.set(query, (statement = db.prepare(query)));
			const reads = /^\s*SELECT|RETURNING/i.test(query);
			const writes = /^\s*(INSERT|UPDATE)/i.test(query);
			const lose = writes && faults.lose?.(query);
			if (lose) db.exec('SAVEPOINT lost');
			const rows = reads
				? (statement.all(...args) as Record<string, unknown>[])
				: (statement.run(...args), []);
			if (lose) db.exec('ROLLBACK TO lost; RELEASE lost');
			return { toArray: () => rows };
		}
	};
}

function table(options?: { maxAttempts?: number }, faults?: Faults) {
	return new TaskTable(fakeSql(new DatabaseSync(':memory:'), faults), options);
}

const byId = (rows: TaskRow[]) => new Map(rows.map((row) => [row.id, row]));

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

test('enqueue ignores an id that exists and keeps its row', () => {
	const t = table();
	assert.equal(t.enqueue('a', 'hash', 'first'), true);
	assert.equal(t.enqueue('a', 'other', 'second'), false);
	assert.deepEqual(
		t.snapshot().map((row) => [row.id, row.name, row.args, row.state, row.attempt]),
		[['a', 'hash', 'first', 'queued', 0]]
	);
});

test('claim takes the oldest rows first, up to the limit, and returns args as stored', () => {
	const t = table();
	t.enqueue('z', 'f', 'text');
	t.enqueue('a', 'f', new Uint8Array([1, 2, 3]));
	t.enqueue('m', 'f');
	const first = t.claim(1000, 500, 2);
	assert.deepEqual(
		first.map((row) => [row.id, row.attempt, row.leaseUntil]),
		[
			['z', 1, 1500],
			['a', 1, 1500]
		]
	);
	assert.equal(first[0]!.args, 'text');
	assert.deepEqual(first[1]!.args, new Uint8Array([1, 2, 3]));
	assert.deepEqual(
		t.claim(1000, 500, 5).map((row) => row.id),
		['m']
	);
	assert.deepEqual(t.claim(1000, 500, 5), []);
	assert.equal(t.snapshot().find((row) => row.id === 'm')!.args, '');
});

test('a running row is claimed again once its lease has ended', () => {
	const t = table();
	t.enqueue('a', 'f');
	assert.equal(t.claim(0, 100, 1).length, 1);
	assert.deepEqual(t.claim(99, 100, 1), []);
	const replay = t.claim(100, 100, 1);
	assert.deepEqual(
		replay.map((row) => [row.id, row.attempt, row.leaseUntil]),
		[['a', 2, 200]]
	);
});

test('a row whose lease ends on its last attempt fails instead of running again', () => {
	const t = table({ maxAttempts: 2 });
	t.enqueue('a', 'f');
	t.enqueue('b', 'f');
	assert.equal(t.claim(0, 10, 1)[0]!.id, 'a');
	assert.equal(t.claim(10, 10, 1)[0]!.attempt, 2);
	assert.equal(t.claim(20, 10, 2)[0]!.id, 'b');
	const rows = byId(t.snapshot());
	assert.equal(rows.get('a')!.state, 'failed');
	assert.equal(rows.get('a')!.error, 'lease expired after 2 attempts');
	assert.equal(rows.get('a')!.attempt, 2);
	assert.equal(t.claim(1000, 10, 5)[0]!.id, 'b');
});

test('expire settles poison rows when nothing claims', () => {
	const t = table({ maxAttempts: 1 });
	t.enqueue('a', 'f');
	t.claim(0, 10, 1);
	assert.equal(t.expire(9), 0);
	assert.equal(t.expire(10), 1);
	assert.equal(t.expire(10), 0);
	assert.deepEqual(t.counts(), { queued: 0, running: 0, done: 0, failed: 1 });
});

test('complete writes once and a repeat changes nothing', () => {
	const t = table();
	t.enqueue('a', 'f');
	const [claim] = t.claim(0, 100, 1);
	assert.equal(t.complete('a', claim!.attempt, 'one'), 'done');
	assert.equal(t.complete('a', claim!.attempt, 'two'), 'ignored');
	assert.equal(t.complete('missing', 1, 'x'), 'ignored');
	const row = t.snapshot()[0]!;
	assert.equal(row.state, 'done');
	assert.equal(row.result, 'one');
	assert.equal(row.leaseUntil, null);
});

test('a result is stored as text or bytes and read back the same', () => {
	const t = table();
	t.enqueue('s', 'f');
	t.enqueue('b', 'f');
	t.claim(0, 100, 2);
	t.complete('s', 1, '{"n":1}');
	t.complete('b', 1, new Uint8Array([0, 255, 7]));
	const rows = byId(t.snapshot());
	assert.equal(rows.get('s')!.result, '{"n":1}');
	assert.deepEqual(rows.get('b')!.result, new Uint8Array([0, 255, 7]));
});

test('a superseded attempt that finishes first wins, and the current attempt then changes nothing', () => {
	const t = table();
	t.enqueue('a', 'f');
	t.claim(0, 10, 1);
	t.claim(10, 10, 1);
	assert.equal(t.complete('a', 1, 'early'), 'late');
	assert.equal(t.complete('a', 2, 'later'), 'ignored');
	assert.equal(t.snapshot()[0]!.result, 'early');
});

test('a completion from a superseded attempt after the current one is ignored', () => {
	const t = table();
	t.enqueue('a', 'f');
	t.claim(0, 10, 1);
	t.claim(10, 10, 1);
	assert.equal(t.complete('a', 2, 'current'), 'done');
	assert.equal(t.complete('a', 1, 'stale'), 'ignored');
	assert.equal(t.snapshot()[0]!.result, 'current');
});

test('fail retries until the last attempt, and a stale failure changes nothing', () => {
	const t = table({ maxAttempts: 2 });
	t.enqueue('a', 'f');
	t.claim(0, 10, 1);
	assert.equal(t.fail('a', 1, 'boom'), 'retry');
	assert.equal(t.fail('a', 1, 'again'), 'ignored');
	assert.equal(t.snapshot()[0]!.state, 'queued');
	assert.equal(t.claim(1, 10, 1)[0]!.attempt, 2);
	assert.equal(t.fail('a', 1, 'stale'), 'ignored');
	assert.equal(t.fail('a', 2, 'last'), 'failed');
	const row = t.snapshot()[0]!;
	assert.equal(row.state, 'failed');
	assert.equal(row.error, 'last');
	assert.equal(t.complete('a', 2, 'too late'), 'ignored');
});

test('renew extends the current attempt only, and never shortens a lease', () => {
	const t = table();
	t.enqueue('a', 'f');
	t.claim(0, 100, 1);
	assert.equal(t.renew('a', 1, 50, 100), true);
	assert.equal(t.snapshot()[0]!.leaseUntil, 150);
	assert.equal(t.renew('a', 1, 0, 10), true);
	assert.equal(t.snapshot()[0]!.leaseUntil, 150);
	assert.equal(t.renew('a', 2, 50, 100), false);
	assert.deepEqual(t.claim(149, 100, 1), []);
	t.complete('a', 1, 'x');
	assert.equal(t.renew('a', 1, 50, 100), false);
	assert.equal(t.renew('missing', 1, 50, 100), false);
});

test('pending counts open and claimable rows and names the next lease end', () => {
	const t = table();
	t.enqueue('a', 'f');
	t.enqueue('b', 'f');
	t.enqueue('c', 'f');
	assert.deepEqual(t.pending(0), { open: 3, claimable: 3 });
	t.claim(0, 100, 2);
	assert.deepEqual(t.pending(50), { open: 3, claimable: 1, nextExpiry: 100 });
	assert.deepEqual(t.pending(100), { open: 3, claimable: 3 });
	t.complete('a', 1, 'x');
	assert.deepEqual(t.pending(100), { open: 2, claimable: 2 });
	assert.deepEqual(table().pending(0), { open: 0, claimable: 0 });
});

test('the table refuses an unsafe name and a bad attempt count', () => {
	const sql = fakeSql(new DatabaseSync(':memory:'));
	assert.throws(() => new TaskTable(sql, { table: 'tasks; DROP TABLE x' }), TypeError);
	assert.throws(() => new TaskTable(sql, { maxAttempts: 0 }), RangeError);
	assert.equal(new TaskTable(sql, { maxAttempts: 4 }).maxAttempts, 4);
});

test('a second table object over the same storage sees the rows of the first', () => {
	const sql = fakeSql(new DatabaseSync(':memory:'));
	const one = new TaskTable(sql);
	one.enqueue('a', 'f', 'x');
	one.claim(0, 100, 1);
	const two = new TaskTable(sql);
	assert.equal(two.snapshot()[0]!.state, 'running');
	assert.equal(two.claim(100, 100, 1)[0]!.attempt, 2);
});

test('enqueue keeps the kind, and a row without one reads back as null', () => {
	const t = table();
	t.enqueue('a', 'f', 'x', 'mail');
	t.enqueue('b', 'f');
	assert.deepEqual(
		t.snapshot().map((row) => [row.id, row.kind]),
		[
			['a', 'mail'],
			['b', null]
		]
	);
	assert.deepEqual(
		t.claim(0, 100, 2).map((row) => [row.id, row.kind]),
		[
			['a', 'mail'],
			['b', null]
		]
	);
});

test('a table made before the kind column existed gains it and keeps its rows', () => {
	const db = new DatabaseSync(':memory:');
	db.exec(
		`CREATE TABLE folio_tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, args, state TEXT NOT NULL, attempt INTEGER NOT NULL, lease_until INTEGER, result, error TEXT, seq INTEGER NOT NULL)`
	);
	db.exec(`INSERT INTO folio_tasks VALUES ('old', 'f', 'x', 'queued', 0, NULL, NULL, NULL, 1)`);
	const sql = fakeSql(db);
	const t = new TaskTable(sql);
	assert.equal(t.snapshot()[0]!.kind, null);
	assert.equal(t.enqueue('new', 'f', '', 'mail'), true);
	assert.deepEqual(
		t.snapshot().map((row) => [row.id, row.kind]),
		[
			['new', 'mail'],
			['old', null]
		]
	);
	assert.equal(t.claim(0, 100, 1)[0]!.id, 'old');
	// opening the migrated table again changes nothing
	assert.equal(new TaskTable(sql).snapshot().length, 2);
});

test('claim with policies runs a resend row again and ends every other expired row as failed', () => {
	const t = table();
	t.enqueue('a', 'f', '', 'mail');
	t.enqueue('b', 'f', '', 'http');
	t.enqueue('c', 'f', '', 'sms');
	t.enqueue('d', 'f');
	t.claim(0, 10, 4);
	const policies = { http: 'resend', mail: 'report' } as const;
	assert.deepEqual(t.claim(9, 10, 4, { policies }), []);
	assert.deepEqual(
		t.claim(10, 10, 4, { policies }).map((row) => [row.id, row.attempt]),
		[['b', 2]]
	);
	const rows = byId(t.snapshot());
	assert.equal(
		rows.get('a')!.error,
		'lease expired on attempt 1 of kind mail: policy report, the effect may have run and is not run again'
	);
	assert.match(rows.get('c')!.error!, /^lease expired on attempt 1 of kind sms: policy report/);
	assert.match(
		rows.get('d')!.error!,
		/^lease expired on attempt 1 of a row with no kind: policy report/
	);
	assert.deepEqual(
		[...rows.values()].map((row) => [row.id, row.state, row.leaseUntil]),
		[
			['a', 'failed', null],
			['b', 'running', 20],
			['c', 'failed', null],
			['d', 'failed', null]
		]
	);
});

test('claim without policies runs every expired row again, as before kinds existed', () => {
	const t = table();
	t.enqueue('a', 'f', '', 'mail');
	t.claim(0, 10, 1);
	assert.deepEqual(
		t.claim(10, 10, 1).map((row) => [row.id, row.attempt]),
		[['a', 2]]
	);
});

test('the claim statement leaves a report row alone even when the statement that ends it was lost', () => {
	const t = table({}, { lose: (query) => query.includes('policy report') });
	t.enqueue('a', 'f', '', 'mail');
	t.enqueue('b', 'f', '', 'http');
	t.claim(0, 10, 2);
	const policies = { http: 'resend', mail: 'report' } as const;
	assert.deepEqual(
		t.claim(10, 10, 2, { policies }).map((row) => row.id),
		['b']
	);
	assert.equal(byId(t.snapshot()).get('a')!.state, 'running');
	assert.deepEqual(
		t.claim(500, 10, 2, { policies }).map((row) => row.id),
		['b']
	);
});

test('reportLost and expire count the rows they end, and a bad policy is refused', () => {
	const t = table({ maxAttempts: 1 });
	t.enqueue('a', 'f', '', 'mail');
	t.enqueue('b', 'f', '', 'http');
	t.enqueue('c', 'f', '', 'http');
	t.claim(0, 10, 3);
	t.complete('c', 1, 'x');
	assert.equal(t.reportLost(9, { http: 'resend' }), 0);
	assert.equal(t.reportLost(10, { http: 'resend' }), 1);
	assert.equal(t.reportLost(10, { http: 'resend' }), 0);
	assert.equal(t.expire(10, { http: 'resend' }), 1);
	assert.deepEqual(t.counts(), { queued: 0, running: 0, done: 1, failed: 2 });
	assert.throws(() => t.reportLost(10, { http: 'retry' as 'resend' }), TypeError);
	assert.throws(() => t.claim(10, 10, 1, { policies: { http: 'x' as 'resend' } }), TypeError);
});

test('claim leaves the ids it is told to skip', () => {
	const t = table();
	for (const id of ['a', 'b', 'c']) t.enqueue(id, 'f');
	assert.deepEqual(
		t.claim(0, 10, 2, { skip: ['a'] }).map((row) => row.id),
		['b', 'c']
	);
	assert.deepEqual(
		t.claim(0, 10, 2, { skip: [] }).map((row) => row.id),
		['a']
	);
});

test('a final failure ends the row at once, whatever attempts remain', () => {
	const t = table({ maxAttempts: 3 });
	t.enqueue('a', 'f');
	t.claim(0, 10, 1);
	assert.equal(t.fail('a', 1, 'never', true), 'failed');
	assert.equal(t.snapshot()[0]!.state, 'failed');
	assert.equal(t.snapshot()[0]!.error, 'never');
	assert.deepEqual(t.claim(1000, 10, 1), []);
});

// the same rules written again over a Map, to run beside the SQL
class Model {
	readonly rows = new Map<
		string,
		{
			state: string;
			attempt: number;
			lease: number | null;
			result: TaskValue | null;
			error: string | null;
			seq: number;
		}
	>();
	#seq = 0;

	readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	enqueue(id: string) {
		if (this.rows.has(id)) return false;
		this.rows.set(id, {
			state: 'queued',
			attempt: 0,
			lease: null,
			result: null,
			error: null,
			seq: ++this.#seq
		});
		return true;
	}

	expire(now: number) {
		let n = 0;
		for (const row of this.rows.values())
			if (row.state === 'running' && row.lease! <= now && row.attempt >= this.max) {
				Object.assign(row, {
					state: 'failed',
					lease: null,
					error: `lease expired after ${this.max} attempts`
				});
				n++;
			}
		return n;
	}

	claim(now: number, lease: number, limit: number) {
		this.expire(now);
		const taken = [...this.rows.entries()]
			.filter(
				([, row]) =>
					row.attempt < this.max &&
					(row.state === 'queued' || (row.state === 'running' && row.lease! <= now))
			)
			.sort((a, b) => a[1].seq - b[1].seq)
			.slice(0, limit);
		for (const [, row] of taken) {
			row.state = 'running';
			row.attempt++;
			row.lease = now + lease;
		}
		return taken.map(([id, row]) => [id, row.attempt, row.lease]);
	}

	complete(id: string, attempt: number, result: TaskValue) {
		const row = this.rows.get(id);
		if (!row || row.state === 'done' || row.state === 'failed') return 'ignored';
		const outcome = row.attempt === attempt ? 'done' : 'late';
		Object.assign(row, { state: 'done', result, error: null, lease: null });
		return outcome;
	}

	fail(id: string, attempt: number, error: string) {
		const row = this.rows.get(id);
		if (!row || row.attempt !== attempt || row.state !== 'running') return 'ignored';
		row.state = row.attempt >= this.max ? 'failed' : 'queued';
		row.error = error;
		row.lease = null;
		return row.state === 'failed' ? 'failed' : 'retry';
	}

	renew(id: string, attempt: number, now: number, lease: number) {
		const row = this.rows.get(id);
		if (!row || row.attempt !== attempt || row.state !== 'running') return false;
		row.lease = Math.max(row.lease!, now + lease);
		return true;
	}
}

function agree(t: TaskTable, model: Model, where: string) {
	assert.deepEqual(
		t
			.snapshot()
			.map((row) => [row.id, row.state, row.attempt, row.leaseUntil, row.result, row.error]),
		[...model.rows.entries()]
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([id, row]) => [id, row.state, row.attempt, row.lease, row.result, row.error]),
		where
	);
}

test('the table agrees with a plain model over random claims, completions, expiries and clock steps', () => {
	for (let seed = 1; seed <= 60; seed++) {
		const random = rng(seed);
		const pick = (n: number) => Math.floor(random() * n);
		const max = 1 + pick(4);
		const t = table({ maxAttempts: max });
		const model = new Model(max);
		let now = 0;
		for (let step = 0; step < 150; step++) {
			const where = `seed ${seed} step ${step}`;
			const id = `t${pick(8)}`;
			const known = model.rows.get(id);
			const attempt = pick((known?.attempt ?? 0) + 2);
			const value: TaskValue =
				random() < 0.3 ? new Uint8Array([pick(256), pick(256)]) : `v${step}`;
			switch (pick(8)) {
				case 0:
				case 1:
					assert.equal(t.enqueue(id, 'f', `a${step}`), model.enqueue(id), where);
					break;
				case 2:
				case 3: {
					const lease = 10 + pick(50);
					const limit = 1 + pick(3);
					assert.deepEqual(
						t
							.claim(now, lease, limit)
							.map((row) => [row.id, row.attempt, row.leaseUntil]),
						model.claim(now, lease, limit),
						where
					);
					break;
				}
				case 4:
					assert.equal(
						t.complete(id, attempt, value),
						model.complete(id, attempt, value),
						where
					);
					break;
				case 5:
					assert.equal(
						t.fail(id, attempt, `e${step}`),
						model.fail(id, attempt, `e${step}`),
						where
					);
					break;
				case 6: {
					const lease = 10 + pick(50);
					assert.equal(
						t.renew(id, attempt, now, lease),
						model.renew(id, attempt, now, lease),
						where
					);
					break;
				}
				default:
					now += pick(40);
					assert.equal(t.expire(now), model.expire(now), where);
			}
			agree(t, model, where);
		}
	}
});

test('lost writes leave every row valid, never reopen a final row and never change a result', () => {
	const allowed: Record<string, string[]> = {
		queued: ['queued', 'running', 'done'],
		running: ['running', 'queued', 'done', 'failed'],
		done: ['done'],
		failed: ['failed']
	};
	for (let seed = 1; seed <= 40; seed++) {
		const random = rng(seed * 7919);
		const pick = (n: number) => Math.floor(random() * n);
		const max = 2 + pick(3);
		const t = table({ maxAttempts: max }, { lose: () => random() < 0.3 });
		let now = 0;
		let before = byId(t.snapshot());
		for (let i = 0; i < 6; i++) t.enqueue(`t${i}`, 'f');
		for (let step = 0; step < 120; step++) {
			const id = `t${pick(6)}`;
			const attempt = pick(max + 1);
			switch (pick(6)) {
				case 0:
					t.claim(now, 10 + pick(30), 1 + pick(3));
					break;
				case 1:
					t.complete(id, attempt, `r${pick(1000)}`);
					break;
				case 2:
					t.fail(id, attempt, 'boom');
					break;
				case 3:
					t.renew(id, attempt, now, 20);
					break;
				default:
					now += pick(30);
			}
			const after = byId(t.snapshot());
			for (const [key, row] of after) {
				const was = before.get(key);
				if (!was) continue;
				assert.ok(
					allowed[was.state]!.includes(row.state),
					`seed ${seed}: ${was.state} to ${row.state}`
				);
				assert.ok(row.attempt >= was.attempt && row.attempt <= max);
				if (was.state === 'done') assert.deepEqual(row.result, was.result);
				if (row.state === 'done') assert.notEqual(row.result, null);
				if (row.state === 'running') assert.notEqual(row.leaseUntil, null);
				if (row.state === 'queued') assert.equal(row.leaseUntil, null);
			}
			before = after;
		}
	}
});

test('with lost writes every task still finishes with its own result', () => {
	for (let seed = 1; seed <= 20; seed++) {
		const random = rng(seed * 104729);
		const t = table({ maxAttempts: 60 }, { lose: () => random() < 0.3 });
		// enqueue is idempotent, so a lost insert is repeated
		while (t.counts().queued < 8)
			for (let i = 0; i < 8; i++) t.enqueue(`t${i}`, 'f', String(i));
		let now = 0;
		for (let round = 0; round < 400 && t.pending(now).open; round++) {
			for (const claimed of t.claim(now, 20, 2))
				if (random() < 0.7) t.complete(claimed.id, claimed.attempt, `r${claimed.args}`);
			now += 7;
		}
		for (const row of t.snapshot()) {
			assert.equal(row.state, 'done', `seed ${seed} ${row.id}`);
			assert.equal(row.result, `r${row.args}`);
		}
	}
});
