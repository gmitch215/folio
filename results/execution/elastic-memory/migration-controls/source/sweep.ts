import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
	counts,
	defaultCosts,
	fixtureTrace,
	simulate,
	type Config
} from '../../research/elastic-model.ts';
import {
	backingWord,
	lruVictim,
	replayChecksum,
	scanTrace,
	stackDistances,
	zipfTrace,
	type Access
} from './access.ts';

// usage: node scripts/probe/elastic/sweep.ts predict | run
// predict writes the model's counts before run touches the executor; run writes the measured rows.

const PAGE = 65536;
const PAGES = 3072;
const FRAMES = [4, 8, 16, 32, 64, 128, 256];
const POLICIES = ['round-robin', 'lru'] as const;
type Policy = (typeof POLICIES)[number];
const KIND = { load: 0, store: 1, fill: 2 } as const;
const TAGS = 16384;
const DIRTY = 20480;
const STAMPS = 24576;
const study = resolve(
	process.env.FOLIO_SWEEP_STUDY ?? 'results/execution/elastic-memory/migration-controls'
);
const sources = [
	new URL('sweep.ts', import.meta.url),
	new URL('access.ts', import.meta.url),
	new URL('../../research/elastic-model.ts', import.meta.url)
];

// tags at 16384, dirty flags at 20480, stamps at 24576, clock at 28672; frame k is page k + 1
const WAT = `(module
 (import "host" "op" (func $op (param i32) (result i32)))
 (import "host" "fault" (func $fault (param i32 i32) (result i32)))
 (memory (export "memory") 257 257)
 (func $find (param $p i32) (param $frames i32) (result i32)
  (local $s i32)
  (block $miss
   (loop $scan
    (br_if $miss (i32.ge_u (local.get $s) (local.get $frames)))
    (if (i32.eq (i32.load (i32.add (i32.const 16384) (i32.shl (local.get $s) (i32.const 2)))) (local.get $p))
     (then (return (local.get $s))))
    (local.set $s (i32.add (local.get $s) (i32.const 1)))
    (br $scan)))
  (i32.const -1))
 (func (export "run") (param $n i32) (param $frames i32) (result i32)
  (local $i i32) (local $op i32) (local $p i32) (local $kind i32) (local $slot i32) (local $clock i32) (local $sum i32)
  (block $end
   (loop $again
    (br_if $end (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $op (call $op (local.get $i)))
    (local.set $p (i32.shr_u (local.get $op) (i32.const 2)))
    (local.set $kind (i32.and (local.get $op) (i32.const 3)))
    (local.set $slot (call $find (local.get $p) (local.get $frames)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
     (then (local.set $slot (call $fault (local.get $p) (local.get $kind)))))
    (local.set $clock (i32.add (i32.load (i32.const 28672)) (i32.const 1)))
    (i32.store (i32.const 28672) (local.get $clock))
    (i32.store (i32.add (i32.const 24576) (i32.shl (local.get $slot) (i32.const 2))) (local.get $clock))
    (if (i32.eqz (local.get $kind))
     (then (local.set $sum (i32.xor (i32.mul (local.get $sum) (i32.const 31))
            (i32.load offset=128 (i32.mul (i32.add (local.get $slot) (i32.const 1)) (i32.const 65536))))))
     (else
      (i32.store offset=128 (i32.mul (i32.add (local.get $slot) (i32.const 1)) (i32.const 65536)) (local.get $i))
      (i32.store8 (i32.add (i32.const 20480) (local.get $slot)) (i32.const 1))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $again)))
  (local.get $sum)))`;

type Row = {
	trace: string;
	frames: number;
	policy: Policy;
	ops: number;
	hits: number;
	faults: number;
	fetches: number;
	zeroFills: number;
	writebacks: number;
	finalWritebacks: number;
	totalWritebacks: number;
	executorFrameBytes: number;
	value: number;
	expected: number;
	exact: boolean;
};

function traces(): Record<string, Access[]> {
	return {
		dense: fixtureTrace(PAGES),
		skewed: zipfTrace({ pages: PAGES, length: 20000, s: 1.1, readShare: 0.7, seed: 1105 }),
		scan: scanTrace(PAGES, 2)
	};
}

function modelConfig(frames: number): Config {
	return {
		name: `frames-${frames}`,
		topology: 'remote-owner',
		frames,
		writePolicy: 'write-back',
		opsPerRequest: 16,
		costs: { ...defaultCosts }
	};
}

function predict() {
	const named = Object.entries(traces()).map(([name, trace]) => {
		const distances = stackDistances(trace);
		const reused = distances.filter((d) => d >= 0);
		const rows = FRAMES.map((frames) => {
			const model = simulate(trace, modelConfig(frames));
			const hits = reused.filter((d) => d < frames).length;
			return {
				frames,
				gets: model.gets,
				puts: model.puts,
				hops: model.hops,
				totalMs: Math.round(model.ms.total),
				lruHits: hits,
				lruMisses: trace.length - hits
			};
		});
		return [
			name,
			{
				ops: trace.length,
				counts: counts(trace),
				coldAccesses: distances.length - reused.length,
				minReuseDistance: Math.min(...reused),
				maxReuseDistance: Math.max(...reused),
				rows
			}
		] as const;
	});
	const out = {
		schema: 'folio.sweep-predictions.v1',
		model: 'scripts/research/elastic-model.ts simulate, remote-owner, write-back, LRU frame cache',
		frames: FRAMES,
		traces: Object.fromEntries(named)
	};
	writeFileSync(join(study, 'sweep-predictions.json'), JSON.stringify(out, null, '\t') + '\n', {
		flag: 'wx'
	});
}

function backing() {
	const directory = mkdtempSync(join(tmpdir(), 'folio-sweep-'));
	const fd = openSync(join(directory, 'pages.bin'), 'wx+');
	const hash = createHash('sha256');
	const page = Buffer.alloc(PAGE);
	for (let p = 0; p < PAGES; p++) {
		page.writeInt32LE(backingWord(p), 128);
		hash.update(page);
		assert.equal(writeSync(fd, page, 0, PAGE, p * PAGE), PAGE);
	}
	return { fd, bytes: PAGES * PAGE, sha256: hash.digest('hex') };
}

function compile() {
	const m = binaryen.parseText(WAT);
	assert.ok(m.validate(), 'sweep module does not validate');
	const bytes = Uint8Array.from(m.emitBinary());
	m.dispose();
	return new WebAssembly.Module(bytes);
}

function runOne(
	name: string,
	trace: Access[],
	frames: number,
	policy: Policy,
	module: WebAssembly.Module,
	fd: number,
	expected: number
): Row {
	const overlay = new Map<number, Uint8Array>();
	const c = { faults: 0, fetches: 0, zeroFills: 0, writebacks: 0 };
	let rr = 0;
	const instance = new WebAssembly.Instance(module, {
		host: {
			op: (i: number) => trace[i]!.page * 4 + KIND[trace[i]!.kind],
			fault: (page: number, kind: number) => {
				c.faults++;
				const slot = policy === 'lru' ? lruVictim(stamps) : rr++ % frames;
				const frame = new Uint8Array(buffer, (slot + 1) * PAGE, PAGE);
				const old = tags[slot]!;
				if (old >= 0 && dirty[slot]) {
					overlay.set(old, Uint8Array.from(frame));
					c.writebacks++;
				}
				tags[slot] = page;
				dirty[slot] = 0;
				if (kind === KIND.fill) {
					frame.fill(0);
					c.zeroFills++;
				} else {
					c.fetches++;
					const saved = overlay.get(page);
					if (saved) frame.set(saved);
					else assert.equal(readSync(fd, frame, 0, PAGE, page * PAGE), PAGE);
				}
				return slot;
			}
		}
	});
	const exp = instance.exports as Record<string, unknown>;
	const buffer = (exp.memory as WebAssembly.Memory).buffer;
	const tags = new Int32Array(buffer, TAGS, frames).fill(-1);
	const dirty = new Uint8Array(buffer, DIRTY, frames);
	const stamps = new Int32Array(buffer, STAMPS, frames);
	const value = (exp.run as (n: number, frames: number) => number)(trace.length, frames);
	let finalWritebacks = 0;
	for (let slot = 0; slot < frames; slot++) {
		if (tags[slot]! >= 0 && dirty[slot]) finalWritebacks++;
	}
	return {
		trace: name,
		frames,
		policy,
		ops: trace.length,
		hits: trace.length - c.faults,
		faults: c.faults,
		fetches: c.fetches,
		zeroFills: c.zeroFills,
		writebacks: c.writebacks,
		finalWritebacks,
		totalWritebacks: c.writebacks + finalWritebacks,
		executorFrameBytes: (frames + 1) * PAGE,
		value,
		expected,
		exact: value === expected
	};
}

function run() {
	const predictions = JSON.parse(readFileSync(join(study, 'sweep-predictions.json'), 'utf8'));
	const module = compile();
	const store = backing();
	const rows: Row[] = [];
	const generated = traces();
	for (const [name, trace] of Object.entries(generated)) {
		const expected = replayChecksum(trace);
		for (const frames of FRAMES) {
			for (const policy of POLICIES) {
				rows.push(runOne(name, trace, frames, policy, module, store.fd, expected));
			}
		}
	}
	const find = (name: string, frames: number, policy: Policy) =>
		rows.find((r) => r.trace === name && r.frames === frames && r.policy === policy)!;
	const comparisons = Object.keys(generated).map((name) => ({
		trace: name,
		rows: FRAMES.map((frames) => {
			const model = predictions.traces[name].rows.find(
				(r: { frames: number }) => r.frames === frames
			);
			const lru = find(name, frames, 'lru');
			const rr = find(name, frames, 'round-robin');
			return {
				frames,
				modelGets: model.gets,
				modelPuts: model.puts,
				stackMisses: model.lruMisses,
				lruFetches: lru.fetches,
				lruWritebacks: lru.totalWritebacks,
				lruFaults: lru.faults,
				rrFetches: rr.fetches,
				rrWritebacks: rr.totalWritebacks,
				rrFaults: rr.faults,
				lruMatchesModel:
					lru.fetches === model.gets &&
					lru.totalWritebacks === model.puts &&
					lru.faults === model.lruMisses,
				rrEqualsLru:
					rr.fetches === lru.fetches &&
					rr.totalWritebacks === lru.totalWritebacks &&
					rr.faults === lru.faults
			};
		})
	}));
	const mismatches = comparisons.flatMap((c) =>
		c.rows.filter((r) => !r.lruMatchesModel).map((r) => ({ trace: c.trace, frames: r.frames }))
	);
	const raw = {
		schema: 'folio.sweep-raw.v1',
		backing: { bytes: store.bytes, sha256: store.sha256 },
		pageBytes: PAGE,
		pages: PAGES,
		frames: FRAMES,
		policies: POLICIES,
		allExact: rows.every((r) => r.exact),
		rows,
		sources: sources.map((path) => ({
			name: basename(path.pathname),
			sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
		})),
		node: process.version
	};
	const dense = rows.filter((r) => r.trace === 'dense' && r.policy === 'lru');
	const summary = {
		schema: 'folio.sweep-summary.v1',
		allExact: raw.allExact,
		rowCount: rows.length,
		lruMatchesModelEverywhere: mismatches.length === 0,
		mismatches,
		denseLruSpread: {
			fetchMin: Math.min(...dense.map((r) => r.fetches)),
			fetchMax: Math.max(...dense.map((r) => r.fetches)),
			writebackMin: Math.min(...dense.map((r) => r.totalWritebacks)),
			writebackMax: Math.max(...dense.map((r) => r.totalWritebacks))
		},
		comparisons
	};
	writeFileSync(join(study, 'sweep-raw.json'), JSON.stringify(raw, null, '\t') + '\n', {
		flag: 'wx'
	});
	writeFileSync(join(study, 'sweep-summary.json'), JSON.stringify(summary, null, '\t') + '\n', {
		flag: 'wx'
	});
}

if (process.argv[2] === 'predict') predict();
else if (process.argv[2] === 'run') run();
else throw new Error('usage: sweep.ts predict | run');
