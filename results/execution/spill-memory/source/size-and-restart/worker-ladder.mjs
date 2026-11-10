import { DurableObject } from 'cloudflare:workers';

// random values are refused in global scope, so the id is made on first use
let isolateId;
const isolate = () => (isolateId ??= crypto.randomUUID());
const PAGE = 65536;
const MIB = 1048576;
const payload = (size, seed) => new Uint8Array(size).fill((seed & 255) | 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function colo(env) {
	if (env.COLO_PROBE !== 'on') return { colo: null, probe: false };
	const text = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
	return { colo: /^colo=(\w+)$/m.exec(text)?.[1] ?? null, probe: true };
}

// a call is POST /op with a JSON body; only the listed ops are reachable
async function dispatch(self, request, ops) {
	const op = new URL(request.url).pathname.slice(1);
	if (!ops.includes(op)) return Response.json({ error: `unknown op ${op}` }, { status: 404 });
	try {
		const args = request.method === 'POST' ? await request.json() : {};
		return Response.json({ isolate: isolate(), ...(await self[op](args)) });
	} catch (error) {
		return Response.json({ error: String(error), isolate: isolate() }, { status: 500 });
	}
}

function ensureBlobTable(sql, name) {
	const cursor = sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY, v BLOB)`);
	cursor.toArray();
	return cursor.rowsWritten;
}

class Base extends DurableObject {
	ping() {
		return { ok: 1 };
	}
	noop() {
		return 1;
	}
	colo() {
		return colo(this.env);
	}
	async clear() {
		let keys = null;
		try {
			keys = this.ctx.storage.sql.exec('SELECT count(*) AS c FROM _cf_KV').one().c;
		} catch {
			// table name is not documented
		}
		await this.ctx.storage.deleteAll();
		return { cleared: true, keysSeen: keys };
	}
	async hold({ ms = 0 }) {
		await sleep(ms);
		return { held: ms };
	}
	fetch(request) {
		return dispatch(this, request, this.constructor.ops);
	}
}

export class Owner extends Base {
	static ops = ['ping', 'colo', 'write', 'clear'];
	async write({ shape, size, n, seed = 0 }) {
		const storage = this.ctx.storage;
		const began = performance.now();
		const per = [];
		let rows = 0,
			setupRows = 0,
			sqlRows = 0;
		if (shape === 'none') return { shape, rows, setupRows, sqlRows, inMs: 0, per };
		if (shape === 'await') {
			for (let i = 0; i < n; i++) {
				const at = performance.now();
				await storage.put(`a:${i}`, payload(size, seed + i));
				per.push(performance.now() - at);
				rows++;
			}
		} else if (shape === 'noawait') {
			const failures = [];
			for (let i = 0; i < n; i++) {
				storage.put(`u:${i}`, payload(size, seed + i)).catch((e) => failures.push(String(e)));
				rows++;
			}
			if (failures.length) throw new Error(failures[0]);
		} else if (shape === 'sql') {
			if (!this.table) setupRows = ensureBlobTable(storage.sql, 'blobs'), (this.table = true);
			for (let i = 0; i < n; i++) {
				const cursor = storage.sql.exec(
					'INSERT OR REPLACE INTO blobs (id, v) VALUES (?, ?)',
					i,
					payload(size, seed + i)
				);
				cursor.toArray();
				sqlRows += cursor.rowsWritten;
				rows++;
			}
		} else throw new Error(`unknown shape ${shape}`);
		return { shape, rows, setupRows, sqlRows, inMs: performance.now() - began, per };
	}
}

export class Executor extends Base {
	static ops = ['ping', 'colo', 'hop', 'fan', 'clear'];
	owner(name, hint) {
		const ns = this.env.OWN;
		return ns.get(ns.idFromName(name), hint ? { locationHint: hint } : undefined);
	}
	async hop({ mode, owner, hint, n }) {
		const stub = mode === 'selfstub' ? this.env.EXEC.get(this.ctx.id) : this.owner(owner, hint);
		const call = {
			fetch: () => stub.fetch('https://owner/ping', { method: 'POST', body: '{}' }),
			rpc: () => stub.ping(),
			local: () => this.noop(),
			selfstub: () => stub.noop()
		}[mode];
		if (!call) throw new Error(`unknown mode ${mode}`);
		const timings = [];
		let error = null;
		try {
			// first call creates the object and opens the connection; it is recorded apart
			const first = performance.now();
			const response = await call();
			if (mode === 'fetch') await response.arrayBuffer();
			timings.push({ i: -1, ms: performance.now() - first });
			for (let i = 0; i < n; i++) {
				const at = performance.now();
				const result = await call();
				if (mode === 'fetch') await result.arrayBuffer();
				timings.push({ i, ms: performance.now() - at });
			}
		} catch (e) {
			error = String(e);
		}
		return { mode, hint: hint ?? null, calls: Math.max(0, timings.length), timings, error };
	}
	async fan({ kind, count, owner }) {
		const stub = this.owner(owner);
		const one = (i) =>
			kind.endsWith('rpc')
				? stub.ping()
				: stub.fetch('https://owner/ping', { method: 'POST', body: '{}' }).then((r) =>
						r.arrayBuffer()
					);
		const timings = [];
		let error = null,
			errorAt = null,
			ok = 0;
		try {
			const first = performance.now();
			await one(-1);
			timings.push({ i: -1, ms: performance.now() - first });
			ok++;
			if (kind.startsWith('all')) {
				const began = performance.now();
				const calls = Array.from({ length: count }, async (_, i) => {
					const at = performance.now();
					await one(i);
					timings.push({ i, ms: performance.now() - at });
					ok++;
				});
				const settled = await Promise.allSettled(calls);
				const failed = settled.findIndex((s) => s.status === 'rejected');
				if (failed >= 0) (error = String(settled[failed].reason)), (errorAt = failed);
				timings.push({ i: 'all', ms: performance.now() - began });
			} else
				for (let i = 0; i < count; i++) {
					const at = performance.now();
					await one(i);
					timings.push({ i, ms: performance.now() - at });
					ok++;
				}
		} catch (e) {
			error = String(e);
			errorAt = ok - 1;
		}
		return { kind, requested: count, ok, error, errorAt, timings };
	}
}

export class Store extends Base {
	static ops = ['ping', 'init', 'rmw', 'read', 'clear'];
	table = false;
	init({ size }) {
		const setupRows = ensureBlobTable(this.ctx.storage.sql, 'b');
		const cursor = this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO b (id, v) VALUES (1, ?)',
			payload(size, 7)
		);
		cursor.toArray();
		this.table = true;
		return { rows: 1, setupRows, sqlRows: cursor.rowsWritten };
	}
	rmw({ n }) {
		const sql = this.ctx.storage.sql;
		let rows = 0,
			sqlRows = 0;
		const began = performance.now();
		for (let i = 0; i < n; i++) {
			const bytes = new Uint8Array(sql.exec('SELECT v FROM b WHERE id = 1').one().v);
			bytes[i % bytes.length] ^= 0x55;
			const cursor = sql.exec('UPDATE b SET v = ? WHERE id = 1', bytes);
			cursor.toArray();
			sqlRows += cursor.rowsWritten;
			rows++;
		}
		return { n, rows, setupRows: 0, sqlRows, inMs: performance.now() - began };
	}
	read({ n }) {
		const sql = this.ctx.storage.sql;
		let sum = 0;
		const began = performance.now();
		for (let i = 0; i < n; i++)
			sum += new Uint8Array(sql.exec('SELECT v FROM b WHERE id = 1').one().v)[i % 64];
		return { n, rows: 0, setupRows: 0, sqlRows: 0, sum, inMs: performance.now() - began };
	}
}

export class Burner extends Base {
	static ops = ['ping', 'burn'];
	burn({ iters }) {
		let x = 1;
		for (let i = 0; i < iters; i++) x = Math.imul(x ^ i, 0x9e3779b1) >>> 0;
		return { iters, x };
	}
}

class Spill extends Base {
	static ops = ['ping', 'spill', 'readback', 'hold', 'clear'];
	async spill({ mib, extentPages, rowBytes, seed = 0 }) {
		const bytes = rowBytes ?? extentPages * PAGE;
		const count = Math.ceil((mib * MIB) / bytes);
		const storage = this.ctx.storage;
		let setupRows = 0,
			sqlRows = 0;
		if (this.mode === 'sql') setupRows = ensureBlobTable(storage.sql, 'ext');
		const failures = [];
		for (let j = 0; j < count; j++) {
			const value = payload(bytes, seed + j);
			if (this.mode === 'sql') {
				const cursor = storage.sql.exec(
					'INSERT OR REPLACE INTO ext (id, v) VALUES (?, ?)',
					j,
					value
				);
				cursor.toArray();
				sqlRows += cursor.rowsWritten;
			} else if (this.mode === 'put')
				storage.put(`x:${j}`, value).catch((e) => failures.push(String(e)));
		}
		if (failures.length) throw new Error(failures[0]);
		const issued = this.mode === 'none' ? 0 : count;
		return { mode: this.mode, rows: issued, setupRows, sqlRows, bytes: count * bytes };
	}
	// reads every sql extent back once; the extents are the ones spill wrote
	readback({ mib, extentPages }) {
		if (this.mode !== 'sql') throw new Error('readback reads the sql extents only');
		const bytes = extentPages * PAGE;
		const count = Math.ceil((mib * MIB) / bytes);
		const sql = this.ctx.storage.sql;
		let read = 0;
		for (let j = 0; j < count; j++)
			read += sql.exec('SELECT v FROM ext WHERE id = ?', j).one().v.byteLength;
		return { mode: this.mode, rows: 0, setupRows: 0, sqlRows: 0, read, reads: count };
	}
}
export class SpillSql extends Spill {
	mode = 'sql';
}
export class SpillPut extends Spill {
	mode = 'put';
}

// same fill as the spill arms, no write: separates harness garbage from the write buffer
export class SpillNone extends Spill {
	mode = 'none';
}

// rung 6b and 6c: one class per arm, so a meter row maps to one arm
export class Size0 extends SpillSql {}
export class Size1 extends SpillSql {}
export class Size2 extends SpillSql {}
export class Size3 extends SpillSql {}
export class Size4 extends SpillSql {}
export class PutOne extends SpillPut {}
export class ReadBack extends SpillSql {}
export class Drop extends SpillSql {}
export class CtlSql extends SpillNone {}
export class CtlPut extends SpillNone {}
export class Restart extends SpillSql {}
export class CtlRestart extends SpillNone {}
export class SmallRows extends SpillSql {}
export class SmallExt extends SpillSql {}
export class CtlSmall extends SpillNone {}
export class SecOwn extends SpillSql {}
export class CtlSec extends SpillNone {}

// the executor of the second-object arm; every op runs on the owner of the same name
export class SecExec extends Base {
	static ops = ['ping', 'spill', 'hold', 'clear'];
	async forward(op, { owner, ...args }) {
		const ns = this.env.SECOWN;
		const response = await ns.get(ns.idFromName(owner)).fetch(`https://owner/${op}`, {
			method: 'POST',
			body: JSON.stringify(args)
		});
		if (!response.ok) throw new Error(`owner ${op} answered ${response.status}`);
		const { isolate, ...reply } = await response.json();
		return { ...reply, ownerIsolate: isolate, forwards: 1 };
	}
	spill(args) {
		return this.forward('spill', args);
	}
	hold(args) {
		return this.forward('hold', args);
	}
	clear(args) {
		return this.forward('clear', args);
	}
}

export class CtlSecExec extends Base {
	static ops = ['ping', 'hold'];
}

export default {
	async fetch(request, env) {
		if (request.headers.get('authorization') !== `Bearer ${env.SECRET}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === '/ready') return Response.json({ ready: true });
		const [, role, name, op] = url.pathname.split('/');
		// a role is the binding in upper case; the bindings are the classes of the script
		const ns = env[role?.toUpperCase()];
		if (!name || !op || typeof ns?.get !== 'function')
			return new Response('not found', { status: 404 });
		const hint = url.searchParams.get('hint');
		const stub = ns.get(ns.idFromName(name), hint ? { locationHint: hint } : undefined);
		const response = await stub.fetch(`https://do/${op}`, {
			method: 'POST',
			body: request.body
		});
		const out = new Response(response.body, response);
		out.headers.set('x-front-colo', request.cf?.colo ?? '');
		return out;
	}
};
