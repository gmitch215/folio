import binaryen from 'binaryen';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { IterationRoute } from '../../src/extract.ts';
import { ownershipRoute } from '../../src/ownership-redirect.ts';
import { certifyOwnership } from '../../src/ownership.ts';
import { hostMath, moduleBytes, recordsOf, writeRecords, type Record_ } from './c21-common.ts';
import { layoutOf, outDir, rng, specs } from './c21-kernels.ts';
import { sameError } from './iteration-diff.ts';
import {
	BASES,
	INSERTS,
	iterModuleOf,
	layoutRecords,
	OUT,
	RECORDS,
	TABLE
} from './ownership-modules.ts';
import { closeRig, firstDifference, openRig, routed, serial } from './ownership-redirect-rig.ts';

// usage: ownership-redirect-gate.ts drivers|mutants OUT.jsonl
// runs certified modules through the certificate, the redirect and the iteration pool, and compares
// with the serial in-place run: memory outside the stack and arena, and the trap
const [mode, output] = process.argv.slice(2);
if (!['drivers', 'mutants'].includes(mode ?? '') || !output)
	throw new Error('usage: ownership-redirect-gate.ts drivers|mutants OUT.jsonl');
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const PAGE = 65536;

// #region drivers

async function drivers() {
	const id = 'aes-cbc-decrypt-shared';
	const spec = specs.find((s) => s.id === id)!;
	const bytes = moduleBytes(spec);
	const c = certifyOwnership(bytes);
	if (c.kind !== 'certificate') throw new Error(`${id} is refused: ${c.reason}`);
	const { route, redirect } = ownershipRoute(bytes, c);
	if (!route.eligible) throw new Error(`route refused ${route.diagnostics.join('; ')}`);
	emit({
		kind: 'header',
		id,
		windows: c.windows,
		copyOut: c.copyOut,
		stats: redirect.stats,
		sha256: c.moduleSha256
	});
	const counts = [5, 24, 70];
	const widths = [1, 2, 4, 8];
	const nmax = Math.max(...counts);
	const layout = layoutOf(spec, nmax, Array(nmax).fill(8192));
	const rig = await openRig(bytes, route, layout.pages * PAGE, widths, hostMath());
	const generators: Record<string, (n: number) => Record_[]> = {
		spec: (n) => recordsOf(spec, n),
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
	let bad = 0;
	let runs = 0;
	for (const [name, make] of Object.entries(generators))
		for (const n of counts)
			for (const trap of [-1, ...(name === 'random' ? [Math.floor(n / 2), n - 1] : [])]) {
				const mem = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
				writeRecords(mem, spec, layout, make(n));
				if (trap >= 0)
					new Uint32Array(mem.buffer, layout.table + 16 * trap, 1)[0] = 0xfffffff0;
				const image = new Uint8Array(mem.buffer).slice();
				const args = [layout.table, n, layout.out];
				const want = serial(rig, image, args, hostMath());
				if (trap >= 0 && want.error === undefined)
					throw new Error('serial run did not trap');
				for (const width of widths) {
					const got = routed(rig, width, image, args);
					const at = firstDifference(rig, want.bytes, got.bytes, PAGE);
					const same = sameError(want.error, got.error);
					runs++;
					if (at !== -1 || !same) bad++;
					const r = got.report!;
					emit({
						kind: 'run',
						generator: name,
						n,
						width,
						trap,
						difference: at,
						sameTrap: same,
						serialTrapped: want.error !== undefined,
						regions: r.regions,
						replayed: r.replayed,
						rolledBack: r.rolledBack,
						traps: r.traps,
						conflicts: r.conflicts,
						stopped: r.stopped,
						windowRefused: r.windowRefused
					});
				}
			}
	emit({ kind: 'done', runs, differences: bad });
	console.log(JSON.stringify({ runs, differences: bad }));
	await closeRig(rig);
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

async function runMutant(
	label: string,
	family: 'hand' | 'driver',
	bytes: Uint8Array,
	setup: (seed: number) => { image: Uint8Array; args: number[]; hostEnd: number },
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
	let route: IterationRoute;
	let stats: unknown;
	try {
		const made = ownershipRoute(bytes, c);
		route = made.route;
		stats = made.redirect.stats;
	} catch (error) {
		tally.notRunnable++;
		emit({
			kind: 'mutant',
			label,
			family,
			ran: false,
			why: `redirect: ${String(error).slice(0, 120)}`
		});
		return;
	}
	if (!route.eligible) {
		tally.notRunnable++;
		emit({
			kind: 'mutant',
			label,
			family,
			ran: false,
			why: `route: ${route.diagnostics.slice(-1)[0]?.slice(0, 160)}`
		});
		return;
	}
	const rig = await openRig(bytes, route, setup(seeds[0]!).hostEnd, [4], imports);
	let diffs = 0;
	let trapped = 0;
	let replayed = 0;
	let regions = 0;
	try {
		for (const seed of seeds) {
			const { image, args } = setup(seed);
			const want = serial(rig, image, args, imports);
			const got = routed(rig, 4, image, args);
			const at = firstDifference(rig, want.bytes, got.bytes, family === 'hand' ? 0 : PAGE);
			if (at !== -1 || !sameError(want.error, got.error)) diffs++;
			if (want.error !== undefined) trapped++;
			replayed += got.report!.replayed;
			regions += got.report!.regions;
		}
	} finally {
		await closeRig(rig);
	}
	tally.run++;
	tally.differences += diffs ? 1 : 0;
	emit({
		kind: 'mutant',
		label,
		family,
		ran: true,
		differences: diffs,
		seeds: seeds.length,
		trapped,
		regions,
		replayed,
		stats
	});
}

async function mutants() {
	const noImports = { f: () => {} };
	// hand modules: the adversary's enumeration, in the callee shape the iteration route takes
	const SEEDS = [1, 2, 3, 4, 5, 6];
	const handSetup = (seed: number) => {
		const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
		const view = new Uint8Array(memory.buffer);
		layoutRecords(view, new Uint32Array(memory.buffer), seed);
		for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
		return { image: view.slice(), args: [TABLE, RECORDS, OUT], hostEnd: 8 * PAGE };
	};
	const wrap = (statement: string) =>
		`(if (i32.and (local.get $sum) (i32.const 1)) (then ${statement}))`;
	const hand = async (statements: string[], insert: string | undefined, label: string) => {
		let bytes: Uint8Array;
		try {
			bytes = iterModuleOf(statements, insert);
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
		// a trap before the first window write: the serial program stops at the same record
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
	// real driver mutants of aes-cbc-decrypt-shared, edited at store sites as the adversary does
	const id = 'aes-cbc-decrypt-shared';
	const spec = specs.find((s) => s.id === id)!;
	const original = new Uint8Array(readFileSync(`${outDir}/${id}.wasm`));
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
	const driverSetup = () => ({
		image,
		args: [layout.table, n, layout.out],
		hostEnd: layout.pages * PAGE
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
				`${id}-${operator}-${k}`,
				'driver',
				mutated,
				driverSetup,
				[1],
				hostMath()
			);
		}
	emit({ kind: 'done', ...tally, refusalReasons: [...reasons] });
	console.log(JSON.stringify({ ...tally, refusalReasons: [...reasons] }));
}

// #endregion

if (mode === 'drivers') await drivers();
else await mutants();
process.exit(0);
