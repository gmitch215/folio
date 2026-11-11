import { appendFileSync, writeFileSync } from 'node:fs';
import { sameError } from './iteration-diff.ts';
import {
	ARENA,
	BASES,
	counterModule,
	DATA,
	layoutRecords,
	OUT,
	RECORDS,
	routeMatches,
	TABLE
} from './ownership-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-counter-adversary.ts OUT.jsonl ; every hand base gets the entry's loop counters (the index, a second
// stepped counter, the record count) stored as data through a long list of operators, and counters used only as
// addresses or loop bounds as controls; each certificate runs the private route and the in-place slice pool against serial
// CHECKER=path loads another copy of the checker, and with it the route is not run (rule removal count)
const { certifyOwnership } = await import(
	process.env.CHECKER ?? new URL('../../src/ownership.ts', import.meta.url).href
);
const output = process.argv[2];
if (output) writeFileSync(output, '', { flag: 'wx' });
const SEEDS = [1, 2, 3, 4, 5, 6];
const call: SliceCall = {
	table: TABLE,
	n: RECORDS,
	out: OUT,
	slot: 64,
	regions: [
		[TABLE, TABLE + 16 * RECORDS],
		[DATA, DATA + 320 * RECORDS],
		[OUT, OUT + 64 * RECORDS],
		[ARENA, ARENA + 64 * RECORDS]
	]
};
const setup = (seed: number) => {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	layoutRecords(view, new Uint32Array(memory.buffer), seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
	return view.slice();
};
const firstDiff = (a: Uint8Array, b: Uint8Array) => {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
	return -1;
};

interface Row {
	label: string;
	kind: 'mutant' | 'control';
	outcome: string;
	detail?: string;
	private?: 'equal' | 'differs';
	route?: string;
}
const rows: Row[] = [];

async function classify(label: string, kind: Row['kind'], body: string, extra = '') {
	const bytes = counterModule({ body, extra });
	const r = certifyOwnership(bytes);
	const row: Row = { label, kind, outcome: r.kind === 'refusal' ? r.reason : 'certificate' };
	if (r.kind === 'refusal') row.detail = r.detail.slice(0, 40);
	if (r.kind === 'certificate' && !process.env.CHECKER) {
		row.private = routeMatches(bytes, r.windows, SEEDS) ? 'equal' : 'differs';
		const rig = await openSliceRig(bytes, r, 8, 4, 40);
		row.route = 'equal';
		try {
			for (const seed of SEEDS) {
				const image = setup(seed);
				const imports = { f: () => {} };
				const want = serialRun(rig, image, call, imports);
				const got = await slicesRun(rig, bootedImage(rig, image, imports), call);
				const d = firstDiff(want.bytes, got.bytes);
				if (d !== -1 || !sameError(want.error, got.error)) {
					row.route = `differs seed ${seed} byte ${d}`;
					break;
				}
			}
		} finally {
			await closeSliceRig(rig);
		}
	}
	rows.push(row);
	if (output) appendFileSync(output, JSON.stringify(row) + '\n');
}

const PUT = '(func $put (param i32 i32) (i32.store offset=4 (local.get 0) (local.get 1)))';
const STEP_J = '(local.set $j (i32.add (local.get $j) (i32.const 3)))';
const counters: Record<string, string> = {
	index: '(local.get $i)',
	second: '(local.get $j)',
	count: '(local.get $n)'
};
const forms: Record<string, (x: string) => string> = {
	plain: (x) => x,
	'plus-sum': (x) => `(i32.add ${x} (local.get $sum))`,
	'plus-const': (x) => `(i32.add ${x} (i32.const 5))`,
	times: (x) => `(i32.mul ${x} (i32.const 3))`,
	shifted: (x) => `(i32.shl ${x} (i32.const 2))`,
	halved: (x) => `(i32.shr_u ${x} (i32.const 1))`,
	masked: (x) => `(i32.and ${x} (i32.const 255))`,
	xored: (x) => `(i32.xor ${x} (local.get $sum))`,
	ored: (x) => `(i32.or ${x} (i32.const 1))`,
	'minus-from-sum': (x) => `(i32.sub (local.get $sum) ${x})`,
	selected: (x) => `(select ${x} (local.get $sum) (i32.and (local.get $sum) (i32.const 1)))`,
	'selected-other': (x) =>
		`(select (local.get $sum) ${x} (i32.and (local.get $sum) (i32.const 1)))`,
	equal: (x) => `(i32.eq ${x} (i32.const 3))`,
	less: (x) => `(i32.lt_u ${x} (local.get $sum))`,
	'by-table-byte': (x) => `(i32.load8_u (i32.add (i32.const 4200) ${x}))`,
	'by-table-word': (x) => `(i32.load (i32.add (i32.const 4200) (i32.shl ${x} (i32.const 2))))`,
	popcount: (x) => `(i32.popcnt ${x})`,
	'through-i64': (x) => `(i32.wrap_i64 (i64.shl (i64.extend_i32_u ${x}) (i64.const 1)))`,
	'sign-extended': (x) => `(i32.extend8_s ${x})`,
	negated: (x) => `(i32.sub (i32.const 0) ${x})`
};
const sinks: Record<string, (v: string) => string> = {
	i32: (v) => `(i32.store offset=4 (local.get $slot) ${v})`,
	i8: (v) => `(i32.store8 offset=4 (local.get $slot) ${v})`,
	i16: (v) => `(i32.store16 offset=4 (local.get $slot) ${v})`,
	i64: (v) => `(i64.store offset=8 (local.get $slot) (i64.extend_i32_u ${v}))`,
	fill: (v) => `(memory.fill (i32.const 4128) ${v} (i32.const 8))`,
	local: (v) => `(local.set $q ${v}) (i32.store offset=4 (local.get $slot) (local.get $q))`,
	call: (v) => `(call $put (local.get $slot) ${v})`
};

const stepFor = (counter: string) => (counter === 'second' ? STEP_J : '');

// the plain operator list on every base, then the sinks on the plain form of each counter
for (const [base, statements] of Object.entries(BASES)) {
	const body = statements.join('\n');
	for (const [counter, x] of Object.entries(counters))
		for (const [form, make] of Object.entries(forms))
			await classify(
				`${base}-${counter}-${form}-i32`,
				'mutant',
				`${body}\n${sinks.i32!(make(x))}\n${stepFor(counter)}`,
				PUT
			);
	for (const [counter, x] of Object.entries(counters))
		for (const [sink, make] of Object.entries(sinks))
			if (sink !== 'i32')
				await classify(
					`${base}-${counter}-plain-${sink}`,
					'mutant',
					`${body}\n${make(x)}\n${stepFor(counter)}`,
					PUT
				);
}

// controls: a counter that only addresses records or bounds a loop certifies and matches the route
const SCR = BASES.scratch!.join('\n');
const controls: Record<string, string> = {
	'address-slot': `${SCR}\n(i32.store (i32.add (local.get $o) (i32.add (i32.shl (local.get $i) (i32.const 6)) (i32.const 8))) (local.get $sum))`,
	'address-table': `${SCR}\n(i32.store offset=12 (local.get $slot) (i32.load (i32.add (local.get $t) (i32.add (i32.shl (local.get $i) (i32.const 4)) (i32.const 8)))))`,
	'address-two': `${SCR}\n(i32.store offset=20 (i32.add (local.get $o) (i32.shl (local.get $j) (i32.const 5))) (local.get $sum))\n(local.set $j (i32.add (local.get $j) (i32.const 2)))`,
	'address-plus-one': `${SCR}\n(i32.store offset=24 (i32.add (local.get $o) (i32.add (i32.shl (local.get $i) (i32.const 6)) (i32.const 4))) (local.get $sum))`,
	'bound-only': SCR
};
for (const [name, body] of Object.entries(controls)) await classify(name, 'control', body, PUT);

const mutants = rows.filter((r) => r.kind === 'mutant');
const accepted = mutants.filter((r) => r.outcome === 'certificate');
const wrong = process.env.CHECKER
	? []
	: accepted.filter((r) => r.route !== 'equal' || r.private !== 'equal');
const byCounter = mutants.filter((r) => r.detail?.startsWith('counter-as-data')).length;
const lost = rows.filter(
	(r) => r.kind === 'control' && (r.outcome !== 'certificate' || r.route !== 'equal')
);
const reasons = new Map<string, number>();
for (const r of mutants) reasons.set(r.outcome, (reasons.get(r.outcome) ?? 0) + 1);
console.log(
	JSON.stringify(
		{
			mutants: mutants.length,
			accepted: accepted.length,
			acceptedAndWrong: wrong.length,
			refused: mutants.length - accepted.length,
			refusedAsCounterAsData: byCounter,
			controls: rows.length - mutants.length,
			controlsLost: lost.length,
			reasons: [...reasons]
		},
		null,
		1
	)
);
for (const r of wrong) console.log('FALSE CERTIFICATE', r.label, r.private, r.route);
for (const r of lost)
	console.log('control not certified or not equal', r.label, r.outcome, r.route);
process.exit(0);
