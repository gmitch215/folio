import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { sameError } from './iteration-diff.ts';
import {
	ARENA,
	assemble,
	DATA,
	layoutRecords,
	OUT,
	RECORDS,
	routeMatches,
	TABLE
} from './ownership-modules.ts';
import { relWat, TOKEN_BASES } from './ownership-relational-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-relational-adversary.ts [OUT.jsonl] ; mutate the hand token table with text edits
// (constants, comparisons, offsets, locals, deleted or conditional stores), certify every mutant and run
// each accepted one through the private-window route and the in-place slice route against serial
const output = process.argv[2];
if (output) writeFileSync(output, '', { flag: 'wx' });
const emit = (row: object) =>
	output ? appendFileSync(output, JSON.stringify(row) + '\n') : undefined;

const SEEDS = [1, 2, 3, 4, 5, 6];
const MAX = 40;
const base = relWat(TOKEN_BASES.tokens!, '', MAX);

interface Row {
	label: string;
	operator: string;
	outcome: string;
	private?: 'equal' | 'differs' | 'unrunnable';
	route?: 'equal' | 'differs' | 'refused' | 'notRunnable' | 'diverges';
	why?: string;
}
const rows: Row[] = [];

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

function setup(seed: number) {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	const view = new Uint8Array(memory.buffer);
	layoutRecords(view, new Uint32Array(memory.buffer), seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
	return view.slice();
}

const firstDiff = (a: Uint8Array, b: Uint8Array) => {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
	return -1;
};

async function routeTruth(bytes: Uint8Array, c: OwnershipCertificate) {
	if (c.wildStores) return { route: 'refused' as const, why: 'wild store' };
	let rig;
	try {
		rig = await openSliceRig(bytes, c, 8, 4, MAX);
	} catch (error) {
		return { route: 'notRunnable' as const, why: String(error).slice(0, 120) };
	}
	try {
		for (const seed of SEEDS) {
			const image = setup(seed);
			const imports = { f: () => {} };
			const want = serialRun(rig, image, call, imports);
			const got = await slicesRun(rig, bootedImage(rig, image, imports), call);
			const at = firstDiff(want.bytes, got.bytes);
			if (at !== -1 || !sameError(want.error, got.error))
				return { route: 'differs' as const, why: `seed ${seed} byte ${at}` };
		}
		return { route: 'equal' as const, why: undefined };
	} finally {
		await closeSliceRig(rig);
	}
}

// edits to the record loop of the harness (table stride, slot stride) break the layout guard, which every
// certificate assumes, so only edits inside the module body count
const BODY_LO = base.indexOf('(local.set $k (i32.const 0))');
const BODY_HI = base.indexOf('(local.set $i (i32.add (local.get $i)');

async function classify(label: string, operator: string, text: string) {
	let first = 0;
	while (first < base.length && text[first] === base[first]) first++;
	if (label !== 'base' && (first < BODY_LO || first >= BODY_HI)) return;
	let bytes: Uint8Array;
	try {
		bytes = assemble(text);
	} catch {
		return;
	}
	const r = certifyOwnership(bytes);
	if (r.kind === 'refusal') {
		rows.push({ label, operator, outcome: r.reason });
		emit({ label, operator, outcome: r.reason });
		return;
	}
	if (!(await terminates(bytes))) {
		const row: Row = {
			label,
			operator,
			outcome: 'certificate',
			private: 'unrunnable',
			route: 'diverges'
		};
		rows.push(row);
		emit(row);
		return;
	}
	let priv: boolean | undefined;
	try {
		priv = routeMatches(bytes, r.windows, SEEDS);
	} catch {
		priv = undefined;
	}
	const route = await routeTruth(bytes, r);
	const row: Row = {
		label,
		operator,
		outcome: 'certificate',
		private: priv === undefined ? 'unrunnable' : priv ? 'equal' : 'differs',
		route: route.route,
		why: route.why
	};
	rows.push(row);
	emit(row);
}

// a mutant whose serial run never returns cannot be compared, so it is cut off and counted apart
function terminates(bytes: Uint8Array): Promise<boolean> {
	const run = spawnSync(
		process.execPath,
		[new URL('./ownership-relational-probe.ts', import.meta.url).pathname],
		{
			input: bytes,
			timeout: 20000
		}
	);
	return Promise.resolve((run.error as NodeJS.ErrnoException | undefined)?.code !== 'ETIMEDOUT');
}

const at = (text: string, from: number, len: number, to: string) =>
	text.slice(0, from) + to + text.slice(from + len);

// balanced s-expression starting at index
const form = (text: string, start: number) => {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')' && --depth === 0) return text.slice(start, i + 1);
	}
	return '';
};

await classify('base', 'base', base);

// constants: each i32.const one up, one down, doubled
for (const m of base.matchAll(/\(i32\.const (-?\d+)\)/g)) {
	const n = Number(m[1]);
	for (const [tag, to] of [
		['up', n + 1],
		['down', n - 1],
		['double', n * 2],
		['neg', n === 0 ? 1 : -n]
	] as const) {
		if (to === n || Math.abs(to) > 2 ** 31) continue;
		await classify(
			`const-${m.index}-${tag}`,
			`const-${tag}`,
			at(base, m.index!, m[0].length, `(i32.const ${to})`)
		);
	}
}

// comparisons: each relational operator changed to its neighbours
const RELS = ['lt_u', 'le_u', 'gt_u', 'ge_u', 'lt_s', 'le_s', 'gt_s', 'ge_s', 'eq', 'ne'];
for (const m of base.matchAll(/\(i32\.(lt_u|le_u|gt_u|ge_u|lt_s|le_s|gt_s|ge_s|eq|ne) /g)) {
	for (const to of RELS) {
		if (to === m[1]) continue;
		await classify(
			`rel-${m.index}-${to}`,
			'rel',
			at(base, m.index!, m[0].length, `(i32.${to} `)
		);
	}
}

// offsets of loads and stores
for (const m of base.matchAll(/(i32\.(?:load|store)(?:8_u)?) offset=(\d+)/g)) {
	const n = Number(m[2]);
	for (const to of [n + 4, n - 4, 0])
		if (to !== n && to >= 0)
			await classify(
				`offset-${m.index}-${to}`,
				'offset',
				at(base, m.index!, m[0].length, to ? `${m[1]} offset=${to}` : m[1]!)
			);
}

// locals read: each local.get of the index and walk variables replaced by another
const LOCALS = ['$tn', '$cnt', '$q', '$pos', '$sup', '$tk', '$c', '$k'];
let sampled = 0;
for (const m of base.matchAll(/\(local\.get (\$tn|\$cnt|\$q|\$pos|\$sup|\$tk)\)/g)) {
	for (const to of LOCALS) {
		if (`$${m[1]!.slice(1)}` === to) continue;
		if ((sampled++ + (m.index ?? 0)) % 3) continue;
		await classify(
			`local-${m.index}-${to}`,
			'local',
			at(base, m.index!, m[0].length, `(local.get ${to})`)
		);
	}
}

// stores: deleted, conditional on a data bit, duplicated at a shifted address
const gate = '(i32.and (local.get $c) (i32.const 1))';
for (const m of base.matchAll(/\(i32\.store(?:8)?[ \n]/g)) {
	const f = form(base, m.index!);
	if (!f) continue;
	await classify(`delete-${m.index}`, 'delete', at(base, m.index!, f.length, '(nop)'));
	await classify(
		`cond-${m.index}`,
		'conditional',
		at(base, m.index!, f.length, `(if ${gate} (then ${f}))`)
	);
	await classify(
		`twice-${m.index}`,
		'duplicate',
		at(
			base,
			m.index!,
			f.length,
			`(block ${f} ${f.replace('(i32.store', '(i32.store offset=4')})`
		)
	);
}

// shared record state: reads and writes outside the walk
const EXTRA: Record<string, string> = {
	'store-super-sentinel': `(i32.store (i32.const 4360) (i32.add (local.get $cnt) (i32.const -2)))`,
	'store-next-big': `(i32.store (i32.const 4356) (i32.add (local.get $tn) (i32.const 2)))`,
	'store-by-data': `(i32.store (i32.add (i32.const 4096) (i32.and (local.get $c) (i32.const 255))) (i32.const 9))`,
	'store-by-data-wide': `(i32.store (i32.add (i32.const 4096) (i32.shl (local.get $c) (i32.const 2))) (i32.const 9))`,
	'store-by-pos': `(i32.store (i32.add (i32.const 4096) (local.get $pos)) (i32.const 9))`,
	'load-pad': `(i32.store (local.get $slot) (i32.load (i32.const 4400)))`,
	'bound-from-pad': `(br_if $pd (i32.ge_u (local.get $tn) (i32.load (i32.const 4400))))`,
	'bound-from-token': `(br_if $pd (i32.ge_u (local.get $tn) (i32.load (i32.const 4100))))`
};
for (const [name, text] of Object.entries(EXTRA))
	for (const spot of [
		'(local.set $tn (i32.load (i32.const 4356)))\n\t\t\t\t(br_if $pd',
		'(local.set $tk (i32.add (i32.const 4096)',
		'(local.set $sup (i32.load (i32.const 4360)))'
	]) {
		const i = base.indexOf(spot);
		if (i < 0) continue;
		await classify(`${name}-${i}`, 'insert', at(base, i, 0, `${text}\n\t\t\t\t`));
	}

const accepted = rows.filter((r) => r.outcome === 'certificate');
const refused = rows.filter((r) => r.outcome !== 'certificate');
const wrong = accepted.filter((r) => r.private === 'differs' || r.route === 'differs');
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
for (const r of wrong) console.log('FALSE CERTIFICATE', r.label, r.private, r.route, r.why);
process.exit(0);
