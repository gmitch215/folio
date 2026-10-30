import { parentPort, workerData } from 'node:worker_threads';
import { iterationArguments, iterationEntryBytes } from './iteration-layout.ts';

const { module, memory, arena, globals, iterate, locals, frameSize, port, signal, control } =
	workerData;
const L = arena;
const ENTRY = iterationEntryBytes;
const exportsOf = new WebAssembly.Instance(module, { env: { memory } }).exports as any;
const u8 = new Uint8Array(memory.buffer);
const u32 = new Uint32Array(memory.buffer);
const counter = new Int32Array(control);
const done = new Int32Array(signal);
const now = () => performance.now();
const stats = { run: 0, scan: 0 };

// reads a bitmap into [start, length] runs of granules and zeroes it as it goes
function scan(base: number, size: number) {
	const words = new Uint32Array(memory.buffer, base, size / 4);
	const runs: number[] = [];
	let start = -1;
	for (let k = 0; k < words.length; k++) {
		const w = words[k]!;
		if (w === 0) {
			if (start >= 0) {
				runs.push(start, k * 32 - start);
				start = -1;
			}
			continue;
		}
		words[k] = 0;
		if (w === 0xffffffff) {
			if (start < 0) start = k * 32;
			continue;
		}
		for (let b = 0; b < 32; b++) {
			if ((w >>> b) & 1) {
				if (start < 0) start = k * 32 + b;
			} else if (start >= 0) {
				runs.push(start, k * 32 + b - start);
				start = -1;
			}
		}
	}
	if (start >= 0) runs.push(start, words.length * 32 - start);
	return Int32Array.from(runs);
}

// status 0 ran, 1 trapped, 2 undo log exhausted
function runOne(job: any, s: number) {
	const index = job.first + s;
	const top = L.slots + (s + 1) * L.slotBytes;
	const frame = top - frameSize;
	if (frameSize) u8.copyWithin(frame, job.frameBase, job.frameBase + frameSize);
	const rbase = L.rmaps + s * L.rsize;
	const wbase = L.wmaps + s * L.wsize;
	const lbase = L.logs + s * L.logBytes;
	const limit = lbase + L.logCapacity * ENTRY;
	exportsOf[globals.readBitmap].value = rbase;
	exportsOf[globals.writeBitmap].value = wbase;
	exportsOf[globals.logPointer].value = lbase;
	exportsOf[globals.logLimit].value = limit;
	exportsOf[globals.stampAddress].value = L.stamp;
	const stack = exportsOf[globals.stackPointer];
	if (stack) stack.value = frameSize ? frame : top;
	const args = iterationArguments(locals, job.entry, index, frame);
	const t1 = now();
	let status = 0;
	try {
		exportsOf[iterate](...args);
	} catch (error) {
		const left = limit - (exportsOf[globals.logPointer].value >>> 0);
		status =
			error instanceof WebAssembly.RuntimeError &&
			/unreachable/.test(error.message) &&
			left < ENTRY
				? 2
				: 1;
	}
	const t2 = now();
	stats.run += t2 - t1;
	const entries = ((exportsOf[globals.logPointer].value >>> 0) - lbase) / ENTRY;
	const written = new Int32Array(entries);
	for (let e = 0; e < entries; e++) written[e] = u32[(lbase + e * ENTRY) / 4]! >>> 5;
	written.sort();
	const reads = scan(rbase, L.rsize);
	if (status) u8.fill(0, wbase, wbase + L.wsize);
	else for (let e = 0; e < entries; e++) u8[wbase + (written[e]! >>> 3)] = 0;
	stats.scan += now() - t2;
	return { index, status, entries, written, reads };
}

port.on('message', (job: any) => {
	stats.run = 0;
	stats.scan = 0;
	let reply: unknown;
	try {
		const results = [];
		for (;;) {
			const k = Atomics.add(counter, 0, 1);
			if (k >= job.count) break;
			results.push(runOne(job, job.reverse ? job.count - 1 - k : k));
		}
		reply = { done: results, runMs: stats.run, scanMs: stats.scan };
	} catch (error) {
		reply = { error: String((error as Error)?.stack ?? error) };
	}
	port.postMessage(reply);
	Atomics.add(done, 0, 1);
	Atomics.notify(done, 0);
});
parentPort!.postMessage({ ready: true });
