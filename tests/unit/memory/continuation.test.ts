import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import {
	CheckpointError,
	changedPages,
	cpuSignal,
	hashPages,
	loadCheckpoint,
	memoryCheckpointStore,
	runSlice,
	saveCheckpoint,
	sqlCheckpointStore,
	type DurableObjectStorage,
	type StopReason
} from '../../../src/memory/continuation.ts';

const PAGE = 65536;
const STEPS = 4096;
const SIGNAL = 1024;
const CELLS = 8192;

interface Hooks {
	beforeInsert?: () => void;
	beforeSync?: () => void;
}

// a durable object's storage over an in-memory SQLite database; a new object stands for a new isolate.
// with crash set, a write survives a kill only once sync() has returned
function openStorage(
	db: DatabaseSync,
	log: string[] = [],
	hooks: Hooks = {},
	crash = false
): DurableObjectStorage {
	if (crash && !db.isTransaction) db.exec('BEGIN');
	const sql = {
		exec(query: string, ...bindings: (string | number | null | ArrayBuffer)[]) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value
			);
			const reading = /^\s*SELECT/i.test(query);
			const writing = /^\s*(INSERT|DELETE|UPDATE)/i.test(query);
			if (writing) log.push(`write ${query.split(/\s+/).slice(0, 3).join(' ')}`);
			if (/^\s*INSERT INTO \S*groups/i.test(query)) hooks.beforeInsert?.();
			const statement = db.prepare(query);
			const rows = reading ? (statement.all(...args) as Record<string, unknown>[]) : [];
			if (!reading) statement.run(...args);
			return { toArray: () => rows };
		}
	};
	return {
		sql,
		transactionSync<T>(closure: () => T): T {
			const [open, close, undo] = crash
				? ['SAVEPOINT t', 'RELEASE t', 'ROLLBACK TO t; RELEASE t']
				: ['BEGIN', 'COMMIT', 'ROLLBACK'];
			db.exec(open);
			try {
				const value = closure();
				db.exec(close);
				return value;
			} catch (error) {
				db.exec(undo);
				throw error;
			}
		},
		async sync() {
			hooks.beforeSync?.();
			log.push('sync');
			if (crash) {
				db.exec('COMMIT');
				db.exec('BEGIN');
			}
		},
		async setAlarm() {
			log.push('alarm');
		}
	} as unknown as DurableObjectStorage;
}

// a guest of linear memory: a step counter, a signal word and scattered writes into the cells
function guestOver(memory: WebAssembly.Memory, target = Infinity) {
	const view = () => new DataView(memory.buffer);
	const guest = {
		signalAt: Infinity,
		steps: () => view().getUint32(STEPS, true),
		run(budget: number): StopReason {
			for (let i = 0; i < budget; i++) {
				const n = guest.steps();
				if (n >= target) return 'finished';
				view().setUint32(STEPS, n + 1, true);
				const cells = (memory.buffer.byteLength - CELLS) / 4;
				view().setUint32(CELLS + ((n * 7) % cells) * 4, n, true);
				if (guest.steps() === guest.signalAt) view().setUint32(SIGNAL, 24, true);
				if (view().getUint32(SIGNAL, true)) return 'signal';
			}
			return 'budget';
		}
	};
	return guest;
}

const signalWord = (memory: WebAssembly.Memory) => ({
	address: SIGNAL,
	get raised() {
		return new DataView(memory.buffer).getUint32(SIGNAL, true) !== 0;
	},
	clear() {
		new DataView(memory.buffer).setUint32(SIGNAL, 0, true);
	}
});

const section = (id: number, body: number[]) => [id, body.length, ...body];
const name = (text: string) => [text.length, ...new TextEncoder().encode(text)];

function moduleBytes({
	memory,
	signal
}: {
	memory: boolean;
	signal: boolean;
}): Uint8Array<ArrayBuffer> {
	const exports: number[][] = [];
	if (memory) exports.push([...name('memory'), 0x02, 0x00]);
	if (signal) exports.push([...name('__instance_signal'), 0x03, 0x00]);
	return new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...(memory ? section(5, [1, 0x00, 1]) : []),
		// i32 global, immutable, initialised to 1024 (the signal word address)
		...(signal ? section(6, [1, 0x7f, 0x00, 0x41, 0x80, 0x08, 0x0b]) : []),
		...(exports.length ? section(7, [exports.length, ...exports.flat()]) : [])
	]);
}

function referenceHash(bytes: Uint8Array): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
	const out: number[] = [];
	for (let base = 0; base < bytes.length; base += PAGE) {
		let h = 0x243f6a8885a308d3n;
		for (let i = 0; i < PAGE; i += 8) {
			h = BigInt.asUintN(64, (h ^ view.getBigUint64(base + i, true)) * 0x9e3779b97f4a7c15n);
			h ^= h >> 32n;
		}
		out.push(Number(h & 0xffffffffn), Number(h >> 32n));
	}
	return out;
}

test('hashPages matches a BigInt reference on aligned and unaligned input', () => {
	const bytes = new Uint8Array(2 * PAGE);
	for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + (i >> 9)) & 0xff;
	assert.deepEqual([...hashPages(bytes)], referenceHash(bytes));
	const shifted = new Uint8Array(2 * PAGE + 1);
	shifted.set(bytes, 1);
	assert.deepEqual([...hashPages(shifted.subarray(1))], referenceHash(bytes));
	const memory = new WebAssembly.Memory({ initial: 1 });
	assert.deepEqual([...hashPages(memory)], referenceHash(new Uint8Array(memory.buffer)));
});

test('hashPages refuses a length that is not whole pages', () => {
	assert.throws(() => hashPages(new Uint8Array(PAGE + 1)), RangeError);
});

test('changedPages: first checkpoint, unchanged, grown memory', () => {
	const first = hashPages(new Uint8Array(2 * PAGE));
	assert.deepEqual(changedPages(first, undefined), [0, 1]);
	assert.deepEqual(changedPages(first, first), []);
	const bytes = new Uint8Array(3 * PAGE);
	bytes[PAGE + 5] = 1;
	assert.deepEqual(changedPages(hashPages(bytes), first), [1, 2]);
	assert.throws(() => changedPages(new Uint32Array(3), undefined), RangeError);
});

test('cpuSignal reads the exported word, and returns undefined without it', () => {
	const instance = new WebAssembly.Instance(
		new WebAssembly.Module(moduleBytes({ memory: true, signal: true }))
	);
	const signal = cpuSignal(instance)!;
	const memory = instance.exports.memory as WebAssembly.Memory;
	assert.equal(signal.address, SIGNAL);
	assert.equal(signal.raised, false);
	new DataView(memory.buffer).setUint32(SIGNAL, 24, true);
	assert.equal(signal.raised, true);
	signal.clear();
	assert.equal(signal.raised, false);

	const plain = new WebAssembly.Instance(
		new WebAssembly.Module(moduleBytes({ memory: true, signal: false }))
	);
	assert.equal(cpuSignal(plain), undefined);
	const unbound = new WebAssembly.Instance(
		new WebAssembly.Module(moduleBytes({ memory: false, signal: true }))
	);
	assert.throws(() => cpuSignal(unbound), TypeError);
});

test('round trip: save, load into a fresh memory, read state and globals back', () => {
	const stores = [
		['memory', () => memoryCheckpointStore()],
		['sql', () => sqlCheckpointStore(openStorage(new DatabaseSync(':memory:')).sql)]
	] as const;
	for (const [label, make] of stores) {
		const store = make();
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 8 });
		new Uint8Array(memory.buffer).set([1, 2, 3], 70000);
		const global = new WebAssembly.Global({ value: 'i64', mutable: true }, 7n);
		const saved = saveCheckpoint(store, memory, {
			globals: { lcg: global },
			stateJson: { at: 3 }
		});
		assert.deepEqual(saved, { epoch: 1, pagesWritten: 2, bytesWritten: 2 * PAGE }, label);

		const target = new WebAssembly.Memory({ initial: 1, maximum: 8 });
		const restoredGlobal = new WebAssembly.Global({ value: 'i64', mutable: true }, 0n);
		const loaded = loadCheckpoint(store, target, { globals: { lcg: restoredGlobal } })!;
		assert.equal(loaded.epoch, 1, label);
		assert.deepEqual(loaded.json<{ at: number }>(), { at: 3 }, label);
		assert.equal(restoredGlobal.value, 7n, label);
		assert.equal(target.buffer.byteLength, 2 * PAGE, label);
		assert.deepEqual(new Uint8Array(target.buffer), new Uint8Array(memory.buffer), label);
	}
	assert.equal(
		loadCheckpoint(memoryCheckpointStore(), new WebAssembly.Memory({ initial: 1 })),
		undefined
	);
});

test('saveCheckpoint takes state or stateJson, not both', () => {
	const memory = new WebAssembly.Memory({ initial: 1 });
	assert.throws(
		() => saveCheckpoint(memoryCheckpointStore(), memory, { state: 'a', stateJson: 1 }),
		TypeError
	);
	const store = memoryCheckpointStore();
	saveCheckpoint(store, memory, { state: 'raw' });
	assert.equal(loadCheckpoint(store, new WebAssembly.Memory({ initial: 1 }))!.state, 'raw');
});

test('a corrupted stored page is refused with code hash and leaves memory alone', () => {
	const db = new DatabaseSync(':memory:');
	const store = sqlCheckpointStore(openStorage(db).sql);
	const memory = new WebAssembly.Memory({ initial: 1 });
	new Uint8Array(memory.buffer).fill(9);
	saveCheckpoint(store, memory);
	const row = db.prepare('SELECT g, bytes FROM continuation_groups').get() as {
		g: number;
		bytes: Uint8Array;
	};
	const bytes = new Uint8Array(row.bytes);
	bytes[5]! ^= 1;
	db.prepare('UPDATE continuation_groups SET bytes = ? WHERE g = ?').run(bytes, row.g);
	const target = new WebAssembly.Memory({ initial: 1 });
	assert.throws(
		() => loadCheckpoint(store, target),
		(error: unknown) => error instanceof CheckpointError && error.code === 'hash'
	);
	assert.equal(new Uint8Array(target.buffer)[0], 0);
});

test('a memory larger than the checkpoint is refused with code size', () => {
	const store = memoryCheckpointStore();
	saveCheckpoint(store, new WebAssembly.Memory({ initial: 1 }));
	assert.throws(
		() => loadCheckpoint(store, new WebAssembly.Memory({ initial: 2 })),
		(error: unknown) => error instanceof CheckpointError && error.code === 'size'
	);
});

test('a global present on one side only is refused with code global', () => {
	const store = memoryCheckpointStore();
	const memory = new WebAssembly.Memory({ initial: 1 });
	saveCheckpoint(store, memory, {
		globals: { a: new WebAssembly.Global({ value: 'i32', mutable: true }, 1) }
	});
	assert.throws(
		() =>
			loadCheckpoint(store, memory, {
				globals: { b: new WebAssembly.Global({ value: 'i32', mutable: true }, 0) }
			}),
		(error: unknown) => error instanceof CheckpointError && error.code === 'global'
	);
	const plain = memoryCheckpointStore();
	saveCheckpoint(plain, memory);
	assert.throws(
		() =>
			loadCheckpoint(plain, memory, {
				globals: { a: new WebAssembly.Global({ value: 'i32' }, 0) }
			}),
		(error: unknown) => error instanceof CheckpointError && error.code === 'global'
	);
});

test('a page with no stored copy is refused with code manifest', () => {
	const db = new DatabaseSync(':memory:');
	const store = sqlCheckpointStore(openStorage(db).sql);
	saveCheckpoint(store, new WebAssembly.Memory({ initial: 1 }));
	db.exec('DELETE FROM continuation_groups');
	assert.throws(
		() => loadCheckpoint(store, new WebAssembly.Memory({ initial: 1 })),
		(error: unknown) => error instanceof CheckpointError && error.code === 'manifest'
	);
});

test('memoryCheckpointStore prunes older copies and rejects a repeated epoch', () => {
	const store = memoryCheckpointStore();
	const memory = new WebAssembly.Memory({ initial: 2 });
	saveCheckpoint(store, memory);
	new Uint8Array(memory.buffer)[10] = 1;
	saveCheckpoint(store, memory);
	assert.equal(store.pages(1, [0]).size, 0);
	assert.equal(store.pages(2, [0]).size, 1);
	assert.throws(() => store.commit({ ...store.latest()! }, new Map()), RangeError);
	assert.throws(
		() => store.commit({ ...store.latest()!, epoch: 9 }, new Map([[0, new Uint8Array(3)]])),
		RangeError
	);
});

test('sqlCheckpointStore prunes inside the commit and honours groupPages', () => {
	const db = new DatabaseSync(':memory:');
	const store = sqlCheckpointStore(openStorage(db).sql, { groupPages: 1, prefix: 'probe_' });
	const memory = new WebAssembly.Memory({ initial: 2 });
	saveCheckpoint(store, memory);
	new Uint8Array(memory.buffer)[10] = 1;
	saveCheckpoint(store, memory);
	const rows = db.prepare('SELECT COUNT(*) AS n FROM probe_groups').get() as { n: number };
	const manifests = db.prepare('SELECT COUNT(*) AS n FROM probe_manifest').get() as { n: number };
	assert.equal(rows.n, 2);
	assert.equal(manifests.n, 1);
	assert.equal(store.pages(1, [0]).size, 0);
	const target = new WebAssembly.Memory({ initial: 2 });
	loadCheckpoint(store, target);
	assert.deepEqual(new Uint8Array(target.buffer), new Uint8Array(memory.buffer));
});

test('bad store and save arguments throw typed errors', () => {
	const db = new DatabaseSync(':memory:');
	assert.throws(() => sqlCheckpointStore(openStorage(db).sql, { prefix: 'a-b' }), TypeError);
	assert.throws(() => sqlCheckpointStore(openStorage(db).sql, { groupPages: 0 }), RangeError);
});

// runSlice cases: one isolate is a storage object plus its memory; a move makes new ones over the same database
const KILLED = new Error('invocation killed');

function world(target = Infinity, crash = false) {
	const db = new DatabaseSync(':memory:');
	const log: string[] = [];
	const hooks: Hooks = {};
	let storage = openStorage(db, log, hooks, crash);
	let memory = new WebAssembly.Memory({ initial: 2, maximum: 16 });
	let guest = guestOver(memory, target);
	let dying = false;
	const slice = async (options: { initialBudget?: number } = {}) => {
		log.push('slice');
		return runSlice({
			storage,
			memory,
			signal: signalWord(memory),
			initialBudget: options.initialBudget ?? 100,
			run(n) {
				log.push('run');
				if (dying) {
					dying = false;
					throw KILLED;
				}
				return guest.run(n);
			},
			steps: () => guest.steps()
		});
	};
	const move = (target2 = target) => {
		storage = openStorage(db, log, hooks, crash);
		memory = new WebAssembly.Memory({ initial: 2, maximum: 16 });
		guest = guestOver(memory, target2);
	};
	return {
		db,
		log,
		hooks,
		slice,
		move,
		get guest() {
			return guest;
		},
		get memory() {
			return memory;
		},
		// the next run throws, and the slice rejects with KILLED
		dieInRun() {
			dying = true;
		},
		// the invocation ends where it stands: unsynced writes are gone and the isolate with them
		async kill(attempt: Promise<unknown>) {
			await assert.rejects(attempt, (error) => error === KILLED);
			db.exec('ROLLBACK');
			db.exec('BEGIN');
			move();
		}
	};
}

const marker = (w: ReturnType<typeof world>) =>
	({ ...w.db.prepare('SELECT k, budget, open FROM continuation_attempt').get() }) as {
		k: number;
		budget: number;
		open: number;
	};

test('runSlice in the same isolate does not restore', async () => {
	const w = world();
	const first = await w.slice();
	w.log.length = 0;
	const second = await w.slice();
	assert.equal(first.restored, false);
	assert.equal(second.restored, false);
	assert.equal(second.stop, 'budget');
	assert.equal(w.guest.steps(), 300);
	const sync = w.log.indexOf('sync');
	assert.ok(sync >= 0 && sync < w.log.indexOf('alarm'), w.log.join(' | '));
});

test('runSlice in a changed isolate restores the last checkpoint', async () => {
	const w = world();
	await w.slice();
	w.move();
	const moved = await w.slice();
	assert.equal(moved.restored, true);
	assert.equal(w.guest.steps(), 300);
});

test('a finished guest commits and does not re-arm', async () => {
	const w = world(150);
	await w.slice();
	w.log.length = 0;
	const done = await w.slice();
	assert.equal(done.finished, true);
	assert.equal(done.stop, 'finished');
	assert.equal(w.log.includes('alarm'), false);
});

test('a bookkeeping write is awaited before the guest runs', async () => {
	const w = world();
	await w.slice();
	await w.slice();
	w.guest.signalAt = w.guest.steps() + 50;
	await w.slice();
	w.guest.signalAt = Infinity;
	w.log.length = 0;
	await w.slice();
	const sync = w.log.lastIndexOf('sync', w.log.indexOf('run'));
	const write = w.log.findIndex((entry) => entry.startsWith('write'));
	assert.ok(write >= 0 && write < sync && sync < w.log.indexOf('run'), w.log.join(' | '));
});

test('the budget doubles, then follows 0.7 of the steps at a signal, then grows 2% per commit', async () => {
	const w = world();
	const budgets: number[] = [];
	budgets.push((await w.slice()).budget);
	budgets.push((await w.slice()).budget);
	w.guest.signalAt = w.guest.steps() + 150;
	const signalled = await w.slice();
	assert.equal(signalled.stop, 'signal');
	budgets.push(signalled.budget);
	w.guest.signalAt = Infinity;
	budgets.push((await w.slice()).budget);
	budgets.push((await w.slice()).budget);
	assert.deepEqual(budgets, [200, 400, 105, 107, 109]);
});

test('a signal stop writes nothing before the re-arm', async () => {
	const w = world();
	await w.slice();
	w.guest.signalAt = w.guest.steps() + 20;
	w.log.length = 0;
	const stopped = await w.slice();
	assert.equal(stopped.stop, 'signal');
	const from = w.log.indexOf('run');
	const alarm = w.log.indexOf('alarm');
	assert.ok(alarm > from);
	assert.equal(
		w.log.slice(from, alarm).some((entry) => entry.startsWith('write')),
		false
	);
});

test('a signal raised during the commit rolls it back and reports cut', async () => {
	const w = world();
	const first = await w.slice();
	assert.equal(first.epoch, 1);
	const memory = w.memory;
	let armed = true;
	w.hooks.beforeInsert = () => {
		if (armed) new DataView(memory.buffer).setUint32(SIGNAL, 24, true);
		armed = false;
	};
	const cut = await w.slice();
	assert.equal(cut.stop, 'cut');
	assert.equal(cut.epoch, 1);
	const newest = w.db
		.prepare('SELECT COUNT(*) AS n FROM continuation_groups WHERE epoch > 1')
		.get() as { n: number };
	assert.equal(newest.n, 0);
	const target = new WebAssembly.Memory({ initial: 2 });
	assert.equal(loadCheckpoint(sqlCheckpointStore(openStorage(w.db).sql), target)!.epoch, 1);
});

test('after a move that follows a signal stop, the budget comes back from the manifest', async () => {
	const w = world();
	await w.slice();
	w.guest.signalAt = w.guest.steps() + 150;
	const signalled = await w.slice();
	assert.equal(signalled.budget, 105);
	w.guest.signalAt = Infinity;
	w.move();
	const moved = await w.slice();
	assert.equal(moved.restored, true);
	assert.equal(moved.budget, 400);
});

test('runSlice refuses a non-positive initialBudget', async () => {
	const w = world();
	await assert.rejects(w.slice({ initialBudget: 0 }), RangeError);
});

// loss detection: a kill is the only thing that leaves an attempt with no commit after it
async function committed(w: ReturnType<typeof world>, count: number) {
	for (let i = 0; i < count; i++) await w.slice();
}

test('a killed attempt halves the budget at the next event and reports it', async () => {
	const w = world(Infinity, true);
	await committed(w, 2);
	w.dieInRun();
	await w.kill(w.slice());
	assert.deepEqual(marker(w), { k: 3, budget: 400, open: 1 });

	const retry = await w.slice();
	assert.deepEqual(retry.lost, { k: 3, from: 400, to: 200 });
	assert.equal(retry.restored, true);
	assert.equal(w.guest.steps(), 300 + 200);
	assert.equal(retry.budget, 204);
	assert.equal(retry.epoch, 3);
	assert.equal((await w.slice()).lost, undefined);
	assert.equal(marker(w).k, 4);
});

test('repeated kills reach the initial budget and stay there', async () => {
	const w = world(Infinity, true);
	await committed(w, 3);
	const seen: number[] = [];
	for (let i = 0; i < 5; i++) {
		w.dieInRun();
		await w.kill(w.slice());
		const { k, budget } = marker(w);
		assert.equal(k, 4);
		seen.push(budget);
	}
	assert.deepEqual(seen, [800, 400, 200, 100, 100]);
	const retry = await w.slice();
	assert.deepEqual(retry.lost, { k: 4, from: 100, to: 100 });
	assert.equal(retry.budget, 102);
});

test('a kill before the marker flush returns loses the marker, so the next event does not halve', async () => {
	const w = world(Infinity, true);
	await committed(w, 2);
	w.hooks.beforeSync = () => {
		w.hooks.beforeSync = undefined;
		throw KILLED;
	};
	await w.kill(w.slice());
	assert.equal(marker(w).k, 2);

	const retry = await w.slice();
	assert.equal(retry.lost, undefined);
	assert.equal(retry.restored, true);
	assert.equal(w.guest.steps(), 300 + 400);
	assert.equal(retry.budget, 800);
});

test('after a loss the budget grows 2% per commit, not double, and a signal still resets it', async () => {
	const w = world(Infinity, true);
	await committed(w, 2);
	w.dieInRun();
	await w.kill(w.slice());
	const budgets: number[] = [];
	budgets.push((await w.slice()).budget);
	budgets.push((await w.slice()).budget);
	w.guest.signalAt = w.guest.steps() + 150;
	const signalled = await w.slice();
	assert.equal(signalled.stop, 'signal');
	budgets.push(signalled.budget);
	w.guest.signalAt = Infinity;
	budgets.push((await w.slice()).budget);
	assert.deepEqual(budgets, [204, 208, 105, 107]);
});

test('a restore keeps the measured flag, so the budget does not double after a signal', async () => {
	const w = world();
	await w.slice();
	w.guest.signalAt = w.guest.steps() + 150;
	await w.slice();
	w.guest.signalAt = Infinity;
	assert.equal((await w.slice()).budget, 107);
	w.move();
	const moved = await w.slice();
	assert.equal(moved.restored, true);
	assert.equal(moved.budget, 109);
});

test('a signal stop and a cut close the attempt, so a move after them is not a loss', async () => {
	const w = world();
	await w.slice();
	w.guest.signalAt = w.guest.steps() + 20;
	assert.equal((await w.slice()).stop, 'signal');
	w.guest.signalAt = Infinity;
	w.move();
	assert.equal((await w.slice()).lost, undefined);

	const memory = w.memory;
	w.hooks.beforeInsert = () => {
		w.hooks.beforeInsert = undefined;
		new DataView(memory.buffer).setUint32(SIGNAL, 24, true);
	};
	assert.equal((await w.slice()).stop, 'cut');
	w.move();
	assert.equal((await w.slice()).lost, undefined);
});

test('a run that throws in the same isolate is not a loss', async () => {
	const w = world();
	await w.slice();
	w.dieInRun();
	await assert.rejects(w.slice(), (error) => error === KILLED);
	assert.equal((await w.slice()).lost, undefined);
});

test('the attempt row is flushed after it is written and before the guest runs', async () => {
	const w = world();
	w.log.length = 0;
	await w.slice();
	const run = w.log.indexOf('run');
	const write = w.log.findIndex((entry) => entry.startsWith('write INSERT OR REPLACE'));
	assert.ok(write >= 0 && w.log.indexOf('sync', write) < run, w.log.join(' | '));
});

test('sqlCheckpointStore exposes flush only when it is given a sync', async () => {
	const db = new DatabaseSync(':memory:');
	const log: string[] = [];
	const storage = openStorage(db, log);
	assert.equal(sqlCheckpointStore(storage.sql).flush, undefined);
	const store = sqlCheckpointStore(storage.sql, { sync: () => storage.sync() });
	await store.flush!();
	assert.deepEqual(log, ['sync']);
	assert.equal(memoryCheckpointStore().flush, undefined);
});
