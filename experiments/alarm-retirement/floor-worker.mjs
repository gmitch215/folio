import { DurableObject } from 'cloudflare:workers';

// nominal 250 ms of CPU per slice; the run reports the measured wall time per slice
const SLICE_UNITS = 50e6;
const MAX_SLICES = 4000;

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

let isolate = null;

// randomUUID is not allowed in global scope, so the id is set on the first call
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

	// one read and no re-arm, so each trial's alarm fires once
	async alarm() {
		console.log(`alarm ${this.ctx.id.name}`);
		this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM marker').toArray();
	}

	// Date.now() only advances at an awaited I/O, so the loop checks the clock after each read
	async work(lengthMs, start) {
		let slices = 0;
		while (slices < MAX_SLICES && Date.now() - start < lengthMs) {
			this.sink = (this.sink + burn(SLICE_UNITS)) | 0;
			slices++;
			await this.ctx.storage.get('tick');
			// a read of a missing key does not advance Date.now; the 1 ms timer does
			await scheduler.wait(1);
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
		const lengthMs = Number(u.searchParams.get('L')) * 1000;
		const armMs = Number(u.searchParams.get('F')) * 1000;
		console.log(`req ${this.ctx.id.name} L=${lengthMs} F=${armMs}`);
		const start = Date.now();
		const sql = this.ctx.storage.sql;
		for (let i = 0; i < 3; i++) sql.exec('INSERT INTO marker(v) VALUES (?)', `m${i}`);
		this.ctx.storage
			.setAlarm(start + armMs)
			.catch((e) => console.log(`setAlarm ${this.ctx.id.name} ${String(e).slice(0, 200)}`));
		const slices = await this.work(lengthMs, start);
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
