import { DurableObject } from 'cloudflare:workers';

// probe copy of floor-worker.mjs for the one-deploy isolating test; mode picks the loop body
const SLICE_UNITS = 50e6;
const MAX_SLICES = 40;
const HARD_STOP_MS = 8000;
const MODES = new Set(['get', 'wait', 'both']);

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

let isolate = null;

function isolateId() {
	return (isolate ??= crypto.randomUUID().slice(0, 8));
}

export class Floor extends DurableObject {
	sink = 0;

	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS marker(k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
		);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS effect(k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
		);
	}

	async alarm() {
		console.log(`alarm ${this.ctx.id.name}`);
		this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM marker').toArray();
	}

	// get: slice then storage read; wait: slice then 1 ms timer; both: slice, storage read, timer
	async work(mode, lengthMs, start) {
		let slices = 0;
		const limit = Math.min(lengthMs, HARD_STOP_MS);
		while (slices < MAX_SLICES && Date.now() - start < limit) {
			this.sink = (this.sink + burn(SLICE_UNITS)) | 0;
			slices++;
			if (mode !== 'wait') await this.ctx.storage.get('tick');
			if (mode !== 'get') await scheduler.wait(1);
		}
		return slices;
	}

	async fetch(request) {
		const u = new URL(request.url);
		if (u.pathname === '/read') {
			const count = (t) =>
				this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n;
			return Response.json({
				markerRows: count('marker'),
				effectRows: count('effect'),
				alarmAt: await this.ctx.storage.getAlarm()
			});
		}
		const mode = u.searchParams.get('mode') ?? 'both';
		if (!MODES.has(mode)) return Response.json({ ok: false, error: `bad mode ${mode}` });
		const lengthMs = Number(u.searchParams.get('L')) * 1000;
		const armMs = Number(u.searchParams.get('F')) * 1000;
		console.log(`req ${this.ctx.id.name} mode=${mode} L=${lengthMs} F=${armMs}`);
		const start = Date.now();
		const sql = this.ctx.storage.sql;
		for (let i = 0; i < 3; i++) sql.exec('INSERT INTO marker(v) VALUES (?)', `m${i}`);
		this.ctx.storage
			.setAlarm(start + armMs)
			.catch((e) => console.log(`setAlarm ${this.ctx.id.name} ${String(e).slice(0, 200)}`));
		const slices = await this.work(mode, lengthMs, start);
		const actualMs = Date.now() - start;
		sql.exec('INSERT INTO effect(v) VALUES (?)', 'e');
		return Response.json({ slices, actualMs, iso: isolateId() });
	}
}

export default {
	async fetch(request, env) {
		const u = new URL(request.url);
		const name = u.searchParams.get('do') ?? 'x';
		const stub = env.FLOOR.get(env.FLOOR.idFromName(name));
		try {
			const r = await stub.fetch(request);
			return Response.json({ ok: true, body: await r.json() });
		} catch (e) {
			console.log(`entry-error ${name} ${String(e).slice(0, 300)}`);
			return Response.json({ ok: false, error: String(e).slice(0, 300) });
		}
	}
};
