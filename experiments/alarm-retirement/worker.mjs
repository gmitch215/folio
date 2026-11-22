import { DurableObject } from 'cloudflare:workers';

// burn units that take about 1.5 s of wall time on the first event; a chain event burns a sixth of that
const BURN_FIRST = 230 * 1.3e6;
const BURN_CHAIN = Math.round(BURN_FIRST / 6);
let isolate = null;
let alarmRuns = 0;

// randomUUID is not allowed in global scope (code 10021), so the id is set on the first call
function isolateId() {
	return (isolate ??= crypto.randomUUID().slice(0, 8));
}

// start-of-event alarm move: read the alarm, then set it to now + move when none is set or it is later than now + test
const START_MOVE = {
	'start-near-awaited': { move: 1, test: 50, awaited: true },
	'start-near-awaited-end-sync': { move: 1, test: 50, awaited: true },
	'start-near-awaited-no-writes': { move: 1, test: 50, awaited: true },
	'start-5s-awaited': { move: 5000, test: 5050, awaited: true },
	'start-near-unawaited': { move: 1, test: 50, awaited: false }
};
// end-of-event alarm set without await or sync, measured from the moment of the call
const END_SET = {
	'end-near-unawaited': 1,
	'end-near-unawaited-no-gap': 1,
	'end-far-unawaited': 60000,
	'alarm-1ms': 1,
	'alarm-10ms': 10,
	'alarm-100ms': 100,
	'alarm-1s': 1000,
	'alarm-5s': 5000,
	'alarm-60s': 60000
};
const ARMS = new Set([
	'no-alarm',
	'start-near-awaited',
	'start-near-awaited-end-sync',
	'start-near-awaited-no-writes',
	'start-5s-awaited',
	'start-near-unawaited',
	'end-sync-then-near',
	'end-near-awaited-then-sync',
	...Object.keys(END_SET)
]);

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

export class Retire extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
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

	// re-arms 240 s out so every arm keeps an alarm set; writes nothing
	async alarm() {
		alarmRuns++;
		await this.ctx.storage.setAlarm(Date.now() + 240000);
	}

	spin(units) {
		this.sink = (this.sink + burn(units)) | 0;
	}

	async step(arm, now, units, pre, post) {
		const st = this.ctx.storage;
		const sql = st.sql;
		const rows = arm !== 'start-near-awaited-no-writes';
		let existingMs = null;
		const sm = START_MOVE[arm];
		if (sm) {
			const existing = await st.getAlarm();
			existingMs = existing === null ? null : existing - now;
			if (existing === null || existing > now + sm.test) {
				if (sm.awaited) await st.setAlarm(now + sm.move);
				else st.setAlarm(now + sm.move).catch(() => {});
			}
		}
		if (rows) sql.exec('INSERT INTO marker(v) VALUES (?)', pre);
		this.spin(units);
		if (rows) sql.exec('INSERT INTO effect(v) VALUES (?)', post);
		if (arm === 'start-near-awaited-end-sync') {
			await st.sync();
		} else if (arm === 'end-sync-then-near') {
			await st.sync();
			st.setAlarm(now + 1).catch(() => {});
		} else if (arm === 'end-near-awaited-then-sync') {
			await st.setAlarm(now + 1);
			await st.sync();
		} else if (arm in END_SET) {
			st.setAlarm(Date.now() + END_SET[arm]).catch(() => {});
		}
		return existingMs;
	}

	async fetch(request) {
		const u = new URL(request.url);
		if (u.pathname === '/read') {
			const count = (t) =>
				this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n;
			const markerRows = count('marker');
			const effectRows = count('effect');
			const alarmAt = await this.ctx.storage.getAlarm();
			return Response.json({
				inst: this.inst,
				marker: markerRows > 0,
				effect: effectRows > 0,
				markerRows,
				effectRows,
				alarmAt
			});
		}
		const arm = u.searchParams.get('arm') ?? '';
		if (!ARMS.has(arm)) throw new Error('unknown arm ' + arm);
		const now = Date.now();
		let existingMs;
		if (u.searchParams.get('mode') === 'chain') {
			const ev = Number(u.searchParams.get('ev'));
			existingMs = await this.step(arm, now, BURN_CHAIN, 'pre' + ev, 'post' + ev);
		} else {
			existingMs = await this.step(arm, now, BURN_FIRST, 'm', 'e');
		}
		return Response.json({ inst: this.inst, iso: isolateId(), alarmRuns, existingMs });
	}
}

export default {
	async fetch(request, env) {
		const u = new URL(request.url);
		const chain = u.searchParams.get('mode') === 'chain';
		const id = env.M.idFromName(u.searchParams.get('do') ?? 'x');
		let event;
		try {
			const r = await env.M.get(id).fetch(request);
			event = { ok: true, body: await r.json() };
		} catch (e) {
			event = { ok: false, error: String(e).slice(0, 300) };
		}
		if (chain) return Response.json({ event });
		await scheduler.wait(3000);
		let readback;
		try {
			const r = await env.M.get(id).fetch(new Request(new URL('/read', request.url)));
			readback = { ok: true, body: await r.json() };
		} catch (e) {
			readback = { ok: false, error: String(e).slice(0, 300) };
		}
		return Response.json({ event, readback });
	}
};
