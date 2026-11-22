// Shared protocol for the Node arm and the local Durable Object. No Node imports here.

export const PAGE = 65536;
export const GROUP = 1048576;
export const PAGES_PER_GROUP = GROUP / PAGE;
export const SIGNAL_WORD = 24;
export const START = "echo cfw_park_run(file_get_contents('/work.php'));";
export const RESUME = 'echo cfw_park_resume_interrupt();';
export const MARK_PARK = 'PARKED_INTERRUPT';
export const MARK_DONE = 'DONE';

// B0 is in polls; 10,000,000 polls ran in about one second on the Mac.
export const SCHEDULE = {
	B0: 10000000,
	signalEvents: [5, 9],
	dropBefore: [3, 7, 12],
	dropAfter: [9],
	cutEvent: null
};

export class CommitCut extends Error {}
export class RestoreError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256Hex(bytes) {
	const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let s = '';
	for (const b of d) s += b.toString(16).padStart(2, '0');
	return s;
}

// The glue's stdout callback is per byte; the sink is reset before every run.
export async function boot(factory, module) {
	const box = { out: [] };
	const php = await factory({
		stdout: (b) => {
			if (b !== null && b !== undefined) box.out.push(b);
		},
		stderr: () => {},
		printErr: () => {},
		instantiateWasm(imports, receive) {
			WebAssembly.instantiate(module, imports).then((i) => {
				box.inst = i;
				box.imports = imports;
				receive(i, module);
			});
			return {};
		}
	});
	const ex = box.inst.exports;
	return {
		php,
		ex,
		imports: box.imports,
		sink: box.out,
		memory: ex.memory,
		signalAt: ex.__instance_signal.value
	};
}

// Same init on every instance, so the JS side (function table, MEMFS setup) matches.
export async function initPhp(p, work) {
	p.php.FS.writeFile('/php.ini', 'opcache.enable=0\nmemory_limit=256M\n', { encoding: 'utf8' });
	await p.php.ccall('pib_storage_init', 'number', [], [], { async: true });
	await p.php.ccall('pib_init', 'number', ['string'], ['embed'], { async: true });
	p.php.FS.writeFile('/work.php', work, { encoding: 'utf8' });
}

export const arm = (p, period) =>
	p.php.ccall('zend_wasm_slice_arm', 'number', ['number', 'number'], [period, 0]);
export const stat = (p, which) =>
	p.php.ccall('zend_wasm_slice_stat', 'number', ['number'], [which]);
export const counters = (p) => ({
	refusals: stat(p, 8),
	parks: stat(p, 9),
	signalParks: stat(p, 10)
});
export const setSignal = (p, v) => new DataView(p.memory.buffer).setUint32(p.signalAt, v, true);
export const readSignal = (p) => new DataView(p.memory.buffer).getUint32(p.signalAt, true);

export async function run(p, code) {
	p.sink.length = 0;
	const ret = await p.php.ccall('pib_run', 'number', ['string'], [code], { async: true });
	return { ret, text: dec.decode(new Uint8Array(p.sink)) };
}

export function classify(res) {
	if (res.ret !== 0) return 'ERROR';
	if (res.text.endsWith(MARK_PARK)) return 'PARKED';
	if (res.text.endsWith(MARK_DONE)) return 'DONE';
	return 'ERROR';
}

// Every MEMFS regular file, with size and content hash. /dev and /proc belong to the runtime.
export async function listing(FS) {
	const files = [];
	const walk = (dir) => {
		for (const name of FS.readdir(dir)) {
			if (name === '.' || name === '..') continue;
			const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
			if (path === '/dev' || path === '/proc') continue;
			const mode = FS.stat(path).mode;
			if (FS.isDir(mode)) walk(path);
			else if (FS.isFile(mode)) files.push(path);
		}
	};
	walk('/');
	const out = [];
	for (const path of files.sort()) {
		const data = FS.readFile(path);
		out.push({ path, size: data.length, sha256: await sha256Hex(data) });
	}
	return out;
}

// Per-page hashes, then the 1 MiB groups whose hash differs from prevHashes.
export async function capture(p, prevHashes) {
	const t0 = performance.now();
	const bytes = p.memory.buffer.byteLength;
	const groups = Math.ceil(bytes / GROUP);
	const pages = bytes / PAGE;
	const pageHex = [];
	for (let i = 0; i < pages; i++) {
		pageHex.push(await sha256Hex(new Uint8Array(p.memory.buffer, i * PAGE, PAGE)));
	}
	const hashes = [];
	for (let gi = 0; gi < groups; gi++) {
		hashes.push(pageHex.slice(gi * PAGES_PER_GROUP, (gi + 1) * PAGES_PER_GROUP).join(''));
	}
	const changed = [];
	const copies = new Map();
	for (let gi = 0; gi < groups; gi++) {
		if (prevHashes[gi] === hashes[gi]) continue;
		changed.push(gi);
		const len = Math.min(GROUP, bytes - gi * GROUP);
		copies.set(gi, new Uint8Array(p.memory.buffer, gi * GROUP, len).slice());
	}
	return { bytes, groups, hashes, changed, copies, ms: performance.now() - t0 };
}

// Rebuild an instance from the last checkpoint. The glue's own resize import grows the memory, so
// its heap views follow; the request is the exact committed size.
export async function restore(factory, module, work, ck) {
	const p = await boot(factory, module);
	await initPhp(p, work);
	const m = ck.manifest;
	const files = await listing(p.php.FS);
	if (JSON.stringify(files) !== JSON.stringify(m.listing)) {
		throw new RestoreError(`MEMFS listing differs at restore of epoch ${m.epoch}`);
	}
	if (p.memory.buffer.byteLength !== m.memBytes) {
		const grow = p.imports.env?.emscripten_resize_heap;
		if (!grow) throw new RestoreError('no emscripten_resize_heap import to grow memory');
		if (!grow(m.memBytes)) throw new RestoreError(`heap grow to ${m.memBytes} refused`);
		if (p.memory.buffer.byteLength !== m.memBytes) {
			throw new RestoreError(
				`memory size ${p.memory.buffer.byteLength} is not ${m.memBytes}`
			);
		}
	}
	const view = new Uint8Array(p.memory.buffer);
	for (let gi = 0; gi < m.groups; gi++) view.set(ck.groups[gi], gi * GROUP);
	p.ex._emscripten_stack_restore(m.sp);
	if (p.ex.emscripten_stack_get_current() !== m.sp) throw new RestoreError('stack pointer');
	if (p.ex.emscripten_stack_get_base() !== m.base) throw new RestoreError('stack base');
	if (p.ex.emscripten_stack_get_end() !== m.end) throw new RestoreError('stack end');
	p.ex.setTempRet0(m.tempRet0);
	if (p.ex.getTempRet0() !== m.tempRet0) throw new RestoreError('tempRet0');
	return p;
}

// The protocol state machine. One call to event() is one event (C9 with the drops and signals of
// the schedule). The store decides where checkpoints and events go.
export class Protocol {
	constructor({ factory, module, work, sched, store }) {
		this.factory = factory;
		this.module = module;
		this.work = work;
		this.sched = sched;
		this.store = store;
		this.p = null;
		this.s = {
			k: 0,
			started: false,
			unsaved: false,
			budget: sched.B0,
			seenSignal: false,
			done: false,
			epoch: -1,
			out: '',
			pending: '',
			sp0: null,
			base0: null,
			end0: null
		};
	}

	async boot() {
		const p = await boot(this.factory, this.module);
		await initPhp(p, this.work);
		const s = this.s;
		const sp = p.ex.emscripten_stack_get_current();
		const base = p.ex.emscripten_stack_get_base();
		const end = p.ex.emscripten_stack_get_end();
		if (s.sp0 === null) {
			s.sp0 = sp;
			s.base0 = base;
			s.end0 = end;
		} else if (sp !== s.sp0 || base !== s.base0 || end !== s.end0) {
			throw new RestoreError('post-init stack values differ between instances');
		}
		return p;
	}

	async commit(kind, k) {
		const s = this.s;
		const p = this.p;
		setSignal(p, 0);
		const t0 = performance.now();
		const cap = await capture(p, await this.store.hashes());
		s.epoch += 1;
		const manifest = {
			epoch: s.epoch,
			kind,
			k,
			memBytes: cap.bytes,
			groups: cap.groups,
			sp: p.ex.emscripten_stack_get_current(),
			base: p.ex.emscripten_stack_get_base(),
			end: p.ex.emscripten_stack_get_end(),
			tempRet0: p.ex.getTempRet0(),
			listing: await listing(p.php.FS),
			out: s.out + s.pending,
			budget: s.budget,
			seenSignal: s.seenSignal
		};
		let hooks = null;
		if (kind === 'budget' && k === this.sched.cutEvent) {
			hooks = {
				beforeRow: (i) => {
					if (i === 1) setSignal(p, SIGNAL_WORD);
					if (readSignal(p) !== 0) throw new CommitCut(`signal raised before row ${i}`);
				}
			};
		}
		const w = await this.store.write(cap, manifest, hooks);
		s.out += s.pending;
		s.pending = '';
		return {
			kind,
			k,
			epoch: s.epoch,
			ms: performance.now() - t0,
			changed: cap.changed.length,
			rows: w.rows,
			memBytes: cap.bytes
		};
	}

	async event() {
		const s = this.s;
		const sched = this.sched;
		s.k += 1;
		const k = s.k;
		if (sched.dropBefore.includes(k)) this.p = null;
		let restoredFrom = null;
		if (this.p === null) {
			const ck = await this.store.load();
			if (ck) {
				this.p = await restore(this.factory, this.module, this.work, ck);
				s.out = ck.manifest.out;
				s.pending = '';
				s.unsaved = false;
				restoredFrom = ck.manifest.epoch;
			} else {
				if (s.started) throw new RestoreError('no checkpoint for a started job');
				this.p = await this.boot();
			}
		} else if (s.unsaved) {
			await this.commit('unsaved-before-event', k);
			s.unsaved = false;
		}
		const p = this.p;
		const sigFirst = sched.signalEvents.includes(k);
		if (sigFirst) setSignal(p, SIGNAL_WORD);
		const before = counters(p);
		arm(p, s.budget);
		const t0 = performance.now();
		const res = await run(p, s.started ? RESUME : START);
		const evMs = performance.now() - t0;
		s.started = true;
		setSignal(p, 0);
		const after = counters(p);
		const status = classify(res);
		if (status === 'ERROR')
			throw new Error(`event ${k} failed: ret ${res.ret} tail ${res.text.slice(-120)}`);
		const stackOk =
			p.ex.emscripten_stack_get_current() === s.sp0 &&
			p.ex.emscripten_stack_get_base() === s.base0 &&
			p.ex.emscripten_stack_get_end() === s.end0;
		const marker = status === 'PARKED' ? MARK_PARK : MARK_DONE;
		const body = res.text.slice(0, res.text.length - marker.length);
		s.pending += body;
		const reason = after.signalParks - before.signalParks > 0 ? 'SIGNAL' : 'BUDGET';
		const rec = {
			k,
			status,
			reason: status === 'PARKED' ? reason : null,
			budget: s.budget,
			sigFirst,
			restoredFrom,
			refusals: after.refusals - before.refusals,
			evMs: Math.round(evMs),
			stackOk,
			markers: ['A-done', 'B-done', 'C-done', 'D-done'].filter((m) => body.includes(m)),
			commit: null,
			cut: false
		};
		if (status === 'PARKED' && reason === 'SIGNAL') {
			s.unsaved = true;
			s.seenSignal = true;
			const stepsAtSignal = 0; // written before the run, so no poll ran
			s.budget = Math.max(sched.B0, Math.round(0.7 * stepsAtSignal));
		} else if (status === 'PARKED') {
			try {
				rec.commit = await this.commit('budget', k);
				s.budget = Math.round((s.seenSignal ? 1.02 : 2) * s.budget);
			} catch (e) {
				if (!(e instanceof CommitCut)) throw e;
				rec.cut = true;
				rec.cutMessage = e.message;
				s.pending = '';
				this.p = null;
			}
		} else {
			rec.commit = await this.commit('done', k);
			s.done = true;
		}
		if (sched.dropAfter.includes(k) && this.p !== null) this.p = null;
		await this.store.appendEvent(rec);
		await this.store.saveState(s);
		return rec;
	}
}
