import { DurableObject } from 'cloudflare:workers';

// slices of nominal 250 ms CPU, each followed by a 1 ms timer yield; the tail gives the measured CPU
const SLICE_UNITS = 50e6;

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

	async alarm() {
		console.log(`alarm ${this.ctx.id.name}`);
		this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM marker').toArray();
	}

	async fetch(request) {
		const u = new URL(request.url);
		const slices = Number(u.searchParams.get('slices'));
		const armed = u.searchParams.get('arm') === 'alarm';
		console.log(`req ${this.ctx.id.name} slices=${slices} arm=${armed ? 'alarm' : 'none'}`);
		const sql = this.ctx.storage.sql;
		for (let i = 0; i < 3; i++) sql.exec('INSERT INTO marker(v) VALUES (?)', `m${i}`);
		const start = Date.now();
		if (armed) {
			this.ctx.storage
				.setAlarm(start + 15000)
				.catch((e) =>
					console.log(`setAlarm ${this.ctx.id.name} ${String(e).slice(0, 200)}`)
				);
		}
		for (let k = 0; k < slices; k++) {
			this.sink = (this.sink + burn(SLICE_UNITS)) | 0;
			await scheduler.wait(1);
		}
		const actualMs = Date.now() - start;
		console.log(`loop-end ${this.ctx.id.name} slices=${slices}`);
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
