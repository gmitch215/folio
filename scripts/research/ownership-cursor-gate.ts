import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { redirectOwnership } from '../../src/ownership-redirect.ts';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { SlicePool } from '../../src/slices.ts';
import { hostMath, moduleBytes, recordsOf, writeRecords, type Record_ } from './c21-common.ts';
import { layoutOf, rng, specs } from './c21-kernels.ts';
import { sameError } from './iteration-diff.ts';
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

// usage: C21_OUT=dir ownership-cursor-gate.ts drivers|control|timing OUT.jsonl ID
// the one-driver gate for a qoi driver certified in allocator mode: the certificate, the redirect and the
// in-place slice pool against the serial in-place run, memory from 65536 up
const [mode, output, id = 'qoi-encode'] = process.argv.slice(2);
if (!['drivers', 'control', 'timing'].includes(mode ?? '') || !output)
	throw new Error('usage: ownership-cursor-gate.ts drivers|control|timing OUT.jsonl ID');
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const PAGE = 65536;
const spec = specs.find((s) => s.id === id)!;
const bytes = moduleBytes(spec);
const made = certifyOwnership(bytes, { allocator: { arenaBytes: spec.arena } });
if (made.kind !== 'certificate') throw new Error(`${id} is refused: ${made.reason} ${made.detail}`);
const c: OwnershipCertificate = made;
const decode = id.startsWith('qoi-decode');

// a stream or an image of the same shape as the spec records with a few bytes changed after the header
function varied(n: number, seed: number): Record_[] {
	const next = rng(seed);
	return recordsOf(spec, n).map((r, i) => {
		const input = r.input.slice();
		if (i % 3 === 0) return { ...r, input };
		const from = decode ? 14 : 0;
		const flips = 1 + Math.floor(next() * 40);
		for (let k = 0; k < flips; k++)
			input[from + Math.floor(next() * (input.length - from))] = Math.floor(next() * 256);
		return { ...r, input };
	});
}

function generators(): Record<string, (n: number) => Record_[]> {
	return {
		spec: (n) => recordsOf(spec, n),
		varied: (n) => varied(n, 0x51ed270b),
		noise: (n) => {
			const next = rng(0x2545f491);
			return recordsOf(spec, n).map((r, i) => ({
				...r,
				input:
					i % 2
						? Uint8Array.from({ length: r.input.length }, () =>
								Math.floor(next() * 256)
							)
						: r.input
			}));
		},
		same: (n) => {
			const first = recordsOf(spec, 1)[0]!;
			return Array.from({ length: n }, () => ({ ...first }));
		}
	};
}

const regionsOf = (layout: ReturnType<typeof layoutOf>, n: number): [number, number][] => [
	[layout.table, layout.table + 16 * n],
	[layout.out, layout.out + n * spec.slot],
	[layout.arena, layout.arena + n * spec.arena],
	[layout.data, layout.end]
];

// the arena slices are written outside the windows, so a trap has to put them back as well
const writesOf = (layout: ReturnType<typeof layoutOf>, n: number): [number, number][] => [
	[layout.out, layout.out + n * spec.slot],
	[layout.arena, layout.arena + n * spec.arena]
];

const callOf = (layout: ReturnType<typeof layoutOf>, n: number): SliceCall => ({
	table: layout.table,
	n,
	out: layout.out,
	slot: spec.slot,
	regions: regionsOf(layout, n)
});

const layoutFor = (n: number, records: Record_[]) =>
	layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);

async function drivers() {
	const redirect = redirectOwnership(bytes, c as never);
	emit({
		kind: 'header',
		id,
		windows: c.windows,
		copyOut: c.copyOut,
		wildStores: c.wildStores,
		derefsProved: c.allocator?.derefsProved,
		stats: redirect.stats,
		sha256: c.moduleSha256
	});
	const counts = [5, 24, 70];
	const widths = [1, 2, 4, 8];
	const nmax = Math.max(...counts);
	let bad = 0;
	let runs = 0;
	let trapRuns = 0;
	const layout = layoutOf(spec, nmax, Array(nmax).fill(48000));
	for (const width of widths) {
		const rig = await openSliceRig(bytes, c, layout.pages, width);
		for (const [name, make] of Object.entries(generators()))
			for (const n of counts)
				for (const trap of [-1, 0, Math.floor(n / 2), n - 1]) {
					if (trap >= 0 && name !== 'varied') continue;
					const mem = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
					const records = make(n);
					const own = layoutFor(n, records);
					if (own.pages > rig.pages) throw new Error('layout does not fit the rig');
					writeRecords(mem, spec, layout, records);
					if (trap >= 0)
						new Uint32Array(mem.buffer, layout.table + 16 * trap, 1)[0] = 0xfffffff0;
					const image = new Uint8Array(mem.buffer).slice();
					const call = callOf(layout, n);
					const want = serialRun(rig, image, call, hostMath());
					if (trap >= 0 && want.error === undefined)
						throw new Error('serial run did not trap');
					const got = await slicesRun(rig, bootedImage(rig, image, hostMath()), call, {
						writes: writesOf(layout, n)
					});
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
	const n = 24;
	const records = recordsOf(spec, n);
	const layout = layoutFor(n, records);
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, records);
	const image = new Uint8Array(mem.buffer).slice();
	const call = callOf(layout, n);
	const redirect = redirectOwnership(bytes, c as never);
	const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: 65536, shared: true });
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
		{ writes: writesOf(layout, n) }
	);
	const at = firstDifference(want.bytes, view.slice(0, layout.pages * PAGE), PAGE);
	emit({ kind: 'control', difference: at });
	console.log(JSON.stringify({ control: 'copy-out emptied', firstDifference: at }));
	await pool.close();
}

// serial against the slice pool at 1, 2, 4 and 8 workers, interleaved and rotated, paired inside a round
async function timing() {
	const n = 256;
	const rounds = Number(process.env.ROUNDS ?? 5);
	const records = recordsOf(spec, n);
	const layout = layoutFor(n, records);
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, records);
	const image = new Uint8Array(mem.buffer).slice();
	const call = callOf(layout, n);
	const widths = [1, 2, 4, 8];
	const rigs = new Map<number, Awaited<ReturnType<typeof openSliceRig>>>();
	for (const w of widths) rigs.set(w, await openSliceRig(bytes, c, layout.pages, w));
	const base = rigs.get(1)!;
	const booted = bootedImage(base, image, hostMath());
	const want = serialRun(base, image, call, hostMath()).bytes;
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const ratios: Record<number, number[]> = { 1: [], 2: [], 4: [], 8: [] };
	const serialMs: number[] = [];
	let wrong = 0;
	for (let round = 0; round < rounds; round++) {
		for (let k = 0; k < 2; k++) serialRun(base, image, call, hostMath());
		const t0 = performance.now();
		serialRun(base, image, call, hostMath());
		const serial = performance.now() - t0;
		serialMs.push(serial);
		for (const w of widths) {
			const rig = rigs.get(w)!;
			await slicesRun(rig, booted, call, { writes: writesOf(layout, n) });
			const run = await slicesRun(rig, booted, call, { writes: writesOf(layout, n) });
			if (firstDifference(want, run.bytes, PAGE) !== -1) wrong++;
			ratios[w]!.push(serial / run.wallMs!);
		}
		emit({ kind: 'round', round, load: loadavg()[0], serial });
	}
	for (const rig of rigs.values()) await closeSliceRig(rig);
	const summary = {
		kind: 'summary',
		rounds,
		wrong,
		serialMedianMs: median(serialMs),
		speedupMedian: Object.fromEntries(widths.map((w) => [w, median(ratios[w]!)])),
		speedupRange: Object.fromEntries(
			widths.map((w) => [w, [Math.min(...ratios[w]!), Math.max(...ratios[w]!)]])
		)
	};
	emit(summary);
	console.log(JSON.stringify(summary));
}

if (mode === 'drivers') await drivers();
else if (mode === 'control') await control();
else await timing();
process.exit(0);
