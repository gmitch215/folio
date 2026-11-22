import { DurableObject } from 'cloudflare:workers';

const VAL = 'v'.repeat(180);
const SLICES = 20;
const PER_SLICE = 100;
const ENTRY = JSON.stringify([0, VAL, VAL]).length + 1;
const ARM_RE = /^(control|pad-table|large-json-rows|ballast-memory|fingerprint-pass|all-features)$/;

function burn(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s = (s + i * 7) | 0;
	return s;
}

function features(arm) {
	return {
		pad: arm === 'pad-table' || arm === 'all-features',
		jl: arm === 'large-json-rows' || arm === 'all-features',
		mem: arm === 'ballast-memory' || arm === 'all-features',
		fp: arm === 'fingerprint-pass' || arm === 'all-features'
	};
}

function jsonOfChars(chars) {
	return JSON.stringify(
		Array.from({ length: Math.round(chars / ENTRY) }, (_, i) => [i, VAL, VAL])
	);
}

function seed(sql, pad) {
	sql.exec('CREATE TABLE IF NOT EXISTS big(k INTEGER PRIMARY KEY, v TEXT)');
	sql.exec('CREATE TABLE IF NOT EXISTS w(k INTEGER PRIMARY KEY, g INTEGER, v TEXT)');
	sql.exec('CREATE INDEX IF NOT EXISTS w_g ON w(g)');
	sql.exec('CREATE TABLE IF NOT EXISTS jl(k INTEGER PRIMARY KEY, body TEXT)');
	if (!sql.exec('SELECT 1 FROM big LIMIT 1').toArray().length) {
		const text = 'x'.repeat(100);
		for (let i = 0; i < 10000; i++)
			sql.exec('INSERT INTO big(k, v) VALUES (?, ?)', i, text + i);
	}
	if (!pad) return;
	sql.exec('CREATE TABLE IF NOT EXISTS pad(k INTEGER PRIMARY KEY, v BLOB)');
	if (sql.exec('SELECT 1 FROM pad LIMIT 1').toArray().length) return;
	const blob = new Uint8Array(1 << 20);
	for (let i = 0; i < 100; i++) sql.exec('INSERT INTO pad(k, v) VALUES (?, ?)', i, blob);
}

function allocate() {
	const memory = new WebAssembly.Memory({ initial: 1600 });
	const u8 = new Uint8Array(memory.buffer);
	for (let i = 0; i < u8.length; i += 4096) u8[i] = 1;
	return { memory, text: 'x'.repeat(30 * 1024 * 1024) };
}

function fingerprint(sql) {
	let h = 0x811c9dc5;
	for (const table of ['big', 'w']) {
		for (const row of sql.exec(`SELECT v FROM ${table}`)) {
			for (let i = 0; i < row.v.length; i++)
				h = Math.imul(h ^ row.v.charCodeAt(i), 0x01000193);
		}
	}
	return h >>> 0;
}

export class Bisect extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
	seq = 0;
	seeded = false;
	ballast = null;
	fp = 0;
	sink = 0;

	async event(arm, iters, sync) {
		const f = features(arm);
		const sql = this.ctx.storage.sql;
		if (!this.seeded) seed(sql, f.pad);
		this.seeded = true;
		if (f.mem && !this.ballast) this.ballast = allocate();
		const seq = ++this.seq;
		for (let s = 0; s < SLICES; s++) {
			for (let i = 0; i < PER_SLICE; i++) {
				sql.exec(
					'INSERT OR REPLACE INTO w(k, g, v) VALUES (?, ?, ?)',
					s * PER_SLICE + i,
					seq,
					VAL
				);
			}
			if (s === SLICES >> 1) sql.exec('SELECT k, v FROM big').toArray();
			this.sink = (this.sink + burn(Math.round(iters / SLICES))) | 0;
		}
		const jk = sql.exec('SELECT COALESCE(MAX(k), 0) + 1 AS n FROM jl').toArray()[0].n;
		sql.exec('INSERT OR REPLACE INTO jl(k, body) VALUES (?, ?)', jk, jsonOfChars(600_000));
		if (f.jl) {
			sql.exec(
				'INSERT OR REPLACE INTO jl(k, body) VALUES (?, ?)',
				jk + 1,
				jsonOfChars(1_500_000)
			);
			sql.exec(
				'INSERT OR REPLACE INTO jl(k, body) VALUES (?, ?)',
				jk + 2,
				jsonOfChars(1_750_000)
			);
		}
		if (f.fp) this.fp = fingerprint(sql);
		if (sync) await this.ctx.storage.sync();
		return seq;
	}

	stats() {
		const sql = this.ctx.storage.sql;
		const tables = new Set(
			sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((r) => r.name)
		);
		const rows = {};
		for (const t of ['big', 'w', 'jl', 'pad']) {
			if (tables.has(t)) rows[t] = sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0].n;
		}
		return { inst: this.inst, seq: this.seq, databaseSize: sql.databaseSize, rows };
	}

	async fetch(request) {
		const u = new URL(request.url);
		if (u.searchParams.has('stat')) return Response.json(this.stats());
		const arm = u.searchParams.get('arm') ?? '';
		if (!ARM_RE.test(arm)) throw new Error('unknown bisect arm ' + arm);
		const iters = Number(u.searchParams.get('iters') ?? 4e9);
		const sync = u.searchParams.get('sync') === '1';
		const t0 = Date.now();
		const seq = await this.event(arm, iters, sync);
		return Response.json({ inst: this.inst, arm, seq, handlerMs: Date.now() - t0 });
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
			return Response.json({ ok: false, error: String(e).slice(0, 400) });
		}
	}
};
