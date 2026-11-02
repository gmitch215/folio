// paired overhead of the stall guard: the same kernel with the stop poll off and on, interleaved
// usage: stall-overhead.ts NAME MODULE.wasm ENTRY INPUTS BYTES_PER_INPUT WIDTH ROUNDS > rows.jsonl
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { prepare } from '../../src/compiler.ts';
import { fit, generate, iterationRun, openRig, serialRun } from './iteration-diff.ts';

const PAGE = 65536;
const align = (value: number, to: number) => Math.ceil(value / to) * to;
const [name, wasmPath, entry, inputsArg, sizeArg, widthArg, roundsArg] = process.argv.slice(2);
const inputs = Number(inputsArg);
const size = Number(sizeArg);
const width = Number(widthArg);
const rounds = Number(roundsArg);
const bytes = new Uint8Array(readFileSync(wasmPath!));
const route = prepare(bytes).iterationRoute!;
if (!route.eligible) throw new Error(route.diagnostics.join('; '));
const sizes = Array.from({ length: inputs }, () => size);
const table = 0x11000;
const out = table + align(8 * inputs, 64) + 64;
let at = align(out + 32 * inputs, 64) + 64;
const offsets = sizes.map((s) => {
	const offset = at;
	at = align(at + s, 64) + 64;
	return offset;
});
const arenaOptions = { frameBytes: route.frame?.size };
const { pages, arenaBase, arenaEnd } = fit(at, arenaOptions);
const open = (stall: boolean) =>
	openRig(bytes, route, entry!, { pages, maximum: 65536, arenaBase, arenaEnd }, [width], {
		...(stall ? { stall: true } : {})
	} as any);
const off = await open(false);
const on = await open(true);
const image = new Uint8Array(pages * PAGE);
const view = new DataView(image.buffer);
sizes.forEach((s, i) => {
	image.set(generate(i, s), offsets[i]!);
	view.setUint32(table + 8 * i, offsets[i]!, true);
	view.setUint32(table + 8 * i + 4, s, true);
});
const args = [table, inputs, out];
const want = serialRun(off, image, args);
const digest = (b: Uint8Array) =>
	createHash('sha256')
		.update(b.subarray(out, out + 32 * inputs))
		.digest('hex');
const rows: any[] = [];
for (let round = 0; round < rounds + 1; round++) {
	for (const [arm, rig] of round % 2
		? ([
				['on', on],
				['off', off]
			] as const)
		: ([
				['off', off],
				['on', on]
			] as const)) {
		const t0 = performance.now();
		const run = iterationRun(rig, width, image, args);
		const wall = performance.now() - t0;
		if (round === 0) continue;
		rows.push({
			kernel: name,
			arm,
			round,
			wallMs: wall,
			workerRunMs: run.report!.workerRunMs,
			dispatchMs: run.report!.dispatchMs,
			replayed: run.report!.replayed,
			regions: run.report!.regions,
			stalls: run.report!.stalls,
			error: run.error ? String(run.error) : undefined,
			equal: digest(run.bytes) === digest(want.bytes),
			load: loadavg()[0]
		});
	}
}
await off.close();
await on.close();
for (const r of rows) console.log(JSON.stringify(r));
