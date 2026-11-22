import { DurableObject } from 'cloudflare:workers';

const mod = { id: null };
const modId = () => (mod.id ??= crypto.randomUUID().slice(0, 8));

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

export class Heavy extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
	seq = 0;
	keep = false;
	seeded = false;
	heavyAlarm = false;
	micro = null;

	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS t(k INTEGER PRIMARY KEY, v BLOB)');
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS log(i INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, what TEXT)'
		);
	}

	async alarm() {
		// micro objects skip the default body, which writes a log row
		if (this.micro) return this.microAlarm();
		if (this.heavyAlarm) {
			const sql = this.ctx.storage.sql;
			const val = 'a'.repeat(180);
			for (let i = 0; i < 300; i++) {
				sql.exec('INSERT OR REPLACE INTO w(k, g, v) VALUES (?, ?, ?)', 7000 + i, -1, val);
			}
			const r = await fetch('https://example.com/');
			await r.text();
			for (let i = 0; i < 300; i++) {
				sql.exec('INSERT OR REPLACE INTO w(k, g, v) VALUES (?, ?, ?)', 7400 + i, -1, val);
			}
			return;
		}
		this.ctx.storage.sql.exec('INSERT INTO log(at, what) VALUES (?, ?)', Date.now(), 'alarm');
		const every = Number(this.env.EVERY ?? 0);
		if (every > 0 && this.keep) await this.ctx.storage.setAlarm(Date.now() + every);
	}

	async shape(arm, iters, slices) {
		const sql = this.ctx.storage.sql;
		if (!this.seeded) {
			sql.exec('CREATE TABLE IF NOT EXISTS big(k INTEGER PRIMARY KEY, v TEXT)');
			sql.exec('CREATE TABLE IF NOT EXISTS w(k INTEGER PRIMARY KEY, g INTEGER, v TEXT)');
			sql.exec('CREATE INDEX IF NOT EXISTS w_g ON w(g)');
			sql.exec('CREATE TABLE IF NOT EXISTS jl(g INTEGER PRIMARY KEY, body TEXT)');
			if (!sql.exec('SELECT 1 FROM big LIMIT 1').toArray().length) {
				const pad = 'x'.repeat(100);
				for (let i = 0; i < 50000; i++) {
					sql.exec('INSERT INTO big(k, v) VALUES (?, ?)', i, pad + i);
				}
			}
			this.seeded = true;
		}
		const seq = this.seq;
		const per = Math.round(2000 / slices);
		const val = 'v'.repeat(180);
		const mid = slices >> 1;
		let fetched = 0;
		const fetchOnce = async () => {
			const r = await fetch('https://example.com/');
			fetched = (await r.text()).length;
		};
		if (arm === 'I') await fetchOnce();
		this.heavyAlarm = arm === 'J' || arm === 'K';
		for (let s = 0; s < slices; s++) {
			if ((arm === 'J' || arm === 'L' || arm === 'N') && s === mid) {
				this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
			}
			if ((arm === 'M' || arm === 'O') && s === mid) {
				this.ctx.storage.setAlarm(Date.now() + 60000).catch(() => {});
			}
			if (arm === 'R' && s === mid) {
				await this.ctx.storage.sync();
				this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
			}
			if ('JKNOPR'.includes(arm) && s === mid) await fetchOnce();
			if (arm === 'K' && s === mid) {
				this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
			}
			if (s === mid) {
				const n = sql.exec('SELECT k, v FROM big WHERE k < 30000').toArray().length;
				if (n !== 30000) throw new Error('bad read ' + n);
			}
			for (let i = 0; i < per; i++) {
				sql.exec(
					'INSERT OR REPLACE INTO w(k, g, v) VALUES (?, ?, ?)',
					(s * per + i) % 6000,
					seq,
					val + i
				);
			}
			if (arm === 'G' && s === mid) await fetchOnce();
			burn(Math.round(iters / slices));
		}
		const body = JSON.stringify(Array.from({ length: 1500 }, (_, i) => [i, val, val]));
		sql.exec('INSERT OR REPLACE INTO jl(g, body) VALUES (?, ?)', seq, body);
		if (arm === 'P') this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
		return { fetched, bodyBytes: body.length };
	}

	async big(arm, iters) {
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS bb(k INTEGER PRIMARY KEY, v BLOB)');
		sql.exec('CREATE TABLE IF NOT EXISTS w(k INTEGER PRIMARY KEY, g INTEGER, v TEXT)');
		const seq = this.seq;
		const blob = new Uint8Array(150 * 1024);
		for (let i = 0; i < blob.length; i += 64) blob[i] = (seq + i) & 255;
		const val = 'v'.repeat(180);
		const slices = 30;
		for (let s = 0; s < slices; s++) {
			blob[0] = (seq + s) & 255;
			sql.exec('INSERT OR REPLACE INTO bb(k, v) VALUES (?, ?)', (seq * 7 + s) % 300, blob);
			for (let i = 0; i < 10; i++) {
				sql.exec(
					'INSERT OR REPLACE INTO w(k, g, v) VALUES (?, ?, ?)',
					(s * 10 + i) % 6000,
					seq,
					val + i
				);
			}
			if (arm === 'Y' && s % 10 === 9) await this.ctx.storage.sync();
			if (arm === 'X' && s === 15) await (await fetch('https://example.com/')).text();
			burn(Math.round(iters / slices));
		}
		const body = JSON.stringify(Array.from({ length: 1500 }, (_, i) => [i, val, val]));
		sql.exec('CREATE TABLE IF NOT EXISTS jl(g INTEGER PRIMARY KEY, body TEXT)');
		sql.exec('INSERT OR REPLACE INTO jl(g, body) VALUES (?, ?)', seq, body);
		return { bodyBytes: body.length };
	}

	async microAlarm() {
		if (this.micro.arm !== 'D') return;
		this.micro.handlerRuns++;
		try {
			this.microInsert();
			await this.ctx.storage.sync();
			await this.ctx.storage.setAlarm(Date.now() + 600000);
		} catch (e) {
			this.micro.handlerFailures++;
			this.micro.note(e);
		}
	}

	microInsert() {
		this.ctx.storage.sql.exec('INSERT INTO micro(v) VALUES (?)', 'm'.repeat(80));
		this.micro.inserts++;
	}

	async microOp(arm) {
		const st = this.ctx.storage;
		if (arm === 'A') {
			this.microInsert();
			await st.sync();
			await st.setAlarm(Date.now() + 1);
			await st.sync();
		} else if (arm === 'B' || arm === 'D') {
			const moved = st.setAlarm(Date.now() + 1).then(
				() => null,
				(e) => e
			);
			this.microInsert();
			await st.sync();
			const e = await moved;
			if (e) throw e;
			if (arm === 'D') await scheduler.wait(30);
		} else if (arm === 'C') {
			this.microInsert();
			await st.setAlarm(Date.now() + 1200000);
			await st.sync();
		} else {
			this.microInsert();
			await st.sync();
		}
	}

	async microRun(arm, n) {
		if (!/^[A-E]$/.test(arm)) throw new Error('micro arm must be A to E');
		const st = this.ctx.storage;
		st.sql.exec(
			'CREATE TABLE IF NOT EXISTS micro(k INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
		);
		const errors = new Set();
		const note = (e) => errors.add(String(e?.message ?? e).slice(0, 160));
		const micro = { arm, inserts: 0, handlerRuns: 0, handlerFailures: 0, note };
		this.micro = micro;
		const t0 = Date.now();
		let done = 0;
		let failures = 0;
		for (let i = 0; i < n; i++) {
			const h0 = micro.handlerFailures;
			let bad = false;
			try {
				await st.setAlarm(Date.now() + 600000);
				await st.sync();
				await this.microOp(arm);
			} catch (e) {
				bad = true;
				note(e);
			}
			if (micro.handlerFailures !== h0) bad = true;
			if (bad) failures++;
			else done++;
		}
		return {
			inst: this.inst,
			arm,
			n,
			done,
			failures,
			inserts: micro.inserts,
			handlerRuns: micro.handlerRuns,
			handlerFailures: micro.handlerFailures,
			errors: [...errors].slice(0, 5),
			ms: Date.now() - t0
		};
	}

	async fetch(request) {
		const u = new URL(request.url);
		const q = (k, d) => u.searchParams.get(k) ?? d;
		const micro = q('micro', '');
		if (micro) return Response.json(await this.microRun(micro, Number(q('n', 100))));
		const arm = q('arm', 'A');
		if ('ZYX'.includes(arm)) {
			this.keep = false;
			const seq = ++this.seq;
			const t0 = Date.now();
			const info = await this.big(arm, Number(q('iters', 4e9)));
			return Response.json({
				inst: this.inst,
				mod: modId(),
				seq,
				arm,
				handlerMs: Date.now() - t0,
				...info
			});
		}
		if ('GHIJKLMNOPR'.includes(arm)) {
			this.keep = false;
			const seq = ++this.seq;
			const t0 = Date.now();
			const info = await this.shape(arm, Number(q('iters', 1.3e9)), 20);
			return Response.json({
				inst: this.inst,
				mod: modId(),
				seq,
				arm,
				handlerMs: Date.now() - t0,
				...info
			});
		}
		const iters = Number(q('iters', 3e9));
		const rows = Number(q('rows', 20));
		const kb = Number(q('kb', 32));
		this.keep = q('keep', '1') === '1';
		const sql = this.ctx.storage.sql;
		const seq = ++this.seq;
		const blob = new Uint8Array(kb * 1024);
		for (let i = 0; i < blob.length; i += 64) blob[i] = (seq + i) & 255;
		const half = rows >> 1;
		for (let i = 0; i < half; i++)
			sql.exec('INSERT OR REPLACE INTO t(k, v) VALUES (?, ?)', i, blob);
		const at = Date.now() + 1;
		let alarmP;
		if (arm === 'B') alarmP = this.ctx.storage.setAlarm(at);
		if (arm === 'C') await this.ctx.storage.setAlarm(at);
		if (arm === 'F') alarmP = this.ctx.storage.setAlarm(Date.now() + 15000);
		const sink = burn(iters);
		for (let i = half; i < rows; i++) {
			sql.exec('INSERT OR REPLACE INTO t(k, v) VALUES (?, ?)', i, blob);
		}
		if (arm === 'D') await this.ctx.storage.setAlarm(Date.now() + 1);
		if (alarmP) alarmP.catch(() => {});
		sql.exec('INSERT INTO log(at, what) VALUES (?, ?)', Date.now(), 'req' + arm);
		return Response.json({ inst: this.inst, mod: modId(), seq, arm, sink });
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
