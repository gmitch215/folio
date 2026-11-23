import { DurableObject } from 'cloudflare:workers';

// idle grid worker: request length L is wall time in 250 ms timer waits, with no CPU burn
const MAX_WAITS = 200;

let isolate = null;

function isolateId() {
	return (isolate ??= crypto.randomUUID().slice(0, 8));
}

export class Floor extends DurableObject {
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
		const lengthMs = Number(u.searchParams.get('L')) * 1000;
		const armMs = Number(u.searchParams.get('F')) * 1000;
		console.log(`req ${this.ctx.id.name} L=${lengthMs} F=${armMs}`);
		const start = Date.now();
		const sql = this.ctx.storage.sql;
		for (let i = 0; i < 3; i++) sql.exec('INSERT INTO marker(v) VALUES (?)', `m${i}`);
		this.ctx.storage
			.setAlarm(start + armMs)
			.catch((e) => console.log(`setAlarm ${this.ctx.id.name} ${String(e).slice(0, 200)}`));
		let waits = 0;
		while (waits < MAX_WAITS && Date.now() - start < lengthMs) {
			await scheduler.wait(250);
			waits++;
		}
		const actualMs = Date.now() - start;
		sql.exec('INSERT INTO effect(v) VALUES (?)', 'e');
		return Response.json({ slices: waits, actualMs, iso: isolateId() });
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
