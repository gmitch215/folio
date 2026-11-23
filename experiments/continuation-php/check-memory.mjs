// Peak extra allocation of the checkpoint path. Each sample is taken after a collection, so the
// array-buffer count is what is live. Run as: node --expose-gc check-memory.mjs
import assert from 'node:assert/strict';
import { GROUP, RestoreError, capture, restoreGroups, sqlStore } from './lib.mjs';

if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');

const GROUPS = 8;
const BYTES = GROUPS * GROUP;
const SLOTS = GROUPS * 3;
const arrayBytes = () => {
	globalThis.gc();
	return process.memoryUsage().arrayBuffers;
};

const memory = { buffer: new ArrayBuffer(BYTES) };
const words = new Uint32Array(memory.buffer);
for (let i = 0; i < words.length; i++) words[i] = Math.imul(i, 2654435761) >>> 0;

// Rows live in one preallocated arena, so the store's own copies are the only new allocations.
const arena = new ArrayBuffer(SLOTS * GROUP);
const arenaBytes = new Uint8Array(arena);
const free = Array.from({ length: SLOTS }, (_, i) => i * GROUP);
const slots = new Map();
let manifestBody = null;
let peak = -Infinity;
const sample = () => {
	peak = Math.max(peak, arrayBytes());
};

const cursor = (rows) => ({
	toArray: () => rows,
	[Symbol.iterator]: () => rows[Symbol.iterator]()
});
// a fresh copy per row, as a storage cursor returns it; no generator local keeps the previous row
const rowBytes = (off) => {
	const bytes = arena.slice(off, off + GROUP);
	sample();
	return bytes;
};
function* liveRows() {
	for (const [key, off] of [...slots]) {
		const [epoch, idx] = key.split(':').map(Number);
		yield { epoch, idx, bytes: rowBytes(off) };
	}
}
const sql = {
	exec(query, ...args) {
		if (query.startsWith('INSERT OR REPLACE INTO grp')) {
			const [epoch, idx, bytes] = args;
			const key = `${epoch}:${idx}`;
			sample();
			const off = slots.get(key) ?? free.pop();
			arenaBytes.set(new Uint8Array(bytes), off);
			slots.set(key, off);
			return cursor([]);
		}
		if (query.startsWith('INSERT OR REPLACE INTO manifest')) {
			manifestBody = args[0];
			return cursor([]);
		}
		if (query.startsWith('SELECT body FROM manifest')) {
			return cursor(manifestBody === null ? [] : [{ body: manifestBody }]);
		}
		if (query === 'SELECT epoch, idx FROM grp') {
			return cursor(
				[...slots.keys()].map((k) => {
					const [epoch, idx] = k.split(':').map(Number);
					return { epoch, idx };
				})
			);
		}
		if (query.startsWith('DELETE FROM grp')) {
			const key = `${args[0]}:${args[1]}`;
			free.push(slots.get(key));
			slots.delete(key);
			return cursor([]);
		}
		if (query === 'SELECT epoch, idx, bytes FROM grp') return liveRows();
		throw new Error(`unexpected statement: ${query}`);
	}
};
let failNextSync = false;
const storage = {
	sql,
	transactionSync: (fn) => fn(),
	sync: async () => {
		if (!failNextSync) return;
		failNextSync = false;
		throw new Error('cut');
	}
};
const store = sqlStore(storage);

const sameBytes = (a, b) => Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) === 0;
const manifestFor = (cap, epoch, prevEpochs = []) => {
	const changed = new Set(cap.changed);
	return {
		epoch,
		memBytes: cap.bytes,
		groups: cap.groups,
		hashes: cap.hashes,
		epochs: cap.hashes.map((_, gi) => (changed.has(gi) ? epoch : prevEpochs[gi]))
	};
};

// first commit: every group is new, so every group is copied and inserted once
assert.equal(await store.live(), null);
const cap0 = await capture({ memory }, []);
assert.equal(cap0.changed.length, GROUPS);
const m0 = manifestFor(cap0, 0);
let base = arrayBytes();
peak = -Infinity;
await store.write({ memory, changed: cap0.changed, epoch: 0, manifest: m0 });
const commitExtra = peak - base;
assert.ok(commitExtra <= 2 * GROUP, `commit peak extra ${commitExtra} bytes`);
assert.equal(slots.size, GROUPS);

// restore from that manifest into a fresh memory: each row is copied once, then the hashes are checked
const fresh = { buffer: new ArrayBuffer(BYTES) };
base = arrayBytes();
peak = -Infinity;
await restoreGroups(fresh, await store.live(), store.rows());
const restoreExtra = peak - base;
// the restore reading is 2 to 3 groups under GC sampling; the bound is a constant, not the memory size
assert.ok(restoreExtra <= 3 * GROUP, `restore peak extra ${restoreExtra} bytes`);
assert.ok(sameBytes(fresh, memory));

// one group changes: one row is written and the replaced row of the old epoch is pruned
new Uint32Array(memory.buffer, 3 * GROUP, 16).fill(0xdeadbeef);
const live0 = await store.live();
const cap1 = await capture({ memory }, live0.hashes);
assert.deepEqual(cap1.changed, [3]);
const m1 = manifestFor(cap1, 1, live0.epochs);
await store.write({ memory, changed: cap1.changed, epoch: 1, manifest: m1 });
assert.equal(slots.size, GROUPS);
assert.ok(!slots.has('0:3'));
const fresh1 = { buffer: new ArrayBuffer(BYTES) };
await restoreGroups(fresh1, await store.live(), store.rows());
assert.ok(sameBytes(fresh1, memory));

// a commit cut between batches leaves rows of epoch 2 with no manifest: the manifest still names
// epoch 1, so restore skips those rows, and the next commit overwrites and prunes them
new Uint32Array(memory.buffer, 5 * GROUP, 16).fill(0x12345678);
new Uint32Array(memory.buffer, 6 * GROUP, 16).fill(0x87654321);
const cap2 = await capture({ memory }, m1.hashes);
assert.deepEqual(cap2.changed, [5, 6]);
const m2 = manifestFor(cap2, 2, m1.epochs);
const cut = new Error('cut');
failNextSync = true;
await assert.rejects(store.write({ memory, changed: cap2.changed, epoch: 2, manifest: m2 }), cut);
assert.ok(slots.has('2:5') && slots.has('2:6'), 'the orphan rows are in the store');
assert.equal((await store.live()).epoch, 1);
const fresh2 = { buffer: new ArrayBuffer(BYTES) };
await restoreGroups(fresh2, await store.live(), store.rows());
assert.ok(sameBytes(fresh2, fresh1), 'restore ignores a cut commit');
await store.write({ memory, changed: cap2.changed, epoch: 2, manifest: m2 });
assert.equal(slots.size, GROUPS);
assert.ok(!slots.has('0:5') && !slots.has('0:6'), 'the replaced rows are pruned');

// a row whose bytes differ from the manifest's hash is refused
const off = slots.get('2:5');
arenaBytes[off + 7] ^= 0xff;
await assert.rejects(
	restoreGroups({ buffer: new ArrayBuffer(BYTES) }, await store.live(), store.rows()),
	RestoreError
);

console.log(
	`check-memory: ok (commit peak extra ${commitExtra} bytes, restore peak extra ${restoreExtra} bytes)`
);
