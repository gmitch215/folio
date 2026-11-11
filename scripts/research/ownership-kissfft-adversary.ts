import binaryen from 'binaryen';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import {
	certifyOwnership,
	checkConfig,
	type OwnershipCertificate,
	type OwnershipOptions
} from '../../src/ownership.ts';
import { hostMath, moduleBytes, recordsOf, writeRecords } from './c21-common.ts';
import { layoutOf, rng, specs } from './c21-kernels.ts';
import { sameError } from './iteration-diff.ts';
import {
	configImage,
	KCFG,
	KEXTENT,
	KFACTORS,
	KISS_MUTANTS,
	KISS_RUN,
	KISS_WORK,
	kissCase,
	kissModule,
	kissRoute,
	KN,
	KTMP,
	type KissMutant
} from './ownership-kissfft-modules.ts';
import { ARENA, DATA, OUT, RECORDS, TABLE } from './ownership-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	firstDifference,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-kissfft-adversary.ts kissfft OUT.jsonl ; mutate the config-premise hand modules, their configs and
// premises, and kissfft-real-shared; certify with the config option and run every accepted mutant through the private
// window route and the in-place slice pool (6 seeds, trapping seeds included) against the serial run on a poisoned wider memory
const output = process.argv[3] ?? process.argv[2];
if (output && output !== 'kissfft') writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output && output !== 'kissfft' ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

const PAGE = 65536;
const NEVER = 'any';
const SEEDS = [1, 2, 3, 4, 5, 6];
const MAX = 40;

interface Row {
	label: string;
	family: 'hand' | 'config' | 'driver';
	operator: string;
	expect: string[];
	outcome: string;
	route?: 'equal' | 'differs' | 'notRunnable' | 'refused' | 'premise';
	trapped?: number;
	why?: string;
}
const rows: Row[] = [];

interface Cfg {
	factors: number[];
	tmp: number;
	n: number;
	cap: number;
	extent: number;
	/** what the certificate is told about the config; the memory always holds the real one */
	told?: { word?: number; at?: number; bytes?: Uint8Array };
}
const BASE_CFG: Cfg = { factors: KFACTORS, tmp: KTMP, n: KN, cap: 12, extent: KEXTENT };

// the checker's disjoint-store bookkeeping is quadratic, so a mutant whose exact loop never ends needs minutes to
// reach the default 4,000,000 steps; hand modules need under 10,000, so their mutants run with this cap and the
// result reports the cap and the defect. The real driver runs at the default.
const HAND_STEPS = 400_000;

const optionsOf = (cfg: Cfg) => ({
	maxSteps: HAND_STEPS,
	config: {
		word: cfg.told?.word ?? 8,
		at: cfg.told?.at ?? KCFG,
		bytes: cfg.told?.bytes ?? configImage(cfg.factors, cfg.tmp, cfg.n),
		extent: cfg.extent
	},
	recursion: cfg.cap
});

// #region ground truth

const handCase = (cfg: Cfg, seed: number, trap = -1) => {
	const c = kissCase(seed, cfg.factors, trap, cfg.tmp, cfg.n);
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
	return { image: c.image, call };
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
			// the router names every region the records can write: outputs, arena slices and inputs
			const writes = call.regions.slice(1);
			const run = await slicesRun(rig, bootedImage(rig, image, imports), call, { writes });
			if (want.error !== undefined) trapped++;
			if (run.error instanceof Error && run.error.name === 'OwnershipSlicesError')
				return { route: 'refused', why: run.error.message, trapped };
			const at = firstDifference(want.bytes, run.bytes, from);
			if (at !== -1 || !sameError(want.error, run.error))
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
	options: OwnershipOptions,
	truth: (c: OwnershipCertificate) => Promise<Pick<Row, 'route' | 'why' | 'trapped'>>
) {
	const r = certifyOwnership(bytes, options);
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

const GATE_RUN = '(i32.and (i32.load8_u (i32.load (local.get $t))) (i32.const 1))';
const GATE_WORK = '(i32.and (i32.load8_u (local.get $f)) (i32.const 1))';

async function hand(
	label: string,
	family: 'hand' | 'config',
	operator: string,
	expect: string[],
	work: string,
	run: string,
	cfg: Cfg = BASE_CFG,
	extra = ''
) {
	if (process.env.OWNERSHIP_KISSFFT_HAND === '0') return;
	let bytes: Uint8Array;
	try {
		bytes = kissModule(work, run + (extra ? `\n\t${extra}` : ''), MAX);
	} catch {
		return;
	}
	await classify(label, family, operator, expect, bytes, optionsOf(cfg), async (c) => {
		const probe = handCase(cfg, 1);
		if (!checkConfig(c, probe.image, { at: TABLE, count: RECORDS }))
			return { route: 'refused', why: 'the router premise check fails' };
		const plain = kissRoute(bytes, c.windows, SEEDS, cfg.factors, cfg.tmp, cfg.n);
		if (plain === 'differs') return { route: 'differs', why: 'private-window route differs' };
		if (plain === 'premise') return { route: 'premise', why: 'depends on the memory size' };
		return slicesTruth(
			bytes,
			c,
			[...SEEDS.map((s) => handCase(cfg, s)), handCase(cfg, 3, 2), handCase(cfg, 5, 6)],
			8,
			MAX,
			{ f: () => {} },
			0
		);
	});
}

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

const operators = (gate: string): Record<string, (form: string) => string> => ({
	delete: () => '(nop)',
	conditional: (form) => `(if ${gate} (then ${form}))`,
	trap: (form) => `(block ${form} (if ${gate} (then (unreachable))))`,
	'fill-after': (form) =>
		`(block ${form} (memory.fill (i32.const ${KTMP}) (i32.const 0) (i32.const 16)))`,
	'address-leak': (form) => `(block ${form} (i32.store (i32.const ${KTMP}) (i32.const ${KTMP})))`
});

const VOID = /\((?:i32\.store(?:8|16)?|local\.set|call|memory\.fill|memory\.copy)[ \n]/g;

await hand('base', 'hand', 'base', ['certificate'], KISS_WORK, KISS_RUN);

// every void site of the two functions, five operators
for (const [which, text, gate] of [
	['work', KISS_WORK, GATE_WORK],
	['run', KISS_RUN, GATE_RUN]
] as const) {
	const sites = parenSites(text, VOID);
	for (const [k, [a, b]] of sites.entries())
		for (const [operator, make] of Object.entries(operators(gate))) {
			const edited = text.slice(0, a) + make(text.slice(a, b)) + text.slice(b);
			await hand(
				`${which}-${operator}-${k}`,
				'hand',
				operator,
				[NEVER],
				which === 'work' ? edited : KISS_WORK,
				which === 'run' ? edited : KISS_RUN
			);
		}
	// i32 constants plus and minus one
	const consts = [...text.matchAll(/\(i32\.const (\d+)\)/g)];
	for (const [k, m] of consts.entries())
		for (const delta of [-1, 1]) {
			const n = Number(m[1]) + delta;
			if (n < 0) continue;
			const edited =
				text.slice(0, m.index!) + `(i32.const ${n})` + text.slice(m.index! + m[0].length);
			await hand(
				`${which}-const-${k}-${delta > 0 ? 'plus' : 'minus'}`,
				'hand',
				'constant',
				[NEVER],
				which === 'work' ? edited : KISS_WORK,
				which === 'run' ? edited : KISS_RUN
			);
		}
}

// statements inserted at three places of $run
const INSERTS: Record<string, string> = {
	'read-scratch': '(i32.store offset=48 (local.get $slot) (i32.load (local.get $tmp)))',
	'read-padding':
		'(i32.store offset=52 (local.get $slot) (i32.load offset=192 (local.get $cfg)))',
	'write-padding': '(i32.store offset=232 (local.get $cfg) (i32.const 9))',
	'write-weights': '(i32.store offset=100 (local.get $cfg) (i32.const 9))',
	'write-frozen': '(i32.store offset=12 (local.get $cfg) (i32.const 9))',
	'write-scratch-data':
		'(i32.store (i32.add (local.get $tmp) (i32.shl (i32.and (i32.load (i32.load (local.get $t))) (i32.const 7)) (i32.const 2))) (i32.const 1))',
	'fill-scratch': '(memory.fill (local.get $tmp) (i32.const 5) (i32.const 32))',
	'copy-in': '(memory.copy (local.get $tmp) (i32.load (local.get $t)) (i32.const 32))',
	'copy-out':
		'(memory.copy (i32.add (local.get $slot) (i32.const 48)) (local.get $tmp) (i32.const 8))',
	'trap-odd': `(if ${GATE_RUN} (then (unreachable)))`,
	escape: '(i32.store offset=56 (local.get $slot) (local.get $tmp))',
	'second-work':
		'(call $work (local.get $tmp) (i32.load (local.get $t)) (i32.const 1) (i32.add (local.get $cfg) (i32.const 8)))',
	'wide-store': '(i64.store (local.get $tmp) (i64.const 1))',
	'store-through-word': '(i32.store (i32.load (local.get $cfg)) (i32.const 1))',
	'store-at-base': '(i32.store (i32.load (local.get $t)) (i32.const 1))'
};
const points = ['(call $work', '(loop $o', '(i32.store offset=40'];
for (const [name, text] of Object.entries(INSERTS))
	for (const [k, at] of points.entries()) {
		const i = KISS_RUN.indexOf(at);
		await hand(
			`insert-${name}-${k}`,
			'hand',
			name,
			[NEVER],
			KISS_WORK,
			KISS_RUN.slice(0, i) + text + '\n\t\t' + KISS_RUN.slice(i)
		);
	}

// the named mutants
for (const m of KISS_MUTANTS) {
	const edit = (text: string, edits: [string, string][] = []) =>
		edits.reduce((t, [from, to]) => t.replace(from, to), text);
	const factors = m.factors ?? KFACTORS;
	await hand(
		`named-${m.name}`,
		'hand',
		'named',
		m.expect,
		edit(KISS_WORK, m.work),
		edit(KISS_RUN, m.run),
		{ ...BASE_CFG, factors },
		(m as KissMutant).extra
	);
}

// #endregion

// #region configs and premises

const next = rng(0x6a09e667);
const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;

// random factor lists: consistent chains (p times m equals the previous m) and unrelated pairs
for (let k = 0; k < 70; k++) {
	const depth = 1 + Math.floor(next() * 5);
	const consistent = next() < 0.6;
	const factors: number[] = [];
	let m = pick([4, 6, 8, 16]);
	for (let d = 0; d < depth; d++) {
		const p = pick([1, 2, 2, 2, 3, 4]);
		const last = d === depth - 1;
		const nm = consistent
			? last
				? 1
				: Math.max(1, Math.floor(m / p))
			: pick([1, 1, 2, 3, 4, 8]);
		factors.push(p, last ? 1 : nm);
		m = nm;
	}
	const n = pick([KN, KN, 4, 16, factors[0]! * (factors[1] ?? 1) || KN]);
	await hand(`config-factors-${k}`, 'config', 'factors', [NEVER], KISS_WORK, KISS_RUN, {
		...BASE_CFG,
		factors,
		n: Math.min(16, Math.max(1, n))
	});
}
for (const tmp of [KTMP - 8, KTMP - 4, KTMP + 4, KTMP + 8, KTMP + 56, KTMP + 64, KTMP + 100])
	await hand(`config-tmp-${tmp}`, 'config', 'tmp', [NEVER], KISS_WORK, KISS_RUN, {
		...BASE_CFG,
		tmp
	});
for (const n of [1, 2, 4, 5, 7, 9, 12, 16])
	await hand(`config-n-${n}`, 'config', 'n', [NEVER], KISS_WORK, KISS_RUN, { ...BASE_CFG, n });
for (const cap of [1, 2, 3, 4])
	await hand(`config-cap-${cap}`, 'config', 'cap', [NEVER], KISS_WORK, KISS_RUN, {
		...BASE_CFG,
		cap
	});
for (const extent of [16, 64, 100, 200, 260, 600])
	await hand(`config-extent-${extent}`, 'config', 'extent', [NEVER], KISS_WORK, KISS_RUN, {
		...BASE_CFG,
		extent
	});
// the certificate is told the wrong word, address or bytes: the premise check must refuse whenever it certifies
for (const word of [0, 4, 12])
	await hand(`premise-word-${word}`, 'config', 'word', [NEVER], KISS_WORK, KISS_RUN, {
		...BASE_CFG,
		told: { word }
	});
for (const at of [KCFG - 4, KCFG + 4, KCFG + 64])
	await hand(`premise-at-${at}`, 'config', 'at', [NEVER], KISS_WORK, KISS_RUN, {
		...BASE_CFG,
		told: { at }
	});
{
	const real = configImage();
	for (const [k, edit] of [
		[0, (b: Uint8Array) => (b[0]! ^= 4)],
		[1, (b: Uint8Array) => (b[4]! += 1)],
		[2, (b: Uint8Array) => (b[8]! = 4)],
		[3, (b: Uint8Array) => (b[12]! = 4)],
		[4, (b: Uint8Array) => (b[20]! = 4)],
		[5, (b: Uint8Array) => (b[24]! = 2)],
		[6, (b: Uint8Array) => (b[80]! = 1)],
		[7, (b: Uint8Array) => (b[95]! = 1)]
	] as const) {
		const bytes = real.slice();
		edit(bytes);
		await hand(`premise-bytes-${k}`, 'config', 'bytes', [NEVER], KISS_WORK, KISS_RUN, {
			...BASE_CFG,
			told: { bytes }
		});
	}
	for (const length of [8, 32, 64, 120]) {
		const bytes = new Uint8Array(length);
		bytes.set(real.subarray(0, Math.min(length, real.length)));
		await hand(`premise-length-${length}`, 'config', 'length', [NEVER], KISS_WORK, KISS_RUN, {
			...BASE_CFG,
			told: { bytes }
		});
	}
}

// #endregion

// #region kissfft-real-shared

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

const DRIVER = 'kissfft-real-shared';
const PER_DRIVER = Number(process.env.OWNERSHIP_DRIVER_MUTANTS ?? 12);
const spec = specs.find((s) => s.id === DRIVER)!;
const driverFile = `${new URL('../../', import.meta.url).pathname}build/research/c21/${DRIVER}.wasm`;
if (existsSync(driverFile) && PER_DRIVER > 0) {
	const original = moduleBytes(spec);
	const module = binaryen.readBinary(original);
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	const n = 24;
	const layout = layoutOf(spec, n, Array(n).fill(spec.inputBytes));
	const lengthOf = spec.inputBytes;
	const nextByte = rng(0x2f6e2b1);
	const caseOf = (seed: number, trap = -1) => {
		const records = recordsOf(spec, n).map((r) => ({
			...r,
			input:
				seed === 1
					? r.input
					: Uint8Array.from({ length: lengthOf }, () => Math.floor(nextByte() * 256))
		}));
		const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
		const exports = new WebAssembly.Instance(
			new WebAssembly.Module(Uint8Array.from(original)),
			{
				env: { memory, ...hostMath() }
			}
		).exports as Record<string, (...a: number[]) => void>;
		exports.setup!(layout.config, 1, spec.config!.nfft);
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
	const frozen = cases[0]!.image.slice(layout.config, layout.config + 276);
	const options = {
		config: { word: 8, at: layout.config, bytes: frozen, extent: spec.config!.stride },
		recursion: 12
	};
	const sites = parenSites(text, /\((?:i(?:32|64)\.store(?:8|16|32)?|f(?:32|64)\.store)[ \n]/g);
	const picks: number[] = [];
	const step = Math.max(1, Math.floor(sites.length / PER_DRIVER));
	for (let k = 0; k < sites.length && picks.length < PER_DRIVER; k += step) picks.push(k);
	const gate = `(i32.and (i32.load8_u (i32.const ${KTMP})) (i32.const 1))`;
	const tmpAt = 1069332;
	const drv: Record<string, (form: string) => string> = {
		delete: () => '(nop)',
		conditional: (form) =>
			`(if (i32.and (i32.load8_u (i32.const ${tmpAt + 8})) (i32.const 1)) (then ${form}))`,
		trap: (form) =>
			`(block ${form} (if (i32.and (i32.load8_u (i32.const ${tmpAt + 8})) (i32.const 1)) (then (unreachable))))`,
		'fill-after': (form) =>
			`(block ${form} (memory.fill (i32.const ${tmpAt}) (i32.const 0) (i32.const 64)))`,
		'address-leak': (form) =>
			`(block ${form} (i32.store (i32.const ${tmpAt}) (i32.const ${tmpAt})))`
	};
	void gate;
	for (const k of picks)
		for (const [operator, make] of Object.entries(drv)) {
			const [a, b] = sites[k]!;
			const bytes = assembleText(text.slice(0, a) + make(text.slice(a, b)) + text.slice(b));
			if (!bytes) continue;
			await classify(
				`${DRIVER}-${operator}-${k}`,
				'driver',
				operator,
				[NEVER],
				bytes,
				options,
				(c) => slicesTruth(bytes, c, cases, layout.pages, 65536, hostMath(), PAGE)
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
	(r) => !r.expect.includes('certificate') && !r.expect.includes(NEVER)
);
const reasons = new Map<string, number>();
for (const r of refused) reasons.set(r.outcome, (reasons.get(r.outcome) ?? 0) + 1);
const why = new Map<string, number>();
for (const r of notRun) why.set(`${r.route}: ${r.why}`, (why.get(`${r.route}: ${r.why}`) ?? 0) + 1);
console.log(
	JSON.stringify(
		{
			mutants: rows.length,
			hand: rows.filter((r) => r.family === 'hand').length,
			config: rows.filter((r) => r.family === 'config').length,
			driver: rows.filter((r) => r.family === 'driver').length,
			accepted: accepted.length,
			acceptedByFamily: Object.fromEntries(
				['hand', 'config', 'driver'].map((f) => [
					f,
					accepted.filter((r) => r.family === f).length
				])
			),
			acceptedAndRun: accepted.filter((r) => r.route === 'equal').length,
			refused: refused.length,
			acceptedAndWrong: wrong.length,
			acceptedPremiseViolated: premise.length,
			acceptedNotRun: notRun.length,
			notRunWhy: [...why],
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
for (const r of unexplainedAccepted.slice(0, 40)) console.log('unexplained accepted', r.label);
for (const r of unexplainedRefused.slice(0, 40))
	console.log('unexplained refused', r.label, r.outcome, 'expected', r.expect.join('|'));
process.exit(0);
