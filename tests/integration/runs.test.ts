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
const setups = [
	{ kind: 'worker', inline: true, label: 'inline-tracked worker lanes' },
	{ kind: 'do', inline: true, label: 'inline-tracked Durable Object lanes' },
	{ kind: 'worker', inline: false, label: 'callout worker lanes' }
] as { kind: Lanes; inline: boolean; label: string }[];
const locals = new Map<string, { runs: Local; addresses: Local }>();
const build = (name: string) =>
	new WebAssembly.Module(
		readFileSync(new URL(`../../experiments/ranges/build/${name}.wasm`, import.meta.url))
	);

beforeAll(async () => {
	execFileSync(process.execPath, ['experiments/ranges/prepare.ts'], { stdio: 'pipe' });
	for (const { kind, inline, label } of setups)
		locals.set(label, {
			runs: await startLocal({}, kind, inline, true),
			addresses: await startLocal({}, kind, inline, false)
		});
});
afterAll(() =>
	Promise.all(
		[...locals.values()].flatMap((pair) => [pair.runs.dispose(), pair.addresses.dispose()])
	)
);

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

for (const { label } of setups) {
	test(`run-encoded results over ${label} match a serial run exactly and carry fewer bytes`, async () => {
		const { runs, addresses } = locals.get(label)!;
		const arena = 131072;
		const expected = oracle(arena);
		for (const [arm, cache] of [
			['snapshot', 'cold'],
			['ranges', 'cold'],
			['ranges', 'warm']
		] as const) {
			const received: Record<string, number> = {};
			for (const [name, local] of [
				['runs', runs],
				['addresses', addresses]
			] as const) {
				await local.prepare(arena, 'random');
				const result = await local.call({ arm, arena, fill: 'random', cache });
				assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 400));
				assert.equal(result.body.value, expected.value, `${name} ${arm} ${cache}`);
				assert.equal(result.body.digest, expected.digest, `${name} ${arm} ${cache}`);
				assert.equal(
					Buffer.compare(await local.memory(), expected.bytes),
					0,
					`${name} ${arm} ${cache}`
				);
				assert.equal(result.body.report.regions, 16);
				assert.equal(result.body.report.transportFallbacks, 0);
				assert.equal(result.body.meter.failures.length, 0);
				if (name === 'runs') {
					assert.equal(result.body.report.runReplies.addresses, 0);
					assert.ok(result.body.report.runReplies.runs > 0);
				} else assert.equal(result.body.report.runReplies, undefined);
				received[name] = result.body.report.transportBytes.received;
			}
			assert.ok(
				received.runs! < received.addresses!,
				`${arm} ${cache}: ${JSON.stringify(received)}`
			);
		}
	});
}
