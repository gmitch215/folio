import { DurableObject } from 'cloudflare:workers';

// probe copy for the pre-loop variants; the loop is the wait loop (slice, then 1 ms timer, no storage read)
const SLICE_UNITS = 50e6;
const MAX_SLICES = 40;
const HARD_STOP_MS = 8000;
const VARIANTS = new Set(['A', 'B', 'C', 'D', 'E']);

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

	async work(lengthMs, start) {
		let slices = 0;
		const limit = Math.min(lengthMs, HARD_STOP_MS);
		while (slices < MAX_SLICES && Date.now() - start < limit) {
			this.sink = (this.sink + burn(SLICE_UNITS)) | 0;
			slices++;
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
		const variant = u.searchParams.get('v') ?? '';
		if (!VARIANTS.has(variant))
			return Response.json({ ok: false, error: `bad variant ${variant}` });
		const lengthMs = Number(u.searchParams.get('L')) * 1000;
		const armMs = Number(u.searchParams.get('F')) * 1000;
		console.log(`req ${this.ctx.id.name} v=${variant} L=${lengthMs} F=${armMs}`);
		const start = Date.now();
		const sql = this.ctx.storage.sql;
		const st = this.ctx.storage;
		if (variant !== 'D') {
			for (let i = 0; i < 3; i++) sql.exec('INSERT INTO marker(v) VALUES (?)', `m${i}`);
		}
		if (variant === 'B') {
			await st.setAlarm(start + armMs);
		} else if (variant === 'E') {
			await st.sync();
			st.setAlarm(start + armMs).catch((e) =>
				console.log(`setAlarm ${this.ctx.id.name} ${String(e).slice(0, 200)}`)
			);
		} else if (variant !== 'C') {
			st.setAlarm(start + armMs).catch((e) =>
				console.log(`setAlarm ${this.ctx.id.name} ${String(e).slice(0, 200)}`)
			);
		}
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
