import { DurableObject } from 'cloudflare:workers';
import burnModule from './build/burn.wasm';

let isolateId;
let isolateStart;
const isolate = () => {
	if (isolateId === undefined) {
		isolateId = crypto.randomUUID();
		isolateStart = Date.now();
	}
	return isolateId;
};
let isolateBlocks = 0;
let isolateEvents = 0;
let ordinal = 0;
let pausedIsolate = false;
const SIGNAL = 1024;

const u32 = (memory, addr) => new DataView(memory.buffer).getUint32(addr, true);

export class Life extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(
				'CREATE TABLE IF NOT EXISTS chain (id INTEGER PRIMARY KEY CHECK (id = 1), target INTEGER, slice INTEGER, pause_after INTEGER, pause_ms INTEGER, blocks INTEGER, slices INTEGER, done INTEGER)'
			);
			ctx.storage.sql.exec(
				'CREATE TABLE IF NOT EXISTS slices (k INTEGER PRIMARY KEY, isolate TEXT, isolate_events INTEGER, isolate_blocks_before INTEGER, object_blocks_before INTEGER, start_ms INTEGER)'
			);
			await ctx.storage.sync();
		});
	}

	burnExports() {
		this.burn ??= new WebAssembly.Instance(burnModule, {}).exports;
		return this.burn;
	}

	async fetch(request) {
		isolateEvents++;
		const ev = ++ordinal;
		const url = new URL(request.url);
		const q = url.searchParams;
		if (url.pathname === '/start') return this.startRoute(q);
		if (url.pathname === '/status') return this.statusRoute(ev);
		if (url.pathname === '/slices') return this.slicesRoute();
		return new Response('unknown route', { status: 404 });
	}

	async startRoute(q) {
		const sql = this.ctx.storage.sql;
		sql.exec(
			'INSERT OR REPLACE INTO chain (id, target, slice, pause_after, pause_ms, blocks, slices, done) VALUES (1, ?, ?, ?, ?, 0, 0, 0)',
			Number(q.get('target')),
			Number(q.get('slice')),
			Number(q.get('pauseAfter') ?? 0),
			Number(q.get('pauseMs') ?? 0)
		);
		await this.ctx.storage.sync();
		await this.ctx.storage.setAlarm(Date.now() + 2000);
		return Response.json({ isolate: isolate(), ok: true });
	}

	statusRoute() {
		const sql = this.ctx.storage.sql;
		return Response.json({
			doId: this.ctx.id.toString(),
			isolate: isolate(),
			isolateBlocks,
			isolateEvents,
			isolateStart,
			chain: sql.exec('SELECT * FROM chain WHERE id = 1').toArray()[0] ?? null,
			slices: sql.exec('SELECT COUNT(*) AS n FROM slices').toArray()[0].n
		});
	}

	slicesRoute() {
		return Response.json(
			this.ctx.storage.sql.exec('SELECT * FROM slices ORDER BY k').toArray()
		);
	}

	async alarm() {
		isolateEvents++;
		const ev = ++ordinal;
		const sql = this.ctx.storage.sql;
		const chain = sql.exec('SELECT * FROM chain WHERE id = 1').toArray()[0];
		if (!chain || chain.done) return;

		const k = sql.exec('SELECT COUNT(*) AS n FROM slices').toArray()[0].n + 1;
		const startMs = Date.now();
		const isolateBefore = isolateBlocks;
		const objectBefore = chain.blocks;
		sql.exec(
			'INSERT INTO slices (k, isolate, isolate_events, isolate_blocks_before, object_blocks_before, start_ms) VALUES (?, ?, ?, ?, ?, ?)',
			k,
			isolate(),
			isolateEvents,
			isolateBefore,
			objectBefore,
			startMs
		);
		await this.ctx.storage.sync();

		const exports = this.burnExports();
		const burned = exports.burn(chain.slice, 1);
		const signal = u32(exports.memory, SIGNAL);
		isolateBlocks += burned;

		let gap = 0;
		if (chain.pause_after > 0 && !pausedIsolate && isolateBlocks > chain.pause_after) {
			pausedIsolate = true;
			gap = chain.pause_ms;
		}

		const objectBlocks = objectBefore + burned;
		const done = objectBlocks >= chain.target ? 1 : 0;
		sql.exec(
			'UPDATE chain SET blocks = ?, slices = ?, done = ? WHERE id = 1',
			objectBlocks,
			k,
			done
		);

		console.log(
			JSON.stringify({
				tag: 'slice',
				isolate: isolate(),
				ordinal: ev,
				doId: this.ctx.id.toString(),
				k,
				isolateEvents,
				isolateBlocksBefore: isolateBefore,
				isolateBlocksAfter: isolateBlocks,
				objectBlocksBefore: objectBefore,
				burned,
				signal,
				startMs,
				endMs: Date.now(),
				gap
			})
		);

		if (!done) await this.ctx.storage.setAlarm(Date.now() + gap);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const [, , name, route] = url.pathname.split('/');
		if (!name || !route) return new Response('not found', { status: 404 });
		const stub = env.L.get(env.L.idFromName(name));
		return stub.fetch(`http://life/${route}${url.search}`);
	}
};
