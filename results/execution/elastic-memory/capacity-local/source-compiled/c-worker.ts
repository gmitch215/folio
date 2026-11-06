import { open, readFile, writeFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

const { module, pages, iterations, backing, overlay, image } = workerData;
const PAGE = 65536, memory = new WebAssembly.Memory({ initial: 2, maximum: 65536 });
const base = await open(backing, 'r');
const cache = new Map<number, Buffer>(), dirty = new Set<number>();
const stats = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0, operations: 0,
	cacheMax: 0, heapMax: 0, externalMax: 0, wasmBytes: memory.buffer.byteLength };
const sample = () => { const m = process.memoryUsage(); stats.heapMax = Math.max(stats.heapMax, m.heapUsed);
	stats.externalMax = Math.max(stats.externalMax, m.external); };
sample();
async function flush(page: number) {
	if (!dirty.has(page)) return;
	await writeFile(`${overlay}/page-${page}`, cache.get(page)!); dirty.delete(page);
	stats.writes++; stats.writeBytes += PAGE;
}
async function frame(page: number) {
	const hit = cache.get(page);
	if (hit) { cache.delete(page); cache.set(page, hit); return hit; }
	if (cache.size === 4) { const victim = cache.keys().next().value!;
		await flush(victim); cache.delete(victim); }
	let data: Buffer;
	try { data = await readFile(`${overlay}/page-${page}`); }
	catch (error: any) { if (error.code !== 'ENOENT') throw error;
		data = Buffer.alloc(PAGE); if ((await base.read(data, 0, PAGE, page * PAGE)).bytesRead !== PAGE) throw new Error('short page'); }
	cache.set(page, data); stats.reads++; stats.readBytes += PAGE;
	stats.cacheMax = Math.max(stats.cacheMax, cache.size); sample(); return data;
}
async function access(kind: string, pointer: number, a: number, b: number, c: number) {
	stats.operations++;
	const write = kind === 'store', offset = write ? b : a, width = write ? c : b;
	const address = (pointer >>> 0) + offset;
	if (width !== 4 || address < PAGE || address + width > (pages + 1) * PAGE || address % PAGE > PAGE - width)
		throw new WebAssembly.RuntimeError('guest address outside tested subset');
	const page = Math.floor(address / PAGE) - 1, at = address % PAGE, data = await frame(page);
	if (write) { data.writeInt32LE(a | 0, at); dirty.add(page); return 0; }
	return data.readInt32LE(at);
}
let exports: Record<string, any>, rewinding = Boolean(image), completion = 0;
let pending: { kind: string; args: number[] } | undefined;
const hook = (kind: string, ...args: number[]) => {
	if (rewinding) { exports.asyncify_stop_rewind(); rewinding = false; return completion; }
	pending = { kind, args }; exports.asyncify_start_unwind(16); return 0;
};
exports = new WebAssembly.Instance(module, { env: { memory }, folio: {
	load: (...args: number[]) => hook('load', ...args), store: (...args: number[]) => hook('store', ...args),
	exhausted: () => hook('park'), load64: () => { throw new Error('unsupported'); },
	store64: () => { throw new Error('unsupported'); }, copy: () => { throw new Error('unsupported'); }, fill: () => { throw new Error('unsupported'); }
} }).exports;
if (image) new Uint8Array(memory.buffer).set(image);
else { const view = new DataView(memory.buffer); view.setUint32(16, 1024, true); view.setUint32(20, 65536, true); }
exports.__folio_set_fuel(64);
while (true) {
	if (rewinding) exports.asyncify_start_rewind(16);
	const value = exports.walk(pages, iterations);
	if (!pending) {
		for (const page of cache.keys()) await flush(page); sample();
		parentPort!.postMessage({ kind: 'done', value, stats }); break;
	}
	exports.asyncify_stop_unwind(); const op = pending; pending = undefined;
	if (op.kind === 'park') {
		for (const page of cache.keys()) await flush(page); sample();
		const copied = Uint8Array.from(new Uint8Array(memory.buffer));
		parentPort!.postMessage({ kind: 'park', image: copied, stats }, [copied.buffer]); break;
	}
	completion = await access(op.kind, ...(op.args as [number, number, number, number])); rewinding = true;
}
await base.close();
