import { DurableObject } from 'cloudflare:workers';

export class Idle extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);

	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS started(k INTEGER PRIMARY KEY, at INTEGER)'
		);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS done(k INTEGER PRIMARY KEY, at INTEGER)');
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v)');
	}

	meta(key) {
		return this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k = ?', key).toArray()[0]?.v;
	}

	setMeta(key, value) {
		this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)', key, value);
	}

	async alarm() {
		const sql = this.ctx.storage.sql;
		if (this.meta('inst') !== this.inst) {
			this.setMeta('instances', Number(this.meta('instances') ?? 0) + 1);
			this.setMeta('inst', this.inst);
		}
		const k = Number(this.meta('alarmStarts') ?? 0) + 1;
		this.setMeta('alarmStarts', k);
		sql.exec('INSERT INTO started(k, at) VALUES (?, ?)', k, Date.now());
		await this.ctx.storage.sync();
		sql.exec('INSERT INTO done(k, at) VALUES (?, ?)', k, Date.now());
		await this.ctx.storage.sync();
		if (k < Number(this.env.MAX_FIRES ?? 80)) {
			await this.ctx.storage.setAlarm(Date.now() + Number(this.env.PERIOD_MS ?? 180000));
		}
	}

	async start() {
		if (this.meta('chain') !== undefined) return false;
		this.setMeta('chain', 1);
		await this.ctx.storage.setAlarm(Date.now() + 1000);
		return true;
	}

	stat() {
		const sql = this.ctx.storage.sql;
		const count = (table) => sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n;
		return {
			inst: this.inst,
			started: count('started'),
			done: count('done'),
			instancesSeen: this.meta('instances') ?? 0,
			alarmStarts: this.meta('alarmStarts') ?? 0,
			lastAt: sql.exec('SELECT MAX(at) AS at FROM done').toArray()[0].at
		};
	}

	async fetch(request) {
		const op = new URL(request.url).searchParams.get('op');
		if (op === 'start') return Response.json({ inst: this.inst, started: await this.start() });
		if (op === 'stat') return Response.json(this.stat());
		return Response.json({ inst: this.inst });
	}
}

export default {
	async fetch(request, env) {
		const u = new URL(request.url);
		const name = u.searchParams.get('do') ?? 'x';
		try {
			const r = await env.I.get(env.I.idFromName(name)).fetch(request);
			return Response.json({ ok: true, body: await r.json() });
		} catch (e) {
			return Response.json({ ok: false, error: String(e).slice(0, 160) });
		}
	}
};
