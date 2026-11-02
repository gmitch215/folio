import assert from 'node:assert/strict';
import { test } from 'vitest';
import { helperSource } from '../../experiments/ranges/kernel.ts';
import { helpers, hex } from '../../experiments/ranges/layout.ts';
import type { Sample, TraceEvent } from '../../experiments/ranges/plan.ts';
import {
	attribute,
	chooseRounds,
	decide,
	expectedInvocations,
	failureOf,
	groups,
	INVOCATION_CAP,
	laneCalls,
	lanesFrom,
	link,
	plan,
	priceRun,
	schedule,
	summarize,
	upperInvocations,
	workerInvocations
} from '../../experiments/ranges/plan.ts';
import { describePlan, verifyFree } from '../../experiments/ranges/run.ts';

const mask = (value: bigint) => BigInt.asUintN(64, value);
const rotl = (value: bigint, by: bigint) => mask((value << by) | (value >> (64n - by)));
const limit = 0x7fffffffffffffffn;
const prime = 0x100000001b3n;
const mix = (h: bigint, word: bigint) => mask(rotl(h ^ word, 5n) * prime);

function referenceFill(length: number, seed: bigint) {
	const x = [0n, 1n, 2n, 3n].map(
		(i) => mask(seed + (((i + 1n) * 0x9e3779b97f4a7c15n) & limit)) | 1n
	);
	const out = new BigUint64Array(length / 8);
	for (let at = 0; at < out.length; at += 4)
		for (let i = 0; i < 4; i++) {
			x[i] = x[i]! ^ mask(x[i]! << 13n);
			x[i] = x[i]! ^ (x[i]! >> 7n);
			x[i] = x[i]! ^ mask(x[i]! << 17n);
			out[at + i] = mask(x[i]! * 0x2545f4914f6cdd1dn);
		}
	return out;
}

function referenceDigest(words: BigUint64Array) {
	const h = [0n, 1n, 2n, 3n].map((i) => (0xcbf29ce484222325n + i * 0x10001n) & limit);
	for (let at = 0; at < words.length; at += 4)
		for (let i = 0; i < 4; i++) h[i] = mix(h[i]!, words[at + i]!);
	return mix(mix(mix(h[0]!, h[1]!), h[2]!), h[3]!);
}

test('the owner helpers fill and digest exactly as the reference does', () => {
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
	const tools = helpers(new WebAssembly.Module(Uint8Array.from(helperSource())), memory);
	tools.fill(0, 131072, 99n);
	const expected = referenceFill(131072, 99n);
	assert.deepEqual(new BigUint64Array(memory.buffer.slice(0)), expected);
	assert.equal(tools.digest(0, 131072), referenceDigest(expected));
	assert.equal(hex(255n), '00000000000000ff');
	const other = new BigUint64Array(expected);
	other[1000] = other[1000]! ^ 1n;
	new BigUint64Array(memory.buffer)[1000] = other[1000]!;
	assert.notEqual(tools.digest(0, 131072), referenceDigest(expected));
	assert.equal(tools.digest(0, 131072), referenceDigest(other));
});

test('the plan fits its cap and counts invocations per request', () => {
	const p = plan();
	assert.equal(p.groups, 8);
	assert.equal(p.cellsPerRound, 32);
	assert.equal(p.durableObjectRows, 0);
	assert.ok(p.withinCap && p.expected <= INVOCATION_CAP);
	assert.ok(p.share < 0.1);
	assert.equal(expectedInvocations('serial', 8388608), 1);
	assert.equal(expectedInvocations('snapshot', 8388608), 17);
	assert.equal(expectedInvocations('snapshot', 33554432), 1);
	assert.equal(expectedInvocations('ranges-warm', 8388608), 17);
	assert.equal(expectedInvocations('ranges-cold', 8388608), 21);
	assert.equal(upperInvocations('ranges-cold', 8388608), 65);
	assert.equal(p.perRequestExpected, 21);
	assert.equal(plan(100).withinCap, false);
	const text = describePlan(10).join('\n');
	assert.match(text, /Durable Object rows: 0/);
	assert.match(text, /within the cap/);
	assert.match(describePlan(100).join('\n'), /OVER THE CAP/);
});

test('every round runs each cell once, cold before warm, in a different order', () => {
	const orders = new Set<string>();
	for (let round = -2; round < 12; round++) {
		const rounds = schedule(round);
		assert.equal(rounds.length, groups.length);
		for (const group of rounds) {
			assert.deepEqual([...group.arms].sort(), [
				'ranges-cold',
				'ranges-warm',
				'serial',
				'snapshot'
			]);
			assert.equal(group.arms.indexOf('ranges-warm'), group.arms.indexOf('ranges-cold') + 1);
		}
		assert.equal(new Set(rounds.map((g) => `${g.arena}-${g.fill}`)).size, groups.length);
		orders.add(JSON.stringify(rounds));
	}
	assert.ok(orders.size >= 10);
});

const sample = (over: Partial<Sample>): Sample => ({
	round: 0,
	rid: 1,
	arena: 8388608,
	fill: 'zero',
	arm: 'snapshot',
	status: 200,
	clientWallMs: 100,
	invocations: 17,
	digest: 'aa',
	value: 1,
	bytesOut: 1000,
	bytesIn: 10,
	transportFallbacks: 0,
	laneFailures: 0,
	...over
});

const round = (r: number, fill: Sample['fill'], wall: [number, number, number, number]) => [
	sample({ round: r, fill, arm: 'serial', invocations: 1, clientWallMs: wall[3], bytesOut: 0 }),
	sample({ round: r, fill, arm: 'snapshot', clientWallMs: wall[0], bytesOut: 100000 }),
	sample({
		round: r,
		fill,
		arm: 'ranges-cold',
		clientWallMs: wall[1],
		bytesOut: 2000,
		escapeRounds: 4,
		footprintHits: 0,
		invocations: 21
	}),
	sample({
		round: r,
		fill,
		arm: 'ranges-warm',
		clientWallMs: wall[2],
		bytesOut: 1900,
		escapeRounds: 0,
		footprintHits: 16
	})
];

test('exactness is linked to the serial sample and failures stay in the row', () => {
	const good = round(0, 'zero', [100, 70, 60, 200]);
	assert.ok(link(good).every((s) => s.exact === true));
	const broken = good.map((s) => (s.arm === 'ranges-warm' ? { ...s, digest: 'bb' } : s));
	assert.equal(failureOf(link(broken).find((s) => s.arm === 'ranges-warm')!), 'inexact');
	const refused = sample({
		arm: 'ranges-cold',
		status: 503,
		error: 'CPU limit',
		digest: undefined
	});
	assert.match(failureOf(refused)!, /status 503: CPU limit/);
	assert.equal(
		failureOf(sample({ arm: 'ranges-cold', transportFallbacks: 2, exact: true })),
		'native fallback'
	);
	assert.equal(
		failureOf(sample({ arm: 'ranges-cold', laneFailures: 1, exact: true })),
		'lane failure'
	);
	// the snapshot arm above its own limit runs natively by design
	assert.equal(
		failureOf(sample({ arena: 33554432, transportFallbacks: 16, bytesOut: 0, exact: true })),
		null
	);
	const rows = summarize([...broken, refused]);
	const warm = rows.find((r) => r.arm === 'ranges-warm')!;
	assert.equal(warm.failures, 1);
	assert.equal(warm.used, 0);
	assert.equal(warm.clientWallMs, null);
	const cold = rows.find((r) => r.arm === 'ranges-cold')!;
	assert.equal(cold.requests, 2);
	assert.equal(cold.failureRate, 0.5);
	assert.deepEqual(cold.failureKinds, { 'status 503: CPU limit': 1 });
});

test('a warm request that found a cold cache is not a warm sample', () => {
	const rows = summarize(
		round(0, 'zero', [100, 70, 60, 200]).map((s) =>
			s.arm === 'ranges-warm' ? { ...s, escapeRounds: 4, footprintHits: 0 } : s
		)
	);
	const warm = rows.find((r) => r.arm === 'ranges-warm')!;
	assert.equal(warm.used, 0);
	assert.equal(warm.cold, 1);
	assert.equal(warm.warm, 0);
});

test('the decision rules read bytes, walls, invocations, failures and the nonzero control', () => {
	const samples = [0, 1, 2].flatMap((r) => [
		...round(r, 'zero', [100, 70, 60, 200]),
		...round(r, 'random', [105, 72, 62, 205])
	]);
	const verdicts = Object.fromEntries(
		decide(summarize(samples), samples).map((v) => [v.id, v.pass])
	);
	assert.deepEqual(verdicts, {
		exact: true,
		'bytes-cold': true,
		'bytes-warm': true,
		'wall-snapshot': true,
		'wall-cold': true,
		'wall-serial': true,
		invocations: true,
		'failure-rate': true,
		'nonzero-control': true
	});
	const slow = samples.map((s) =>
		s.arm === 'ranges-warm' && s.fill === 'random' ? { ...s, clientWallMs: 100 } : s
	);
	const after = Object.fromEntries(decide(summarize(slow), slow).map((v) => [v.id, v.pass]));
	assert.equal(after['nonzero-control'], false);
	const over = samples.map((s) =>
		s.rid === 1 && s.arm === 'ranges-cold' ? { ...s, invocations: 30 } : s
	);
	assert.equal(decide(summarize(over), over).find((v) => v.id === 'invocations')!.pass, false);
	const empty = decide([], []);
	assert.equal(empty.find((v) => v.id === 'exact')!.pass, false);
	assert.equal(empty.find((v) => v.id === 'bytes-warm')!.pass, null);
});

test('tail events join to requests by rid and by the coordinator span', () => {
	const coordinator = (rid: number, at: number, cpu: number): TraceEvent => ({
		scriptName: 'c',
		cpuTime: cpu,
		wallTime: 100,
		eventTimestamp: at,
		event: { request: { url: `https://x.example/run?arm=ranges&rid=${rid}` } }
	});
	const lane = (script: string, at: number, cpu: number): TraceEvent => ({
		scriptName: script,
		cpuTime: cpu,
		wallTime: 5,
		eventTimestamp: at,
		event: { rpcMethod: 'execute' }
	});
	const out = attribute(
		[
			coordinator(1, 1000, 3),
			lane('l1', 1010, 2),
			lane('l2', 1020, 4),
			coordinator(2, 2000, 1),
			lane('l1', 2010, 1),
			lane('l1', 1500, 9),
			{ ...lane('other', 1010, 8) }
		],
		'c',
		['l1', 'l2']
	);
	assert.deepEqual(out.get(1), { coordinatorMs: 3, laneMs: 6, laneMaxMs: 4, laneEvents: 2 });
	assert.deepEqual(out.get(2), { coordinatorMs: 1, laneMs: 1, laneMaxMs: 1, laneEvents: 1 });
	assert.equal(out.size, 2);
});

test('calibration keeps one step below the largest surviving rounds', () => {
	assert.equal(chooseRounds({ 2: true, 4: true, 8: true, 16: false }), 4);
	assert.equal(chooseRounds({ 2: true, 4: false }), 2);
	assert.equal(chooseRounds({ 2: false }), null);
	assert.equal(
		chooseRounds({
			2: true,
			4: true,
			8: true,
			16: true,
			32: true,
			64: true,
			128: true,
			256: true
		}),
		128
	);
});

test('only the Free plan passes, and an unreadable plan passes only for the Free pair', async () => {
	const api = (result: unknown) => (async () => result) as never;
	const denied = (async () => {
		throw new Error('/subscriptions: Authentication error');
	}) as never;
	assert.equal(
		(await verifyFree(api([{ state: 'enabled', rate_plan: { id: 'free' } }]), 'FREE')).checked,
		true
	);
	await assert.rejects(
		verifyFree(api([{ state: 'enabled', rate_plan: { id: 'workers_paid' } }]), 'SELECTED'),
		/paid Workers subscription/
	);
	assert.equal((await verifyFree(denied, 'FREE')).checked, false);
	await assert.rejects(verifyFree(denied, 'SELECTED'), /cannot verify the Free plan/);
});

test('the lane class comes from FOLIO_RANGES_LANES and defaults to Worker lanes', () => {
	assert.equal(lanesFrom(undefined), 'worker');
	assert.equal(lanesFrom(''), 'worker');
	assert.equal(lanesFrom('do'), 'do');
	assert.throws(() => lanesFrom('durable'), /worker or do/);
});

test('the Durable Object plan counts stub calls as invocations and prices them apart', () => {
	const worker = plan(3);
	assert.equal(worker.lanes, 'worker');
	assert.equal(worker.deploys, 5);
	assert.equal(worker.durableObjectCallsPlanned, 0);
	assert.equal(worker.priced, null);
	const objects = plan(3, { lanes: 'do', kernel: 16384 });
	assert.equal(objects.deploys, 2);
	// the invocation arithmetic is the conservative one; only the lower reading differs
	assert.equal(objects.perRequestExpected, worker.perRequestExpected);
	assert.equal(objects.perRequestUpper, worker.perRequestUpper);
	assert.equal(objects.perRequestWithoutObjectCalls, 1);
	assert.equal(workerInvocations('ranges-cold', 8388608, 'do'), 1);
	assert.equal(workerInvocations('ranges-cold', 8388608, 'worker'), 21);
	assert.equal(laneCalls('ranges-cold', 8388608), 20);
	assert.equal(laneCalls('snapshot', 33554432), 0);
	assert.equal(laneCalls('serial', 8388608), 0);
	// a fixed kernel skips the calibration ladder
	assert.equal(objects.calibration, 1);
	assert.ok(objects.withinCap);
	// per group and round: 7 snapshot-capable groups send 16, cold adds 4, warm 16, 32 MiB sends none
	const perRound = 6 * (16 + 20 + 16) + 2 * (0 + 20 + 16);
	assert.equal(objects.durableObjectCallsPlanned, 5 * perRound + 8);
	assert.equal(objects.durableObjectRows, 0);
});

test('the price splits the same requests between Workers and Durable Objects', () => {
	const worker = priceRun(3, 'worker', 16384);
	const objects = priceRun(3, 'do', 16384);
	assert.equal(worker.counts.durableObjectRequests, 0);
	assert.equal(worker.counts.durableObjectGbSeconds, 0);
	// the eight readiness probes are the only calls Durable Objects add
	assert.equal(
		objects.counts.workerRequests + objects.counts.durableObjectRequests,
		worker.counts.workerRequests + 8
	);
	assert.equal(objects.counts.cpuMs, worker.counts.cpuMs);
	assert.equal(objects.objects, 8);
	assert.ok(objects.counts.durableObjectGbSeconds > 0);
	assert.ok(objects.price.total > worker.price.total);
	assert.ok(priceRun(3, 'do', 65536).price.total > objects.price.total);
	assert.ok(objects.price.total < 0.1);
});

test('the dry run states the lane class, the unverified stub count and the price', () => {
	const text = describePlan(3, { lanes: 'do', kernel: 65536 }).join('\n');
	assert.match(text, /lanes: Durable Object, 2 Worker scripts/);
	assert.match(text, /whether a stub call counts \(unverified\)/);
	assert.match(text, /list-rate price at a fixed kernel of 65536 rounds/);
	assert.match(text, /total at most \$/);
	assert.match(describePlan(3).join('\n'), /lanes: service-bound Workers/);
	assert.doesNotMatch(describePlan(3).join('\n'), /list-rate price/);
});

test('a Durable Object lane event carries the coordinator script name and joins by span', () => {
	const coordinator: TraceEvent = {
		scriptName: 'c',
		cpuTime: 2,
		wallTime: 100,
		eventTimestamp: 1000,
		event: { request: { url: 'https://x.example/run?arm=ranges&rid=7' } }
	};
	const object = (at: number, cpu: number, script = 'c'): TraceEvent => ({
		scriptName: script,
		cpuTime: cpu,
		wallTime: 5,
		eventTimestamp: at,
		event: { rpcMethod: 'execute' }
	});
	const out = attribute(
		[coordinator, object(1010, 5), object(1020, 7), object(1030, 9, 'snapshot-owner')],
		'c',
		[]
	);
	assert.deepEqual(out.get(7), { coordinatorMs: 2, laneMs: 12, laneMaxMs: 7, laneEvents: 2 });
});
