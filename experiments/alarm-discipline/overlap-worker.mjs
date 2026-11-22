import { DurableObject } from 'cloudflare:workers';

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

const FIRST_ARMS = new Set([
	'burn-then-write',
	'alarm-unawaited-then-burn',
	'alarm-awaited-then-burn',
	'alarm-unawaited-short-burn',
	'alarm-unawaited-long-burn',
	'alarm-20min-unawaited-then-burn',
	'alarm-unawaited-no-burn',
	'prior-burn-then-alarm-unawaited',
	'alarm-awaited-synced-then-burn',
	'burn-then-alarm-unawaited',
	'burn-then-alarm-awaited-sync',
	'burn-then-alarm-unawaited-sync',
	'burn-then-alarm-unawaited-wait',
	'write-sync-then-burn-alarm-unawaited',
	'burn-then-alarm-awaited-wait',
	'burn-write-then-alarm-20min-unawaited'
]);

export class Overlap extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
	seq = 0;
	xCount = 0;
	sink = 0;
	fired = 0;

	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS o(k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
		);
	}

	async alarm() {
		this.ctx.storage.sql.exec('INSERT INTO o(v) VALUES (?)', 'alarm');
		this.fired++;
		await this.ctx.storage.setAlarm(Date.now() + 600000);
	}

	reply(arm, atStart) {
		const fires = this.fired;
		this.fired = 0;
		return Response.json({ inst: this.inst, arm, seq: this.seq, fires, atStart });
	}

	async firstEvent(arm, n) {
		const st = this.ctx.storage;
		const sql = st.sql;
		const write = () => sql.exec('INSERT INTO o(v) VALUES (?)', 'row');
		const soon = (ms) => st.setAlarm(Date.now() + ms).catch(() => {});
		const spin = () => {
			this.sink = (this.sink + burn(n)) | 0;
		};
		if (arm === 'PRE') {
			spin();
		} else if (arm === 'burn-then-write') {
			spin();
			write();
		} else if (
			arm === 'alarm-unawaited-then-burn' ||
			arm === 'prior-burn-then-alarm-unawaited'
		) {
			soon(1);
			spin();
			write();
		} else if (arm === 'alarm-awaited-then-burn') {
			await st.setAlarm(Date.now() + 1);
			spin();
			write();
		} else if (arm === 'alarm-unawaited-short-burn' || arm === 'alarm-unawaited-long-burn') {
			soon(1);
			spin();
			write();
		} else if (arm === 'alarm-20min-unawaited-then-burn') {
			soon(1200000);
			spin();
			write();
		} else if (arm === 'alarm-unawaited-no-burn') {
			soon(1);
			write();
		} else if (arm === 'alarm-awaited-synced-then-burn') {
			await st.setAlarm(Date.now() + 1);
			await st.sync();
			spin();
			write();
		} else if (arm === 'burn-then-alarm-unawaited') {
			spin();
			soon(1);
			write();
		} else if (arm === 'burn-then-alarm-awaited-sync') {
			spin();
			await st.setAlarm(Date.now() + 1);
			await st.sync();
			write();
		} else if (arm === 'burn-then-alarm-unawaited-sync') {
			spin();
			soon(1);
			await st.sync();
		} else if (arm === 'burn-then-alarm-unawaited-wait') {
			spin();
			soon(1);
			await scheduler.wait(50);
		} else if (arm === 'write-sync-then-burn-alarm-unawaited') {
			write();
			await st.sync();
			spin();
			soon(1);
		} else if (arm === 'burn-then-alarm-awaited-wait') {
			spin();
			await st.setAlarm(Date.now() + 1);
			await scheduler.wait(50);
		} else if (arm === 'burn-write-then-alarm-20min-unawaited') {
			spin();
			write();
			soon(1200000);
		} else {
			throw new Error('unknown first-event arm ' + arm);
		}
	}

	async fetch(request) {
		const atStart = this.fired;
		const u = new URL(request.url);
		const arm = u.searchParams.get('arm') ?? 'no-alarm';
		const n = Number(u.searchParams.get('cpu') ?? 1000) * 1.3e6;
		if (arm === 'P') {
			this.seq++;
			return this.reply(arm, atStart);
		}
		if (arm === 'PRE' || FIRST_ARMS.has(arm)) {
			this.seq++;
			await this.firstEvent(arm, n);
			return this.reply(arm, atStart);
		}

		const st = this.ctx.storage;
		const sql = st.sql;
		const write = () => sql.exec('INSERT INTO o(v) VALUES (?)', 'row');
		const seq = ++this.seq;
		await st.setAlarm(Date.now() + 600000);
		await st.sync();

		if (arm === 'T') {
			// trailing request: collects the fires that landed after the previous reply
		} else if (arm === 'no-alarm') {
			write();
			this.sink = (this.sink + burn(n)) | 0;
			write();
		} else if (arm === 'alarm-2s-committed') {
			await st.setAlarm(Date.now() + 2000);
			await st.sync();
			this.sink = (this.sink + burn(n)) | 0;
			write();
		} else if (arm === 'alarm-1ms-unawaited') {
			st.setAlarm(Date.now() + 1).catch(() => {});
			this.sink = (this.sink + burn(n)) | 0;
			write();
		} else if (arm === 'alarm-20min-committed') {
			await st.setAlarm(Date.now() + 1200000);
			await st.sync();
			this.sink = (this.sink + burn(n)) | 0;
			write();
		} else if (arm === 'alarm-2s-committed-sliced') {
			await st.setAlarm(Date.now() + 2000);
			await st.sync();
			for (let i = 0; i < 5; i++) {
				if (i > 0) await scheduler.wait(50);
				this.sink = (this.sink + burn(n / 5)) | 0;
			}
			write();
		} else if (arm === 'X') {
			// the second event on an instance aborts; the third lands on a fresh instance
			this.xCount++;
			write();
			if (this.xCount === 2) {
				await st.sync();
				this.ctx.abort('overlap-control');
			}
		} else {
			throw new Error('unknown arm ' + arm);
		}

		return this.reply(arm, atStart);
	}
}

export default {
	async fetch(request, env) {
		const u = new URL(request.url);
		const name = u.searchParams.get('do') ?? 'x';
		try {
			const r = await env.H.get(env.H.idFromName(name)).fetch(request);
			return Response.json({ ok: true, body: await r.json() });
		} catch (e) {
			return Response.json({ ok: false, error: String(e).slice(0, 160) });
		}
	}
};
