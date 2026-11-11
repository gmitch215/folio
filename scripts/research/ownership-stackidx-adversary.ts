import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OwnershipCertificate } from '../../src/ownership.ts';
import { sameError } from './iteration-diff.ts';
import {
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
	TABLE,
	type AllocBase
} from './ownership-alloc-modules.ts';
import { regionsMatch } from './ownership-cursor-modules.ts';
import { extremeMatches } from './ownership-extent-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';
import { STACKIDX_BASES } from './ownership-stackidx-modules.ts';

// usage: ownership-stackidx-adversary.ts OUT.jsonl ; mutate the stack-array modules, certify in allocator mode and
// run every accepted mutant at two arena bases, at extreme lengths and through the in-place slice route
const output = process.argv[2];
if (output) writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

interface Row {
	label: string;
	operator: string;
	outcome: string;
	relocation?: 'equal' | 'differs' | 'skipped';
	route?: 'equal' | 'differs' | 'refused' | 'notRunnable' | 'nonterminating' | 'premise';
	why?: string;
}

// STACKIDX_CHECKER names another copy of the checker, to tell what a rule changed
const { certifyOwnership } = (await import(
	process.env.STACKIDX_CHECKER ?? '../../src/ownership.ts'
)) as typeof import('../../src/ownership.ts');
const SEEDS = [1, 2, 3, 4, 5, 6];
const probe = new URL('./ownership-stackidx-probe.ts', import.meta.url);
const rows: Row[] = [];
const options = { allocator: { arenaBytes: ARENA_BYTES }, maxSteps: 400_000 };
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
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (i >= STACK_TOP - 4096 && i < STACK_TOP) continue;
		if (a[i] !== b[i]) return i;
	}
	return a.length === b.length ? -1 : n;
};

async function routeTruth(
	bytes: Uint8Array,
	c: OwnershipCertificate
): Promise<Pick<Row, 'route' | 'why'>> {
	if (c.wildStores) return { route: 'refused', why: 'wild store' };
	let rig;
	try {
		rig = await openSliceRig(bytes, c, 8, 4, 40);
	} catch (error) {
		return { route: 'notRunnable', why: String(error).slice(0, 120) };
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
		return { route: 'equal' };
	} finally {
		await closeSliceRig(rig);
	}
}

// a mutant can loop for ever on some input; the ground truth first runs it in a child that is killed after 10 s
function terminates(bytes: Uint8Array): boolean {
	const run = spawnSync(process.execPath, [fileURLToPath(probe)], {
		input: bytes,
		timeout: 10_000,
		stdio: ['pipe', 'ignore', 'ignore']
	});
	return run.error === undefined;
}

async function classify(label: string, operator: string, bytes: Uint8Array) {
	const r = certifyOwnership(bytes, options);
	if (r.kind === 'refusal') {
		rows.push({ label, operator, outcome: r.reason });
		emit({ label, outcome: r.reason });
		return;
	}
	if (!terminates(bytes)) {
		const row: Row = {
			label,
			operator,
			outcome: 'certificate',
			relocation: 'skipped',
			route: 'nonterminating'
		};
		rows.push(row);
		emit(row);
		return;
	}
	const own = regionsMatch(bytes, r.windows);
	if (!own.ok) {
		const row: Row = {
			label,
			operator,
			outcome: 'certificate',
			relocation: 'skipped',
			route: 'premise',
			why: own.why
		};
		rows.push(row);
		emit(row);
		return;
	}
	const first = relocationMatches(bytes, r, SEEDS);
	const rel = first.ok ? extremeMatches(bytes, r.allocator?.pointerCells) : first;
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

const wrap = (statement: string) =>
	`(if (i32.and (local.get $sum) (i32.const 1)) (then ${statement}))`;

// each distinct edit replaces one occurrence of a constant, an offset, a local, an operator or a comparison
function edits(text: string): { operator: string; text: string }[] {
	const out: { operator: string; text: string }[] = [];
	const at = (re: RegExp, make: (m: RegExpExecArray) => { operator: string; to: string }[]) => {
		for (const m of text.matchAll(re))
			for (const { operator, to } of make(m))
				out.push({
					operator,
					text: text.slice(0, m.index) + to + text.slice(m.index! + m[0].length)
				});
	};
	at(/\(i32\.const (\d+)\)/g, (m) => {
		const n = Number(m[1]);
		if (n === ARENA_BYTES) return [];
		const list: [string, number][] = [
			['const-up', n + 1],
			['const-double', n * 2],
			['const-four', n + 4]
		];
		if (n > 0) list.push(['const-down', n - 1]);
		return list.map(([operator, v]) => ({ operator, to: `(i32.const ${v})` }));
	});
	at(/offset=(\d+)/g, (m) => {
		const n = Number(m[1]);
		const list: [string, number][] = [
			['offset-up', n + 4],
			['offset-odd', n + 1]
		];
		if (n >= 4) list.push(['offset-down', n - 4]);
		return list.map(([operator, v]) => ({ operator, to: `offset=${v}` }));
	});
	at(/\(local\.get \$k\)/g, () => [
		{ operator: 'k-plus-1', to: '(i32.add (local.get $k) (i32.const 1))' },
		{ operator: 'k-minus-1', to: '(i32.sub (local.get $k) (i32.const 1))' },
		{ operator: 'k-sum', to: '(local.get $sum)' },
		{ operator: 'k-neg', to: '(i32.sub (i32.const 0) (local.get $k))' }
	]);
	const ops: Record<string, string[]> = {
		'i32.add': ['i32.sub', 'i32.or'],
		'i32.sub': ['i32.add'],
		'i32.shl': ['i32.shr_u', 'i32.shr_s'],
		'i32.and': ['i32.or', 'i32.xor', 'i32.add'],
		'i32.mul': ['i32.add']
	};
	at(/i32\.(?:add|sub|shl|and|mul)(?=[ \n])/g, (m) =>
		ops[m[0]]!.map((to) => ({ operator: `op-${to}`, to }))
	);
	const swaps: Record<string, string[]> = {
		'i32.ge_u': ['i32.gt_u', 'i32.ge_s', 'i32.le_u'],
		'i32.gt_u': ['i32.ge_u', 'i32.gt_s'],
		'i32.lt_u': ['i32.le_u'],
		'i32.le_u': ['i32.lt_u']
	};
	at(/i32\.(?:ge_u|gt_u|lt_u|le_u)/g, (m) =>
		swaps[m[0]]!.map((to) => ({ operator: `cmp-${to}`, to }))
	);
	// extra statements that write or read the array at an index of a given shape
	return out;
}

const INSERTS: Record<string, string> = {
	'store-plain-at-k':
		'(i32.store (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 2))) (local.get $sum))',
	'store-ptr-at-k':
		'(i32.store (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 2))) (local.get $a))',
	'store-byte-at-k':
		'(i32.store8 (i32.add (i32.add (global.get $sp) (i32.const 17)) (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 2))) (local.get $sum))',
	'store-wide-at-k':
		'(i64.store (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 1)) (i32.const 3))) (i64.const 7))',
	'store-far-index':
		'(i32.store (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 31)) (i32.const 2))) (local.get $sum))',
	'store-sp-index':
		'(i32.store (i32.add (global.get $sp) (i32.shl (i32.and (local.get $sum) (i32.const 63)) (i32.const 2))) (local.get $sum))',
	'read-far-index':
		'(local.set $d (i32.load (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 31)) (i32.const 2)))))',
	'read-then-use':
		'(i32.store8 (i32.add (local.get $a) (i32.and (i32.load (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 2)))) (i32.const 15))) (local.get $sum))',
	'read-signed-index':
		'(local.set $d (i32.load (i32.add (i32.add (global.get $sp) (i32.const 48)) (i32.shl (i32.sub (i32.and (local.get $sum) (i32.const 3)) (i32.const 2)) (i32.const 2)))))',
	'read-byte-array':
		'(local.set $d (i32.load8_u (i32.add (i32.add (global.get $sp) (i32.const 16)) (i32.and (local.get $sum) (i32.const 15)))))',
	'memset-array':
		'(memory.fill (i32.add (global.get $sp) (i32.const 16)) (i32.const 0) (i32.const 8))',
	'ptr-to-slot-index':
		'(i32.store (local.get $slot) (i32.add (global.get $sp) (i32.shl (i32.and (local.get $sum) (i32.const 3)) (i32.const 2))))'
};

const ONLY = process.env.STACKIDX_ONLY?.split(',');

async function hand(base: AllocBase, statements: string[], label: string, operator: string) {
	let bytes: Uint8Array;
	try {
		bytes = allocModuleOf(base, statements, undefined, 40);
	} catch {
		return;
	}
	if (process.env.STACKIDX_TRACE) console.error(label);
	if (process.env.STACKIDX_DUMP === label) {
		console.log(statements.join('\n'));
		process.exit(0);
	}
	await classify(label, operator, bytes);
}

for (const [name, base] of Object.entries(STACKIDX_BASES)) {
	if (ONLY && !ONLY.includes(name)) continue;
	const body = base.statements;
	await hand(base, body, name, 'base');
	for (let i = 0; i < body.length; i++) {
		const list = edits(body[i]!);
		for (let k = 0; k < list.length; k++)
			await hand(
				base,
				body.map((s, at) => (at === i ? list[k]!.text : s)),
				`${name}-${list[k]!.operator}-${i}-${k}`,
				list[k]!.operator
			);
		await hand(
			base,
			body.filter((_, k) => k !== i),
			`${name}-delete-${i}`,
			'delete'
		);
		await hand(
			base,
			body.map((s, k) => (k === i ? wrap(s) : s)),
			`${name}-cond-${i}`,
			'conditional'
		);
		if (i + 1 < body.length) {
			const swapped = [...body];
			[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
			await hand(base, swapped, `${name}-swap-${i}`, 'swap');
		}
	}
	for (const [insert, text] of Object.entries(INSERTS))
		for (const at of [3, Math.floor(body.length / 2) + 2, body.length - 1])
			await hand(
				base,
				[...body.slice(0, at), text, ...body.slice(at)],
				`${name}-${insert}-${at}`,
				insert
			);
}

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
// a record that writes outside its own slot, arena slice, windows and stack breaks the listed premise
// 'record-derived pointers stay inside their regions'; the check runs each record alone (`regionsMatch`)
const premise = accepted.filter((r) => r.route === 'premise');
const wrongReloc = accepted.filter((r) => r.relocation === 'differs');
const wrongRoute = accepted.filter((r) => r.route === 'differs');
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
			acceptedAndWrongRelocation: wrongReloc.length,
			acceptedAndWrongRoute: wrongRoute.length,
			premiseViolated: premise.length,
			routes: [...routes],
			topReasons: [...reasons].sort((a, b) => b[1] - a[1])
		},
		null,
		1
	)
);
for (const r of [...wrongReloc, ...wrongRoute])
	console.log('FALSE CERTIFICATE', r.label, r.relocation, r.route, r.why);
process.exit(0);
