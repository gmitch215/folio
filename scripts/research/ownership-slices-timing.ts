import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { redirectOwnership } from '../../src/ownership-redirect.ts';
import { certifyOwnership } from '../../src/ownership.ts';
import { SlicePool } from '../../src/slices.ts';
import { hostMath, moduleBytes, recordsOf, specOf, writeRecords } from './c21-common.ts';
import { layoutOf } from './c21-kernels.ts';
import { bootedImage, closeSliceRig, openSliceRig, slicesRun } from './ownership-slices-rig.ts';

// usage: ownership-slices-timing.ts run ROUNDS OUT.jsonl | child ARM
// arms: serial, serial-redirected, slices-1, slices-2, slices-4, slices-8, sibling-serial, sibling-slices-8
// one fresh process per arm and round, arms interleaved and rotated, ratios paired inside a round
const ARMS = [
	'serial',
	'serial-redirected',
	'slices-1',
	'slices-2',
	'slices-4',
	'slices-8',
	'sibling-serial',
	'sibling-slices-8'
];
const N = Number(process.env.SLICES_N ?? 256);
const WARM = 3;

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
	const serialMemory = (module: Uint8Array) => {
		const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
		new Uint8Array(memory.buffer).set(image);
		const made = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(module)), {
			env: { memory, ...hostMath() }
		});
		return { memory, bulk: made.exports.bulk as (...a: number[]) => void };
	};
	const want = (() => {
		const { memory, bulk } = serialMemory(bytes);
		bulk(...args);
		return new Uint8Array(memory.buffer).slice(layout.out, outEnd);
	})();
	const same = (view: Uint8Array) =>
		Buffer.compare(Buffer.from(view.subarray(layout.out, outEnd)), Buffer.from(want)) === 0;
	const loadStart = loadavg()[0]!;
	let ms = 0;
	let correct = false;
	let detail: unknown;
	if (arm === 'serial' || arm === 'serial-redirected' || arm === 'sibling-serial') {
		let module: Uint8Array = bytes;
		if (arm === 'serial-redirected') {
			const c = certifyOwnership(bytes);
			if (c.kind !== 'certificate') throw new Error('refused');
			module = redirectOwnership(bytes, c).module;
		}
		const { memory, bulk } = serialMemory(module);
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
		ms = (await run()).wallMs;
		correct = same(new Uint8Array(memory.buffer));
		await pool.close();
	} else {
		const width = Number(arm.split('-').pop());
		const c = certifyOwnership(bytes);
		if (c.kind !== 'certificate') throw new Error('refused');
		const rig = await openSliceRig(bytes, c, layout.pages, width);
		const booted = bootedImage(rig, image, hostMath());
		const call = {
			table: layout.table,
			n: N,
			out: layout.out,
			slot: spec.slot,
			regions: [
				[layout.table, layout.table + 16 * N],
				[layout.aux, layout.aux + N * spec.auxBytes],
				[layout.out, outEnd],
				[layout.data, layout.end]
			] as [number, number][]
		};
		let last;
		for (let i = 0; i <= WARM; i++) last = await slicesRun(rig, booted, call);
		const report = last!.report!;
		ms = last!.wallMs!;
		correct = last!.error === undefined && same(last!.bytes);
		const spans = report.tasks.map((t) => t.endMs - t.startMs);
		detail = {
			replayed: report.replayed,
			snapshotBytes: report.snapshotBytes,
			snapshotMs: report.snapshotMs,
			copyOutMs: report.copyOutMs,
			taskMs: spans,
			taskWaitMs: report.tasks.map((t) => t.waitMs),
			taskCpuMs: report.tasks.map((t) => t.cpuMs)
		};
		await closeSliceRig(rig);
	}
	console.log(
		JSON.stringify({ arm, n: N, ms, correct, loadStart, loadEnd: loadavg()[0], detail })
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
				{ encoding: 'utf8', env: process.env, maxBuffer: 1 << 24 }
			);
			const row = JSON.parse(text.trim().split('\n').pop()!);
			appendFileSync(output, JSON.stringify({ round, ...row }) + '\n');
			(samples[arm] ??= [])[round] = { ms: row.ms, correct: row.correct };
		}
	}
	const pairs = (num: string, den: string) =>
		Array.from({ length: rounds }, (_, r) => samples[num]![r]!.ms / samples[den]![r]!.ms);
	const fmt = (values: number[]) =>
		`${median(values).toFixed(2)} (${Math.min(...values).toFixed(2)} to ${Math.max(...values).toFixed(2)})`;
	const rows: [string, string, string][] = [
		['speedup slices-1 vs serial', 'serial', 'slices-1'],
		['speedup slices-2 vs serial', 'serial', 'slices-2'],
		['speedup slices-4 vs serial', 'serial', 'slices-4'],
		['speedup slices-8 vs serial', 'serial', 'slices-8'],
		['speedup sibling-slices-8 vs sibling-serial', 'sibling-serial', 'sibling-slices-8'],
		['time ratio serial-redirected / serial', 'serial-redirected', 'serial'],
		['time ratio slices-8 / sibling-slices-8', 'slices-8', 'sibling-slices-8'],
		['time ratio serial / sibling-serial', 'serial', 'sibling-serial']
	];
	for (const [name, num, den] of rows) console.log(name.padEnd(46), fmt(pairs(num, den)));
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
else throw new Error('usage: ownership-slices-timing.ts run ROUNDS OUT.jsonl | child ARM');
