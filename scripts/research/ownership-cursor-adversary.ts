import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
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
import { CURSOR_BASES, DELAYED, regionsMatch } from './ownership-cursor-modules.ts';
import { extremeMatches } from './ownership-extent-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-cursor-adversary.ts [OUT.jsonl] ; text edits of the cursor hand modules. Each accepted mutant is
// run at two arena bases, at extreme record lengths, on a wider memory with poison pages, through the private
// windows and through the in-place slice route. `truth` as the first argument is the child that does the first three
const SEEDS = [1, 2, 3];
const options = { allocator: { arenaBytes: ARENA_BYTES } };
const LENGTHS = [0, 1, 15, 299, 300, 371, 372, 495, 496, 497, 1000, 4096];
const WIDER_PAGES = 12;

// premise check: a result that depends on the size of the memory is not a fault of the certificate
function widerMatches(bytes: Uint8Array): { ok: boolean; why?: string } {
	const run = (pages: number) => {
		const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
		const view = new Uint8Array(memory.buffer);
		layoutAlloc(view, new Uint32Array(memory.buffer), 1, 0);
		view.fill(0xcd, 8 * 65536);
		const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
			env: { memory, f: () => {} }
		});
		let trapped = false;
		try {
			(instance.exports.bulk as (t: number, n: number, o: number) => void)(
				TABLE,
				RECORDS,
				OUT
			);
		} catch {
			trapped = true;
		}
		return { trapped, view };
	};
	const a = run(8);
	const b = run(WIDER_PAGES);
	if (a.trapped !== b.trapped) return { ok: false, why: 'trap differs on a wider memory' };
	for (let i = 0; i < 8 * 65536; i++)
		if (a.view[i] !== b.view[i] && !(i >= STACK_TOP - 4096 && i < STACK_TOP))
			return { ok: false, why: `byte ${i} differs on a wider memory` };
	return { ok: true };
}

const regionsOf = (bytes: Uint8Array, c: OwnershipCertificate) => regionsMatch(bytes, c.windows);

if (process.argv[2] === 'cert') {
	const bytes = new Uint8Array(readFileSync(0));
	console.log(JSON.stringify(certifyOwnership(bytes, options)));
	process.exit(0);
}

if (process.argv[2] === 'truth') {
	const bytes = new Uint8Array(readFileSync(0));
	const c = certifyOwnership(bytes, options);
	if (c.kind !== 'certificate') throw new Error('refused');
	const rel = relocationMatches(bytes, c, SEEDS);
	const ext = extremeMatches(bytes, c.allocator!.pointerCells, LENGTHS);
	const wide = widerMatches(bytes);
	const own = regionsOf(bytes, c);
	console.log(JSON.stringify({ rel, ext, wide, own }));
	process.exit(0);
}

const output = process.argv[2];
if (output) writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

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
	extreme?: string;
	wider?: string;
	regions?: string;
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

// CURSOR_ONLY=file: one label per line, to rerun the rows another lane's unfinished edit of the checker spoiled
const only = process.env.CURSOR_ONLY
	? new Set(readFileSync(process.env.CURSOR_ONLY, 'utf8').split('\n').filter(Boolean))
	: undefined;

async function classify(label: string, operator: string, base: AllocBase, statements: string[]) {
	if (only && !only.has(label)) return;
	let bytes: Uint8Array;
	try {
		bytes = allocModuleOf(base, statements, undefined, 40);
	} catch {
		return;
	}
	// a mutant that makes the checker run for a minute is a finding of its own
	const made = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'cert'], {
		input: bytes,
		timeout: 60000,
		encoding: 'utf8',
		maxBuffer: 1 << 26
	});
	if (made.error || made.status !== 0) {
		rows.push({ label, operator, outcome: 'timeout' });
		emit({ label, outcome: 'timeout' });
		return;
	}
	const r = JSON.parse(made.stdout) as ReturnType<typeof certifyOwnership>;
	if (r.kind === 'refusal') {
		rows.push({ label, operator, outcome: r.reason });
		emit({ label, outcome: r.reason });
		return;
	}
	const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'truth'], {
		input: bytes,
		timeout: 30000,
		encoding: 'utf8'
	});
	if (child.error || child.status !== 0) {
		const row: Row = { label, operator, outcome: 'certificate', route: 'diverges' };
		rows.push(row);
		emit(row);
		return;
	}
	const truth = JSON.parse(child.stdout.trim().split('\n').pop()!) as {
		rel: { ok: boolean; why?: string };
		ext: { ok: boolean; why?: string };
		wide: { ok: boolean; why?: string };
		own: { ok: boolean; why?: string };
	};
	const route = truth.wide.ok ? await routeTruth(bytes, r) : { route: 'skipped', why: undefined };
	const row: Row = {
		label,
		operator,
		outcome: 'certificate',
		relocation: truth.rel.ok ? 'equal' : 'differs',
		extreme: truth.ext.ok ? 'equal' : 'differs',
		wider: truth.wide.ok ? 'equal' : 'premise',
		regions: truth.own.ok ? 'own' : 'premise',
		route: route.route,
		why: truth.rel.why ?? truth.ext.why ?? truth.wide.why ?? truth.own.why ?? route.why
	};
	rows.push(row);
	emit(row);
}

const wrap = (s: string) => `(if (i32.and (local.get $sum) (i32.const 1)) (then ${s}))`;
const LOCALS = ['$sum', '$len', '$a', '$b', '$c', '$n', '$d', '$p', '$slot', '$k'];

const bases: [string, AllocBase][] = [
	...Object.entries(CURSOR_BASES).filter(([name]) => name !== 'bottomwide'),
	['delayed', DELAYED]
];

for (const [name, base] of bases) {
	const stm = base.statements;
	await classify(`${name}-base`, 'base', base, stm);
	for (let i = 0; i < stm.length; i++) {
		await classify(
			`${name}-delete-${i}`,
			'delete',
			base,
			stm.filter((_, k) => k !== i)
		);
		await classify(
			`${name}-cond-${i}`,
			'conditional',
			base,
			stm.map((s, k) => (k === i ? wrap(s) : s))
		);
		if (i + 1 < stm.length) {
			const swapped = [...stm];
			[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
			await classify(`${name}-swap-${i}`, 'swap', base, swapped);
		}
		const edit = (index: number, length: number, text: string) =>
			stm.map((s, k) => (k === i ? s.slice(0, index) + text + s.slice(index + length) : s));
		for (const m of stm[i]!.matchAll(/\(i32\.const (-?\d+)\)/g)) {
			const n = Number(m[1]);
			for (const [tag, to] of [
				['up', n + 1],
				['down', n - 1],
				['double', n * 2],
				['half', Math.floor(n / 2)],
				['neg', n === 0 ? 1 : -n]
			] as const) {
				if (to === n) continue;
				await classify(
					`${name}-const-${i}-${m.index}-${tag}`,
					`const-${tag}`,
					base,
					edit(m.index!, m[0].length, `(i32.const ${to})`)
				);
			}
		}
		for (const m of stm[i]!.matchAll(/\(i32\.(lt_u|le_u|gt_u|ge_u|eq|ne) /g))
			for (const to of ['lt_u', 'le_u', 'gt_u', 'ge_u', 'eq', 'ne']) {
				if (to === m[1]) continue;
				await classify(
					`${name}-rel-${i}-${m.index}-${to}`,
					'rel',
					base,
					edit(m.index!, m[0].length, `(i32.${to} `)
				);
			}
		for (const m of stm[i]!.matchAll(/\(local\.get (\$[a-z]+)\)/g))
			for (const to of LOCALS) {
				if (`(local.get ${to})` === m[0]) continue;
				await classify(
					`${name}-local-${i}-${m.index}-${to}`,
					'local',
					base,
					edit(m.index!, m[0].length, `(local.get ${to})`)
				);
			}
		for (const m of stm[i]!.matchAll(/\(i32\.(add|sub|and|shl|or) /g))
			for (const to of ['add', 'sub', 'and', 'shl', 'or', 'mul']) {
				if (to === m[1]) continue;
				await classify(
					`${name}-op-${i}-${m.index}-${to}`,
					'op',
					base,
					edit(m.index!, m[0].length, `(i32.${to} `)
				);
			}
	}
}

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
const wrong = accepted.filter(
	(r) =>
		r.regions !== 'premise' &&
		(r.relocation === 'differs' || r.extreme === 'differs' || r.route === 'differs')
);
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
			premiseViolated: accepted.filter(
				(r) => r.wider === 'premise' || r.regions === 'premise'
			).length,
			premiseRegionsAndRouteDiffers: accepted.filter(
				(r) => r.regions === 'premise' && r.route === 'differs'
			).length,
			diverges: accepted.filter((r) => r.route === 'diverges').length,
			routes: [...routes],
			topReasons: [...reasons].sort((a, b) => b[1] - a[1])
		},
		null,
		1
	)
);
for (const r of wrong)
	console.log('FALSE CERTIFICATE', r.label, r.relocation, r.extreme, r.route, r.why);
process.exit(0);
