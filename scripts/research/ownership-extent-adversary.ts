import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { sameError } from './iteration-diff.ts';
import {
	ALLOC_BASES,
	allocModuleOf,
	ARENA_BYTES,
	ARENAS,
	DATA,
	layoutAlloc,
	OUT,
	RECORDS,
	relocationMatches,
	SLICE,
	STACK_TOP,
	TABLE
} from './ownership-alloc-modules.ts';
import { EXTENT_BASE, extentStatements } from './ownership-relational-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-extent-adversary.ts [OUT.jsonl] ; text edits of the allocation-extent hand module,
// each accepted mutant run at two arena bases, through the private windows and the in-place slice route
const output = process.argv[2];
if (output) writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

const SEEDS = [1, 2, 3, 4, 5, 6];
const options = { allocator: { arenaBytes: ARENA_BYTES } };
const base = extentStatements(EXTENT_BASE);

const call: SliceCall = {
	table: TABLE,
	n: RECORDS,
	out: OUT,
	slot: 64,
	regions: [
		[TABLE, TABLE + 16 * RECORDS],
		[DATA, DATA + 320 * RECORDS],
		[OUT, OUT + 64 * RECORDS],
		[ARENAS, ARENAS + SLICE * RECORDS]
	]
};
const writes: [number, number][] = [
	[OUT, OUT + 64 * RECORDS],
	[ARENAS, ARENAS + SLICE * RECORDS]
];

const differsAt = (a: Uint8Array, b: Uint8Array) => {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (i >= STACK_TOP - 4096 && i < STACK_TOP) continue;
		if (a[i] !== b[i]) return i;
	}
	return -1;
};

interface Row {
	label: string;
	operator: string;
	outcome: string;
	relocation?: string;
	route?: string;
	why?: string;
}
const rows: Row[] = [];

async function routeTruth(bytes: Uint8Array, c: OwnershipCertificate) {
	if (c.wildStores) return { route: 'refused', why: 'wild store' };
	let rig;
	try {
		rig = await openSliceRig(bytes, c, 8, 4, 40);
	} catch (error) {
		return { route: 'notRunnable', why: String(error).slice(0, 100) };
	}
	try {
		for (const seed of SEEDS) {
			const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
			layoutAlloc(new Uint8Array(memory.buffer), new Uint32Array(memory.buffer), seed, 0);
			const image = new Uint8Array(memory.buffer).slice();
			const imports = { f: () => {} };
			const want = serialRun(rig, image, call, imports);
			const got = await slicesRun(rig, bootedImage(rig, image, imports), call, { writes });
			const at = differsAt(want.bytes, got.bytes);
			if (at !== -1 || !sameError(want.error, got.error))
				return { route: 'differs', why: `seed ${seed} byte ${at}` };
		}
		return { route: 'equal', why: undefined };
	} finally {
		await closeSliceRig(rig);
	}
}

async function classify(label: string, operator: string, statements: string[]) {
	let bytes: Uint8Array;
	try {
		bytes = allocModuleOf(ALLOC_BASES.list!, statements, undefined, 40);
	} catch {
		return;
	}
	const r = certifyOwnership(bytes, options);
	if (r.kind === 'refusal') {
		rows.push({ label, operator, outcome: r.reason });
		emit({ label, outcome: r.reason });
		return;
	}
	const probe = spawnSync(
		process.execPath,
		[new URL('./ownership-relational-probe.ts', import.meta.url).pathname, 'alloc'],
		{ input: bytes, timeout: 20000 }
	);
	if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
		const row: Row = { label, operator, outcome: 'certificate', route: 'diverges' };
		rows.push(row);
		emit(row);
		return;
	}
	const rel = relocationMatches(bytes, r, SEEDS);
	const route = await routeTruth(bytes, r);
	const row: Row = {
		label,
		operator,
		outcome: 'certificate',
		relocation: rel.ok ? 'equal' : 'differs',
		route: route.route,
		why: rel.ok ? route.why : rel.why
	};
	rows.push(row);
	emit(row);
}

const join = (s: string[]) => s;
const wrap = (s: string) => `(if (i32.and (local.get $sum) (i32.const 1)) (then ${s}))`;

await classify('base', 'base', join(base));
base.forEach((statement, i) => {
	void statement;
	void i;
});

for (let i = 0; i < base.length; i++) {
	await classify(
		`delete-${i}`,
		'delete',
		base.filter((_, k) => k !== i)
	);
	await classify(
		`cond-${i}`,
		'conditional',
		base.map((s, k) => (k === i ? wrap(s) : s))
	);
	if (i + 1 < base.length) {
		const swapped = [...base];
		[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
		await classify(`swap-${i}`, 'swap', swapped);
	}
	for (const m of base[i]!.matchAll(/\(i32\.const (-?\d+)\)/g)) {
		const n = Number(m[1]);
		for (const [tag, to] of [
			['up', n + 1],
			['down', n - 1],
			['double', n * 2],
			['half', Math.floor(n / 2)],
			['neg', n === 0 ? 1 : -n]
		] as const) {
			if (to === n) continue;
			const text =
				base[i]!.slice(0, m.index!) +
				`(i32.const ${to})` +
				base[i]!.slice(m.index! + m[0].length);
			await classify(
				`const-${i}-${m.index}-${tag}`,
				`const-${tag}`,
				base.map((s, k) => (k === i ? text : s))
			);
		}
	}
	for (const m of base[i]!.matchAll(/\(i32\.(lt_u|le_u|gt_u|ge_u|eq|ne) /g))
		for (const to of ['lt_u', 'le_u', 'gt_u', 'ge_u', 'eq', 'ne']) {
			if (to === m[1]) continue;
			const text =
				base[i]!.slice(0, m.index!) +
				`(i32.${to} ` +
				base[i]!.slice(m.index! + m[0].length);
			await classify(
				`rel-${i}-${m.index}-${to}`,
				'rel',
				base.map((s, k) => (k === i ? text : s))
			);
		}
	for (const m of base[i]!.matchAll(/\(local\.get (\$sum|\$len|\$a|\$k|\$slot)\)/g))
		for (const to of ['$sum', '$len', '$a', '$k', '$arena', '$p']) {
			if (`(local.get ${to})` === m[0]) continue;
			const text =
				base[i]!.slice(0, m.index!) +
				`(local.get ${to})` +
				base[i]!.slice(m.index! + m[0].length);
			await classify(
				`local-${i}-${m.index}-${to}`,
				'local',
				base.map((s, k) => (k === i ? text : s))
			);
		}
}

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
const wrong = accepted.filter((r) => r.relocation === 'differs' || r.route === 'differs');
const reasons = new Map<string, number>();
for (const r of refused) reasons.set(r.outcome, (reasons.get(r.outcome) ?? 0) + 1);
const routes = new Map<string, number>();
for (const r of accepted) routes.set(r.route ?? '', (routes.get(r.route ?? '') ?? 0) + 1);
console.log(
	JSON.stringify(
		{
			mutants: rows.length,
			accepted: accepted.length,
			refused: refused.length,
			acceptedAndWrong: wrong.length,
			routes: [...routes],
			topReasons: [...reasons].sort((a, b) => b[1] - a[1])
		},
		null,
		1
	)
);
for (const r of wrong) console.log('FALSE CERTIFICATE', r.label, r.relocation, r.route, r.why);
process.exit(0);
