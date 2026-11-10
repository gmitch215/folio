import binaryen from 'binaryen';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { redirectOwnership } from '../../src/ownership-redirect.ts';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { SlicePool } from '../../src/slices.ts';
import { hostMath, moduleBytes, recordsOf, writeRecords, type Record_ } from './c21-common.ts';
import { layoutOf, outDir, rng, specs } from './c21-kernels.ts';
import { sameError } from './iteration-diff.ts';
import {
	ARENA,
	BASES,
	DATA,
	INSERTS,
	iterModuleOf,
	layoutRecords,
	OUT,
	RECORDS,
	TABLE
} from './ownership-modules.ts';
import {
	bootedImage,
	closeSliceRig,
	firstDifference,
	importsUrl,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-slices-gate.ts drivers|control|mutants OUT.jsonl
// runs certified modules through the certificate, the redirect and the in-place slice pool and compares
// with the serial in-place run: memory from 65536 (drivers) or 0 (hand modules) up to the private
// regions, and the trap
const [mode, output] = process.argv.slice(2);
if (!['drivers', 'control', 'mutants'].includes(mode ?? '') || !output)
	throw new Error('usage: ownership-slices-gate.ts drivers|control|mutants OUT.jsonl');
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const PAGE = 65536;
const ID = 'aes-cbc-decrypt-shared';

// #region drivers

function generators(): Record<string, (n: number, spec: (typeof specs)[number]) => Record_[]> {
	return {
		spec: (n, spec) => recordsOf(spec, n),
		random: (n) => {
			const next = rng(0x51ed270b);
			return Array.from({ length: n }, () => ({
				input: Uint8Array.from({ length: 16 * (1 + Math.floor(next() * 512)) }, () =>
					Math.floor(next() * 256)
				),
				aux: Uint8Array.from({ length: 32 }, () => Math.floor(next() * 256))
			}));
		},
		same: (n) => {
			const input = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 255);
			const aux = Uint8Array.from({ length: 32 }, (_, i) => i * 5);
			return Array.from({ length: n }, () => ({ input, aux }));
		}
	};
}

function driverSetup() {
	const spec = specs.find((s) => s.id === ID)!;
	const bytes = moduleBytes(spec);
	const c = certifyOwnership(bytes);
	if (c.kind !== 'certificate') throw new Error(`${ID} is refused: ${c.reason}`);
	return { spec, bytes, c };
}

const callOf = (
	spec: (typeof specs)[number],
	layout: ReturnType<typeof layoutOf>,
	n: number
): SliceCall => ({
	table: layout.table,
	n,
	out: layout.out,
	slot: spec.slot,
	regions: [
		[layout.table, layout.table + 16 * n],
		[layout.aux, layout.aux + n * spec.auxBytes],
		[layout.out, layout.out + n * spec.slot],
		[layout.data, layout.end]
	]
});

async function drivers() {
	const { spec, bytes, c } = driverSetup();
	const redirect = redirectOwnership(bytes, c);
	emit({
		kind: 'header',
		id: ID,
		windows: c.windows,
		copyOut: c.copyOut,
		stats: redirect.stats,
		sha256: c.moduleSha256
	});
	const counts = [5, 24, 70];
	const widths = [1, 2, 4, 8];
	const nmax = Math.max(...counts);
	const layout = layoutOf(spec, nmax, Array(nmax).fill(8192));
	let bad = 0;
	let runs = 0;
	let trapRuns = 0;
	for (const width of widths) {
		const rig = await openSliceRig(bytes, c, layout.pages, width);
		for (const [name, make] of Object.entries(generators()))
			for (const n of counts)
				for (const trap of name === 'random' ? [-1, 0, Math.floor(n / 2), n - 1] : [-1]) {
					const mem = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
					writeRecords(mem, spec, layout, make(n, spec));
					if (trap >= 0)
						new Uint32Array(mem.buffer, layout.table + 16 * trap, 1)[0] = 0xfffffff0;
					const image = new Uint8Array(mem.buffer).slice();
					const call = callOf(spec, layout, n);
					const want = serialRun(rig, image, call, hostMath());
					if (trap >= 0 && want.error === undefined)
						throw new Error('serial run did not trap');
					const got = await slicesRun(rig, bootedImage(rig, image, hostMath()), call);
					const at = firstDifference(want.bytes, got.bytes, PAGE);
					const same = sameError(want.error, got.error);
					runs++;
					if (trap >= 0) trapRuns++;
					if (at !== -1 || !same) bad++;
					emit({
						kind: 'run',
						generator: name,
						n,
						width,
						trap,
						difference: at,
						lowEqual: firstDifference(want.bytes, got.bytes, 0) === -1,
						sameTrap: same,
						serialTrapped: want.error !== undefined,
						replayed: got.report?.replayed,
						refused: got.report?.refused
					});
				}
		await closeSliceRig(rig);
	}
	emit({ kind: 'done', runs, trapRuns, differences: bad });
	console.log(JSON.stringify({ runs, trapRuns, differences: bad }));
}

// the same gate with the copy-out ranges emptied; it has to report a difference
async function control() {
	const { spec, bytes, c } = driverSetup();
	const n = 24;
	const layout = layoutOf(spec, n, Array(n).fill(8192));
	const records = recordsOf(spec, n);
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, records);
	const image = new Uint8Array(mem.buffer).slice();
	const call = callOf(spec, layout, n);
	const redirect = redirectOwnership(bytes, c);
	const memory = new WebAssembly.Memory({
		initial: layout.pages,
		maximum: 65536,
		shared: true
	});
	const pool = await SlicePool.open(redirect.module, {
		memory,
		workers: 4,
		imports: importsUrl,
		ownership: { ...redirect.plan, copyOut: [] }
	});
	const rig = { pages: layout.pages, original: new WebAssembly.Module(Uint8Array.from(bytes)) };
	const want = serialRun(rig, image, call, hostMath());
	const view = new Uint8Array(memory.buffer);
	view.set(bootedImage(rig, image, hostMath()));
	await pool.run(
		'bulk',
		n,
		(from, to) => [call.table + 16 * from, to - from, call.out + call.slot * from],
		{ writes: [[call.out, call.out + n * call.slot]] }
	);
	const at = firstDifference(want.bytes, view.slice(0, layout.pages * PAGE), PAGE);
	emit({ kind: 'control', difference: at });
	console.log(JSON.stringify({ control: 'copy-out emptied', firstDifference: at }));
	await pool.close();
}

// #endregion

// #region mutants

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
		const ok = m.validate();
		const bytes = ok ? Uint8Array.from(m.emitBinary()) : undefined;
		m.dispose();
		return bytes;
	} catch {
		return undefined;
	}
}

const tally = { mutants: 0, accepted: 0, run: 0, notRunnable: 0, differences: 0 };
const reasons = new Map<string, number>();

interface Setup {
	image: Uint8Array;
	call: SliceCall;
	pages: number;
}

async function runMutant(
	label: string,
	family: 'hand' | 'driver',
	bytes: Uint8Array,
	setup: (seed: number) => Setup,
	seeds: number[],
	imports: WebAssembly.ModuleImports
) {
	tally.mutants++;
	const c = certifyOwnership(bytes);
	if (c.kind !== 'certificate') {
		reasons.set(c.reason, (reasons.get(c.reason) ?? 0) + 1);
		return;
	}
	tally.accepted++;
	let rig;
	try {
		rig = await openSliceRig(
			bytes,
			c as OwnershipCertificate,
			setup(seeds[0]!).pages,
			4,
			family === 'hand' ? 40 : 65536
		);
	} catch (error) {
		tally.notRunnable++;
		emit({ kind: 'mutant', label, family, ran: false, why: String(error).slice(0, 160) });
		return;
	}
	let diffs = 0;
	let trapped = 0;
	let replayed = 0;
	let first = -1;
	try {
		for (const seed of seeds) {
			const { image, call } = setup(seed);
			const want = serialRun(rig, image, call, imports);
			const got = await slicesRun(rig, bootedImage(rig, image, imports), call);
			const at = firstDifference(want.bytes, got.bytes, family === 'hand' ? 0 : PAGE);
			if (at !== -1 || !sameError(want.error, got.error)) {
				diffs++;
				if (first < 0) first = at;
			}
			if (want.error !== undefined) trapped++;
			if (got.report?.replayed || got.error !== undefined) replayed++;
		}
	} finally {
		await closeSliceRig(rig);
	}
	tally.run++;
	tally.differences += diffs ? 1 : 0;
	emit({
		kind: 'mutant',
		label,
		family,
		ran: true,
		differences: diffs,
		firstDifference: first,
		seeds: seeds.length,
		trapped,
		replayed
	});
}

async function mutants() {
	const noImports = { f: () => {} };
	const SEEDS = [1, 2, 3, 4, 5, 6];
	const MAX = 40;
	const handSetup = (seed: number): Setup => {
		const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
		const view = new Uint8Array(memory.buffer);
		layoutRecords(view, new Uint32Array(memory.buffer), seed);
		for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
		return {
			image: view.slice(),
			pages: 8,
			call: {
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
			}
		};
	};
	const wrap = (statement: string) =>
		`(if (i32.and (local.get $sum) (i32.const 1)) (then ${statement}))`;
	const hand = async (statements: string[], insert: string | undefined, label: string) => {
		let bytes: Uint8Array;
		try {
			bytes = iterModuleOf(statements, insert, MAX);
		} catch {
			return;
		}
		await runMutant(label, 'hand', bytes, handSetup, SEEDS, noImports);
	};
	const oddSum = '(i32.and (local.get $sum) (i32.const 1))';
	const early = {
		trap: `(if ${oddSum} (then (unreachable)))`,
		oob: `(if ${oddSum} (then (drop (i32.load (i32.const 2147483632)))))`
	};
	for (const [name, base] of Object.entries(BASES)) {
		await hand(base, undefined, name);
		for (const [kind, guard] of Object.entries(early))
			await hand([guard, ...base], undefined, `${name}-early-${kind}`);
		for (let i = 0; i < base.length; i++) {
			await hand(
				base.filter((_, k) => k !== i),
				undefined,
				`${name}-delete-${i}`
			);
			await hand(
				base.map((s, k) => (k === i ? wrap(s) : s)),
				undefined,
				`${name}-cond-${i}`
			);
			if (i + 1 < base.length) {
				const swapped = [...base];
				[swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
				await hand(swapped, undefined, `${name}-swap-${i}`);
			}
		}
		for (const [insert, add] of Object.entries(INSERTS))
			for (const at of [0, Math.floor(base.length / 2), base.length])
				await hand(
					[...base.slice(0, at), ...(add.text ? [add.text] : []), ...base.slice(at)],
					insert,
					`${name}-${insert}-${at}`
				);
	}
	// real driver mutants of aes-cbc-decrypt-shared, edited at store sites
	const spec = specs.find((s) => s.id === ID)!;
	const original = new Uint8Array(readFileSync(`${outDir}/${ID}.wasm`));
	const module = binaryen.readBinary(original);
	module.setFeatures(binaryen.Features.All & ~compact);
	const text = module.emitText();
	module.dispose();
	const n = 24;
	const records = recordsOf(spec, n);
	const layout = layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, records);
	const image = new Uint8Array(mem.buffer).slice();
	const driverSetupOf = (): Setup => ({
		image,
		pages: layout.pages,
		call: callOf(spec, layout, n)
	});
	const sites = storeSites(text);
	const per = Number(process.env.OWNERSHIP_DRIVER_MUTANTS ?? 40);
	const step = Math.max(1, Math.floor(sites.length / per));
	const picks: number[] = [];
	for (let k = 0; k < sites.length && picks.length < per; k += step) picks.push(k);
	const gate = '(i32.and (i32.load8_u (i32.const 66060)) (i32.const 1))';
	const operators: Record<string, (form: string) => string> = {
		delete: () => '(nop)',
		conditional: (form) => `(if ${gate} (then ${form}))`,
		trap: (form) => `(block ${form} (if ${gate} (then (unreachable))))`,
		'fill-after': (form) =>
			`(block ${form} (memory.fill (i32.const 66048) (i32.const 0) (i32.const 64)))`,
		'address-leak': (form) => `(block ${form} (i32.store (i32.const 66048) (i32.const 66048)))`
	};
	for (const k of picks)
		for (const [operator, make] of Object.entries(operators)) {
			const [a, b] = sites[k]!;
			const mutated = assembleText(text.slice(0, a) + make(text.slice(a, b)) + text.slice(b));
			if (!mutated) continue;
			await runMutant(
				`${ID}-${operator}-${k}`,
				'driver',
				mutated,
				driverSetupOf,
				[1],
				hostMath()
			);
		}
	emit({ kind: 'done', ...tally, refusalReasons: [...reasons] });
	console.log(JSON.stringify({ ...tally, refusalReasons: [...reasons] }));
}

// #endregion

if (mode === 'drivers') await drivers();
else if (mode === 'control') await control();
else await mutants();
process.exit(0);
