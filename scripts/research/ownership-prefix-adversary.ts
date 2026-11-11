import binaryen from 'binaryen';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { hostMath, recordsOf, writeRecords } from './c21-common.ts';
import { layoutOf, outDir, rng, specs } from './c21-kernels.ts';
import { sameError } from './iteration-diff.ts';
import {
	ARENA,
	DATA,
	layoutRecords,
	OUT,
	RECORDS,
	routeMatches,
	TABLE
} from './ownership-modules.ts';
import {
	PREFIX_BASES,
	PREFIX_INSERTS,
	PREFIX_MUTANTS,
	prefixModuleOf,
	type PrefixBase
} from './ownership-prefix-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	firstDifference,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-prefix-adversary.ts OUT.jsonl ; mutate the prefix hand modules and sha256-shared, certify with
// the prefix option, and run every accepted mutant through the redirect and the in-place slice pool (6 seeds, trapping
// seeds included) against the serial run; hand modules also run the private-window route
const output = process.argv[3] ?? process.argv[2];
if (output && output !== 'prefix') writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output && output !== 'prefix' ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

const PAGE = 65536;
const NEVER = 'any';
const SEEDS = [1, 2, 3, 4, 5, 6];
const MAX = 40;
const opts = { prefix: true as const };

interface Row {
	label: string;
	family: 'hand' | 'driver';
	operator: string;
	expect: string[];
	outcome: string;
	route?: 'equal' | 'differs' | 'notRunnable' | 'refused' | 'premise';
	trapped?: number;
	why?: string;
}
const rows: Row[] = [];

// #region ground truth

const handSetup = (seed: number, trapRecord = -1) => {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	layoutRecords(view, new Uint32Array(memory.buffer), seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
	if (trapRecord >= 0) new Uint32Array(memory.buffer, TABLE + 16 * trapRecord, 1)[0] = 0xfffffff0;
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
	return { image: view.slice(), call };
};

async function slicesTruth(
	bytes: Uint8Array,
	c: OwnershipCertificate,
	cases: { image: Uint8Array; call: SliceCall }[],
	pages: number,
	maximum: number,
	imports: WebAssembly.ModuleImports,
	from: number
): Promise<Pick<Row, 'route' | 'why' | 'trapped'>> {
	if (c.wildStores) return { route: 'refused', why: 'wild store' };
	let rig;
	try {
		rig = await openSliceRig(bytes, c, pages, 4, maximum);
	} catch (error) {
		return { route: 'notRunnable', why: String(error).slice(0, 120) };
	}
	let trapped = 0;
	try {
		for (const [k, { image, call }] of cases.entries()) {
			const want = serialRun(rig, image, call, imports);
			// a program whose result changes with four more zero pages reads outside its regions: a premise violation
			const poisoned = new Uint8Array((pages + 4) * PAGE);
			for (let a = 0; a < poisoned.length; a++) poisoned[a] = (a * 13 + 5) & 255;
			poisoned.set(image);
			const wider = serialRun(
				{ pages: pages + 4, original: rig.original },
				poisoned,
				call,
				imports
			);
			if (
				(want.error === undefined) !== (wider.error === undefined) ||
				firstDifference(want.bytes, wider.bytes.subarray(0, want.bytes.length), 0) !== -1
			)
				return { route: 'premise', why: `case ${k} depends on the memory size`, trapped };
			const got = await slicesRun(rig, bootedImage(rig, image, imports), call);
			if (want.error !== undefined) trapped++;
			const at = firstDifference(want.bytes, got.bytes, from);
			if (at !== -1 || !sameError(want.error, got.error))
				return { route: 'differs', why: `case ${k} byte ${at}`, trapped };
		}
		return { route: 'equal', trapped };
	} finally {
		await closeSliceRig(rig);
	}
}

async function classify(
	label: string,
	family: Row['family'],
	operator: string,
	expect: string[],
	bytes: Uint8Array,
	truth: (c: OwnershipCertificate) => Promise<Pick<Row, 'route' | 'why' | 'trapped'>>
) {
	const r = certifyOwnership(bytes, opts);
	if (r.kind === 'refusal') {
		const row: Row = { label, family, operator, expect, outcome: r.reason };
		rows.push(row);
		emit(row);
		return;
	}
	const row: Row = {
		label,
		family,
		operator,
		expect,
		outcome: 'certificate',
		...(await truth(r))
	};
	rows.push(row);
	emit(row);
}

// #endregion

// #region hand modules

const wrap = (statement: string) =>
	`(if (i32.and (local.get $sum) (i32.const 1)) (then ${statement}))`;
const oddLen = '(i32.and (local.get $len) (i32.const 1))';
const early = {
	trap: `(if ${oddLen} (then (unreachable)))`,
	oob: `(if ${oddLen} (then (drop (i32.load (i32.const 2147483632)))))`
};

async function hand(
	base: PrefixBase,
	statements: string[],
	label: string,
	operator: string,
	expect: string[]
) {
	let bytes: Uint8Array;
	try {
		bytes = prefixModuleOf(base, statements, MAX);
	} catch {
		return;
	}
	await classify(label, 'hand', operator, expect, bytes, async (c) => {
		const plain = routeMatches(prefixModuleOf(base, statements), c.windows, SEEDS);
		if (!plain) return { route: 'differs', why: 'private-window route differs' };
		return slicesTruth(
			bytes,
			c,
			[...SEEDS.map((s) => handSetup(s)), handSetup(3, 2), handSetup(5, 6)],
			8,
			MAX,
			{ f: () => {} },
			0
		);
	});
}

for (const [name, base] of Object.entries(PREFIX_BASES)) {
	const body = base.statements;
	await hand(base, body, name, 'base', ['none']);
	for (const [kind, guard] of Object.entries(early))
		await hand(base, [guard, ...body], `${name}-early-${kind}`, kind, ['none', NEVER]);
	for (let i = 0; i < body.length; i++) {
		await hand(
			base,
			body.filter((_, k) => k !== i),
			`${name}-delete-${i}`,
			'delete',
			[NEVER]
		);
		await hand(
			base,
			body.map((s, k) => (k === i ? wrap(s) : s)),
			`${name}-cond-${i}`,
			'conditional',
			[NEVER]
		);
		if (i + 1 < body.length) {
			const swapped = [...body];
			[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
			await hand(base, swapped, `${name}-swap-${i}`, 'swap', [NEVER]);
		}
	}
	for (const [insert, add] of Object.entries(PREFIX_INSERTS))
		for (const at of [0, Math.floor(body.length / 2), body.length])
			await hand(
				base,
				[...body.slice(0, at), add.text, ...body.slice(at)],
				`${name}-${insert}-${at}`,
				insert,
				add.expect
			);
}

// sites in the helper functions: every store and every i32 constant, edited in place
function parenSites(text: string, re: RegExp) {
	const sites: [number, number][] = [];
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

const functionOps: Record<string, (form: string) => string> = {
	delete: () => '(nop)',
	conditional: (form) => `(if ${oddLen.replace('$len', '$len')} (then ${form}))`,
	trap: (form) => `(block ${form} (if (i32.load (i32.const 4164)) (then (unreachable))))`,
	'fill-after': (form) =>
		`(block ${form} (memory.fill (i32.const 4096) (i32.const 0) (i32.const 16)))`,
	'address-leak': (form) => `(block ${form} (i32.store (i32.const 4164) (i32.const 4160)))`
};

for (const [name, base] of Object.entries(PREFIX_BASES)) {
	const sites = parenSites(base.extra, /\((?:i32|i64)\.store(?:8|16|32)?[ \n]/g);
	for (const [k, [a, b]] of sites.entries())
		for (const [operator, make] of Object.entries(functionOps))
			await hand(
				{
					...base,
					extra:
						base.extra.slice(0, a) + make(base.extra.slice(a, b)) + base.extra.slice(b)
				},
				base.statements,
				`${name}-fn-${operator}-${k}`,
				operator,
				[NEVER]
			);
	const consts = [...base.extra.matchAll(/\(i32\.const (\d+)\)/g)];
	for (const [k, m] of consts.entries())
		for (const delta of [-1, 1]) {
			const n = Number(m[1]) + delta;
			if (n < 0) continue;
			const at = m.index!;
			await hand(
				{
					...base,
					extra:
						base.extra.slice(0, at) +
						`(i32.const ${n})` +
						base.extra.slice(at + m[0].length)
				},
				base.statements,
				`${name}-const-${k}-${delta > 0 ? 'plus' : 'minus'}`,
				'constant',
				[NEVER]
			);
		}
}

for (const m of PREFIX_MUTANTS) {
	const base = PREFIX_BASES[m.base]!;
	let extra = base.extra;
	for (const [from, to] of m.edits) extra = extra.replace(from, to);
	await hand({ ...base, extra }, base.statements, `named-${m.name}`, 'named', m.expect);
}

// #endregion

// #region sha256-shared

const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;

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

const DRIVER = 'sha256-shared';
const PER_DRIVER = Number(process.env.OWNERSHIP_DRIVER_MUTANTS ?? 24);
const spec = specs.find((s) => s.id === DRIVER)!;
if (existsSync(`${outDir}/${DRIVER}.wasm`) && PER_DRIVER > 0) {
	const original = new Uint8Array(readFileSync(`${outDir}/${DRIVER}.wasm`));
	const module = binaryen.readBinary(original);
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	const n = 24;
	const layout = layoutOf(spec, n, Array(n).fill(32768));
	const next = rng(0x2f6e2b1);
	const lengths = [1, 55, 56, 63, 64, 65, 120, 128, 4096];
	const caseOf = (seed: number, trap = -1) => {
		const records = recordsOf(spec, n).map((r, i) => ({
			...r,
			input:
				seed === 1
					? r.input
					: Uint8Array.from(
							{ length: lengths[(i + seed) % lengths.length]! + (seed % 3) },
							() => Math.floor(next() * 256)
						)
		}));
		const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
		writeRecords(memory, spec, layout, records);
		if (trap >= 0) new Uint32Array(memory.buffer, layout.table + 16 * trap, 1)[0] = 0xfffffff0;
		return {
			image: new Uint8Array(memory.buffer).slice(),
			call: {
				table: layout.table,
				n,
				out: layout.out,
				slot: spec.slot,
				regions: [
					[layout.table, layout.table + 16 * n],
					[layout.out, layout.out + n * spec.slot],
					[layout.data, layout.end]
				]
			} satisfies SliceCall
		};
	};
	const cases = [caseOf(1), caseOf(2), caseOf(3), caseOf(4), caseOf(5, 7), caseOf(6, 23)];
	const sites = parenSites(text, /\(i(?:32|64)\.store(?:8|16|32)?[ \n]/g);
	const picks: number[] = [];
	const step = Math.max(1, Math.floor(sites.length / PER_DRIVER));
	for (let k = 0; k < sites.length && picks.length < PER_DRIVER; k += step) picks.push(k);
	const gate = '(i32.and (i32.load8_u (i32.const 65860)) (i32.const 1))';
	const operators: Record<string, (form: string) => string> = {
		delete: () => '(nop)',
		conditional: (form) => `(if ${gate} (then ${form}))`,
		trap: (form) => `(block ${form} (if ${gate} (then (unreachable))))`,
		'fill-after': (form) =>
			`(block ${form} (memory.fill (i32.const 65792) (i32.const 0) (i32.const 64)))`,
		'address-leak': (form) => `(block ${form} (i32.store (i32.const 65792) (i32.const 65792)))`
	};
	for (const k of picks)
		for (const [operator, make] of Object.entries(operators)) {
			const [a, b] = sites[k]!;
			const bytes = assembleText(text.slice(0, a) + make(text.slice(a, b)) + text.slice(b));
			if (!bytes) continue;
			await classify(`${DRIVER}-${operator}-${k}`, 'driver', operator, [NEVER], bytes, (c) =>
				slicesTruth(bytes, c, cases, layout.pages, 65536, hostMath(), PAGE)
			);
		}
}

// #endregion

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
const wrong = accepted.filter((r) => r.route === 'differs');
const premise = accepted.filter((r) => r.route === 'premise');
const notRun = accepted.filter(
	(r) => r.route !== 'equal' && r.route !== 'differs' && r.route !== 'premise'
);
const unexplainedRefused = refused.filter(
	(r) => !r.expect.includes(NEVER) && !r.expect.includes(r.outcome)
);
const unexplainedAccepted = accepted.filter(
	(r) => !r.expect.includes('none') && !r.expect.includes(NEVER)
);
const reasons = new Map<string, number>();
for (const r of refused) reasons.set(r.outcome, (reasons.get(r.outcome) ?? 0) + 1);
console.log(
	JSON.stringify(
		{
			mutants: rows.length,
			hand: rows.filter((r) => r.family === 'hand').length,
			driver: rows.filter((r) => r.family === 'driver').length,
			accepted: accepted.length,
			acceptedHand: accepted.filter((r) => r.family === 'hand').length,
			acceptedDriver: accepted.filter((r) => r.family === 'driver').length,
			refused: refused.length,
			acceptedAndWrong: wrong.length,
			acceptedPremiseViolated: premise.length,
			acceptedNotRun: notRun.length,
			acceptedRunTrapping: accepted.filter((r) => (r.trapped ?? 0) > 0).length,
			unexplainedAccepted: unexplainedAccepted.length,
			unexplainedRefused: unexplainedRefused.length,
			topReasons: [...reasons].sort((a, b) => b[1] - a[1])
		},
		null,
		1
	)
);
for (const r of wrong) console.log('FALSE CERTIFICATE', r.label, r.operator, r.why);
for (const r of premise) console.log('premise violated', r.label, r.why);
for (const r of notRun) console.log('accepted, not run', r.label, r.route, r.why);
for (const r of unexplainedAccepted.slice(0, 40)) console.log('unexplained accepted', r.label);
for (const r of unexplainedRefused.slice(0, 40))
	console.log('unexplained refused', r.label, r.outcome, 'expected', r.expect.join('|'));
process.exit(0);
