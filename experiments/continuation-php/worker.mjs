import { DurableObject } from 'cloudflare:workers';
import factory from './build/php8.5-worker.mjs';
import wasmModule from './build/php8.5-worker.mjs.wasm';
import { Protocol, SCHEDULE, sqlStore } from './lib.mjs';

globalThis.self ??= globalThis;
globalThis.location ??= { href: 'http://localhost/' };

const SCHED = { ...SCHEDULE, cutEvent: 6 };

export class Job extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx = ctx;
		this.sql = ctx.storage.sql;
		this.proto = null;
		ctx.blockConcurrencyWhile(async () => {
			this.sql.exec(
				'CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), work TEXT)'
			);
			this.sql.exec(
				'CREATE TABLE IF NOT EXISTS grp (epoch INTEGER NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (epoch, idx))'
			);
			this.sql.exec(
				'CREATE TABLE IF NOT EXISTS manifest (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)'
			);
			this.sql.exec(
				'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)'
			);
			this.sql.exec(
				'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)'
			);
		});
	}

	store() {
		return sqlStore(this.ctx.storage);
	}

	protocol() {
		if (this.proto) return this.proto;
		const job = this.sql.exec('SELECT work FROM job WHERE id = 1').toArray()[0];
		if (!job) return null;
		this.proto = new Protocol({
			factory,
			module: wasmModule,
			work: job.work,
			sched: SCHED,
			store: this.store()
		});
		const st = this.sql.exec('SELECT body FROM state WHERE id = 1').toArray()[0];
		if (st) Object.assign(this.proto.s, JSON.parse(st.body));
		return this.proto;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/start') {
			const { work } = await request.json();
			this.ctx.storage.transactionSync(() => {
				for (const t of ['job', 'grp', 'manifest', 'state', 'events'])
					this.sql.exec(`DELETE FROM ${t}`);
				this.sql.exec('INSERT INTO job (id, work) VALUES (1, ?)', work);
			});
			this.proto = null;
			await this.ctx.storage.setAlarm(Date.now());
			return Response.json({ started: true });
		}
		if (request.method === 'GET' && url.pathname === '/status') {
			const proto = this.protocol();
			const events = this.sql
				.exec('SELECT body FROM events ORDER BY seq')
				.toArray()
				.map((r) => JSON.parse(r.body));
			return Response.json({
				done: proto ? proto.s.done : false,
				k: proto ? proto.s.k : 0,
				out: proto && proto.s.done ? proto.s.out : null,
				events
			});
		}
		return new Response('not found', { status: 404 });
	}

	async alarm() {
		const proto = this.protocol();
		if (!proto || proto.s.done) return;
		await proto.event();
		if (!proto.s.done) await this.ctx.storage.setAlarm(Date.now());
	}
}

export default {
	async fetch(request, env) {
		return env.P.get(env.P.idFromName('job')).fetch(request);
	}
};
