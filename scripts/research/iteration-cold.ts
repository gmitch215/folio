import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Folio } from '../../src/node.ts';

// one cold process per sample: Folio.open, then the first and second run of the BLAKE3 consumer
// over `files` equal inputs of `size` bytes, each paired with a serial native run in the same
// process. prints one JSON line with the load average and what the route decided.

const root = new URL('../../', import.meta.url).pathname;
const [filesArg = '128', sizeArg = '262144', widthArg = '8'] = process.argv.slice(2);
const files = Number(filesArg);
const size = Number(sizeArg);
const width = Number(widthArg);
const BASE = 1 << 20;
const DATA = BASE + 65536;
const PAGE = 65536;
const bytes = new Uint8Array(readFileSync(`${root}build/research/blake3/blake3-hash-all.wasm`));
const pages = Math.ceil((DATA + files * (size + 64)) / PAGE) + 2;
const buffers = Array.from({ length: 8 }, (_, index) => {
	const data = new Uint8Array(size);
	let state = (0x9e3779b9 ^ Math.imul(index + 1, 2654435761)) | 0;
	for (let i = 0; i < size; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		data[i] = state & 255;
	}
	return data;
});
const place = (memory: WebAssembly.Memory) => {
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer, BASE, 2 * files);
	let at = DATA;
	for (let i = 0; i < files; i++) {
		view.set(buffers[i % 8]!, at);
		words[2 * i] = at;
		words[2 * i + 1] = size;
		at += size + 64;
	}
};
const out = BASE + 8 * files;
const digest = (memory: WebAssembly.Memory) =>
	createHash('sha256')
		.update(new Uint8Array(memory.buffer, out, 32 * files))
		.digest('hex');
const nativeMemory = new WebAssembly.Memory({ initial: pages, maximum: pages });
const hash = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
	env: { memory: nativeMemory }
}).exports.hash_all as CallableFunction;
const serial = () => {
	place(nativeMemory);
	const start = performance.now();
	hash(BASE, files, out);
	return performance.now() - start;
};
serial();
const expected = digest(nativeMemory);
const nativeMs = [serial()];
const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: true });
const openStart = performance.now();
const folio = await Folio.open(bytes, { memory, workers: width });
const openMs = performance.now() - openStart;
const runs: Record<string, unknown>[] = [];
for (let call = 0; call < 2; call++) {
	place(folio.memory);
	const load = loadavg();
	const start = performance.now();
	const report = await folio.run('hash_all', [BASE, files, out]);
	const wallMs = performance.now() - start;
	assert.equal(digest(folio.memory), expected);
	nativeMs.push(serial());
	runs.push({
		call,
		wallMs,
		load,
		extraction: report.extraction,
		reason: report.reason,
		regions: report.regions,
		batches: report.iteration?.batches,
		stopped: report.iteration?.stopped,
		serial: report.iteration?.serial,
		estimateMs: report.iteration?.admission?.estimateMs,
		plainIterationMs: report.iteration?.admission?.plainIterationMs
	});
}
await folio.close();
console.log(JSON.stringify({ files, size, width, openMs, nativeMs, runs }));
