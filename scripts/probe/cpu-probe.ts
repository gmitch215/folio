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
const makeMemory = () => new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const nativeMemory = makeMemory(),
	twoMemory = makeMemory(),
	fourMemory = makeMemory();
const instance = new WebAssembly.Instance(new WebAssembly.Module(program.original), {
	env: { memory: nativeMemory }
});
const two = await Folio.open(program, { memory: twoMemory, workers: 2 });
const four = await Folio.open(program, { memory: fourMemory, workers: 4 });
const cases = [
	{ name: 'tiny', count: 16, rounds: 4 },
	{ name: 'stream', count: 4096, rounds: 1 },
	{ name: 'compute', count: 1024, rounds: 32768 }
];
const arms = ['native', 'serial-api', 'two', 'four', 'spec-four'];
function initialize(memory: WebAssembly.Memory, count: number) {
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
			threadIds: [two.threadIds, four.threadIds],
			sha256: encoded.sha256,
			arms
		})
	);
	for (const item of cases) {
		initialize(nativeMemory, item.count);
		(instance.exports.program as CallableFunction)(1024, item.count, item.rounds);
		const expected = Uint8Array.from(new Uint8Array(nativeMemory.buffer));
		for (let round = -2; round < 7; round++) {
			for (let turn = 0; turn < arms.length; turn++) {
				const arm = arms[(turn + round + 2) % arms.length]!;
				const memory =
					arm === 'two'
						? twoMemory
						: arm === 'four' || arm === 'spec-four' || arm === 'serial-api'
							? fourMemory
							: nativeMemory;
				initialize(memory, item.count);
				const cpuStart = process.cpuUsage();
				const start = performance.now();
				let report;
				if (arm === 'native')
					(instance.exports.program as CallableFunction)(1024, item.count, item.rounds);
				else
					report = await (arm === 'two' ? two : four).run(
						'program',
						[1024, item.count, item.rounds],
						{
							parallel:
								arm === 'serial-api'
									? 'off'
									: arm === 'spec-four'
										? 'speculate'
										: 'auto'
						}
					);
				const wallMs = performance.now() - start;
				const cpu = process.cpuUsage(cpuStart);
				const resultMemory = arm === 'serial-api' ? fourMemory : memory;
				assert.deepEqual(new Uint8Array(resultMemory.buffer), expected);
				if (arm === 'two' || arm === 'four' || arm === 'spec-four') {
					assert.equal(report!.replayed, 0);
					assert.equal(report!.fallbacks, 0);
				}
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
							report,
							load: loadavg()
						})
					);
			}
		}
	}
} finally {
	await two.close();
	await four.close();
}
