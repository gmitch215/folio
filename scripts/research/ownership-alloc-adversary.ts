import binaryen from 'binaryen';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

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

const NEVER = 'any';
const SEEDS = [1, 2, 3, 4, 5, 6];
const rows: Row[] = [];
const options = { allocator: { arenaBytes: ARENA_BYTES } };

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
	const rel = relocationMatches(bytes, r, SEEDS);
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
	try {
		bytes = allocModuleOf(base, statements, insert, 40);
	} catch {
		return;
	}
	await classify(label, operator, expect, bytes, (b) => certifyOwnership(b, options));
}

for (const [name, base] of Object.entries(ALLOC_BASES)) {
	const body = base.statements;
	await hand(base, body, undefined, name, 'base', ['none']);
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
	for (const [insert, add] of Object.entries(ALLOC_INSERTS))
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
for (const id of DRIVER_IDS) {
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
