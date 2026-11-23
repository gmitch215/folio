import { DurableObject } from 'cloudflare:workers';

const MIB = 1048576;
// 50e6 units is one chain burn, the same unit the retirement chains use
const CHAIN_UNITS = 50e6;
// far more units than 30 s of CPU, so the platform kills the request before the loop ends
const KILL_UNITS = 100e9;
const CHUNKS = 8;
const CHUNK_MIB = 32;

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

export class M1 extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
	keep = [];
	sink = 0;

	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS r(k INTEGER PRIMARY KEY AUTOINCREMENT, ev INTEGER, tag TEXT)'
		);
	}

	async alarm() {
		await this.ctx.storage.setAlarm(Date.now() + 240000);
	}

	spin(units) {
		this.sink = (this.sink + burn(units)) | 0;
	}

	trigger(kind) {
		if (kind === 'memory') {
			for (let i = 0; i < CHUNKS; i++) this.keep.push(new ArrayBuffer(CHUNK_MIB * MIB));
		} else if (kind === 'cpu') {
			this.spin(KILL_UNITS);
		}
	}

	async fetch(request) {
		const u = new URL(request.url);
		const name = this.ctx.id.name;
		const sql = this.ctx.storage.sql;
		const tag = u.searchParams.get('t') ?? '-';
		if (u.pathname === '/read') {
			console.log(`req ${name} ${tag} read`);
			const rows = sql.exec('SELECT ev, tag FROM r ORDER BY k').toArray();
			return Response.json({ inst: this.inst, iso: isolateId(), rows });
		}
		if (u.pathname === '/pre') {
			console.log(`req ${name} ${tag} pre`);
			this.spin(Number(u.searchParams.get('units')));
			return Response.json({ inst: this.inst, iso: isolateId() });
		}
		const ev = Number(u.searchParams.get('ev'));
		const kind = u.searchParams.get('kind') ?? 'none';
		const variant = u.searchParams.get('variant') ?? 'after';
		const orig = u.searchParams.get('orig') ?? '0';
		console.log(`req ${name} ${tag} ev=${ev} kind=${kind} variant=${variant} orig=${orig}`);
		const ins = 'INSERT INTO r(ev, tag) VALUES (?, ?)';
		sql.exec(ins, ev, 'm');
		const sync = u.searchParams.get('sync');
		if (sync) {
			// flush arms: m and y, then the flush, then a burn past the CPU limit with no later write
			sql.exec(ins, ev, 'y');
			if (sync === 'sync' || sync === 'syncyield') await this.ctx.storage.sync();
			if (sync === 'syncyield') await scheduler.wait(50);
			this.spin(KILL_UNITS);
			return Response.json({ inst: this.inst, iso: isolateId() });
		}
		if (orig === '1') {
			// the shape of the end-near-unawaited-no-gap chain arm: marker, burn, effect, alarm
			this.spin(CHAIN_UNITS);
			sql.exec(ins, ev, 'x');
			this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
			return Response.json({ inst: this.inst, iso: isolateId() });
		}
		if (orig === '2') {
			// the same shape with y before the burn and a transaction write z, still no yield
			sql.exec(ins, ev, 'y');
			this.spin(CHAIN_UNITS);
			sql.exec(ins, ev, 'x');
			this.ctx.storage.transactionSync(() => sql.exec(ins, ev, 'z'));
			this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
			return Response.json({ inst: this.inst, iso: isolateId() });
		}
		sql.exec(ins, ev, 'y');
		if (kind === 'storage') this.spin(CHAIN_UNITS);
		if (variant === 'during') this.trigger(kind);
		await scheduler.wait(50);
		sql.exec(ins, ev, 'x');
		this.ctx.storage.transactionSync(() => sql.exec(ins, ev, 'z'));
		if (variant === 'after') this.trigger(kind);
		if (kind === 'storage') this.ctx.storage.setAlarm(Date.now() + 1).catch(() => {});
		console.log(`done ${name} ${tag}`);
		return Response.json({ inst: this.inst, iso: isolateId() });
	}
}

export default {
	async fetch(request, env) {
		const u = new URL(request.url);
		const name = u.searchParams.get('do') ?? 'x';
		try {
			const r = await env.M.get(env.M.idFromName(name)).fetch(request);
			return Response.json({ ok: true, body: await r.json() });
		} catch (e) {
			console.log(
				`entry-error ${name} ${u.searchParams.get('t') ?? '-'} ${String(e).slice(0, 300)}`
			);
			return Response.json({ ok: false, error: String(e).slice(0, 300) });
		}
	}
};
