import { DurableObject } from 'cloudflare:workers';
import burnModule from './build/burn.wasm';
import jspiModule from './build/jspi.wasm';

let isolateId;
const isolate = () => (isolateId ??= crypto.randomUUID());
let ordinal = 0;
const SIGNAL = 1024;
const TERMINATED = 1028;
const BLOCKS = 2056;

const note = (ev, fields) =>
	console.log(JSON.stringify({ tag: 'ev', isolate: isolate(), ordinal: ev, ...fields }));
const u32 = (memory, addr) => new DataView(memory.buffer).getUint32(addr, true);

export class Probe extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), target INTEGER, done INTEGER, mode TEXT, every INTEGER, finished INTEGER, final TEXT, error TEXT)'
		);
		ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS slices (k INTEGER PRIMARY KEY, isolate TEXT, ordinal INTEGER, before1024 INTEGER, start INTEGER, end INTEGER, blocks INTEGER)'
		);
	}

	burnExports() {
		this.burn ??= new WebAssembly.Instance(burnModule, {}).exports;
		return this.burn;
	}

	jspiExports() {
		this.jspi ??= new WebAssembly.Instance(jspiModule, {
			env: { yield: new WebAssembly.Suspending(() => this.yieldPoint()) }
		}).exports;
		return this.jspi;
	}

	yieldPoint() {
		this.reached?.();
		return new Promise((resolve) => (this.resume = resolve));
	}

	// resolves when the guest yields or finishes; undefined when there is no stack to resume
	jspiStep(first, target, every) {
		const reached = new Promise((resolve) => (this.reached = resolve));
		if (first) {
			this.promisingRun ??= WebAssembly.promising(this.jspiExports().run);
			this.promisingRun(target, every).then(
				(state) => {
					this.final = String(state);
					this.reached();
				},
				(error) => {
					this.error = String(error);
					this.reached();
				}
			);
			return reached;
		}
		if (!this.resume) return undefined;
		const resume = this.resume;
		this.resume = undefined;
		resume();
		return reached;
	}

	async fetch(request) {
		const ev = ++ordinal;
		const url = new URL(request.url);
		const q = url.searchParams;
		if (url.pathname === '/burn') return this.burnRoute(ev, q);
		if (url.pathname === '/chain') return this.chainRoute(ev, q);
		if (url.pathname === '/status') return this.statusRoute(ev);
		return new Response('unknown route', { status: 404 });
	}

	burnRoute(ev, q) {
		const exports = this.burnExports();
		const before1024 = exports.word(SIGNAL);
		const before1028 = exports.word(TERMINATED);
		const blocks = Number(q.get('blocks'));
		const poll = Number(q.get('poll') ?? 0);
		note(ev, { kind: 'burn', rid: q.get('rid'), blocks, poll, before1024, before1028 });
		const blocksDone = exports.burn(blocks, poll);
		return Response.json({
			isolate: isolate(),
			ordinal: ev,
			before1024,
			before1028,
			blocksDone,
			after1024: exports.word(SIGNAL),
			state: String(exports.state())
		});
	}

	async chainRoute(ev, q) {
		const sql = this.ctx.storage.sql;
		const target = Number(q.get('blocks'));
		const mode = q.get('mode');
		const every = Number(q.get('every') ?? 0);
		sql.exec('DELETE FROM job');
		sql.exec('DELETE FROM slices');
		sql.exec(
			'INSERT INTO job (id, target, done, mode, every, finished) VALUES (1, ?, 0, ?, ?, 0)',
			target,
			mode,
			every
		);
		await this.ctx.storage.setAlarm(Date.now() + 2000);
		note(ev, { kind: 'chain', target, mode, every });
		return Response.json({ isolate: isolate(), ordinal: ev, ok: true });
	}

	statusRoute(ev) {
		const sql = this.ctx.storage.sql;
		note(ev, { kind: 'status' });
		return Response.json({
			isolate: isolate(),
			ordinal: ev,
			job: sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0] ?? null,
			slices: sql.exec('SELECT * FROM slices ORDER BY k').toArray(),
			hasStack: this.resume !== undefined,
			jspi: {
				suspending: typeof WebAssembly.Suspending,
				promising: typeof WebAssembly.promising
			}
		});
	}

	closeSlice(k, blocks) {
		this.ctx.storage.sql.exec(
			'UPDATE slices SET end = ?, blocks = ? WHERE k = ?',
			Date.now(),
			blocks,
			k
		);
	}

	async alarm() {
		const ev = ++ordinal;
		const sql = this.ctx.storage.sql;
		const job = sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0];
		if (!job || job.finished) return;
		const k = sql.exec('SELECT COUNT(*) AS n FROM slices').toArray()[0].n + 1;
		const jspi = job.mode === 'jspi';
		const exports = jspi ? this.jspiExports() : this.burnExports();
		const before1024 = u32(exports.memory, SIGNAL);
		sql.exec(
			'INSERT INTO slices (k, isolate, ordinal, before1024, start) VALUES (?, ?, ?, ?, ?)',
			k,
			isolate(),
			ev,
			before1024,
			Date.now()
		);
		note(ev, { kind: 'slice', k, mode: job.mode, before1024 });

		if (!jspi) {
			const blocks = exports.burn(job.target - job.done, 1);
			exports.clear(SIGNAL);
			const done = job.done + blocks;
			sql.exec('UPDATE job SET done = ? WHERE id = 1', done);
			this.closeSlice(k, blocks);
			if (done >= job.target) {
				sql.exec(
					'UPDATE job SET finished = 1, final = ? WHERE id = 1',
					String(exports.state())
				);
				return;
			}
			await this.ctx.storage.setAlarm(Date.now());
			return;
		}

		const reached = this.jspiStep(k === 1, job.target, job.every);
		if (!reached) {
			this.closeSlice(k, 0);
			sql.exec("UPDATE job SET finished = 1, error = 'lost' WHERE id = 1");
			return;
		}
		await reached;
		const cumulative = u32(exports.memory, BLOCKS);
		sql.exec('UPDATE job SET done = ? WHERE id = 1', cumulative);
		this.closeSlice(k, cumulative - job.done);
		if (this.error !== undefined) {
			sql.exec('UPDATE job SET finished = 1, error = ? WHERE id = 1', this.error);
			return;
		}
		if (this.final !== undefined) {
			sql.exec('UPDATE job SET finished = 1, final = ? WHERE id = 1', this.final);
			return;
		}
		await this.ctx.storage.setAlarm(Date.now());
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const [, , name, route] = url.pathname.split('/');
		if (!name || !route) return new Response('not found', { status: 404 });
		const stub = env.P.get(env.P.idFromName(name));
		return stub.fetch(`http://probe/${route}${url.search}`);
	}
};
