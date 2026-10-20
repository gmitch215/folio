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
const count = 64 * 1024 * 1024;
const memory = new WebAssembly.Memory({ initial: 4097, maximum: 8192, shared: true });
const control = new WebAssembly.Instance(new WebAssembly.Module(program.original), {
	env: { memory }
});
const initialize = () => {
	const words = new Uint32Array(memory.buffer, 1024, count);
	for (let i = 0; i < words.length; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
};
const pool = await Folio.open(program, { memory, workers: 4 });
try {
	initialize();
	(control.exports.program as CallableFunction)(1024, count, 1);
	const expected = Uint8Array.from(new Uint8Array(memory.buffer));
	console.log(
		JSON.stringify({
			kind: 'environment',
			node: process.version,
			v8: process.versions.v8,
			cpu: cpus()[0]!.model,
			sha256: encoded.sha256,
			threadIds: pool.threadIds,
			physicalBytes: memory.buffer.byteLength,
			activeBytes: count * 4
		})
	);
	for (let round = -2; round < 7; round++) {
		for (const arm of round % 2 === 0 ? ['native', 'four'] : ['four', 'native']) {
			initialize();
			const cpuStart = process.cpuUsage();
			const start = performance.now();
			let report;
			if (arm === 'native') (control.exports.program as CallableFunction)(1024, count, 1);
			else report = await pool.run('program', [1024, count, 1]);
			const wallMs = performance.now() - start;
			const cpu = process.cpuUsage(cpuStart);
			assert.equal(
				Buffer.compare(Buffer.from(memory.buffer), Buffer.from(expected.buffer)),
				0
			);
			if (arm === 'four') assert.equal(report!.mode, 'native-shared');
			if (round >= 0)
				console.log(
					JSON.stringify({
						kind: 'sample',
						round,
						arm,
						wallMs,
						cpuMs: (cpu.user + cpu.system) / 1000,
						passed: true,
						fullWordsVerified: count,
						report,
						rss: process.memoryUsage().rss,
						load: loadavg()
					})
				);
		}
	}
} finally {
	await pool.close();
}
