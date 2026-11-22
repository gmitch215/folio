import { DurableObject } from 'cloudflare:workers';

const MIB = 1 << 20;
const ROW_BYTES = 200;
const KINDS = ['rows', 'blob', 'abort'];

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

export class Ladder extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
	seq = 0;
	keys = 0;
	sink = 0;

	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS c(id INTEGER PRIMARY KEY, bin TEXT, k TEXT, v BLOB, exp INTEGER)'
		);
		ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS c_bin_k ON c(bin, k)');
	}

	write(n, value) {
		const sql = this.ctx.storage.sql;
		let written = 0;
		for (let i = 0; i < n; i++) {
			const key = this.keys++;
			const cursor = sql.exec(
				'INSERT INTO c(bin, k, v, exp) VALUES (?, ?, ?, ?)',
				`b${key % 64}`,
				`${this.inst}-${key}`,
				value,
				key
			);
			cursor.toArray();
			written += cursor.rowsWritten;
		}
		return written;
	}

	async event(kind, n, order, end, iters) {
		const seq = ++this.seq;
		if (order === 'blocked') this.sink = (this.sink + burn(iters)) | 0;
		const value = new Uint8Array(kind === 'blob' ? MIB : ROW_BYTES);
		const rowsWritten = this.write(n, value);
		if (kind === 'abort' && seq === 2) this.ctx.abort('ladder-control');
		let syncMs = null;
		if (end === 'sync') {
			const t0 = performance.now();
			await this.ctx.storage.sync();
			syncMs = performance.now() - t0;
		}
		return {
			inst: this.inst,
			kind,
			n,
			order,
			end,
			seq,
			rowsLogical: n,
			rowsWritten,
			bytes: n * value.byteLength,
			dbBytes: this.ctx.storage.sql.databaseSize,
			syncMs
		};
	}

	async fetch(request) {
		const u = new URL(request.url);
		const kind = u.searchParams.get('kind') ?? 'rows';
		if (!KINDS.includes(kind)) throw new Error('kind must be rows, blob or abort');
		const n = Number(u.searchParams.get('n') ?? 1);
		if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
		const order = u.searchParams.get('order') ?? 'plain';
		if (order !== 'plain' && order !== 'blocked')
			throw new Error('order must be plain or blocked');
		const end = u.searchParams.get('end') ?? 'return';
		if (end !== 'return' && end !== 'sync') throw new Error('end must be return or sync');
		const iters = Number(u.searchParams.get('burn') ?? 2e9);
		return Response.json(await this.event(kind, n, order, end, iters));
	}
}

export default {
	async fetch(request, env) {
		const u = new URL(request.url);
		const name = u.searchParams.get('do') ?? 'x';
		try {
			const r = await env.L.get(env.L.idFromName(name)).fetch(request);
			return Response.json({ ok: true, body: await r.json() });
		} catch (e) {
			return Response.json({ ok: false, error: String(e).slice(0, 400) });
		}
	}
};
