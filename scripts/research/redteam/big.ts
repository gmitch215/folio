import { readFileSync, writeFileSync } from 'node:fs';
import { predictEnd } from '../../../src/affine.ts';
import { moduleBytes, runLoop, runStream, type Row } from './lib.ts';

// lengths above 2^20: every accepted module at 1048576 bytes (the whole 2 MiB memory above the 1 MiB offset)
const dir = process.argv[2];
if (!dir) throw new Error('usage: big.ts DIRECTORY');
const rows: Row[] = JSON.parse(readFileSync(`${dir}/modules.json`, 'utf8'));
const N = 1048576;
let checked = 0;
let failures = 0;
const start = Date.now();
for (const r of rows) {
	for (const k of ['stream', 'loop'] as const) {
		if (!r[k].accepted) continue;
		const bytes = moduleBytes(dir, r.id);
		const verdict = k === 'stream' ? runStream(bytes) : runLoop(bytes);
		const inst = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)));
		const memory = inst.exports.memory as WebAssembly.Memory;
		const need = 1048576 + N - memory.buffer.byteLength;
		if (need > 0) memory.grow(Math.ceil(need / 65536));
		const heap = new Uint8Array(memory.buffer);
		for (let i = 0; i < N; i++)
			heap[1048576 + i] = (Math.imul(i, 2654435761) ^ (i >>> 8)) & 255;
		const update = inst.exports.update as Function;
		const call = (s: number, at: number, n: number) => update(s | 0, 1048576 + at, n) >>> 0;
		const s = 0x80000000;
		const whole = call(s, 0, N);
		const cut = Math.floor(N / 3);
		const chain = call(call(s, 0, cut), cut, N - cut);
		const half = N / 2;
		const model = predictEnd(verdict.model!, BigInt(s), half, BigInt(call(0, 0, half)));
		const combined = predictEnd(
			verdict.model!,
			model,
			N - half,
			BigInt(call(0, half, N - half))
		);
		checked++;
		if (chain !== whole || combined !== BigInt(whole)) {
			failures++;
			console.log('FAIL', r.id, k, whole, chain, combined);
		}
	}
}
const result = { length: N, checked, failures };
writeFileSync(`${dir}/big.json`, JSON.stringify(result, null, 1), { flag: 'wx' });
console.log({ ...result, ms: Date.now() - start });
