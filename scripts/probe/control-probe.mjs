import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { Folio } from '../../dist/node.js';

const program = JSON.parse(
	readFileSync(new URL('../../build/control-prepared.json', import.meta.url)),
	(_, value) =>
		value?.folioBytes ? Uint8Array.from(Buffer.from(value.folioBytes, 'base64')) : value
);
const pages = Number(process.env.FOLIO_PAGES ?? 4097);
const count = Number(process.env.FOLIO_COUNT ?? 64);
const rounds = Number(process.env.FOLIO_ROUNDS ?? 2097152);
const repeats = Number(process.env.FOLIO_REPEATS ?? 7);
const makeMemory = () => new WebAssembly.Memory({ initial: pages, maximum: 8192, shared: true });
const oracleMemory = makeMemory();
const oracle = new WebAssembly.Instance(new WebAssembly.Module(program.original), {
	env: { memory: oracleMemory }
});
const pools = [];
const arms = [
	{
		name: 'raw',
		workers: 0,
		memory: oracleMemory,
		invoke: () => oracle.exports.main(1024, count, rounds)
	}
];
for (const width of [1, 2, 4, 8]) {
	const memory = makeMemory();
	const pool = await Folio.open(program, { memory, workers: width, profile: true });
	pools.push(pool);
	arms.push({
		name: `auto-${width}`,
		workers: width,
		memory,
		invoke: () => pool.run('main', [1024, count, rounds])
	});
}
const initialize = (memory) => {
	new Uint8Array(memory.buffer).fill(0);
	const view = new Uint32Array(memory.buffer, 1024, count);
	for (let i = 0; i < count; i++) view[i] = Math.imul(i + 1, 2654435761) >>> 0;
};
initialize(oracleMemory);
const expectedValue = oracle.exports.main(1024, count, rounds);
const expected = Uint8Array.from(new Uint8Array(oracleMemory.buffer));
console.log(
	JSON.stringify({
		metadata: {
			node: process.version,
			v8: process.versions.v8,
			model: cpus()[0].model,
			sourceSha256: createHash('sha256').update(program.original).digest('hex'),
			pages,
			count,
			rounds,
			repeats,
			warmups: 2,
			checkedBytes: expected.length,
			newPath: 'numeric-result branching controller; automatic inlined-loop outlining',
			batchLimit: '16 regions per worker',
			flags: 'see scripts/build/fixtures.ts'
		}
	})
);
try {
	for (let iteration = -2; iteration < repeats; iteration++) {
		const shift = (iteration + 2) % arms.length;
		const order = [...arms.slice(shift), ...arms.slice(0, shift)];
		for (const arm of order) {
			initialize(arm.memory);
			const load = loadavg();
			const cpuStart = process.cpuUsage();
			const started = performance.now();
			const result = await arm.invoke();
			const wallMs = performance.now() - started;
			const cpu = process.cpuUsage(cpuStart);
			const value = arm.name === 'raw' ? result : result.values[0];
			assert.equal(value, expectedValue);
			assert.deepEqual(new Uint8Array(arm.memory.buffer), expected);
			if (arm.workers > 1) {
				assert.equal(result.extraction, 'control-flow');
				assert.equal(result.workers, arm.workers);
				assert.equal(result.regions, count);
				assert.equal(result.replayed, 0);
				assert.equal(result.fallbacks, 0);
			}
			console.log(
				JSON.stringify({
					iteration,
					arm: arm.name,
					wallMs,
					cpuMs: (cpu.user + cpu.system) / 1000,
					load,
					freeMiB: freemem() / 1048576,
					rssMiB: process.memoryUsage().rss / 1048576,
					exact: true,
					...(arm.name === 'raw' ? {} : { report: result })
				})
			);
		}
	}
} finally {
	await Promise.all(pools.map((pool) => pool.close()));
}
