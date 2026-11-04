import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { predictEnd, probeAffine } from '../../src/affine.ts';
import { chunkRanges } from '../../src/fold.ts';
import { TaskPool } from '../../src/tasks.ts';
import { checkStream, toSharedImport } from './stream-check.ts';

// usage: summary-coldstart.ts STREAM.wasm OUTPUT.json ; FOLIO_WIDTH and FOLIO_MIB size the run
// cost of making one artifact usable: probe, check, pool start, first call, steady call
const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error('usage: summary-coldstart.ts STREAM.wasm OUTPUT.json');
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
const width = Number(process.env.FOLIO_WIDTH ?? 8);
const mib = Number(process.env.FOLIO_MIB ?? 8);
const original = new Uint8Array(readFileSync(binary));
const rows: Record<string, number> = {};
const lap = (name: string, since: number) =>
	(rows[name] = Number((performance.now() - since).toFixed(2)));

let t = performance.now();
const sampled = probeAffine(original, 'update');
lap('probeMs', t);
t = performance.now();
checkStream(original);
const shared = toSharedImport(original);
const checked = checkStream(shared, 'update', 'transition', { sharedImport: true });
lap('checkMs', t);
t = performance.now();
const module = new WebAssembly.Module(shared);
lap('compileMs', t);
const pages = mib * 16 + 2;
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
const input = new Uint8Array(memory.buffer, 0, mib * 1048576);
for (let k = 0; k < input.length; k++) input[k] = (Math.imul(k, 17) ^ (k >>> 7)) & 255;
t = performance.now();
const pool = new TaskPool(width);
const workers = Array.from({ length: width }, (_, index) => {
	const link = pool.link(index);
	return new Worker(new URL('./summary-probe.ts', import.meta.url), {
		workerData: { module, memory, link, pages: Math.ceil((mib * 16) / width) + 4 },
		transferList: [link.port]
	});
});
const chunks = chunkRanges(input.length, width, 1);
const run = () => {
	const handles = chunks.map((c) =>
		pool.submit('shared:0', input.subarray(c.start, c.end), { share: true })
	);
	let state = 0n;
	chunks.forEach((c, k) => {
		const bytes = pool.join(handles[k]!).bytes;
		state = predictEnd(
			checked.model,
			state,
			c.end - c.start,
			new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true)
		);
	});
	return state;
};
run();
lap('firstCallMs', t);
t = performance.now();
run();
lap('secondCallMs', t);
const native = new WebAssembly.Instance(module, { env: { memory } }).exports.update as Function;
t = performance.now();
native(0, 0, input.length);
lap('serialMs', t);
pool.close();
await Promise.all(workers.map((w) => w.terminate()));
rows.model = sampled.kind === 'model' ? 1 : 0;
const record = { node: process.version, width, mib, ...rows };
writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
