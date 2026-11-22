import { DurableObject } from 'cloudflare:workers';
import guestModule from './build/guest.wasm';
import hashModule from './build/hash.wasm';

const PAGE = 65536;
const PAGES = 512;
const GROUP_PAGES = 16;
const GROUPS = PAGES / GROUP_PAGES;
const GROUP_BYTES = GROUP_PAGES * PAGE;
const SIGNAL = 1024;
// placement: 500-step segments, each checkpointed in the event, until 4,000 steps on one isolate
const PLACE_SEG = 500;
const PLACE_STEPS = 4000;

// assigned inside handlers: module-scope random ids are refused at startup
let isolateId;
const isolate = () => (isolateId ??= crypto.randomUUID());
let ordinal = 0;
const CUT = new Error('signal raised during a commit');

const note = (ev, fields) =>
	console.log(JSON.stringify({ tag: 'ev', isolate: isolate(), ordinal: ev, ...fields }));
const u32 = (memory, addr) => new DataView(memory.buffer).getUint32(addr, true);
const setU32 = (memory, addr, value) => new DataView(memory.buffer).setUint32(addr, value, true);
const hex = (buffer) =>
	Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (buffer) => hex(await crypto.subtle.digest('SHA-256', buffer));
// runs a statement and returns the rows it wrote
const exec = (sql, query, ...args) => {
	const cursor = sql.exec(query, ...args);
	cursor.toArray();
	return cursor.rowsWritten ?? 0;
};

function attach(memory, epoch, last) {
	return {
		memory,
		guest: new WebAssembly.Instance(guestModule, { env: { memory } }).exports,
		hash: new WebAssembly.Instance(hashModule, { env: { memory } }).exports,
		epoch,
		last
	};
}

const fresh = () => attach(new WebAssembly.Memory({ initial: PAGES, maximum: PAGES }), 0, null);

function hashAll(live) {
	live.hash.hashPages(0, PAGES);
	return new BigUint64Array(live.hash.hashes.buffer).slice(0, PAGES);
}

export class Durable extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.live = null;
		this.warmSteps = 0;
		ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;
			sql.exec(
				'CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), target INTEGER, every INTEGER, mid INTEGER, sim INTEGER, drop_at TEXT, steps INTEGER, finished INTEGER, unsaved INTEGER, isolate TEXT, final TEXT, sha TEXT, place INTEGER, iso_start INTEGER, mode TEXT, b INTEGER, sbar INTEGER, b0 INTEGER, sim_at INTEGER, cut_at INTEGER)'
			);
			sql.exec(
				'CREATE TABLE IF NOT EXISTS slices (k INTEGER PRIMARY KEY, isolate TEXT, ordinal INTEGER, restored INTEGER, lost INTEGER, unsaved_seen INTEGER, steps_start INTEGER, sig_steps INTEGER, ran INTEGER, mids INTEGER, steps_end INTEGER)'
			);
			sql.exec(
				'CREATE TABLE IF NOT EXISTS grp (epoch INTEGER NOT NULL, g INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (epoch, g))'
			);
			sql.exec(
				'CREATE TABLE IF NOT EXISTS manifest (epoch INTEGER PRIMARY KEY, pages INTEGER NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, steps INTEGER NOT NULL, isolate TEXT NOT NULL, hashes BLOB NOT NULL)'
			);
			await ctx.storage.sync();
		});
	}

	async restore(manifest) {
		const rows = this.ctx.storage.sql
			.exec('SELECT g, bytes FROM grp WHERE epoch <= ? ORDER BY epoch ASC', manifest.epoch)
			.toArray();
		const live = fresh();
		const view = new Uint8Array(live.memory.buffer);
		for (const row of rows) view.set(new Uint8Array(row.bytes), row.g * GROUP_BYTES);
		const got = hashAll(live);
		const want = new BigUint64Array(new Uint8Array(manifest.hashes).slice().buffer);
		const bad = [];
		for (let p = 0; p < PAGES; p++) if (got[p] !== want[p]) bad.push(p);
		if (bad.length)
			throw new Error(`restore refused: ${bad.length} page(s) fail the hash check`);
		if ((await sha(want.buffer)) !== manifest.root)
			throw new Error('restore refused: manifest root');
		live.guest.set_state(BigInt(manifest.state), manifest.steps);
		live.last = got;
		live.epoch = manifest.epoch;
		return live;
	}

	// writes the changed 1 MiB groups, the manifest (with every page hash) and the job row in one sync transaction
	async checkpoint(ev, live, why, extra, { guard, tally = { rows: 0 } } = {}) {
		const hashes = hashAll(live);
		const changed = [];
		for (let g = 0; g < GROUPS; g++) {
			for (let p = g * GROUP_PAGES; p < (g + 1) * GROUP_PAGES; p++) {
				if (!live.last || live.last[p] !== hashes[p]) {
					changed.push(g);
					break;
				}
			}
		}
		const epoch = live.epoch + 1;
		const root = await sha(hashes.buffer);
		const view = new Uint8Array(live.memory.buffer);
		const sql = this.ctx.storage.sql;
		const state = String(live.guest.get_state());
		const steps = live.guest.get_steps();
		const write = (query, ...args) => {
			const cursor = sql.exec(query, ...args);
			cursor.toArray();
			tally.rows += cursor.rowsWritten ?? 0;
		};
		this.ctx.storage.transactionSync(() => {
			for (const [i, g] of changed.entries()) {
				write(
					'INSERT INTO grp (epoch, g, bytes) VALUES (?, ?, ?)',
					epoch,
					g,
					view.slice(g * GROUP_BYTES, (g + 1) * GROUP_BYTES).buffer
				);
				write('DELETE FROM grp WHERE g = ? AND epoch < ?', g, epoch);
				guard?.(i);
			}
			write('DELETE FROM manifest WHERE epoch < ?', epoch);
			write(
				'INSERT INTO manifest (epoch, pages, root, state, steps, isolate, hashes) VALUES (?, ?, ?, ?, ?, ?, ?)',
				epoch,
				PAGES,
				root,
				state,
				steps,
				isolate(),
				hashes.buffer
			);
			write('UPDATE job SET steps = ?, unsaved = 0 WHERE id = 1', steps);
			extra?.(write);
		});
		live.last = hashes;
		live.epoch = epoch;
		note(ev, {
			kind: 'checkpoint',
			why,
			epoch,
			changed: changed.length,
			rows: tally.rows,
			steps
		});
		return tally.rows;
	}

	async alarm() {
		const ev = ++ordinal;
		const id = isolate();
		const sql = this.ctx.storage.sql;

		if (this.warmSteps) {
			const n = this.warmSteps;
			this.warmSteps = 0;
			const ran = fresh().guest.run(n);
			note(ev, { kind: 'warm', ran });
			return;
		}

		const job = sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0];
		if (!job || job.finished) return;
		if (job.mode === 'bc') return this.bcEvent(ev, job, id);
		const k = sql.exec('SELECT COUNT(*) AS n FROM slices').toArray()[0].n + 1;
		if (job.drop_at.split(',').includes(String(k))) this.live = null;

		let book = 0;
		const prior = sql.exec('SELECT k FROM slices ORDER BY k DESC LIMIT 1').toArray()[0];
		const unsavedSeen = job.unsaved;
		if (prior && job.unsaved)
			book += exec(sql, 'UPDATE slices SET sig_steps = ? WHERE k = ?', job.steps, prior.k);

		const moved = job.isolate !== null && job.isolate !== id;
		let placing = job.place === 1 && !moved;
		let live;
		let restored = 0;
		let lost = 0;
		if (this.live && job.isolate === id) {
			live = this.live;
			setU32(live.memory, SIGNAL, 0);
			if (job.unsaved) {
				await this.checkpoint(ev, live, 'deferred');
				await this.ctx.storage.sync();
			}
		} else {
			const manifest = sql
				.exec('SELECT * FROM manifest ORDER BY epoch DESC LIMIT 1')
				.toArray()[0];
			live = manifest ? await this.restore(manifest) : fresh();
			restored = manifest ? 1 : 0;
			lost = job.steps - (manifest?.steps ?? 0);
			this.live = live;
		}

		const startSteps = live.guest.get_steps();
		const isoStart = job.isolate === id ? job.iso_start : startSteps;
		book += exec(
			sql,
			'INSERT INTO slices (k, isolate, ordinal, restored, lost, unsaved_seen, steps_start) VALUES (?, ?, ?, ?, ?, ?, ?)',
			k,
			id,
			ev,
			restored,
			lost,
			unsavedSeen,
			startSteps
		);
		book += exec(
			sql,
			'UPDATE job SET isolate = ?, unsaved = 0, steps = ?, place = ?, iso_start = ? WHERE id = 1',
			id,
			startSteps,
			placing ? 1 : 0,
			isoStart
		);
		await this.ctx.storage.sync();
		note(ev, {
			kind: 'slice',
			k,
			restored,
			lost,
			unsaved: unsavedSeen,
			steps: startSteps,
			book
		});

		const target = job.target;
		let ran = 0;
		let mids = 0;
		let signalled = false;
		for (;;) {
			const left = target - live.guest.get_steps();
			const seg = placing ? PLACE_SEG : job.every;
			const want = seg > 0 ? Math.min(left, seg) : left;
			const got = live.guest.run(want);
			ran += got;
			if (live.guest.get_steps() >= target) break;
			let raised = u32(live.memory, SIGNAL) !== 0;
			if (!raised && job.sim && got === want) {
				setU32(live.memory, SIGNAL, 24);
				raised = true;
			}
			if (raised) {
				signalled = true;
				break;
			}
			if (placing || job.mid) {
				const done = placing && live.guest.get_steps() - isoStart >= PLACE_STEPS;
				await this.checkpoint(
					ev,
					live,
					placing ? 'place' : 'mid',
					done ? (write) => write('UPDATE job SET place = 0 WHERE id = 1') : undefined
				);
				await this.ctx.storage.sync();
				mids++;
				if (done) placing = false;
			}
		}

		const steps = live.guest.get_steps();
		if (!signalled) {
			setU32(live.memory, SIGNAL, 0);
			const final = String(live.guest.get_state());
			const finalSha = await sha(live.memory.buffer);
			await this.checkpoint(ev, live, 'final', (write) => {
				write(
					'UPDATE job SET finished = 1, final = ?, sha = ? WHERE id = 1',
					final,
					finalSha
				);
				write(
					'UPDATE slices SET ran = ?, mids = ?, steps_end = ? WHERE k = ?',
					ran,
					mids,
					steps,
					k
				);
			});
			await this.ctx.storage.sync();
			note(ev, { kind: 'final', k, ran, steps, mids });
			return;
		}

		// the only work after the signal: a job row write and the re-arm
		const signalRows = exec(sql, 'UPDATE job SET steps = ?, unsaved = 1 WHERE id = 1', steps);
		note(ev, { kind: 'signal', k, ran, steps, mids, book: signalRows });
		await this.ctx.storage.setAlarm(Date.now());
	}

	// boundary commits (C9): one guest run per event; a budget stop commits before it returns, a signal stop saves nothing
	async bcEvent(ev, job, id) {
		const sql = this.ctx.storage.sql;
		const k = sql.exec('SELECT COUNT(*) AS n FROM slices').toArray()[0].n + 1;
		if (job.drop_at.split(',').includes(String(k))) this.live = null;
		const latest =
			sql.exec('SELECT * FROM manifest ORDER BY epoch DESC LIMIT 1').toArray()[0] ?? null;

		let live;
		let restored = 0;
		let lost = 0;
		if (this.live && job.isolate === id) {
			live = this.live;
			setU32(live.memory, SIGNAL, 0);
			if (live.guest.get_steps() > (latest?.steps ?? 0)) {
				await this.checkpoint(ev, live, 'deferred');
				await this.ctx.storage.sync();
			}
		} else {
			live = latest ? await this.restore(latest) : fresh();
			setU32(live.memory, SIGNAL, 0);
			restored = latest ? 1 : 0;
			lost = job.steps - (latest?.steps ?? 0);
			this.live = live;
		}

		const start = live.guest.get_steps();
		let book = exec(
			sql,
			'INSERT INTO slices (k, isolate, ordinal, restored, lost, steps_start) VALUES (?, ?, ?, ?, ?, ?)',
			k,
			id,
			ev,
			restored,
			lost,
			start
		);
		book += exec(sql, 'UPDATE job SET isolate = ?, steps = ? WHERE id = 1', id, start);
		await this.ctx.storage.sync();
		note(ev, { kind: 'slice', k, restored, lost, steps: start, b: job.b, book });

		const want = Math.min(job.target - start, job.b);
		const sim = job.sim_at !== null && job.sim_at < want;
		const ran = live.guest.run(sim ? job.sim_at : want);
		if (sim && ran === job.sim_at) setU32(live.memory, SIGNAL, 24);
		const steps = live.guest.get_steps();

		if (steps >= job.target) {
			setU32(live.memory, SIGNAL, 0);
			const final = String(live.guest.get_state());
			const finalSha = await sha(live.memory.buffer);
			await this.checkpoint(ev, live, 'final', (write) => {
				write(
					'UPDATE job SET finished = 1, final = ?, sha = ? WHERE id = 1',
					final,
					finalSha
				);
			});
			await this.ctx.storage.sync();
			note(ev, { kind: 'final', k, ran, steps });
			return;
		}
		if (u32(live.memory, SIGNAL) !== 0) return this.bcSignal(ev, k, ran, steps);

		const b = job.sbar === null ? 2 * job.b : Math.round(1.02 * job.b);
		const tally = { rows: 0 };
		const guard = (i) => {
			if (u32(live.memory, SIGNAL) !== 0) throw CUT;
			if (i === 0 && job.cut_at === k) setU32(live.memory, SIGNAL, 24);
		};
		try {
			await this.checkpoint(
				ev,
				live,
				'commit',
				(write) => write('UPDATE job SET b = ? WHERE id = 1', b),
				{
					guard,
					tally
				}
			);
		} catch (error) {
			if (error !== CUT) throw error;
			note(ev, { kind: 'cut', k, steps, rows: tally.rows });
			return this.bcSignal(ev, k, ran, steps);
		}
		await this.ctx.storage.sync();
		note(ev, { kind: 'commit', k, steps, b });
		await this.ctx.storage.setAlarm(Date.now());
	}

	async bcSignal(ev, k, ran, steps) {
		const b = Math.round(0.7 * ran);
		const book = exec(
			this.ctx.storage.sql,
			'UPDATE job SET steps = ?, b = ?, sbar = ? WHERE id = 1',
			steps,
			b,
			ran
		);
		note(ev, { kind: 'signal', k, ran, steps, b, sbar: ran, book });
		await this.ctx.storage.setAlarm(Date.now());
	}

	async fetch(request) {
		const ev = ++ordinal;
		const url = new URL(request.url);
		const q = url.searchParams;
		const rid = q.get('rid');
		const sql = this.ctx.storage.sql;
		const reply = (body = {}) =>
			Response.json({ isolate: isolate(), ordinal: ev, rid, ...body });
		switch (url.pathname) {
			case '/init':
				note(ev, { kind: 'init', rid });
				return reply();
			case '/warm':
				note(ev, { kind: 'warm-request', rid });
				this.warmSteps = Number(q.get('steps'));
				await this.ctx.storage.setAlarm(Date.now());
				return reply();
			case '/chain': {
				sql.exec('DELETE FROM job');
				sql.exec('DELETE FROM slices');
				sql.exec('DELETE FROM grp');
				sql.exec('DELETE FROM manifest');
				sql.exec(
					'INSERT INTO job (id, target, every, mid, sim, drop_at, steps, finished, unsaved, isolate, final, sha, place, iso_start) VALUES (1, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL, ?, 0)',
					Number(q.get('steps')),
					Number(q.get('every') ?? 0),
					Number(q.get('mid') ?? 0),
					Number(q.get('sim') ?? 0),
					q.get('drop') ?? '',
					Number(q.get('place') ?? 0)
				);
				const b0 = Number(q.get('b0') ?? 2000);
				sql.exec(
					'UPDATE job SET mode = ?, b = ?, b0 = ?, sim_at = ?, cut_at = ? WHERE id = 1',
					q.get('mode'),
					b0,
					b0,
					q.has('sim_at') ? Number(q.get('sim_at')) : null,
					q.has('cut_at') ? Number(q.get('cut_at')) : null
				);
				this.live = null;
				this.warmSteps = 0;
				await this.ctx.storage.sync();
				await this.ctx.storage.setAlarm(Date.now() + 2000);
				note(ev, { kind: 'chain', rid });
				return reply();
			}
			case '/budget':
				note(ev, { kind: 'budget', rid, every: q.get('every'), mid: q.get('mid') });
				sql.exec(
					'UPDATE job SET every = ?, mid = ? WHERE id = 1',
					Number(q.get('every')),
					Number(q.get('mid'))
				);
				await this.ctx.storage.sync();
				return reply();
			case '/status':
				note(ev, { kind: 'status', rid });
				return reply({
					job: sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0] ?? null,
					slices: sql.exec('SELECT * FROM slices ORDER BY k').toArray(),
					manifests: sql.exec('SELECT COUNT(*) AS n FROM manifest').toArray()[0].n,
					live: this.live?.epoch ?? null
				});
			case '/release':
				note(ev, { kind: 'release', rid });
				await this.ctx.storage.setAlarm(Date.now() + 500);
				return reply();
			case '/abort':
				note(ev, { kind: 'abort', rid });
				this.ctx.abort();
				return reply();
			default:
				return new Response('unknown route', { status: 404 });
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const [, , name, route] = url.pathname.split('/');
		if (!name || !route) return new Response('not found', { status: 404 });
		const stub = env.P.get(env.P.idFromName(name));
		return stub.fetch(`http://probe/${route}${url.search}`);
	}
};
