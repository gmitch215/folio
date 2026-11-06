import { open, readFile, writeFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

const { module, mode, pages, iterations, working, receiver, image, backing, profile, overlay } =
	workerData;
const PAGE = 65536,
	FLAGS = 16384;
const elastic = mode.startsWith('elastic');
const mutable = mode === 'elastic-write';
const lazy = mode === 'elastic-lazy';
const memory = new WebAssembly.Memory({ initial: elastic ? 5 : pages + 1, maximum: 65536 });
const file = await open(backing, 'r');
const stats = {
	fetchedPages: 0,
	fetchBytes: 0,
	preparationBytes: 0,
	faults: 0,
	hits: 0,
	writebackBytes: 0,
	dirtyEvictions: 0,
	wasmBytes: memory.buffer.byteLength,
	samples: [] as object[]
};
let victim = 0,
	pending: { kind: string; page?: number; slot?: number } | undefined;
let exports: Record<string, any>,
	rewinding = Boolean(image),
	completion = 0;
const sample = () => stats.samples.push({ ...process.memoryUsage(), atFetch: stats.fetchedPages });
sample();
const flush = async (slot: number) => {
	if (!mutable) return;
	const dirty = new Uint8Array(memory.buffer, 17000, 4),
		tags = new Int32Array(memory.buffer, FLAGS, 4);
	if (!dirty[slot] || tags[slot]! < 0) return;
	await writeFile(
		`${overlay}/page-${tags[slot]}`,
		new Uint8Array(memory.buffer, (slot + 1) * PAGE, PAGE)
	);
	dirty[slot] = 0;
	stats.writebackBytes += PAGE;
	stats.dirtyEvictions++;
};
const load = async (page: number, slot: number, preparation = false) => {
	await flush(slot);
	const destination = new Uint8Array(memory.buffer, (elastic ? slot + 1 : page + 1) * PAGE, PAGE);
	let fromOverlay = false;
	if (mutable) {
		try {
			destination.set(await readFile(`${overlay}/page-${page}`));
			fromOverlay = true;
		} catch (error: any) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	if (!fromOverlay) {
		const result = await file.read(destination, 0, PAGE, page * PAGE);
		if (result.bytesRead !== PAGE) throw new Error(`short page ${page}`);
	}
	if (elastic) new Int32Array(memory.buffer, FLAGS, 4)[slot] = page;
	else new Uint8Array(memory.buffer, FLAGS, pages)[page] = 1;
	stats.fetchedPages++;
	stats.fetchBytes += PAGE;
	if (preparation) stats.preparationBytes += PAGE;
	if (stats.fetchedPages % 16 === 0) sample();
};
const started = performance.now(),
	cpu = process.cpuUsage();
if (image) {
	new Uint8Array(memory.buffer).set(image);
	if (!elastic && mode !== 'eager') new Uint8Array(memory.buffer, FLAGS, pages).fill(0);
	// the control page travels without frame contents, so every frame refetches on first touch
	if (lazy) new Int32Array(memory.buffer, FLAGS, 4).fill(-1);
} else {
	const view = new DataView(memory.buffer);
	view.setUint32(16, 1024, true);
	view.setUint32(20, 8192, true);
	if (elastic) new Int32Array(memory.buffer, FLAGS, 4).fill(-1);
}
if (mode === 'eager' && !image) for (let page = 0; page < pages; page++) await load(page, 0, true);
if (mode === 'prefetch') for (const page of profile) await load(page, 0, true);
exports = new WebAssembly.Instance(module, {
	env: { memory },
	host: {
		fault: (page: number, slot: number) => {
			if (rewinding) {
				exports.asyncify_stop_rewind();
				rewinding = false;
				return completion;
			}
			pending = { kind: 'fault', page, slot };
			exports.asyncify_start_unwind(16);
			return 0;
		},
		park: () => {
			if (rewinding) {
				exports.asyncify_stop_rewind();
				rewinding = false;
				return;
			}
			pending = { kind: 'park' };
			exports.asyncify_start_unwind(16);
		}
	}
}).exports;
while (true) {
	if (rewinding) exports.asyncify_start_rewind(16);
	const value = exports.run(pages, working, iterations, receiver);
	if (!pending) {
		for (let slot = 0; slot < 4; slot++) await flush(slot);
		sample();
		const used = process.cpuUsage(cpu);
		parentPort!.postMessage({
			kind: 'done',
			value,
			stats,
			wallMs: performance.now() - started,
			cpuMs: (used.user + used.system) / 1000
		});
		break;
	}
	exports.asyncify_stop_unwind();
	const op = pending;
	pending = undefined;
	if (op.kind === 'fault') {
		// round-robin over four slots: eviction follows load order (FIFO), not recency
		const slot = elastic ? victim++ % 4 : 0;
		await load(op.page!, slot);
		completion = slot;
		stats.faults++;
		rewinding = true;
	} else {
		const before = performance.now();
		const copied = Uint8Array.from(
			new Uint8Array(
				memory.buffer,
				0,
				mode === 'eager' || (elastic && !lazy) ? memory.buffer.byteLength : PAGE
			)
		);
		const copyMs = performance.now() - before;
		sample();
		const used = process.cpuUsage(cpu);
		parentPort!.postMessage(
			{
				kind: 'park',
				image: copied,
				copyMs,
				stats,
				wallMs: performance.now() - started,
				cpuMs: (used.user + used.system) / 1000
			},
			[copied.buffer]
		);
		break;
	}
}
await file.close();
