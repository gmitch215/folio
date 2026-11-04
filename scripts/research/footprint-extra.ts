import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { hostMath, moduleBytes, recordsOf, writeRecords } from './c21-common.ts';
import { layoutOf, outDir, specs } from './c21-kernels.ts';

// usage: footprint-extra.ts OUTPUT.json ; input diversity, relocation, last value and pointer escape
const target = process.argv[2];
if (!target) throw new Error('usage: footprint-extra.ts OUTPUT.json');
if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);

const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
const hash = (view: Uint8Array) => createHash('sha256').update(view).digest('hex').slice(0, 16);
const prng = (seed: number) => {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s & 255;
	};
};

interface Subject {
	id: string;
	n: number;
	view: Uint8Array;
	baseline: Uint8Array;
	run: (i: number) => string;
	// write set of one record run from the baseline, stack writes removed when the subject can shift its stack
	writes: (i: number) => Set<number>;
	own: (i: number) => (at: number) => boolean;
	relocate?: (i: number) => () => void;
	outputRegion: [number, number];
}

const restore = (s: Subject) => s.view.set(s.baseline);

function analyze(s: Subject) {
	const writes: Set<number>[] = [];
	const fresh: string[] = [];
	for (let i = 0; i < s.n; i++) {
		restore(s);
		fresh.push(s.run(i));
		restore(s);
		const w = s.writes(i);
		const mine = s.own(i);
		for (const at of [...w]) if (mine(at)) w.delete(at);
		writes.push(w);
	}
	const sharedOf = (count: number) => {
		const seen = new Map<number, number>();
		for (let i = 0; i < count; i++)
			for (const at of writes[i]!) seen.set(at, (seen.get(at) ?? 0) + 1);
		return [...seen].filter(([, c]) => c > 1).map(([at]) => at);
	};
	const first = sharedOf(Math.min(6, s.n));
	const writers = new Map<number, number>();
	for (const w of writes) for (const at of w) writers.set(at, (writers.get(at) ?? 0) + 1);
	const everyRecord = [...writers].filter(([, c]) => c === s.n).length;
	const all = sharedOf(s.n);
	const carried = (order: number[]) => {
		restore(s);
		const out: string[] = [];
		for (const i of order) out[i] = s.run(i);
		return out;
	};
	const order = [...Array(s.n).keys()];
	const forward = carried(order);
	const finalState = s.view.slice();
	const backward = carried([...order].reverse());
	const same = (a: string[], b: string[]) => a.every((v, i) => v === b[i]);
	const sharedSet = new Set(all);
	let poison = 0;
	const next = prng(7919);
	for (let i = 0; i < Math.min(s.n, 8); i++) {
		restore(s);
		for (const at of all) s.view[at] = next();
		if (s.run(i) !== fresh[i]) poison++;
	}
	let reloc: number | null = null;
	if (s.relocate) {
		reloc = 0;
		for (let i = 0; i < Math.min(s.n, 4); i++) {
			restore(s);
			const undo = s.relocate(i);
			if (s.run(i) !== fresh[i]) reloc++;
			undo();
		}
	}
	// last value: shared bytes that end the sequential run different from the baseline
	let finalDirty = 0;
	for (const at of all) if (finalState[at] !== s.baseline[at]) finalDirty++;
	// escape: words in the output region that hold an address inside the shared hull
	let escapes = 0;
	if (all.length) {
		const lo = Math.min(...all);
		const hi = Math.max(...all);
		const dv = new DataView(finalState.buffer, finalState.byteOffset, finalState.byteLength);
		for (let at = s.outputRegion[0]; at + 4 <= s.outputRegion[1]; at += 4) {
			const v = dv.getUint32(at, true);
			if (v >= lo && v <= hi + 4) escapes++;
		}
	}
	return {
		id: s.id,
		records: s.n,
		sharedFirstSix: first.length,
		sharedAll: all.length,
		writtenByEveryRecord: everyRecord,
		diversityGrowth: all.length - first.length,
		carriedEqualsFresh: same(forward, fresh),
		reversedEqualsFresh: same(backward, fresh),
		poisonChanged: poison,
		relocationChanged: reloc,
		sharedFinalDirty: finalDirty,
		escapeWords: escapes,
		sharedSample: all.slice(0, 6),
		sharedSizeBytes: sharedSet.size
	};
}

// synthetic bulk drivers: the table is 4 words per record (data, length, aux, arena), output slot 64 bytes
const TABLE = 8192;
const OUT = 12288;
const DATA = 16384;
const ARENA = 40960;
const bodies: Record<string, { note: string; body: string }> = {
	clean: {
		note: 'pure function of the record',
		body: '(i32.store (local.get $slot) (local.get $sum))'
	},
	counter: {
		note: 'increments a static counter that is observable after the loop',
		body: `(i32.store (i32.const 4096) (i32.add (i32.load (i32.const 4096)) (i32.const 1)))
			(i32.store (local.get $slot) (local.get $sum))`
	},
	rare: {
		note: 'writes a static only when the first input byte is 255',
		body: `(if (i32.eq (i32.load8_u (local.get $p)) (i32.const 255)) (then (i32.store (i32.const 4100) (i32.const 1))))
			(i32.store (local.get $slot) (local.get $sum))`
	},
	carry: {
		note: 'reads what the previous record wrote',
		body: `(i32.store (local.get $slot) (i32.add (local.get $sum) (i32.load (i32.const 4104))))
			(i32.store (i32.const 4104) (local.get $sum))`
	},
	cursor: {
		note: 'bump cursor reset from the arena pointer; the output is the address it returns',
		body: `(i32.store (i32.const 4112) (local.get $arena))
			(i32.store (i32.const 4112) (i32.add (i32.load (i32.const 4112)) (i32.const 16)))
			(i32.store (local.get $slot) (i32.load (i32.const 4112)))`
	},
	scratch: {
		note: 'write-first static scratch, result independent of its address',
		body: `(i32.store (i32.const 4120) (local.get $sum))
			(i32.store (i32.const 4124) (i32.add (i32.load (i32.const 4120)) (i32.const 1)))
			(i32.store (local.get $slot) (i32.load (i32.const 4124)))`
	}
};
const driverWat = (body: string) => `(module (import "env" "memory" (memory 8))
	(func (export "bulk") (param $t i32) (param $n i32) (param $o i32)
		(local $i i32) (local $p i32) (local $len i32) (local $k i32) (local $sum i32) (local $arena i32) (local $slot i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $p (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 4)))))
			(local.set $len (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 4)))))
			(local.set $arena (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 12)))))
			(local.set $slot (i32.add (local.get $o) (i32.shl (local.get $i) (i32.const 6))))
			(local.set $sum (i32.const 0)) (local.set $k (i32.const 0))
			(block $sd (loop $sl
				(br_if $sd (i32.ge_u (local.get $k) (local.get $len)))
				(local.set $sum (i32.add (local.get $sum) (i32.load8_u (i32.add (local.get $p) (local.get $k)))))
				(local.set $k (i32.add (local.get $k) (i32.const 1))) (br $sl)))
			${body}
			(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $each))))
)`;

const synthetic = (id: string): Subject => {
	const n = 18;
	const module = binaryen.parseText(driverWat(bodies[id]!.body));
	const bytes = Uint8Array.from(module.emitBinary());
	module.dispose();
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: { memory }
	}).exports as Record<string, Function>;
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer);
	const next = prng(12345);
	for (let i = 0; i < n; i++) {
		const at = DATA + i * 320;
		for (let k = 0; k < 256; k++) view[at + k] = next() % 254;
		if (i === 9 || i === 15) view[at] = 255;
		words[(TABLE + 16 * i) / 4] = at;
		words[(TABLE + 16 * i + 4) / 4] = 256;
		words[(TABLE + 16 * i + 12) / 4] = ARENA + i * 64;
	}
	const baseline = view.slice();
	const run = (i: number) => {
		exports.bulk!(TABLE + 16 * i, 1, OUT + 64 * i);
		return hash(view.subarray(OUT + 64 * i, OUT + 64 * (i + 1)));
	};
	const diff = () => {
		const set = new Set<number>();
		for (let at = 0; at < view.length; at++) if (view[at] !== baseline[at]) set.add(at);
		return set;
	};
	return {
		id: `synthetic:${id}`,
		n,
		view,
		baseline,
		run,
		writes: (i) => {
			run(i);
			return diff();
		},
		own: (i) => (at) =>
			(at >= OUT + 64 * i && at < OUT + 64 * (i + 1)) ||
			(at >= ARENA + i * 64 && at < ARENA + (i + 1) * 64),
		relocate: (i) => {
			const slot = (TABLE + 16 * i + 12) / 4;
			const old = words[slot]!;
			words[slot] = 6 * 65536 + i * 64;
			return () => (words[slot] = old);
		},
		outputRegion: [OUT, OUT + 64 * n]
	};
};

const real = (spec: (typeof specs)[number], count: number): Subject => {
	const n = Math.min(count, spec.n);
	const records = recordsOf(spec, n);
	const layout = layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);
	const pages = layout.pages + 24;
	const bytes = moduleBytes(spec);
	const mod = binaryen.readBinary(bytes);
	mod.setFeatures(binaryen.Features.All & ~compact);
	let shifted: Uint8Array<ArrayBuffer> | undefined;
	for (let g = 0; g < mod.getNumGlobals(); g++) {
		if (binaryen.getGlobalInfo(mod.getGlobalByIndex(g)).name === '__stack_pointer') {
			mod.removeGlobal('__stack_pointer');
			mod.addGlobal('__stack_pointer', binaryen.i32, true, mod.i32.const(pages * 65536));
			shifted = Uint8Array.from(mod.emitBinary());
			break;
		}
	}
	mod.dispose();
	const make = (module: Uint8Array<ArrayBuffer>) => {
		const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
		const exports = new WebAssembly.Instance(new WebAssembly.Module(module), {
			env: { memory, ...hostMath() }
		}).exports as Record<string, Function>;
		if (spec.config)
			exports.setup!(layout.config, spec.config.perRecord ? n : 1, spec.config.nfft);
		writeRecords(memory, spec, layout, records);
		return { memory, view: new Uint8Array(memory.buffer), exports };
	};
	const base = make(bytes);
	const alt = shifted ? make(shifted) : undefined;
	const baseline = base.view.slice();
	if (alt) alt.view.set(baseline.subarray(0, Math.min(baseline.length, alt.view.length)));
	const words = new Uint32Array(base.memory.buffer, layout.table, 4 * n);
	const run = (i: number) => {
		base.exports.bulk!(layout.table + 16 * i, 1, layout.out + spec.slot * i);
		return hash(
			base.view.subarray(layout.out + spec.slot * i, layout.out + spec.slot * (i + 1))
		);
	};
	return {
		id: spec.id,
		n,
		view: base.view,
		baseline,
		run,
		writes: (i) => {
			run(i);
			const w0 = new Set<number>();
			for (let at = 0; at < base.view.length; at++)
				if (base.view[at] !== baseline[at]) w0.add(at);
			if (alt) {
				alt.view.set(baseline.subarray(0, Math.min(baseline.length, alt.view.length)));
				alt.exports.bulk!(layout.table + 16 * i, 1, layout.out + spec.slot * i);
				for (const at of [...w0]) if (alt.view[at] === baseline[at]) w0.delete(at);
			}
			return w0;
		},
		own: (i) => (at) =>
			(at >= layout.out + spec.slot * i && at < layout.out + spec.slot * (i + 1)) ||
			(spec.arena > 0 &&
				at >= layout.arena + i * spec.arena &&
				at < layout.arena + (i + 1) * spec.arena) ||
			(!!spec.config &&
				spec.config.perRecord &&
				at >= layout.config + i * spec.config.stride &&
				at < layout.config + (i + 1) * spec.config.stride),
		relocate:
			spec.arena > 0
				? (i) => {
						const old = words[4 * i + 3]!;
						words[4 * i + 3] = (layout.pages + 4) * 65536 + i * 4096;
						return () => (words[4 * i + 3] = old);
					}
				: undefined,
		outputRegion: [layout.out, layout.out + n * spec.slot]
	};
};

const rows: object[] = [];
for (const id of Object.keys(bodies))
	rows.push({ kind: 'synthetic', note: bodies[id]!.note, ...analyze(synthetic(id)) });
for (const spec of specs) {
	if (!existsSync(`${outDir}/${spec.id}.wasm`)) continue;
	try {
		rows.push({ kind: 'real', ...analyze(real(spec, 18)) });
	} catch (error) {
		rows.push({ kind: 'real', id: spec.id, error: String(error).slice(0, 160) });
	}
}
writeFileSync(
	target,
	JSON.stringify(
		{
			kind: 'privatizability-extra-probes',
			node: process.version,
			limitations: [
				'write sets are byte differences; reads and same-value writes are invisible',
				'relocation moves only the arena pointer of a record; static addresses cannot be relocated without a rewrite',
				'escape scan looks for words in the output region that point into the shared hull',
				'18 records per driver, one generator'
			],
			rows
		},
		null,
		2
	) + '\n'
);
for (const r of rows as any[])
	console.log(
		[
			r.kind,
			r.id,
			`shared6=${r.sharedFirstSix}`,
			`shared18=${r.sharedAll}`,
			`carried=${r.carriedEqualsFresh}`,
			`poison=${r.poisonChanged}`,
			`reloc=${r.relocationChanged}`,
			`dirty=${r.sharedFinalDirty}`,
			`escape=${r.escapeWords}`,
			`every=${r.writtenByEveryRecord}`,
			r.error ?? ''
		].join(' ')
	);
