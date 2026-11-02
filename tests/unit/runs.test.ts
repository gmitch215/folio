import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepare } from '../../src/compiler.ts';
import { Coordinator } from '../../src/coordinator.ts';
import {
	decodeFrame,
	decodeResults,
	encodeFrame,
	encodeResults,
	runsVersion
} from '../../src/frames.ts';
import { inlineLane } from '../../src/inline.ts';
import type { ManagedArtifact, ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { memoryImports } from '../../src/memory.ts';
import { encodeRangesFrame, escapes, RangeSet, resultEscapes } from '../../src/ranges.ts';
import {
	capRuns,
	checkRuns,
	DirtyRuns,
	packWrites,
	runBytes,
	runsOfSorted,
	writeRunsOf
} from '../../src/runs.ts';
import type { TransactionResult } from '../../src/transaction.ts';

// a fixed-seed generator so a failure reproduces
function random(seed: number) {
	let state = seed >>> 0;
	return (below: number) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return Math.floor((state / 0x100000000) * below);
	};
}
const pairs = (runs: ArrayLike<number>): [number, number][] => {
	const out: [number, number][] = [];
	for (let i = 0; i < runs.length; i += 2) out.push([runs[i]!, runs[i + 1]!]);
	return out;
};
const expand = (runs: ArrayLike<number>): number[] => {
	const out: number[] = [];
	for (const [start, length] of pairs(runs)) for (let k = 0; k < length; k++) out.push(start + k);
	return out;
};

test('runs of sorted addresses coalesce, ignore repeats and keep isolated bytes', () => {
	assert.deepEqual(pairs(runsOfSorted([])), []);
	assert.deepEqual(pairs(runsOfSorted([7])), [[7, 1]]);
	assert.deepEqual(pairs(runsOfSorted([0, 1, 1, 2, 4, 5, 9])), [
		[0, 3],
		[4, 2],
		[9, 1]
	]);
	assert.equal(runBytes(runsOfSorted([0, 1, 2, 10])), 4);
});

test('write runs carry each byte once and merge touching pieces in address order', () => {
	const { runs, data } = writeRunsOf([
		[11, 3],
		[10, 2],
		[40, 9],
		[12, 4],
		[10, 5]
	]);
	assert.deepEqual(pairs(runs), [
		[10, 3],
		[40, 1]
	]);
	assert.deepEqual([...data], [5, 3, 4, 9]);
	const packed = packWrites([
		[32, Uint8Array.of(3, 4)],
		[0, Uint8Array.of(1, 2)],
		[2, Uint8Array.of(9)],
		[100, new Uint8Array()],
		[34, Uint8Array.of(5)]
	]);
	assert.deepEqual(pairs(packed.runs), [
		[0, 3],
		[32, 3]
	]);
	assert.deepEqual([...packed.data], [1, 2, 9, 3, 4, 5]);
	assert.deepEqual(pairs(packWrites([]).runs), []);
});

test('capRuns keeps a byte prefix and never returns a zero-length run', () => {
	const runs = Uint32Array.of(0, 4, 10, 4, 20, 4);
	assert.deepEqual(pairs(capRuns(runs, 100)), pairs(runs));
	assert.deepEqual(pairs(capRuns(runs, 6)), [
		[0, 4],
		[10, 2]
	]);
	assert.deepEqual(pairs(capRuns(runs, 4)), [[0, 4]]);
	assert.deepEqual(pairs(capRuns(runs, 0)), []);
	assert.deepEqual(pairs(capRuns(runs, -3)), []);
});

test('checkRuns names every way a run list can be wrong', () => {
	checkRuns(Uint32Array.of(0, 1, 2, 3, 100, 28), 128, 'read');
	checkRuns(Uint32Array.of(), 0, 'read');
	assert.throws(() => checkRuns(Uint32Array.of(5, 0), 128, 'read'), /non-canonical lane read/);
	assert.throws(() => checkRuns(Uint32Array.of(0, 4, 4, 4), 128, 'read'), /non-canonical/);
	assert.throws(() => checkRuns(Uint32Array.of(0, 4, 3, 4), 128, 'write'), /non-canonical/);
	assert.throws(() => checkRuns(Uint32Array.of(10, 2, 0, 2), 128, 'write'), /non-canonical/);
	assert.throws(() => checkRuns(Uint32Array.of(127, 2), 128, 'read'), /read outside arena/);
	assert.throws(() => checkRuns(Uint32Array.of(0, 4), 3, 'write'), /write outside arena/);
});

test('dirty runs merge touching and nested writes and answer overlaps at the byte', () => {
	const dirty = new DirtyRuns();
	assert.equal(dirty.overlaps(Uint32Array.of(0, 100)), false);
	dirty.add(10, 4);
	dirty.add(14, 2);
	assert.deepEqual(pairs(dirty.runs()), [[10, 6]]);
	dirty.add(12, 1);
	dirty.add(30, 1);
	dirty.add(0, 0);
	dirty.add(0, 3);
	assert.deepEqual(pairs(dirty.runs()), [
		[0, 3],
		[10, 6],
		[30, 1]
	]);
	dirty.add(2, 9);
	assert.deepEqual(pairs(dirty.runs()), [
		[0, 16],
		[30, 1]
	]);
	dirty.add(16, 14);
	assert.deepEqual(pairs(dirty.runs()), [[0, 31]]);
	assert.equal(dirty.count, 1);
	const other = new DirtyRuns();
	other.add(64, 32);
	assert.equal(other.overlaps(Uint32Array.of(0, 64)), false, 'a read ending at the write start');
	assert.equal(other.overlaps(Uint32Array.of(0, 65)), true, 'one shared byte');
	assert.equal(other.overlaps(Uint32Array.of(95, 1)), true, 'the last written byte');
	assert.equal(other.overlaps(Uint32Array.of(96, 8)), false, 'a read starting at the write end');
	assert.equal(other.overlaps(Uint32Array.of(0, 8, 90, 2, 200, 4)), true);
	assert.equal(other.overlaps(Uint32Array.of(0, 8, 96, 2, 200, 4)), false);
	assert.equal(other.has(64) && other.has(95) && !other.has(63) && !other.has(96), true);
});

test('dirty runs and escapes equal the per-address path on random inputs', () => {
	const next = random(20261102);
	for (let round = 0; round < 300; round++) {
		const memory = 1 + next(600);
		const dirty = new DirtyRuns();
		const set = new Set<number>();
		for (let w = next(8); w > 0; w--) {
			const length = 1 + next(40),
				start = next(memory);
			dirty.add(start, length);
			for (let k = 0; k < length; k++) set.add(start + k);
		}
		assert.deepEqual(
			expand(dirty.runs()),
			[...set].sort((a, b) => a - b)
		);
		for (let a = 0; a < memory + 50; a += 1 + next(7)) assert.equal(dirty.has(a), set.has(a));
		// a read list as 64-byte granules (the inline lane) or as single bytes (the callout lane)
		const reads = new Set<number>();
		for (let r = next(12); r > 0; r--) {
			const granule = next(2) ? 64 : 1;
			const start = Math.floor(next(memory) / granule) * granule;
			for (let k = 0; k < granule; k++) reads.add(start + k);
		}
		const addresses = [...reads].sort((a, b) => a - b);
		const runs = runsOfSorted(addresses);
		assert.deepEqual(expand(runs), addresses);
		assert.equal(
			dirty.overlaps(runs),
			addresses.some((a) => set.has(a)),
			`round ${round}`
		);
		const shipped = RangeSet.of(
			Array.from({ length: next(5) }, () => [next(memory), 1 + next(200)] as [number, number])
		);
		assert.deepEqual(
			RangeSet.fromRuns(runs).subtract(shipped).spans(),
			escapes(addresses, shipped).spans(),
			`escapes, round ${round}`
		);
		assert.deepEqual(
			resultEscapes({ reads: [], readRuns: runs }, shipped).spans(),
			resultEscapes({ reads: addresses }, shipped).spans()
		);
		assert.deepEqual(pairs(RangeSet.fromRuns(runs).runs()), pairs(runs));
	}
});

test('a shipped boundary inside a granule escapes the unshipped half exactly', () => {
	const shipped = RangeSet.of([[0, 4128]]);
	const lost = RangeSet.fromRuns(Uint32Array.of(4096, 64)).subtract(shipped);
	assert.deepEqual(lost.spans(), [[4128, 32]]);
});

const identity = { session: 'runs', epoch: 2, sequence: 5 };
const decodeOptions = (extra: object = {}) => ({
	maximumFrameBytes: 1 << 24,
	memoryBytes: 65536,
	maxBytes: 4096,
	calls: 2,
	runs: true,
	...extra
});
const sample: TransactionResult[] = [
	{
		value: 7,
		reads: [],
		writes: [],
		readRuns: Uint32Array.of(64, 64, 1000, 1),
		writeRuns: Uint32Array.of(10, 2, 500, 1),
		writeData: Uint8Array.of(1, 2, 3),
		escapes: [[1000, 1]]
	},
	{
		reads: [],
		writes: [],
		readRuns: new Uint32Array(),
		writeRuns: new Uint32Array(),
		exhausted: true
	}
];

test('a run results frame round trips and carries byte counts for readers of the header', () => {
	const frame = encodeResults(identity, sample, 1 << 24, true);
	const { header } = decodeFrame<{ runs: number; results: any[] }>(frame, 1 << 24);
	assert.equal(header.runs, runsVersion);
	assert.equal(header.results[0].readBytes, 65);
	assert.equal(header.results[0].writeBytes, 3);
	assert.equal(header.results[0].reads, 2);
	const back = decodeResults(frame, identity, decodeOptions());
	assert.deepEqual(pairs(back[0]!.readRuns!), [
		[64, 64],
		[1000, 1]
	]);
	assert.deepEqual(pairs(back[0]!.writeRuns!), [
		[10, 2],
		[500, 1]
	]);
	assert.deepEqual([...back[0]!.writeData!], [1, 2, 3]);
	assert.deepEqual(back[0]!.escapes, [[1000, 1]]);
	assert.equal(back[0]!.value, 7);
	assert.equal(back[1]!.exhausted, true);
	assert.equal(back[1]!.readRuns!.length, 0);
});

test('results with addresses convert on encode and give the same runs', () => {
	const legacy: TransactionResult[] = [
		{
			reads: [5, 3, 4, 900, 5],
			writes: [
				[21, 9],
				[20, 8],
				[30, 1]
			]
		},
		{ reads: [], writes: [] }
	];
	const back = decodeResults(
		encodeResults(identity, legacy, 1 << 24, true),
		identity,
		decodeOptions()
	);
	assert.deepEqual(pairs(back[0]!.readRuns!), [
		[3, 3],
		[900, 1]
	]);
	assert.deepEqual(pairs(back[0]!.writeRuns!), [
		[20, 2],
		[30, 1]
	]);
	assert.deepEqual([...back[0]!.writeData!], [8, 9, 1]);
});

test('an address frame still decodes under a run request, and a run frame is refused otherwise', () => {
	const old = decodeResults(
		encodeResults(identity, [
			{ reads: [1, 2], writes: [[3, 4]] },
			{ reads: [], writes: [] }
		]),
		identity,
		decodeOptions()
	);
	assert.deepEqual(old[0]!.reads, [1, 2]);
	assert.equal(old[0]!.readRuns, undefined);
	const frame = encodeResults(identity, sample, 1 << 24, true);
	assert.throws(
		() => decodeResults(frame, identity, decodeOptions({ runs: false })),
		/unrequested run encoding/
	);
	assert.throws(
		() => decodeResults(frame, identity, decodeOptions({ runs: undefined })),
		TypeError
	);
	const future = decodeFrame<any>(frame, 1 << 24);
	const bumped = encodeFrame({ ...future.header, runs: 2 }, future.payload);
	assert.throws(
		() => decodeResults(bumped, identity, decodeOptions()),
		/unsupported results encoding/
	);
	assert.throws(
		() => decodeResults(encodeResults(identity, [], 1 << 24, true), identity, decodeOptions()),
		/invalid lane result count/
	);
});

test('decoding refuses run lists that are unsorted, touching, empty, outside the arena or miscounted', () => {
	const make = (patch: (r: any) => void, payload?: (bytes: Uint8Array) => Uint8Array) => {
		const { header, payload: bytes } = decodeFrame<any>(
			encodeResults(identity, sample, 1 << 24, true),
			1 << 24
		);
		patch(header.results[0]);
		return encodeFrame(header, payload ? payload(bytes) : bytes);
	};
	const put = (offset: number, value: number) => (bytes: Uint8Array) => {
		const copy = bytes.slice();
		new DataView(copy.buffer).setUint32(offset, value, true);
		return copy;
	};
	const refuse = (frame: Uint8Array, error: RegExp, kind = TypeError) =>
		assert.throws(
			() => decodeResults(frame, identity, decodeOptions()),
			(e) => {
				assert.ok(e instanceof kind, String(e));
				assert.match((e as Error).message, error);
				return true;
			}
		);
	// payload words: read runs at 0 to 12, write runs at 16 to 28, then bytes and the escape
	refuse(
		make(() => {}, put(0, 2000)),
		/non-canonical lane read/
	);
	refuse(
		make(() => {}, put(4, 0)),
		/non-canonical lane read/
	);
	refuse(
		make(() => {}, put(8, 128)),
		/non-canonical lane read/
	);
	refuse(
		make(() => {}, put(8, 65536)),
		/lane read outside arena/,
		RangeError
	);
	refuse(
		make(() => {}, put(24, 11)),
		/non-canonical lane write/
	);
	refuse(
		make(() => {}, put(24, 65536)),
		/lane write outside arena/,
		RangeError
	);
	refuse(
		make((r) => (r.readBytes = 64), undefined),
		/invalid lane tracking counts/
	);
	refuse(
		make((r) => (r.writeBytes = 2), undefined),
		/lane tracking|invalid lane tracking/
	);
	refuse(
		make((r) => (r.reads = -1), undefined),
		/invalid lane tracking counts/
	);
	refuse(
		make((r) => (r.readBytes = 1e12), undefined),
		/lane tracking exceeds limit/,
		RangeError
	);
	refuse(
		make((r) => (r.reads = 3), undefined),
		/exceeds limit|invalid|non-canonical/,
		Error as any
	);
	refuse(
		make(
			() => {},
			(bytes) => bytes.slice(0, bytes.length - 1)
		),
		/exceeds limit/,
		RangeError
	);
	refuse(
		make(
			() => {},
			(bytes) => Uint8Array.of(...bytes, 0)
		),
		/unconsumed lane payload/
	);
	refuse(
		make((r) => (r.trap = 5), undefined),
		/invalid lane trap/
	);
	assert.throws(
		() =>
			decodeResults(
				make(() => {}),
				identity,
				decodeOptions({ maxBytes: 8 })
			),
		RangeError
	);
	assert.throws(
		() =>
			decodeResults(
				make(() => {}),
				{ ...identity, sequence: 6 },
				decodeOptions()
			),
		/stale lane response/
	);
});

test('encoding refuses write data that does not match its runs', () => {
	assert.throws(
		() =>
			encodeResults(
				identity,
				[
					{
						reads: [],
						writes: [],
						writeRuns: Uint32Array.of(0, 4),
						writeData: Uint8Array.of(1)
					}
				],
				1 << 24,
				true
			),
		/write runs and write data differ/
	);
});

// the lane, end to end
function wasm(text: string): Uint8Array {
	const module = binaryen.parseText(text);
	module.setFeatures(binaryen.Features.All);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}
const compile = (bytes: Uint8Array) => new WebAssembly.Module(Uint8Array.from(bytes));
function artifact(bytes: Uint8Array): ManagedArtifact {
	const plan = prepare(bytes, { minimumRegionWork: 0 }).control;
	assert.ok(plan);
	const { coordinator, transactional, workerOriginal, ...control } = plan;
	return {
		original: compile(bytes),
		coordinator: compile(coordinator),
		transactional: compile(transactional),
		inline: compile(inlineLane(workerOriginal)),
		control,
		memories: memoryImports(bytes)
	};
}
type Wrap = (lane: FolioLane) => ManagedLaneTransport;
const plain: Wrap = (lane) => ({
	execute: async (frame) => lane.execute(new Uint8Array(frame)),
	close: async () => lane.close()
});
function lanes(
	program: ManagedArtifact,
	mode: 'callout' | 'inline',
	count = 4,
	logEntries?: number,
	wrap: Wrap = plain
): ManagedLaneTransport[] {
	return Array.from({ length: count }, () =>
		wrap(
			new FolioLane(program.transactional!, {
				initial: program.control!.initial,
				maximum: program.control!.maximum,
				...(mode === 'inline' ? { inline: { module: program.inline!, logEntries } } : {})
			})
		)
	);
}
// a lane from a release that predates runs: it ignores the key and answers in addresses
const predating: Wrap = (lane) => ({
	execute: async (frame) => {
		const { header, payload } = decodeFrame<any>(new Uint8Array(frame), 1 << 30);
		delete header.runs;
		return lane.execute(encodeFrame(header, payload));
	},
	close: async () => lane.close()
});
// a lane that answers in a results version this owner does not know
const future: Wrap = (lane) => ({
	execute: async (frame) => {
		const { header, payload } = decodeFrame<any>(lane.execute(new Uint8Array(frame)), 1 << 30);
		return encodeFrame({ ...header, runs: 2 }, payload);
	},
	close: async () => lane.close()
});
function serial(program: ManagedArtifact, seed: (bytes: Uint8Array) => void) {
	const instance = new WebAssembly.Instance(program.original, {});
	const memory = instance.exports.memory as WebAssembly.Memory;
	seed(new Uint8Array(memory.buffer));
	const value = (instance.exports.main as CallableFunction)();
	return { value, memory: new Uint8Array(memory.buffer) };
}
// the same program through ManagedFolio with addresses and with runs, against the serial run
async function agree(
	text: string,
	seed: (bytes: Uint8Array) => void,
	options: {
		logEntries?: number;
		ranges?: boolean;
		wrap?: Wrap;
		modes?: ('callout' | 'inline')[];
	} = {}
) {
	const program = artifact(wasm(text));
	const expected = serial(program, seed);
	const reports: Record<string, any> = {};
	for (const mode of options.modes ?? (['callout', 'inline'] as const))
		for (const runs of [false, true]) {
			const pool = new ManagedFolio(program, {
				lanes: lanes(program, mode, 4, options.logEntries, options.wrap),
				...(options.ranges === false ? {} : { ranges: {} }),
				runs
			});
			try {
				seed(new Uint8Array(pool.memory.buffer));
				const report = await pool.run('main');
				const label = `${mode} ${runs ? 'runs' : 'addresses'}`;
				assert.deepEqual(report.values, [expected.value], label);
				assert.equal(
					Buffer.compare(new Uint8Array(pool.memory.buffer), expected.memory),
					0,
					label
				);
				reports[`${mode}:${runs}`] = report;
			} finally {
				await pool.close();
			}
		}
	return reports;
}
const put8 = '(func $put8 (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))';
const sum = `(func $sum (param $p i32) (param $n i32) (param $out i32)
	(local $i i32) (local $s i32)
	(block $done (loop $each
		(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
		(local.set $s (i32.add (local.get $s) (i32.load8_u (i32.add (local.get $p) (local.get $i)))))
		(local.set $i (i32.add (local.get $i) (i32.const 1)))
		(br $each)))
	(i32.store (local.get $out) (local.get $s)))`;
const noise = (bytes: Uint8Array) => {
	let state = 7;
	for (let i = 0; i < bytes.length; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		bytes[i] = (state >>> 16) | 1;
	}
};

test('disjoint regions in runs give the serial result with no replay and answers in runs', async () => {
	const calls = [0, 1, 2, 3, 4, 5, 6, 7]
		.map(
			(k) =>
				`(call $sum (i32.const ${65536 + k * 4096}) (i32.const 4000) (i32.const ${k * 64}))`
		)
		.join(' ');
	const text = `(module (memory (export "memory") 2 2 shared) ${sum}
		(func (export "main") (result i32) ${calls} (i32.load (i32.const 64))))`;
	for (const ranges of [true, false]) {
		const reports = await agree(text, noise, { ranges });
		for (const mode of ['callout', 'inline']) {
			const run = reports[`${mode}:true`];
			assert.equal(run.replayed, 0, mode);
			assert.equal(run.fallbacks, 0, mode);
			assert.equal(run.runReplies.addresses, 0, mode);
			assert.ok(run.runReplies.runs > 0, mode);
			assert.equal(run.regions, reports[`${mode}:false`].regions);
			assert.ok(
				run.transportBytes.received < reports[`${mode}:false`].transportBytes.received
			);
		}
	}
});

test('a true conflict in runs is detected and replayed to the serial result', async () => {
	const text = `(module (memory (export "memory") 1 1 shared)
		(func $bump (param i32) (i32.store (local.get 0) (i32.add (i32.load (local.get 0)) (i32.const 1))))
		(func (export "main") (result i32)
			(call $bump (i32.const 0)) (call $bump (i32.const 0)) (call $bump (i32.const 0))
			(call $bump (i32.const 128))
			(i32.load (i32.const 0))))`;
	for (const ranges of [true, false]) {
		const reports = await agree(text, (bytes) => bytes.fill(3), { ranges });
		for (const mode of ['callout', 'inline'])
			assert.ok(reports[`${mode}:true`].replayed >= 2, `${mode} ${ranges}`);
	}
});

test('false sharing inside one lane granule gives the serial result, with a replay only where a granule forces it', async () => {
	// bytes 0 and 1 share a write granule and a read granule; 31 and 32 straddle the write granule edge
	const text = `(module (memory (export "memory") 1 1 shared) ${put8}
		(func (export "main") (result i32)
			(call $put8 (i32.const 0) (i32.const 0))
			(call $put8 (i32.const 1) (i32.const 0))
			(call $put8 (i32.const 31) (i32.const 9))
			(call $put8 (i32.const 32) (i32.const 0))
			(call $put8 (i32.const 63) (i32.const 2))
			(call $put8 (i32.const 64) (i32.const 2))
			(i32.load (i32.const 0))))`;
	for (const ranges of [true, false]) await agree(text, noise, { ranges });
});

test('a write of zero into unshipped nonzero bytes is not lost in runs', async () => {
	const text = `(module (memory (export "memory") 2 2 shared) ${put8}
		(func (export "main") (result i32)
			(call $put8 (i32.const 70000) (i32.const 0))
			(call $put8 (i32.const 80000) (i32.const 0))
			(i32.load8_u (i32.const 70000))))`;
	await agree(text, noise);
});

test('a log-exhausting region falls back and the result stays serial in runs', async () => {
	const stores = Array.from(
		{ length: 16 },
		(_, k) => `(i32.store8 (i32.add (local.get 0) (i32.const ${k * 32})) (i32.const ${k + 1}))`
	).join(' ');
	const text = `(module (memory (export "memory") 1 1 shared)
		(func $spread (param i32) ${stores})
		(func (export "main") (result i32)
			(call $spread (i32.const 0)) (call $spread (i32.const 4096)) (call $spread (i32.const 8192))
			(i32.add (i32.load8_u (i32.const 31)) (i32.load8_u (i32.const 4127)))))`;
	const reports = await agree(text, noise, { logEntries: 4, modes: ['inline'] });
	assert.ok(reports['inline:true'].fallbacks >= 1, JSON.stringify(reports['inline:true']));
	await agree(text, noise, { logEntries: 64, modes: ['inline'] });
});

test('a lane that predates runs answers in addresses and the owner still gets the serial result', async () => {
	const text = `(module (memory (export "memory") 2 2 shared) ${sum}
		(func (export "main") (result i32)
			(call $sum (i32.const 65536) (i32.const 3000) (i32.const 0))
			(call $sum (i32.const 69632) (i32.const 3000) (i32.const 64))
			(call $sum (i32.const 73728) (i32.const 3000) (i32.const 128))
			(call $sum (i32.const 77824) (i32.const 3000) (i32.const 192))
			(i32.load (i32.const 64))))`;
	const reports = await agree(text, noise, { wrap: predating });
	for (const mode of ['callout', 'inline']) {
		const run = reports[`${mode}:true`];
		assert.equal(run.runReplies.runs, 0, mode);
		assert.ok(run.runReplies.addresses > 0, mode);
		assert.equal(run.transportFallbacks, 0, mode);
	}
	assert.equal(reports['inline:false'].runReplies, undefined);
});

test('a lane that answers in an unknown results version is refused and the owner runs natively', async () => {
	const text = `(module (memory (export "memory") 2 2 shared) ${sum}
		(func (export "main") (result i32)
			(call $sum (i32.const 65536) (i32.const 3000) (i32.const 0))
			(call $sum (i32.const 69632) (i32.const 3000) (i32.const 64))
			(i32.load (i32.const 64))))`;
	const program = artifact(wasm(text));
	const expected = serial(program, noise);
	const pool = new ManagedFolio(program, {
		lanes: lanes(program, 'inline', 2, undefined, future),
		runs: true
	});
	try {
		noise(new Uint8Array(pool.memory.buffer));
		const report = await pool.run('main');
		assert.deepEqual(report.values, [expected.value]);
		assert.equal(Buffer.compare(new Uint8Array(pool.memory.buffer), expected.memory), 0);
		assert.ok(report.transportFallbacks >= 1);
		assert.ok(pool.diagnostics.some((text) => /unsupported results encoding/.test(text)));
	} finally {
		await pool.close();
	}
});

test('a lane refuses a request for a results version it does not know', () => {
	const program = artifact(
		wasm(`(module (memory (export "memory") 1 1 shared)
			(func $bump (param i32) (i32.store (local.get 0) (i32.const 1)))
			(func (export "main") (call $bump (i32.const 0)) (call $bump (i32.const 64))))`)
	);
	const lane = new FolioLane(program.transactional!, {
		initial: program.control!.initial,
		maximum: program.control!.maximum
	});
	const header = {
		...identity,
		calls: [{ export: 'x', args: [0] }],
		fuel: 1000,
		maxBytes: 4096,
		runs: 2
	};
	assert.throws(
		() => lane.execute(encodeFrame(header, new Uint8Array(65536))),
		/unsupported results encoding/
	);
	assert.throws(
		() => new ManagedFolio(program, { lanes: [plain(lane)], runs: 1 as any }),
		/invalid runs option/
	);
});

// direct lane frames, addresses against runs
const probe = `(module (import "env" "memory" (memory 2 2 shared))
	(func (export "peek") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func (export "poke") (param i32 i32) (i32.store8 (local.get 0) (local.get 1)))
	(func (export "copy") (param i32 i32 i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)))
	(func (export "fill") (param i32 i32 i32) (memory.fill (local.get 0) (local.get 1) (local.get 2)))
	(func (export "wide") (param i32) (result i64) (i64.load (local.get 0)))
	(func (export "divide") (param i32) (result i32)
		(i32.div_u (i32.const 9) (i32.load8_u (local.get 0))))
	(func (export "outside") (param i32) (result i32) (i32.load (local.get 0))))`;

function exchange(
	lane: FolioLane,
	memory: Uint8Array,
	shipped: RangeSet | undefined,
	calls: { export: string; args: number[] }[],
	runs: boolean,
	maxBytes = 262144
) {
	const header = { ...identity, calls, fuel: 1000000, maxBytes, ...(runs ? { runs: 1 } : {}) };
	const frame = shipped
		? encodeRangesFrame(header, memory, shipped).frame
		: encodeFrame(header, memory);
	return decodeResults(lane.execute(frame), identity, {
		maximumFrameBytes: 1 << 26,
		memoryBytes: memory.length,
		maxBytes,
		calls: calls.length,
		runs
	});
}
const writesOf = (result: TransactionResult): Map<number, number> => {
	const out = new Map<number, number>();
	if (!result.writeRuns) {
		for (const [address, value] of result.writes) out.set(address, value);
		return out;
	}
	let at = 0;
	for (const [start, length] of pairs(result.writeRuns))
		for (let k = 0; k < length; k++) out.set(start + k, result.writeData![at++]!);
	return out;
};
const readsOf = (result: TransactionResult): number[] =>
	(result.readRuns ? expand(result.readRuns) : [...result.reads]).sort((a, b) => a - b);

test('lane runs expand to exactly the addresses and writes of the address reply, on both lanes', () => {
	const bytes = wasm(probe);
	const callout = new FolioLane(compile(prepare(bytes).transactional!), {
		initial: 2,
		maximum: 2
	});
	const inline = new FolioLane(compile(inlineLane(bytes)), {
		initial: 2,
		maximum: 2,
		inline: { module: compile(inlineLane(bytes)) }
	});
	const memory = new Uint8Array(131072);
	noise(memory);
	const calls = [
		{ export: 'peek', args: [100] },
		{ export: 'poke', args: [200, 0] },
		{ export: 'poke', args: [201, memory[201]!] },
		{ export: 'copy', args: [4096, 70, 150] },
		{ export: 'fill', args: [9000, 5, 100] },
		{ export: 'fill', args: [9010, 6, 300] },
		{ export: 'wide', args: [63] },
		{ export: 'divide', args: [5] },
		{ export: 'outside', args: [131072 - 2] }
	];
	for (const lane of [callout, inline])
		for (const shipped of [undefined, RangeSet.of([[0, 65536]]), RangeSet.of([[0, 4128]])]) {
			const a = exchange(lane, memory, shipped, calls, false);
			const b = exchange(lane, memory, shipped, calls, true);
			a.forEach((left, index) => {
				const right = b[index]!;
				const label = `${calls[index]!.export} ${lane === inline ? 'inline' : 'callout'} ${shipped?.count}`;
				assert.deepEqual(readsOf(right), readsOf(left), `${label} reads`);
				assert.deepEqual(writesOf(right), writesOf(left), `${label} writes`);
				assert.equal(right.value, left.value, label);
				assert.equal(right.trap, left.trap, label);
				assert.equal(Boolean(right.exhausted), Boolean(left.exhausted), label);
				assert.deepEqual(right.escapes, left.escapes, `${label} escapes`);
				assert.ok(right.readRuns && right.writeRuns && right.writeData, label);
				assert.equal(left.readRuns, undefined, label);
			});
		}
});

test('lane runs obey the byte budget like the address reply', () => {
	const bytes = wasm(probe);
	const inline = new FolioLane(compile(inlineLane(bytes)), {
		initial: 2,
		maximum: 2,
		inline: { module: compile(inlineLane(bytes)) }
	});
	const memory = new Uint8Array(131072).fill(2);
	const calls = [
		{ export: 'copy', args: [4096, 0, 128] },
		{ export: 'peek', args: [10] }
	];
	const a = exchange(inline, memory, undefined, calls, false, 64);
	const b = exchange(inline, memory, undefined, calls, true, 64);
	assert.deepEqual(
		b.map((r) => Boolean(r.exhausted)),
		a.map((r) => Boolean(r.exhausted))
	);
	assert.equal(b[0]!.exhausted, true);
	assert.deepEqual(b[0]!.readRuns && [...b[0]!.readRuns], []);
});

// the coordinator with hand-built results: both encodings, mixed, in order
function owner(width = 2) {
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
	const bytes = new Uint8Array(memory.buffer);
	const natives: number[] = [];
	const dispatched: number[][] = [];
	return {
		bytes,
		natives,
		dispatched,
		make: (answers: (call: { args: readonly (number | bigint)[] }) => TransactionResult) =>
			new Coordinator({
				memory,
				workerMemory: memory,
				width,
				profile: false,
				dispatch: async (_lane, calls) => {
					dispatched.push(calls.map((call) => Number(call.args[0])));
					return calls.map(answers);
				},
				native: (call) => natives.push(Number(call.args[0]))
			})
	};
}
const runResult = (reads: number[], writes: [number, number[]][]): TransactionResult => ({
	reads: [],
	writes: [],
	readRuns: Uint32Array.from(reads),
	...packRuns(writes)
});
function packRuns(writes: [number, number[]][]) {
	const packed = packWrites(
		writes.map(([start, data]) => [start, Uint8Array.from(data)] as const)
	);
	return { writeRuns: packed.runs, writeData: packed.data };
}

test('the coordinator commits write runs in order and replays a read run that overlaps one', async () => {
	const h = owner();
	const scheduler = h.make((call) => {
		const at = Number(call.args[0]);
		// call 0 writes bytes 100..103; call 1 reads 102..105 and writes 200; call 2 reads 300 only
		if (at === 0) return runResult([0, 4], [[100, [1, 2, 3, 4]]]);
		if (at === 1) return runResult([102, 4], [[200, [9]]]);
		if (at === 2) return runResult([104, 1, 300, 1], [[201, [7]]]);
		return { reads: [], writes: [] };
	});
	for (const at of [0, 1, 2]) scheduler.enqueue({ export: 'r', args: [at] });
	await scheduler.flush();
	assert.equal(scheduler.report.replayed, 1, 'only the call that read written bytes');
	assert.deepEqual([...h.bytes.subarray(100, 104)], [1, 2, 3, 4]);
	assert.equal(h.bytes[201], 7);
});

test('the coordinator treats a run that touches a write at its edge as no conflict, one byte inside as a conflict', async () => {
	for (const [read, replays] of [
		[[104, 8], 0],
		[[96, 4], 0],
		[[96, 5], 1],
		[[103, 1], 1]
	] as [number[], number][]) {
		const h = owner();
		const scheduler = h.make((call) =>
			Number(call.args[0]) === 0
				? runResult([0, 1], [[100, [1, 2, 3, 4]]])
				: runResult(read, [[400, [5]]])
		);
		for (const at of [0, 1]) scheduler.enqueue({ export: 'r', args: [at] });
		await scheduler.flush();
		assert.equal(scheduler.report.replayed, replays, JSON.stringify(read));
	}
});

test('the coordinator stays exact when address results and run results mix in one batch', async () => {
	for (const first of ['runs', 'addresses']) {
		const h = owner();
		const scheduler = h.make((call) => {
			const at = Number(call.args[0]);
			if (at === 0)
				return first === 'runs'
					? runResult([0, 1], [[50, [8]]])
					: { reads: [0], writes: [[50, 8]] };
			return first === 'runs'
				? { reads: [50], writes: [[60, 1]] }
				: runResult([48, 4], [[60, [1]]]);
		});
		for (const at of [0, 1]) scheduler.enqueue({ export: 'r', args: [at] });
		await scheduler.flush();
		assert.equal(scheduler.report.replayed, 1, first);
		assert.equal(h.bytes[50], 8);
		assert.equal(h.bytes[60], 1);
	}
});

test('an exhausted run result makes the owner run the rest natively', async () => {
	const h = owner();
	const scheduler = h.make((call) =>
		Number(call.args[0]) === 1
			? { reads: [], writes: [], exhausted: true, readRuns: new Uint32Array() }
			: runResult([0, 1], [[10 + Number(call.args[0]), [3]]])
	);
	for (const at of [0, 1, 2]) scheduler.enqueue({ export: 'r', args: [at] });
	await scheduler.flush();
	assert.deepEqual(h.natives, [1, 2]);
	assert.equal(h.bytes[10], 3);
});
