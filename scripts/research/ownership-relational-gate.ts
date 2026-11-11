import { appendFileSync, writeFileSync } from 'node:fs';
import { redirectOwnership } from '../../src/ownership-redirect.ts';
import { certifyOwnership } from '../../src/ownership.ts';
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

// usage: ownership-relational-gate.ts drivers|control OUT.jsonl [id]
// the one-driver gate of the slice route on a driver the relational domain certifies: widths 1 2 4 8,
// counts 5 24 70, three generators, trapping runs, serial against the in-place route from page 1 up
const [mode, output, idArg] = process.argv.slice(2);
if (!['drivers', 'control'].includes(mode ?? '') || !output)
	throw new Error('usage: ownership-relational-gate.ts drivers|control OUT.jsonl [id]');
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const PAGE = 65536;
const ID = idArg ?? 'jsmn-parse-shared';
const ALPHABET = '{}[]",:  abc0123456789-.\\ntrue';

const generators = (): Record<string, (n: number, spec: (typeof specs)[number]) => Record_[]> => ({
	spec: (n, spec) => recordsOf(spec, n),
	random: (n) => {
		const next = rng(0x2f6b1d5);
		return Array.from({ length: n }, () => ({
			input: Uint8Array.from({ length: 16 + Math.floor(next() * 2000) }, () =>
				ALPHABET.charCodeAt(Math.floor(next() * ALPHABET.length))
			),
			aux: new Uint8Array(0)
		}));
	},
	same: (n, spec) => {
		const one = recordsOf(spec, 1)[0]!;
		return Array.from({ length: n }, () => one);
	}
});

const spec = specs.find((s) => s.id === ID)!;
const bytes = moduleBytes(spec);
const c = certifyOwnership(bytes);
if (c.kind !== 'certificate') throw new Error(`${ID} is refused: ${c.reason} ${c.detail}`);

const callOf = (layout: ReturnType<typeof layoutOf>, n: number): SliceCall => ({
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
	const redirect = redirectOwnership(bytes, c as never);
	emit({
		kind: 'header',
		id: ID,
		windows: (c as { windows: unknown }).windows,
		stats: redirect.stats
	});
	const counts = [5, 24, 70];
	const widths = [1, 2, 4, 8];
	const nmax = Math.max(...counts);
	const layout = layoutOf(spec, nmax, Array(nmax).fill(8192));
	let bad = 0;
	let runs = 0;
	let trapRuns = 0;
	for (const width of widths) {
		const rig = await openSliceRig(bytes, c as never, layout.pages, width);
		for (const [name, make] of Object.entries(generators()))
			for (const n of counts)
				for (const trap of name === 'random' ? [-1, 0, Math.floor(n / 2), n - 1] : [-1]) {
					const mem = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
					writeRecords(mem, spec, layout, make(n, spec));
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
						sameTrap: same,
						serialTrapped: want.error !== undefined,
						replayed: got.report?.replayed,
						refused: got.report?.refused
					});
				}
		await closeSliceRig(rig);
	}
	emit({ kind: 'done', runs, trapRuns, differences: bad });
	console.log(JSON.stringify({ id: ID, runs, trapRuns, differences: bad }));
}

// the same gate with the copy-out ranges emptied; it has to report a difference
async function control() {
	const n = 24;
	const layout = layoutOf(spec, n, Array(n).fill(8192));
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
	console.log(JSON.stringify({ id: ID, control: 'copy-out emptied', firstDifference: at }));
	await pool.close();
}

if (mode === 'drivers') await drivers();
else await control();
process.exit(0);
