import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
	MemoryPageOwner,
	PageDirectory,
	pageBytes,
	type PageDirectoryOptions,
	type PageOwner,
	type PageScope
} from '../../src/pages.ts';

const scope: PageScope = { tenant: 'tenant', session: 'session', incarnation: 'fresh-1' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(options: Partial<PageDirectoryOptions> = {}) {
	const a = new MemoryPageOwner('a', scope, 8 * pageBytes);
	const b = new MemoryPageOwner('b', scope, 8 * pageBytes);
	const directory = new PageDirectory({ scope, owners: [a, b], initialPages: 8, ...options });
	return { a, b, directory };
}

function transport(owner: PageOwner, changes: Partial<PageOwner>): PageOwner {
	return {
		id: owner.id,
		read: (scope, version) => owner.read(scope, version),
		stage: (scope, version, bytes) => owner.stage(scope, version, bytes),
		discard: (scope, version) => owner.discard(scope, version),
		...changes
	};
}

test('cross-owner commits publish one manifest decision and keep all views detached', async () => {
	const gate = deferred(),
		entered = deferred();
	const a = new MemoryPageOwner('a', scope, 4 * pageBytes);
	const b = new MemoryPageOwner('b', scope, 4 * pageBytes);
	const delayed = transport(b, {
		stage: async (...args) => {
			await b.stage(...args);
			entered.resolve();
			await gate.promise;
		}
	});
	const directory = new PageDirectory({ scope, owners: [a, delayed], initialPages: 2 });
	const lease = await directory.acquire({ write: [0, 1] });
	const escaped = lease.view(0);
	escaped[0] = 17;
	lease.view(1)[0] = 23;
	const commit = lease.commit();
	await entered.promise;
	assert.deepEqual([directory.inspect(0).fence, directory.inspect(1).fence], [0, 0]);
	assert.deepEqual(await directory.collect(), { discarded: 0, pending: 0 });
	assert.equal(a.bytes + b.bytes, 2 * pageBytes);
	escaped[0] = 99;
	await assert.rejects(directory.acquire({ read: [0, 1] }), /conflict/);
	gate.resolve();
	await commit;
	assert.deepEqual(
		[directory.inspect(0).fence, directory.inspect(1).fence],
		[lease.fence, lease.fence]
	);
	assert.throws(() => lease.view(0), /released/);
	const reader = await directory.acquire({ read: [0, 1] });
	assert.deepEqual([reader.view(0)[0], reader.view(1)[0]], [17, 23]);
	reader.view(0)[0] = 88;
	reader.abort();
	const again = await directory.acquire({ read: [0] });
	assert.equal(again.view(0)[0], 17);
	again.abort();
});

test('all-at-once locking permits readers and rejects overlapping writers without partial locks', async () => {
	const { directory } = setup();
	const first = await directory.acquire({ read: [0] });
	const second = await directory.acquire({ read: [0] });
	await assert.rejects(directory.acquire({ write: [0, 1] }), /conflict/);
	const unrelated = await directory.acquire({ write: [1] });
	unrelated.abort();
	first.abort();
	await assert.rejects(directory.acquire({ write: [0] }), /conflict/);
	second.abort();
	const writer = await directory.acquire({ write: [0] });
	await assert.rejects(directory.acquire({ read: [0] }), /conflict/);
	writer.abort();
});

test('owner failures and lost stage responses abort every staged version without partial commit', async () => {
	for (const lost of [false, true]) {
		const a = new MemoryPageOwner('a', scope, 4 * pageBytes);
		const b = new MemoryPageOwner('b', scope, 4 * pageBytes);
		const failing = transport(b, {
			stage: async (...args) => {
				if (lost) await b.stage(...args);
				throw new Error(lost ? 'response lost' : 'owner failed');
			}
		});
		const directory = new PageDirectory({ scope, owners: [a, failing], initialPages: 2 });
		const lease = await directory.acquire({ write: [0, 1] });
		lease.view(0)[0] = 7;
		lease.view(1)[0] = 8;
		await assert.rejects(lease.commit(), /lost|failed/);
		assert.deepEqual([directory.inspect(0).fence, directory.inspect(1).fence], [0, 0]);
		assert.equal(directory.stats.retiredPages, 2);
		assert.deepEqual(await directory.collect(), { discarded: 2, pending: 0 });
		assert.equal(a.bytes + b.bytes, 0);
		await assert.rejects(
			b.stage(scope, { page: 1, fence: lease.fence }, new Uint8Array(pageBytes)),
			/fenced/
		);
	}
});

test('lease expiry during staging blocks lock reuse until the operation revalidates and aborts', async () => {
	let now = 0;
	const gate = deferred(),
		entered = deferred();
	const owner = new MemoryPageOwner('a', scope, 4 * pageBytes);
	const delayed = transport(owner, {
		stage: async (...args) => {
			await owner.stage(...args);
			entered.resolve();
			await gate.promise;
		}
	});
	const directory = new PageDirectory({
		scope,
		owners: [delayed],
		initialPages: 1,
		clock: () => now,
		leaseMilliseconds: 10
	});
	const lease = await directory.acquire({ write: [0] });
	lease.view(0)[0] = 5;
	const commit = lease.commit();
	await entered.promise;
	now = 10;
	await assert.rejects(directory.acquire({ write: [0] }), /conflict/);
	gate.resolve();
	await assert.rejects(commit, /expired/);
	assert.equal(directory.inspect(0).zero, true);
	await directory.collect();
	const next = await directory.acquire({ write: [0] });
	assert.ok(next.fence > lease.fence);
	next.abort();
});

test('expiry during an owner read rejects the resident snapshot and drops its credits', async () => {
	let now = 0,
		delay = false;
	const gate = deferred(),
		entered = deferred();
	const owner = new MemoryPageOwner('a', scope, 4 * pageBytes);
	const delayed = transport(owner, {
		read: async (...args) => {
			const result = await owner.read(...args);
			if (delay) {
				entered.resolve();
				await gate.promise;
			}
			return result;
		}
	});
	const directory = new PageDirectory({
		scope,
		owners: [delayed],
		initialPages: 1,
		clock: () => now,
		leaseMilliseconds: 10
	});
	const writer = await directory.acquire({ write: [0] });
	await writer.commit();
	delay = true;
	const acquisition = directory.acquire({ read: [0] });
	await entered.promise;
	now = 11;
	gate.resolve();
	await assert.rejects(acquisition, /expired/);
	assert.equal(directory.stats.residentBytes, 0);
	assert.equal(directory.stats.leases, 0);
});

test('growth is explicit zero metadata while missing materialized versions are errors', async () => {
	const { directory, a } = setup({ initialPages: 0, maximumPages: 8 });
	assert.equal(directory.grow(8), 0);
	assert.equal(a.bytes, 0);
	assert.throws(() => directory.grow(1), /growth/);
	const reader = await directory.acquire({ read: [7] });
	assert.ok(reader.view(7).every((byte) => byte === 0));
	reader.abort();
	const writer = await directory.acquire({ write: [0] });
	await writer.commit();
	await a.discard(scope, { page: 0, fence: writer.fence });
	await assert.rejects(directory.acquire({ read: [0] }), /missing/);
	assert.equal(directory.inspect(0).zero, false);
});

test('dirty abort and expiry never publish, and incarnation mismatches reject capabilities', async () => {
	let now = 0;
	const { directory } = setup({ clock: () => now, leaseMilliseconds: 5 });
	const writer = await directory.acquire({ write: [0] });
	writer.view(0)[0] = 19;
	writer.abort();
	assert.equal(directory.inspect(0).zero, true);
	const expired = await directory.acquire({ write: [0] });
	now = 5;
	await assert.rejects(expired.commit(), /expired/);
	assert.equal(directory.stats.leases, 0);
	const current = await directory.acquire({ write: [0] });
	const otherScope = { ...scope, incarnation: 'fresh-2' };
	const otherOwner = new MemoryPageOwner('a', otherScope, pageBytes);
	const other = new PageDirectory({ scope: otherScope, owners: [otherOwner], initialPages: 1 });
	await assert.rejects(other.commit(current), /stale/);
	await assert.rejects(otherOwner.read(scope, { page: 0, fence: 1 }), /scope/);
	current.abort();
});

test('resident, snapshot, lease, owner and retirement limits enforce finite credits', async () => {
	const { directory } = setup({
		maximumResidentPages: 2,
		maximumLeasePages: 2,
		maximumLeases: 1
	});
	await assert.rejects(directory.acquire({ read: [0, 1, 2] }), /count/);
	const lease = await directory.acquire({ write: [0, 1] });
	await assert.rejects(directory.acquire({ read: [2] }), /credit/);
	await assert.rejects(lease.commit(), /snapshot credit/);
	lease.abort();
	const owner = new MemoryPageOwner('a', scope, pageBytes);
	const one = new PageDirectory({
		scope,
		owners: [owner],
		initialPages: 2,
		maximumRetiredPages: 2
	});
	const first = await one.acquire({ write: [0] });
	await first.commit();
	const second = await one.acquire({ write: [1] });
	await assert.rejects(second.commit(), /owner credit/);
	assert.equal(one.inspect(1).zero, true);
	const third = await one.acquire({ write: [1] });
	await assert.rejects(third.commit(), /retirement credit/);
	third.abort();
	await one.collect();
	assert.equal(one.stats.retiredPages, 0);
});

test('failed garbage deletion remains charged and never removes live reader versions', async () => {
	let unavailable = true;
	const owner = new MemoryPageOwner('a', scope, 4 * pageBytes);
	const flaky = transport(owner, {
		discard: async (...args) => {
			if (unavailable) throw new Error('unavailable');
			await owner.discard(...args);
		}
	});
	const directory = new PageDirectory({ scope, owners: [flaky], initialPages: 1 });
	const first = await directory.acquire({ write: [0] });
	first.view(0)[0] = 1;
	await first.commit();
	const second = await directory.acquire({ write: [0] });
	second.view(0)[0] = 2;
	await second.commit();
	const reader = await directory.acquire({ read: [0] });
	assert.deepEqual(await directory.collect(), { discarded: 0, pending: 1 });
	unavailable = false;
	assert.deepEqual(await directory.collect(), { discarded: 1, pending: 0 });
	assert.equal(reader.view(0)[0], 2);
	assert.equal(owner.bytes, pageBytes);
	reader.abort();
});

test('owner retries preserve immutable bytes and discard fences delayed requests', async () => {
	const owner = new MemoryPageOwner('a', scope, pageBytes);
	const version = { page: 0, fence: 1 },
		bytes = new Uint8Array(pageBytes);
	bytes[0] = 7;
	await owner.stage(scope, version, bytes);
	await owner.stage(scope, version, bytes);
	bytes[0] = 9;
	assert.equal((await owner.read(scope, version))[0], 7);
	await assert.rejects(owner.stage(scope, version, bytes), /changed/);
	await owner.discard(scope, version);
	await owner.discard(scope, version);
	await assert.rejects(owner.stage(scope, version, bytes), /fenced/);
	assert.equal(owner.bytes, 0);
});
