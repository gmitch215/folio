import { expect, test } from 'vitest';
import {
	CAT,
	CLASS_NAMES,
	record,
	summarizeWorksp,
	toGranules,
	WorkSpan,
	type WNode
} from '../../scripts/analyze/worksp.ts';
import { Recorder } from '../../scripts/probe/worksp-recorder.ts';

const W = 100000;
const layout = { stack: [0, 800] as [number, number], static: [800, 1600] as [number, number] };
const HEAP = 500;
const STATIC = 120;
const rel = (a: number, b: number) => a === b || a === 0 || b === 0;

/** root chunks R0..R8 spawn eight tasks; a join follows. Returns the analyzer. */
function eight(tasks: Partial<WNode>[], options: { hostAfter?: number } = {}) {
	const ws = new WorkSpan(layout, rel);
	let prev = -1;
	const joins: number[] = [];
	for (let k = 0; k < 8; k++) {
		const r = ws.add({
			weight: 0,
			preds: prev >= 0 ? [prev] : [],
			inv: 0,
			reads: [],
			writes: []
		});
		const t = ws.add({ weight: W, preds: [r], inv: k + 1, reads: [], writes: [], ...tasks[k] });
		prev = r;
		if (options.hostAfter) {
			const h = ws.add({
				weight: options.hostAfter,
				preds: [t],
				inv: k + 1,
				reads: [],
				writes: [],
				host: 1
			});
			joins.push(h);
		} else joins.push(t);
	}
	ws.add({ weight: 0, preds: [prev, ...joins], inv: 0, reads: [], writes: [], join: true });
	return ws;
}

const par = (ws: WorkSpan, options = {}) =>
	ws.ladder(options).map((m: any) => (m.parallelism === null ? null : +m.parallelism.toFixed(3)));
const own = (k: number, base = HEAP) => ({ writes: [base + 10 * k, base + 10 * k + 7, CAT.plain] });

// independent oracle: longest weighted path over an explicit edge list
function oracle(weights: number[], edges: [number, number][]) {
	const finish = weights.map(() => 0);
	for (let i = 0; i < weights.length; i++) {
		const start = Math.max(0, ...edges.filter(([, b]) => b === i).map(([a]) => finish[a]!));
		finish[i] = start + weights[i]!;
	}
	return Math.max(...finish);
}

test('oracle matches the definitions on a hand-built chain and fork', () => {
	expect(
		oracle(
			[5, 7, 3],
			[
				[0, 1],
				[1, 2]
			]
		)
	).toBe(15);
	expect(
		oracle(
			[5, 7, 3],
			[
				[0, 1],
				[0, 2]
			]
		)
	).toBe(12);
});

test('A: eight tasks on private buffers run 8.0 at every rung', () => {
	const ws = eight(Array.from({ length: 8 }, (_, k) => own(k)));
	expect(par(ws)).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
	expect(ws.evaluate({ name: 'x', removed: [] }).span).toBe(oracle(Array(8).fill(W), []));
});

test('B: a shared counter serializes until the tags are verified, and the class is named', () => {
	const rmw = (cat: number) =>
		Array.from({ length: 8 }, (_, k) => ({
			reads: [HEAP, HEAP, cat],
			writes: [HEAP, HEAP, cat],
			...(k >= 0 ? {} : {})
		}));
	const plain = eight(rmw(CAT.plain));
	expect(par(plain)).toEqual([8, 1, 1, 1, 1, 1, 1, 1]);
	const chain: [number, number][] = [];
	for (let k = 0; k < 7; k++) chain.push([k, k + 1]);
	expect(plain.evaluate({ name: 'x', removed: [] }).span).toBe(oracle(Array(8).fill(W), chain));
	const m1 = plain.ladder()[1]!;
	expect(m1.binding_class).toEqual(['heap']);
	expect(plain.ladder()[7]!.replays).toBe(7);
	const tagged = eight(rmw(CAT.rc));
	expect(par(tagged)).toEqual([8, 1, 1, 1, 8, 8, 8, 8]);
	expect(tagged.ladder()[1]!.binding_class).toEqual(['refcount']);
	expect(tagged.ladder()[7]!.replays).toBe(0);
	const data = eight(
		Array.from({ length: 8 }, () => ({
			reads: [STATIC, STATIC, CAT.plain],
			writes: [STATIC, STATIC, CAT.plain]
		}))
	);
	expect(data.ladder()[1]!.binding_class).toEqual(['static']);
});

test('B: a later plain read of a tagged counter waits for every tagged writer', () => {
	const ws = eight(
		Array.from({ length: 8 }, (_, k) => ({
			weight: W + k,
			reads: [HEAP, HEAP, CAT.rc],
			writes: [HEAP, HEAP, CAT.rc]
		}))
	);
	ws.add({ weight: 10, preds: [], inv: 0, reads: [HEAP, HEAP, CAT.plain], writes: [] });
	const m4 = ws.ladder()[4]!;
	expect(m4.span).toBe(W + 7 + 10);
	expect(ws.virtual).toBeGreaterThan(0);
});

test('C: the stack pointer chain needs rename_sp, and stack data flow between tasks invalidates it', () => {
	const slices = Array.from({ length: 8 }, (_, k) => ({
		sp: 3,
		reads: [10 + k, 10 + k, CAT.plain],
		writes: [10 + k, 10 + k, CAT.plain]
	}));
	const ok = eight(slices);
	expect(par(ok)).toEqual([8, 1, 8, 8, 8, 8, 8, 8]);
	expect(ok.ladder()[1]!.binding_class).toEqual(['interp']);
	expect(ok.checks.stackRawCross).toBe(0);
	const flow = eight(
		slices.map((s, k) =>
			k === 1 ? { ...s, reads: [10, 10, CAT.plain, 11, 11, CAT.plain] } : s
		)
	);
	const rows = flow.ladder();
	expect(rows[1]!.valid).toBe(true);
	expect(rows[2]!.valid).toBe(false);
	expect(rows[2]!.parallelism).toBeNull();
	expect(rows[2]!.invalid_reasons[0]).toMatch(/rename_sp/);
	expect(rows[7]!.valid).toBe(false);
});

test('D: a memory chain is 1.0 from M1 and replays seven times; a nested chain is 1.0 at M0', () => {
	const chain = eight(
		Array.from({ length: 8 }, (_, k) => ({
			reads: k === 0 ? [] : [HEAP + k - 1, HEAP + k - 1, CAT.plain],
			writes: [HEAP + k, HEAP + k, CAT.plain]
		}))
	);
	expect(par(chain)).toEqual([8, 1, 1, 1, 1, 1, 1, 1]);
	const rows = chain.ladder({ rollback: 0 });
	expect(rows[7]!.replays).toBe(7);
	expect(chain.ladder({ rollback: 50 })[7]!.span).toBe(8 * W + 7 * 50);
	const ws = new WorkSpan(layout, rel);
	let prev = -1;
	for (let k = 0; k < 8; k++)
		prev = ws.add({
			weight: W,
			preds: prev >= 0 ? [prev] : [],
			inv: k + 1,
			reads: [],
			writes: []
		});
	expect(par(ws)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
	expect(ws.ladder()[0]!.binding_class).toEqual(['spawn']);
});

test('E: shared output serializes until output_ordered, and the concat term follows the formula', () => {
	const out = Array.from({ length: 8 }, () => ({
		reads: [HEAP, HEAP, CAT.out],
		writes: [HEAP, HEAP, CAT.out]
	}));
	expect(par(eight(out))).toEqual([8, 1, 1, 1, 1, 8, 8, 8]);
	expect(eight(out).ladder()[1]!.binding_class).toEqual(['output']);
	const rows = eight(out).ladder({ merge: { output: 1000 } });
	expect(rows[5]!.span).toBe(W + 8000);
	expect(+rows[5]!.parallelism.toFixed(2)).toBe(7.41);
	const bad = eight(
		out.map((o, k) => (k === 3 ? { ...o, writes: [HEAP, HEAP, CAT.outOther] } : o))
	);
	const bl = bad.ladder();
	expect(bl[4]!.valid).toBe(true);
	expect(bl[5]!.valid).toBe(false);
	expect(bl[5]!.invalid_reasons[0]).toMatch(/output_ordered/);
});

test('F: serialized host calls cost 8H until host_buffered', () => {
	const H = 10000;
	const ws = eight(
		Array.from({ length: 8 }, () => ({})),
		{ hostAfter: H }
	);
	const rows = ws.ladder();
	expect(rows[0]!.span).toBe(W + H);
	expect(rows[1]!.span).toBe(W + 8 * H);
	expect(+rows[1]!.parallelism.toFixed(2)).toBe(4.89);
	expect(rows[1]!.binding_class).toEqual(['host']);
	expect(rows[6]!.span).toBe(W + H);
	expect(rows[6]!.parallelism).toBe(8);
	expect(ws.ladder({ merge: { host: 100 } })[6]!.span).toBe(W + H + 800);
	expect(ws.ladder({ hostReplay: 'violated' })[6]!.valid).toBe(false);
});

test('G: shared reads add no edges', () => {
	const ws = eight(
		Array.from({ length: 8 }, (_, k) => ({
			reads: [HEAP, HEAP + 9, CAT.plain],
			...own(k, 900)
		}))
	);
	expect(par(ws)).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
});

test('allocator extents are their own class and rename_alloc removes them', () => {
	const ws = eight(
		Array.from({ length: 8 }, () => ({
			reads: [HEAP, HEAP, CAT.alloc],
			writes: [HEAP, HEAP, CAT.alloc]
		}))
	);
	expect(par(ws)).toEqual([8, 1, 1, 8, 8, 8, 8, 8]);
	expect(ws.ladder()[1]!.binding_class).toEqual(['allocator']);
	expect(ws.ladder()[3]!.preconditions.rename_alloc).toBe('unchecked');
	const frees = new WorkSpan(layout, rel);
	frees.add({ weight: 1, preds: [], inv: 1, reads: [], writes: [], allocs: [4096, 16] });
	frees.add({ weight: 1, preds: [], inv: 2, reads: [], writes: [], frees: [4096] });
	expect(frees.checks.crossFrees).toBe(1);
	expect(frees.ladder({ allocTracking: true })[3]!.valid).toBe(false);
});

test('the sensitivity table separates one class removed from all but one', () => {
	const ws = eight(
		Array.from({ length: 8 }, () => ({
			sp: 3,
			reads: [HEAP, HEAP, CAT.plain],
			writes: [HEAP, HEAP, CAT.plain]
		}))
	);
	const s = ws.sensitivity();
	expect(s.interp!.only_removed).toBe(1);
	expect(s.heap!.only_removed).toBe(1);
	expect(s.heap!.all_but).toBe(1);
	expect(s.interp!.all_but).toBe(1);
	const sp = eight(Array.from({ length: 8 }, (_, k) => ({ sp: 3, ...own(k) })));
	const t = sp.sensitivity();
	expect(t.interp!.only_removed).toBe(8);
	expect(t.interp!.all_but).toBe(1);
	expect(t.heap!.all_but).toBe(8);
});

test('toGranules merges per category and orders by category', () => {
	expect(
		toGranules([
			{ lo: 0, hi: 8, cat: 0 },
			{ lo: 8, hi: 24, cat: 0 },
			{ lo: 100, hi: 108, cat: 2 },
			{ lo: 64, hi: 72, cat: 0 }
		])
	).toEqual([0, 2, 0, 8, 8, 0, 12, 13, 2]);
});

test('H: the recorder recovers eight tasks from frame changes at the dispatch site', () => {
	const rec = new Recorder({ layout });
	let ic = 0;
	rec.start(0);
	rec.dispatch(1000, ic);
	for (let k = 0; k < 8; k++) {
		rec.dispatch(2000, (ic += 10));
		rec.access((HEAP + 100 * k) * 8, 64, true);
		rec.dispatch(1000, (ic += W));
	}
	const ws = rec.finish((ic += 10));
	const rows = ws.ladder();
	expect(rec.stats.invocations).toBe(9);
	expect(rec.stats.popped).toBe(9);
	expect(rows.map((m: any) => +m.parallelism.toFixed(3))).toEqual(
		rows.map((m: any) => +(m.work / m.span).toFixed(3))
	);
	expect(rows[0]!.parallelism).toBeGreaterThan(7.9);
	expect(rows[7]!.parallelism).toBeGreaterThan(7.9);
	const dispatchesByTask = new Recorder({ layout });
	dispatchesByTask.start(0);
	for (let k = 0; k < 3; k++) {
		dispatchesByTask.dispatch(1000 + 100 * k, k * 5);
		dispatchesByTask.dispatch(1000, k * 5 + 1);
	}
	expect(dispatchesByTask.stats.invocations).toBe(3);
});

test('the recorder charges allocator and output extents to their classes and counts nested dispatches', () => {
	const rec = new Recorder({ layout });
	rec.start(0);
	rec.dispatch(1000, 5);
	rec.enter('alloc');
	rec.access(4000, 8, true);
	rec.exit('alloc');
	rec.enter('out');
	rec.access(8000, 8, true);
	rec.dispatch(1000, 9);
	rec.exit('out');
	rec.access(8000, 8, true, CAT.rc);
	rec.host();
	const ws = rec.finish(20);
	expect(rec.stats.outputExtents).toBe(1);
	expect(ws.checks.outOtherWrites).toBe(1);
	expect(ws.events.host).toBe(1);
	expect(ws.nodeCount).toBeGreaterThan(1);
});

test('the record carries the schema, the ladder and the sensitivity table', () => {
	const ws = eight(Array.from({ length: 8 }, (_, k) => own(k)));
	const r = record(ws, {
		module: { name: 'm', sha256: 'x' },
		input: { id: 'case' },
		machine: { name: 'test', node: 'n' },
		granularity: 'synthetic',
		events: {},
		assumptions: [],
		unmeasured: []
	});
	expect(r.schema).toBe('folio.worksp.v2');
	expect(r.models).toHaveLength(9);
	expect(r.models[8]!.extension).toBe(true);
	expect(CLASS_NAMES).toHaveLength(9);
	const summary = summarizeWorksp(
		[
			{
				kind: 'sample',
				name: 'case',
				repeat: 0,
				mode: 'trace',
				outputEqual: true,
				nativeMs: 1,
				instrumentedWallMs: 2,
				slowdown: 2,
				counters: {},
				counts: { invocations: 9 },
				record: r
			}
		],
		'h'
	);
	expect((summary.inputs['case#0'] as any).ladder[0].parallelism).toBe(8);
	expect((summary.inputs['case#0'] as any).invocations).toBe(9);
});

const hostFold = (h: any) => h.imports;

async function roundTrip(wat: string, mode: 'count' | 'trace', dispatch = 'none', alloc = '4') {
	const { default: binaryen } = await import('binaryen');
	const { instrumentWorksp } = await import('../../scripts/probe/worksp-instrument.ts');
	const { createHooks } = await import('../../scripts/probe/worksp-hooks.ts');
	const m = binaryen.parseText(wat);
	const bytes = new Uint8Array(m.emitBinary());
	m.dispose();
	const result = instrumentWorksp(bytes, { mode, dispatch, alloc: [alloc], out: [] });
	const hooks = createHooks({
		mode,
		sites: mode === 'trace' ? result.sites : undefined,
		layout,
		meta: { module: { name: 'wat', sha256: 'x' }, machine: { name: 't', node: 'n' } }
	});
	const instance = new WebAssembly.Instance(new WebAssembly.Module(result.bytes), {
		folio: hostFold(hooks)
	});
	hooks.attach(instance, (instance.exports as any).m);
	return { instance, hooks, result };
}

const LOOP = `(module
 (memory (export "m") 1)
 (func $f (export "f") (param $n i32) (result i32)
  (local $i i32) (local $s i32)
  (block $out
   (loop $l
    (br_if $out (i32.ge_u (local.get $i) (local.get $n)))
    (local.set $s (i32.add (local.get $s) (i32.load (i32.shl (local.get $i) (i32.const 2)))))
    (i32.store (i32.shl (local.get $i) (i32.const 2)) (local.get $s))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l)))
  (local.get $s))
 (func $nest (export "nest") (result i32)
  (i32.load (i32.load (i32.const 0))))
 (func $one (param i32) (result i32) (local.get 0))
 (func $calls (export "calls") (result i32)
  (call $one (call $one (i32.const 1))))
 (func $alloc (export "alloc") (param $x i32) (result i32)
  (if (local.get $x) (then (return (i32.const 5))))
  (i32.const 7)))`;

test('count mode matches the hand count of executed nodes, loads and stores', async () => {
	const { instance, hooks } = await roundTrip(LOOP, 'count');
	const before = hooks.snapshot();
	(instance.exports as any).f(3);
	const after = hooks.snapshot();
	const d = (k: string) => after[k]! - before[k]!;
	expect(d('n')).toBe(21 * 3 + 7);
	expect(d('ld')).toBe(3);
	expect(d('st')).toBe(3);
	expect(d('ldb')).toBe(12);
	expect(d('stb')).toBe(12);
});

test('nested loads and calls are all tallied (regression: a nested node overwrote its children)', async () => {
	const { instance, hooks } = await roundTrip(LOOP, 'count');
	const before = hooks.snapshot();
	(instance.exports as any).nest();
	(instance.exports as any).calls();
	const after = hooks.snapshot();
	expect(after.ld! - before.ld!).toBe(2);
	expect(after.call! - before.call!).toBe(2);
});

test('trace mode reports every access address and balances extent hooks across a return', async () => {
	const { instance, hooks, result } = await roundTrip(LOOP, 'trace');
	expect(result.stats.unsupportedReturns).toBe(0);
	expect(result.stats.extentFunctions).toBe(1);
	hooks.begin();
	(instance.exports as any).f(3);
	expect((instance.exports as any).alloc(1)).toBe(5);
	expect((instance.exports as any).alloc(0)).toBe(7);
	const out = hooks.end({ id: 'loop' });
	expect(out.stats!.accesses).toBe(6);
	expect(out.counts.extentEnter[1]).toBe(2);
	expect(out.record!.events.interval_records).toBe(2);
});

const DISPATCH = (shared: boolean) => `(module
 (type $h (func (param i32)))
 (memory (export "m") 8)
 (table 2 funcref)
 (elem (i32.const 0) $work $nop)
 (func $nop (param $f i32))
 (func $work (param $f i32)
  (local $i i32)
  (loop $l
   (i32.store (i32.add (local.get $f) (i32.shl (local.get $i) (i32.const 2))) (local.get $i))
   ${shared ? '(i32.store (i32.const 1200) (i32.add (i32.load (i32.const 1200)) (i32.const 1)))' : ''}
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br_if $l (i32.lt_u (local.get $i) (i32.const 200)))))
 (func $run (export "run")
  (local $k i32)
  (loop $t
   (call_indirect (type $h) (i32.const 1000) (i32.const 1))
   (call_indirect (type $h) (i32.add (i32.const 100000) (i32.shl (local.get $k) (i32.const 12))) (i32.const 0))
   (local.set $k (i32.add (local.get $k) (i32.const 1)))
   (br_if $t (i32.lt_u (local.get $k) (i32.const 8))))
  (call_indirect (type $h) (i32.const 1000) (i32.const 1)))
)`;

test('H: tasks dispatched through call_indirect are recovered from frame changes in Wasm', async () => {
	for (const shared of [false, true]) {
		const { instance, hooks } = await roundTrip(DISPATCH(shared), 'trace', '2', 'none');
		hooks.begin();
		(instance.exports as any).run();
		const out = hooks.end({ id: 'dispatch' });
		expect(out.stats!.invocations).toBe(9);
		const models = out.record!.models;
		if (!shared) {
			for (const model of models) expect(model.parallelism).toBeGreaterThan(7.5);
		} else {
			expect(models[0]!.parallelism).toBeGreaterThan(7.5);
			expect(models[1]!.parallelism).toBeLessThan(1.5);
			expect(models[1]!.binding_class).toEqual(['static']);
			expect(models[7]!.replays).toBeGreaterThan(0);
		}
	}
});

// #region exposure, dead stack and the private-state rung
const TOP = 800;
const word = (g: number) => g * 8;

/** two sibling invocations under one root frame; each body runs between its dispatch and the next */
function siblings(bodies: ((rec: Recorder) => void)[], sp = 700) {
	const rec = new Recorder({ layout });
	rec.start(0, 0, 0, TOP);
	rec.dispatch(1000, 1, 0, 0, TOP);
	bodies.forEach((body, k) => {
		rec.dispatch(2000 + 16 * k, 10 + 100 * k, 0, 0, sp);
		body(rec);
		rec.dispatch(1000, 100 + 100 * k, 0, 0, TOP);
	});
	return { rec, ws: rec.finish(1000) };
}

test('a read after the same chunk wrote the bytes is not a dependence; a partial overlap still is', () => {
	const a = (rec: Recorder) => rec.access(word(HEAP), 8, true);
	const own = (rec: Recorder) => {
		rec.access(word(HEAP), 8, true);
		rec.access(word(HEAP), 8, false);
	};
	const exposed = (rec: Recorder) => rec.access(word(HEAP), 8, false);
	const half = (rec: Recorder) => {
		rec.access(word(HEAP), 4, true);
		rec.access(word(HEAP), 8, false);
	};
	expect(siblings([a, own]).ws.conflictCounts().raw).toBe(0);
	expect(siblings([a, exposed]).ws.conflictCounts().raw).toBe(1);
	expect(siblings([a, half]).ws.conflictCounts().raw).toBe(1);
	const { rec } = siblings([a, own]);
	expect(rec.stats.ownWriteReads).toBe(1);
});

test('an exposed read of stack below the chunk start is uninitialized; above it is data flow', () => {
	const below = word(75);
	const above = word(92);
	const write = (addr: number) => (rec: Recorder) => rec.access(addr, 8, true);
	const read = (addr: number) => (rec: Recorder) => rec.access(addr, 8, false);
	const dead = siblings([write(below), read(below)]);
	expect(dead.ws.checks.stackRawCross).toBe(0);
	expect(dead.rec.stats.deadStackReads).toBe(1);
	expect(dead.ws.ladder()[2]!.valid).toBe(true);
	const real = siblings([write(above), read(above)]);
	expect(real.ws.checks.stackRawCross).toBe(1);
	expect(real.rec.stats.deadStackReads).toBe(0);
	expect(real.ws.ladder()[2]!.valid).toBe(false);
	const off = new Recorder({ layout, deadStack: false });
	off.start(0, 0, 0, TOP);
	off.dispatch(1000, 1, 0, 0, TOP);
	off.dispatch(2000, 10, 0, 0, 700);
	off.access(below, 8, true);
	off.dispatch(1000, 50, 0, 0, TOP);
	off.dispatch(2016, 60, 0, 0, 700);
	off.access(below, 8, false);
	off.dispatch(1000, 90, 0, 0, TOP);
	expect(off.finish(100).checks.stackRawCross).toBe(1);
});

test('caller code that runs after an activation returns is charged to the caller, not the last callback', () => {
	const rec = new Recorder({ layout });
	rec.start(0, 0, 0, TOP);
	rec.dispatch(1000, 1, 0, 0, TOP);
	for (let k = 0; k < 2; k++) {
		rec.markEntry();
		rec.enterExec();
		rec.dispatch(2000, 10 + 100 * k, 0, 0, 700);
		if (k === 1) rec.access(word(95), 8, false);
		rec.exitExec(50 + 100 * k, 0, 0, 760);
		rec.access(word(95), 8, true);
	}
	const ws = rec.finish(500);
	expect(ws.checks.stackRawCross).toBe(0);
	expect(rec.stats.invocations).toBe(3);
	expect(ws.invParent[2]).toBe(1);
	expect(ws.invParent[3]).toBe(1);
});

type Kind = 'independent' | 'dependent' | 'shared';

/** a main frame whose opcodes are separate nodes calls f eight times; every node is built from accesses */
function loop(kind: Kind) {
	const rec = new Recorder({
		layout,
		nameOf: (frame) => (frame === 1000 ? 'main' : 'f'),
		fine: (label) => label === 'main'
	});
	let ic = 0;
	const tick = (n: number) => (ic += n);
	const STATIC_WORD = word(120);
	const X = word(HEAP + 400);
	rec.start(0, 0, 0, TOP);
	rec.dispatch(1000, tick(1), 0, 0, TOP);
	for (let k = 0; k < 8; k++) {
		if (kind === 'dependent' && k > 0) rec.access(X, 8, false);
		rec.access(word(HEAP + k), 8, true);
		rec.dispatch(1000, tick(5), 0, 0, TOP);
		rec.access(word(HEAP + k), 8, false);
		rec.dispatch(2000 + 16 * k, tick(5), 0, 0, 700);
		rec.access(word(HEAP + k), 8, false);
		rec.access(STATIC_WORD, 8, false);
		rec.access(STATIC_WORD, 8, true);
		if (kind === 'shared') {
			rec.access(word(HEAP + 500), 8, false);
			rec.access(word(HEAP + 500), 8, true);
		}
		rec.access(word(HEAP + 100 + 10 * k), 8, true);
		rec.access(word(HEAP + 200 + k), 8, true);
		rec.dispatch(1000, tick(W), 0, 0, TOP);
		rec.access(word(HEAP + 200 + k), 8, false);
		rec.access(kind === 'dependent' ? X : word(HEAP + 300 + k), 8, true);
		rec.dispatch(1000, tick(5), 0, 0, TOP);
	}
	return rec.finish(tick(10));
}

const privatize = (ws: WorkSpan, labels: string[]) =>
	+ws.privateRung('P', (label) => labels.includes(label)).parallelism!.toFixed(2);

test('private rung: independent calls from an opcode-grained caller reach 8, shared interpreter state is dropped', () => {
	const ws = loop('independent');
	expect(ws.ladder()[1]!.parallelism).toBeLessThan(1.1);
	const p = privatize(ws, ['f']);
	expect(p).toBeGreaterThan(7.2);
	expect(p).toBeLessThan(8.01);
	expect(privatize(ws, [])).toBeLessThan(1.1);
	const row = ws.privateRung('P', (label) => label === 'f');
	expect(row.privateInvocations).toBe(8);
	expect(row.binding_class).toContain('spawn');
});

test('private rung: a value carried from one call into the next stays a dependence', () => {
	const ws = loop('dependent');
	expect(privatize(ws, ['f'])).toBeLessThan(1.02);
	const row = ws.privateRung('P', (label) => label === 'f');
	expect(row.path_edge_classes.heap).toBeGreaterThanOrEqual(14);
	expect(row.path_edge_classes.static).toBeUndefined();
});

test('private rung: a site that shares a variable stays at 1.0 until it is left out of the private set', () => {
	const ws = loop('shared');
	expect(privatize(ws, [])).toBeLessThan(1.1);
	expect(privatize(ws, ['f'])).toBeGreaterThan(7.2);
});

test('the call tree reports inclusive work and the sibling pairs that both reach the threshold', () => {
	const ws = loop('independent');
	const tree = ws.callTree();
	expect(tree.total).toBeGreaterThan(8 * W);
	expect(tree.incl[1]).toBeGreaterThan(8 * W);
	const groups = ws.siblingGroups(0.05);
	expect(groups).toHaveLength(1);
	expect(groups[0]!.label).toBe('main');
	expect(groups[0]!.children).toBe(8);
	expect(groups[0]!.second).toBeGreaterThan(0.1);
	expect(groups[0]!.groups[0]).toMatchObject({ label: 'f', n: 8 });
	expect(ws.siblingGroups(0.5)).toHaveLength(0);
});

const tasks = (ws: WorkSpan, labels: string[]) =>
	ws.taskModel('T', (_v, label) => labels.includes(label));

test('task model: independent calls reach 8, no private set is serial by the owner bound', () => {
	const ws = loop('independent');
	const t = tasks(ws, ['f']);
	expect(t.tasks).toBe(8);
	expect(t.parallelism!).toBeGreaterThan(7.2);
	expect(t.parallelism!).toBeLessThan(8.01);
	expect(t.longest_task).toBeGreaterThanOrEqual(W);
	const none = tasks(ws, []);
	expect(none.parallelism).toBe(1);
	expect(none.binding).toBe('owner thread');
});

test('task model: a carried value and a shared variable follow the validated set', () => {
	expect(tasks(loop('dependent'), ['f']).parallelism!).toBeLessThan(1.02);
	expect(tasks(loop('shared'), []).parallelism).toBe(1);
	expect(tasks(loop('shared'), ['f']).parallelism!).toBeGreaterThan(7.2);
});

test('task model: owner work above the longest task bounds the time', () => {
	const ws = new WorkSpan(layout, rel);
	ws.registerInv(1, 0, 'owner work');
	ws.registerInv(2, 0, 'task');
	ws.registerInv(3, 0, 'task');
	const root = ws.add({ weight: 0, preds: [], inv: 0, reads: [], writes: [] });
	ws.add({ weight: 700, preds: [root], inv: 1, reads: [], writes: [] });
	ws.add({ weight: 100, preds: [root], inv: 2, reads: [], writes: [] });
	ws.add({ weight: 100, preds: [root], inv: 3, reads: [], writes: [] });
	const t = ws.taskModel('T', (_v, label) => label === 'task');
	expect(t.owner_work).toBe(700);
	expect(t.time).toBe(700);
	expect(t.parallelism).toBe(900 / 700);
	expect(t.binding).toBe('owner thread');
});

test('task model: edges through allocator, static and write-after-write state do not cross a task', () => {
	const ws = new WorkSpan(layout, rel);
	for (let k = 1; k <= 2; k++) ws.registerInv(k, 0, 'task');
	const root = ws.add({ weight: 0, preds: [], inv: 0, reads: [], writes: [] });
	const body = {
		weight: W,
		reads: [STATIC, STATIC, CAT.plain, HEAP, HEAP, CAT.alloc],
		writes: [STATIC, STATIC, CAT.plain, HEAP, HEAP, CAT.alloc]
	};
	ws.add({ ...body, preds: [root], inv: 1 });
	ws.add({ ...body, preds: [root], inv: 2 });
	expect(tasks(ws, ['task']).parallelism).toBeGreaterThan(1.99);
	expect(tasks(ws, []).parallelism).toBe(1);
});
// #endregion
