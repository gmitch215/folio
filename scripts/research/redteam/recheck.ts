import { readFileSync, writeFileSync } from 'node:fs';
import { predictEnd } from '../../../src/affine.ts';
import { moduleBytes, runLoop, runStream, type Row } from './lib.ts';

// second ground truth for accepted modules: every byte value, random states, odd addresses, short lengths
const dir = process.argv[2];
if (!dir) throw new Error('usage: recheck.ts DIRECTORY');
const rows: Row[] = JSON.parse(readFileSync(`${dir}/modules.json`, 'utf8'));
let seed = 0xc0ffee;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const out: { id: string; checker: string; failure: string }[] = [];
let checked = 0;
let accepted = 0;
for (const r of rows) {
	for (const k of ['stream', 'loop'] as const) {
		if (!r[k].accepted) continue;
		accepted++;
		const bytes = moduleBytes(dir, r.id);
		const verdict = k === 'stream' ? runStream(bytes) : runLoop(bytes);
		const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)));
		const memory = instance.exports.memory as WebAssembly.Memory;
		memory.grow(32);
		const heap = new Uint8Array(memory.buffer);
		const update = instance.exports.update as Function;
		const call = (s: number, at: number, n: number) => update(s | 0, at, n) >>> 0;
		let failure = '';
		const test = (s: number, at: number, n: number, data: number[]) => {
			heap.set(data, at);
			const whole = call(s, at, n);
			const offset = call(0, at, n);
			const predicted = predictEnd(verdict.model!, BigInt(s >>> 0), n, BigInt(offset));
			if (predicted !== BigInt(whole) && !failure)
				failure = `n ${n} state ${s >>> 0} at ${at} data ${data.join(',')} whole ${whole} predicted ${predicted}`;
			if (n > 1 && !failure) {
				const cut = 1 + (rnd() % (n - 1));
				const chain = call(call(s, at, cut), at + cut, n - cut);
				if (chain !== whole)
					failure = `chain n ${n} cut ${cut} state ${s >>> 0} at ${at} data ${data.join(',')} whole ${whole} chain ${chain}`;
			}
			checked++;
		};
		const states = [0, 1, 0x80000000, 0xffffffff, ...Array.from({ length: 24 }, rnd)];
		for (let b = 0; b < 256; b++)
			for (const s of states) test(s, 1048576 + (rnd() % 9), 1, [b]);
		for (let t = 0; t < 1500; t++) {
			const n = 2 + (rnd() % 14);
			test(
				rnd(),
				1048576 + (rnd() % 17),
				n,
				Array.from({ length: n }, () => rnd() & 255)
			);
		}
		out.push({ id: r.id, checker: k, failure });
	}
}
writeFileSync(`${dir}/recheck.json`, JSON.stringify(out, null, 1), { flag: 'wx' });
console.log(
	'accepted',
	accepted,
	'calls-compared',
	checked,
	'failures',
	out.filter((o) => o.failure).length
);
for (const o of out) if (o.failure) console.log(o.id, o.checker, o.failure);
