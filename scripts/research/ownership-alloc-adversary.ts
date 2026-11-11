import binaryen from 'binaryen';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { layoutOf, outDir, specs } from './c21-kernels.ts';
import { sameError } from './iteration-diff.ts';
import {
	ALLOC_BASES,
	ALLOC_INSERTS,
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
import { BROTLI_BASES } from './ownership-brotli-modules.ts';
import { DISPATCH_BASES } from './ownership-dispatch-modules.ts';
import { EXTENT_BASES, extremeMatches } from './ownership-extent-modules.ts';
import { SENTINEL_BASES } from './ownership-sentinel-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';
import { YYJSON_BASES } from './ownership-yyjson-modules.ts';
import { YYJSON2_BASES } from './ownership-yyjson2-modules.ts';

const YYJSON_ALL = { ...YYJSON_BASES, ...YYJSON2_BASES, ...DISPATCH_BASES };

// usage: ownership-alloc-adversary.ts [OUT.jsonl] ; mutate the hand allocator modules and the real
// allocator drivers, certify in allocator mode, and run every accepted mutant at two arena bases and
// through the in-place slice route against serial
const output = process.argv[3] ?? process.argv[2];
if (output && output !== 'alloc') writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output && output !== 'alloc' ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

interface Row {
	label: string;
	operator: string;
	expect: string[];
	outcome: string;
	relocation?: 'equal' | 'differs' | 'skipped';
	route?: 'equal' | 'differs' | 'refused' | 'notRunnable' | 'skipped';
	why?: string;
}

const YYJSON_ONLY = !!process.env.YYJSON_ONLY;
const SENTINEL_ONLY = !!process.env.SENTINEL_ONLY || YYJSON_ONLY;
// record lengths around the guard of the sentinel bases and the arena size
const SENTINEL_LENGTHS = YYJSON_ONLY
	? [
			0, 1, 2, 3, 15, 63, 64, 100, 395, 400, 479, 480, 481, 491, 492, 493, 495, 496, 497, 500,
			501, 512, 4096
		]
	: [0, 1, 2, 3, 15, 63, 64, 395, 396, 397, 398, 400, 401, 495, 496, 512, 4096];
const NEVER = 'any';
const SEEDS = [1, 2, 3, 4, 5, 6];
const rows: Row[] = [];
const options = {
	allocator: { arenaBytes: ARENA_BYTES },
	...(SENTINEL_ONLY ? { maxSteps: 60000 } : {})
};

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

// the ground-truth runs in a child process that is stopped when a mutant never ends, as a mutated scan step can
function groundInWorker(
	bytes: Uint8Array,
	cert: OwnershipCertificate
): Promise<{ ok: boolean; why?: string }> {
	const run = spawnSync(
		process.execPath,
		[fileURLToPath(new URL('./ownership-ground-worker.ts', import.meta.url))],
		{
			input: JSON.stringify({
				bytes: Buffer.from(bytes).toString('base64'),
				cert,
				seeds: SEEDS,
				lengths: SENTINEL_LENGTHS
			}),
			timeout: 30000,
			maxBuffer: 1 << 24
		}
	);
	if (run.error || run.signal) return Promise.resolve({ ok: true, why: 'timeout' });
	try {
		return Promise.resolve(JSON.parse(run.stdout.toString()));
	} catch {
		return Promise.resolve({
			ok: false,
			why: 'child failed ' + run.stderr.toString().slice(0, 100)
		});
	}
}

async function classify(
	label: string,
	operator: string,
	expect: string[],
	bytes: Uint8Array,
	cert: (b: Uint8Array) => ReturnType<typeof certifyOwnership>
) {
	const r = cert(bytes);
	if (r.kind === 'refusal') {
		rows.push({ label, operator, expect, outcome: r.reason });
		emit({ label, outcome: r.reason });
		return;
	}
	const rel = YYJSON_ONLY
		? await groundInWorker(bytes, r)
		: relocationMatches(bytes, r, SEEDS).ok
			? extremeMatches(
					bytes,
					r.allocator?.pointerCells,
					SENTINEL_ONLY ? SENTINEL_LENGTHS : undefined
				)
			: relocationMatches(bytes, r, SEEDS);
	if (rel.why === 'timeout') {
		const row: Row = {
			label,
			operator,
			expect,
			outcome: 'certificate',
			relocation: 'skipped',
			route: 'skipped',
			why: 'timeout'
		};
		rows.push(row);
		emit(row);
		return;
	}
	const route = await routeTruth(bytes, r);
	const row: Row = {
		label,
		operator,
		expect,
		outcome: 'certificate',
		relocation: rel.ok ? 'equal' : 'differs',
		route: route.route,
		why: rel.ok ? route.why : rel.why
	};
	rows.push(row);
	emit(row);
}

// #region hand modules

const wrap = (statement: string) =>
	`(if (i32.and (local.get $sum) (i32.const 1)) (then ${statement}))`;

async function hand(
	base: AllocBase,
	statements: string[],
	insert: string | undefined,
	label: string,
	operator: string,
	expect: string[]
) {
	let bytes: Uint8Array;
	// a cursor that never moves makes the module itself run forever, so no ground truth exists
	if (SENTINEL_ONLY && statements.some((s) => s.includes('(local.get $b) (i32.const 0)))')))
		return;
	try {
		bytes = allocModuleOf(base, statements, insert, 40);
	} catch {
		return;
	}
	if (BROTLI_ONLY && !process.env.ONE) {
		// a child process with a timeout, so a mutant that never ends is counted and cannot hang the sweep
		const file = `${tmpdir()}/mutant-${process.pid}.wasm`;
		writeFileSync(file, bytes);
		const run = spawnSync(
			process.execPath,
			[...process.execArgv, new URL(import.meta.url).pathname, 'alloc'],
			{ env: { ...process.env, ONE: file }, timeout: 90000, encoding: 'utf8' }
		);
		const line = run.stdout?.split('\n').find((l) => l.startsWith('ROW '));
		const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
		const row: Row = line
			? { ...JSON.parse(line.slice(4)), label, operator, expect }
			: { label, operator, expect, outcome: timedOut ? 'timeout' : 'crash' };
		rows.push(row);
		emit(row);
		return;
	}
	await classify(label, operator, expect, bytes, (b) => certifyOwnership(b, options));
}

// text edits of the extent bases: each distinct edit replaces one occurrence of a count, an index or a comparison
function extentEdits(text: string): { operator: string; text: string }[] {
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
		if (n === 512) return [];
		const list = [
			['const-up', n + 1],
			['const-double', n * 2]
		] as [string, number][];
		if (n > 0) list.push(['const-down', n - 1]);
		return list.map(([operator, v]) => ({ operator, to: `(i32.const ${v})` }));
	});
	const len = '(local.get $len)';
	at(/\(local\.get \$len\)/g, () =>
		[
			['len-plus-1', `(i32.add ${len} (i32.const 1))`],
			['len-plus-8', `(i32.add ${len} (i32.const 8))`],
			['len-minus-1', `(i32.sub ${len} (i32.const 1))`],
			['len-shl-4', `(i32.shl ${len} (i32.const 4))`],
			['len-sum', '(local.get $sum)'],
			['len-sum-masked', '(i32.and (local.get $sum) (i32.const 1023))']
		].map(([operator, to]) => ({ operator: operator!, to: to! }))
	);
	at(/\(local\.get \$k\)/g, () =>
		[
			['k-plus-1', '(i32.add (local.get $k) (i32.const 1))'],
			['k-minus-1', '(i32.sub (local.get $k) (i32.const 1))'],
			['k-len', len]
		].map(([operator, to]) => ({ operator: operator!, to: to! }))
	);
	const swaps: Record<string, string[]> = {
		'i32.ge_u': ['i32.gt_u', 'i32.ge_s'],
		'i32.gt_u': ['i32.ge_u', 'i32.gt_s'],
		'i32.lt_u': ['i32.le_u'],
		'i32.le_u': ['i32.lt_u']
	};
	at(/i32\.(?:ge_u|gt_u|lt_u|le_u)/g, (m) =>
		swaps[m[0]]!.map((to) => ({ operator: `cmp-${to}`, to }))
	);
	at(/i32\.(?:ne|eq) /g, (m) => [
		{ operator: 'cmp-flip', to: m[0] === 'i32.ne ' ? 'i32.eq ' : 'i32.ne ' }
	]);
	at(/i32\.eqz/g, () => [{ operator: 'eqz-drop', to: 'i32.ne (i32.const 0)' }]);
	at(/(i32\.(?:load8_u|store8)) offset=(\d+)/g, (m) =>
		[0, 1, 3, 4, 8]
			.filter((n) => n !== Number(m[2]))
			.map((n) => ({
				operator: 'offset',
				to: `${m[1]} offset=${n}`
			}))
	);
	at(/i32\.load8_u \(/g, () =>
		[1, 3, 4, 8].map((n) => ({ operator: 'offset-add', to: `i32.load8_u offset=${n} (` }))
	);
	return out;
}

if (process.env.ONE) {
	await classify('one', 'one', [], new Uint8Array(readFileSync(process.env.ONE)), (b) =>
		certifyOwnership(b, options)
	);
	console.log('ROW ' + JSON.stringify(rows[0]));
	process.exit(0);
}

const ONLY = process.env.ALLOC_ONLY?.split(',');
// text edits of the module-level functions of the brotli bases: comparisons, arithmetic, constants and locals
function functionEdits(text: string): { operator: string; text: string }[] {
	const out: { operator: string; text: string }[] = [];
	const at = (re: RegExp, make: (m: RegExpExecArray) => string[], operator: string) => {
		for (const m of text.matchAll(re))
			for (const to of make(m))
				out.push({
					operator,
					text: text.slice(0, m.index) + to + text.slice(m.index! + m[0].length)
				});
	};
	const compares = ['lt_u', 'le_u', 'gt_u', 'ge_u', 'lt_s', 'ge_s', 'eq', 'ne'];
	at(
		/i(32|64)\.(lt_u|le_u|gt_u|ge_u|lt_s|ge_s|eq|ne)\b/g,
		(m) => compares.filter((c) => c !== m[2]).map((c) => `i${m[1]}.${c}`),
		'compare'
	);
	at(/i(32|64)\.(sub|add)\b/g, (m) => [`i${m[1]}.${m[2] === 'sub' ? 'add' : 'sub'}`], 'arith');
	at(
		/\(i(32|64)\.const (\d+)\)/g,
		(m) =>
			[`(i${m[1]}.const ${Number(m[2]) + 1})`, `(i${m[1]}.const ${Number(m[2]) * 2})`].concat(
				Number(m[2]) > 0 ? [`(i${m[1]}.const ${Number(m[2]) - 1})`] : []
			),
		'constant'
	);
	at(
		/\(local\.get \$(k|d|lg|pos|flush)\)/g,
		(m) =>
			['k', 'd', 'lg', 'pos', 'flush']
				.filter((x) => x !== m[1])
				.map((x) => `(local.get $${x})`),
		'local'
	);
	return out;
}

// the yyjson bases: swap each local of the scan and the allocation for another
function localEdits(text: string): { operator: string; text: string }[] {
	const out: { operator: string; text: string }[] = [];
	for (const m of text.matchAll(/\(local\.(get|tee) \$(a|b|c|d|n|acc)\b/g))
		for (const to of ['a', 'b', 'c', 'd', 'acc'].filter((x) => x !== m[2]))
			out.push({
				operator: 'local-swap',
				text:
					text.slice(0, m.index) +
					`(local.${m[1]} $${to}` +
					text.slice(m.index! + m[0].length)
			});
	return out;
}

const BROTLI_ONLY = !!process.env.BROTLI_ONLY;
const EXTENT_ONLY = !!process.env.EXTENT_ONLY || SENTINEL_ONLY || BROTLI_ONLY;
for (const [name, base] of Object.entries({
	...ALLOC_BASES,
	...EXTENT_BASES,
	...SENTINEL_BASES,
	...BROTLI_BASES,
	...YYJSON_ALL
})) {
	if (ONLY && !ONLY.includes(name)) continue;
	if (YYJSON_ONLY ? !(name in YYJSON_ALL) : SENTINEL_ONLY && !(name in SENTINEL_BASES)) continue;
	if (BROTLI_ONLY && !(name in BROTLI_BASES)) continue;
	const extent =
		name in EXTENT_BASES ||
		name in SENTINEL_BASES ||
		name in BROTLI_BASES ||
		name in YYJSON_ALL;
	if (EXTENT_ONLY && !extent) continue;
	const body = base.statements;
	await hand(base, body, undefined, name, 'base', ['none']);
	if (BROTLI_ONLY && base.extra) {
		const edits = functionEdits(base.extra);
		for (let k = 0; k < edits.length; k++)
			await hand(
				{ ...base, extra: edits[k]!.text },
				body,
				undefined,
				`${name}-fn-${edits[k]!.operator}-${k}`,
				edits[k]!.operator,
				[NEVER]
			);
	}
	if (extent)
		for (let i = 0; i < body.length; i++) {
			const edits = [
				...extentEdits(body[i]!),
				...(BROTLI_ONLY || YYJSON_ONLY ? functionEdits(body[i]!) : []),
				...(YYJSON_ONLY ? localEdits(body[i]!) : [])
			];
			for (let k = 0; k < edits.length; k++)
				await hand(
					base,
					body.map((s, at) => (at === i ? edits[k]!.text : s)),
					undefined,
					`${name}-${edits[k]!.operator}-${i}-${k}`,
					edits[k]!.operator,
					[NEVER]
				);
		}
	for (let i = 0; i < body.length; i++) {
		await hand(
			base,
			body.filter((_, k) => k !== i),
			undefined,
			`${name}-delete-${i}`,
			'delete',
			[NEVER]
		);
		await hand(
			base,
			body.map((s, k) => (k === i ? wrap(s) : s)),
			undefined,
			`${name}-cond-${i}`,
			'conditional',
			[NEVER]
		);
		if (i + 1 < body.length) {
			const swapped = [...body];
			[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
			await hand(base, swapped, undefined, `${name}-swap-${i}`, 'swap', [NEVER]);
		}
	}
	for (const [insert, add] of EXTENT_ONLY ? [] : Object.entries(ALLOC_INSERTS))
		for (const at of [0, Math.floor(body.length / 2), body.length])
			await hand(
				base,
				[...body.slice(0, at), ...(add.text ? [add.text] : []), ...body.slice(at)],
				insert,
				`${name}-${insert}-${at}`,
				insert,
				add.expect
			);
}

// #endregion

// #region real allocator drivers

const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

function storeSites(text: string) {
	const sites: [number, number][] = [];
	const re = /\(i(?:32|64)\.store(?:8|16|32)?[ \n]/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		let depth = 0;
		for (let at = m.index; at < text.length; at++) {
			if (text[at] === '(') depth++;
			else if (text[at] === ')' && --depth === 0) {
				sites.push([m.index, at + 1]);
				break;
			}
		}
	}
	return sites;
}

function assembleText(text: string): Uint8Array | undefined {
	try {
		const m = binaryen.parseText(text);
		m.setFeatures(binaryen.Features.All & ~compact);
		const bytes = m.validate() ? Uint8Array.from(m.emitBinary()) : undefined;
		m.dispose();
		return bytes;
	} catch {
		return undefined;
	}
}

const DRIVER_IDS = [
	'miniz-compress',
	'miniz-decompress',
	'qoi-encode',
	'qoi-decode',
	'brotli-compress',
	'qoa-encode',
	'yyjson-read',
	'md4c-html'
];
const PER_DRIVER = Number(process.env.OWNERSHIP_DRIVER_MUTANTS ?? 12);
const driverRows: string[] = [];
for (const id of ONLY ? [] : DRIVER_IDS) {
	const file = `${outDir}/${id}.wasm`;
	const spec = specs.find((s) => s.id === id);
	if (!existsSync(file) || !spec) continue;
	void layoutOf;
	const original = new Uint8Array(readFileSync(file));
	const opts = { allocator: { arenaBytes: spec.arena } };
	const base = certifyOwnership(original, opts);
	driverRows.push(`${id} ${base.kind === 'refusal' ? base.reason : 'CERTIFICATE'}`);
	const module = binaryen.readBinary(original);
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	const sites = storeSites(text);
	const step = Math.max(1, Math.floor(sites.length / PER_DRIVER));
	const gate = '(i32.and (i32.load8_u (i32.const 0)) (i32.const 1))';
	const operators: Record<string, (form: string) => string> = {
		delete: () => '(nop)',
		conditional: (form) => `(if ${gate} (then ${form}))`,
		'address-leak': (form) => `(block ${form} (i32.store (i32.const 4096) (i32.const 4096)))`
	};
	let picked = 0;
	for (let k = 0; k < sites.length && picked < PER_DRIVER; k += step, picked++)
		for (const [operator, make] of Object.entries(operators)) {
			const [a, b] = sites[k]!;
			const bytes = assembleText(text.slice(0, a) + make(text.slice(a, b)) + text.slice(b));
			if (!bytes) continue;
			const r = certifyOwnership(bytes, opts);
			if (r.kind === 'refusal')
				rows.push({
					label: `${id}-${operator}-${k}`,
					operator,
					expect: [NEVER],
					outcome: r.reason
				});
			else
				rows.push({
					label: `${id}-${operator}-${k}`,
					operator,
					expect: [NEVER],
					outcome: 'certificate',
					relocation: 'skipped',
					route: 'skipped',
					why: 'real driver mutant accepted, not run'
				});
		}
}

// #endregion

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
const wrongReloc = accepted.filter((r) => r.relocation === 'differs');
const wrongRoute = accepted.filter((r) => r.route === 'differs');
const unverified = accepted.filter((r) => r.relocation === 'skipped');
const unexplainedAccepted = accepted.filter(
	(r) => !r.expect.includes('none') && !r.expect.includes(NEVER)
);
const unexplainedRefused = refused.filter(
	(r) => !r.expect.includes(NEVER) && !r.expect.includes(r.outcome)
);
const reasons = new Map<string, number>();
for (const r of refused) reasons.set(r.outcome, (reasons.get(r.outcome) ?? 0) + 1);
const routes = new Map<string, number>();
for (const r of accepted) routes.set(r.route ?? '', (routes.get(r.route ?? '') ?? 0) + 1);
console.log(
	JSON.stringify(
		{
			mutants: rows.length,
			hand: rows.filter((r) => !DRIVER_IDS.some((id) => r.label.startsWith(id))).length,
			accepted: accepted.length,
			refused: refused.length,
			acceptedAndWrongRelocation: wrongReloc.length,
			acceptedAndWrongRoute: wrongRoute.length,
			acceptedNotRun: unverified.length,
			unexplainedAccepted: unexplainedAccepted.length,
			unexplainedRefused: unexplainedRefused.length,
			routes: [...routes],
			topReasons: [...reasons].sort((a, b) => b[1] - a[1]),
			drivers: driverRows
		},
		null,
		1
	)
);
for (const r of [...wrongReloc, ...wrongRoute])
	console.log('FALSE CERTIFICATE', r.label, r.relocation, r.route, r.why);
for (const r of unverified) console.log('accepted, not run', r.label);
for (const r of unexplainedAccepted.slice(0, 60))
	console.log('unexplained accepted', r.label, r.operator, r.relocation, r.route);
for (const r of unexplainedRefused.slice(0, 60))
	console.log(
		'unexplained refused',
		r.label,
		r.operator,
		r.outcome,
		'expected',
		r.expect.join('|')
	);
process.exit(0);
