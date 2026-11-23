// Budget checks for the park protocol. No wasm: a fake instance stands in for the module, and the
// restore check stops at boot.
import assert from 'node:assert/strict';
import { MARK_PARK, Protocol, SCHEDULE, budgetAfterSignal } from './lib.mjs';

const B0 = 10000000;
assert.equal(budgetAfterSignal(40000000, B0), 28000000);
assert.equal(budgetAfterSignal(12000000, B0), B0);
assert.equal(budgetAfterSignal(B0, B0), B0);

const noBoot = async () => {
	throw new Error('boot stop');
};
const sched = { ...SCHEDULE, B0, signalEvents: [], dropBefore: [], dropAfter: [], cutEvent: null };

const manifest = { epoch: 3, budget: 26000000, seenSignal: true };
const store = {
	live: async () => manifest,
	rows: () => [],
	appendEvent: async () => {},
	saveState: async () => {},
	flush: async () => {}
};
const proto = new Protocol({
	factory: noBoot,
	module: null,
	work: '',
	sched: { ...SCHEDULE, B0 },
	store
});
await assert.rejects(proto.event(), /boot stop/);
assert.equal(proto.s.budget, 26000000);
assert.equal(proto.s.seenSignal, true);

// A fake instance whose every run ends in a budget park. Commits go to `writes`.
const enc = new TextEncoder();
const fakeInstance = () => {
	const sink = [];
	return {
		memory: { buffer: new ArrayBuffer(65536) },
		signalAt: 0,
		sink,
		php: {
			FS: { readdir: () => [] },
			ccall(name) {
				if (name !== 'pib_run') return 0;
				order.push('run');
				sink.push(...enc.encode(`x${MARK_PARK}`));
				return Promise.resolve(0);
			}
		},
		ex: {
			emscripten_stack_get_current: () => 1,
			emscripten_stack_get_base: () => 2,
			emscripten_stack_get_end: () => 3,
			getTempRet0: () => 0
		}
	};
};
const writes = [];
const events = [];
const order = [];
const bank = {
	live: async () => null,
	rows: () => [],
	write: async ({ manifest: m }) => {
		writes.push(m);
		return { rows: 1 };
	},
	appendEvent: async (rec) => {
		events.push(rec);
	},
	saveState: async () => {
		order.push('save');
	},
	flush: async () => {
		order.push('flush');
	}
};
const live = new Protocol({ factory: noBoot, module: null, work: '', sched, store: bank });
live.p = fakeInstance();
live.s.started = true;

const first = await live.event();
assert.deepEqual(
	order.slice(0, 3),
	['save', 'flush', 'run'],
	'the attempt is flushed before the run'
);
assert.equal(first.status, 'PARKED');
assert.equal(first.reason, 'BUDGET');
assert.equal(first.budget, B0);
assert.equal(writes.at(-1).budget, 2 * B0, 'the manifest holds the budget after the doubling');
assert.equal(live.s.budget, 2 * B0);

const resumed = new Protocol({
	factory: noBoot,
	module: null,
	work: '',
	sched,
	store: { ...bank, live: async () => writes.at(-1) }
});
await assert.rejects(resumed.event(), /boot stop/);
assert.equal(
	resumed.s.budget,
	2 * B0,
	'a restore right after a budget commit keeps the doubled budget'
);

const second = await live.event();
assert.equal(second.budget, 2 * B0);
assert.equal(writes.at(-1).budget, 4 * B0);
assert.equal(typeof first.isolate, 'string');
assert.notEqual(first.isolate, '');
assert.equal(second.isolate, first.isolate, 'one isolate id per isolate');
assert.equal(typeof first.evMs, 'number');
// Loss detection. An attempt with no commit after it is a kill: the next event halves the budget and
// records a LOST event. An attempt followed by a commit is not a kill, and the manifest budget applies.
const lostEvents = [];
const killStore = (liveEpoch) => ({
	live: async () => ({ epoch: liveEpoch, budget: 40000000, seenSignal: false, groups: 0 }),
	rows: () => [],
	appendEvent: async (rec) => {
		lostEvents.push(rec);
	},
	saveState: async () => {},
	flush: async () => {}
});
const killed = new Protocol({
	factory: noBoot,
	module: null,
	work: '',
	sched,
	store: killStore(4)
});
killed.s.started = true;
killed.s.epoch = 4;
killed.s.budget = 40000000;
const kills = [];
for (let i = 0; i < 3; i++) {
	killed.s.attempt = { k: 8, budget: killed.s.budget, epoch: 4 };
	await assert.rejects(killed.event(), /boot stop/);
	kills.push(killed.s.budget);
}
assert.deepEqual(kills, [20000000, B0, B0], 'halving reaches B0 and stays there');
assert.equal(killed.s.seenSignal, true, 'a kill stops the doubling');
assert.equal(lostEvents.length, 3);
assert.equal(lostEvents[0].status, 'LOST');
assert.equal(lostEvents[0].budget, 40000000);
assert.equal(lostEvents[0].budgetAfter, 20000000);

const committed = new Protocol({
	factory: noBoot,
	module: null,
	work: '',
	sched,
	store: killStore(5)
});
committed.s.started = true;
committed.s.epoch = 4;
committed.s.budget = 80000000;
committed.s.attempt = { k: 8, budget: 80000000, epoch: 4 };
await assert.rejects(committed.event(), /boot stop/);
assert.equal(committed.s.budget, 40000000, 'a commit after the attempt keeps the manifest budget');
assert.equal(lostEvents.length, 3, 'no LOST record when a commit followed the attempt');

console.log('check-budget: ok');
