import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certifyStream, type StreamCertificate } from '../../../../src/certify.ts';
import type { Row, Rec } from './lib.ts';

// pointers against the top of a 4 GiB memory, and lengths of 2^30 and 2^31 at pointer zero, for the
// accepted modules that declare a 4 GiB maximum. usage: bigcheck.ts MANIFEST SHARD COUNT MODE
// MODE ptr: pointer at the end of memory (cheap); MODE len: lengths over 2^30 (one module at a time)
const here = dirname(fileURLToPath(import.meta.url));
const [manifest, shardArg, countArg, mode] = process.argv.slice(2);
const recs = readFileSync(join(here, manifest!), 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l) as Rec & { sha: string });
const done = new Map<string, Row>();
for (const f of readdirSync(join(here, 'results')))
	if (f.endsWith('.jsonl') && !f.startsWith('big'))
		for (const l of readFileSync(join(here, 'results', f), 'utf8').split('\n'))
			if (l) {
				const r = JSON.parse(l) as Row;
				done.set(r.sha256, r);
			}
const PAGE = 65536;
const probe = Uint8Array.from({ length: 300 }, (_, k) => (Math.imul(k + 3, 2654435761) >>> 9) & 255);
let n = 0;
for (const [i, rec] of recs.entries()) {
	if (i % Number(countArg) !== Number(shardArg)) continue;
	const row = done.get(rec.sha);
	if (!row || row.checker !== 'accepted' || !/-4g$/.test(rec.id.replace(/\/\d+-/, '/'))) continue;
	if (process.env.ONLY && !new RegExp(process.env.ONLY).test(rec.id)) continue;
	if (process.env.MAX && n >= Number(process.env.MAX)) break;
	const bytes = new Uint8Array(readFileSync(rec.file));
	const cert = certifyStream(bytes, 'update') as StreamCertificate;
	if (cert.kind !== 'certificate') continue;
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	const make = (pages: number) => {
		const inst = new WebAssembly.Instance(mod, {});
		const mem = inst.exports.memory as WebAssembly.Memory;
		mem.grow(pages - mem.buffer.byteLength / PAGE);
		const fn = inst.exports.update as (a: number, b: number, c: number) => number;
		return { mem, fn };
	};
	let verdict = 'ok';
	const state = 0x9e3779b9 | 0;
	try {
		if (mode === 'ptr') {
			const top = make(65536);
			for (const len of [1, 2, 3, 16, 17, 100]) {
				const ref = make(40);
				new Uint8Array(ref.mem.buffer, 1 << 20, len).set(probe.subarray(0, len));
				const want = ref.fn(state, 1 << 20, len) >>> 0;
				const at = 2 ** 32 - len;
				new Uint8Array(top.mem.buffer, at, len).set(probe.subarray(0, len));
				let got: number;
				try {
					got = top.fn(state, at | 0, len) >>> 0;
				} catch (e) {
					verdict = `FALSE trap at top pointer len ${len}: ${String(e).slice(0, 60)}`;
					break;
				}
				if (got !== want) {
					verdict = `FALSE top pointer len ${len}: got ${got} want ${want}`;
					break;
				}
			}
		} else {
			const pages = 32769;
			const w = make(pages);
			const len = 2 ** 31;
			const t = Date.now();
			const whole = w.fn(state, 0, len) >>> 0;
			const c = make(pages);
			const mid = c.fn(state, 0, 1);
			const chain = c.fn(mid, 1, len - 1) >>> 0;
			verdict = whole === chain ? `ok ${Date.now() - t} ms` : `FALSE 2^31 whole ${whole} chain ${chain}`;
		}
	} catch (e) {
		verdict = `harness ${String(e).slice(0, 100)}`;
	}
	n++;
	console.log(JSON.stringify({ id: rec.id, sha: rec.sha.slice(0, 16), ring: cert.ring, mode, verdict }));
}
console.log('checked', n);
