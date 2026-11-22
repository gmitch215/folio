import { DurableObject } from 'cloudflare:workers';
import burnModule from './build/burn.wasm';
import guestModule from './build/guest.wasm';
import hashModule from './build/hash.wasm';

const PAGE = 65536;
const PAGES = 512;
const SIGNAL = 1024;
const TERMINATED = 1028;

let isolateId;
const terminator = new WebAssembly.Instance(burnModule, {}).exports;
let ordinal = 0;

const note = (ev, fields) =>
	console.log(JSON.stringify({ tag: 'ev', isolate: isolateId, ordinal: ev, ...fields }));
const u32 = (memory, addr) => new DataView(memory.buffer).getUint32(addr, true);
const hex = (buffer) =>
	Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (buffer) => hex(await crypto.subtle.digest('SHA-256', buffer));
const toBlob = (value) => new BigUint64Array([value]).buffer;
const fromBlob = (buffer) => new BigUint64Array(buffer)[0];

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

function dirty(memory, pages, rep) {
	const view = new DataView(memory.buffer);
	for (let p = 0; p < pages; p++) view.setUint32(p * PAGE + 4096, rep * 1000003 + p + 1, true);
}

export class Durable extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		isolateId ??= crypto.randomUUID();
		this.live = null;
		ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;
			sql.exec(
				'CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), target INTEGER, every INTEGER, drop_at TEXT, hold TEXT, steps INTEGER, finished INTEGER, paused INTEGER, isolate TEXT, final TEXT, sha TEXT)'
			);
			sql.exec(
				'CREATE TABLE IF NOT EXISTS slices (k INTEGER PRIMARY KEY, isolate TEXT, ordinal INTEGER, restored INTEGER, before1024 INTEGER, after1024 INTEGER, ran INTEGER, steps INTEGER)'
			);
			sql.exec(
				'CREATE TABLE IF NOT EXISTS page (epoch INTEGER NOT NULL, idx INTEGER NOT NULL, hash BLOB NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (epoch, idx))'
			);
			sql.exec(
				'CREATE TABLE IF NOT EXISTS manifest (epoch INTEGER PRIMARY KEY, pages INTEGER NOT NULL, root TEXT NOT NULL, state TEXT NOT NULL, steps INTEGER NOT NULL, isolate TEXT NOT NULL)'
			);
			await ctx.storage.sync();
		});
	}

	// the live instance when this isolate holds it, else the latest manifest, else a fresh guest
	async liveFor(job) {
		if (this.live && (!job || job.isolate === isolateId))
			return { live: this.live, restored: false };
		const manifest = this.ctx.storage.sql
			.exec('SELECT * FROM manifest ORDER BY epoch DESC LIMIT 1')
			.toArray()[0];
		this.live = manifest ? await this.restore(manifest) : fresh();
		return { live: this.live, restored: Boolean(manifest) };
	}

	async restore(manifest) {
		const rows = this.ctx.storage.sql
			.exec(
				'SELECT idx, bytes, hash FROM page WHERE epoch <= ? ORDER BY epoch ASC',
				manifest.epoch
			)
			.toArray();
		const live = fresh();
		const view = new Uint8Array(live.memory.buffer);
		const want = new BigUint64Array(PAGES);
		for (const row of rows) {
			view.set(new Uint8Array(row.bytes), row.idx * PAGE);
			want[row.idx] = fromBlob(row.hash);
		}
		const got = hashAll(live);
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

	// hashes every page, then writes the changed pages, the manifest and any extra rows in one sync transaction
	async checkpoint(live, inside) {
		const hashes = hashAll(live);
		const changed = [];
		for (let p = 0; p < PAGES; p++)
			if (!live.last || live.last[p] !== hashes[p]) changed.push(p);
		const epoch = live.epoch + 1;
		const root = await sha(hashes.buffer);
		const view = new Uint8Array(live.memory.buffer);
		const sql = this.ctx.storage.sql;
		const state = String(live.guest.get_state());
		const steps = live.guest.get_steps();
		let rows = 0;
		const write = (query, ...args) => {
			const cursor = sql.exec(query, ...args);
			cursor.toArray();
			rows += cursor.rowsWritten ?? 0;
		};
		this.ctx.storage.transactionSync(() => {
			for (const p of changed) {
				write(
					'INSERT INTO page (epoch, idx, hash, bytes) VALUES (?, ?, ?, ?)',
					epoch,
					p,
					toBlob(hashes[p]),
					view.slice(p * PAGE, (p + 1) * PAGE).buffer
				);
				write('DELETE FROM page WHERE idx = ? AND epoch < ?', p, epoch - 1);
			}
			write(
				'INSERT INTO manifest (epoch, pages, root, state, steps, isolate) VALUES (?, ?, ?, ?, ?, ?)',
				epoch,
				PAGES,
				root,
				state,
				steps,
				isolateId
			);
			inside?.(write);
		});
		live.last = hashes;
		live.epoch = epoch;
		return { epoch, changed: changed.length, rows };
	}

	async checkpointNow(live) {
		const result = await this.checkpoint(live);
		await this.ctx.storage.sync();
		return result;
	}

	async alarm() {
		const ev = ++ordinal;
		const sql = this.ctx.storage.sql;
		const job = sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0];
		if (!job || job.finished || job.paused) return;
		const k = sql.exec('SELECT COUNT(*) AS n FROM slices').toArray()[0].n + 1;
		if (job.drop_at.split(',').includes(String(k))) this.live = null;
		const { live, restored } = await this.liveFor(job);
		const before1024 = u32(live.memory, SIGNAL);
		sql.exec(
			'INSERT INTO slices (k, isolate, ordinal, restored, before1024) VALUES (?, ?, ?, ?, ?)',
			k,
			isolateId,
			ev,
			restored ? 1 : 0,
			before1024
		);
		sql.exec('UPDATE job SET isolate = ? WHERE id = 1', isolateId);
		await this.ctx.storage.sync();
		note(ev, { kind: 'slice', k, restored, before1024 });

		const remaining = job.target - live.guest.get_steps();
		const ran = live.guest.run(job.every > 0 ? Math.min(remaining, job.every) : remaining);
		const after1024 = u32(live.memory, SIGNAL);
		new DataView(live.memory.buffer).setUint32(SIGNAL, 0, true);
		const steps = live.guest.get_steps();
		const finished = steps >= job.target;
		const paused = !finished && job.hold.split(',').includes(String(k));
		const final = finished ? String(live.guest.get_state()) : null;
		const finalSha = finished ? await sha(live.memory.buffer) : null;
		const ck = await this.checkpoint(live, (write) => {
			write(
				'UPDATE slices SET ran = ?, after1024 = ?, steps = ? WHERE k = ?',
				ran,
				after1024,
				steps,
				k
			);
			write(
				'UPDATE job SET steps = ?, finished = ?, paused = ?, final = ?, sha = ? WHERE id = 1',
				steps,
				finished ? 1 : 0,
				paused ? 1 : 0,
				final,
				finalSha
			);
		});
		await this.ctx.storage.sync();
		note(ev, {
			kind: 'checkpoint',
			k,
			ran,
			steps,
			epoch: ck.epoch,
			changed: ck.changed,
			rows: ck.rows
		});
		if (!finished && !paused) await this.ctx.storage.setAlarm(Date.now());
	}

	async fetch(request) {
		const ev = ++ordinal;
		const url = new URL(request.url);
		const q = url.searchParams;
		const rid = q.get('rid');
		const sql = this.ctx.storage.sql;
		const reply = (body = {}) =>
			Response.json({ isolate: isolateId, ordinal: ev, rid, ...body });
		switch (url.pathname) {
			case '/init':
				note(ev, { kind: 'init', rid });
				return reply();
			case '/chain': {
				sql.exec('DELETE FROM job');
				sql.exec('DELETE FROM slices');
				sql.exec('DELETE FROM page');
				sql.exec('DELETE FROM manifest');
				sql.exec(
					'INSERT INTO job (id, target, every, drop_at, hold, steps, finished, paused, isolate, final, sha) VALUES (1, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)',
					Number(q.get('steps')),
					Number(q.get('every') ?? 0),
					q.get('drop') ?? '',
					q.get('hold') ?? ''
				);
				this.live = null;
				await this.ctx.storage.sync();
				await this.ctx.storage.setAlarm(Date.now() + 2000);
				note(ev, { kind: 'chain', rid });
				return reply();
			}
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
				sql.exec('UPDATE job SET paused = 0 WHERE id = 1');
				await this.ctx.storage.sync();
				await this.ctx.storage.setAlarm(Date.now() + 500);
				return reply();
			case '/abort':
				note(ev, { kind: 'abort', rid });
				this.ctx.abort();
				return reply();
			case '/burn': {
				const budget = Number(q.get('steps'));
				const { live } = await this.liveFor(null);
				const before1024 = u32(live.memory, SIGNAL);
				const stepsBefore = live.guest.get_steps();
				note(ev, { kind: 'burn', rid, budget, before1024 });
				const ran = live.guest.run(budget);
				return reply({
					ran,
					before1024,
					after1024: u32(live.memory, SIGNAL),
					stepsBefore,
					stepsAfter: live.guest.get_steps()
				});
			}
			case '/term-burn': {
				const blocks = Number(q.get('blocks'));
				note(ev, { kind: 'term-burn', rid, blocks });
				terminator.burn(blocks, 0);
				return reply({ blocksDone: blocks });
			}
			case '/term-read':
				note(ev, { kind: 'term-read', rid });
				return reply({
					word1028: terminator.word(TERMINATED),
					word1024: terminator.word(SIGNAL),
					state: String(terminator.state())
				});
			case '/ck': {
				const mode = q.get('mode');
				const pages = Number(q.get('dirty')) * 16;
				const { live, restored } = await this.liveFor(null);
				note(ev, { kind: 'ck', rid, mode, pages });
				const results = [];
				if (mode === 'base') {
					results.push(await this.checkpointNow(live));
				} else {
					for (let rep = 1; rep <= 5; rep++) {
						dirty(live.memory, pages, rep);
						if (mode === 'ck') results.push(await this.checkpointNow(live));
					}
				}
				return reply({ restored, results });
			}
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
