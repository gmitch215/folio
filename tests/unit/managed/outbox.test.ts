import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test, vi } from 'vitest';
import {
	Outbox,
	PermanentError,
	type OutboxContext,
	type OutboxOptions
} from '../../../src/managed/outbox.ts';
import type { ReplayPolicies } from '../../../src/managed/tasks.ts';
import { crashSql } from '../../helpers/crash-sql.ts';

interface RigOptions {
	policies?: ReplayPolicies;
	maxAttempts?: number;
	width?: number;
	// what the effect does; a throw is the effect failing, a return value is its result
	behavior?: (context: OutboxContext) => ReturnType<OutboxOptions['effect']>;
}

// an outbox over storage where a write survives a reset only once flush() has returned
function rig(options: RigOptions = {}) {
	const db = new DatabaseSync(':memory:');
	const hooks: { beforeFlush?: () => void } = {};
	const store = crashSql(db, hooks);
	const clock = {
		t: 0,
		now() {
			return this.t;
		}
	};
	const calls: OutboxContext[] = [];
	const make = () =>
		new Outbox(store.sql, {
			policies: options.policies,
			maxAttempts: options.maxAttempts,
			width: options.width,
			clock,
			leaseMs: 6000,
			flush: store.flush,
			effect: (context) => {
				calls.push(context);
				return options.behavior?.(context);
			}
		});
	// the nth flush from now is lost: the process resets before it commits
	const loseFlush = (n: number) => {
		let left = n;
		hooks.beforeFlush = () => {
			if (--left > 0) return;
			hooks.beforeFlush = undefined;
			store.reset();
			throw new Error('reset');
		};
	};
	const ran = (id: string) => calls.filter((call) => call.id === id).length;
	const row = (outbox: Outbox, id: string) => outbox.results().find((entry) => entry.id === id)!;
	return { db, store, clock, calls, make, outbox: make(), loseFlush, ran, row };
}

const mail = (id: string) => ({ id, kind: 'mail', args: 'to a@example.test' });

afterEach(() => {
	vi.useRealTimers();
});

test('an effect that throws goes back to the queue and succeeds on a later drain', async () => {
	const r = rig({
		behavior: ({ attempt }) => {
			if (attempt < 3) throw new Error(`smtp down ${attempt}`);
			return 'sent';
		}
	});
	await r.outbox.enqueue([mail('m1')]);
	assert.deepEqual(await r.outbox.drain(), { done: 0, failed: 0, retried: 1, reported: 0 });
	assert.equal(r.ran('m1'), 1);
	assert.deepEqual(
		[r.row(r.outbox, 'm1').state, r.row(r.outbox, 'm1').error],
		['queued', 'smtp down 1']
	);
	assert.equal((await r.outbox.drain()).retried, 1);
	assert.deepEqual(await r.outbox.drain(), { done: 1, failed: 0, retried: 0, reported: 0 });
	const done = r.row(r.outbox, 'm1');
	assert.deepEqual(
		[done.state, done.attempt, done.result, done.error],
		['done', 3, 'sent', null]
	);
	assert.equal(r.ran('m1'), 3);
});

test('a transient failure on the last attempt ends the row as failed with its message', async () => {
	const r = rig({
		maxAttempts: 2,
		behavior: () => {
			throw new Error('smtp down');
		}
	});
	await r.outbox.enqueue([mail('m1')]);
	assert.equal((await r.outbox.drain()).retried, 1);
	assert.equal((await r.outbox.drain()).failed, 1);
	const failed = r.row(r.outbox, 'm1');
	assert.deepEqual([failed.state, failed.attempt, failed.error], ['failed', 2, 'smtp down']);
	assert.deepEqual(await r.outbox.drain(), { done: 0, failed: 0, retried: 0, reported: 0 });
	assert.equal(r.ran('m1'), 2);
});

test('a PermanentError ends the row as failed on the first attempt and keeps the message', async () => {
	const r = rig({
		behavior: () => {
			throw new PermanentError('mailbox does not exist');
		}
	});
	await r.outbox.enqueue([mail('m1')]);
	assert.deepEqual(await r.outbox.drain(), { done: 0, failed: 1, retried: 0, reported: 0 });
	const failed = r.row(r.outbox, 'm1');
	assert.deepEqual(
		[failed.state, failed.attempt, failed.error],
		['failed', 1, 'mailbox does not exist']
	);
	await r.outbox.drain();
	assert.equal(r.ran('m1'), 1);
	assert.equal(new PermanentError('x', { cause: 1 }).cause, 1);
	assert.equal(new PermanentError('x').name, 'PermanentError');
});

test('an effect that returns the wrong type ends its row without running again', async () => {
	const r = rig({ behavior: (() => 5) as unknown as RigOptions['behavior'] });
	await r.outbox.enqueue([mail('m1')]);
	assert.equal((await r.outbox.drain()).failed, 1);
	assert.match(r.row(r.outbox, 'm1').error!, /returned neither text, bytes nor nothing/);
	assert.equal(r.ran('m1'), 1);
});

test('the key is the row id on every attempt, with the kind, the attempt number and the args', async () => {
	const r = rig({
		behavior: ({ attempt }) => {
			if (attempt < 3) throw new Error('again');
		}
	});
	await r.outbox.enqueue([{ id: 'm1', kind: 'mail', argsJson: { to: 'a' } }]);
	for (let i = 0; i < 3; i++) await r.outbox.drain();
	assert.deepEqual(
		r.calls.map(({ id, kind, attempt, key, args }) => [id, kind, attempt, key, args]),
		[1, 2, 3].map((attempt) => ['m1', 'mail', attempt, 'm1', '{"to":"a"}'])
	);
});

test('a resend kind is claimed again once its lease has ended', async () => {
	const r = rig({ policies: { mail: 'resend' } });
	await r.outbox.enqueue([mail('m1')]);
	// an earlier incarnation claimed the row and never reported
	assert.equal(r.outbox.table.claim(0, 6000, 1, { policies: { mail: 'resend' } }).length, 1);
	assert.deepEqual(await r.outbox.drain(), { done: 0, failed: 0, retried: 0, reported: 0 });
	r.clock.t = 6000;
	assert.deepEqual(await r.outbox.drain(), { done: 1, failed: 0, retried: 0, reported: 0 });
	assert.equal(r.row(r.outbox, 'm1').attempt, 2);
	assert.equal(r.ran('m1'), 1);
});

test('at-most-once: a report kind whose process died while the effect ran is reported, not run again', async () => {
	vi.useFakeTimers();
	let started!: () => void;
	const running = new Promise<void>((resolve) => (started = resolve));
	const r = rig({
		policies: { mail: 'report' },
		behavior: () => {
			started();
			return new Promise<never>(() => {});
		}
	});
	await r.outbox.enqueue([mail('m1')]);
	// the process dies with the effect in flight: only what was flushed survives
	void r.outbox.drain();
	await running;
	r.store.reset();
	const next = r.make();
	assert.equal(next.table.snapshot()[0]!.state, 'running');
	r.clock.t = 6000;
	assert.deepEqual(await next.drain(), { done: 0, failed: 0, retried: 0, reported: 1 });
	const reported = r.row(next, 'm1');
	assert.equal(reported.state, 'failed');
	assert.match(reported.error!, /attempt 1 of kind mail: policy report/);
	assert.equal(r.ran('m1'), 1);
	assert.deepEqual(await next.drain(), { done: 0, failed: 0, retried: 0, reported: 0 });
	assert.equal(r.ran('m1'), 1);
});

test('a reset inside the flush of a claim loses the claim, and the replay runs the effect once', async () => {
	for (const policy of ['resend', 'report'] as const) {
		const r = rig({ policies: { mail: policy } });
		await r.outbox.enqueue([mail('m1')]);
		r.loseFlush(1);
		await assert.rejects(r.outbox.drain(), /reset/);
		assert.equal(r.ran('m1'), 0, policy);
		const next = r.make();
		const lost = next.results()[0]!;
		assert.deepEqual([lost.state, lost.attempt], ['queued', 0]);
		assert.deepEqual(await next.drain(), { done: 1, failed: 0, retried: 0, reported: 0 });
		assert.equal(r.ran('m1'), 1, policy);
		assert.equal(r.row(next, 'm1').attempt, 1);
	}
});

test('at-least-once: a resend kind whose effect ran and whose completion was lost runs again', async () => {
	const r = rig({ policies: { mail: 'resend' } });
	await r.outbox.enqueue([mail('m1')]);
	r.loseFlush(2);
	await assert.rejects(r.outbox.drain(), /reset/);
	assert.equal(r.ran('m1'), 1);
	const next = r.make();
	assert.equal(next.results()[0]!.state, 'running');
	r.clock.t = 6000;
	assert.deepEqual(await next.drain(), { done: 1, failed: 0, retried: 0, reported: 0 });
	assert.equal(r.ran('m1'), 2);
	assert.equal(r.row(next, 'm1').attempt, 2);
});

test('at-most-once: a report kind whose effect ran and whose completion was lost is not run again', async () => {
	const r = rig({ policies: { mail: 'report' } });
	await r.outbox.enqueue([mail('m1')]);
	r.loseFlush(2);
	await assert.rejects(r.outbox.drain(), /reset/);
	assert.equal(r.ran('m1'), 1);
	const next = r.make();
	r.clock.t = 6000;
	assert.deepEqual(await next.drain(), { done: 0, failed: 0, retried: 0, reported: 1 });
	assert.equal(r.ran('m1'), 1);
	const reported = r.row(next, 'm1');
	assert.equal(reported.state, 'failed');
	assert.match(reported.error!, /policy report/);
});

test('a completion that was flushed survives a reset and is not replayed', async () => {
	for (const policy of ['resend', 'report'] as const) {
		const r = rig({ policies: { mail: policy } });
		await r.outbox.enqueue([mail('m1')]);
		await r.outbox.drain();
		r.store.reset();
		const next = r.make();
		r.clock.t = 60000;
		assert.deepEqual(await next.drain(), { done: 0, failed: 0, retried: 0, reported: 0 });
		assert.deepEqual([r.row(next, 'm1').state, r.ran('m1')], ['done', 1]);
	}
});

test('a row that finished stays done when the process dies during the effect of a row beside it', async () => {
	vi.useFakeTimers();
	let started!: () => void;
	const running = new Promise<void>((resolve) => (started = resolve));
	const r = rig({
		policies: { mail: 'report' },
		width: 2,
		behavior: ({ id }) => {
			if (id !== 'm2') return 'sent';
			started();
			return new Promise<never>(() => {});
		}
	});
	await r.outbox.enqueue([mail('m1'), mail('m2')]);
	void r.outbox.drain();
	await running;
	r.store.reset();
	const next = r.make();
	r.clock.t = 6000;
	assert.deepEqual(await next.drain(), { done: 0, failed: 0, retried: 0, reported: 1 });
	assert.deepEqual(
		next.results().map((entry) => [entry.id, entry.state, r.ran(entry.id)]),
		[
			['m1', 'done', 1],
			['m2', 'failed', 1]
		]
	);
});

test('a kind with no policy is reported, and so is every kind when no policy is given', async () => {
	for (const policies of [undefined, { http: 'resend' } as const]) {
		const r = rig({ policies });
		await r.outbox.enqueue([mail('m1')]);
		r.outbox.table.claim(0, 6000, 1);
		r.clock.t = 6000;
		assert.deepEqual(await r.outbox.drain(), { done: 0, failed: 0, retried: 0, reported: 1 });
		assert.equal(r.ran('m1'), 0);
		assert.match(r.row(r.outbox, 'm1').error!, /policy report/);
	}
});

test('one outbox holds a resend kind and a report kind side by side', async () => {
	const r = rig({ policies: { http: 'resend', mail: 'report' } });
	await r.outbox.enqueue([mail('a'), { id: 'b', kind: 'http' }]);
	r.outbox.table.claim(0, 6000, 2);
	r.clock.t = 6000;
	assert.deepEqual(await r.outbox.drain(), { done: 1, failed: 0, retried: 0, reported: 1 });
	assert.deepEqual(
		r.outbox.results().map((entry) => [entry.id, entry.kind, entry.state]),
		[
			['a', 'mail', 'failed'],
			['b', 'http', 'done']
		]
	);
});

test('a row that lost its last attempt to an expired lease fails with the exhausted lease', async () => {
	const r = rig({ policies: { mail: 'resend' }, maxAttempts: 1 });
	await r.outbox.enqueue([mail('m1')]);
	r.outbox.table.claim(0, 6000, 1, { policies: { mail: 'resend' } });
	r.clock.t = 6000;
	assert.deepEqual(await r.outbox.drain(), { done: 0, failed: 1, retried: 0, reported: 0 });
	assert.equal(r.row(r.outbox, 'm1').error, 'lease expired after 1 attempts');
	assert.equal(r.ran('m1'), 0);
});

test('width runs that many rows at once, and drain returns when none is left', async () => {
	let live = 0;
	let peak = 0;
	const r = rig({
		width: 3,
		behavior: async () => {
			peak = Math.max(peak, ++live);
			await new Promise((resolve) => setImmediate(resolve));
			live--;
		}
	});
	await r.outbox.enqueue(Array.from({ length: 7 }, (_, i) => mail(`m${i}`)));
	assert.deepEqual(await r.outbox.drain(), { done: 7, failed: 0, retried: 0, reported: 0 });
	assert.equal(peak, 3);
	assert.deepEqual(
		r.outbox.results().map((entry) => entry.state),
		Array(7).fill('done')
	);
});

test('an effect that awaits keeps its lease, so a second drain neither reports nor runs the row', async () => {
	vi.useFakeTimers();
	const db = new DatabaseSync(':memory:');
	let release!: (value: string) => void;
	let runs = 0;
	const sql = crashSql(db).sql;
	const make = () =>
		new Outbox(sql, {
			policies: { mail: 'report' },
			leaseMs: 6000,
			effect: () => {
				runs++;
				return new Promise<string>((resolve) => (release = resolve));
			}
		});
	const first = make();
	await first.enqueue([mail('m1')]);
	const drained = first.drain();
	await vi.advanceTimersByTimeAsync(20000);
	assert.deepEqual(await make().drain(), { done: 0, failed: 0, retried: 0, reported: 0 });
	release('sent');
	assert.deepEqual(await drained, { done: 1, failed: 0, retried: 0, reported: 0 });
	assert.deepEqual(
		[first.results()[0]!.state, first.results()[0]!.result, runs],
		['done', 'sent', 1]
	);
});

test('resume drains and names the next alarm, and names none when nothing is open', async () => {
	const r = rig({
		behavior: ({ id }) => {
			if (id === 'bad') throw new Error('smtp down');
		}
	});
	await r.outbox.enqueue([mail('bad'), mail('good')]);
	const first = await r.outbox.resume();
	assert.deepEqual([first.done, first.retried, first.wake], [1, 1, r.clock.t + 5000]);
	// a row another incarnation holds sets the alarm to its lease end
	const held = rig();
	await held.outbox.enqueue([mail('m1')]);
	held.outbox.table.claim(0, 9000, 1);
	assert.equal((await held.outbox.resume()).wake, 9000);
	held.clock.t = 9000;
	assert.deepEqual(await held.outbox.resume(), { done: 0, failed: 0, retried: 0, reported: 1 });
	assert.equal('wake' in (await rig().outbox.resume()), false);
});

test('enqueue ignores a repeated id, takes JSON arguments and refuses bad rows', async () => {
	const r = rig();
	assert.equal(
		await r.outbox.enqueue([
			{ id: 'a', kind: 'mail', argsJson: { n: 1 } },
			{ id: 'b', kind: 'http', args: new Uint8Array([9]) },
			{ id: 'c', kind: 'redis' }
		]),
		3
	);
	assert.equal(await r.outbox.enqueue([{ id: 'a', kind: 'other' }]), 0);
	const rows = r.outbox.results();
	assert.deepEqual(
		rows.map((entry) => [entry.id, entry.kind, entry.args]),
		[
			['a', 'mail', '{"n":1}'],
			['b', 'http', new Uint8Array([9])],
			['c', 'redis', '']
		]
	);
	await assert.rejects(r.outbox.enqueue([{ id: '', kind: 'mail' }]), TypeError);
	await assert.rejects(r.outbox.enqueue([{ id: 'x', kind: '' }]), TypeError);
	await assert.rejects(
		r.outbox.enqueue([{ id: 'x', kind: 'm', args: '1', argsJson: 1 }]),
		TypeError
	);
	await assert.rejects(
		r.outbox.enqueue([{ id: 'x', kind: 'm', args: 5 as unknown as string }]),
		TypeError
	);
});

test('the outbox refuses a missing effect, a short lease, a zero width and an unknown policy', () => {
	const sql = crashSql(new DatabaseSync(':memory:')).sql;
	const effect = () => {};
	assert.throws(() => new Outbox(sql, {} as OutboxOptions), TypeError);
	assert.throws(() => new Outbox(sql, { effect, leaseMs: 4999 }), RangeError);
	assert.throws(() => new Outbox(sql, { effect, width: 0 }), RangeError);
	assert.throws(
		() => new Outbox(sql, { effect, policies: { mail: 'retry' as unknown as 'resend' } }),
		TypeError
	);
});

// a seeded random run: every flush has a 30% chance of being lost with the process, and the
// outbox restarts over what was flushed
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

test('with 30% of unflushed writes lost every row ends done or failed with its cause, report effects ran at most once and done resend effects at least once', async () => {
	const kinds = ['mail', 'http', 'redis'];
	const policies: ReplayPolicies = { mail: 'report', http: 'resend' };
	for (let seed = 1; seed <= 60; seed++) {
		const random = rng(seed * 7919);
		const took = new Map<string, number>();
		const db = new DatabaseSync(':memory:');
		const hooks: { beforeFlush?: () => void } = {};
		const store = crashSql(db, hooks);
		const clock = { t: 0, now: () => clock.t };
		const make = () =>
			new Outbox(store.sql, {
				policies,
				maxAttempts: 4,
				clock,
				leaseMs: 6000,
				flush: store.flush,
				width: 1 + Math.floor(random() * 3),
				effect: ({ id }) => {
					const roll = random();
					if (roll < 0.15) throw new PermanentError(`permanent ${id}`);
					if (roll < 0.3) throw new Error(`transient ${id}`);
					// the effect took place only when it returns, as a throw means it did not
					took.set(id, (took.get(id) ?? 0) + 1);
					return 'ok';
				}
			});
		const items = Array.from({ length: 8 }, (_, i) => ({
			id: `r${i}`,
			kind: kinds[i % kinds.length]!
		}));
		await make().enqueue(items);
		hooks.beforeFlush = () => {
			if (random() >= 0.3) return;
			store.reset();
			throw new Error('reset');
		};
		let outbox = make();
		for (let round = 0; round < 400 && outbox.table.pending(clock.t).open; round++) {
			clock.t += 7000;
			outbox = make();
			try {
				await outbox.drain();
			} catch (error) {
				assert.equal((error as Error).message, 'reset', `seed ${seed}`);
			}
		}
		hooks.beforeFlush = undefined;
		store.reset();
		for (const entry of make().results()) {
			const where = `seed ${seed} ${entry.id}`;
			assert.ok(entry.state === 'done' || entry.state === 'failed', where);
			if (entry.state === 'failed')
				assert.match(
					entry.error ?? '',
					/^(permanent r\d|transient r\d|lease expired after 4 attempts|lease expired on attempt \d of kind \w+: policy report)/,
					where
				);
			const count = took.get(entry.id) ?? 0;
			if (policies[entry.kind!] !== 'resend') assert.ok(count <= 1, `${where} ran ${count}`);
			if (policies[entry.kind!] === 'resend' && entry.state === 'done')
				assert.ok(count >= 1, where);
			if (entry.state === 'done') assert.equal(entry.result, 'ok', where);
		}
	}
});
