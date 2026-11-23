import binaryen from 'binaryen';
import { translate } from './elastic-translate.ts';
import {
	MEMORY_PAGES,
	PAGE,
	rng,
	runNative,
	runTranslated,
	seedData,
	translateOptions
} from './fixture-lib.ts';
import type { PagerOptions } from './pager.ts';

// random differential test: small functions made of loads, stores, pointer chasing, ifs, blocks with
// br_if, bounded loops and calls that fault pages in. Each runs untranslated and translated with a
// pager that evicts, and the results and every page must match.
const COUNT = Number(process.argv[2] ?? 300);
const SEED = Number(process.argv[3] ?? 1);

const HEADER = `
 (import "env" "memory" (memory ${MEMORY_PAGES}))
 (global $sp (mut i32) (i32.const 65536))
 (type $t1 (func (param i32) (result i32)))
 (table 2 funcref)
 (elem (i32.const 0) $touch)
 (func $touch (export "touch") (param $a i32) (result i32) (i32.load (local.get $a)))
`;

function generate(seed: number): string {
	const r = rng(seed * 7919 + 13);
	const pick = <T>(xs: T[]) => xs[r() % xs.length]!;
	const base = () => `(local.get $p${r() % 3})`;
	const off = () => 4 * (r() % 26);
	let loops = 0;
	let labels = 0;
	const load = (): string => {
		const form = r() % 4;
		if (form === 0) return `(i32.load (i32.add ${base()} (i32.const ${off()})))`;
		return `(i32.load offset=${off()} ${base()})`;
	};
	const value = (): string =>
		pick([
			`(local.get $acc)`,
			`(i32.const ${r() % 1000})`,
			`(local.get $c)`,
			`(i32.add (local.get $acc) ${load()})`,
			`(i32.xor (local.get $acc) ${load()})`
		]);
	const cond = () => `(i32.and (local.get $acc) (i32.const ${1 << (r() % 6)}))`;
	const stmt = (depth: number): string => {
		const k = r() % 14;
		switch (k) {
			case 0:
			case 1:
			case 2:
				return `(local.set $acc (i32.add (local.get $acc) ${load()}))`;
			case 3:
			case 4:
				return `(i32.store offset=${pick([8, 12])} ${base()} ${value()})`;
			case 5:
				return `(local.set $p${r() % 3} (i32.load offset=${pick([0, 4])} ${base()}))`;
			case 6:
				return `(drop (local.tee $p${r() % 3} (i32.load offset=${pick([0, 4])} ${base()})))`;
			case 7:
				return `(local.set $acc (i32.add (local.get $acc) (call $touch ${pick([base(), `(i32.const ${(1 + (r() % 15)) * PAGE + 4 * (r() % 2000)})`])})))`;
			case 8:
				return `(local.set $acc (i32.add (local.get $acc) (call_indirect (type $t1) ${base()} (i32.const 0))))`;
			case 9:
				return `(i32.store offset=${pick([8, 12])} ${base()} (i32.add (local.get $acc) (call $touch ${base()})))`;
			case 10:
				return depth > 2 ? `(nop)` : `(if ${cond()} (then ${block(depth + 1)}) (else ${block(depth + 1)}))`;
			case 11:
				if (depth > 2 || loops >= 3) return `(nop)`;
				{
					const n = loops++;
					return `(local.set $n${n} (i32.const ${2 + (r() % 3)})) (loop $L${n} ${block(depth + 1)} (br_if $L${n} (local.tee $n${n} (i32.sub (local.get $n${n}) (i32.const 1)))))`;
				}
			case 12:
				if (depth > 2) return `(nop)`;
				{
					const b = labels++;
					return `(block $B${b} (br_if $B${b} ${cond()}) ${block(depth + 1)})`;
				}
			default:
				return `(local.set $acc (i32.add (local.get $acc) (i32.add ${load()} ${load()})))`;
		}
	};
	const block = (depth: number): string => {
		const n = 2 + (r() % 4);
		return Array.from({ length: n }, () => stmt(depth)).join('\n   ');
	};
	return `(module ${HEADER}
 (func $f (export "f") (param $a i32) (param $b i32) (param $c i32) (result i32)
  (local $p0 i32) (local $p1 i32) (local $p2 i32) (local $acc i32) (local $n0 i32) (local $n1 i32) (local $n2 i32)
  (local.set $p0 (local.get $a))
  (local.set $p1 (local.get $b))
  (local.set $p2 (i32.load (local.get $a)))
  ${block(0)}
  (local.get $acc)))`;
}

const data = seedData();
const configs: Partial<PagerOptions>[] = [
	{ mode: 'dynamic', frames: 3 },
	{ mode: 'dynamic', frames: 4 },
	{ mode: 'dynamic', frames: 6 },
	{ mode: 'fixed', frames: 8 }
];
let ran = 0;
let groups = 0;
let epochSites = 0;
let faults = 0;
let evictions = 0;
const failures: string[] = [];
const VARIANT = process.env.VARIANT ?? 'ep';
for (let i = 0; i < COUNT && failures.length < 3; i++) {
	if (process.env.ONLY && Number(process.env.ONLY) !== i) continue;
	const wat = generate(SEED * 100000 + i);
	const m = binaryen.parseText(wat);
	m.setFeatures(binaryen.Features.MVP);
	if (!m.validate()) throw new Error(`generated module ${i} is invalid\n${wat}`);
	const bytes = m.emitBinary();
	m.dispose();
	const t = translate(bytes, { ...translateOptions, epoch: VARIANT === 'ep' });
	groups += t.stats.groups;
	epochSites += t.stats.epochSites;
	const r = rng(i + 99);
	for (let a = 0; a < 3; a++) {
		const node = () => (1 + (r() % 15)) * PAGE + (r() % 4000) * 16;
		const args = [node(), node(), r()];
		const n = await runNative(bytes, 'f', args, data);
		for (const cfg of configs) {
			const x = await runTranslated(t.bytes, 'f', args, data, cfg);
			ran++;
			faults += x.pager.counts.faults;
			evictions += x.pager.counts.evictions;
			if (n.result !== x.result || n.trap !== x.trap || n.pages !== x.pages) {
				failures.push(
					`function ${i} args ${args} cfg ${JSON.stringify(cfg)}: native=${n.result ?? n.trap} translated=${x.result ?? x.trap} pages=${n.pages === x.pages ? 'same' : 'DIFFER'}\n${wat}`
				);
				break;
			}
		}
		if (failures.length) break;
	}
}
console.log(JSON.stringify({ functions: COUNT, seed: SEED, comparisons: ran, groups, epochSites, faults, evictions, failures: failures.length }));
for (const f of failures) console.log(f);
process.exit(failures.length ? 1 : 0);
