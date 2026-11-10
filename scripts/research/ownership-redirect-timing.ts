import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { iterationRoute, stackRoute } from '../../src/extract.ts';
import { ownershipRoute, redirectOwnership } from '../../src/ownership-redirect.ts';
import { certifyOwnership } from '../../src/ownership.ts';
import { SlicePool } from '../../src/slices.ts';
import { hostMath, moduleBytes, recordsOf, specOf, writeRecords } from './c21-common.ts';
import { layoutOf } from './c21-kernels.ts';
import { launch, openRig } from './ownership-redirect-rig.ts';

// usage: ownership-redirect-timing.ts run ROUNDS OUT.jsonl | child ARM
// arms: serial, serial-redirected, pool-1, pool-8, sibling-serial, sibling-pool-8, sibling-slices-8
// one fresh process per arm and round, arms interleaved, ratios paired inside a round
const ARMS = [
	'serial',
	'serial-redirected',
	'pool-1',
	'pool-8',
	'sibling-serial',
	'sibling-pool-1',
	'sibling-pool-8',
	'sibling-slices-8'
];
const N = Number(process.env.REDIRECT_N ?? 256);
const WARM = 3;
const PAGE = 65536;

async function child(arm: string) {
	const sibling = arm.startsWith('sibling');
	const spec = specOf(sibling ? 'aes-cbc-decrypt' : 'aes-cbc-decrypt-shared');
	const bytes = moduleBytes(spec);
	const records = recordsOf(spec, N);
	const layout = layoutOf(
		spec,
		N,
		records.map((r) => r.input.length)
	);
	const mem = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
	writeRecords(mem, spec, layout, records);
	const image = new Uint8Array(mem.buffer).slice();
	const args = [layout.table, N, layout.out];
	const outEnd = layout.out + N * spec.slot;
	// the expected output and the window, from the serial program
	const reference = () => {
		const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
		new Uint8Array(memory.buffer).set(image);
		const made = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
			env: { memory, ...hostMath() }
		});
		(made.exports.bulk as (...a: number[]) => void)(...args);
		return new Uint8Array(memory.buffer).slice(layout.out, outEnd);
	};
	const want = reference();
	const same = (view: Uint8Array) =>
		Buffer.compare(Buffer.from(view.subarray(layout.out, outEnd)), Buffer.from(want)) === 0;
	const loadStart = loadavg()[0]!;
	let ms = 0;
	let correct = false;
	let report: unknown;
	if (arm === 'serial' || arm === 'serial-redirected' || arm === 'sibling-serial') {
		let module: Uint8Array = bytes;
		if (arm === 'serial-redirected') {
			const c = certifyOwnership(bytes);
			if (c.kind !== 'certificate') throw new Error('refused');
			module = redirectOwnership(bytes, c).module;
		}
		const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
		new Uint8Array(memory.buffer).set(image);
		const made = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(module)), {
			env: { memory, ...hostMath() }
		});
		const bulk = made.exports.bulk as (...a: number[]) => void;
		for (let i = 0; i < WARM; i++) bulk(...args);
		const t = performance.now();
		bulk(...args);
		ms = performance.now() - t;
		correct = same(new Uint8Array(memory.buffer));
	} else if (arm === 'sibling-slices-8') {
		const memory = new WebAssembly.Memory({
			initial: layout.pages,
			maximum: 65536,
			shared: true
		});
		const pool = await SlicePool.open(bytes, { memory, workers: 8 });
		writeRecords(memory, spec, layout, records);
		const run = () =>
			pool.run('bulk', N, (from, to) => [
				layout.table + 16 * from,
				to - from,
				layout.out + from * spec.slot
			]);
		for (let i = 0; i < WARM; i++) await run();
		const t = performance.now();
		await run();
		ms = performance.now() - t;
		correct = same(new Uint8Array(memory.buffer));
		await pool.close();
	} else {
		const width = Number(arm.split('-').pop());
		const route = sibling
			? iterationRoute(bytes, stackRoute(bytes))
			: (() => {
					const c = certifyOwnership(bytes);
					if (c.kind !== 'certificate') throw new Error('refused');
					return ownershipRoute(bytes, c).route;
				})();
		if (!route.eligible) throw new Error(`route refused ${route.diagnostics.join('; ')}`);
		const rig = await openRig(bytes, route, layout.pages * PAGE, [width], hostMath());
		const call = launch(rig, width, image, args);
		for (let i = 0; i < WARM; i++) call();
		const last = call();
		ms = last.ms;
		report = {
			regions: last.report.regions,
			replayed: last.report.replayed,
			stopped: last.report.stopped,
			conflicts: last.report.conflicts
		};
		correct = same(last.view);
		await rig.pools.get(width)!.close();
	}
	console.log(
		JSON.stringify({ arm, n: N, ms, correct, loadStart, loadEnd: loadavg()[0], report })
	);
	process.exit(0);
}

const median = (values: number[]) => {
	const s = [...values].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

function orchestrate(rounds: number, output: string) {
	writeFileSync(output, '', { flag: 'wx' });
	const samples: Record<string, { ms: number; correct: boolean }[]> = {};
	for (let round = 0; round < rounds; round++) {
		const order = ARMS.map((_, i) => ARMS[(i + round) % ARMS.length]!);
		for (const arm of order) {
			const text = execFileSync(
				process.execPath,
				[new URL(import.meta.url).pathname, 'child', arm],
				{
					encoding: 'utf8',
					env: process.env,
					maxBuffer: 1 << 24
				}
			);
			const row = JSON.parse(text.trim().split('\n').pop()!);
			appendFileSync(output, JSON.stringify({ round, ...row }) + '\n');
			(samples[arm] ??= [])[round] = { ms: row.ms, correct: row.correct };
		}
	}
	const ratio = (num: string, den: string) => {
		const values = Array.from(
			{ length: rounds },
			(_, r) => samples[num]![r]!.ms / samples[den]![r]!.ms
		);
		return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
	};
	const fmt = (r: { median: number; min: number; max: number }) =>
		`${r.median.toFixed(2)} (${r.min.toFixed(2)} to ${r.max.toFixed(2)})`;
	const rows = [
		['speedup pool-8 vs serial', ratio('serial', 'pool-8')],
		['speedup pool-1 vs serial', ratio('serial', 'pool-1')],
		['speedup sibling-pool-8 vs sibling-serial', ratio('sibling-serial', 'sibling-pool-8')],
		['speedup sibling-slices-8 vs sibling-serial', ratio('sibling-serial', 'sibling-slices-8')],
		['cost serial-redirected / serial', ratio('serial-redirected', 'serial')],
		['cost pool-1 / serial', ratio('pool-1', 'serial')],
		['cost sibling-pool-1 / sibling-serial', ratio('sibling-pool-1', 'sibling-serial')],
		['cost pool-1 / sibling-pool-1', ratio('pool-1', 'sibling-pool-1')],
		['serial / sibling-serial', ratio('serial', 'sibling-serial')]
	] as const;
	for (const [name, r] of rows) console.log(name.padEnd(46), fmt(r));
	const wrong = Object.entries(samples).flatMap(([arm, list]) =>
		list.filter((s) => !s.correct).map(() => arm)
	);
	console.log('incorrect samples:', wrong.length ? wrong.join(',') : 'none');
	console.log(
		'median ms:',
		Object.entries(samples)
			.map(([a, l]) => `${a}=${median(l.map((s) => s.ms)).toFixed(1)}`)
			.join(' ')
	);
}

const [verb, a, b] = process.argv.slice(2);
if (verb === 'child') await child(a!);
else if (verb === 'run' && a && b) orchestrate(Number(a), b);
else throw new Error('usage: ownership-redirect-timing.ts run ROUNDS OUT.jsonl | child ARM');
