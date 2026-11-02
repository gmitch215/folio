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
	for (const kind of kinds) locals[kind] = await startLocal({}, kind, true);
});
afterAll(() => Promise.all(kinds.map((kind) => locals[kind]?.dispose())));

function oracle(arena: number) {
	const memory = new WebAssembly.Memory({
		initial: arena / 65536,
		maximum: MAX_PAGES,
		shared: true
	});
	const bytes = new Uint8Array(memory.buffer);
	const tools = helpers(build('helpers'), memory);
	fillArena(tools, bytes, 'random');
	seedPartitions(bytes);
	const main = new WebAssembly.Instance(build('original'), { env: { memory } }).exports
		.main as CallableFunction;
	const value = main(BASE, 4, 2);
	return { value, bytes, digest: hex(tools.digest(0, arena)) };
}

for (const kind of kinds) {
	test(`inline-tracked lanes over ${kind} lanes match a serial run exactly in both arms`, async () => {
		const local = locals[kind];
		for (const arena of [131072, 1048576]) {
			const expected = oracle(arena);
			for (const [arm, cache] of [
				['snapshot', 'cold'],
				['ranges', 'cold'],
				['ranges', 'warm']
			] as const) {
				await local.prepare(arena, 'random');
				const result = await local.call({ arm, arena, fill: 'random', cache });
				assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 400));
				assert.equal(result.body.value, expected.value, `${arm} ${cache}`);
				assert.equal(result.body.digest, expected.digest, `${arm} ${cache}`);
				assert.equal(
					Buffer.compare(await local.memory(), expected.bytes),
					0,
					`${arm} ${cache}`
				);
				assert.equal(result.body.report.regions, 16);
				assert.equal(result.body.report.transportFallbacks, 0);
				assert.equal(result.body.meter.failures.length, 0);
			}
		}
	});
}
