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

// usage: ownership-prefix-gate.ts drivers|control|timing OUT.jsonl [ID]
// the one-driver gate of the aes lane for a driver certified with the prefix domain: the certificate,
// the redirect and the in-place slice pool against the serial in-place run, memory from 65536 up
const [mode, output, id = 'sha256-shared'] = process.argv.slice(2);
if (!['drivers', 'control', 'timing'].includes(mode ?? '') || !output)
	throw new Error('usage: ownership-prefix-gate.ts drivers|control|timing OUT.jsonl [ID]');
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const PAGE = 65536;
const spec = specs.find((s) => s.id === id)!;
const bytes = moduleBytes(spec);
const made = certifyOwnership(bytes, { prefix: true });
if (made.kind !== 'certificate') throw new Error(`${id} is refused: ${made.reason} ${made.detail}`);
const c: OwnershipCertificate = made;
const LENGTHS = [1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 4096, 8191];
const MAXIN = 32768;

function generators(): Record<string, (n: number) => Record_[]> {
	return {
		spec: (n) => recordsOf(spec, n),
		random: (n) => {
			const next = rng(0x51ed270b);
			return Array.from({ length: n }, (_, i) => ({
				input: Uint8Array.from(
					{
						length:
							i % 5 === 0
								? LENGTHS[Math.floor(next() * LENGTHS.length)]!
								: 1 + Math.floor(next() * 4000)
					},
					() => Math.floor(next() * 256)
				),
				aux: new Uint8Array(0)
			}));
		},
		same: (n) => {
			const input = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 255);
			return Array.from({ length: n }, () => ({ input, aux: new Uint8Array(0) }));
		}
	};
}

const callOf = (layout: ReturnType<typeof layoutOf>, n: number): SliceCall => ({
	table: layout.table,
	n,
	out: layout.out,
	slot: spec.slot,
	regions: [
		[layout.table, layout.table + 16 * n],
		[layout.out, layout.out + n * spec.slot],
		[layout.data, layout.end]
	]
});

async function drivers() {
	const redirect = redirectOwnership(bytes, c as never);
	emit({
		kind: 'header',
		id,
		windows: c.windows,
		copyOut: c.copyOut,
		prefix: c.prefix,
		wildStores: c.wildStores,
		stats: redirect.stats,
		sha256: c.moduleSha256
	});
	const counts = [5, 24, 70];
	const widths = [1, 2, 4, 8];
	const nmax = Math.max(...counts);
	const layout = layoutOf(spec, nmax, Array(nmax).fill(MAXIN));
	let bad = 0;
	let runs = 0;
	let trapRuns = 0;
	for (const width of widths) {
		const rig = await openSliceRig(bytes, c, layout.pages, width);
		for (const [name, make] of Object.entries(generators()))
			for (const n of counts)
				for (const trap of name === 'random' ? [-1, 0, Math.floor(n / 2), n - 1] : [-1]) {
					const mem = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
					const records = make(n);
					if (trap >= 0 && records[trap]!.input.length === 0)
						records[trap] = { ...records[trap]!, input: new Uint8Array(64) };
					writeRecords(mem, spec, layout, records);
					if (trap >= 0)
						new Uint32Array(mem.buffer, layout.table + 16 * trap, 1)[0] = 0xfffffff0;
					const image = new Uint8Array(mem.buffer).slice();
					const call = callOf(layout, n);
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
	const n = 24;
	const layout = layoutOf(spec, n, Array(n).fill(MAXIN));
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, recordsOf(spec, n));
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
		{ writes: [[call.out, call.out + n * call.slot]] }
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
	const layout = layoutOf(spec, n, Array(n).fill(MAXIN));
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, recordsOf(spec, n));
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
	const slicesMs: Record<number, number[]> = { 1: [], 2: [], 4: [], 8: [] };
	let wrong = 0;
	for (let round = 0; round < rounds; round++) {
		for (let k = 0; k < 2; k++) serialRun(base, image, call, hostMath());
		const t0 = performance.now();
		serialRun(base, image, call, hostMath());
		const serial = performance.now() - t0;
		serialMs.push(serial);
		for (const w of widths) {
			const rig = rigs.get(w)!;
			await slicesRun(rig, booted, call);
			const run = await slicesRun(rig, booted, call);
			if (firstDifference(want, run.bytes, PAGE) !== -1) wrong++;
			slicesMs[w]!.push(run.wallMs!);
			ratios[w]!.push(serial / run.wallMs!);
		}
		emit({
			kind: 'round',
			round,
			load: loadavg()[0],
			serial,
			slices: Object.fromEntries(widths.map((w) => [w, slicesMs[w]!.at(-1)]))
		});
	}
	for (const rig of rigs.values()) await closeSliceRig(rig);
	const summary = {
		kind: 'summary',
		rounds,
		wrong,
		serialMedianMs: median(serialMs),
		slicesMedianMs: Object.fromEntries(widths.map((w) => [w, median(slicesMs[w]!)])),
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
