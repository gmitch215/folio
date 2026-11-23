// Shared protocol for the Node arm and the local Durable Object. No Node imports here.

export const PAGE = 65536;
export const GROUP = 1048576;
export const PAGES_PER_GROUP = GROUP / PAGE;
export const SIGNAL_WORD = 24;
export const START = "echo cfw_park_run(file_get_contents('/work.php'));";
export const RESUME = 'echo cfw_park_resume_interrupt();';
export const MARK_PARK = 'PARKED_INTERRUPT';
export const MARK_DONE = 'DONE';
export const BATCH = 16;

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

// the patch cannot report the polls run before a signal park, so the budget falls to 0.7 of the one in force
export const budgetAfterSignal = (budget, B0) => Math.max(B0, Math.round(0.7 * budget));

// module scope, so one id per isolate; the first call is inside an event handler
let isolate = null;
export const isolateId = () => (isolate ??= crypto.randomUUID());

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

// Hash of one 1 MiB group: the digests of its pages, hashed again. No copy of the group is made.
async function groupHash(buffer, gi) {
	const end = Math.min((gi + 1) * GROUP, buffer.byteLength);
	let pages = '';
	for (let at = gi * GROUP; at < end; at += PAGE) {
		pages += await sha256Hex(new Uint8Array(buffer, at, PAGE));
	}
	return sha256Hex(enc.encode(pages));
}

// Hashes every group and lists the ones whose hash differs from prevHashes. Copies nothing.
export async function capture(p, prevHashes) {
	const bytes = p.memory.buffer.byteLength;
	const groups = Math.ceil(bytes / GROUP);
	const hashes = [];
	const changed = [];
	for (let gi = 0; gi < groups; gi++) {
		const h = await groupHash(p.memory.buffer, gi);
		hashes.push(h);
		if (prevHashes[gi] !== h) changed.push(gi);
	}
	return { bytes, groups, hashes, changed };
}

// Writes each live group from its row straight into memory, then checks every group's hash. Only the
// manifest selects a row; rows of another epoch are left by a commit that never finished.
export async function restoreGroups(memory, m, rows) {
	const bytes = memory.buffer.byteLength;
	const seen = new Array(m.groups).fill(0);
	const cursor = rows[Symbol.iterator]();
	// the row is bound inside the body, so the previous row is free while the next one is read
	for (;;) {
		const step = cursor.next();
		if (step.done) break;
		const r = step.value;
		if (m.epochs[r.idx] !== r.epoch) continue;
		const src = new Uint8Array(r.bytes);
		const at = r.idx * GROUP;
		if (src.length !== Math.min(GROUP, bytes - at)) {
			throw new RestoreError(`group ${r.idx} holds ${src.length} bytes`);
		}
		new Uint8Array(memory.buffer, at, src.length).set(src);
		seen[r.idx] += 1;
	}
	if (seen.some((n) => n !== 1)) throw new RestoreError('group rows do not match the manifest');
	for (let gi = 0; gi < m.groups; gi++) {
		if ((await groupHash(memory.buffer, gi)) !== m.hashes[gi]) {
			throw new RestoreError(`hash of group ${gi} at restore of epoch ${m.epoch}`);
		}
	}
}

// Rebuild an instance from the last checkpoint. The glue's own resize import grows the memory, so
// its heap views follow; the request is the exact committed size.
export async function restore(factory, module, work, m, rows) {
	const p = await boot(factory, module);
	await initPhp(p, work);
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
	await restoreGroups(p.memory, m, rows);
	p.ex._emscripten_stack_restore(m.sp);
	if (p.ex.emscripten_stack_get_current() !== m.sp) throw new RestoreError('stack pointer');
	if (p.ex.emscripten_stack_get_base() !== m.base) throw new RestoreError('stack base');
	if (p.ex.emscripten_stack_get_end() !== m.end) throw new RestoreError('stack end');
	p.ex.setTempRet0(m.tempRet0);
	if (p.ex.getTempRet0() !== m.tempRet0) throw new RestoreError('tempRet0');
	return p;
}

// Checkpoint store over a Durable Object's storage. A commit copies one group at a time, inserts it
// under the new epoch in batches of BATCH groups, then writes the manifest and prunes in one
// transaction. Restore follows only the manifest, so a commit cut before that point is invisible.
export function sqlStore(storage) {
	const sql = storage.sql;
	return {
		async live() {
			const r = sql.exec('SELECT body FROM manifest WHERE id = 1').toArray()[0];
			return r ? JSON.parse(r.body) : null;
		},
		rows() {
			return sql.exec('SELECT epoch, idx, bytes FROM grp');
		},
		async write({ memory, changed, epoch, manifest, hooks }) {
			let rows = 0;
			for (let i = 0; i < changed.length; i += BATCH) {
				storage.transactionSync(() => {
					for (const gi of changed.slice(i, i + BATCH)) {
						hooks?.beforeRow?.(rows);
						const len = Math.min(GROUP, memory.buffer.byteLength - gi * GROUP);
						const copy = new Uint8Array(memory.buffer, gi * GROUP, len).slice();
						sql.exec(
							'INSERT OR REPLACE INTO grp (epoch, idx, bytes) VALUES (?, ?, ?)',
							epoch,
							gi,
							copy.buffer
						);
						rows++;
					}
				});
				await storage.sync();
			}
			const live = new Set(manifest.epochs.map((e, gi) => `${e}:${gi}`));
			const stale = [];
			for (const r of sql.exec('SELECT epoch, idx FROM grp')) {
				if (!live.has(`${r.epoch}:${r.idx}`)) stale.push([r.epoch, r.idx]);
			}
			storage.transactionSync(() => {
				sql.exec(
					'INSERT OR REPLACE INTO manifest (id, body) VALUES (1, ?)',
					JSON.stringify(manifest)
				);
				for (const [epoch, idx] of stale) {
					sql.exec('DELETE FROM grp WHERE epoch = ? AND idx = ?', epoch, idx);
				}
			});
			return { rows: rows + 1 };
		},
		async appendEvent(rec) {
			sql.exec('INSERT INTO events (body) VALUES (?)', JSON.stringify(rec));
		},
		async saveState(s) {
			sql.exec(
				'INSERT OR REPLACE INTO state (id, body) VALUES (1, ?)',
				JSON.stringify({ ...s, pending: '' })
			);
		},
		// a write is lost if the invocation is reset before its output gate opens; sync waits for it
		async flush() {
			await storage.sync();
		}
	};
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
		const t0 = Date.now();
		const live = await this.store.live();
		const cap = await capture(p, live?.hashes ?? []);
		s.epoch += 1;
		const changed = new Set(cap.changed);
		const manifest = {
			epoch: s.epoch,
			kind,
			k,
			memBytes: cap.bytes,
			groups: cap.groups,
			hashes: cap.hashes,
			epochs: cap.hashes.map((_, gi) => (changed.has(gi) ? s.epoch : live.epochs[gi])),
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
		const w = await this.store.write({
			memory: p.memory,
			changed: cap.changed,
			epoch: s.epoch,
			manifest,
			hooks
		});
		s.out += s.pending;
		s.pending = '';
		return {
			kind,
			k,
			epoch: s.epoch,
			ms: Date.now() - t0,
			changed: cap.changed.length,
			rows: w.rows,
			memBytes: cap.bytes
		};
	}

	async event() {
		const s = this.s;
		const sched = this.sched;
		const attempt = s.attempt;
		s.attempt = null;
		if (attempt) s.k = attempt.k - 1;
		s.k += 1;
		const k = s.k;
		if (sched.dropBefore.includes(k)) this.p = null;
		let lost = null;
		if (attempt) {
			const live = await this.store.live();
			if ((live?.epoch ?? -1) === attempt.epoch) {
				lost = {
					from: attempt.budget,
					to: Math.max(sched.B0, Math.floor(attempt.budget / 2))
				};
				this.p = null;
				s.budget = lost.to;
				s.seenSignal = true;
				await this.store.appendEvent({
					k,
					status: 'LOST',
					reason: 'KILL',
					budget: lost.from,
					budgetAfter: lost.to
				});
			}
		}
		let restoredFrom = null;
		if (this.p === null) {
			const m = await this.store.live();
			if (m) {
				if (!lost) {
					s.budget = m.budget;
					s.seenSignal = m.seenSignal;
				}
				s.epoch = m.epoch;
				this.p = await restore(this.factory, this.module, this.work, m, this.store.rows());
				s.out = m.out;
				s.pending = '';
				s.unsaved = false;
				restoredFrom = m.epoch;
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
		s.attempt = { k, budget: s.budget, epoch: s.epoch };
		await this.store.saveState(s);
		await this.store.flush();
		const before = counters(p);
		arm(p, s.budget);
		const t0 = Date.now();
		const res = await run(p, s.started ? RESUME : START);
		s.started = true;
		s.attempt = null;
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
			isolate: isolateId(),
			refusals: after.refusals - before.refusals,
			stackOk,
			markers: ['A-done', 'B-done', 'C-done', 'D-done'].filter((m) => body.includes(m)),
			commit: null,
			cut: false
		};
		if (status === 'PARKED' && reason === 'SIGNAL') {
			s.unsaved = true;
			s.seenSignal = true;
			s.budget = budgetAfterSignal(s.budget, sched.B0);
		} else if (status === 'PARKED') {
			s.budget = Math.round((s.seenSignal ? 1.02 : 2) * s.budget);
			try {
				rec.commit = await this.commit('budget', k);
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
		await this.store.saveState(s);
		rec.evMs = Date.now() - t0;
		await this.store.appendEvent(rec);
		return rec;
	}
}
