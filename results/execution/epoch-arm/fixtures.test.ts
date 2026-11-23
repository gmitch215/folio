import binaryen from 'binaryen';
import { EPOCH_BOUND_BYTES, translate } from './elastic-translate.ts';
import {
	MEMORY_PAGES,
	PAGE,
	runNative,
	runTranslated,
	seedData,
	translateOptions
} from './fixture-lib.ts';
import type { PagerOptions } from './pager.ts';

// fixtures for the epoch-group translation: every case runs the untranslated module and the translated
// one on the same data and compares results (or traps) and the final contents of every page.

const WAT = `
(module
 (import "env" "memory" (memory ${MEMORY_PAGES}))
 (global $sp (mut i32) (i32.const 65536))
 (type $t1 (func (param i32) (result i32)))
 (table 2 funcref)
 (elem (i32.const 0) $touch)
 (func $touch (export "touch") (param $a i32) (result i32) (i32.load (local.get $a)))
 (func $walk (export "walk") (param $p i32) (param $n i32) (result i32)
  (local $acc i32)
  (loop $l
   (local.set $acc (i32.add (local.get $acc) (i32.add (i32.load offset=4 (local.get $p)) (i32.load offset=8 (local.get $p)))))
   (i32.store offset=4 (local.get $p) (i32.add (i32.load offset=4 (local.get $p)) (i32.const 1)))
   (local.set $p (i32.load (local.get $p)))
   (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
  (local.get $acc))
 (func $cross (export "cross") (param $b i32) (result i32)
  (local $x i32)
  (local.set $x (i32.add (i32.load (local.get $b)) (i32.load offset=120 (local.get $b))))
  (i32.store offset=64 (local.get $b) (i32.add (local.get $x) (i32.load offset=4 (local.get $b))))
  (i32.add (local.get $x) (i32.load offset=64 (local.get $b))))
 (func $evict (export "evict") (param $p i32) (param $q i32) (result i32)
  (local $x i32)
  (local.set $x (i32.load (local.get $p)))
  (drop (call $touch (local.get $q)))
  (i32.store offset=24 (local.get $p) (local.get $x))
  (i32.add (local.get $x) (i32.add (i32.load offset=8 (local.get $p)) (i32.load offset=16 (local.get $p)))))
 (func $evictInd (export "evictInd") (param $p i32) (param $q i32) (result i32)
  (local $x i32)
  (local.set $x (i32.load (local.get $p)))
  (drop (call_indirect (type $t1) (local.get $q) (i32.const 0)))
  (i32.store offset=24 (local.get $p) (i32.add (local.get $x) (i32.const 1)))
  (i32.add (local.get $x) (i32.add (i32.load offset=8 (local.get $p)) (i32.load offset=16 (local.get $p)))))
 (func $casc (export "casc") (param $a i32) (param $b i32) (param $c i32) (result i32)
  (local $x i32)
  (local.set $x (i32.load (local.get $a)))
  (local.set $x (i32.add (local.get $x) (i32.load (local.get $b))))
  (local.set $x (i32.add (local.get $x) (i32.load (local.get $c))))
  (i32.store offset=4 (local.get $a) (local.get $x))
  (i32.store offset=4 (local.get $b) (i32.add (local.get $x) (i32.const 3)))
  (i32.store offset=4 (local.get $c) (i32.add (local.get $x) (i32.const 5)))
  (i32.add (local.get $x) (i32.add (i32.load offset=8 (local.get $a)) (i32.add (i32.load offset=8 (local.get $b)) (i32.load offset=8 (local.get $c))))))
 (func $join (export "join") (param $p i32) (param $c i32) (result i32)
  (local $x i32)
  (if (local.get $c)
   (then (local.set $x (i32.add (i32.load (local.get $p)) (i32.load offset=4 (local.get $p)))))
   (else (local.set $x (i32.load offset=8 (local.get $p)))))
  (i32.add (local.get $x) (i32.load offset=12 (local.get $p))))
 (func $skip (export "skip") (param $p i32) (param $c i32) (result i32)
  (local $x i32)
  (block $out
   (br_if $out (local.get $c))
   (local.set $x (i32.add (i32.load (local.get $p)) (i32.load offset=4 (local.get $p)))))
  (i32.add (local.get $x) (i32.load offset=8 (local.get $p))))
 (func $wb (export "wb") (param $p i32) (result i32)
  (i32.store (local.get $p) (local.tee $p (i32.load offset=4 (local.get $p))))
  (i32.add (i32.load offset=8 (local.get $p)) (i32.load offset=12 (local.get $p))))
 (func $hoistLoop (export "hoistLoop") (param $b i32) (param $n i32) (result i32)
  (local $acc i32)
  (loop $l
   (local.set $acc (i32.add (local.get $acc) (i32.add (i32.load offset=8 (local.get $b)) (i32.load offset=12 (local.get $b)))))
   (i32.store offset=16 (local.get $b) (local.get $acc))
   (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
  (local.get $acc))
 (func $hoist3 (export "hoist3") (param $a i32) (param $b i32) (param $c i32) (param $n i32) (result i32)
  (local $acc i32)
  (loop $l
   (local.set $acc (i32.add (local.get $acc) (i32.add (i32.load offset=8 (local.get $a)) (i32.add (i32.load offset=8 (local.get $b)) (i32.load offset=8 (local.get $c))))))
   (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
  (local.get $acc))
 (func $loopTail (export "loopTail") (param $p i32) (param $q i32) (param $n i32) (result i32)
  (local $acc i32)
  (local.set $acc (i32.load (local.get $p)))
  (loop $l
   (local.set $acc (i32.add (local.get $acc) (i32.load offset=4 (local.get $p))))
   (i32.store offset=8 (local.get $p) (local.get $acc))
   (local.set $acc (i32.add (local.get $acc) (call $touch (i32.add (local.get $q) (i32.shl (i32.and (local.get $n) (i32.const 3)) (i32.const 16))))))
   (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
  (local.get $acc))
 (func $callLoop (export "callLoop") (param $p i32) (param $q i32) (param $n i32) (result i32)
  (local $acc i32)
  (loop $l
   (local.set $acc (i32.add (local.get $acc) (i32.load offset=4 (local.get $p))))
   (local.set $acc (i32.add (local.get $acc) (call $touch (i32.add (local.get $q) (i32.shl (i32.and (local.get $n) (i32.const 3)) (i32.const 16))))))
   (i32.store offset=8 (local.get $p) (local.get $acc))
   (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
  (i32.add (local.get $acc) (i32.load offset=12 (local.get $p))))
)
`;

function nativeModule(): Uint8Array {
	const m = binaryen.parseText(WAT);
	m.setFeatures(binaryen.Features.MVP);
	if (!m.validate()) throw new Error('fixture module is invalid');
	const bytes = m.emitBinary();
	m.dispose();
	return bytes;
}

const native = nativeModule();
const variants = {
	ep: translate(native, { ...translateOptions, epoch: true }),
	'ep-count': translate(native, { ...translateOptions, epoch: true, count: true })
};

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
	results.push({ name, ok, detail });
	console.log(JSON.stringify({ test: name, ok, detail }));
};

const data = seedData();
const addr = (page: number, off: number) => page * PAGE + off;
const nodeAt = (page: number, k: number) => addr(page, k * 16);

interface Case {
	name: string;
	fn: string;
	args: number[];
	cfg?: Partial<PagerOptions>;
	pre?: [string, number[]][];
	expectEpoch?: boolean;
	expectGroups?: boolean;
}

const cascadePre: [string, number[]][] = [
	['touch', [nodeAt(8, 1)]],
	['touch', [nodeAt(9, 2)]],
	['touch', [nodeAt(14, 4)]]
];
const cascadeArgs = [nodeAt(8, 1), nodeAt(9, 2), nodeAt(10, 3)];

const cases: Case[] = [
	{ name: 'loop re-sets its base (3 frames)', fn: 'walk', args: [nodeAt(9, 5), 300], expectGroups: true },
	{ name: 'loop re-sets its base (fixed map)', fn: 'walk', args: [nodeAt(3, 7), 500], cfg: { mode: 'fixed', frames: 8 } },
	{ name: 'span across a page boundary (fixed map)', fn: 'cross', args: [addr(9, 0) - 60], cfg: { mode: 'fixed', frames: 8 }, expectGroups: true },
	{ name: 'span across a page boundary, boundary at the first page', fn: 'cross', args: [addr(8, 0) + PAGE - 60], cfg: { mode: 'fixed', frames: 8 } },
	{ name: 'span inside the arena', fn: 'cross', args: [addr(3, 100)] },
	{ name: 'eviction inside a callee (call)', fn: 'evict', args: [nodeAt(8, 9), nodeAt(11, 3)], cfg: { frames: 1 }, expectEpoch: true },
	{ name: 'eviction inside a callee (call_indirect)', fn: 'evictInd', args: [nodeAt(9, 9), nodeAt(12, 3)], cfg: { frames: 1 }, expectEpoch: true },
	{ name: 'eviction in a callee, callee page already resident', fn: 'evict', args: [nodeAt(10, 9), nodeAt(10, 3)], cfg: { frames: 2 } },
	{ name: 'forced re-check cascade (3 frames, 3 live groups)', fn: 'casc', args: cascadeArgs, cfg: { frames: 3 }, pre: cascadePre, expectEpoch: true },
	{ name: 'join: a group inside one arm does not cover the code after the join', fn: 'join', args: [nodeAt(12, 6), 1], expectGroups: true },
	{ name: 'join, else arm', fn: 'join', args: [nodeAt(13, 6), 0] },
	{ name: 'skip: br_if before the first access', fn: 'skip', args: [nodeAt(12, 6), 1] },
	{ name: 'skip, falls through', fn: 'skip', args: [nodeAt(12, 6), 0] },
	{ name: 'store whose value moves the base', fn: 'wb', args: [nodeAt(9, 11)], expectGroups: true },
	{ name: 'store whose value moves the base (p in the arena)', fn: 'wb', args: [nodeAt(5, 11)] },
	{ name: 'call-free loop with an invariant base (hoisted)', fn: 'hoistLoop', args: [nodeAt(10, 12), 40] },
	{
		name: 'hoisted loop keys that evict each other before the loop starts',
		fn: 'hoist3',
		args: [nodeAt(9, 3), nodeAt(10, 4), nodeAt(11, 5), 20],
		cfg: { frames: 3 },
		pre: [
			['touch', [nodeAt(14, 1)]],
			['touch', [nodeAt(15, 2)]]
		],
		expectEpoch: true
	},
	{ name: 'loop whose only call follows every member and whose check ends right before the loop', fn: 'loopTail', args: [nodeAt(8, 21), addr(9, 0), 25], cfg: { frames: 1 }, expectEpoch: true },
	{ name: 'loop with a call that evicts the loop base', fn: 'callLoop', args: [nodeAt(8, 21), addr(9, 0), 25], cfg: { frames: 1 }, expectEpoch: true }
];

for (const variant of ['ep', 'ep-count'] as const) {
	for (const c of cases) {
		const n = await runNative(native, c.fn, c.args, data, c.pre);
		const t = await runTranslated(variants[variant].bytes, c.fn, c.args, data, c.cfg ?? {}, c.pre);
		let ok = n.result === t.result && n.trap === t.trap && n.pages === t.pages;
		let detail = `native=${n.result ?? n.trap} translated=${t.result ?? t.trap} faults=${t.pager.counts.faults} evictions=${t.pager.counts.evictions} pages=${n.pages === t.pages ? 'same' : 'DIFFER'}`;
		if (variant === 'ep-count') {
			detail += ` counters=${JSON.stringify(t.counters)}`;
			if (c.expectEpoch && !(t.counters.epoch! > 0)) {
				ok = false;
				detail += ' (expected the epoch re-check to run)';
			}
			if (c.expectGroups && !(t.counters.gchk! > 0)) {
				ok = false;
				detail += ' (expected a group check to run)';
			}
		}
		record(`${variant}: ${c.name}`, ok, detail);
	}
}

// the cascade runs more than one re-check round
{
	const t = await runTranslated(variants['ep-count'].bytes, 'casc', cascadeArgs, data, { frames: 3 }, cascadePre);
	record(
		'cascade needs more than one re-check round',
		(t.counters.epoch ?? 0) >= 2,
		`rechecks=${t.counters.epoch} evictions=${t.pager.counts.evictions}`
	);
}

// 3 live pages in 2 frames never settle: the bound trap with the distinct message
{
	const n = await runNative(native, 'casc', cascadeArgs, data);
	const t = await runTranslated(variants.ep.bytes, 'casc', cascadeArgs, data, { frames: 2 });
	record(
		'a re-check that cannot settle traps with the distinct message',
		n.result !== undefined && t.trap !== undefined && t.trap.includes(`(${EPOCH_BOUND_BYTES} bytes)`),
		`native=${n.result} translated=${t.trap}`
	);
}

// a span whose pages are mapped to different frames traps like a straddling access does
{
	const t = await runTranslated(variants.ep.bytes, 'cross', [addr(9, 0) - 60], data, { mode: 'split', frames: 8 });
	record(
		'a span across pages with different frames traps (page straddle)',
		t.trap !== undefined && t.trap.includes('page straddle'),
		`translated=${t.trap}`
	);
}

console.log(JSON.stringify({ variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { bytes: v.bytes.length, stats: v.stats }])) }));
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
