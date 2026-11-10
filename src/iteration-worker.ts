import { parentPort, workerData } from 'node:worker_threads';
import {
	iterationArguments,
	iterationEntryBytes,
	iterationShadowCopies,
	iterationWindowCopy
} from './iteration-layout.ts';
import { markReadSummary, scanReads } from './read-scan.ts';
import { markReadWindow, readWindowsAt } from './read-windows.ts';

const {
	module,
	memory,
	arena,
	globals,
	iterate,
	locals,
	frameSize,
	port,
	signal,
	control,
	ownership
} = workerData;
const L = arena;
const ENTRY = iterationEntryBytes;
const plain = new WebAssembly.Instance(module, { env: { memory } }).exports as any;
// the other lowerings, instantiated when the pool sends them, by key
const variants = new Map<string, any>();
let u8 = new Uint8Array(memory.buffer);
let u32 = new Uint32Array(memory.buffer);
const counter = new Int32Array(control);
const done = new Int32Array(signal);
const now = () => performance.now();
const stats = { run: 0, scan: 0, words: 0, set: 0, mark: 0 };

// status 0 ran, 1 trapped, 2 undo log exhausted, 3 stopped by the owner's stall word
function runOne(job: any, s: number) {
	const index = job.first + s;
	const top = L.slots + (s + 1) * L.slotBytes;
	const frame = top - frameSize;
	const win = job.window ? iterationWindowCopy(top, frameSize, job.window) : undefined;
	const exportsOf = job.variant ? variants.get(job.variant) : plain;
	// the tracked region is the frame, or the window copy and the frame below which it sits
	const region = win ? win.region : frameSize;
	const regionLow = win ? win.copy : frame;
	if (frameSize) u8.copyWithin(frame, job.frameBase, job.frameBase + frameSize);
	if (win) u8.copyWithin(win.copy, job.window.low, job.window.end);
	// a certified window is private and untracked: the slot starts from the owner's bytes
	const own = ownership ? iterationShadowCopies(top, frameSize, ownership.windows) : undefined;
	if (own)
		ownership.windows.forEach((w: { low: number; end: number; delta: string }, i: number) => {
			u8.copyWithin(own.copies[i]!.copy, w.low, w.end);
			exportsOf[w.delta].value = own.copies[i]!.delta;
		});
	const shadow = L.frameShadow + s * L.frameSlotBytes;
	if (region) {
		u8.fill(0, shadow, shadow + L.frameSlotBytes);
		exportsOf[globals.frameLow].value = regionLow;
		exportsOf[globals.frameSize].value = region;
		exportsOf[globals.frameShadow].value = shadow;
	}
	if (win) {
		exportsOf[globals.windowLow].value = job.window.low;
		exportsOf[globals.windowEnd].value = job.window.end;
		exportsOf[globals.windowDelta].value = win.delta;
	}
	const rbase = L.rmaps + s * L.rsize;
	const sbase = L.ssize ? L.smaps + s * L.ssize : 0;
	const wbase = L.wmaps + s * L.wsize;
	const lbase = job.logs.base + s * job.logs.bytes;
	const limit = lbase + job.logs.capacity * ENTRY;
	exportsOf[globals.readBitmap].value = rbase;
	if (L.ssize) exportsOf[globals.readSummary].value = sbase;
	exportsOf[globals.writeBitmap].value = wbase;
	exportsOf[globals.logPointer].value = lbase;
	exportsOf[globals.logLimit].value = limit;
	exportsOf[globals.stampAddress].value = L.stamp;
	const stack = exportsOf[globals.stackPointer];
	if (stack) stack.value = own ? own.low : win ? win.copy : frameSize ? frame : top;
	const slotted = exportsOf[globals.slotLow] !== undefined;
	if (slotted) {
		exportsOf[globals.exemptLow].value = top - L.slotBytes;
		exportsOf[globals.exemptEnd].value = win ? win.copy : frame;
		exportsOf[globals.slotLow].value = top - L.slotBytes;
		exportsOf[globals.slotEnd].value = top;
		exportsOf[globals.arenaLow].value = L.slots;
		exportsOf[globals.arenaEnd].value = L.stamp;
		exportsOf[globals.violation].value = 0;
	}
	const tm = now();
	if (exportsOf[globals.readWindow0Low]) {
		// the guard of a window with no bytes is false, so a stale window never carries over
		const found = job.readWindows ? readWindowsAt(job.readWindows, index, job.memoryBytes) : [];
		for (const [i, names] of [
			[globals.readWindow0Low, globals.readWindow0Span],
			[globals.readWindow1Low, globals.readWindow1Span]
		].entries()) {
			const w = found[i];
			if (exportsOf[names[0]!] === undefined) continue;
			exportsOf[names[0]!].value = w ? w.low : 0;
			exportsOf[names[1]!].value = w ? w.bytes - 7 : 0;
			if (w) {
				markReadWindow(u8, rbase, w.low, w.bytes);
				if (L.ssize) markReadSummary(u8, sbase, L.ssize - 1, w.low, w.bytes);
			}
		}
	}
	const args = iterationArguments(locals, job.entry, index, frame);
	const counted = exportsOf[globals.readHits] !== undefined;
	if (counted) {
		exportsOf[globals.readHits].value = 0;
		exportsOf[globals.readMisses].value = 0;
		exportsOf[globals.readExempt].value = 0;
	}
	const t1 = now();
	stats.mark += t1 - tm;
	let status = 0;
	let touched = -1;
	try {
		exportsOf[iterate](...args);
	} catch (error) {
		const reached = slotted ? exportsOf[globals.violation].value >>> 0 : 0;
		if (reached) {
			touched = Math.floor((Math.max(reached, L.slots) - L.slots) / L.slotBytes);
			touched = Math.min(touched, L.batch);
		}
		const left = limit - (exportsOf[globals.logPointer].value >>> 0);
		const unreachable =
			error instanceof WebAssembly.RuntimeError && /unreachable/.test(error.message);
		status =
			!reached && unreachable && Atomics.load(u32, (L.stamp + 4) / 4) !== 0
				? 3
				: !reached && unreachable && left < ENTRY
					? 2
					: 1;
	}
	const t2 = now();
	stats.run += t2 - t1;
	const runMs = t2 - t1;
	const entries = ((exportsOf[globals.logPointer].value >>> 0) - lbase) / ENTRY;
	const written = new Int32Array(entries);
	for (let e = 0; e < entries; e++) written[e] = u32[(lbase + e * ENTRY) / 4]! >>> 5;
	written.sort();
	const rwords = new Uint32Array(memory.buffer, rbase, L.rsize / 4);
	const summary = L.ssize ? new Uint8Array(memory.buffer, sbase, L.ssize) : undefined;
	const reads = scanReads(rwords, summary, stats);
	let frameWritten = new Uint32Array(0);
	let frameExposed = new Uint32Array(0);
	if (region) {
		const granules = Math.ceil(region / 32);
		const words = (at: number) => u32.slice(at / 4, at / 4 + granules);
		const copy = (at: number) => {
			const found = words(at);
			return found.some(Boolean) ? found : new Uint32Array(0);
		};
		frameWritten = copy(shadow);
		frameExposed = copy(shadow + 4 * granules + 4);
	}
	if (status) u8.fill(0, wbase, wbase + L.wsize);
	else for (let e = 0; e < entries; e++) u8[wbase + (written[e]! >>> 3)] = 0;
	stats.scan += now() - t2;
	return {
		index,
		status,
		entries,
		runMs,
		written,
		reads,
		frameWritten,
		frameExposed,
		touched,
		counts: counted
			? {
					hits: exportsOf[globals.readHits].value >>> 0,
					misses: exportsOf[globals.readMisses].value >>> 0,
					exempt: exportsOf[globals.readExempt].value >>> 0
				}
			: undefined
	};
}

port.on('message', (job: any) => {
	if (job.install) {
		variants.set(job.key, new WebAssembly.Instance(job.install, { env: { memory } }).exports);
		return;
	}
	// the pool may have grown the memory for a larger log; the old views end at the old length
	if (job.memoryBytes > u8.length) {
		u8 = new Uint8Array(memory.buffer);
		u32 = new Uint32Array(memory.buffer);
	}
	stats.run = 0;
	stats.scan = 0;
	stats.words = 0;
	stats.set = 0;
	stats.mark = 0;
	let reply: unknown;
	try {
		const results = [];
		for (;;) {
			const k = Atomics.add(counter, 0, 1);
			if (k >= job.count) break;
			const outcome = runOne(job, job.reverse ? job.count - 1 - k : k);
			results.push(outcome);
			// every later iteration is rolled back and replayed anyway, so leave them unstarted
			if (outcome.status && !job.reverse) Atomics.store(counter, 0, 1 << 30);
		}
		reply = {
			done: results,
			runMs: stats.run,
			scanMs: stats.scan,
			scanWords: stats.words,
			scanSet: stats.set,
			markMs: stats.mark
		};
	} catch (error) {
		reply = { error: String((error as Error)?.stack ?? error) };
	}
	port.postMessage(reply);
	Atomics.add(done, 0, 1);
	Atomics.notify(done, 0);
});
parentPort!.postMessage({ ready: true });
