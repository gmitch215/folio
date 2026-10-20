import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { Folio } from '../../src/node.ts';

const encoded = JSON.parse(
	readFileSync(new URL('../../build/probe.json', import.meta.url), 'utf8')
);
const program = {
	...encoded,
	original: Buffer.from(encoded.original, 'base64'),
	transactional: Buffer.from(encoded.transactional, 'base64')
};
const memory = new WebAssembly.Memory({ initial: 4097, maximum: 8192, shared: true });
const control = new WebAssembly.Instance(new WebAssembly.Module(program.original), {
	env: { memory }
});
const pools = new Map<number, Folio>();
for (const workers of [1, 2, 4, 8])
	pools.set(workers, await Folio.open(program, { memory, workers, profile: true }));
const cases = [
	{ name: 'tiny', count: 16, rounds: 4 },
	{ name: 'stream-small', count: 4096, rounds: 1 },
	{ name: 'compute', count: 4096, rounds: 32768 },
	{ name: 'arena256', count: 64 * 1024 * 1024, rounds: 1 }
];
function initialize(count: number) {
	new Uint8Array(memory.buffer).fill(0);
	const words = new Uint32Array(memory.buffer, 1024, count);
	for (let i = 0; i < count; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
}
try {
	console.log(
		JSON.stringify({
			kind: 'environment',
			node: process.version,
			v8: process.versions.v8,
			cpu: cpus()[0]!.model,
			sha256: encoded.sha256,
			physicalBytes: memory.buffer.byteLength,
			threadIds: [...pools].map(([workers, pool]) => ({ workers, ids: pool.threadIds })),
			affinity: readFileSync('/proc/self/status', 'utf8')
				.split('\n')
				.filter((line) => line.startsWith('Cpus_allowed_list:'))
		})
	);
	for (const item of cases) {
		initialize(item.count);
		(control.exports.program as CallableFunction)(1024, item.count, item.rounds);
		const expected = Uint8Array.from(new Uint8Array(memory.buffer));
		const arms = [
			'raw',
			'one',
			'two',
			'four',
			'eight',
			...(item.name === 'arena256' ? [] : ['tracked-four'])
		];
		for (let round = -2; round < 9; round++) {
			for (let turn = 0; turn < arms.length; turn++) {
				const arm = arms[(turn + round + 2) % arms.length]!;
				initialize(item.count);
				const cpuStart = process.cpuUsage();
				const start = performance.now();
				let report;
				if (arm === 'raw')
					(control.exports.program as CallableFunction)(1024, item.count, item.rounds);
				else
					report = await pools
						.get(arm === 'one' ? 1 : arm === 'two' ? 2 : arm === 'eight' ? 8 : 4)!
						.run('program', [1024, item.count, item.rounds], {
							parallel: arm === 'tracked-four' ? 'speculate' : 'auto'
						});
				const wallMs = performance.now() - start;
				const cpu = process.cpuUsage(cpuStart);
				assert.equal(
					Buffer.compare(Buffer.from(memory.buffer), Buffer.from(expected.buffer)),
					0
				);
				if (
					['compute', 'arena256'].includes(item.name) &&
					['two', 'four', 'eight'].includes(arm)
				)
					assert.equal(report!.mode, 'native-shared');
				if (round >= 0)
					console.log(
						JSON.stringify({
							kind: 'sample',
							...item,
							arm,
							round,
							wallMs,
							cpuMs: (cpu.user + cpu.system) / 1000,
							passed: true,
							verifiedBytes: expected.length,
							report,
							rss: process.memoryUsage().rss,
							load: loadavg()
						})
					);
			}
		}
	}
} finally {
	for (const pool of pools.values()) await pool.close();
}
