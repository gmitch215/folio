import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, test } from 'vitest';
import {
	BASE,
	fillArena,
	helpers,
	hex,
	MAX_PAGES,
	seedPartitions
} from '../../experiments/ranges/layout.ts';
import { startLocal } from '../../experiments/ranges/local.ts';
import type { Lanes } from '../../experiments/ranges/plan.ts';

type Local = Awaited<ReturnType<typeof startLocal>>;
const kinds: Lanes[] = ['worker', 'do'];
const locals = {} as Record<Lanes, Local>;
const build = (name: string) =>
	new WebAssembly.Module(
		readFileSync(new URL(`../../experiments/ranges/build/${name}.wasm`, import.meta.url))
	);

beforeAll(async () => {
	execFileSync(process.execPath, ['experiments/ranges/prepare.ts'], { stdio: 'pipe' });
	for (const kind of kinds) locals[kind] = await startLocal({}, kind);
});
afterAll(() => Promise.all(kinds.map((kind) => locals[kind]?.dispose())));

// serial native run of the same program over the same arena, outside any worker
function oracle(arena: number, fill: 'zero' | 'random', waves = 4, rounds = 2) {
	const memory = new WebAssembly.Memory({
		initial: arena / 65536,
		maximum: MAX_PAGES,
		shared: true
	});
	const bytes = new Uint8Array(memory.buffer);
	const tools = helpers(build('helpers'), memory);
	fillArena(tools, bytes, fill);
	seedPartitions(bytes);
	const main = new WebAssembly.Instance(build('original'), { env: { memory } }).exports
		.main as CallableFunction;
	const value = main(BASE, waves, rounds);
	return { value, bytes, digest: hex(tools.digest(0, arena)) };
}

async function exact(
	target: Local,
	arm: 'snapshot' | 'ranges',
	arena: number,
	fill: 'zero' | 'random',
	cache: 'cold' | 'warm' = 'cold'
) {
	const expected = oracle(arena, fill);
	await target.prepare(arena, fill);
	const result = await target.call({ arm, arena, fill, cache });
	assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 400));
	assert.equal(result.body.value, expected.value);
	assert.equal(result.body.digest, expected.digest);
	assert.equal(Buffer.compare(await target.memory(), expected.bytes), 0, 'memory differs');
	return result.body;
}

for (const kind of kinds) {
	test(`ranges and snapshot over ${kind} lanes match a serial run exactly`, async () => {
		const local = locals[kind];
		for (const arena of [131072, 1048576, 8388608]) {
			const snapshot = await exact(local, 'snapshot', arena, 'zero');
			const cold = await exact(local, 'ranges', arena, 'zero');
			const warm = await exact(local, 'ranges', arena, 'zero', 'warm');
			for (const body of [snapshot, cold, warm]) {
				assert.equal(body.lanes, kind);
				assert.equal(body.report.regions, 16);
				assert.equal(body.report.transportFallbacks, 0);
				assert.equal(body.meter.failures.length, 0);
				// the transport's own count agrees with the report
				assert.equal(body.meter.bytesOut, body.report.transportBytes.sent);
				assert.equal(body.meter.bytesIn, body.report.transportBytes.received);
			}
			assert.equal(snapshot.meter.calls, 16);
			assert.equal(cold.meter.calls, 20);
			assert.equal(cold.report.escapeRounds, 4);
			assert.equal(warm.meter.calls, 16);
			assert.equal(warm.report.escapeRounds, 0);
			assert.equal(warm.report.footprintHits, 16);
			assert.ok(warm.meter.bytesOut < snapshot.meter.bytesOut);
			if (arena === 8388608) {
				assert.ok(cold.meter.bytesOut <= snapshot.meter.bytesOut * 0.05);
				assert.ok(warm.meter.bytesOut <= snapshot.meter.bytesOut * 0.05);
			}
		}
	}, 120000);

	test(`a nonzero arena gives the same exact result and bytes sent over ${kind} lanes`, async () => {
		const local = locals[kind];
		const zero = await exact(local, 'ranges', 1048576, 'zero');
		const random = await exact(local, 'ranges', 1048576, 'random');
		assert.equal(random.meter.bytesOut, zero.meter.bytesOut);
		await exact(local, 'snapshot', 1048576, 'random');
	}, 60000);

	test(`a ${kind} lane that throws or returns a malformed frame ends in an exact serial result`, async () => {
		for (const fault of ['throw', 'malformed']) {
			const broken = await startLocal({ 2: fault }, kind);
			try {
				for (const arm of ['ranges', 'snapshot'] as const) {
					const body = await exact(broken, arm, 1048576, 'zero');
					// lane 2 serves one region a wave, so every wave falls back once
					assert.equal(body.report.transportFallbacks, 4, `${fault} ${arm}`);
					assert.ok(body.diagnostics.length > 0);
					if (fault === 'throw')
						assert.ok(body.meter.failures.every((row: any) => row.lane === 1));
				}
			} finally {
				await broken.dispose();
			}
		}
	}, 120000);
}
